/**
 * 阶段 2（把"轮询"换成"推"）判据 —— ES-1..ES-9。
 *
 * ## 为什么这组判据的重点不是"能不能推"，而是"推丢了怎么办"
 *
 * 推送比轮询强的地方是"变化立刻可见"；比轮询**危险**的地方是：
 * 轮询天然是"每次都重新问一遍全量"，而推送一旦丢了一段，
 * **客户端不会自己发现**——它会安静地少显示一段，直到用户重启页面。
 *
 * 所以这组判据里最要紧的是 ES-3：**检查点失效时必须明说 `reset`，不许静默跳过**。
 * 这条是我从 DSH 抄的：它宁可"不复用旧检查点、整批重来"，
 * 也不让"旧映射长期留在历史里"。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | ES-1 | 序号单调递增；`since` 之后只给更新的；跨会话不串 |
 * | ES-2 | 分页与预算：条数/字节都不超限，且 `hasMore` 如实为真 |
 * | ES-3 | **检查点失效 ⇒ `reset: true` 且不带事件**（绝不静默跳过） |
 * | ES-4 | 长轮询：有事件立刻回；没事件到点回空；**挂起上限 < 上游代理超时** |
 * | ES-5 | 只唤醒**相关**的订阅（别的会话变了不该打断这个订阅的等待） |
 * | ES-6 | 环形缓冲有界（长跑不吃内存），且丢弃后 `oldestSeq` 如实前移 |
 * | ES-7 | 唤醒后取到的是**完整**的一段（不含被丢的），或如实 `reset` |
 * | ES-8 | 预算取的是**字节**而不只是条数（一条大事件也要被拦住） |
 * | ES-9 | 手机页面**不再**定时轮询 messages/approvals/run |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  emitPhoneEvent,
  eventsSince,
  waitPhoneEvents,
  pendingWaiters,
  currentSeq,
  EVENT_RING_MAX,
  EVENT_BATCH_MAX_ITEMS,
  EVENT_BATCH_MAX_BYTES,
  EVENT_WAIT_MAX_MS,
  __resetPhoneEventsForTests,
} from "../core/phone-link/event-stream";

const read = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  __resetPhoneEventsForTests();
});

describe("第 122 轮阶段 2 · 手机事件流", () => {
  it("ES-1: 序号单调递增；只给 since 之后的；跨会话不串", () => {
    const a1 = emitPhoneEvent("messages", "s-1");
    const a2 = emitPhoneEvent("messages", "s-1");
    const b1 = emitPhoneEvent("messages", "s-2");
    expect(a1).toBeLessThan(a2);
    expect(a2).toBeLessThan(b1);

    const all = eventsSince(0);
    expect(all.events.map((e) => e.seq)).toEqual([a1, a2, b1]);
    expect(all.nextSeq).toBe(b1);
    expect(all.reset).toBe(false);

    // since 之后
    expect(eventsSince(a2).events.map((e) => e.seq)).toEqual([b1]);
    // 会话过滤
    expect(eventsSince(0, "s-1").events.map((e) => e.seq)).toEqual([a1, a2]);
    expect(eventsSince(0, "s-2").events.map((e) => e.seq)).toEqual([b1]);
    // 已是最新 ⇒ 空且不 reset
    const none = eventsSince(b1, "s-1");
    expect(none.events).toEqual([]);
    expect(none.reset).toBe(false);
    expect(none.nextSeq).toBe(b1);
  });

  it("ES-1b: 全局事件对所有会话订阅都相关", () => {
    const g = emitPhoneEvent("sessions"); // 没有 sessionId ⇒ 全局
    expect(eventsSince(0, "s-1").events.map((e) => e.seq)).toEqual([g]);
    expect(eventsSince(0, "s-2").events.map((e) => e.seq)).toEqual([g]);
  });

  it("ES-3: **检查点失效必须明说 reset**（绝不静默跳过）—— 本轮最要紧的一条", () => {
    // 灌满并溢出缓冲，制造"中间一段被丢弃"
    for (let i = 0; i < EVENT_RING_MAX + 50; i++) emitPhoneEvent("messages", "s-1");
    const latest = currentSeq();
    // 客户端报了一个**早已被丢弃**的检查点
    const stale = eventsSince(1, "s-1");
    expect(stale.reset, "陈旧检查点必须回 reset").toBe(true);
    expect(stale.events, "reset 时不许带事件（带了就等于在拼凑）").toEqual([]);
    expect(stale.oldestSeq).toBeGreaterThan(1);

    // 而正常范围内的检查点不 reset
    const fresh = eventsSince(latest - 5, "s-1");
    expect(fresh.reset).toBe(false);
    expect(fresh.events.length).toBe(5);

    // 边界：正好等于"最老可用 - 1" 时**不该** reset（那一位就是最老的那个）
    const ok = eventsSince(stale.oldestSeq - 1, "s-1");
    expect(ok.reset, "oldestSeq-1 之后的数据是完整的，不该判为失效").toBe(false);
    expect(ok.events[0].seq).toBe(stale.oldestSeq);
  });

  it("ES-2/ES-8: 分页与预算 —— 条数、字节都不超限，且 hasMore 如实", () => {
    for (let i = 0; i < 30; i++) emitPhoneEvent("messages", "s-1");

    const p1 = eventsSince(0, "s-1", { maxItems: 10 });
    expect(p1.events.length).toBe(10);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextSeq).toBe(p1.events[9].seq);

    // 接着取（客户端就用 nextSeq 当 since）
    const p2 = eventsSince(p1.nextSeq, "s-1", { maxItems: 10 });
    expect(p2.events.length).toBe(10);
    expect(p2.events[0].seq).toBe(p1.nextSeq + 1);
    // 取到尾巴时 hasMore 必须为 false（否则客户端会无限续取）
    const p3 = eventsSince(p2.nextSeq, "s-1", { maxItems: 100 });
    expect(p3.events.length).toBe(10);
    expect(p3.hasMore).toBe(false);

    /**
     * ES-8：预算必须按**字节**也拦一道。
     * 构造一条很大的事件，即使条数远未到上限也必须被预算拦住。
     */
    __resetPhoneEventsForTests();
    const big = "甲".repeat(400 * 1024); // 单条就超过 256 KiB 预算
    emitPhoneEvent("messages", "s-1", { big });
    const byBytes = eventsSince(0, "s-1", { maxBytes: EVENT_BATCH_MAX_BYTES });
    expect(byBytes.events.length, "超大单条也要被字节预算拦住").toBe(0);
    expect(byBytes.hasMore).toBe(true);
    // 放宽预算就能拿到
    expect(eventsSince(0, "s-1", { maxBytes: 2 * 1024 * 1024 }).events.length).toBe(1);
    void EVENT_BATCH_MAX_ITEMS;
  });

  it("ES-4: 长轮询 —— 有事件立刻回；没事件到点回空；**上限小于上游代理超时**", async () => {
    // 已有事件 ⇒ 立刻回，不等
    emitPhoneEvent("messages", "s-1");
    const t0 = Date.now();
    const quick = await waitPhoneEvents(0, "s-1", 5000);
    expect(quick.events.length).toBe(1);
    expect(Date.now() - t0).toBeLessThan(200);

    /**
     * ⚠️ 这条是**硬约束**，不是风格问题：
     * Rust 侧转发到渲染进程等的是 PROXY_TIMEOUT = 15s（`phone/mod.rs:988`）。
     * 挂得比它久 ⇒ 客户端拿到的是 504 而不是事件，表现为"偶尔整批丢失"。
     */
    expect(EVENT_WAIT_MAX_MS, "挂起上限必须小于上游代理超时 15s").toBeLessThan(15_000);
    const src = read("src-tauri/src/phone/mod.rs");
    const m = src.match(/PROXY_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/);
    expect(m, "必须能找到 PROXY_TIMEOUT").toBeTruthy();
    expect(EVENT_WAIT_MAX_MS).toBeLessThan(Number(m![1]) * 1000);

    // 挂起超时后必须回（不许吊死）
    const t1 = Date.now();
    const empty = await waitPhoneEvents(currentSeq(), "s-1", 300);
    expect(empty.events).toEqual([]);
    expect(empty.reset).toBe(false);
    const waited = Date.now() - t1;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(1200);
    // 等待者必须被回收（否则长跑会漏）
    expect(pendingWaiters()).toBe(0);

    /**
     * 请求的 wait 超过上限时必须被**夹到上限**，而不是原样等下去。
     * 这里不能真等 10 秒（会撞 vitest 的 5 秒超时，我第一版就是这么写红的）——
     * 改成"用超大 wait 注册、再发一条事件把它唤醒"，验证它至少不会因为
     * 数值过大而拒绝或行为异常；夹取本身由下面的代码形状判据钉住。
     */
    const p = waitPhoneEvents(currentSeq(), "s-1", 10 * 60 * 1000);
    emitPhoneEvent("messages", "s-1");
    const woke = await p;
    expect(woke.events.length).toBe(1);
    // 夹取必须在**事件流模块自己**里（不是 mod.rs —— 第一版就读错了文件）
    const es = read("src/core/phone-link/event-stream.ts");
    expect(es, "必须用 Math.min 夹到上限").toMatch(/Math\.min\(EVENT_WAIT_MAX_MS/);
  });

  it("ES-5: 只唤醒**相关**的订阅（别的会话变了不该打断等待）", async () => {
    const p = waitPhoneEvents(currentSeq(), "s-1", 400);
    // 不相关的会话发事件 ⇒ 不该被唤醒
    emitPhoneEvent("messages", "s-2");
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingWaiters(), "不相关的事件不该把等待者唤醒").toBe(1);

    // 相关的事件 ⇒ 立刻唤醒
    emitPhoneEvent("messages", "s-1");
    const got = await p;
    expect(got.events.length).toBe(1);
    expect(got.events[0].sessionId).toBe("s-1");

    // 全局事件也该唤醒任何订阅
    const p2 = waitPhoneEvents(currentSeq(), "s-3", 400);
    emitPhoneEvent("sessions");
    const got2 = await p2;
    expect(got2.events.length).toBe(1);
  });

  it("ES-6: 环形缓冲有界（长跑不吃内存），且 oldestSeq 如实前移", () => {
    for (let i = 0; i < EVENT_RING_MAX * 2; i++) emitPhoneEvent("messages", "s-1");
    const all = eventsSince(0, "s-1", { maxItems: 100000 });
    // reset 会先生效（因为 since=0 太老），所以这里用 oldestSeq 来验有界
    expect(all.reset).toBe(true);
    expect(all.oldestSeq).toBe(currentSeq() - EVENT_RING_MAX + 1);
    const fromOldest = eventsSince(all.oldestSeq - 1, "s-1", { maxItems: 100000 });
    expect(fromOldest.events.length, "缓冲里最多只留 EVENT_RING_MAX 条").toBe(EVENT_RING_MAX);
  });

  it("ES-7: 唤醒后取到的是**完整**的一段，否则如实 reset（不许拼凑）", async () => {
    /**
     * ⚠️ 这个场景才是真的：**订阅的会话没动静，而别的会话把缓冲冲爆了**。
     *
     * 第一版我写的是"等 s-1 的同时往 s-1 发事件"—— 那样等待者**第一条就被唤醒**，
     * 根本等不到溢出，于是判据测的是别的东西（红得莫名其妙）。
     * 真正的风险是：客户端在等 A，期间 B 的流量把 A 的检查点挤出了缓冲；
     * 等 A 真的有变化时，客户端**以为自己只差几条**，其实中间已经断了。
     * 这时必须回 reset 让它整批重取。
     */
    const since = currentSeq();
    const p = waitPhoneEvents(since, "s-1", 5000);
    // 别的会话灌爆环形缓冲（不该唤醒 s-1 的等待者）
    for (let i = 0; i < EVENT_RING_MAX + 100; i++) emitPhoneEvent("messages", "s-2");
    expect(pendingWaiters(), "别的会话的事件不该唤醒 s-1 的等待").toBe(1);
    // 现在 s-1 自己变了 ⇒ 唤醒
    emitPhoneEvent("messages", "s-1");
    const got = await p;
    expect(got.reset, "等待期间 s-1 的检查点已被挤出 ⇒ 必须 reset").toBe(true);
    expect(got.events, "reset 时不许拼凑一小截给它").toEqual([]);
  });

  it("ES-9: 手机页面**不再**定时轮询 messages/approvals/run", () => {
    const html = read("src-tauri/src/phone/ui/app.html");
    // 必须出现事件流端点
    expect(html).toContain("/api/events?since=");
    // 旧的 2.6 秒轮询必须消失（那条正是这一阶段要替换掉的东西）
    expect(html, "旧的 2.6s 三连轮询必须被事件流取代").not.toMatch(
      /setInterval\(function\(\)\{ loadMessages\(\); loadApprovals\(\); loadRun\(\); \}/,
    );
    // 会话列表那条 5 秒轮询也不该再无条件跑（事件流会告诉它）
    expect(html).not.toMatch(/setInterval\(function\(\)\{ if \(state\.view === "sessions"\) loadSessions\(\); \}/);
    // 但"整批重取"的路径必须留着（reset 时就靠它）
    expect(html).toMatch(/loadMessages\(|loadApprovals\(/);
  });
});
