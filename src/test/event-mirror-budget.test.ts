/**
 * 事件镜像的**内存预算**契约（第 63 轮；对齐 `message-mirror-budget.test.ts`）。
 *
 * ## 为什么单独立这一项（审计原文）
 *
 * 稳定性审计第 ④ 节把这条列成"最重的两条无上界结构"之一，并且点出了要害：
 *
 * > `rust-port.ts:1087 RustEventMirror.bySession`（+ `:1089 loaded`）— 事件 payload 全文，
 * > **无跨会话预算、无 LRU**；而消息镜像 `RustMessageMirror` 有 `totalBudgetRows = 20_000`
 * > → **明显不对称：消息镜像有预算、事件镜像没有**。
 *
 * 增长不是"用户点了多少会话"决定的，而是"进程**读过**多少会话"决定的：
 * 读路径每一条都经过 `event-log.ts` 的 `rustEventPort()` → `events.ensureLoaded(sessionId)`，
 * 而启动维护的运行时不变式审计会**按全部会话**扫一遍、还先等两侧镜像就绪
 * （`maintenance.ts::runRuntimeInvariantAudit`）。于是"库里有多少会话"≈"镜像里有多少份事件语料"。
 *
 * ## 本文件钉住四条
 *
 * 1. **驻留有界**：跨会话总行数超过预算 → 按 LRU 逐出**整份会话**（`stats()` 可证）；
 * 2. **逐出即回退到"未加载"**：被逐出的会话 `isLoaded` 为 false、`readAll` 返回**空数组**
 *    （不是"只剩一部分"的残缺集合）—— 这是"读语义不变"的判据：
 *    要么完整，要么重新加载；
 * 3. **逐出后可恢复**：再次访问会重新分页拉回，且内容与逐出前**逐条一致**；
 * 4. **未落库的本地追加是逐出的硬性例外**：`pending && !settled` 的会话一律不动
 *    （逐出会删掉 `MirrorEvent.pending` 所依赖的唯一一份本地副本 → 静默丢事件）。
 *
 * 另有一条对称性判据（EVB-5）：**两个镜像的默认预算必须相等** ——
 * 那正是审计点出的"不对称"被消掉的可观测形式。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
}));
vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async () => {},
  appendMessageTombstone: async () => {},
  readSessionMessages: () => [],
}));

const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

/** 假传输：`events.list` 按会话返回给定行数的分页 */
function eventTransport(rowCounts: Record<string, number>) {
  const listCalls: Array<{ session_id: string; from_seq?: number }> = [];
  return {
    listCalls,
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "events.list") {
        const p = (params ?? {}) as { session_id: string; from_seq?: number; limit?: number };
        listCalls.push({ session_id: p.session_id, from_seq: p.from_seq });
        const total = rowCounts[p.session_id] ?? 0;
        const from = p.from_seq === undefined ? 0 : Number(p.from_seq);
        const limit = Number(p.limit ?? 5000);
        const items = [] as Array<Record<string, unknown>>;
        for (let i = from; i < Math.min(total, from + limit); i++) {
          items.push({
            seq: i + 1,
            session_id: p.session_id,
            type: "assistant_text",
            payload: `{"i":${i}}`,
            timestamp: from + i,
          });
        }
        return {
          ok: true,
          result: { items, has_more: from + items.length < total, next_cursor: null },
        } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
}

afterEach(() => {
  setStoragePort(null);
  failures.length = 0;
  vi.restoreAllMocks();
});

describe("事件镜像内存预算 —— 驻留有界 + 整会话 LRU 逐出（对齐消息镜像）", () => {
  it("EVB-1: 超过总预算 → 逐出最久未使用的**整份会话**，isLoaded 回到 false", async () => {
    // 预算刻意给成 250 行：三个各 100 条的会话就会超预算
    const t = eventTransport({ s1: 100, s2: 100, s3: 100 });
    const port = new RustStoragePort(t as never, (_s, _e, note) => failures.push(note), {
      eventMirrorBudgetRows: 250,
    });
    setStoragePort(port);
    await port.start();

    port.events.ensureLoaded("s1");
    await settle();
    expect(port.events.stats().events, "单个会话在预算内").toBe(100);
    expect(port.events.isLoaded("s1")).toBe(true);

    port.events.ensureLoaded("s2");
    await settle();
    expect(port.events.stats().events, "两个会话仍在预算内（250）").toBe(200);
    expect(port.events.isLoaded("s1"), "没超预算就一个都不许逐出").toBe(true);

    // 第三个会话进来 → 300 > 250 → 逐出最久未使用的 s1
    port.events.ensureLoaded("s3");
    await settle();
    const stats = port.events.stats();
    expect(stats.events, "驻留总行数必须有界").toBeLessThanOrEqual(250);
    expect(stats.evictions, "必须发生逐出").toBeGreaterThan(0);
    expect(port.events.isLoaded("s1"), "最久未使用的会话被逐出").toBe(false);
    expect(port.events.isLoaded("s3"), "刚加载的会话必须还在（对照）").toBe(true);
    expect(
      failures.some((n) => n.includes("内存预算")),
      "逐出必须留痕（否则用户只会看到'卡了一下'，查不出原因）",
    ).toBe(true);
  });

  it("EVB-2: 逐出后读回**空数组**（不是残缺集合）+ 再访问能完整恢复", async () => {
    const t = eventTransport({ s1: 100, s2: 100, s3: 100 });
    const port = new RustStoragePort(t as never, () => {}, { eventMirrorBudgetRows: 250 });
    setStoragePort(port);
    await port.start();

    port.events.ensureLoaded("s1");
    await settle();
    const before = port.events.readAll("s1").map((e) => e.seq);
    expect(before).toHaveLength(100);

    port.events.ensureLoaded("s2");
    await settle();
    port.events.ensureLoaded("s3");
    await settle();
    expect(port.events.isLoaded("s1")).toBe(false);

    /*
     * 读语义没有变坏：被逐出的会话退化成"**还没加载**"这个既有状态，
     * `readAll` 给空数组（调用方按"未加载不路由"整体回退/重新加载），
     * 而**绝不是**"只给一部分"—— 那会让回放/投影/维护读到不完整的事件集合。
     */
    expect(port.events.readAll("s1"), "逐出后不能给出残缺的镜像").toEqual([]);
    expect(port.events.readFrom("s1", 1), "同理：区间读也不能给半份").toEqual([]);
    expect(port.events.latestSeq("s1"), "逐出后不能留一个假水位").toBe(0);
    expect(port.events.count("s1")).toBe(0);

    // 重新访问 → 重新分页拉回，内容与逐出前逐条一致
    port.events.ensureLoaded("s1");
    await settle();
    expect(port.events.isLoaded("s1"), "重新访问必须能恢复").toBe(true);
    expect(port.events.readAll("s1").map((e) => e.seq)).toEqual(before);
    expect(
      t.listCalls.filter((c) => c.session_id === "s1").length,
      "恢复必须真的重新分页拉取（不是凭空造出来的）",
    ).toBeGreaterThan(1);
  });

  it("EVB-3: 【对照】没超预算 ⇒ evictions 恒为 0", async () => {
    const t = eventTransport({ a: 10, b: 10 });
    const port = new RustStoragePort(t as never, () => {}, { eventMirrorBudgetRows: 1000 });
    setStoragePort(port);
    await port.start();

    port.events.ensureLoaded("a");
    await settle();
    port.events.ensureLoaded("b");
    await settle();

    expect(port.events.isLoaded("a"), "预算内已加载的会话 isLoaded 必须保持 true").toBe(true);
    expect(port.events.isLoaded("b")).toBe(true);
    expect(port.events.stats().events).toBe(20);
    expect(port.events.stats().evictions, "没超预算就不该逐出（否则会造成无谓的重复加载）").toBe(0);
  });

  it("EVB-4: 未确认落库的本地追加**是逐出的硬性例外**（否则会静默丢事件）", async () => {
    const t = eventTransport({ s1: 100, s2: 100, s3: 100, s4: 100 });
    const port = new RustStoragePort(t as never, () => {}, { eventMirrorBudgetRows: 250 });
    setStoragePort(port);
    await port.start();

    // s1：先本地追加一条（还没落库），再加载 → 合并后带一条 pending 占位
    const local = port.events.appendLocal("s1", "user_message", '{"text":"hi"}', 1);
    port.events.ensureLoaded("s1");
    await settle();
    expect(port.events.pendingPlaceholderCount("s1"), "夹具前提：s1 有一条未落库的追加").toBe(1);

    port.events.ensureLoaded("s2");
    await settle();
    port.events.ensureLoaded("s3");
    await settle();

    /*
     * 超预算了，但候选名单里的第一个（最久未使用的 s1）必须被**跳过**：
     * 它的 `pending` 副本是"既不在分页里、又可能没落库"的那条事件的唯一凭据
     * （见 `MirrorEvent.pending` 的长注释）。逐出 = 本进程内永久丢这条事件。
     * 于是逐出落到下一个候选 s2 身上 —— 这就是"逐出只换目标，不改语义"。
     */
    expect(port.events.isLoaded("s1"), "带未落库追加的会话不许被逐出").toBe(true);
    expect(port.events.pendingPlaceholderCount("s1"), "那条占位必须还在").toBe(1);
    expect(port.events.isLoaded("s2"), "逐出换到了下一个候选（对照：逐出确实发生了）").toBe(false);
    expect(port.events.stats().events).toBeLessThanOrEqual(250);

    // 一旦 reconcile（引擎回传真实 seq = 确认落库），它就回到可回收名单里 —— 例外是**暂时**的
    port.events.reconcile("s1", local.seq, 9999);
    expect(port.events.pendingPlaceholderCount("s1")).toBe(0);
    port.events.ensureLoaded("s4");
    await settle();
    expect(port.events.isLoaded("s1"), "确认落库之后就能正常逐出了").toBe(false);
    expect(port.events.isLoaded("s4")).toBe(true);
  });

  it("EVB-5: 两个镜像的**默认预算相等**（审计点出的'不对称'的可观测判据）", async () => {
    const t = eventTransport({});
    const port = new RustStoragePort(t as never, () => {});
    setStoragePort(port);
    await port.start();

    const eventBudget = port.events.stats().budgetRows;
    const messageBudget = port.messages.stats().budgetRows;
    expect(eventBudget, "事件镜像必须有预算（改前这里是'没有任何预算'）").toBeGreaterThan(0);
    expect(
      eventBudget,
      "同一进程里两份'按会话加载的正文镜像'，预算口径与默认值必须一致（消息镜像 20000 行）",
    ).toBe(messageBudget);
  });
});
