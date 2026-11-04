/**
 * DocumentLedger —— 本轮「文档用法」的结构化记忆（ADR-0008 §11）。
 *
 * ## 为什么不能靠「把读过的正文留在上下文里」
 *
 * 文档正文是**最贵**的上下文：一份 300 页 PDF 的某一段就有几千 token。
 * 检索型工作真正要跨轮保留的只有三件事：**看过哪些文件、读过哪些 chunk、
 * 确认了哪些带 citation 的事实**。正文随时可以按 citation 再取一次。
 *
 * ## 注入位置
 *
 * 只能进 `trailingTurnContext`（易变尾部），**绝不进 system 前缀** ——
 * 否则每轮前缀都变，`dsh-d5-prefix-cache-stability` 会红（前缀缓存失效）。
 *
 * ## 预算
 *
 * 渲染文本 ≤2,000 token（超出按「文件 → 已读 → 事实」优先级截断）。
 */

import { estimateDocTokens, truncateToTokens, type DocumentSearchHit } from "./client";

interface LedgerFile {
  id: string;
  name: string;
  pages?: number;
  status?: string;
}

interface LedgerRead {
  documentId: string;
  chunkNo: number;
  pageFrom?: number;
  pageTo?: number;
  headingPath?: string | null;
  at: number;
}

interface LedgerFact {
  text: string;
  at: number;
}

interface LedgerState {
  files: Map<string, LedgerFile>;
  reads: Map<string, LedgerRead>;
  facts: LedgerFact[];
}

const MAX_FACTS = 40;
const MAX_READS = 80;
const MAX_FILES = 40;

const ledgers = new Map<string, LedgerState>();

function ledger(collectionId: string): LedgerState {
  let state = ledgers.get(collectionId);
  if (!state) {
    state = { files: new Map(), reads: new Map(), facts: [] };
    ledgers.set(collectionId, state);
  }
  return state;
}

/** 记录一次检索命中（文件 + chunk）。 */
export function recordDocumentSearch(collectionId: string, hits: DocumentSearchHit[]): void {
  const state = ledger(collectionId);
  for (const hit of hits) {
    if (state.files.size < MAX_FILES) {
      const existing = state.files.get(hit.document_id);
      if (!existing) {
        state.files.set(hit.document_id, {
          id: hit.document_id,
          name: hit.name ?? hit.document_id,
          pages: hit.page_to || undefined,
          status: hit.status,
        });
      } else if (!existing.pages && hit.page_to) {
        existing.pages = hit.page_to;
      }
    }
    const key = `${hit.document_id}#${hit.chunk_no}`;
    if (state.reads.size < MAX_READS && !state.reads.has(key)) {
      state.reads.set(key, {
        documentId: hit.document_id,
        chunkNo: hit.chunk_no,
        pageFrom: hit.page_from,
        pageTo: hit.page_to,
        headingPath: hit.heading_path ?? null,
        at: Date.now(),
      });
    }
  }
  trim(state);
}

/** 记录一次定点阅读（`doc_read`）。 */
export function recordDocumentRead(params: {
  collectionId: string;
  documentId: string;
  documentName?: string;
  chunkNo?: number;
  pageFrom?: number;
  pageTo?: number;
  headingPath?: string | null;
}): void {
  const state = ledger(params.collectionId);
  if (params.documentName && state.files.size < MAX_FILES) {
    if (!state.files.has(params.documentId)) {
      state.files.set(params.documentId, {
        id: params.documentId,
        name: params.documentName,
        pages: params.pageTo || undefined,
      });
    }
  }
  if (typeof params.chunkNo === "number" && state.reads.size < MAX_READS) {
    state.reads.set(`${params.documentId}#${params.chunkNo}`, {
      documentId: params.documentId,
      chunkNo: params.chunkNo,
      pageFrom: params.pageFrom,
      pageTo: params.pageTo,
      headingPath: params.headingPath ?? null,
      at: Date.now(),
    });
  }
  trim(state);
}

/** 记录一条带 citation 的事实（由检索/阅读结果推导，不是模型自述）。 */
export function recordDocumentFact(collectionId: string, fact: string): void {
  const text = fact.trim();
  if (!text) return;
  const state = ledger(collectionId);
  if (state.facts.some((f) => f.text === text)) return;
  state.facts.push({ text, at: Date.now() });
  trim(state);
}

function trim(state: LedgerState): void {
  if (state.facts.length > MAX_FACTS) state.facts = state.facts.slice(-MAX_FACTS);
  if (state.reads.size > MAX_READS) {
    const entries = [...state.reads.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of entries.slice(0, entries.length - MAX_READS)) state.reads.delete(key);
  }
  if (state.files.size > MAX_FILES) {
    const extra = [...state.files.keys()].slice(0, state.files.size - MAX_FILES);
    for (const key of extra) state.files.delete(key);
  }
}

function citationOf(state: LedgerState, read: LedgerRead): string {
  const file = state.files.get(read.documentId);
  const name = file?.name ?? read.documentId;
  const page =
    typeof read.pageFrom === "number"
      ? read.pageFrom === read.pageTo || read.pageTo == null
        ? `p.${read.pageFrom}`
        : `p.${read.pageFrom}-${read.pageTo}`
      : "";
  const heading = read.headingPath ? ` §${read.headingPath}` : "";
  return `${name} ${page}${heading} (chunk ${read.chunkNo})`.replace(/\s+/g, " ").trim();
}

/** 渲染 ledger 文本（没有内容时返回空串 —— 不把普通对话变成永远带一段固定文本）。 */
export function renderDocumentLedger(collectionId: string, maxTokens = 2000): string {
  const state = ledgers.get(collectionId);
  if (!state) return "";
  if (state.files.size === 0 && state.reads.size === 0 && state.facts.length === 0) return "";

  const lines: string[] = ["[文档索引]"];
  if (state.files.size > 0) {
    lines.push("文件:");
    for (const file of state.files.values()) {
      const pages = file.pages ? ` · ${file.pages} 页` : "";
      const status = file.status && file.status !== "ready" ? ` · ${file.status}` : "";
      lines.push(`- ${file.name}${pages}${status}（id: ${file.id}）`);
    }
  }
  if (state.reads.size > 0) {
    lines.push("已读:");
    const reads = [...state.reads.values()].sort((a, b) => a.at - b.at).slice(-12);
    for (const read of reads) lines.push(`- ${citationOf(state, read)}`);
  }
  if (state.facts.length > 0) {
    lines.push("已确认:");
    for (const fact of state.facts.slice(-12)) lines.push(`- ${fact.text}`);
  }
  lines.push("[用法] 需要更多内容用 doc_read；不要整篇读入。");

  const rendered = lines.join("\n");
  /*
   * 截断要把**后缀本身**也算进预算：先按 `maxTokens - 24` 截正文，再拼后缀。
   * （否则「≤2,000 token」这条判据会被后缀顶出去 —— 实测 2,007。）
   */
  const suffix = "\n…（ledger 已截断）";
  const { text, truncated } = truncateToTokens(rendered, Math.max(0, maxTokens - 24));
  return truncated ? `${text}${suffix}` : text;
}

/** 某集合是否已有 ledger 内容（用于「是否注入」判断）。 */
export function hasDocumentLedger(collectionId: string): boolean {
  const state = ledgers.get(collectionId);
  if (!state) return false;
  return state.files.size > 0 || state.reads.size > 0 || state.facts.length > 0;
}


/** 判据用：清空全部。 */
export function __resetDocumentLedgerForTests(): void {
  ledgers.clear();
}
