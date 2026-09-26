/**
 * O-31：**完全重复的文本事件**的收敛判据（读路 + 回放等价性）
 *
 * ## 这一组用例在钉什么
 *
 * 1.16.175 及更早的版本里，页面每次重载都会把当前会话的消息再落库一遍
 * （`appendMessageTextEvent` 的指纹表当时是进程内内存态，重载即清空）。
 * 真机实测（2026-09，用户库副本）：`session_events` 8425 行、其中文本事件 6327 行，
 * **只有 253 条是不同的** —— 6073 行是完全重复，最大重数 218 次。
 * 1.16.176 修好了"不再新增"；O-31 收尾的是**存量**与**可见面**。
 *
 * ## 最要紧的一条：保留 `seq` **最小**的，不是最新的
 *
 * 直觉上"保留最新"更自然（后写的覆盖先写的），但在本仓库**是错的**：
 * `event-projection.ts` 里
 * - `applyUserMessage` 有 `if (state.messages.some(m => m.id === payload.messageId)) return;`
 *   ⇒ **首次写入胜出**，且该消息在派生列表里的**位置**由首次那条的 `seq` 决定；
 * - `applyAssistantText` 的位置同样由**首次**那条决定（`push`），只有正文是后写覆盖。
 *
 * 而收敛只删"载荷逐字节相同"的事件，所以正文保留哪条都一样 —— 会被改变的是**位置**。
 * `DEDUP-3` 用一个**交错**的流（A、B、A）把这件事钉死：
 * 保留最小 → 回放结果 `[A, B]`（与未收敛时逐条相同）；
 * 保留最大 → 回放结果 `[B, A]`（**静默的回放等价性破坏**）。
 * 变异 `DEDUP-M2`（把判据改成保留最大）必须让这条红。
 */
import { describe, it, expect } from "vitest";
import {
  collapseExactDuplicateTextEvents,
  DEDUPABLE_TEXT_EVENT_TYPES,
  isDedupableTextEvent,
  type SessionEvent,
} from "../core/storage/event-types";
import { EventProjection } from "../core/storage/event-projection";

const SID = "s1";

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, sessionId: SID, type, payload, timestamp: 1_700_000_000_000 + seq };
}

/** 用户消息事件 */
const user = (seq: number, mid: string, content: string) =>
  ev(seq, "user_message", { messageId: mid, content });

/** 助手正文事件 */
const assistant = (seq: number, mid: string, content: string) =>
  ev(seq, "assistant_text", { messageId: mid, content });

const seqs = (events: SessionEvent[]) => events.map((e) => e.seq);

describe("O-31 完全重复文本事件的收敛判据", () => {
  it("DEDUP-1：同一份正文写三遍 ⇒ 只留一条，且是 seq 最小的那条", () => {
    const events = [user(10, "u1", "同一份正文"), user(20, "u1", "同一份正文"), user(30, "u1", "同一份正文")];
    const out = collapseExactDuplicateTextEvents(events);
    expect(seqs(out)).toEqual([10]);
  });

  it("DEDUP-2：正文不同（同一 messageId 被改写）⇒ 一条都不删", () => {
    const events = [user(10, "u1", "第一版"), user(20, "u1", "改写版"), assistant(30, "a1", "回复甲"), assistant(40, "a1", "回复乙")];
    const out = collapseExactDuplicateTextEvents(events);
    expect(seqs(out)).toEqual([10, 20, 30, 40]);
  });

  it("DEDUP-3：**回放等价性** —— 收敛前后投影出的消息逐条相同（含交错流）", () => {
    /**
     * 交错是这条用例的关键：`A@10` 与 `A@30` 之间夹着 `B@20`。
     * 只有保留最小 seq 才能让收敛后的回放顺序与收敛前一致。
     */
    const full: SessionEvent[] = [
      user(10, "u1", "第一条问题"),
      assistant(20, "a1", "第一段回复"),
      user(30, "u1", "第一条问题"),
      assistant(40, "a1", "第一段回复"),
      user(50, "u2", "第二条问题"),
      assistant(60, "a2", "第二段回复"),
      user(70, "u1", "第一条问题"),
      assistant(80, "a1", "第一段回复"),
    ];
    const projection = new EventProjection();
    const before = projection.projectFromEvents(full);
    const after = projection.projectFromEvents(collapseExactDuplicateTextEvents(full));

    expect(after).toEqual(before);
    /** 顺序也要逐条对上（`toEqual` 对数组是有序比较，这里再显式钉一次 id 序列） */
    expect(after.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(before.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("DEDUP-4：工具事件**一概不动**（哪怕载荷逐字节相同）", () => {
    const tc = (seq: number) => ev(seq, "tool_call", { toolCallId: "tc1", name: "shell" });
    const events = [tc(10), tc(20), ev(30, "tool_result", { toolCallId: "tc1", content: "ok" }), ev(40, "tool_result", { toolCallId: "tc1", content: "ok" })];
    expect(collapseExactDuplicateTextEvents(events)).toHaveLength(4);
    expect(seqs(collapseExactDuplicateTextEvents(events))).toEqual([10, 20, 30, 40]);
  });

  it("DEDUP-5：可收敛的类型只有 user_message / assistant_text；其余类型一律不算", () => {
    expect([...DEDUPABLE_TEXT_EVENT_TYPES]).toEqual(["user_message", "assistant_text"]);
    expect(isDedupableTextEvent(ev(1, "user_message", {}))).toBe(true);
    expect(isDedupableTextEvent(ev(1, "assistant_text", {}))).toBe(true);
    for (const t of ["tool_call", "tool_result", "session_meta", "turn_start", "compaction", "error", "abort"]) {
      expect(isDedupableTextEvent(ev(1, t, {})), `${t} 不该在收敛范围内`).toBe(false);
    }
  });

  it("DEDUP-6：载荷键顺序不同 ⇒ 不算完全重复（判据是逐字节，不是「看起来一样」）", () => {
    const a = ev(10, "assistant_text", { messageId: "a1", content: "x", extra: 1 });
    const b = ev(20, "assistant_text", { extra: 1, content: "x", messageId: "a1" });
    expect(JSON.stringify(a.payload)).not.toBe(JSON.stringify(b.payload));
    expect(collapseExactDuplicateTextEvents([a, b])).toHaveLength(2);
  });

  it("DEDUP-7：没有重复时**原样返回**（同一批对象、同一顺序）", () => {
    const events = [user(10, "u1", "甲"), assistant(20, "a1", "乙"), user(30, "u2", "丙")];
    const out = collapseExactDuplicateTextEvents(events);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(events[0]);
    expect(out[1]).toBe(events[1]);
    expect(out[2]).toBe(events[2]);
  });

  it("DEDUP-8：真实形态 —— 4842 条文本事件只对应 64 条不同正文时收敛到 64 条", () => {
    /** 造出"每次重载把 64 条消息重写一遍"的形态，共写 30 遍 */
    const events: SessionEvent[] = [];
    let seq = 1;
    for (let round = 0; round < 30; round++) {
      for (let i = 0; i < 32; i++) {
        events.push(user(seq++, `u${i}`, `问题 ${i}`));
        events.push(assistant(seq++, `a${i}`, `回答 ${i}`));
      }
    }
    expect(events).toHaveLength(1920);
    const out = collapseExactDuplicateTextEvents(events);
    expect(out).toHaveLength(64);
    // 保留的是**第一轮**（seq 最小的那一批）
    expect(seqs(out)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    /** 回放等价：收敛前后投影出的消息逐条相同 */
    const projection = new EventProjection();
    expect(projection.projectFromEvents(out)).toEqual(projection.projectFromEvents(events));
  });

  it("DEDUP-9：跨会话不合并 —— 会话 id 在键里，误传跨会话数组只会「收敛不足」", () => {
    /**
     * 纯函数本身不需要知道会话边界（调用方只传单会话的 `readAll`），
     * 但把 `sessionId` 放进判据键是**方向安全**的兜底：
     * 万一有人把跨会话的数组直接丢进来，结果是"少删几条"（可发现、无害），
     * 而不是"把两个会话里各自合法的那条正文合并掉"（丢数据、静默）。
     */
    const a = user(10, "u1", "同样的正文");
    const b: SessionEvent = { ...user(20, "u1", "同样的正文"), sessionId: "s2" };
    const out = collapseExactDuplicateTextEvents([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.sessionId)).toEqual([SID, "s2"]);
  });
});
