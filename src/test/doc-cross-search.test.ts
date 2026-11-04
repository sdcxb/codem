/**
 * 跨文档问答的证据层（`doc_cross_search`）：
 * 1. 一次查询跨多份文档，按文档分组、每条带稳定 citation；
 * 2. 没配 embedding 时只用全文，`meta.vectorUsed=false`（不假装用过向量）；
 * 3. 配了 embedding 时合并向量命中（同块去重、只出现一次）；
 * 4. 本工具**不生成答案**：输出明确要求调用方基于证据作答。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocCrossSearchTool } from "../core/llm/tools/document-tools";
import {
  __resetDocumentBackendForTests,
  setDocumentBackend,
  type DocumentRecord,
  type DocumentSearchHit,
} from "../core/document/client";
import { createFakeDocumentBackend } from "./helpers/documents-fake";

vi.mock("../core/llm/multimodal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm/multimodal")>();
  return {
    ...actual,
    generateEmbeddings: vi.fn(async () => [{ text: "q", embedding: [1, 0] }]),
  };
});

vi.mock("../core/document/vector-index", () => ({
  isVectorIndexAvailable: vi.fn(() => false),
}));

import { generateEmbeddings } from "../core/llm/multimodal";
import { isVectorIndexAvailable } from "../core/document/vector-index";

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc_1",
    collection_id: "session:s1",
    kind: "attachment",
    dedupe_key: "blob:1",
    name: "报告.pdf",
    size: 100,
    page_count: 2,
    block_count: 2,
    chunk_count: 2,
    text_bytes: 100,
    status: "ready",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function hit(overrides: Partial<DocumentSearchHit> = {}): DocumentSearchHit {
  return {
    document_id: "doc_1",
    chunk_no: 0,
    name: "报告.pdf",
    status: "ready",
    page_from: 1,
    page_to: 1,
    heading_path: "第一章",
    text_offset: 0,
    text_len: 100,
    preview: "迁移目标与范围",
    score: 1,
    ...overrides,
  };
}

function ctx() {
  return {
    sessionId: "s1",
    messageId: "m1",
    cwd: ".",
    abort: new AbortController().signal,
    messages: [],
    metadata: vi.fn(),
  } as any;
}

afterEach(() => {
  __resetDocumentBackendForTests();
  vi.mocked(isVectorIndexAvailable).mockReturnValue(false);
  vi.mocked(generateEmbeddings).mockClear();
});

describe("CROSS-1 全文证据（无向量）", () => {
  it("跨两份文档分组、每条带 citation、明确 evidence 模式", async () => {
    const fake = createFakeDocumentBackend({
      documents: [doc(), doc({ id: "doc_2", name: "附件.docx", dedupe_key: "blob:2" })],
      hits: [
        hit({ chunk_no: 0, preview: "报告里的迁移范围" }),
        hit({ chunk_no: 1, document_id: "doc_2", name: "附件.docx", page_from: 3, preview: "附件里的验收清单" }),
      ],
    });
    setDocumentBackend(fake.backend);

    const res = await createDocCrossSearchTool().execute({ query: "迁移 验收" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("## 报告.pdf");
    expect(res.output).toContain("## 附件.docx");
    expect(res.output).toContain("[file: 报告.pdf");
    expect(res.output).toContain("[file: 附件.docx");
    expect(res.output).toContain("chunk: doc_1#0");
    expect(res.output).toContain("请只基于下列证据作答");
    expect((res.metadata as any).vectorUsed).toBe(false);
    expect((res.metadata as any).documents).toBe(2);
    expect(generateEmbeddings).not.toHaveBeenCalled();
  });
});

describe("CROSS-2 混合检索（配了 embedding）", () => {
  it("向量命中与全文命中按块去重，meta 标记 vectorUsed", async () => {
    vi.mocked(isVectorIndexAvailable).mockReturnValue(true);
    const fake = createFakeDocumentBackend({
      documents: [doc()],
      hits: [hit({ chunk_no: 0 })],
      vectors: [
        { document_id: "doc_1", chunk_no: 0, score: 0.9, name: "报告.pdf", page_from: 1, page_to: 1 },
        { document_id: "doc_1", chunk_no: 1, score: 0.8, name: "报告.pdf", page_from: 2, page_to: 2 },
      ],
      texts: { "doc_1#1": "只有向量才召回的验收段落" },
    });
    setDocumentBackend(fake.backend);

    const res = await createDocCrossSearchTool().execute(
      { query: "验收", limit: 5 },
      ctx(),
    );
    expect(res.isError).toBe(false);
    expect(generateEmbeddings).toHaveBeenCalledOnce();
    expect((res.metadata as any).vectorUsed).toBe(true);
    expect((res.metadata as any).hits).toBe(2);
    // 同块只出现一次（chunk#0 既在 FTS 又在向量里）
    const citations0 = (res.output.match(/chunk: doc_1#0/g) ?? []).length;
    expect(citations0).toBe(1);
    expect(res.output).toContain("chunk: doc_1#1");
    expect(res.output).toContain("只有向量才召回的验收段落");
  });

  it("向量调用失败时降级全文，并如实标 vectorUsed=false", async () => {
    vi.mocked(isVectorIndexAvailable).mockReturnValue(true);
    vi.mocked(generateEmbeddings).mockRejectedValueOnce(new Error("embedding down"));
    const fake = createFakeDocumentBackend({
      documents: [doc()],
      hits: [hit()],
    });
    setDocumentBackend(fake.backend);
    const res = await createDocCrossSearchTool().execute({ query: "迁移" }, ctx());
    expect(res.isError).toBe(false);
    expect((res.metadata as any).vectorUsed).toBe(false);
    expect(res.output).toContain("chunk: doc_1#0");
  });
});
