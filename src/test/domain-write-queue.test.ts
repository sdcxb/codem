/**
 * 域写队列的契约测试（FIX-X，第 46 轮）
 *
 * ## 为什么单独一个文件
 *
 * 队列行为只在**加载窗口**（`ensureLoaded` 已发起、`isReady` 还没真）里才存在，
 * 而 `fake-storage-port.ts` 默认是**同步就绪**的（那是刻意的，见那个文件头）——
 * 所以既有 277 个文件在结构上看不见这一段。本文件显式开 `asyncLoad`。
 *
 * | 用例 | 守什么 | 缺陷编号 |
 * | --- | --- | --- |
 * | DELW-1~4 | 窗口里的**谓词删除**必须真删（带 where），审计不许说谎 | X-1 |
 * | AGE-1~2 | 加载失败的表：滞留条目必须**老化出队 + 如实上报**（不静默） | X-2 |
 * | PER-1~2 | 一张坏表**占不满**队列、饿不死别的表（单表上限） | X-2 |
 * | DIAG-1~2 | `deferredWriteStats()` 能回答"几张表在排、各多少、老化丢了多少" | X-2 |
 *
 * ## "改之前会失败"的对照（原始输出，见报告）
 *
 * 未修改的 `domain-store.ts` 上跑同一批场景（一次性探针，用完已删）：
 *
 * ```
 * PROBE X-1 removed(返回值) = null  pending = 1
 * PROBE X-1 库里的行 = []                                   ← 一行都没删掉（keep 也被删了？不是：是整表被跳过）
 * PROBE X-1 实际发出的写命令 = [{"command":"crud.delete","params":{"table":"todo_lists"}}]
 * PROBE X-1 审计缓冲里的删除记录 = [{"cmd":"crud.delete","table":"todo_lists"}]   ← 空 where 的假审计
 * PROBE X-2c 坏表加载失败后 stats = {"pending":500,...}
 * PROBE X-2c 另一张表 accepted = false                      ← 被坏表饿死
 * PROBE X-2c goals 落库行 = []
 * PROBE X-2d 推后 60s 前 = {"pending":1,...}  后 = {"pending":1,...}   ← 老化不存在
 * ```
 *
 * 也就是说：X-1 的"删了 0 行却记了一条删除审计"在**假端口上**都能直接看到
 * （真端口更严重：`crud.rs::crud_delete` 对空 `where` 是**明确拒绝**，
 * 所以那次重放还会额外抛一次错）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import {
  __resetDeferredWritesForTests,
  deferredWriteStats,
  domainDeleteWhere,
  domainWrite,
} from "../core/storage/domain-store";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { clearWriteAudit, recentWrites } from "../core/storage/write-audit";
import { createFakeStoragePort } from "./fake-storage-port";

/**
 * 跑完**微任务**（假端口的异步就绪与写穿都在微任务上，没有 `setTimeout`）。
 *
 * ## 为什么不用 `setTimeout(0)` 排空（实测踩到）
 *
 * 老化用例需要把 `Date.now()` 推后 60 秒，而 `vi.useFakeTimers()` +
 * `useRealTimers()` 会把系统时间**一并还原**（实测：推后 60s → 回到真实时间，
 * 于是老化永远不触发），所以在这些用例里只能 `vi.setSystemTime()`
 * **单独**改 `Date`（它不需要装假定时器，实测有效）。
 *
 * 那一刻不能让"跑时间"依赖 `setTimeout`：假定时器接管期间 `setTimeout` 不会自己到期。
 * 好在这里本来就不需要它 —— 需要等的只有微任务。
 */
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/**
 * 把**系统时间**推后 N 毫秒。
 *
 * ⚠️ 刻意**不**用 `vi.useFakeTimers()`：那个 fixture 会在 `useRealTimers()` 时
 * 把 `Date` 一起还原（见上），而这个模块的老化判据只看 `Date.now()`。
 * 这里改的是全局 `Date`，用例结束由 `afterEach` 的 `vi.restoreAllMocks()` 之外的
 * 方式无所谓 —— vitest 的 mock 状态在每个测试文件后重置；若要保险，
 * 后续用例里再 `setSystemTime` 一次即可（本文件的用例互不依赖绝对时间）。
 */
function shiftClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

const errors: string[] = [];

beforeEach(() => {
  setStoragePort(null);
  __resetDeferredWritesForTests();
  resetPersistFailures();
  clearWriteAudit();
  errors.length = 0;
  // 统一上报通道走 console.error（见 persist-failure.ts），接住它才能断言"没被静默吞"
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  setStoragePort(null);
  __resetDeferredWritesForTests();
  vi.restoreAllMocks();
});

// ========== X-1：窗口里的谓词删除 ==========

describe("X-1 加载窗口里的 `domainDeleteWhere`：重放必须真的删（带 where），审计不许说谎", () => {
  const TABLE = "todo_lists";
  const opts = { scope: "fixx.sweep", note: "过期行未清理" };

  it("DELW-1: 预测「created_at < 100」→ 只删匹配的那一行，另一行必须留着", async () => {
    const port = createFakeStoragePort({
      asyncLoad: true,
      seed: {
        [TABLE]: [
          { id: "old", created_at: 1 },
          { id: "keep", created_at: 999 },
        ],
      },
    });
    setStoragePort(port);

    const removed = domainDeleteWhere(TABLE, (row) => Number(row.created_at) < 100, "id", opts);
    /*
     * `null` = 本次同步调用"未接手"（镜像还没到手），这是**如实**的：
     * 它没有把"什么都没做"说成"删了 0 行"。区别在于现在这次删除**真的会到库里执行**。
     */
    expect(removed, "同步这一刻确实没删（未接手），必须如实返回 null 而不是 0").toBeNull();
    expect(deferredWriteStats().pending, "但这次删除必须进队列，不能丢").toBe(1);

    await flush();

    expect(
      port.__table(TABLE).map((r) => r.id),
      "重放必须在**已就绪的镜像上**重新求值谓词：old 被删、keep 留着",
    ).toEqual(["keep"]);
  });

  it("DELW-2: 写穿的删除命令**必须带 where**（空 where 会被真引擎明确拒绝）", async () => {
    const port = createFakeStoragePort({
      asyncLoad: true,
      seed: { [TABLE]: [{ id: "old", created_at: 1 }] },
    });
    setStoragePort(port);
    domainDeleteWhere(TABLE, () => true, "id", opts);
    await flush();

    const deletes = port.__writes().filter((w) => w.command === "crud.delete");
    expect(deletes.length, "必须发出删除（早先连命令都发不出正确的）").toBe(1);
    const where = deletes[0].params?.where as Record<string, unknown> | undefined;
    /*
     * 这是 X-1 的核心断言。旧实现这里发的是 `{table:"todo_lists"}` —— 没有 where，
     * 而 `crud.rs::crud_delete` 对空 where 的回答是"删除必须给出 where 条件"。
     */
    expect(where, "删除命令必须带 where 条件").toBeTruthy();
    expect(Object.keys(where ?? {}), "where 不能是空对象").not.toEqual([]);
    expect(where).toEqual({ id: "old" });
  });

  it("DELW-3: 审计只记**真实发出去**的那条命令（不许留下空 where 的假证据）", async () => {
    const port = createFakeStoragePort({
      asyncLoad: true,
      seed: { [TABLE]: [{ id: "old", created_at: 1 }] },
    });
    setStoragePort(port);
    domainDeleteWhere(TABLE, () => true, "id", opts);
    await flush();

    const audit = recentWrites({ onlyDeletes: true });
    expect(audit.length, "确实删了 → 应当有且只有一条删除审计").toBe(1);
    expect(audit[0].key, "审计里的定位信息必须是真实条件，而不是 undefined（空 where）").toBe(
      JSON.stringify({ id: "old" }),
    );
  });

  it("DELW-4: 谓词一行都不匹配 → **不发命令、不记审计**（不是'发了空删除再说删了 0 行'）", async () => {
    const port = createFakeStoragePort({
      asyncLoad: true,
      seed: { [TABLE]: [{ id: "keep", created_at: 999 }] },
    });
    setStoragePort(port);
    domainDeleteWhere(TABLE, (row) => Number(row.created_at) < 100, "id", opts);
    await flush();

    expect(port.__writes().filter((w) => w.command === "crud.delete"), "无事可做就不该发命令").toEqual([]);
    expect(recentWrites({ onlyDeletes: true }), "没有写穿就没有审计（审计不能记'发生过的事'之外的东西）").toEqual(
      [],
    );
    expect(port.__table(TABLE).map((r) => r.id), "不该误删任何行").toEqual(["keep"]);
    expect(deferredWriteStats().pending, "队列要排空").toBe(0);
  });
});

// ========== X-2：老化 ==========

describe("X-2 滞留条目必须老化出队，并**如实上报**", () => {
  it("AGE-1: 加载失败的表：条目不会永远压在队列里（推后 60s 后归零 + 计入 expired）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, domainsFailLoading: ["todo_lists"] });
    setStoragePort(port);

    expect(domainWrite("todo_lists", [{ id: "t1" }], { scope: "fixx.age", note: "待办未保存" })).toBe(true);
    await flush(); // 加载失败落地：loading 清掉、isReady 恒 false、onLoaded 永不触发
    expect(deferredWriteStats().pending, "这次写确实排进了队列（这就是滞留的现场）").toBe(1);

    shiftClock(60_000);
    const stats = deferredWriteStats();
    expect(stats.pending, "超过老化窗口必须出队（旧实现这里是 1，永远不消）").toBe(0);
    expect(stats.expired, "必须计入'老化丢弃'，而不是悄悄消失").toBe(1);
    expect(stats.tables, "按表分布里也不该再有它").toEqual({});
  });

  it("AGE-2: 老化必须走**统一上报通道**，文案要说清'该表在 X ms 内未就绪'", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, domainsFailLoading: ["todo_lists"] });
    setStoragePort(port);
    domainWrite("todo_lists", [{ id: "t1" }], { scope: "fixx.age2", note: "待办未保存" });
    await flush();

    shiftClock(60_000);
    deferredWriteStats(); // 触碰队列即结算

    const reported = getPersistFailures();
    const mine = reported.find((f) => f.area === "fixx.age2");
    expect(mine, "绝不允许静默丢：必须出现在上报通道里").toBeTruthy();
    expect(mine!.lastMessage).toContain("未就绪");
    expect(mine!.lastMessage).toContain("本次写放弃");
    expect(errors.join("\n"), "上报必须真的落到日志（用户与排查都看得见）").toContain("本次写放弃");
  });
});

// ========== X-2：按表上限 ==========

describe("X-2 一张坏表不许占满整个队列（按表上限）", () => {
  it("PER-1: 坏表塞满自己的额度后，**另一张正在加载的表仍然排队成功并落库**", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, domainsFailLoading: ["todo_lists"] });
    setStoragePort(port);

    const accepted: boolean[] = [];
    for (let i = 0; i < 500; i++) {
      accepted.push(domainWrite("todo_lists", [{ id: `t${i}` }], { scope: "fixx.bad", note: "坏表" }));
    }
    await flush();
    const saturated = deferredWriteStats();
    expect(saturated.tables["todo_lists"], "坏表只能占住自己那一份额度").toBeLessThanOrEqual(100);
    expect(accepted.filter((a) => !a).length, "超出单表额度的写仍然**如实返回 false**").toBeGreaterThan(0);
    expect(errors.join("\n"), "被拒的写必须被上报（不静默）").toContain("域写队列已满");

    /*
     * 关键断言（旧实现的现场：`另一张表 accepted = false`、`goals 落库行 = []`）：
     * 另一张表**确实在加载中**，本该排队成功。
     */
    const other = domainWrite("goals", [{ id: "g1" }], { scope: "fixx.good", note: "好表" });
    expect(other, "别的表不该被一张坏表的滞留条目饿死").toBe(true);
    expect(deferredWriteStats().tables["goals"], "诊断要能看出两张表各自排了多少").toBe(1);

    await flush();
    expect(port.__table("goals").map((r) => r.id), "好表的写必须真的落库").toEqual(["g1"]);
  });

  it("PER-2: 单表额度是**硬**上限，超出的部分一条都不许偷偷入队", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, domainsFailLoading: ["todo_lists"] });
    setStoragePort(port);
    for (let i = 0; i < 300; i++) {
      domainWrite("todo_lists", [{ id: `t${i}` }], { scope: "fixx.cap", note: "坏表" });
    }
    const stats = deferredWriteStats();
    expect(stats.pending, "单表最多 100 条").toBe(100);
    expect(stats.dropped, "其余 200 条必须被计数为丢弃（并已上报）").toBe(200);
    expect(stats.expired, "这些写从来没进过队，不该记成'老化'").toBe(0);
  });
});

// ========== X-2：诊断 ==========

describe("X-2 `deferredWriteStats()` 必须能回答'几张表在排、各多少、老化丢多少'", () => {
  it("DIAG-1: 多张表同时排队时给出按表分布", () => {
    const port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);
    domainWrite("todo_lists", [{ id: "a" }], { scope: "fixx.diag", note: "n" });
    domainWrite("todo_lists", [{ id: "b" }], { scope: "fixx.diag", note: "n" });
    domainWrite("goals", [{ id: "g" }], { scope: "fixx.diag", note: "n" });

    const stats = deferredWriteStats();
    expect(stats.pending).toBe(3);
    expect(stats.tables, "按表的分布是诊断的第一问（'几张表在排队、各自多少'）").toEqual({
      todo_lists: 2,
      goals: 1,
    });
    expect(stats).toHaveProperty("expired");
    expect(stats.dropped).toBe(0);
  });

  it("DIAG-2: `dropped` 与 `expired` 是两件事（'没排上' ≠ '排上了没成'）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, domainsFailLoading: ["todo_lists"] });
    setStoragePort(port);
    for (let i = 0; i < 102; i++) {
      domainWrite("todo_lists", [{ id: `t${i}` }], { scope: "fixx.diag2", note: "n" });
    }
    expect(deferredWriteStats().dropped, "102 条里 2 条没排上").toBe(2);
    expect(deferredWriteStats().expired, "这时候还没有'排上了没成'").toBe(0);

    await flush();
    shiftClock(60_000);
    const after = deferredWriteStats();
    expect(after.expired, "排上的 100 条全部老化放弃").toBe(100);
    expect(after.dropped, "'没排上'的计数不该被老化的结果覆盖或抵消").toBe(2);
    expect(after.pending).toBe(0);
  });
});
