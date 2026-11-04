/**
 * DOCI-6：检索/阅读的**契约与预算**。
 *
 * 三条硬约束（ADR-0008 §10，改这里先改 ADR）：
 * 1. 一次 `doc_search` 渲染文本 ≤6,000 token，命中必须带 citation；
 * 2. 一次 `doc_read` ≤4,000 token，超了要 `hasMore`；
 * 3. 索引未就绪 ⇒ 返回**状态**（indexing/needs_ocr），绝不返回空数组冒充「没有相关内容」。
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
import {
  estimateDocTokens,
  fitSearchHits,
  type DocumentSearchHit,
} from "../core/document/client";
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
    chunk_no: 3,
    name: "报告.docx",
    status: "ready",
    page_from: 12,
    page_to: 13,
    heading_path: "3.2 迁移",
    text_offset: 100,
    text_len: 500,
    preview: "这一段讲数据迁移的目标与步骤。",
    score: 1.5,
    ...overrides,
  };
}

afterEach(() => {
  __resetDocumentBackendForTests();
  __resetDocumentLedgerForTests();
});

describe("DOCI-6 预算函数", () => {
  it("fitSearchHits 把 8×3000 字压到 ≤6000 token", () => {
    const hits = Array.from({ length: 8 }, (_, i) =>
      hit({ chunk_no: i, preview: "迁移".repeat(1500) }),
    );
    const fitted = fitSearchHits(hits, 6000);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(hits.length);
    const used = fitted.reduce((n, f) => n + estimateDocTokens(f.snippet) + 20, 0);
    expect(used).toBeLessThanOrEqual(6000);
    for (const f of fitted) expect(estimateDocTokens(f.snippet)).toBeLessThanOrEqual(900);
  });

  it("token 估算与 Rust 同口径（中文 1 token/字，英文 4 字符/token）", () => {
    expect(estimateDocTokens("存储迁移")).toBe(4);
    expect(estimateDocTokens("abcd")).toBe(1);
  });
});

describe("DOCI-6 doc_search 契约", () => {
  it("命中带 citation，且返回体在预算内", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc()],
      hits: [hit(), hit({ chunk_no: 4, preview: "另一段关于迁移的说明。", page_from: 14, page_to: 14 })],
    });
    setDocumentBackend(fake.backend);

    const res = await tool("doc_search").execute({ query: "迁移" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[file: 报告.docx");
    expect(res.output).toContain("page: 12-13");
    expect(res.output).toContain("§3.2 迁移");
    expect(res.output).toContain("chunk: doc_1#3");
    expect((res.metadata as any).tokens).toBeLessThanOrEqual(6000);
    expect((res.metadata as any).hits).toBe(2);
    // 查询原样下传（中文不被改写）
    expect(fake.calls.find((c) => c.name === "documents.search")?.params).toMatchObject({ query: "迁移" });
  });

  it("索引未就绪 ⇒ 返回状态，不返回「没有相关内容」", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ id: "doc_x", status: "indexing", chunk_count: 0 })],
      hits: [],
      byStatus: { indexing: 1 },
    });
    setDocumentBackend(fake.backend);

    const res = await tool("doc_search").execute({ query: "迁移" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("还没就绪");
    expect((res.metadata as any).status).toBe("indexing");
    expect(res.output).not.toContain("没有命中");
  });

  it("空查询报参数错误（不退化成全表）", async () => {
    const fake = createFakeDocumentBackend({ documents: [makeDoc()] });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_search").execute({ query: "   " }, ctx());
    expect(res.isError).toBe(true);
    expect(fake.calls.some((c) => c.name === "documents.search")).toBe(false);
  });

  it("needs_ocr 的文档会让 0 命中带上解释（不是假结论）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ id: "doc_scan", name: "扫描件.pdf", status: "needs_ocr", chunk_count: 0 })],
      hits: [],
      byStatus: { needs_ocr: 1 },
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_search").execute({ query: "合同" }, ctx());
    expect(res.output).toContain("需 OCR");
    expect((res.metadata as any).degraded).toBe(1);
  });
});

describe("DOCI-6 doc_read 预算", () => {
  it("超预算截断并标 hasMore", async () => {
    const longText = "迁移步骤说明。".repeat(2000); // ≈12000 token
    const fake = createFakeDocumentBackend({
      documents: [makeDoc()],
      texts: { "doc_1#3": longText },
      chunks: {
        doc_1: [
          {
            chunk_no: 3,
            page_from: 12,
            page_to: 12,
            heading_path: "3.2 迁移",
            text_offset: 0,
            text_len: longText.length,
            token_count: 12000,
            preview: "…",
          },
        ],
      },
    });
    setDocumentBackend(fake.backend);

    const res = await tool("doc_read").execute(
      { document_id: "doc_1", chunk_no: 3, max_tokens: 200 },
      ctx(),
    );
    expect(res.isError).toBe(false);
    expect((res.metadata as any).hasMore).toBe(true);
    const body = res.output.split("\n\n").slice(1).join("\n\n");
    expect(estimateDocTokens(body)).toBeLessThanOrEqual(220);
    expect(res.output).toContain("file: 报告.docx");
  });

  it("只给 document_id ⇒ 返回大纲与块提示（不返回整篇）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc({ page_count: 320, chunk_count: 900 })],
      headings: [
        { heading: "第一章 总则", block_no: 0 },
        { heading: "第二章 迁移", block_no: 40 },
      ],
      chunks: { doc_1: [{ chunk_no: 0, page_from: 1, page_to: 1, text_offset: 0, text_len: 10, token_count: 3 }] },
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_read").execute({ document_id: "doc_1" }, ctx());
    expect(res.output).toContain("第一章 总则");
    expect(res.output).toContain("chunk_no");
    expect(res.output).not.toContain("迁移步骤说明。".repeat(10));
  });
});

describe("DOCI-6 doc_outline / doc_status", () => {
  it("outline 只给结构与状态，不给正文", async () => {
    const fake = createFakeDocumentBackend({
      documents: [makeDoc(), makeDoc({ id: "doc_2", name: "附件.pdf", status: "needs_engine", error: "PDFium 未就绪" })],
      headings: [{ heading: "第一章 总则", block_no: 0 }],
    });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_outline").execute({}, ctx());
    expect(res.output).toContain("报告.docx");
    expect(res.output).toContain("已索引");
    expect(res.output).toContain("附件.pdf");
    expect(res.output).toContain("需 PDF 引擎");
    expect(res.output).toContain("PDFium 未就绪");
  });

  it("status 给出索引库与 PDF 引擎状态（可行动）", async () => {
    const fake = createFakeDocumentBackend({ documents: [makeDoc()] });
    setDocumentBackend(fake.backend);
    const res = await tool("doc_status").execute({}, ctx());
    expect(res.output).toContain("schema v1");
    expect(res.output).toContain("PDF 引擎");
    expect(res.output).toContain("全部文档已就绪");
  });
});
