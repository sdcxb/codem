/**
 * 文档结构状态（C05）—— 把「这是什么格式 / 有多少页要 OCR / 表格怎么入索引」
 * 变成**确定的一行状态**，而不是让下游从 chunk 数字里猜。
 *
 * ## 为什么不能只报「已索引」
 *
 * ADR-0008 §13「不伪装」：一份 `.xlsx`（行级入索引）与一份扫描版 PDF
 * （视觉转录）在检索结果里看起来都是「命中了 chunk」。但实际上：
 *
 * - 表格：每个 sheet 的每一行是一个块（`kind = table_row`），**单元格合并/公式不建模**；
 * - 扫描页：正文来自视觉模型（`text_source = vision`），引用必须写明来源。
 *
 * 工具输出里不写这两件事，模型就会把「行文本」当语义段落、把 OCR 文本当原文 ——
 * 这正是 C05 要求「表格/OCR 文档有明确状态」的原因。
 *
 * ## 数据来源（全部是既有命令，不改后端契约）
 *
 * - 文档行：`documents.list` / `documents.get` 的 `mime/name/page_count/status`；
 * - 页状态：`documents.pages` 的 `kind`（text/scanned/mixed）与 `ocr_state`。
 */

import type { DocumentPageMeta } from "./client";

/** 文档格式分类（只覆盖索引器真的区别对待的几类）。 */
type DocumentFormat = "table" | "pdf" | "word" | "text" | "image" | "other";

/** 页级状态的来源（C05）：真实 `documents.pages` / 由文档与块元数据派生的降级口径。 */
type DocumentPageStateSource = "pages" | "derived";

/**
 * 页级数据的覆盖度：
 * - `complete`：命中了真实页数据；
 * - `partial`：后端有页表，但里面没有这一页（不能据此断言这一页不存在状态）；
 * - `none`：后端完全没有页级数据。
 */
type DocumentPageDataCoverage = "complete" | "partial" | "none";

/** 单页状态（`doc_read` 的页状态行与 metadata 共用这一份口径）。 */
export interface DocumentPageStateSummary {
  page?: number;
  source: DocumentPageStateSource;
  coverage: DocumentPageDataCoverage;
  kindLabel: string;
  /** 原始页类型（`text`/`scanned`/`mixed`；派生时为 undefined —— 不编造） */
  kind?: string | null;
  /** 原始 OCR 状态（`pending`/`done`/`failed`；派生时为 undefined） */
  ocrState?: string | null;
  ocrModel?: string | null;
  ocrLabel?: string;
  /** 正文来源：**只有真实页数据**才敢断言（派生一律不给，避免把 OCR 文本当原文） */
  textSource?: "layout" | "vision";
  /** 可直接进工具输出的一行（派生时写明「派生」与依据） */
  line: string;
  /** 派生时给可诊断的原因（metadata 用；不进正文，省 token） */
  note?: string;
}

type PageMetaLike = Pick<DocumentPageMeta, "kind" | "text_source" | "ocr_state" | "ocr_model">;

/** OCR 状态中文（与页类型同一份口径；未知就不编）。 */
function ocrStateLabel(state?: string | null, model?: string | null): string | undefined {
  if (!state) return undefined;
  const head = state === "done" ? "OCR 已完成" : state === "failed" ? "OCR 失败" : "OCR 待处理";
  return model ? `${head}（${model}）` : head;
}

/**
 * 解析一页的页状态（**真实页数据优先**，没有才派生并标注）。
 *
 * 为什么：`documents.pages` 是「这一页是扫描件/正文来自视觉转录」的唯一权威来源；
 * 拿到它时必须用它（`source: "pages"`）。拿不到时**不能**沉默 —— 沉默会让模型把
 * 一份可能来自 OCR 的正文当原文引用（C05/ADR-0008 §13「不伪装」）。
 * 派生口径只允许说「未知」，不许猜 `text`/`layout`。
 */
export function resolveDocumentPageState(args: {
  /** 页号（按页读来自请求；按块读来自块元数据 pageFrom；都没有时为 undefined） */
  page?: number;
  /** 命中的权威页元数据（来自 `documents.pages`；没有就是 undefined） */
  pageMeta?: PageMetaLike;
  /** 后端是否返回了页表（用于区分 `partial` 与 `none`） */
  hasPageTable: boolean;
  /** 读取路径：`page` 按页读 / `chunk` 按块读 */
  via: "page" | "chunk";
}): DocumentPageStateSummary {
  const page = args.page;
  const meta = args.pageMeta;
  if (meta) {
    const kindLabel = pageKindLabel(meta.kind);
    const ocrLabel = ocrStateLabel(meta.ocr_state, meta.ocr_model);
    const textSource =
      meta.text_source === "vision" || meta.ocr_state === "done"
        ? "vision"
        : meta.text_source === "layout"
          ? "layout"
          : undefined;
    return {
      ...(typeof page === "number" && page > 0 ? { page } : {}),
      source: "pages",
      coverage: "complete",
      kindLabel,
      kind: meta.kind ?? null,
      ocrState: meta.ocr_state ?? null,
      ocrModel: meta.ocr_model ?? null,
      ...(ocrLabel ? { ocrLabel } : {}),
      ...(textSource ? { textSource } : {}),
      line: `页状态: ${kindLabel}${ocrLabel ? ` · ${ocrLabel}` : ""}`,
    };
  }
  const coverage: DocumentPageDataCoverage = args.hasPageTable ? "partial" : "none";
  const note =
    coverage === "partial"
      ? `documents.pages 里没有第 ${page ?? "?"} 页（不据此断言这一页没有状态）`
      : args.via === "chunk"
        ? "只有块元数据，后端未返回 documents.pages"
        : "后端未返回 documents.pages";
  return {
    ...(typeof page === "number" && page > 0 ? { page } : {}),
    source: "derived",
    coverage,
    kindLabel: pageKindLabel(null),
    line: `页状态: 未知（派生：${note}，无法确认是否 OCR 文本）`,
    note,
  };
}

/** 结构摘要（`doc_outline` / `doc_status` / `doc_read` 共用同一份口径）。 */
interface DocumentStructureSummary {
  format: DocumentFormat;
  /** 表格类文档：行级入索引（单元格语义未建模），检索命中以行为单位 */
  tableRows: boolean;
  pages: {
    /** `page_count`（文档行）；没有页概念时为 0 */
    total: number;
    /** 有文本层的页 */
    text: number;
    /** 整页扫描（无文本层） */
    scanned: number;
    /** 混排（部分文本层 + 部分图像） */
    mixed: number;
    /** OCR 已完成页 */
    ocrDone: number;
    /** 待转录（pending/null）页 */
    ocrPending: number;
    /** 转录失败页 */
    ocrFailed: number;
    /** 正文来源是视觉转录的页 */
    visionPages: number;
  };
  /**
   * OCR 总状态：
   * - `none`：没有需要转录的页（或没有页数据）；
   * - `pending`：有页待转录；
   * - `partial`：一部分转录完成、仍有待转录/失败；
   * - `done`：需要转录的页全部完成；
   * - `failed`：有转录失败且没有待转录页。
   */
  ocrState: "none" | "pending" | "partial" | "done" | "failed";
  /** 视觉转录用过的模型（去重，展示用） */
  visionModels: string[];
  /**
   * 页级状态的**来源**（C05）：有真实 `documents.pages` 就优先用它（`pages`）；
   * 没有才是由文档级状态派生的降级口径（`derived`，只敢说未知）。
   */
  pageStateSource: DocumentPageStateSource;
  /** 页级数据覆盖度（`partial`/`none` 时 note 里会写明「其余页不推断」） */
  pageDataCoverage: DocumentPageDataCoverage;
  /** 一句话状态（可直接进工具输出；数据未知时说明未知） */
  note: string;
}

const TABLE_MIME = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/tab-separated-values",
];
const WORD_MIME = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
];

/** 按 mime/扩展名分类（mime 优先；都没有时按扩展名；都不认识 → other）。 */
function classifyDocumentFormat(
  mime?: string | null,
  name?: string | null,
): DocumentFormat {
  const m = (mime ?? "").toLowerCase();
  if (m) {
    if (TABLE_MIME.includes(m) || m.startsWith("text/csv")) return "table";
    if (WORD_MIME.includes(m)) return "word";
    if (m === "application/pdf") return "pdf";
    if (m.startsWith("image/")) return "image";
    if (m.startsWith("text/")) return "text";
  }
  const ext = /\.([a-z0-9]+)$/i.exec((name ?? "").trim())?.[1]?.toLowerCase() ?? "";
  if (["xlsx", "xls", "csv", "tsv"].includes(ext)) return "table";
  if (["docx", "doc", "rtf"].includes(ext)) return "word";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"].includes(ext)) return "image";
  if (["md", "markdown", "txt", "log", "json", "yaml", "yml"].includes(ext)) return "text";
  return "other";
}

/** 页类型中文标签（页状态一行里用；未知页类型如实说未知）。 */
function pageKindLabel(kind?: string | null): string {
  switch (kind) {
    case "text":
      return "文本页";
    case "scanned":
      return "扫描页";
    case "mixed":
      return "混排页";
    case null:
    case undefined:
    case "":
      return "页类型未知";
    default:
      return `${kind} 页`;
  }
}

/** 汇总结构（纯函数：判据不需要真后端）。 */
export function summarizeDocumentStructure(
  doc: {
    mime?: string | null;
    name?: string | null;
    page_count?: number;
    status?: string;
    chunk_count?: number;
  },
  pages: Pick<DocumentPageMeta, "kind" | "ocr_state" | "ocr_model" | "text_source">[],
): DocumentStructureSummary {
  const format = classifyDocumentFormat(doc.mime ?? null, doc.name ?? null);
  const pages_ = {
    total: Math.max(0, Number(doc.page_count ?? 0)),
    text: 0,
    scanned: 0,
    mixed: 0,
    ocrDone: 0,
    ocrPending: 0,
    ocrFailed: 0,
    visionPages: 0,
  };
  const models = new Set<string>();
  for (const page of pages) {
    const kind = page.kind ?? "";
    if (kind === "scanned") pages_.scanned += 1;
    else if (kind === "mixed") pages_.mixed += 1;
    else if (kind === "text") pages_.text += 1;

    const ocr = page.ocr_state ?? "";
    if (ocr === "done") pages_.ocrDone += 1;
    else if (ocr === "failed") pages_.ocrFailed += 1;
    else if (kind === "scanned" || kind === "mixed") pages_.ocrPending += 1;

    if (page.text_source === "vision") {
      pages_.visionPages += 1;
      if (page.ocr_model) models.add(page.ocr_model);
    }
  }

  const needsOcr = pages_.scanned + pages_.mixed;
  let ocrState: DocumentStructureSummary["ocrState"] = "none";
  if (needsOcr > 0) {
    if (pages_.ocrPending > 0) ocrState = pages_.ocrDone > 0 || pages_.ocrFailed > 0 ? "partial" : "pending";
    else if (pages_.ocrFailed > 0) ocrState = "failed";
    else ocrState = "done";
  }

  /** C05：页级状态优先用真实页数据；没有页表时才派生并标注 */
  const hasPageTable = pages.length > 0;
  const pageDataCoverage: DocumentPageDataCoverage = !hasPageTable
    ? "none"
    : pages_.total > 0 && pages.length < pages_.total
      ? "partial"
      : "complete";
  const pageStateSource: DocumentPageStateSource = hasPageTable ? "pages" : "derived";

  const tableRows = format === "table";
  const bits: string[] = [];
  bits.push(
    tableRows
      ? "表格文档（按行入索引：每行一个块，单元格合并/公式未建模）"
      : format === "pdf"
        ? "PDF 文档"
        : format === "word"
          ? "Word 文档"
          : format === "image"
            ? "图片文档（需视觉转录）"
            : format === "text"
              ? "纯文本文档"
              : "文档格式未知（按扩展名也识别不出）",
  );
  if (pages_.total > 0) bits.push(`${pages_.total} 页`);
  if (hasPageTable) {
    bits.push(`文本页 ${pages_.text}`);
    if (pages_.scanned > 0) bits.push(`扫描页 ${pages_.scanned}`);
    if (pages_.mixed > 0) bits.push(`混排页 ${pages_.mixed}`);
    if (pageDataCoverage === "partial") {
      bits.push(`页级状态只覆盖已返回的 ${pages.length}/${pages_.total} 页（partial；其余页不推断）`);
    }
  } else if (pages_.total > 0 && (format === "pdf" || format === "image")) {
    bits.push("页级状态未知（派生：后端未返回 documents.pages，只有文档级状态，不推断）");
  }
  if (needsOcr > 0) {
    bits.push(`OCR 已转录 ${pages_.ocrDone}/${needsOcr}`);
    if (pages_.ocrPending > 0) bits.push(`待转录 ${pages_.ocrPending}`);
    if (pages_.ocrFailed > 0) bits.push(`转录失败 ${pages_.ocrFailed}`);
  }
  if (models.size > 0) bits.push(`视觉模型 ${[...models].join("、")}`);
  if (doc.status && doc.status !== "ready") bits.push(`文档状态 ${doc.status}`);

  return {
    format,
    tableRows,
    pages: pages_,
    ocrState,
    visionModels: [...models],
    pageStateSource,
    pageDataCoverage,
    note: bits.join(" · "),
  };
}

/** 单行渲染（工具输出里一行说清；`note` 已包含全部事实）。 */
export function renderStructureLine(summary: DocumentStructureSummary): string {
  return `结构: ${summary.note}`;
}
