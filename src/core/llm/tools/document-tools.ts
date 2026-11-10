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
  documentOutlineDetailed,
  documentPages,
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
import {
  renderStructureLine,
  resolveDocumentPageState,
  summarizeDocumentStructure,
  type DocumentPageStateSummary,
} from "../../document/structure";
import {
  documentLedgerSnapshot,
  documentSyncCheck,
  flushDocumentLedgerPersistence,
  recordDocumentClaim,
  recordDocumentOutline,
  recordDocumentRead,
  recordDocumentSearch,
  recordDocumentSection,
  verifyDocumentClaim,
} from "../../document/ledger";
import {
  DOC_PIPELINE_STAGES,
  documentPipelineSnapshot,
  runDocumentPipelineStage,
  startDocumentPipeline,
  submitDocumentSection,
  type DocPipelineStage,
} from "../../document/pipeline";

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
          /**
           * C05：单文档大纲要带**页码 + 章节路径 + 结构状态**。
           *
           * 旧输出只有 `heading` 字符串（`block_no` 都没渲染），模型看得到章节名
           * 却不知道在哪一页、也不知道这份文档是表格/xlsx 还是扫描件 ——
           * 于是既无法按页定点阅读，也无法判断「OCR 还没跑完 ⇒ 现在检索会漏」。
           */
          const [doc, outline, pages] = await Promise.all([
            getDocument(explicitId),
            documentOutlineDetailed(explicitId),
            documentPages(explicitId).catch(() => []),
          ]);
          const structure = summarizeDocumentStructure(doc, pages);
          const headings = outline.headings.slice(0, 60).map((h, i) => {
            const page = typeof h.page === "number" ? ` · p.${h.page}` : "";
            return `  ${i + 1}. ${h.heading}${page}`;
          });
          const coverageNote =
            outline.pageCoverage === "partial"
              ? "（页码只覆盖已取到的块，未标页码的标题页码未知）"
              : outline.pageCoverage === "none"
                ? "（没有块元数据，页码未知）"
                : "";
          const body = [
            docLine(doc),
            renderStructureLine(structure),
            headings.length > 0
              ? `标题（${outline.headings.length}）${coverageNote}:`
              : "（这份文档没有可识别的标题层级）",
            ...headings,
          ].join("\n");
          recordDocumentOutline({
            collectionId: doc.collection_id || collectionId,
            documentId: doc.id,
            documentName: doc.name || doc.id,
            headings: outline.headings.map((h) => h.heading),
            pages: doc.page_count,
            status: doc.status,
            updatedAt: doc.updated_at,
            sha256: doc.sha256 ?? null,
          });
          return {
            title: `doc_outline: ${doc.name || doc.id}`,
            output: body,
            isError: false,
            metadata: {
              documentId: doc.id,
              status: doc.status,
              headings: outline.headings.length,
              pageCoverage: outline.pageCoverage,
              structure,
            },
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
        const citations: Array<{
          documentId: string;
          chunkNo: number;
          pageFrom: number;
          pageTo: number;
          headingPath: string | null;
          citation: string;
        }> = [];
        const blocks = fitted.map(({ hit, snippet }, i) => {
          const citation = formatCitation({
            documentId: hit.document_id,
            chunkNo: hit.chunk_no,
            name: hit.name,
            pageFrom: hit.page_from,
            pageTo: hit.page_to,
            headingPath: hit.heading_path,
          });
          citations.push({
            documentId: hit.document_id,
            chunkNo: hit.chunk_no,
            pageFrom: hit.page_from,
            pageTo: hit.page_to,
            headingPath: hit.heading_path ?? null,
            citation,
          });
          return `${i + 1}. ${citation}\n${snippet}`;
        });
        const used = fitted.reduce((n, h) => n + estimateDocTokens(h.snippet) + 20, 0);
        /**
         * C05：命中来自「未完全就绪」的文档时要**当场说明**（例如扫描件还在转录）。
         * 不写这一句，0 命中/少命中会被读成「文档里没有这件事」（ADR §13 不伪装）。
         */
        const notReady = [
          ...new Set(result.items.filter((h) => h.status && h.status !== "ready").map((h) => h.status as string)),
        ];
        const degradedNote =
          notReady.length > 0
            ? `\n（注意：本次命中里有文档状态为 ${notReady.join(" / ")} —— 其内容可能不完整，别据此断定「没有」。）`
            : "";
        return {
          title: `doc_search: ${query}`,
          output: `${blocks.join("\n\n")}${degradedNote}`,
          isError: false,
          metadata: {
            hits: result.items.length,
            returned: fitted.length,
            truncated: fitted.length < result.items.length,
            tokens: used,
            hasMore: result.has_more,
            citations,
            degradedStatuses: notReady,
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
        /** C05：读到的这一页是什么页、正文来自哪里（OCR 页必须写明来源） */
        let pageMeta: { kind?: string | null; ocr_state?: string | null; ocr_model?: string | null; text_source?: string | null } | undefined;
        /** 这次读的时候后端页表有几行（区分「没有页级数据」与「页表里没这一页」） */
        let pageTableSize = 0;
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
            updatedAt: doc.updated_at,
            sha256: doc.sha256 ?? null,
          });
        } else if (typeof page === "number") {
          const part = await readDocumentPage(documentId, page, maxTokens);
          text = part.text;
          citation = part.citation;
          hasMore = part.hasMore;
          pageMeta = part.pageMeta;
          pageTableSize = part.pageTableSize;
          recordDocumentRead({
            collectionId: doc.collection_id,
            documentId: doc.id,
            documentName: doc.name ?? undefined,
            pageFrom: page,
            pageTo: page,
            headingPath: part.citation?.headingPath ?? null,
            updatedAt: doc.updated_at,
            sha256: doc.sha256 ?? null,
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

        /**
         * C05（页级状态**优先真实数据**）：
         *
         * `documents.pages` 是「这一页是不是扫描件 / 正文是不是视觉转录」的唯一权威来源。
         * 按页读时它就在 `readDocumentPage` 里取过（`pageMeta` + 页表行数）；
         * 按块读时页号来自块元数据（`citation.pageFrom`），这里再查一次页表。
         * 查不到就**派生并明确标注**（`页状态: 未知（派生：…）`），绝不沉默 ——
         * 沉默会让模型把一份可能来自 OCR 的正文当原文引用（ADR-0008 §13「不伪装」）。
         */
        let pageState: DocumentPageStateSummary | undefined;
        if (typeof chunkNo === "number") {
          const chunkPage =
            typeof citation?.pageFrom === "number" && citation.pageFrom > 0 ? citation.pageFrom : undefined;
          if (chunkPage !== undefined) {
            const pageTable = await documentPages(documentId).catch(() => []);
            pageState = resolveDocumentPageState({
              page: chunkPage,
              pageMeta: pageTable.find((p) => p.page_no === chunkPage),
              hasPageTable: pageTable.length > 0,
              via: "chunk",
            });
          }
        } else if (typeof page === "number") {
          pageState = resolveDocumentPageState({
            page,
            ...(pageMeta ? { pageMeta } : {}),
            hasPageTable: pageTableSize > 0,
            via: "page",
          });
        }

        /**
         * 引用里带上**正文来源**：扫描页的文本是视觉模型转录的（`text_source=vision`），
         * 不标出来模型会把 OCR 结果当原文引用 —— 那正是 C05「OCR 文档有明确状态」要防的。
         * 只有真实页数据才敢断言 `vision`（派生口径不会给 textSource）。
         */
        const fromVision = pageState?.textSource === "vision";
        const cite = formatCitation({
          documentId,
          chunkNo: typeof chunkNo === "number" ? chunkNo : undefined,
          name: doc.name,
          pageFrom: citation?.pageFrom,
          pageTo: typeof chunkNo === "number" ? citation?.pageTo : page,
          headingPath: citation?.headingPath,
          ...(fromVision ? { textSource: "vision", ocrModel: pageState?.ocrModel ?? null } : {}),
        });
        const pageStatus = pageState ? `\n${pageState.line}` : "";
        return {
          title: `doc_read: ${doc.name || documentId}`,
          output: `${cite}${pageStatus}\n\n${text}${hasMore ? "\n\n…（还有更多内容：用下一页/下一块）" : ""}`,
          isError: false,
          metadata: {
            documentId,
            chunkNo,
            page,
            hasMore,
            tokens: estimateDocTokens(text),
            status: doc.status,
            ...(pageState
              ? {
                  pageKind: pageState.source === "pages" ? pageState.kind ?? null : null,
                  ocrState: pageState.source === "pages" ? pageState.ocrState ?? null : null,
                  textSource: pageState.source === "pages" ? pageState.textSource ?? null : null,
                  /** 页级状态来自真实页数据，还是派生的降级口径（C05 判据看这两个字段） */
                  pageStateSource: pageState.source,
                  pageDataCoverage: pageState.coverage,
                  ...(pageState.note ? { pageStateNote: pageState.note } : {}),
                }
              : {}),
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
        /**
         * C05：把「表格/OCR 文档」的状态说清楚。
         *
         * 只报 `by_status` 回答不了两个具体问题：这份文档是不是表格（行级入索引）、
         * 需要视觉转录的页跑到哪一步。这里对**没就绪**与**表格/PDF/图片**类文档
         * 逐份取 `documents.pages`（最多 6 份，避免一次状态查询打爆 IPC），
         * 取不到就写「结构状态未知」，不猜。
         */
        const structureTargets = list.items
          .filter(
            (d) =>
              d.status !== "ready" ||
              /xlsx|xls|csv|tsv|pdf|png|jpe?g|webp|tiff?/i.test(`${d.name ?? ""} ${d.mime ?? ""}`),
          )
          .slice(0, 6);
        const structureLines = (
          await Promise.all(
            structureTargets.map(async (d) => {
              try {
                const pages = await documentPages(d.id);
                const structure = summarizeDocumentStructure(d, pages);
                return `- ${d.name || d.id}: ${renderStructureLine(structure).replace(/^结构: /, "")}`;
              } catch {
                return `- ${d.name || d.id}: 结构状态未知（documents.pages 读取失败）`;
              }
            }),
          )
        ).filter(Boolean);
        const body = [
          `集合: ${collectionId}`,
          `状态: ${summary}`,
          `分块总数: ${stats.total_chunks}`,
          health ? `索引库: schema v${health.schema_version} · ${health.documents} 份文档 / ${health.chunks} 块` : "",
          pdf ? `PDF 引擎: ${pdf.available ? "可用" : "未就绪（.pdf 会标 needs_engine）"}` : "",
          structureLines.length > 0 ? "结构/OCR:" : "",
          ...structureLines,
          problems.length > 0 ? "需要注意:" : "全部文档已就绪。",
          ...detail,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          title: "doc_status",
          output: body,
          isError: false,
          metadata: {
            byStatus: by,
            totalChunks: stats.total_chunks,
            problems: problems.length,
            structureChecked: structureLines.length,
          },
        };
      } catch (e: any) {
        return { title: "doc_status", output: `状态查询失败：${e?.message ?? e}`, isError: true };
      }
    },
  };
}

// ═══════════════════════ doc_ledger（C06：文档账本） ═══════════════════════

/**
 * 文档账本工具 —— 长文档任务里「哪些章节读过/改过/验过、哪些结论带引用」的**唯一入口**。
 *
 * ## 为什么必须是工具，而不只是尾部注入
 *
 * 尾部注入（`renderDocumentLedger`）只给模型一份摘要；当模型要回答
 * 「第 4 章还没看吗」「这条结论引用在哪一页」时，它需要一个**可查询**的入口。
 * 没有这个入口，模型只能凭记忆回答 —— 那正是「未读/未验不可见」的来源。
 *
 * ## 写动作也在这里（claim / section）
 *
 * 账本的价值在于「claim 必须带 citation」。如果允许模型先写自由文本结论、
 * 事后再补引用，回溯就断了。所以这里**只接受带 citation 的 claim**；
 * 没有引用直接报错，而不是静默存一条无法回溯的字符串。
 *
 * ## 为什么 `shouldDefer`（低频、按需查询）
 *
 * 账本是**动作型**入口（claim / verify / section），不是每轮都要看的常驻说明：
 * 覆盖摘要由尾部注入（`renderDocumentLedger`）每轮免费给出，`doc_status` 仍常驻，
 * 模型要回答「第 4 章还没看吗」时才需要这份可查询明细。常驻它会让所有回合
 * 为 871 字符付费（2026-11-06 实测），而它只在读写文档的任务里被调用 ——
 * 按仓库既有口径改为 `tool_search` 按需取回；系统提示里的 Deferred Tools 段落
 * 仍会列出名称 + searchHint，模型知道它存在。
 */
export function createDocLedgerTool(): ToolDef {
  return {
    id: "doc_ledger",
    shouldDefer: true,
    searchHint:
      "文档账本：章节覆盖（已读/已改/已验）、未读/未验、claim→citation 与版本同步检查（读写文档任务时用）",
    contract: {
      sideEffectScope: "session",
      accessScope: "session",
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_ledger to see what this session has actually covered in documents: read/edited/verified sections, " +
      "unread and unverified sections, and claims with their citations. Record a claim (action=claim) only with a citation " +
      "you can point at; never invent page/chunk numbers.",
    description:
      "Document ledger: section coverage (read/edited/verified), unread/unverified sections, claims with citations, " +
      "and a document-version sync check. action=status is read-only; claim/verify/section write the ledger.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "claim", "verify", "section"] },
        collection_id: { type: "string", description: "Override collection." },
        claim: { type: "string", description: "claim: claim text." },
        claim_id: { type: "string", description: "verify: claim id." },
        document_id: { type: "string", description: "Document id." },
        chunk_no: { type: "number", description: "Citation chunk." },
        page: { type: "number", description: "Citation page." },
        heading: { type: "string", description: "Section heading." },
        section_status: { type: "string", enum: ["read", "edited", "verified"] },
      },
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const collectionId = resolveCollection(ctx, args.collection_id);
      const action = typeof args.action === "string" && args.action.trim() ? args.action.trim() : "status";
      try {
        if (action === "claim") {
          const claim = typeof args.claim === "string" ? args.claim : "";
          const documentId = typeof args.document_id === "string" ? args.document_id.trim() : "";
          const chunkNo = numArg(args, "chunk_no");
          const page = numArg(args, "page");
          const record = recordDocumentClaim({
            collectionId,
            claim,
            citation: {
              documentId,
              ...(typeof chunkNo === "number" ? { chunkNo } : {}),
              ...(typeof page === "number" ? { pageFrom: page, pageTo: page } : {}),
              ...(typeof args.heading === "string" && args.heading.trim()
                ? { headingPath: args.heading.trim() }
                : {}),
            },
          });
          const snapshot = documentLedgerSnapshot(collectionId);
          /**
           * 显式记账是**对用户的承诺**（「已记账」/「已标记」）⇒ 不进去抖窗口，立刻落盘。
           * 自动记账（检索/阅读/大纲）仍走去抖（见 `ledger.ts` 的 `markDirty`）。
           */
          flushDocumentLedgerPersistence();
          return {
            title: "doc_ledger: claim",
            output: `已记账：${record.text}（${record.id}，未验证）`,
            isError: false,
            metadata: { claimId: record.id, counts: snapshot.counts },
          };
        }
        if (action === "verify") {
          const claimId = typeof args.claim_id === "string" ? args.claim_id.trim() : "";
          const snapshot = documentLedgerSnapshot(collectionId);
          const known = snapshot.claims.some((c) => c.id === claimId);
          if (!known) {
            return {
              title: "doc_ledger: verify",
              output: `没有这个 claim：${claimId || "（缺少 claim_id）"}。先用 action=status 看 claim id。`,
              isError: true,
              metadata: { claimId, counts: snapshot.counts },
            };
          }
          const changed = verifyDocumentClaim(collectionId, claimId);
          flushDocumentLedgerPersistence();
          return {
            title: "doc_ledger: verify",
            output: changed ? `已标记 ${claimId} 为已验证。` : `${claimId} 之前已经验证过（未重复改动）。`,
            isError: false,
            metadata: { claimId, changed, counts: snapshot.counts },
          };
        }
        if (action === "section") {
          const documentId = typeof args.document_id === "string" ? args.document_id.trim() : "";
          const heading = typeof args.heading === "string" ? args.heading.trim() : "";
          const sectionStatus = args.section_status;
          if (!documentId || !heading) {
            return { title: "doc_ledger: section", output: "需要 document_id + heading。", isError: true };
          }
          if (sectionStatus !== "read" && sectionStatus !== "edited" && sectionStatus !== "verified") {
            return {
              title: "doc_ledger: section",
              output: "section_status 只能是 read / edited / verified。",
              isError: true,
            };
          }
          const page = numArg(args, "page");
          const upgraded = recordDocumentSection({
            collectionId,
            documentId,
            headingPath: heading,
            status: sectionStatus,
            ...(typeof page === "number" ? { pageFrom: page } : {}),
          });
          flushDocumentLedgerPersistence();
          return {
            title: "doc_ledger: section",
            output: upgraded
              ? `章节状态已升级为 ${sectionStatus}：${heading}`
              : `章节 ${heading} 已经是同级或更高状态（不降级），未改动。`,
            isError: false,
            metadata: { upgraded, sectionStatus },
          };
        }

        const snapshot = documentLedgerSnapshot(collectionId);
        if (!snapshot.hasContent) {
          return {
            title: "doc_ledger",
            output: "这个集合还没有文档账本内容（先 doc_outline / doc_search / doc_read）。",
            isError: false,
            metadata: { counts: snapshot.counts },
          };
        }
        const sync = await documentSyncCheck(collectionId);
        const lines: string[] = ["[文档账本] " + collectionId];
        lines.push(
          `文件 ${snapshot.counts.files} · 已读块 ${snapshot.counts.reads} · 章节 ${snapshot.counts.sections}` +
            `（未读 ${snapshot.counts.unread} / 未验 ${snapshot.counts.unverified}）· claim ${snapshot.counts.claims}（已验 ${snapshot.counts.verifiedClaims}）`,
        );
        if (
          snapshot.segment.first !== undefined &&
          snapshot.segment.current !== undefined &&
          snapshot.segment.current > snapshot.segment.first
        ) {
          lines.push(`覆盖保留：第 ${snapshot.segment.first} 段 → 第 ${snapshot.segment.current} 段`);
        }
        if (snapshot.unread.length > 0) {
          lines.push("未读章节:");
          for (const item of snapshot.unread.slice(0, 10)) lines.push(`- ${item.name} §${item.headingPath}`);
        }
        if (snapshot.unverified.length > 0) {
          lines.push("未验章节:");
          for (const item of snapshot.unverified.slice(0, 10)) {
            lines.push(`- ${item.documentId} §${item.headingPath}（${item.status}）`);
          }
        }
        if (snapshot.claims.length > 0) {
          lines.push("结论:");
          for (const claim of snapshot.claims.slice(-10)) {
            lines.push(`- ${claim.verified ? "[已验证]" : "[待验证]"} ${claim.text}（${claim.id}）← ${claim.citation}`);
          }
        }
        lines.push(
          `版本同步: ${
            sync.ok
              ? `已检查 ${sync.checked} 份文档，版本未变化`
              : [
                  ...(sync.changed.length > 0
                    ? [
                        `${sync.changed.length} 份文档在读过之后发生变化（${sync.changed
                          .map((c) => c.name)
                          .join("、")}）`,
                      ]
                    : []),
                  ...(sync.unknown.length > 0 ? [`${sync.unknown.length} 份读不到（${sync.unknown.join("、")}）`] : []),
                  ...(sync.unreadSections > 0 ? [`未读章节 ${sync.unreadSections}`] : []),
                  ...(sync.unverifiedSections > 0 ? [`未验章节 ${sync.unverifiedSections}`] : []),
                  ...(sync.unverifiedClaims > 0 ? [`待验结论 ${sync.unverifiedClaims}`] : []),
                ].join("；")
          }`,
        );
        return {
          title: "doc_ledger",
          output: lines.join("\n"),
          isError: false,
          metadata: {
            counts: snapshot.counts,
            segment: snapshot.segment,
            sync,
            unread: snapshot.unread,
            claims: snapshot.claims,
          },
        };
      } catch (e: any) {
        return { title: "doc_ledger", output: `文档账本操作失败：${e?.message ?? e}`, isError: true };
      }
    },
  };
}

// ═══════════════════════ doc_compile（C07：长文档编译流水线） ═══════════════════════

/** 从 citation 文案里取出 `documentId + chunkNo/page`（解析不出就返回 null）。 */
function parseCitationLocator(
  citation: string,
): { documentId: string; chunkNo?: number; page?: number } | null {
  const chunk = /chunk:\s*([^\s|\]]+)#(\d+)/.exec(citation);
  if (chunk) return { documentId: chunk[1], chunkNo: Number(chunk[2]) };
  const doc = /(?:^|\|)\s*doc:\s*([^\s|\]]+)/.exec(citation);
  const page = /(?:^|\|)\s*page:\s*(\d+)/.exec(citation);
  if (doc && page) return { documentId: doc[1], page: Number(page[1]) };
  return null;
}

/**
 * 长文档编译流水线工具（C07）。
 *
 * 阶段（顺序固定）：outline → sections → merge → consistency → citations → coverage → diff。
 * 工具**不写正文**：分节正文由模型 `action=submit` 交上来，阶段机负责顺序、证据与完成判定。
 * 未交齐分节时 `merge` 会被拒绝（禁止跳级），失败会停在原地（不冒充完成）。
 *
 * ## 为什么 `shouldDefer`（低频、大 schema）
 *
 * `context-tax-budget` 的常驻预算守的是「每轮都随请求发出去的定义」。长文档编译是
 * **特定任务才用**的能力（不是每轮对话都需要），把 1.8K 字符的 schema 常驻会让所有回合
 * 为它付费。这里按仓库既有口径延迟加载：模型先用 `tool_search` 取回完整 schema 再调用。
 */
export function createDocCompileTool(): ToolDef {
  return {
    id: "doc_compile",
    shouldDefer: true,
    searchHint:
      "Long-document compile pipeline (outline → sections → merge → consistency → citations → coverage → diff) with per-stage evidence.",
    contract: {
      sideEffectScope: "session",
      accessScope: "session",
      concurrencySafe: false,
      outputSchema: DOC_TEXT_OUTPUT_SCHEMA,
      renderOutput: renderDocTextOutput,
    },
    guidance:
      "Use doc_compile for long-document compilation: plan (outline → section jobs), submit each section WITH citations, " +
      "then run stages in order (sections → merge → consistency → citations → coverage → diff). " +
      "Stages must not be skipped; if a stage refuses, fix the reported reason instead of pretending it is done.",
    description:
      "Drive the long-document compile pipeline with per-stage evidence: outline → sections → merge → consistency → " +
      "citations → coverage → diff. action=plan builds section jobs from an outline (or an indexed document), " +
      "action=submit delivers one section (content + citations), action=stage runs the next stage, action=status " +
      "reports stage/section progress and why it is not complete yet.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["plan", "submit", "stage", "status"],
          description: "plan | submit | stage | status.",
        },
        document_id: { type: "string", description: "Target document id (also used as pipeline key)." },
        title: { type: "string", description: "Human title of the compiled document." },
        sections: {
          type: "array",
          description: "action=plan: outline headings (omit to read the outline from document_id).",
          items: {
            type: "object",
            properties: { heading: { type: "string" }, page: { type: "number" } },
            required: ["heading"],
          },
        },
        section_id: { type: "string", description: "action=submit: section id from plan/status." },
        heading: { type: "string", description: "action=submit: section heading (alternative to section_id)." },
        content: { type: "string", description: "action=submit: section body." },
        citations: {
          type: "array",
          items: { type: "string" },
          description: "action=submit: citations backing this section (at least one is required).",
        },
        stage: {
          type: "string",
          enum: [...DOC_PIPELINE_STAGES],
          description: "action=stage: the stage to run (previous stage must be done).",
        },
        baseline_text: { type: "string", description: "Optional previous merged text used as the diff baseline." },
        verify_citations: {
          type: "boolean",
          description: "action=stage citations: resolve citations against the document index (default true).",
        },
      },
      required: ["action"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const action = typeof args.action === "string" ? args.action.trim() : "status";
      const documentId = typeof args.document_id === "string" ? args.document_id.trim() : "";
      if (!documentId) {
        return { title: "doc_compile", output: "需要 document_id（流水线按它定位）。", isError: true };
      }
      const sessionId = ctx.sessionId;
      try {
        if (action === "plan") {
          let outline: Array<{ heading: string; page?: number }> = [];
          const given = Array.isArray(args.sections) ? (args.sections as Array<Record<string, unknown>>) : [];
          if (given.length > 0) {
            outline = given
              .map((s) => ({
                heading: String(s?.heading ?? "").trim(),
                ...(typeof s?.page === "number" ? { page: s.page } : {}),
              }))
              .filter((s) => s.heading.length > 0);
          } else {
            const detailed = await documentOutlineDetailed(documentId);
            outline = detailed.headings.map((h) => ({
              heading: h.heading,
              ...(typeof h.page === "number" ? { page: h.page } : {}),
            }));
          }
          if (outline.length === 0) {
            return {
              title: "doc_compile",
              output: "没有可用的章节：请给 sections，或先让这份文档索引出标题层级。",
              isError: true,
            };
          }
          const snapshot = startDocumentPipeline({
            sessionId,
            documentId,
            ...(typeof args.title === "string" ? { title: args.title } : {}),
            outline,
            ...(typeof args.baseline_text === "string" ? { baselineText: args.baseline_text } : {}),
          });
          const jobs = snapshot.sections.map((s) => `- ${s.id}: ${s.heading}${s.page ? ` · p.${s.page}` : ""}`);
          return {
            title: `doc_compile: plan（${snapshot.sections.length} 节）`,
            output:
              `编译计划（${snapshot.title}）:\n${jobs.join("\n")}\n\n` +
              `阶段顺序（不可跳级）：${DOC_PIPELINE_STAGES.join(" → ")}\n` +
              `下一步：action=submit 逐个交分节（content + citations），全部交齐后 action=stage stage=sections。`,
            isError: false,
            metadata: { snapshot },
          };
        }
        if (action === "submit") {
          const result = submitDocumentSection({
            sessionId,
            documentId,
            ...(typeof args.section_id === "string" ? { sectionId: args.section_id } : {}),
            ...(typeof args.heading === "string" ? { heading: args.heading } : {}),
            content: typeof args.content === "string" ? args.content : "",
            ...(Array.isArray(args.citations) ? { citations: args.citations.map((c) => String(c)) } : {}),
          });
          if (!result.ok) {
            return {
              title: "doc_compile: submit",
              output: `分节未交付：${result.error}`,
              isError: true,
              metadata: result.snapshot ? { snapshot: result.snapshot } : {},
            };
          }
          const progress = result.snapshot.sectionProgress;
          return {
            title: `doc_compile: submit ${result.section.id}`,
            output:
              `已交付 ${result.section.id}「${result.section.heading}」（${result.section.citations.length} 条引用）。` +
              `进度 ${progress.done}/${progress.total}。`,
            isError: false,
            metadata: { snapshot: result.snapshot },
          };
        }
        if (action === "stage") {
          const stage = typeof args.stage === "string" ? (args.stage as DocPipelineStage) : null;
          if (!stage || !(DOC_PIPELINE_STAGES as readonly string[]).includes(stage) || stage === "outline") {
            return {
              title: "doc_compile: stage",
              output: `需要 stage（${DOC_PIPELINE_STAGES.filter((s) => s !== "outline").join(" / ")}）。`,
              isError: true,
            };
          }
          let resolveCitation: ((citation: string) => boolean) | undefined;
          if (stage === "citations" && args.verify_citations !== false) {
            const snapshot = documentPipelineSnapshot(sessionId, documentId);
            const citations = snapshot ? [...new Set(snapshot.sections.flatMap((s) => s.citations))] : [];
            const checked = new Map<string, boolean>();
            for (const citation of citations) {
              const locator = parseCitationLocator(citation);
              if (!locator) continue;
              try {
                const chunks = await documentChunks({
                  documentId: locator.documentId,
                  ...(typeof locator.chunkNo === "number"
                    ? { chunkNos: [locator.chunkNo] }
                    : { page: locator.page }),
                  limit: 1,
                });
                checked.set(citation, chunks.items.length > 0);
              } catch {
                checked.set(citation, false);
              }
            }
            resolveCitation = (citation: string) => checked.get(citation) ?? true;
          }
          const result = runDocumentPipelineStage({
            sessionId,
            documentId,
            stage,
            ...(resolveCitation ? { resolveCitation } : {}),
            ...(typeof args.baseline_text === "string" ? { baselineText: args.baseline_text } : {}),
          });
          if (!result.ok) {
            return {
              title: `doc_compile: ${stage} 未完成`,
              output: result.error,
              isError: true,
              metadata: result.snapshot ? { snapshot: result.snapshot } : {},
            };
          }
          const nextStep = result.snapshot.complete
            ? `全部阶段完成（${DOC_PIPELINE_STAGES.join(" → ")}）。`
            : `下一步：${result.snapshot.blockedBy[0]?.stage ?? "（无）"}`;
          const artifacts =
            result.evidence.artifacts.length > 0
              ? `（产物 ${result.evidence.artifacts.map((a) => `${a.name}#${a.digest}`).join("、")}）`
              : "";
          return {
            title: `doc_compile: ${stage}`,
            output: `${result.evidence.summary}${artifacts}\n${nextStep}`,
            isError: false,
            metadata: { stage, evidence: result.evidence, snapshot: result.snapshot },
          };
        }

        const snapshot = documentPipelineSnapshot(sessionId, documentId);
        if (!snapshot) {
          return {
            title: "doc_compile: status",
            output: "这份文档还没有编译流水线（先 action=plan）。",
            isError: false,
          };
        }
        const stages = snapshot.stages.map((s) => `${s.stage}=${s.status}`).join(" · ");
        const jobs = snapshot.sections.map(
          (s) => `- ${s.id}: ${s.heading} · ${s.status}${s.citations.length > 0 ? ` · ${s.citations.length} 引用` : ""}`,
        );
        /**
         * C07：重启后补丁正文不再在内存里（持久化只存摘要）—— 仍要如实说「改了多少」，
         * 否则 status 会把一份真做过的 diff 写成「（无）」。
         */
        const diffLine = snapshot.diff
          ? `${snapshot.diff.split("\n").length} 行（基线 ${snapshot.baseline}）`
          : snapshot.diffSummary
            ? `摘要 +${snapshot.diffSummary.added} / -${snapshot.diffSummary.removed} · ${snapshot.diffSummary.lines} 行（基线 ${snapshot.diffSummary.baseline}）`
            : "（无）";
        return {
          title: "doc_compile: status",
          output:
            `${snapshot.complete ? "已完成" : "未完成"}（${snapshot.title}）\n` +
            `阶段: ${stages}\n` +
            `分节: ${snapshot.sectionProgress.done}/${snapshot.sectionProgress.total}\n` +
            `${jobs.join("\n")}\n` +
            (snapshot.complete ? `diff: ${diffLine}` : `卡在: ${snapshot.blockedBy.map((b) => `${b.stage}（${b.reason}）`).join("；")}`),
          isError: false,
          metadata: { snapshot },
        };
      } catch (e: any) {
        return { title: "doc_compile", output: `编译流水线失败：${e?.message ?? e}`, isError: true };
      }
    },
  };
}
