/**
 * C05：文档结构可查询 —— `doc_outline` / `doc_search` / `doc_read` 的**引用与状态**判据。
 *
 * 验收口径（docs/marketing/context-os.claims.json C05）：
 * 「doc_outline/doc_search/doc_read 可用；结果带页码/章节/chunk 引用；表格/OCR 文档有明确状态。」
 *
 * 三条判据各自会因为实现坏掉而红：
 * 1. outline 丢层级/页码（`documentOutlineDetailed` 的页码合并或渲染被改坏）；
 * 2. search 的 citation 元数据丢字段（page/section/chunk 任一缺失）；
 * 3. read 页时不带页状态/OCR 来源（扫描页文本被当成原文）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../core/llm/tools";
import {
  createDocOutlineTool,
  createDocReadTool,
  createDocSearchTool,
  createDocStatusTool,
  withDocOutputValue,
} from "../core/llm/tools/document-tools";
import type { DocumentSearchHit } from "../core/document/client";
import {
  __resetDocumentBackendForTests,
  __resetDocumentLedgerForTests,
  setDocumentBackend,
} from "../core/document/test-seams";
import { createFakeDocumentBackend, makeDoc } from "./helpers/documents-fake";

function ctx(sessionId = "s1"): ToolContext {
  return {
    sessionId,
    messageId: "m1",
    cwd: "C:\\project",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as unknown as ToolContext;
}

function tool(id: string) {
  const all = [
    withDocOutputValue(createDocOutlineTool()),
    withDocOutputValue(createDocSearchTool()),
    withDocOutputValue(createDocReadTool()),
    withDocOutputValue(createDocStatusTool()),
  ];
  const found = all.find((t) => t.id === id);
  if (!found) throw new Error(`缺少工具 ${id}`);
  return found;
}

function hit(overrides: Partial<DocumentSearchHit> = {}): DocumentSearchHit {
  return {
    document_id: "doc_1",
    chunk_no: 9,
    name: "报告.docx",
    status: "ready",
    page_from: 12,
    page_to: 12,
    heading_path: "第二章 迁移",
    text_offset: 0,
    text_len: 100,
    preview: "迁移分三步。",
    score: 1,
    ...overrides,
  };
}

const CHUNKS = {
  doc_1: [
    {
      chunk_no: 0,
      page_from: 1,
      page_to: 1,
      heading_path: "第一章 总则",
      text_offset: 0,
      text_len: 10,
      token_count: 3,
      preview: "总则",
    },
    {
      chunk_no: 3,
      page_from: 1,
      page_to: 2,
      heading_path: "第一章 总则 > 1.1 范围",
      text_offset: 10,
      text_len: 40,
      token_count: 10,
      preview: "范围",
    },
    {
      chunk_no: 9,
      page_from: 12,
      page_to: 12,
      heading_path: "第二章 迁移",
      text_offset: 50,
      text_len: 80,
      token_count: 20,
      preview: "迁移",
    },
  ],
};

afterEach(() => {
  __resetDocumentBackendForTests();
  __resetDocumentLedgerForTests();
});

describe("C05-1 doc_outline：层级 + 页码 + 结构状态", () => {
  it("标题按层级列出并带页码（p.1 / p.12），页码覆盖度如实标注", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ page_count: 12, chunk_count: 3 })],
      headings: [
        { heading: "第一章 总则", block_no: 0 },
        { heading: "第一章 总则 > 1.1 范围", block_no: 2 },
        { heading: "第二章 迁移", block_no: 9 },
      ],
      chunks: CHUNKS,
    });
    setDocumentBackend(fake.backend);

    const res = await tool("doc_outline").execute({ document_id: "doc_1" }, ctx());
    expect(res.isError).toBe(false);
    // 层级：父章节与子章节都在，且顺序稳定
    expect(res.output).toContain("1. 第一章 总则 · p.1");
    expect(res.output).toContain("2. 第一章 总则 > 1.1 范围 · p.1");
    expect(res.output).toContain("3. 第二章 迁移 · p.12");
    expect((res.metadata as any).pageCoverage).toBe("complete");
    expect((res.metadata as any).headings).toBe(3);
  });

  it("页码取不全时标 partial（不编造页码）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ page_count: 30 })],
      headings: [
        { heading: "第一章 总则", block_no: 0 },
        { heading: "第三章 未取到块", block_no: 90 },
      ],
      chunks: {
        doc_1: [
          {
            chunk_no: 0,
            page_from: 2,
            page_to: 2,
            heading_path: "第一章 总则",
            text_offset: 0,
            text_len: 10,
            token_count: 3,
          },
        ],
      },
      // 模拟「块元数据被 limit 截断」：未命中页码的标题可能只是没取到，不能断言它无页码
      chunksHasMore: true,
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_outline").execute({ document_id: "doc_1" }, ctx());
    expect((res.metadata as any).pageCoverage).toBe("partial");
    expect(res.output).toContain("第一章 总则 · p.2");
    expect(res.output).toContain("第三章 未取到块");
    // 未取到块的标题不写页码（宁缺不编）
    expect(res.output).not.toContain("第三章 未取到块 · p.");
  });

  it("表格类文档与扫描/OCR 页有明确状态（表格按行入索引；OCR 进度可见）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [
        makeDoc({ id: "doc_x", name: "名录.xlsx", mime: "text/csv", page_count: 2, chunk_count: 4 }),
      ],
      headings: [{ heading: "Sheet1", block_no: 0 }],
      chunks: { doc_x: [{ chunk_no: 0, page_from: 1, page_to: 1, heading_path: "Sheet1", text_offset: 0, text_len: 10, token_count: 3 }] },
      pages: {
        doc_x: [
          { page_no: 1, kind: "text", text_source: "layout", text_bytes: 10 },
          { page_no: 2, kind: "scanned", ocr_state: "pending", text_bytes: 0 },
        ],
      },
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_outline").execute({ document_id: "doc_x" }, ctx());
    expect(res.output).toContain("表格文档（按行入索引");
    expect(res.output).toContain("扫描页 1");
    expect(res.output).toContain("待转录 1");
    expect((res.metadata as any).structure.tableRows).toBe(true);
    expect((res.metadata as any).structure.ocrState).toBe("pending");
  });
});

describe("C05-2 doc_search：每条命中带 page/section/chunk 引用（机器可读）", () => {
  it("metadata.citations 完整，输出里的 citation 三段齐全", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc()],
      hits: [hit()],
    });
    setDocumentBackend(fake.backend);

    const res = await tool("doc_search").execute({ query: "迁移" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[file: 报告.docx | page: 12 | §第二章 迁移 | chunk: doc_1#9]");
    const citations = (res.metadata as any).citations as Array<Record<string, unknown>>;
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      documentId: "doc_1",
      chunkNo: 9,
      pageFrom: 12,
      pageTo: 12,
      headingPath: "第二章 迁移",
    });
    expect(String(citations[0].citation)).toContain("chunk: doc_1#9");
  });

  it("命中来自未就绪文档时当场说明（不是「没有相关内容」）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [
        makeDoc({ id: "doc_ok", name: "说明书.docx" }),
        makeDoc({ id: "doc_scan", name: "扫描件.pdf", status: "needs_ocr", chunk_count: 0 }),
      ],
      // 至少一份 ready：否则 notReadyAnswer 会先返回「索引还没就绪」，走不到命中分支
      byStatus: { ready: 1, needs_ocr: 1 },
      hits: [hit({ document_id: "doc_scan", name: "扫描件.pdf", status: "needs_ocr", heading_path: "合同" })],
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_search").execute({ query: "合同" }, ctx());
    expect((res.metadata as any).degradedStatuses).toEqual(["needs_ocr"]);
    expect(res.output).toContain("别据此断定");
  });
});

describe("C05-3 doc_read：页码/章节引用 + OCR 来源状态", () => {
  it("读扫描页：引用带 source: vision(model)，并单独给页状态", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ page_count: 2 })],
      chunks: CHUNKS,
      texts: { "doc_1#3": "扫描页转录出来的正文。" },
      pages: {
        doc_1: [
          { page_no: 1, kind: "text", text_source: "layout", text_bytes: 10 },
          { page_no: 2, kind: "scanned", text_source: "vision", ocr_state: "done", ocr_model: "mimo-vl", text_bytes: 30 },
        ],
      },
    });
    setDocumentBackend(fake.backend);

    const res = await tool("doc_read").execute({ document_id: "doc_1", page: 2 }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("source: vision(mimo-vl)");
    expect(res.output).toContain("页状态: 扫描页 · OCR 已完成（mimo-vl）");
    expect((res.metadata as any).pageKind).toBe("scanned");
    expect((res.metadata as any).ocrState).toBe("done");
    expect((res.metadata as any).textSource).toBe("vision");
  });

  it("读普通块：citation 仍有 page + 章节 + chunk（不提 OCR 来源）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc()],
      chunks: CHUNKS,
      texts: { "doc_1#9": "迁移正文。" },
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_read").execute({ document_id: "doc_1", chunk_no: 9 }, ctx());
    // fake readText 的 citation 固定返回 pageFrom/pageTo/headingPath —— 三件套都要在引用里
    expect(res.output).toContain("page: 1");
    expect(res.output).toContain("§第一章");
    expect(res.output).toContain("chunk: doc_1#9");
    expect(res.output).not.toContain("source: vision");
  });
});

describe("C05-4 doc_status：结构/OCR 汇总（可行动）", () => {
  it("列出扫描页与 OCR 进度，而不是只给状态计数", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ id: "doc_scan", name: "扫描件.pdf", status: "needs_ocr", page_count: 3, chunk_count: 1 })],
      chunks: { doc_scan: [] },
      pages: {
        doc_scan: [
          { page_no: 1, kind: "scanned", ocr_state: "done", text_source: "vision", ocr_model: "mimo-vl", text_bytes: 10 },
          { page_no: 2, kind: "scanned", ocr_state: "pending", text_bytes: 0 },
          { page_no: 3, kind: "scanned", ocr_state: "failed", text_bytes: 0 },
        ],
      },
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_status").execute({}, ctx());
    expect(res.output).toContain("结构/OCR:");
    expect(res.output).toContain("扫描页 3");
    expect(res.output).toContain("OCR 已转录 1/3");
    expect(res.output).toContain("转录失败 1");
    expect((res.metadata as any).structureChecked).toBe(1);
  });
});

/**
 * C05-5：页级状态**优先用真实 `documents.pages`**，没有才是派生口径（且必须标注）。
 *
 * 为什么单独钉一条：`documents.pages` 是「这一页是扫描件 / 正文来自视觉转录」的唯一权威来源；
 * 按块读（`chunk_no`）原来根本不看页表 ⇒ 扫描页的正文会被当成原文引用。
 * 判据双向：
 * - 有 pages ⇒ outline/read 都用 pages（read 的引用带 `source: vision(...)`）；
 * - 没有 pages ⇒ 明确写「派生 + 后端未返回 documents.pages」，**不**断言 OCR 来源；
 * - 页表只覆盖一部分页 ⇒ 标 `partial`（其余页不推断）。
 *
 * 变红方式：把 read 的页状态改回只看 `pageMeta`（按块读永远没有）⇒ 有 pages 的用例红；
 * 把派生分支去掉/静默 ⇒ 无 pages 的用例红；把 coverage 恒写 complete ⇒ partial 用例红。
 */
describe("C05-5 页级状态优先真实 pages（无 pages 才派生且标注）", () => {
  const SCANNED_PAGE_CHUNK = {
    chunk_no: 5,
    page_from: 1,
    page_to: 1,
    heading_path: "第二章 迁移",
    text_offset: 0,
    text_len: 30,
    token_count: 8,
  };

  it("有 pages：outline 用页表统计，按块读也带 OCR 来源与页状态（source=pages）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ name: "扫描件.pdf", mime: "application/pdf", page_count: 2, chunk_count: 1 })],
      headings: [{ heading: "第二章 迁移", block_no: 0 }],
      chunks: { doc_1: [SCANNED_PAGE_CHUNK] },
      texts: { "doc_1#5": "扫描页转录出来的正文。" },
      pages: {
        doc_1: [
          { page_no: 1, kind: "scanned", text_source: "vision", ocr_state: "done", ocr_model: "mimo-vl", text_bytes: 30 },
          { page_no: 2, kind: "text", text_source: "layout", text_bytes: 10 },
        ],
      },
    });
    setDocumentBackend(fake.backend);

    const outline = await tool("doc_outline").execute({ document_id: "doc_1" }, ctx());
    const structure = (outline.metadata as any).structure;
    expect(structure.pageStateSource, "有真实页数据时必须优先用它").toBe("pages");
    expect(structure.pageDataCoverage).toBe("complete");
    expect(outline.output).toContain("扫描页 1");
    expect(outline.output).toContain("OCR 已转录 1/1");

    const read = await tool("doc_read").execute({ document_id: "doc_1", chunk_no: 5 }, ctx());
    expect(read.output, "按块读到扫描页也必须写明来源").toContain("source: vision(mimo-vl)");
    expect(read.output).toContain("页状态: 扫描页 · OCR 已完成（mimo-vl）");
    expect((read.metadata as any).pageStateSource).toBe("pages");
    expect((read.metadata as any).pageKind).toBe("scanned");
    expect((read.metadata as any).ocrState).toBe("done");
    expect((read.metadata as any).textSource).toBe("vision");
  });

  it("没有 pages：outline/read 走派生口径并明确标注（不断言 OCR 来源）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ name: "扫描件.pdf", mime: "application/pdf", page_count: 2, chunk_count: 1 })],
      headings: [{ heading: "第二章 迁移", block_no: 0 }],
      chunks: { doc_1: [SCANNED_PAGE_CHUNK] },
      texts: { "doc_1#5": "没有页级数据的正文。" },
      // 刻意不提供 pages：后端不返回页表
    });
    setDocumentBackend(fake.backend);

    const outline = await tool("doc_outline").execute({ document_id: "doc_1" }, ctx());
    const structure = (outline.metadata as any).structure;
    expect(structure.pageStateSource, "没有页表时只能是派生口径").toBe("derived");
    expect(structure.pageDataCoverage).toBe("none");
    expect(outline.output).toContain("页级状态未知（派生：后端未返回 documents.pages");

    const read = await tool("doc_read").execute({ document_id: "doc_1", chunk_no: 5 }, ctx());
    expect(read.output, "派生时必须写明「派生」与依据").toContain("页状态: 未知（派生：");
    expect(read.output).toContain("documents.pages");
    expect(read.output, "派生口径不许断言 OCR 来源").not.toContain("source: vision");
    expect((read.metadata as any).pageStateSource).toBe("derived");
    expect((read.metadata as any).pageDataCoverage).toBe("none");
    expect((read.metadata as any).textSource).toBeNull();
  });

  it("页表只覆盖一部分页：标 partial，其余页不推断", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ name: "长文档.pdf", mime: "application/pdf", page_count: 5, chunk_count: 1 })],
      headings: [{ heading: "第一章", block_no: 0 }],
      chunks: { doc_1: [SCANNED_PAGE_CHUNK] },
      pages: {
        doc_1: [{ page_no: 1, kind: "text", text_source: "layout", text_bytes: 10 }],
      },
    });
    setDocumentBackend(fake.backend);

    const outline = await tool("doc_outline").execute({ document_id: "doc_1" }, ctx());
    const structure = (outline.metadata as any).structure;
    expect(structure.pageStateSource).toBe("pages");
    expect(structure.pageDataCoverage, "只返回 1/5 页时不能标 complete").toBe("partial");
    expect(outline.output).toContain("页级状态只覆盖已返回的 1/5 页（partial；其余页不推断）");
  });
});

