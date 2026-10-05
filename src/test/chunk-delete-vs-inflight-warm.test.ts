/**
 * 第 253 波：**删除之后到达的预热结果，不许把被删的块写回缓存** ✓（判据先行 ✓）。
 *
 * ## 为什么（第 252 波量出来的 ✓，探针随后撤回 ✓）
 *
 * ```
 * [探针] 删除后缓存=[{"nb_…":["chk_…"]}]      ← 删完之后，缓存里**仍有那一块** ✗
 * ```
 *
 * 次序 ✓（第 208 波那套"写点作废 + 预热"的必然结果 ✗）：
 *
 * ```
 * t0  addChunksBulk         → 缓存没有该 notebook ⇒ 作废 + **发起预热**（异步）
 * t1  deleteChunksBySource  → **同步摘缓存**（摘了个空 ✗ —— 预热还没落地）
 * t2  预热结果落地           → 把 t0 时刻（**含被删块**）的数据写进缓存 ✗✗
 * ```
 *
 * ⇒ **删除之后，同步读会读回已被删掉的块** ✗ —— **陈旧数据复活** ✓，
 * 这是**产品侧**的一致性缺陷 ✓（不是夹具 ✓、不是 `where`/分桶 ✓）。
 *
 * ## 判据 ✓
 *
 * - **NC-DEL-3**：删除**之后**才到达的预热结果 ⇒ 缓存里**不许**有被删的那个来源的块 ✓；
 * - **NC-DEL-4 反向对照**：**没有删除**时 ⇒ 预热结果**必须**照常落进缓存 ✓
 *   （不许"一律丢弃预热结果"✗ —— 那会让按需读永远是空的 ✓）。
 *
 * **变异**：去掉"代际核对"⇒ **NC-DEL-3 红** ✓。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";

vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
  reportAdvisory: () => {},
}));

/** 把缓存里**所有**桶里所有 notebook 的块 id 拍平 ✓（`__chunkCacheBucketsForTests` 只给 id ✓）。 */
async function cachedIds(): Promise<string[]> {
  const k = await import("../core/knowledge/storage");
  return k.__chunkCacheBucketsForTests().flatMap((b) => Object.values(b.entries).flat());
}

describe("第 253 波：删除与在飞预热的次序（陈旧数据不许复活 ✗）", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("NC-DEL-3: 删除**之后**到达的预热结果 ⇒ 缓存里不许有被删来源的块", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const k = await import("../core/knowledge/storage");
    const port = createFakeStoragePort({ seed: { notebooks: [], notebook_sources: [], notebook_chunks: [] } });
    setStoragePort(port as never);

    const nb = k.createNotebook({ name: "次序测试" });
    const src = k.addSource({ notebookId: nb.id, name: "s", type: "text", content: "x" });
    /** t0：写 ⇒ 缓存没有该 notebook ⇒ **作废 + 发起预热**（异步 ✓，此处**故意不 await** ✗）。 */
    k.addChunksBulk(nb.id, src.id, [{ content: "a", chunkIndex: 0, embedding: null, tokenCount: 1 }]);
    /** t1：同步删除 ⇒ 摘缓存（此刻还是空的 ✗）。 */
    k.deleteChunksBySource(src.id);
    /** t2：**等那次在飞的预热落地** ✓ —— 它落地的数据是 t0 时刻的（含被删块 ✗）。 */
    await k.__warmChunksForTests(nb.id);

    expect(
      await cachedIds(),
      "删除之后，缓存里**不许**留下已被删掉的块 ✗（陈旧数据复活比读不到严重得多 ✓）",
    ).toEqual([]);
  });

  it("NC-DEL-4 反向对照: **没有删除**时，预热结果必须照常落进缓存（不许一律丢弃 ✗）", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const k = await import("../core/knowledge/storage");
    const port = createFakeStoragePort({ seed: { notebooks: [], notebook_sources: [], notebook_chunks: [] } });
    setStoragePort(port as never);

    const nb = k.createNotebook({ name: "反向对照" });
    const src = k.addSource({ notebookId: nb.id, name: "s", type: "text", content: "x" });
    k.addChunksBulk(nb.id, src.id, [{ content: "a", chunkIndex: 0, embedding: null, tokenCount: 1 }]);
    await k.__warmChunksForTests(nb.id);

    expect(await cachedIds(), "没删除时预热结果必须落进缓存（否则按需读永远是空的 ✗）").toHaveLength(1);
  });
});
