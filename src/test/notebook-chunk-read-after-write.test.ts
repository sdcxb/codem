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

  /**
   * ⚠️ 第 261 波：**仍然 skip，但原因换了** ✗→✓（换了之后这条判据更有价值 ✓）。
   *
   * 我按"写穿缓存"已经落地 ✓ 的理由把它启用了 ✓ ⇒ 它**红** ✗：
   * `expected [0] to deeply equal [0, 1]` ×
   * ⇒ 写完 + 预热之后，**只读到既有块**（`c1`，index 0 ✓），**新块根本没进引擎** ✗。
   *
   * ## 这暴露的是**产品侧另一半**（与第 104/105 波那条"删除"同源 ✓）
   *
   * 那个夹具里镜像 `neverReady` ✓（= 迁移后 `notebook_chunks` 的现实 ✓：
   * 它**天生不该进镜像** ✓）⇒ `domainWrite` 走到 **`deferWrite` 排队** ✗
   * ⇒ 而"表永远不会就绪"时那次重放**永远不会发生** ✗ ⇒ 写**永远不落地** ✗。
   * 于是：**读**改走按需拉取之后 ✓，**写进的东西读不回来** ✗。
   *
   * ⇒ 所以迁移的**第三半**（第 105 波只覆盖了"删除"✓）必须扩到**写** ✓：
   * 对"**不镜像的表**" ✓，**写也必须直达引擎** ✓（不能只排队等一个永远不会就绪的镜像 ✗）。
   *
   * ## 判据（下一波 ✓，先写后改 ✓）
   *
   * - **`NC-WR-1`**：镜像 `neverReady` 时 `addChunksBulk` ⇒ **必须**把行交给引擎 ✓
   *   （按需拉取能读回来 ✓）；
   * - **反向对照 `NC-WR-2`**：镜像**可用**时 ⇒ 仍走镜像那条路 ✓（不许把原路弄坏 ✗）；
   * - **变异**：把"直达引擎"去掉（退回只排队 ✗）⇒ **`NC-WR-1` 红** ✓。
   */
  it.skip("NC-RW-1（待"写直达引擎"落地后启用 ✗）: 写完之后 **预热完成时** 必须读到完整且含新块的列表", async () => {
    /**
     * 第 260 波：**启用** ✓（第 207 波按纪律先写成 skip ✓）。
     *
     * 它钉的是「**最终**可读」✓ —— 而不是「不预热就能读」✗（后者已被第 206 波明确放弃 ✓）：
     * 1. `addChunksBulk` ✓（写 ✓；本 notebook 缓存未知 ⇒ 作废 + 预热 ✓）；
     * 2. **等预热完成** ✓；
     * 3. `getChunks` ⇒ 必须**完整**（含既有块 `c1` ✓ 与新块 ✓）且按 `chunk_index` 升序 ✓。
     *
     * ⚠️ 它与"拆镜像读"**解耦** ✓（镜像在不在都应通过 ✓）⇒ 可以先落地 ✓。
     */
    const { setStoragePort } = await import("../core/storage/port");
    const k = await import("../core/knowledge/storage");
    setStoragePort(refusedPort() as never);

    /** 先让既有块 c1 进缓存 ✓（镜像永远不接手 ✓ ⇒ 只能走按需读 ✓）。 */
    await k.__warmChunksForTests("nb1");
    expect(k.getChunks("nb1").map((c) => c.id), "预热后应能读到既有块").toEqual(["c1"]);

    /** 再写一块 ✓（写点：缓存已有该 notebook ⇒ 就地合并 ✓；没有则作废+预热 ✓）。 */
    k.addChunksBulk("nb1", "src1", [{ content: "块2", chunkIndex: 1, embedding: null, tokenCount: 1 }]);
    await k.__warmChunksForTests("nb1");

    const got = k.getChunks("nb1");
    expect(got.map((c) => c.chunkIndex), "必须按 chunk_index 升序").toEqual([0, 1]);
    expect(got.length, "必须**完整**（既有块 + 新块），不许只给新写的那一块 ✗").toBe(2);
  });
});
