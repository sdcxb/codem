/**
 * 文档索引工具（ADR-0008 §10）：`doc_outline` / `doc_search` / `doc_read` / `doc_status` /
 * `doc_cross_search`（跨文档证据层）。
 *
 * ## 契约（改这里先改 ADR）
 *
 * | 工具 | 返回 | 硬约束 |
 * |---|---|---|
 * | `doc_outline` | 文件清单 + 状态 + 标题路径 | 不返回正文 |
 * | `doc_search` | 命中块 + citation + snippet | 整次 ≤6K token |
 * | `doc_read` | 指定块/页正文 + citation + hasMore | 单次 ≤4K token |
 * | `doc_status` | 文件/索引/OCR 状态 + 可行动原因 | 永远给状态，不返回「没有相关内容」 |
 * | `doc_cross_search` | 跨文档分组证据 + citation（FTS + 可选向量） | 不生成答案；≤6K token |
 *
 * ## 为什么「未就绪」必须返回状态
 *
 * 用户刚拖进一份 300 页 PDF，索引要几十秒。此时返回空结果会让模型得出
 * 「文档里没有这件事」——这是**假结论**。工具必须说「正在索引，已完成 X%」，
 * 让模型等待或换个问题（ADR §13「不伪装」）。
 */

import type { ToolContext, ToolDef, ToolExecuteResult } from "../tools";
import {
  documentChunks,
  documentHealth,
  documentOutline,
  documentStats,
  estimateDocTokens,
  fitSearchHits,
  getDocument,
  getPdfEngineStatus,
  listDocuments,
  readDocumentChunk,
  readDocumentPage,
  searchDocuments,
  truncateToTokens,
  vectorSearch,
  type DocumentRecord,
} from "../../document/client";
import { generateEmbeddings } from "../multimodal";
import { isVectorIndexAvailable } from "../../document/vector-index";
import { collectionIdForSession } from "../../document/session-collection";
import { formatCitation, parseChunkRef } from "../../document/citation";
import { recordDocumentRead, recordDocumentSearch } from "../../document/ledger";

const DOC_SEARCH_MAX_TOKENS = 6000;
const DOC_SEARCH_DEFAULT_TOKENS = 6000;
const DOC_READ_MAX_TOKENS = 4000;
const DOC_READ_DEFAULT_TOKENS = 4000;

/**
 * 文档工具的结果契约（见 `output-value.ts`）。
 *
 * 结构刻意是「文本 + 机器可读元数据」：`text` 是模型看到的那段（与旧行为逐字一致），
 * `meta` 让下游（UI/审计/判据）不必嗅探字符串就能拿到 状态/命中数/token 预算。
 * **声明了契约就必须真的返回 `value`** —— 管线会把"只有 output 没有 value"判成错误。
 */
const DOC_TEXT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    meta: { type: "object" },
  },
  required: ["text", "meta"],
  additionalProperties: false,
} as const;

function renderDocTextOutput(value: unknown): string {
  const v = value as { text?: unknown } | null;
  return typeof v?.text === "string" ? v.text : "";
}

/**
 * 给 4 个文档工具统一补 `value`：每个返回分支都会被覆盖，避免"某条错误分支忘了带 value
 * ⇒ 真机被管线判成 outputSchema 违约"。
 */
export function withDocOutputValue(tool: ToolDef): ToolDef {
  const run = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(args, ctx) {
      const res = await run(args, ctx);
      return { ...res, value: { text: res.output, meta: res.metadata ?? {} } };
    },
  };
}

function resolveCollection(ctx: ToolContext, explicit?: unknown): string {
  const s = typeof explicit === "string" ? explicit.trim() : "";
  if (s) return s;
  return collectionIdForSession(ctx.sessionId);
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "排队中";
    case "extracting":
      return "提取中";
    case "indexing":
      return "索引中";
    case "ready":
      return "已索引";
    case "needs_ocr":
      return "需 OCR";
    case "needs_engine":
      return "需 PDF 引擎";
    case "needs_password":
      return "需密码";
    case "too_large":
      return "文件过大（仅元数据）";
    case "unsupported":
      return "不支持";
    case "stale":
      return "文件已移动/删除";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

function docLine(doc: DocumentRecord): string {
  const pages = doc.page_count > 0 ? ` · ${doc.page_count} 页` : "";
  const chunks = doc.chunk_count > 0 ? ` · ${doc.chunk_count} 块` : "";
  const err = doc.error ? ` · 原因：${doc.error}` : "";
  return `- ${doc.name || doc.id}（${statusLabel(doc.status)}${pages}${chunks}；id: ${doc.id}）${err}`;
}

/** 索引未就绪时的统一回答（**不是**「没有相关内容」）。 */
async function notReadyAnswer(collectionId: string): Promise<ToolExecuteResult | null> {
  const stats = await documentStats(collectionId);
  const by = stats.by_status ?? {};
  const pending = (by.pending ?? 0) + (by.extracting ?? 0) + (by.indexing ?? 0);
  const ready = by.ready ?? 0;
  const ocr = (by.needs_ocr ?? 0) + (by.needs_engine ?? 0);
  if (pending === 0 && ready === 0 && ocr === 0) {
    return {
      title: "doc_status",
      output:
        "这个集合还没有已索引的文档。可以：\n" +
        "1) 把文件拖进对话/用上传按钮（会立即入索引队列）；\n" +
        "2) 在消息里直接写出文件路径（会自动登记）；\n" +
        "3) 粘贴图片/文件。",
      isError: false,
      metadata: { status: "empty" },
    };
  }
  if (ready === 0 && (pending > 0 || ocr > 0)) {
    // 状态要区分「还在跑」与「跑完了但没有可检索文本」：两者该采取的动作不同。
    const state = pending > 0 ? "indexing" : "needs_ocr";
    const action =
      pending > 0
        ? "现在检索会漏内容。请稍等（进度见输入区状态条），或先用 doc_status 看明细；"
        : "这些文件没有可提取文本（扫描件/图片，或 PDF 引擎未就绪）⇒ 检索**不可能**命中。" +
          "请让用户改用带文本的版本，或等 P1 的视觉转录；";
    return {
      title: "doc_status",
      output:
        `文档索引还没就绪：进行中 ${pending} 个，需 OCR/引擎 ${ocr} 个。\n` +
        action +
        "**不要**据此判断「文档里没有这件事」。",
      isError: false,
      metadata: { status: state, pending, ocr, degraded: ocr },
    };
  }
  return null;
}

// ═══════════════════════════ doc_outline ═══════════════════════════

export function createDocOutlineTool(): ToolDef {
  return {
    id: "doc_outline",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      concurrencySafe: true,
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_outline first for any document task: it lists indexed documents (status/pages/chunks) and, for one document, its heading tree. Never read a whole document — outline → search → read.",
    description:
      "List indexed documents in the current project (or one document's outline). " +
      "Returns: name, status (ready/indexing/needs_ocr/...), pages, chunk count, and heading paths. " +
      "Call this BEFORE doc_search so you know what is actually indexed.",
    parameters: {
      type: "object",
      properties: {
        collection_id: { type: "string", description: "Override the collection (defaults to the current project)." },
        document_id: { type: "string", description: "Show the heading outline of this document." },
        limit: { type: "number", description: "Max documents to list (default 20)." },
      },
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const collectionId = resolveCollection(ctx, args.collection_id);
      try {
        const explicitId = typeof args.document_id === "string" ? args.document_id : "";
        if (explicitId) {
          const [doc, outline] = await Promise.all([
            getDocument(explicitId),
            documentOutline(explicitId),
          ]);
          const headings = outline.headings.slice(0, 60).map((h) => `  - ${h.heading}`);
          const body = [
            docLine(doc),
            headings.length > 0 ? "标题:" : "（这份文档没有可识别的标题层级）",
            ...headings,
          ].join("\n");
          return {
            title: `doc_outline: ${doc.name || doc.id}`,
            output: body,
            isError: false,
            metadata: { documentId: doc.id, status: doc.status, headings: outline.headings.length },
          };
        }

        const limit = clamp(numArg(args, "limit") ?? 20, 1, 100);
        const list = await listDocuments({ collectionId, limit });
        if (list.items.length === 0) {
          const fallback = await notReadyAnswer(collectionId);
          if (fallback) return fallback;
          return {
            title: "doc_outline",
            output: "这个集合还没有文档。上传/拖拽/粘贴文件，或在消息里写文件路径即可入索引。",
            isError: false,
          };
        }
        const lines = list.items.map(docLine);
        const stats = await documentStats(collectionId);
        const by = stats.by_status ?? {};
        const summary = Object.entries(by)
          .map(([k, v]) => `${statusLabel(k)} ${v}`)
          .join(" / ");
        return {
          title: "doc_outline",
          output: `${summary || "无"}\n${lines.join("\n")}`,
          isError: false,
          metadata: { documents: list.items.length, byStatus: by },
        };
      } catch (e: any) {
        return {
          title: "doc_outline",
          output: `文档索引不可用：${e?.message ?? e}`,
          isError: true,
        };
      }
    },
  };
}

// ═══════════════════════════ doc_search ═══════════════════════════

export function createDocSearchTool(): ToolDef {
  return {
    id: "doc_search",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      concurrencySafe: true,
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_search to find the few chunks that answer the question (BM25 + Chinese segmentation). " +
      "Every hit has a citation you must quote. If the result says the index is still running, wait or tell the user — " +
      "never claim the document lacks the information.",
    description:
      "Full-text search over indexed project documents (Chinese + English). " +
      "Returns at most 6,000 tokens of snippets, each with a stable citation " +
      "(documentId, chunk, page range, heading path). Do NOT dump whole documents; " +
      "use doc_read on a specific chunk when you need more.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a short phrase (Chinese/English)." },
        collection_id: { type: "string", description: "Override the collection (defaults to the current project)." },
        document_id: { type: "string", description: "Restrict to one document." },
        top_k: { type: "number", description: "Max hits (default 8, max 32)." },
        max_tokens: { type: "number", description: "Snippet budget for the whole result (default/max 6000)." },
      },
      required: ["query"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const collectionId = resolveCollection(ctx, args.collection_id);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { title: "doc_search", output: "query 不能为空", isError: true };
      }
      const maxTokens = clamp(numArg(args, "max_tokens") ?? DOC_SEARCH_DEFAULT_TOKENS, 500, DOC_SEARCH_MAX_TOKENS);
      const topK = clamp(numArg(args, "top_k") ?? 8, 1, 32);
      try {
        const ready = await notReadyAnswer(collectionId);
        if (ready) return ready;

        const documentId = typeof args.document_id === "string" ? args.document_id : undefined;
        const result = await searchDocuments({ collectionId, documentId, query, limit: topK });
        if (result.items.length === 0) {
          const stats = await documentStats(collectionId);
          const degraded = (stats.by_status?.needs_ocr ?? 0) + (stats.by_status?.needs_engine ?? 0);
          const note =
            degraded > 0
              ? `（注意：有 ${degraded} 个文档没有可检索文本——需 OCR/PDF 引擎；它们的内容不在本次检索范围内。）`
              : "";
          return {
            title: "doc_search",
            output: `没有命中「${query}」。${note}\n可以换关键词；或用 doc_outline 看有哪些文档/章节。`,
            isError: false,
            metadata: { hits: 0, degraded },
          };
        }

        const fitted = fitSearchHits(result.items, maxTokens);
        recordDocumentSearch(collectionId, result.items.slice(0, fitted.length));
        const blocks = fitted.map(({ hit, snippet }, i) => {
          const citation = formatCitation({
            documentId: hit.document_id,
            chunkNo: hit.chunk_no,
            name: hit.name,
            pageFrom: hit.page_from,
            pageTo: hit.page_to,
            headingPath: hit.heading_path,
          });
          return `${i + 1}. ${citation}\n${snippet}`;
        });
        const used = fitted.reduce((n, h) => n + estimateDocTokens(h.snippet) + 20, 0);
        return {
          title: `doc_search: ${query}`,
          output: blocks.join("\n\n"),
          isError: false,
          metadata: {
            hits: result.items.length,
            returned: fitted.length,
            truncated: fitted.length < result.items.length,
            tokens: used,
            hasMore: result.has_more,
          },
        };
      } catch (e: any) {
        return { title: "doc_search", output: `文档检索失败：${e?.message ?? e}`, isError: true };
      }
    },
  };
}

// ═══════════════════════════ doc_read ═══════════════════════════

export function createDocReadTool(): ToolDef {
  return {
    id: "doc_read",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      concurrencySafe: true,
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_read to read exactly one chunk or one page after doc_search pointed you there. " +
      "Max 4,000 tokens per call; use hasMore/next chunk instead of asking for the whole file.",
    description:
      "Read one document chunk or one page (max 4,000 tokens). " +
      "Provide document_id + chunk_no (from doc_search), or document_id + page. " +
      "Returns text with its citation and a hasMore flag. Whole documents are never returned.",
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Document id (from doc_outline/doc_search)." },
        chunk_no: { type: "number", description: "Chunk number from doc_search." },
        page: { type: "number", description: "Page number (alternative to chunk_no)." },
        ref: { type: "string", description: "Shorthand 'docId#chunkNo' (optional)." },
        max_tokens: { type: "number", description: "Budget for this read (default/max 4000)." },
      },
    },
    async execute(args): Promise<ToolExecuteResult> {
      const maxTokens = clamp(numArg(args, "max_tokens") ?? DOC_READ_DEFAULT_TOKENS, 200, DOC_READ_MAX_TOKENS);
      let documentId = typeof args.document_id === "string" ? args.document_id.trim() : "";
      let chunkNo = numArg(args, "chunk_no");
      if (!documentId && typeof args.ref === "string") {
        const parsed = parseChunkRef(args.ref);
        documentId = parsed.documentId;
        chunkNo = chunkNo ?? parsed.chunkNo;
      }
      const page = numArg(args, "page");
      try {
        if (!documentId) {
          // 没给 id：给出可选项，而不是干错
          const list = await listDocuments({ limit: 20 });
          const lines = list.items.map((d) => `- ${d.name || d.id}（id: ${d.id}，${statusLabel(d.status)}）`);
          return {
            title: "doc_read",
            output: `需要 document_id。当前可选的文档：\n${lines.join("\n") || "（暂无）"}`,
            isError: false,
          };
        }
        const doc = await getDocument(documentId);
        let text = "";
        let citation: any = {};
        let hasMore = false;
        if (typeof chunkNo === "number") {
          const part = await readDocumentChunk(documentId, chunkNo);
          text = part.text;
          citation = part.citation;
          hasMore = part.hasMore;
          const clipped = truncateToTokens(text, maxTokens);
          text = clipped.text;
          hasMore = hasMore || clipped.truncated;
          recordDocumentRead({
            collectionId: doc.collection_id,
            documentId: doc.id,
            documentName: doc.name ?? undefined,
            chunkNo,
            pageFrom: citation?.pageFrom ?? undefined,
            pageTo: citation?.pageTo ?? undefined,
            headingPath: citation?.headingPath ?? null,
          });
        } else if (typeof page === "number") {
          const part = await readDocumentPage(documentId, page, maxTokens);
          text = part.text;
          citation = part.citation;
          hasMore = part.hasMore;
          recordDocumentRead({
            collectionId: doc.collection_id,
            documentId: doc.id,
            documentName: doc.name ?? undefined,
            pageFrom: page,
            pageTo: page,
            headingPath: part.citation?.headingPath ?? null,
          });
        } else {
          // 只给了文档：先给大纲 + 首块，避免模型直接要全文
          const outline = await documentOutline(documentId, 30);
          const headings = outline.headings.map((h) => `- ${h.heading}`).join("\n");
          const first = await documentChunks({ documentId, limit: 1 });
          const firstNo = first.items[0]?.chunk_no;
          return {
            title: `doc_read: ${doc.name || doc.id}`,
            output:
              `这份文档有 ${doc.page_count} 页 / ${doc.chunk_count} 块，标题大纲：\n${headings || "（无标题层级）"}\n\n` +
              `要读正文，请给 chunk_no（例如 ${typeof firstNo === "number" ? firstNo : 0}）或 page。`,
            isError: false,
            metadata: { documentId, pages: doc.page_count, chunks: doc.chunk_count },
          };
        }

        const cite = formatCitation({
          documentId,
          chunkNo: typeof chunkNo === "number" ? chunkNo : undefined,
          name: doc.name,
          pageFrom: citation?.pageFrom,
          pageTo: typeof chunkNo === "number" ? citation?.pageTo : page,
          headingPath: citation?.headingPath,
        });
        return {
          title: `doc_read: ${doc.name || documentId}`,
          output: `${cite}\n\n${text}${hasMore ? "\n\n…（还有更多内容：用下一页/下一块）" : ""}`,
          isError: false,
          metadata: {
            documentId,
            chunkNo,
            page,
            hasMore,
            tokens: estimateDocTokens(text),
            status: doc.status,
          },
        };
      } catch (e: any) {
        return { title: "doc_read", output: `读取失败：${e?.message ?? e}`, isError: true };
      }
    },
  };
}

// ═══════════════════════ doc_cross_search（跨文档问答的证据层） ═══════════════════════

/**
 * 跨文档检索：一次查询覆盖集合内**所有**文档，把 FTS 与向量命中合并、
 * 按文档分组返回带 citation 的证据，供主模型组织答案。
 *
 * 边界（如实写在 description 里）：本工具**不生成自然语言答案**，
 * 它给的是「哪些文档的哪些块能回答 + 稳定引用」；答案由主模型基于证据写。
 * 这样不会把「检索不到」伪装成「文档里没有」。
 */
export function createDocCrossSearchTool(): ToolDef {
  return {
    id: "doc_cross_search",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      concurrencySafe: true,
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_cross_search when the answer may span several documents (compare/aggregate). " +
      "It returns evidence grouped by document with citations; write the answer yourself from those citations. " +
      "If vector search is unavailable it falls back to full-text only — say which mode was used if it matters.",
    description:
      "Cross-document evidence retrieval over the whole project collection: full-text + optional vector search, " +
      "merged and grouped by document, each line with a stable citation. " +
      "It does NOT write the final answer; the caller must synthesize it from the cited evidence. " +
      "Budget ≤6,000 tokens. Use doc_read for the full text of a cited chunk.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question or key phrases (Chinese/English)." },
        collection_id: { type: "string", description: "Override the collection (defaults to the current project)." },
        limit: { type: "number", description: "Max evidence chunks after merge (default 8, max 12)." },
        include_vectors: {
          type: "boolean",
          description: "Try vector search when an embedding provider is configured (default true).",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const collectionId = resolveCollection(ctx, args.collection_id);
      const query = String(args.query ?? "").trim();
      if (!query) {
        return { title: "doc_cross_search", output: "query 不能为空。", isError: true };
      }
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 12);
      try {
        const fts = await searchDocuments({ collectionId, query, limit: 12 });

        let vectorHits: Awaited<ReturnType<typeof vectorSearch>>["items"] = [];
        let vectorUsed = false;
        if (args.include_vectors !== false && isVectorIndexAvailable()) {
          try {
            const embedded = await generateEmbeddings({ texts: [query] });
            const vec = await vectorSearch({
              collectionId,
              queryVector: embedded[0]?.embedding ?? [],
              limit: 12,
            });
            vectorHits = vec.items;
            vectorUsed = vectorHits.length > 0;
          } catch (e: any) {
            // 向量是增强：失败时明确降级，不假装用过
            console.warn("[doc_cross_search] 向量检索不可用，降级为全文：", e?.message ?? e);
          }
        }

        type Evidence = {
          key: string;
          documentId: string;
          chunkNo: number;
          name?: string | null;
          pageFrom?: number;
          pageTo?: number;
          headingPath?: string | null;
          preview?: string | null;
          score: number;
        };
        const merged = new Map<string, Evidence>();
        fts.items.forEach((h, i) => {
          merged.set(`${h.document_id}:${h.chunk_no}`, {
            key: `${h.document_id}:${h.chunk_no}`,
            documentId: h.document_id,
            chunkNo: h.chunk_no,
            name: h.name,
            pageFrom: h.page_from,
            pageTo: h.page_to,
            headingPath: h.heading_path,
            preview: h.preview,
            score: 1 / (60 + i),
          });
        });
        vectorHits.forEach((h, i) => {
          const key = `${h.document_id}:${h.chunk_no}`;
          const existing = merged.get(key);
          const add = 1.2 / (60 + i);
          if (existing) {
            existing.score += add;
          } else {
            merged.set(key, {
              key,
              documentId: h.document_id,
              chunkNo: h.chunk_no,
              name: h.name,
              pageFrom: h.page_from ?? undefined,
              pageTo: h.page_to ?? undefined,
              headingPath: h.heading_path,
              preview: null,
              score: add,
            });
          }
        });

        const ranked = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
        if (ranked.length === 0) {
          return {
            title: "doc_cross_search",
            output: `未检索到与「${query}」相关的证据（全文${vectorUsed ? " + 向量" : ""}）。这不等于文档里没有；可换关键词或先看 doc_status。`,
            isError: false,
            metadata: { collectionId, vectorUsed, hits: 0, documents: 0 },
          };
        }

        const byDoc = new Map<string, Evidence[]>();
        for (const hit of ranked) {
          const list = byDoc.get(hit.documentId) ?? [];
          list.push(hit);
          byDoc.set(hit.documentId, list);
        }

        const lines: string[] = [];
        let tokens = 0;
        const usedDocIds: string[] = [];
        for (const [docId, hits] of byDoc) {
          const header = `## ${hits[0].name || docId}`;
          if (estimateDocTokens(header) + tokens > DOC_SEARCH_MAX_TOKENS) break;
          lines.push(header);
          tokens += estimateDocTokens(header);
          usedDocIds.push(docId);
          for (const hit of hits) {
            const citation = formatCitation({
              documentId: hit.documentId,
              chunkNo: hit.chunkNo,
              name: hit.name,
              pageFrom: hit.pageFrom,
              pageTo: hit.pageTo,
              headingPath: hit.headingPath,
            });
            let preview = hit.preview?.trim() ?? "";
            if (!preview) {
              try {
                preview = (await readDocumentChunk(hit.documentId, hit.chunkNo)).text;
              } catch {
                preview = "";
              }
            }
            const clipped = truncateToTokens(preview.replace(/\s+/g, " ").trim(), 240).text;
            const line = `${citation} ${clipped}`;
            if (estimateDocTokens(line) + tokens > DOC_SEARCH_MAX_TOKENS) break;
            lines.push(line);
            tokens += estimateDocTokens(line);
          }
        }

        recordDocumentSearch(collectionId, fts.items);
        const header = [
          `证据模式：${vectorUsed ? "全文 + 向量" : "全文"}；命中 ${ranked.length} 块，覆盖 ${usedDocIds.length} 份文档。`,
          "请只基于下列证据作答，逐条引用 citation；证据不足就说不足。",
        ].join("\n");
        return {
          title: "doc_cross_search",
          output: `${header}\n\n${lines.join("\n")}`,
          isError: false,
          metadata: {
            collectionId,
            vectorUsed,
            hits: ranked.length,
            documents: usedDocIds.length,
          },
        };
      } catch (e: any) {
        return {
          title: "doc_cross_search",
          output: `跨文档检索失败：${e?.message ?? e}`,
          isError: true,
        };
      }
    },
  };
}

export function createDocStatusTool(): ToolDef {
  return {
    id: "doc_status",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      concurrencySafe: true,
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_status when a document task seems to be missing content: it tells you what is indexed, what is still running, " +
      "and which files need OCR / the PDF engine (with reasons). Never infer 'no content' from an empty search alone.",
    description:
      "Report document index state for the current project: counts by status, chunk totals, and actionable reasons " +
      "for files that are failed / need OCR / need the PDF engine / too large / stale.",
    parameters: {
      type: "object",
      properties: {
        collection_id: { type: "string", description: "Override the collection." },
      },
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const collectionId = resolveCollection(ctx, args.collection_id);
      try {
        const [stats, list, health, pdf] = await Promise.all([
          documentStats(collectionId),
          listDocuments({ collectionId, limit: 200 }),
          documentHealth().catch(() => null),
          getPdfEngineStatus().catch(() => null),
        ]);
        const by = stats.by_status ?? {};
        const summary =
          Object.entries(by)
            .map(([k, v]) => `${statusLabel(k)}: ${v}`)
            .join(" / ") || "空";
        const problems = list.items.filter((d) => d.status !== "ready");
        const detail = problems.slice(0, 12).map(docLine);
        const body = [
          `集合: ${collectionId}`,
          `状态: ${summary}`,
          `分块总数: ${stats.total_chunks}`,
          health ? `索引库: schema v${health.schema_version} · ${health.documents} 份文档 / ${health.chunks} 块` : "",
          pdf ? `PDF 引擎: ${pdf.available ? "可用" : "未就绪（.pdf 会标 needs_engine）"}` : "",
          problems.length > 0 ? "需要注意:" : "全部文档已就绪。",
          ...detail,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          title: "doc_status",
          output: body,
          isError: false,
          metadata: { byStatus: by, totalChunks: stats.total_chunks, problems: problems.length },
        };
      } catch (e: any) {
        return { title: "doc_status", output: `状态查询失败：${e?.message ?? e}`, isError: true };
      }
    },
  };
}
