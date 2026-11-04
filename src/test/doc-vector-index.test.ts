/**
 * 向量索引补齐（可选能力）：批次写入、覆盖判断、失败降级。
 *
 * 真实 embedding 模型不在这里跑：`embed` 可注入；本判据只钉编排契约：
 * 1. 只在 embedding 配置启用时工作；
 * 2. 已覆盖的文档跳过（不重复花 API/CPU）；
 * 3. 单文档失败不拖垮其它文档，纯 FTS 仍可用。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCollectionVectors } from "../core/document/vector-index";
import {
  __resetDocumentBackendForTests,
  setDocumentBackend,
  type DocumentRecord,
} from "../core/document/client";
import { createFakeDocumentBackend } from "./helpers/documents-fake";

vi.mock("../core/llm/multimodal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm/multimodal")>();
  return {
    ...actual,
    getMultimodalSettings: () => ({
      embedding: { enabled: true, providerId: "local", model: "test-model", apiKey: "", baseUrl: "" },
    }),
  };
});

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc_1",
    collection_id: "c1",
    kind: "attachment",
    dedupe_key: "blob:1",
    name: "报告.pdf",
    size: 100,
    page_count: 2,
    block_count: 2,
    chunk_count: 2,
    text_bytes: 20,
    status: "ready",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

afterEach(() => __resetDocumentBackendForTests());

describe("VEC-1 向量补齐编排", () => {
  it("两份文档按批嵌入并写入（replace_all 只用于首块）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [doc(), doc({ id: "doc_2", name: "附件.docx", dedupe_key: "blob:2" })],
      chunks: {
        doc_1: [
          { chunk_no: 0, page_from: 1, page_to: 1, heading_path: null },
          { chunk_no: 1, page_from: 2, page_to: 2, heading_path: null },
        ],
        doc_2: [{ chunk_no: 0, page_from: 1, page_to: 1, heading_path: null }],
      },
      texts: { "doc_1#0": "迁移目标", "doc_1#1": "验收步骤", "doc_2#0": "附录" },
    });
    setDocumentBackend(fake.backend);

    const embed = vi.fn(async (texts: string[]) => texts.map((_, i) => [1, i + 1, 0]));
    const res = await ensureCollectionVectors("c1", { embed });

    expect(res).toMatchObject({ documents: 2, chunks: 3, model: "test-model" });
    expect(embed).toHaveBeenCalledTimes(2);
    const upserts = fake.calls.filter((c) => c.name === "documents.vector_upsert");
    expect(upserts).toHaveLength(2);
    expect((upserts[0].params as any).replace_all).toBe(true);
    expect((upserts[0].params as any).vectors).toHaveLength(2);
    expect((upserts[1].params as any).replace_all).toBe(true);
    expect((upserts[0].params as any).model).toBe("test-model");
  });

  it("已覆盖的文档跳过（不重复嵌入）", async () => {
    const fake = createFakeDocumentBackend({
      documents: [doc()],
      chunks: {
        doc_1: [
          { chunk_no: 0, page_from: 1, page_to: 1, heading_path: null },
          { chunk_no: 1, page_from: 2, page_to: 2, heading_path: null },
        ],
      },
      vectorStatus: [{ document_id: "doc_1", model: "test-model", chunks: 2, dim: 3 }],
    });
    setDocumentBackend(fake.backend);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const res = await ensureCollectionVectors("c1", { embed });
    expect(res.skipped).toBe(1);
    expect(res.chunks).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it("规模 ≥1024 时训练 IVF；增长不足 30% 不重复训练", async () => {
    const fake = createFakeDocumentBackend({
      documents: [],
      vectorCount: 2000,
      vectorMeta: null,
    });
    setDocumentBackend(fake.backend);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    await ensureCollectionVectors("c1", { embed });
    expect(fake.calls.filter((c) => c.name === "documents.vector_train")).toHaveLength(1);

    // 已训练 1900，现在 2000（+5%）→ 不重训
    fake.seed.vectorMeta = { dim: 8, count: 1900, k: 32, trained_at: 1 };
    await ensureCollectionVectors("c1", { embed });
    expect(fake.calls.filter((c) => c.name === "documents.vector_train")).toHaveLength(1);
  });

  it("单文档嵌入失败不抛出，也不影响其它文档", async () => {
    const fake = createFakeDocumentBackend({
      documents: [doc(), doc({ id: "doc_2", dedupe_key: "blob:2" })],
      chunks: {
        doc_1: [{ chunk_no: 0, page_from: 1, page_to: 1, heading_path: null }],
        doc_2: [{ chunk_no: 0, page_from: 1, page_to: 1, heading_path: null }],
      },
    });
    setDocumentBackend(fake.backend);
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce([[1, 0, 0]]);
    const res = await ensureCollectionVectors("c1", { embed });
    expect(res.documents).toBe(1);
    expect(res.chunks).toBe(1);
  });
});
