/**
 * 第 236 波：**假端口必须按 `where` 过滤** ✓（判据先行 ✓）。
 *
 * ## 为什么（第 233–235 波量出来的 ✓）
 *
 * 迁移让"读"改走**按需拉取** ✓ ⇒ 才发现**假端口的 `crud.list` 不按 `where` 过滤** ✗：
 *
 * ```
 * 第 234 波：只拆计数那一处 ⇒ DOM-31 红
 *            AssertionError: 只数本笔记本的文本块: expected 3 to be 2
 * 第 235 波：探针显示产品**带对了条件** ✓
 *            [探针] crud.list where={"notebook_id":"nb_…"}
 * ```
 *
 * ⇒ **产品侧清白** ✓（条件带对了 ✓）；问题在**夹具比实现更宽松** ✗ ——
 * 而本仓库**明令禁止这个方向** ✓：夹具一旦比实现宽松 ✗，
 * "**跨笔记本串数据**"这类缺陷就会**在测试基座里看不见** ✗。
 *
 * ## 判据 ✓
 *
 * - **NC-WHERE-1**：收到 `where: { notebook_id }` ⇒ **只**返回该笔记本的行 ✓；
 * - **NC-WHERE-2 反向对照**：**不带** `where` ⇒ **返回全部**行 ✓
 *   （不许"一律过滤掉"✗ —— 那会把其它用途弄坏 ✓）。
 *
 * **变异**：把夹具里的过滤去掉 ⇒ **NC-WHERE-1 红** ✓。
 */
import { describe, expect, it } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";

const chunkRow = (id: string, notebookId: string, index: number) => ({
  id,
  notebook_id: notebookId,
  source_id: `s_${notebookId}`,
  content: `块${index}`,
  chunk_index: index,
  created_at: 1,
});

/** 跨笔记本数据 ✓：`nb1` 两行 ✓、`nb2` 一行 ✓。 */
function portAcrossNotebooks() {
  return createFakeStoragePort({
    seed: {
      notebook_chunks: [chunkRow("c1", "nb1", 0), chunkRow("c2", "nb1", 1), chunkRow("c9", "nb2", 0)],
    },
  });
}

describe("第 236 波：假端口必须按 where 过滤（夹具不许比实现宽松 ✗）", () => {
  it("NC-WHERE-1: 带 where:{notebook_id:'nb1'} ⇒ **只**返回 nb1 的两行（不许把 nb2 的也算进来 ✗）", async () => {
    const port = portAcrossNotebooks();
    const res = (await (port.data as { command: (c: string, p?: unknown) => Promise<unknown> }).command(
      "crud.list",
      { table: "notebook_chunks", where: { notebook_id: "nb1" }, limit: 1000, offset: 0 },
    )) as { items?: Array<Record<string, unknown>> };
    const ids = (res.items ?? []).map((r) => String(r.id)).sort();
    expect(ids, "按 notebook_id 过滤后只能有 nb1 的两行").toEqual(["c1", "c2"]);
  });

  it("NC-WHERE-2 反向对照: **不带** where ⇒ 返回全部三行（不许一律过滤掉 ✗）", async () => {
    const port = portAcrossNotebooks();
    const res = (await (port.data as { command: (c: string, p?: unknown) => Promise<unknown> }).command(
      "crud.list",
      { table: "notebook_chunks", limit: 1000, offset: 0 },
    )) as { items?: Array<Record<string, unknown>> };
    const ids = (res.items ?? []).map((r) => String(r.id)).sort();
    expect(ids, "没有 where 时必须返回全部行").toEqual(["c1", "c2", "c9"]);
  });
});
