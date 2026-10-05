/**
 * 第 240 波：**假端口的实例之间不许共享状态** ✓（判据先行 ✓）。
 *
 * ## 为什么（第 233–239 波一路量出来的 ✓）
 *
 * 迁移让"读"改走**按需拉取** ✓ ⇒ 才照出 `DOM-31` 的 `expected 3 to be 2` ✗。
 * 三方核对的结果 ✓：**产品侧三处全对** ✓（`where` ✓ / 过滤 ✓ / 分桶 ✓）
 * —— 真正的原因是**用例之间没有隔离** ✗：
 *
 * ```
 * domain-mirror.test.ts:96   const port = new RustStoragePort(…);   ← **模块级单例** ✓
 * domain-mirror.test.ts:122  afterEach(() => setStoragePort(null));  ← 只解绑，**不清表** ✗
 * ```
 *
 * ⇒ 42 条用例共用一张表 ✗ ⇒ 前面的用例在 `nb1` 名下留下的行 ✓
 * 会被 `DOM-31` 的按需拉取**合法地**读回来 ✓ ⇒ 计数 3 ✗（自己 2 + 别人 1）✓。
 *
 * ## 本判据钉的是什么 ✓
 *
 * 假端口**本身**是对的（`createFakeStoragePort` 每次调用都新建表 ✓）——
 * 要钉住的是"**这件事以后不许被改坏**" ✓：
 *
 * - **NC-ISO-1** ✓：**两个独立实例** seed **同一个 notebook id** ⇒
 *   第二个实例**只能看到自己 seed 的那批** ✓（不许看到第一个实例留下的行 ✗）；
 * - **NC-ISO-2 反向对照** ✓：**同一个实例内**两次 seed 同一个 notebook ⇒
 *   第二次**应能看到两次的结果** ✓（不许"一律清空"✗ —— 同一实例里的累积语义要保留 ✓）。
 *
 * **变异**：让假端口把表存在**模块级**（实例之间共享）⇒ **NC-ISO-1 红** ✓。
 *
 * ## 它治的是哪一类缺陷 ✓
 *
 * 本仓库的铁律是「**夹具不许比实现宽松**」✗ ——
 * 实例间共享状态 ✗ 会让"**跨用例/跨会话串数据**"这类缺陷在测试基座里**看不见** ✗，
 * 而今天这条迁移已经**真的**踩到它一次 ✓（`DOM-31` ✓）。
 */
import { describe, expect, it } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";

const chunkRow = (id: string, notebookId: string, sourceId: string) => ({
  id,
  notebook_id: notebookId,
  source_id: sourceId,
  content: id,
  chunk_index: 0,
  created_at: 1,
});

const listIds = async (port: unknown, notebookId: string) => {
  const res = (await (port as { data: { command: (c: string, p?: unknown) => Promise<unknown> } }).data.command(
    "crud.list",
    { table: "notebook_chunks", where: { notebook_id: notebookId }, limit: 1000, offset: 0 },
  )) as { items?: Array<Record<string, unknown>> };
  return (res.items ?? []).map((r) => String(r.id)).sort();
};

describe("第 240 波：假端口实例之间不许共享状态（夹具不许比实现宽松 ✗）", () => {
  it("NC-ISO-1: 两个**独立实例** seed 同一个 notebook ⇒ 第二个只见自己那批（不许看见别人的行 ✗）", async () => {
    const 第一个 = createFakeStoragePort({
      seed: { notebook_chunks: [chunkRow("a1", "nb1", "s_a")] },
    });
    const 第二个 = createFakeStoragePort({
      seed: { notebook_chunks: [chunkRow("b1", "nb1", "s_b")] },
    });
    expect(await listIds(第一个, "nb1"), "第一个实例只看得到自己 seed 的").toEqual(["a1"]);
    expect(await listIds(第二个, "nb1"), "第二个实例**不许**看到第一个实例留下的行 ✗").toEqual(["b1"]);
  });

  /**
   * ⚠️ 第 240 波：**这条暂时跳过** ✗ —— 不是夹具的问题 ✓，是**我这条判据的期望没量清** ✗。
   *
   * 现象 ✓：我发的那条 `crud.upsert`（`{table, rows, primaryKey:"id"}`）**没有**让第二次读到两行 ✓
   * ⇒ 说明假端口的 upsert 有**我没量清的语义** ✗
   * （它自己的注释里写着 `writtenThrough`：只有"**经 `crud.upsert` 成功写过一次**"的行才算引擎里已有 ✓；
   * 而 `mode` / `insert` / `replace` 的差别我**没有量** ✗）。
   *
   * ⇒ 按本项目的规矩 ✓：**先量清 `crud.upsert` 的模式语义** ✓（`insert` / `replace` / 默认 ✓），
   * 再回填这条反向对照 ✓ —— **不许**为了让判据变绿而改夹具 ✗（那正好是反方向 ✗）。
   * `NC-ISO-1`（实例之间不许共享 ✓）**已经绿** ✓，它是本文件的主要目的 ✓。
   */
  it("NC-ISO-2 反向对照: 同一实例内两次写同一 notebook ⇒ 第二次看到两次的结果（累积必须保留 ✓）", async () => {
    /**
     * 第 282 波：**启用** ✓ —— 第 280/281 波量清了真因 ✓：
     * 原来那句 `port.data.command("crud.upsert", …)` ✗ 落到了**另一个**分发器
     * （`fake-storage-port.ts:1356` 的白名单 ✓，它只认 `crud.list` 那一批 ✓）
     * ⇒ 报 `未实现的命令 crud.upsert` ✗ —— 而 `crud.upsert` 的实现在 **`invokeCommand`** 里 ✓（241 ✓）。
     *
     * ⇒ 改用**文档化的镜像写入口** `domains.applyWrite` ✓（`fake-storage-port.ts:1476` ✓）：
     * 该假端口的**镜像与表是同一张内存表** ✓ ⇒ 写完 `crud.list` 立刻能读到 ✓。
     *
     * 它钉的语义不变 ✓：「**同一个实例内**，第二次写之后能读到两次的结果」✓
     * —— 守"**不许把同一实例里的累积清掉**"✗，与 `NC-ISO-1`（**实例之间不许共享** ✓）配对 ✓。
     */
    const port = createFakeStoragePort({
      seed: { notebook_chunks: [chunkRow("a1", "nb1", "s_a")] },
    });
    (port.domains as unknown as { applyWrite: (t: string, r: Record<string, unknown>) => void }).applyWrite(
      "notebook_chunks",
      chunkRow("a2", "nb1", "s_a"),
    );
    expect(await listIds(port, "nb1"), "同一实例内的累积必须保留（不许一律清空 ✗）").toEqual(["a1", "a2"]);
  });
});
