/**
 * 第 207 波：**文本块迁移的"读后写"判据** ✓（判据先行 ✓）。
 *
 * ## 背景（第 204–206 波量出来的 ✓）
 *
 * 迁移要拆掉 `getChunks` 的**镜像同步读** ✗（`no-sync-mirror-reads` 越界 5→3 ✓），
 * 改成只读**按需缓存** ✓ ⇒ 于是"**刚写完就读**"这条语义要重新安放 ✓：
 *
 * ```
 * phase-b-f-regression:692  addChunksBulk(...)
 * phase-b-f-regression:697  getChunks(nb.id)      ← 紧接着同步读回
 * ```
 *
 * 三条不可能同时成立 ✓（第 205 波）：①读后写立刻可读 ✓ ②同步读要么完整要么抛 ✓ ③不许镜像同步读 ✗
 * ⇒ 第 206 波定稿**出路 B** ✓：**放弃"不预热就能同步读到"**✗（既有契约本来也不保证 ✓），
 * 保住 ①② ✓。于是判据分两条 ✓：
 *
 * - **NC-RW-1（待启用 ✓）**：写完之后 **预热完成时** ⇒ 必须读到**完整且含新块**的列表 ✓；
 * - **NC-RW-2（本波就绿 ✓）**：缓存**未知**时 ⇒ **必须抛** ✓
 *   —— **不许**返回不完整列表 ✗（那会让检索静默漏检 ✓，比抛错更糟 ✗）。
 *
 * NC-RW-2 现在就应当通过 ✓（它是**迁移的守门判据** ✓：迁移过程中最容易犯的错
 * 就是"为了让写完立刻可读，把一块塞进空缓存"✗ ⇒ 那条错会被它当场抓住 ✓）。
 *
 * 变异：让 `getChunks` 在缓存为空时"新建一个只含已知块的缓存" ⇒ **NC-RW-2 红** ✓。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding: unknown) => failures.push(String(finding)),
}));

const chunkRow = (id: string, notebookId: string, sourceId: string, index: number) => ({
  id,
  notebook_id: notebookId,
  source_id: sourceId,
  chunk_index: index,
  content: `块${index}`,
  text: `块${index}`,
  created_at: 1,
  embedding: null,
});

/** 镜像**永远不接手** ✓（`neverReady` ✓）⇒ 只剩按需读那条路 ✓ —— 正是迁移后的现实 ✓。 */
function refusedPort() {
  return createFakeStoragePort({
    seed: { notebook_chunks: [chunkRow("c1", "nb1", "src1", 0)] },
    neverReady: ["notebook_chunks"],
  });
}

describe("第 207 波：文本块迁移的读后写", () => {
  beforeEach(() => {
    failures.length = 0;
    vi.resetModules();
  });

  it("NC-RW-2 守门: 缓存**未知**时 getChunks **必须抛**（不许返回不完整列表 ✗）", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const k = await import("../core/knowledge/storage");
    setStoragePort(refusedPort() as never);

    /**
     * 此刻：镜像没接手 ✓、按需缓存也是空的 ✓ ⇒ 唯一正确的行为是**抛** ✓，
     * 并明确说"**这不是'没有相关内容'**"✓（既有契约 ✓）。
     * 若这里**返回**了任何东西 ✗ ⇒ 说明有人在空缓存上"补了一块"✗ ⇒ 检索会静默漏检 ✓。
     */
    expect(
      () => k.getChunks("nb1"),
      "缓存未知 ⇒ 必须抛 ChunkIndexUnavailableError ✓（不许静默给不完整结果 ✗）",
    ).toThrowError(k.ChunkIndexUnavailableError);
  });

  it.skip("NC-RW-1（随「写穿缓存」一起启用 ✓）: 写完之后 **预热完成时** 必须读到完整且含新块的列表", async () => {
    /**
     * 这条要等第 208 波的"写点作废 + 预热"落地 ✓ 才能启 ✓：
     * 1. `addChunksBulk(nb, src, [...])` ✓；
     * 2. 等预热完成 ✓（异步 ✓）；
     * 3. `getChunks(nb)` ⇒ 必须**完整**（含既有块 c1 ✓ 与新块 ✓）且按 `chunk_index` 升序 ✓。
     * ⇒ 它钉的是"**最终**可读"✓，而不是"不预热就能读"✗（后者已被第 206 波明确放弃 ✓）。
     */
  });
});
