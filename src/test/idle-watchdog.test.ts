/**
 * 空闲看门狗契约（第 64 波）—— 对齐 DSH 的 `@deepseek-ai/dsh-timeout`。
 *
 * 用户质疑「用时间做可靠性有问题」之后重做的核心：
 *   · 时间只用来测**沉默**（有没有事件），不用来测**总共干了多久**；
 *   · 有进展就重新上弦 —— **合法长任务永远不会被误杀**；
 *   · `<= 0` 表示不设空闲上限（对齐 DSH 的 `timeoutMs <= 0` 语义）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { idleWatchdog, idleTimeoutOf, IdleTimeoutError } from "../core/session/idle-watchdog";

describe("空闲看门狗（第 64 波，对齐 DSH idleWatchdog）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("IDLE-1: 一直没动静 → 到点中止，原因带能力自己的错误码", () => {
    const w = idleWatchdog(undefined, 1000, "BACKGROUND_TURN_IDLE");
    expect(w.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(w.signal.aborted).toBe(true);
    expect(w.timedOut()).toBe(true);
    const err = idleTimeoutOf(w.signal, "BACKGROUND_TURN_IDLE");
    expect(err).toBeInstanceOf(IdleTimeoutError);
    expect(err?.idleMs).toBe(1000);
    w.dispose();
  });

  it("IDLE-2: 有进展就重新上弦 —— 干一小时也不会被杀（这是与「墙钟上限」最本质的区别）", () => {
    const w = idleWatchdog(undefined, 60_000, "BACKGROUND_TURN_IDLE");
    // 每 30 秒来一次事件，持续"一小时"
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(30_000);
      w.pulse();
    }
    expect(w.signal.aborted, "一直在产出的事件流不该被空闲看门狗中止").toBe(false);
    expect(w.timedOut()).toBe(false);
    // 一旦真的安静下来，仍然会在窗口后中止
    vi.advanceTimersByTime(60_001);
    expect(w.signal.aborted).toBe(true);
    w.dispose();
  });

  it("IDLE-3: idleMs <= 0 表示不设空闲上限（对齐 DSH 的 timeoutMs <= 0）", () => {
    const w = idleWatchdog(undefined, 0, "BACKGROUND_TURN_IDLE");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(w.signal.aborted).toBe(false);
    expect(w.timedOut()).toBe(false);
    w.dispose();
  });

  it("IDLE-4: 上游取消会融合进来（用户点终止 / 父会话 cancel_delegation）", () => {
    const upstream = new AbortController();
    const w = idleWatchdog(upstream.signal, 60_000, "BACKGROUND_TURN_IDLE");
    upstream.abort(new Error("cancelled by user"));
    expect(w.signal.aborted).toBe(true);
    expect(w.timedOut(), "上游取消不算空闲超时").toBe(false);
    expect(idleTimeoutOf(w.signal, "BACKGROUND_TURN_IDLE")).toBeUndefined();
    w.dispose();
  });

  it("IDLE-5: dispose 之后不再计时/不再中止（否则任务结束后还会误报超时）", () => {
    const w = idleWatchdog(undefined, 1000, "BACKGROUND_TURN_IDLE");
    w.dispose();
    vi.advanceTimersByTime(10_000);
    expect(w.signal.aborted).toBe(false);
  });

  it("IDLE-6: 触发之后再 pulse 也不会复活（一次超时就是超时）", () => {
    const w = idleWatchdog(undefined, 1000, "BACKGROUND_TURN_IDLE");
    vi.advanceTimersByTime(1001);
    expect(w.signal.aborted).toBe(true);
    w.pulse();
    expect(idleTimeoutOf(w.signal, "BACKGROUND_TURN_IDLE")).toBeInstanceOf(IdleTimeoutError);
    w.dispose();
  });
});
