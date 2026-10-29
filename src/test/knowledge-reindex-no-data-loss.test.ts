/**
 * 重新索引必须**先算完再替换**（第 233 轮审计 · 数据丢失）。
 *
 * ## 缺陷形态（`src/core/knowledge/indexer.ts`）
 *
 * ```ts
 * deleteChunksBySource(source.id);            // :85  ← 先把旧块删掉
 * for (...) { await generateEmbeddings(...) } // :94-111  ← 这里才可能抛错
 * addChunksBulk(...)                          // :121  ← 还没走到
 * ... catch { updateSource({status:'failed'}) } // :149-152  ← 只改状态，不动计数
 * ```
 *
 * 再加上 `reindexSource()` 在开始前就 `updateSource({ chunkCount: 0 })`（:404），于是：
 *
 * 1. **embedding 服务不可用/限流**（`multimodal.ts` 明确 throw）⇒ 旧块已被删、新块没写
 *    ⇒ 用户一个「重新索引」就把已有索引清空（不可恢复，只能靠重新索引成功一次）；
 * 2. 失败分支只写 `status/errorMessage`，**不修 `chunk_count`** ⇒ 界面上的块数继续显示旧值，
 *    而检索侧对空块返回 `[]`（不抛）⇒ 呈现为「没有相关内容」= 一句假陈述；
 * 3. `chunkCount: 0` 在**抽取/分块阶段**失败时同样是假的：那时块还在库里，UI 却说 0。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | IDX-1 | embedding 失败 ⇒ **旧块必须还在**（`deleteChunksBySource` 未在失败前被调用） |
 * | IDX-2 | embedding 失败 ⇒ `chunk_count` 不许被写成 0 / 不许与库里的真实块数脱节 |
 * | IDX-3 | 成功路径照旧：先清旧块再写新块（反向对照，不能变成"只增不删"） |
 *
 * 变异自证：把 `deleteChunksBySource` 挪回 embedding 之前 ⇒ IDX-1 立刻红；
 * 把 `reindexSource` 里的 `chunkCount: 0` 加回去 ⇒ IDX-2 红。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  extractText: vi.fn(),
  chunkText: vi.fn(),
  generateEmbeddings: vi.fn(),
  isUsingLocalEmbedding: vi.fn(() => false),
  addSource: vi.fn(),
  updateSource: vi.fn(),
  addChunksBulk: vi.fn(),
  deleteChunksBySource: vi.fn(),
  refreshNotebookCounts: vi.fn(),
  updateNotebook: vi.fn(),
  getSource: vi.fn(),
  listSources: vi.fn(() => []),
}));

vi.mock("../core/knowledge/extractor", () => ({ extractText: mocks.extractText }));
vi.mock("../core/knowledge/chunker", () => ({ chunkText: mocks.chunkText }));
vi.mock("../core/llm/multimodal", () => ({
  generateEmbeddings: mocks.generateEmbeddings,
  isUsingLocalEmbedding: mocks.isUsingLocalEmbedding,
}));
vi.mock("../core/knowledge/storage", () => ({
  addSource: mocks.addSource,
  updateSource: mocks.updateSource,
  addChunksBulk: mocks.addChunksBulk,
  deleteChunksBySource: mocks.deleteChunksBySource,
  refreshNotebookCounts: mocks.refreshNotebookCounts,
  updateNotebook: mocks.updateNotebook,
  getSource: mocks.getSource,
  listSources: mocks.listSources,
}));

import { indexSource, reindexSource } from "../core/knowledge/indexer";

const source = {
  id: "src-1",
  notebookId: "nb-1",
  name: "a.md",
  type: "file",
  uri: "C:/ws/a.md",
  status: "indexed",
  chunkCount: 40,
  addedAt: 1,
} as never;

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function" && "mockReset" in fn) (fn as { mockReset: () => void }).mockReset();
  }
  mocks.isUsingLocalEmbedding.mockReturnValue(false);
  mocks.extractText.mockResolvedValue({ text: "hello world" });
  mocks.chunkText.mockReturnValue([
    { content: "hello", chunkIndex: 0, tokenCount: 1 },
    { content: "world", chunkIndex: 1, tokenCount: 1 },
  ]);
  mocks.getSource.mockReturnValue(source);
});

describe("重新索引：先算完再替换", () => {
  it("IDX-1: embedding 失败 ⇒ 旧块不得被删", async () => {
    mocks.generateEmbeddings.mockRejectedValue(new Error("embedding 服务不可用"));
    await indexSource(source);

    expect(
      mocks.deleteChunksBySource.mock.calls.length,
      "旧块在 embedding 成功之前就被删掉了（一次失败 = 索引清空）",
    ).toBe(0);
    expect(mocks.addChunksBulk, "新块不该写进去").not.toHaveBeenCalled();
  });

  it("IDX-2: embedding 失败 ⇒ chunk_count 不得被写成 0（与库里真实块数保持一致）", async () => {
    mocks.generateEmbeddings.mockRejectedValue(new Error("限流"));
    await indexSource(source);

    const countWrites = mocks.updateSource.mock.calls
      .map(([, patch]) => patch as Record<string, unknown>)
      .filter((p) => "chunkCount" in p);
    expect(
      countWrites.map((p) => p.chunkCount),
      "失败路径不得改动块数（旧块还在库里，改成 0 就是假陈述）",
    ).toEqual([]);
  });

  it("IDX-2b: reindexSource 开始时不得先把 chunkCount 归零", async () => {
    mocks.generateEmbeddings.mockRejectedValue(new Error("限流"));
    await reindexSource("src-1");

    const zeroed = mocks.updateSource.mock.calls
      .map(([, patch]) => patch as Record<string, unknown>)
      .some((p) => p.chunkCount === 0);
    expect(zeroed, "reindexSource 在索引成功前把块数写成 0").toBe(false);
  });

  it("IDX-3（反向对照）: 成功路径仍然先清旧块再写新块", async () => {
    mocks.generateEmbeddings.mockResolvedValue([{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }]);
    await indexSource(source);

    expect(mocks.deleteChunksBySource).toHaveBeenCalledWith("src-1");
    expect(mocks.addChunksBulk).toHaveBeenCalledTimes(1);
    const delOrder = mocks.deleteChunksBySource.mock.invocationCallOrder[0];
    const addOrder = mocks.addChunksBulk.mock.invocationCallOrder[0];
    expect(delOrder, "先删后加（不能只增不删、留下重复块）").toBeLessThan(addOrder);

    const indexed = mocks.updateSource.mock.calls
      .map(([, patch]) => patch as Record<string, unknown>)
      .find((p) => p.status === "indexed");
    expect(indexed?.chunkCount, "成功后写真实块数").toBe(2);
  });
});
