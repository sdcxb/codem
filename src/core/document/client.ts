/**
 * 项目级文档索引 —— 渲染侧客户端（ADR-0008）。
 *
 * ## 分工（重要）
 *
 * 提取、分块、FTS 写入**全部在 Rust**（1GB 文件不可能走 IPC 搬字节）。
 * 这里只做四件事：
 * 1. 把「入口」（上传/粘贴/拖拽/路径）变成 `documents_ingest` 调用；
 * 2. 大文件按 **4MB 分块** 走 `documents_blob_*` 写入受管 blob 目录；
 * 3. 调 `documents.*` 查询命令（`storage_invoke` 通道，与主库同一条白名单）；
 * 4. 结果**按 token 预算裁剪**（`doc_search` ≤6K、`doc_read` ≤4K）。
 *
 * ## 可测性
 *
 * 后端可注入（`setDocumentBackend`）：判据用内存假后端驱动，不依赖 Tauri 运行时。
 * 真实实现只用 `storage_invoke` / `documents_*` 两条 IPC，和真机走同一条路。
 */

import { invoke } from "@tauri-apps/api/core";

// ═══════════════════════════ 类型 ═══════════════════════════

type DocumentStatus =
  | "pending"
  | "extracting"
  | "indexing"
  | "ready"
  | "failed"
  | "needs_ocr"
  | "needs_engine"
  | "needs_password"
  | "too_large"
  | "unsupported"
  | "stale";

export type DocumentKind = "attachment" | "paste" | "path" | "drop";

export interface DocumentRecord {
  id: string;
  collection_id: string;
  kind: DocumentKind | string;
  source_ref?: string | null;
  dedupe_key: string;
  name?: string | null;
  mime?: string | null;
  size: number;
  sha256?: string | null;
  mtime?: number | null;
  page_count: number;
  block_count: number;
  chunk_count: number;
  text_bytes: number;
  status: DocumentStatus | string;
  error?: string | null;
  outline_json?: string | null;
  extractor_version?: number;
  metadata_json?: string | null;
  created_at: number;
  updated_at: number;
}

export interface DocumentSearchHit {
  document_id: string;
  chunk_no: number;
  name?: string | null;
  status?: string;
  page_from: number;
  page_to: number;
  heading_path?: string | null;
  text_offset: number;
  text_len: number;
  preview?: string | null;
  score: number;
}

export interface DocumentChunkMeta {
  chunk_no: number;
  page_from: number;
  page_to: number;
  heading_path?: string | null;
  text_offset: number;
  text_len: number;
  token_count: number;
  preview?: string | null;
}

export interface DocumentProgress {
  jobId?: string;
  documentId?: string | null;
  stage: string;
  name?: string;
  bytes?: number;
  /** 总字节数（长文件进度用） */
  totalBytes?: number;
  /** 已处理百分比 0–100（后端每 ~700ms 发一次） */
  percent?: number;
  pages?: number;
  chunks?: number;
  error?: string;
  at?: number;
}

export interface IngestRequest {
  collection_id: string;
  kind: DocumentKind;
  path?: string;
  sha256?: string;
  name?: string;
  mime?: string;
  size?: number;
  source_ref?: string;
}

export interface DocumentBackend {
  command<T>(name: string, params?: Record<string, unknown>): Promise<T>;
  ingest(request: IngestRequest): Promise<{ job_id: string }>;
  cancel(jobId: string): Promise<unknown>;
  blobBegin(name: string): Promise<{ upload_id: string }>;
  blobAppend(uploadId: string, dataBase64: string): Promise<unknown>;
  blobFinish(uploadId: string, name: string): Promise<{ sha256: string; size: number; path: string }>;
  blobAbort(uploadId: string): Promise<unknown>;
  readText(documentId: string, chunkNo: number): Promise<{ text: string; citation: any; hasMore: boolean }>;
  pdfProbe(): Promise<{ available: boolean }>;
}

/** 文档索引错误：带稳定 code，便于 UI 决定「重试/降级/提示」。 */
export class DocumentIndexError extends Error {
  readonly code: string;
  constructor(message: string, code = "OTHER") {
    super(message);
    this.name = "DocumentIndexError";
    this.code = code;
  }
}

// ═══════════════════════════ 后端（可注入） ═══════════════════════════

let backend: DocumentBackend | null = null;

export function setDocumentBackend(next: DocumentBackend | null): void {
  backend = next;
}

export function hasDocumentBackend(): boolean {
  if (backend) return true;
  return typeof (globalThis as any).__TAURI__?.core?.invoke === "function";
}

function getBackend(): DocumentBackend {
  if (backend) return backend;
  const inv = (globalThis as any).__TAURI__?.core?.invoke;
  if (typeof inv !== "function") {
    throw new DocumentIndexError(
      "文档索引不可用：没有 Tauri 运行时（浏览器/测试环境需注入后端）",
      "UNAVAILABLE",
    );
  }
  return tauriBackend;
}

const tauriBackend: DocumentBackend = {
  async command<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const reply = await invoke<{ ok: boolean; result?: T; error?: { message?: string; code?: string } }>(
      "storage_invoke",
      { command: name, params },
    );
    if (!reply || reply.ok !== true) {
      throw new DocumentIndexError(
        reply?.error?.message ?? `文档索引命令失败：${name}`,
        reply?.error?.code ?? "OTHER",
      );
    }
    return reply.result as T;
  },
  ingest: (request) => invoke("documents_ingest", { request }),
  cancel: (jobId) => invoke("documents_cancel", { jobId }),
  blobBegin: (name) => invoke("documents_blob_begin", { name }),
  // Tauri 2 把 JS 的 camelCase 参数映射到 Rust 的 snake_case 参数名。
  blobAppend: (uploadId, dataBase64) =>
    invoke("documents_blob_append", { uploadId, data: dataBase64 }),
  blobFinish: (uploadId, name) => invoke("documents_blob_finish", { uploadId, name }),
  blobAbort: (uploadId) => invoke("documents_blob_abort", { uploadId }),
  readText: (documentId, chunkNo) =>
    invoke("documents_read", { documentId, chunkNo }),
  pdfProbe: () => invoke("documents_pdf_probe"),
};

// ═══════════════════════════ 集合与预算 ═══════════════════════════

/** 集合 id：有项目 → 项目；无项目 → 会话级（接口预留未来提升到全局库）。 */
export function collectionIdFor(projectId?: string | null, sessionId?: string | null): string {
  if (projectId && projectId.trim()) return projectId;
  return `session:${sessionId ?? "unknown"}`;
}

/** token 估算（与 Rust 侧 `estimate_tokens` 同口径：CJK 1 token/字，其他 4 字符/token）。 */
export function estimateDocTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const isCjk =
      (c >= 0x3400 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af);
    if (isCjk) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 按 token 预算截断（保留开头；返回是否截断）。 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: "", truncated: text.length > 0 };
  let tokens = 0;
  let i = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const isCjk =
      (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff);
    const next = tokens + (isCjk ? 1 : 0.25);
    // 先判越界再收字符：返回值的 `estimateDocTokens` **绝不超过**预算
    if (next > maxTokens) {
      return { text: text.slice(0, i), truncated: true };
    }
    tokens = next;
    i += ch.length;
  }
  return { text, truncated: false };
}

/**
 * 按预算裁剪检索命中：每条只保留必要字段 + 截断 `snippet`。
 *
 * 硬约束（ADR-0008 §10）：整次检索渲染文本 ≤ `maxTokens`（默认 6000）。
 */
export function fitSearchHits(
  hits: DocumentSearchHit[],
  maxTokens = 6000,
  perHitMaxTokens = 900,
): Array<{ hit: DocumentSearchHit; snippet: string }> {
  const out: Array<{ hit: DocumentSearchHit; snippet: string }> = [];
  let used = 0;
  for (const hit of hits) {
    const raw = hit.preview ?? "";
    const remaining = maxTokens - used;
    if (remaining <= 40) break;
    const budget = Math.min(perHitMaxTokens, remaining - 20);
    const { text } = truncateToTokens(raw, budget);
    const cost = estimateDocTokens(text) + 20;
    if (used + cost > maxTokens) break;
    out.push({ hit, snippet: text });
    used += cost;
  }
  return out;
}

// ═══════════════════════════ 查询 ═══════════════════════════

export async function listDocuments(params: {
  collectionId?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ items: DocumentRecord[]; has_more: boolean }> {
  return getBackend().command("documents.list", {
    collection_id: params.collectionId,
    status: params.status,
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
  });
}

export async function getDocument(id: string): Promise<DocumentRecord> {
  return getBackend().command("documents.get", { id });
}

export async function searchDocuments(params: {
  collectionId?: string;
  documentId?: string;
  query: string;
  limit?: number;
}): Promise<{ items: DocumentSearchHit[]; has_more: boolean }> {
  return getBackend().command("documents.search", {
    collection_id: params.collectionId,
    document_id: params.documentId,
    query: params.query,
    limit: params.limit ?? 8,
  });
}

export async function documentChunks(params: {
  documentId: string;
  page?: number;
  chunkNos?: number[];
  limit?: number;
}): Promise<{ items: DocumentChunkMeta[]; has_more: boolean }> {
  return getBackend().command("documents.chunks", {
    document_id: params.documentId,
    page: params.page,
    chunk_nos: params.chunkNos,
    limit: params.limit ?? 20,
  });
}

export async function documentStats(collectionId?: string): Promise<{
  by_status: Record<string, number>;
  total_chunks: number;
}> {
  return getBackend().command("documents.stats", { collection_id: collectionId });
}

// ═══════════════════════ 向量索引（可选能力） ═══════════════════════

export interface DocumentVectorHit {
  document_id: string;
  chunk_no: number;
  score: number;
  name?: string | null;
  page_from?: number | null;
  page_to?: number | null;
  heading_path?: string | null;
}

export async function vectorUpsert(params: {
  documentId: string;
  vectors: Array<{ chunk_no: number; vector: number[] }>;
  model?: string;
  replaceAll?: boolean;
}): Promise<{ upserted: number; dim: number; model: string }> {
  return getBackend().command("documents.vector_upsert", {
    document_id: params.documentId,
    vectors: params.vectors,
    model: params.model,
    replace_all: params.replaceAll ?? false,
  });
}

export async function vectorSearch(params: {
  collectionId: string;
  queryVector: number[];
  limit?: number;
  model?: string;
  documentIds?: string[];
}): Promise<{ items: DocumentVectorHit[]; dim: number }> {
  return getBackend().command("documents.vector_search", {
    collection_id: params.collectionId,
    query_vector: params.queryVector,
    limit: params.limit ?? 20,
    model: params.model,
    document_ids: params.documentIds,
  });
}

export async function vectorStatus(params: {
  documentId?: string;
  collectionId?: string;
} = {}): Promise<{
  items: Array<{ document_id: string; model: string; chunks: number; dim?: number | null }>;
  count: number;
  assigned: number;
  /** 已写入 int8 量化向量的条数（训练/upsert 后 == count） */
  quantized: number;
  meta: { dim: number; count: number; k: number; trained_at: number } | null;
}> {
  return getBackend().command("documents.vector_status", {
    document_id: params.documentId,
    collection_id: params.collectionId,
  });
}

/** 训练/重建 IVF 聚类（≥1024 个向量才有意义；不足时返回 trained=false）。 */
export async function vectorTrain(params: {
  collectionId: string;
  iterations?: number;
}): Promise<{ trained: boolean; reason?: string; count: number; k?: number; dim?: number; assigned?: number }> {
  return getBackend().command("documents.vector_train", {
    collection_id: params.collectionId,
    iterations: params.iterations,
  });
}

/** 文档大纲（标题路径，按首次出现排序；不返回正文）。 */
export async function documentOutline(
  documentId: string,
  limit = 80,
): Promise<{ headings: Array<{ heading: string; block_no: number }> }> {
  return getBackend().command("documents.outline", { document_id: documentId, limit });
}

// ═══════════════════════ 视觉转录（P1，ADR-0008 §15） ═══════════════════════

export interface OcrPendingPage {
  page_no: number;
  kind?: string | null;
}

export interface RenderedPagePng {
  page_no: number;
  media_type: string;
  data: string;
  width: number;
  height: number;
}

/** 需要视觉转录的页（`scanned`/`mixed`，未完成/失败）。 */
export async function ocrPendingPages(documentId: string): Promise<OcrPendingPage[]> {
  const res = await invoke<{ pages: OcrPendingPage[] }>("documents_ocr_pending", { documentId });
  return res.pages ?? [];
}

/** 渲染一页 PDF 为 PNG（base64），交给视觉模型。 */
export async function renderDocumentPage(
  documentId: string,
  pageNo: number,
  maxWidth = 1400,
): Promise<RenderedPagePng> {
  return invoke<RenderedPagePng>("documents_render_page", { documentId, pageNo, maxWidth });
}

/** 写一页的转录文本（Rust 追加侧车 + 建块/分块/FTS + 标记页 done）。 */
export async function writeDocumentOcrPage(params: {
  documentId: string;
  pageNo: number;
  text: string;
  model: string;
}): Promise<{ chunk_no: number; block_no: number }> {
  return invoke("documents_ocr_write", {
    documentId: params.documentId,
    pageNo: params.pageNo,
    text: params.text,
    model: params.model,
  });
}

/** 单页转录失败：标 failed（重试时会再次列出；不影响其他页）。 */
export async function markDocumentOcrFailed(
  documentId: string,
  pageNo: number,
): Promise<unknown> {
  return invoke("documents_ocr_mark_failed", { documentId, pageNo });
}

/** 收尾：没有待转录页 ⇒ 文档转 ready 并刷新计数。 */
export async function finishDocumentOcr(
  documentId: string,
): Promise<{ remaining: number; status: string; chunk_count?: number }> {
  return invoke("documents_ocr_finish", { documentId });
}

/** 更新文档状态（仅白名单字段由引擎决定）。 */
export async function updateDocumentStatus(
  documentId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return getBackend().command("documents.update_status", { id: documentId, ...patch });
}


export async function documentHealth(): Promise<{
  path: string;
  schema_version: number;
  documents: number;
  chunks: number;
  /** FTS 行数（可能与 documents/chunks 不一致：清库残留/旧库升级时用来发现“幽灵行”） */
  fts_rows?: number;
}> {
  return getBackend().command("documents.health");
}

export async function readDocumentChunk(
  documentId: string,
  chunkNo: number,
): Promise<{ text: string; citation: { pageFrom?: number; pageTo?: number; headingPath?: string | null }; hasMore: boolean }> {
  return getBackend().readText(documentId, chunkNo);
}

/** 读某一页：按页取块 → 逐块读正文（预算内），拼成 ≤maxTokens 的文本。 */
export async function readDocumentPage(
  documentId: string,
  page: number,
  maxTokens = 4000,
): Promise<{ text: string; citation: any; hasMore: boolean }> {
  const chunks = await documentChunks({ documentId, page, limit: 8 });
  if (chunks.items.length === 0) {
    return { text: "", citation: { page }, hasMore: false };
  }
  let text = "";
  let used = 0;
  for (const c of chunks.items) {
    const part = await readDocumentChunk(documentId, c.chunk_no);
    const cost = estimateDocTokens(part.text);
    if (used + cost > maxTokens) {
      const { text: clipped } = truncateToTokens(part.text, Math.max(0, maxTokens - used));
      text += clipped;
      used += estimateDocTokens(clipped);
      return { text, citation: part.citation, hasMore: true };
    }
    text += part.text;
    used += cost;
  }
  return {
    text,
    citation: { page, headingPath: chunks.items[0]?.heading_path ?? null },
    hasMore: chunks.has_more,
  };
}

export async function getPdfEngineStatus(): Promise<{ available: boolean }> {
  return getBackend().pdfProbe();
}

// ═══════════════════════════ 摄取 ═══════════════════════════

/** 路径型：只登记路径 + sha（不复制原文件）。 */
export async function ingestPath(params: {
  collectionId: string;
  path: string;
  name?: string;
  kind?: DocumentKind;
  sourceRef?: string;
}): Promise<{ job_id: string }> {
  return getBackend().ingest({
    collection_id: params.collectionId,
    kind: params.kind ?? "path",
    path: params.path,
    name: params.name,
    source_ref: params.sourceRef ?? params.path,
  });
}

/** blob 型：调用方已把字节写入 `blobs/<sha256>`（上传/粘贴/拖拽）。 */
async function ingestBlob(params: {
  collectionId: string;
  sha256: string;
  name: string;
  size?: number;
  mime?: string;
  kind?: DocumentKind;
  sourceRef?: string;
}): Promise<{ job_id: string }> {
  return getBackend().ingest({
    collection_id: params.collectionId,
    kind: params.kind ?? "attachment",
    sha256: params.sha256,
    name: params.name,
    size: params.size,
    mime: params.mime,
    source_ref: params.sourceRef,
  });
}

export async function cancelIngest(jobId: string): Promise<unknown> {
  return getBackend().cancel(jobId);
}


/** 单块上限（与 Rust `BLOB_CHUNK_MAX_BYTES` 对齐：8MiB；这里按 4MiB 切）。 */
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;

/** 字节 → base64（分片子串拼接，避免 `String.fromCharCode(...bigArray)` 爆栈）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * 把浏览器 `File` 分块写成受管 blob，然后入索引（浏览器兜底通道）。
 *
 * 原生文件对话框能拿到真实路径时**优先**走 `ingestPath`（1GB 不必搬字节）；
 * 这条通道用于拖拽/粘贴等只有 `File` 对象的场景。
 */
export async function ingestFileBytes(params: {
  collectionId: string;
  file: File;
  kind?: DocumentKind;
  sourceRef?: string;
  onProgress?: (sent: number, total: number) => void;
}): Promise<{ job_id: string; sha256: string }> {
  const { file, collectionId } = params;
  const backendRef = getBackend();
  const total = file.size;
  const begin = await backendRef.blobBegin(file.name || "document");
  let sent = 0;
  for (let offset = 0; offset < total; offset += BLOB_CHUNK_BYTES) {
    const slice = file.slice(offset, Math.min(offset + BLOB_CHUNK_BYTES, total));
    const buf = new Uint8Array(await slice.arrayBuffer());
    await backendRef.blobAppend(begin.upload_id, bytesToBase64(buf));
    sent += buf.length;
    params.onProgress?.(sent, total);
  }
  if (total === 0) {
    // 空文件也要 finish（否则上传临时文件不会被清理）
    await backendRef.blobAppend(begin.upload_id, "");
  }
  const done = await backendRef.blobFinish(begin.upload_id, file.name || "document");
  const job = await ingestBlob({
    collectionId,
    sha256: done.sha256,
    name: file.name || done.path,
    size: done.size,
    mime: file.type || undefined,
    kind: params.kind ?? "attachment",
    sourceRef: params.sourceRef ?? `blob:${done.sha256}`,
  });
  return { job_id: job.job_id, sha256: done.sha256 };
}

/** 粘贴的图片（data URL）：解码成 `File` → 走同一条 blob 通道。 */
export async function ingestPastedImage(params: {
  collectionId: string;
  dataUrl: string;
  name: string;
  sourceRef?: string;
}): Promise<{ job_id: string; sha256: string } | null> {
  const comma = params.dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = params.dataUrl.slice(0, comma);
  const body = params.dataUrl.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  const mime = /^data:([^;]+)/i.exec(meta)?.[1] ?? "image/png";
  const bytes = isBase64
    ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body));
  const file = new File([bytes], params.name, { type: mime });
  return ingestFileBytes({
    collectionId: params.collectionId,
    file,
    kind: "paste",
    sourceRef: params.sourceRef,
  });
}

// ═══════════════════════════ 进度事件 ═══════════════════════════

/** 订阅摄取进度（仅 Tauri 环境；返回取消订阅函数）。 */
export async function subscribeDocumentProgress(
  handler: (p: DocumentProgress) => void,
): Promise<() => void> {
  if (typeof (globalThis as any).__TAURI__?.event?.listen !== "function") return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<DocumentProgress>("document://progress", (event) => handler(event.payload));
}

/** 测试/切换用：清空注入的后端。 */
export function __resetDocumentBackendForTests(): void {
  backend = null;
}
