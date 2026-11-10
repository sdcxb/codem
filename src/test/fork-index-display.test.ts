/**
 * P0-0（D1/E5/D11）：分叉的「下标空间」必须与切片空间一致。
 *
 * ## 被守的缺陷
 *
 * 分叉走两步：① 用「窗口内下标 + 全量列表」换算出会话内绝对下标；
 * ② `store.forkSession` 按绝对下标从全量列表切片。
 *
 * 两步以前都用 `listMessages`（模型投影），所以"一致"是免费的。
 * P0-0 把切片改成 `listDisplayMessages`（换过段的会话要完整时间线）之后，
 * 如果换算仍用投影视图，两个下标空间就分叉了：
 *
 * - 换过段的会话里投影视图只有最新段 ⇒ 偏移量算小 ⇒ **分叉点被往前挪**；
 * - 表现是「点最后一轮分叉，子会话少了换段前的内容」，静默无报错。
 *
 * 这两条用例分别钉「换算用 DisplayView」和「没换段时行为不变」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage, listDisplayMessages, listMessages } from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";
import { resolveForkIndexForSession, resolveSessionAbsoluteIndex } from "../core/session/fork-index";

const S = "sess-fork-index-display";

function epochMarker(id: string, cutoffMessageId: string, kind: "compact" | "switch", seq: number) {
  return buildContextEpochMetadata({
    epochId: id,
    cutoffMessageId,
    createdAt: 100 * seq,
    removedCount: 1,
    keptCount: 1,
    trigger: kind === "switch" ? "switch" : "auto",
    kind,
    segmentSeq: seq,
  }) ?? undefined;
}

describe("fork 下标换算 × DisplayView", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({
      seed: {
        sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    }));
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("FI-1: 换过段时按 DisplayView 算偏移（用小了会丢换段前的内容）", () => {
    createMessage({ id: "m1", role: "user", content: "换段之前", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      metadata: epochMarker("compact-switch-2", "m2", "switch", 2),
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "换段之前答", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "第三", timestamp: 4, status: "done" }, S);
    createMessage({ id: "m4", role: "assistant", content: "第四", timestamp: 5, status: "done" }, S);
    createMessage({ id: "m5", role: "user", content: "第五", timestamp: 6, status: "done" }, S);

    const display = listDisplayMessages(S);
    expect(display.map((m) => m.id), "前提：DisplayView 是完整的 6 条").toHaveLength(6);
    expect(listMessages(S).map((m) => m.id), "前提：模型投影只有最新段").toEqual([
      "compact-switch-2", "m2", "m3", "m4", "m5",
    ]);

    /**
     * ⚠️ 窗口必须用**生产形态**：`useAppStore().messages` 由 `listMessages` 填充
     * （`src/store.ts:556`），不是 DisplayView 的后缀。用 DisplayView 造窗口会让
     * "offset + 窗口下标"这个错误假设恰好成立 —— 测不出缺陷（复核 2 抓到的正是这个）。
     */
    const window = listMessages(S).map((m) => ({ id: m.id, timestamp: m.timestamp }));
    const clicked = window.findIndex((m) => m.id === "m3");

    const result = resolveForkIndexForSession(S, clicked, window);

    /* m3 在 DisplayView 里的位置是 3；用投影下标 + 时间戳偏移会算成 2（指向 m2） */
    expect(result.absoluteIndex, "必须指到被点消息在 DisplayView 里的位置（m3 → 3）").toBe(3);
    expect(result.windowStartAbsoluteIndex, "窗口首条 marker 在 DisplayView 的第 1 位").toBe(1);
  });

  it("FI-1b: 换段后又压缩过（投影把 marker 挪到最前）仍按 id 定位", () => {
    createMessage({ id: "m1", role: "user", content: "第一段", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到第二段]",
      timestamp: 2,
      status: "done",
      metadata: epochMarker("compact-switch-2", "m2", "switch", 2),
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "二", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "三", timestamp: 4, status: "done" }, S);
    createMessage({
      id: "compact-400-3",
      role: "user",
      content: "[段内压缩]",
      timestamp: 5,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-400-3",
        cutoffMessageId: "m3",
        createdAt: 400,
        removedCount: 1,
        keptCount: 1,
        trigger: "auto",
        kind: "compact",
        segmentSeq: 2,
      }) ?? undefined,
    }, S);
    createMessage({ id: "m4", role: "user", content: "四", timestamp: 6, status: "done" }, S);

    const display = listDisplayMessages(S);
    expect(display.map((m) => m.id), "DisplayView 顺序 = 时间线顺序").toEqual([
      "m1", "compact-switch-2", "m2", "m3", "compact-400-3", "m4",
    ]);
    const projection = listMessages(S);
    expect(projection.map((m) => m.id), "投影把最新 marker 挪到最前").toEqual([
      "compact-400-3", "m3", "m4",
    ]);

    const window = projection.map((m) => ({ id: m.id, timestamp: m.timestamp }));
    const clicked = window.findIndex((m) => m.id === "m3");
    const result = resolveForkIndexForSession(S, clicked, window);

    expect(result.absoluteIndex, "m3 在 DisplayView 的第 3 位（不是投影第 1 位）").toBe(3);
    expect(display[result.absoluteIndex].id, "定位到的必须就是被点的那条").toBe("m3");
  });

  it("FI-2: 没换过段时与旧行为（注入 listMessages）逐值相同", () => {
    createMessage({ id: "m1", role: "user", content: "一", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-100-1",
      role: "user",
      content: "[摘要]",
      timestamp: 2,
      status: "done",
      metadata: epochMarker("compact-100-1", "m3", "compact", 1),
    }, S);
    createMessage({ id: "m3", role: "assistant", content: "三", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m4", role: "user", content: "四", timestamp: 4, status: "done" }, S);

    const window = listDisplayMessages(S).slice(-2).map((m) => ({ id: m.id, timestamp: m.timestamp }));
    const next = resolveForkIndexForSession(S, 1, window);
    const prev = resolveSessionAbsoluteIndex(S, 1, window, (sid) => listMessages(sid));

    expect(next.offset).toBe(prev.offset);
    expect(next.absoluteIndex).toBe(prev.absoluteIndex);
  });
});
