/**
 * 第 262 波：**对"不镜像的表"，写必须直达引擎** ✓（判据先行 ✓）。
 *
 * ## 为什么（第 261 波量到的 ✓）
 *
 * 把 `NC-RW-1` 启用（理由：写穿缓存已落地 ✓）⇒ 它**红** ✗：
 *
 * ```
 * × 必须按 chunk_index 升序: expected [ +0 ] to deeply equal [ +0, 1 ]
 * ```
 *
 * ⇒ 写完 + 预热之后 ✓，**只读到既有块**（`c1`，index 0 ✓），**新块根本没进引擎** ✗。
 * 原因 ✓：夹具里镜像 `neverReady` ✓ —— 而这**正是迁移后 `notebook_chunks` 的现实** ✓
 * （它**天生不该进镜像** ✓：每行带 8KB 的 embedding ✓）⇒
 * `domainWrite` 走 **`deferWrite` 排队** ✗ ⇒
 * 而"**表永远不会就绪**"时那次重放**永远不会发生** ✗ ⇒ **写永远不落地** ✗。
 *
 * ⇒ 与第 104/105 波那条"**删除**要直达引擎" **同源** ✓ ⇒
 * **第三半 = 对不镜像的表，读 / 写 / 删三条都要直达引擎** ✓。
 *
 * ## 判据 ✓
 *
 * - **NC-WR-1**：镜像**永远不就绪**时 ⇒ `addChunksBulk` **必须**把行交给引擎 ✓
 *   （`crud.upsert` 真的到达 ✓，且按需拉取能读回来 ✓）；
 * - **NC-WR-2 反向对照**：镜像**可用**时 ⇒ 仍然走**镜像**那条路 ✓
 *   （不许把原路弄坏 ✗ —— 镜像可用时的写本来是对的 ✓）。
 *
 * **变异**：把"直达引擎"去掉（退回只排队 ✗）⇒ **NC-WR-1 红** ✓。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s: string, finding: unknown) => failures.push(String(finding)),
}));

const chunkRow = (id: string, notebookId: string, sourceId: string, index: number) => ({
  id,
  notebook_id: notebookId,
  source_id: sourceId,
  chunk_index: index,
  content: id,
  text: id,
  created_at: 1,
  embedding: null,
});

describe("第 262 波：不镜像的表，写必须直达引擎（不能只排队等一个永远不会就绪的镜像 ✗）", () => {
  beforeEach(() => {
    failures.length = 0;
    vi.resetModules();
  });

  it("NC-WR-1: 镜像**永远不就绪**时，addChunksBulk **必须**把行交给引擎（按需拉取能读回来 ✓）", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const k = await import("../core/knowledge/storage");
    /** 镜像永不就绪 ✓ = 迁移后 `notebook_chunks` 的现实 ✓。 */
    setStoragePort(
      createFakeStoragePort({
        seed: { notebook_chunks: [chunkRow("c1", "nb1", "src1", 0)] },
        neverReady: ["notebook_chunks"],
      }) as never,
    );

    k.addChunksBulk("nb1", "src1", [{ content: "块2", chunkIndex: 1, embedding: null, tokenCount: 1 }]);
    /** 等预热（= 一次按需拉取 ✓）；若写没到引擎 ⇒ 只会拉到既有块 ✗。 */
    await k.__warmChunksForTests("nb1");

    expect(
      k.getChunks("nb1").map((c) => c.chunkIndex),
      "镜像不就绪 ⇒ 写必须直达引擎，否则新写的块读不回来 ✗",
    ).toEqual([0, 1]);
  });

  it("NC-WR-2 反向对照: 镜像**可用**时仍走镜像那条路（不许把原本正确的写路径弄坏 ✗）", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const k = await import("../core/knowledge/storage");
    const port = createFakeStoragePort({
      seed: { notebook_chunks: [chunkRow("c1", "nb1", "src1", 0)] },
    });
    setStoragePort(port as never);
    await port.start();
    port.domains.ensureLoaded("notebook_chunks");

    k.addChunksBulk("nb1", "src1", [{ content: "块2", chunkIndex: 1, embedding: null, tokenCount: 1 }]);
    await k.__warmChunksForTests("nb1");

    expect(k.getChunks("nb1").map((c) => c.chunkIndex), "镜像可用时读得到的仍是两块").toEqual([0, 1]);
  });
});
