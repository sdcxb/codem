/**
 * 翻页（loadMoreMessages）：**「读不到」不许被写成「没有更多历史」**（第 48 轮）
 *
 * ## 守的缺陷（与首屏那条同一类，但后果更重）
 *
 * `loadMoreMessages` 原来只有一个结局：拿不到更早的消息就把 `hasMoreMessages` 置 false。
 * 于是"这次读失败了"与"真的翻到开头了"合并成同一件事。首屏那条（`messagesReadUnavailable`）
 * 第 47 轮修过，翻页这条一直留着，而它的后果比首屏更重：
 *
 * `hasMoreMessages` 同时控制着**「↑ 滚动加载更多历史消息」提示条**与
 * **滚动到底的自动翻页**（`ChatPanel` / `NbChatPanel` 都按它渲染）。
 * 一旦被写成 false，用户不仅看不到更早的消息，而且**再没有任何重试机会** ——
 * 界面一切正常、没有任何错误，看起来只是"这个会话本来就不长"。
 * 一个真有 800 条历史的会话就这样被永久渲染成"就这么多"。
 *
 * ## 判据（每一档都有用例）
 *
 * | 情形 | `hasMoreMessages` | `loadMoreReadUnavailable` |
 * | --- | --- | --- |
 * | 读路径不可用（端口没注册 / 镜像没接手 / 被截断） | **保持 true** | `true` |
 * | 读抛错 | **保持 true** | `true` |
 * | 读可用，确实还有更早的 | `true`（还有剩余时） | `false` |
 * | 读可用，确实翻到开头了 | `false` | `false` |
 *
 * 关键是**"读不到"不构成"没有"的证据**：前者只能保持原值 + 给重试入口，
 * 后者才允许把入口收掉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { __resetSaveFingerprints, useAppStore, type Message } from "../store";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SESSION_A = "sess-paging-A";

/** A 的历史：30 条（> loadMessages 的 INITIAL_LIMIT=10，于是 hasMoreMessages 初始为 true） */
const aHistory = (): Message[] =>
  Array.from({ length: 30 }, (_, i) => ({
    id: `a-${i + 1}`,
    role: "user" as const,
    content: `A 的第 ${i + 1} 条`,
    timestamp: 1_000 + i,
    status: "done" as const,
  }));

let port: FakeStoragePort;

beforeEach(() => {
  resetPersistFailures();
  __resetSaveFingerprints();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SESSION_A, project_id: "p1", title: "A", created_at: 1, last_message_at: 2, message_count: 0 },
      ],
      messages: aHistory().map((m) => ({ ...m, session_id: SESSION_A, hidden: 0 })),
    },
  });
  setStoragePort(port);
  const s = useAppStore.getState();
  s.clearMessages();
});

afterEach(() => {
  useAppStore.getState().clearMessages();
  setStoragePort(null);
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 跑一次翻页（那 300ms 回调必须用假计时器推进，否则用例同步跑完、回调根本不触发） */
function runLoadMore(sessionId: string, count?: number): void {
  vi.useFakeTimers();
  try {
    useAppStore.getState().loadMoreMessages(sessionId, count);
    vi.advanceTimersByTime(500);
  } finally {
    vi.useRealTimers();
  }
}

describe("LM：翻页的「读不到」与「没有更多」必须分开", () => {
  it("LM-1: 读路径不可用 → hasMoreMessages 保持 true、标记读不到、并上报（不许静默）", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    expect(useAppStore.getState().messages.length, "前置：首屏只有最后 10 条").toBe(10);
    expect(useAppStore.getState().hasMoreMessages, "前置：还有更早的").toBe(true);

    const before = useAppStore.getState().messages.map((m) => m.id);

    // 读路径变得不可用（端口掉了 / 镜像没接手 —— 与 `isMessagesReadUnavailable` 同源）
    setStoragePort(null);

    runLoadMore(SESSION_A, 20);

    const after = useAppStore.getState();
    expect(
      after.hasMoreMessages,
      "「读不到」不是「没有」的证据：置 false 会让提示条与自动翻页一起消失、重试入口也没了",
    ).toBe(true);
    expect(after.loadMoreReadUnavailable, "必须如实标记这次没读到").toBe(true);
    expect(after.isLoadingMore, "loading 必须归位，否则翻页永久卡住").toBe(false);
    expect(after.messages.map((m) => m.id), "失败的翻页不许改动列表").toEqual(before);
    expect(
      getPersistFailures().map((f) => f.area),
      "失败必须可见（静默失败正是这条缺陷的本体）",
    ).toContain("store.loadMoreMessages");
  });

  it("LM-2: 读路径恢复后重试 → 更早的消息真的补回来，两个标记归位", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    setStoragePort(null);
    runLoadMore(SESSION_A, 20);
    expect(useAppStore.getState().loadMoreReadUnavailable, "前置：第一次没读到").toBe(true);

    // 读路径回来了 → 重试
    setStoragePort(port);
    runLoadMore(SESSION_A, 20);

    const after = useAppStore.getState();
    expect(after.messages.length, "应当补回 20 条更早的").toBe(30);
    expect(after.messages[0].id, "补回来的是**最前面**那段").toBe("a-1");
    expect(after.loadMoreReadUnavailable, "成功后标记必须清掉").toBe(false);
    expect(after.hasMoreMessages, "30 条全在窗口里了 → 没有更多").toBe(false);
    expect(after.isLoadingMore).toBe(false);
  });

  it("LM-3: 读可用且确实翻到开头了 → 才允许收掉入口（不许把正常路径也改成永远可重试）", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    expect(useAppStore.getState().hasMoreMessages).toBe(true);

    // 一次要 100 条 → 30 条全进窗口 → olderMessages 为空 = 真的到开头了
    runLoadMore(SESSION_A, 100);

    const after = useAppStore.getState();
    expect(after.messages.length).toBe(30);
    expect(after.hasMoreMessages, "真的没有更早的了 → 入口应当收掉").toBe(false);
    expect(after.loadMoreReadUnavailable, "这是正常结局，不是「读不到」").toBe(false);
    expect(
      getPersistFailures().map((f) => f.area),
      "正常结局不许上报失败",
    ).not.toContain("store.loadMoreMessages");
  });

  it("LM-4: 首屏重读会清掉上一次翻页的「读不到」（标记属于那一次读，不许跨会话/跨读残留）", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    setStoragePort(null);
    runLoadMore(SESSION_A, 20);
    expect(useAppStore.getState().loadMoreReadUnavailable).toBe(true);

    // 会话重新加载（用户点了"重新读取"，或切回来）
    setStoragePort(port);
    useAppStore.getState().loadMessages(SESSION_A);

    expect(
      useAppStore.getState().loadMoreReadUnavailable,
      "上一次翻页的结论必须跟着那一次读结束",
    ).toBe(false);
    expect(useAppStore.getState().hasMoreMessages).toBe(true);
  });

  it("LM-5: 归属已切换时丢弃回调（P0-2 的守卫不许被这次改动破坏）", () => {
    const SESSION_B = "sess-paging-B";
    setStoragePort(
      createFakeStoragePort({
        seed: {
          sessions: [
            { id: SESSION_A, project_id: "p1", title: "A", created_at: 1, last_message_at: 2, message_count: 0 },
            { id: SESSION_B, project_id: "p1", title: "B", created_at: 1, last_message_at: 2, message_count: 0 },
          ],
          messages: [
            ...aHistory().map((m) => ({ ...m, session_id: SESSION_A, hidden: 0 })),
            { id: "b-1", session_id: SESSION_B, role: "user", content: "B 的唯一一条", timestamp: 5_000, status: "done", hidden: 0 },
          ],
        },
      }),
    );
    useAppStore.getState().loadMessages(SESSION_A);

    vi.useFakeTimers();
    try {
      useAppStore.getState().loadMoreMessages(SESSION_A, 20);
      useAppStore.getState().loadMessages(SESSION_B); // 300ms 窗口内切走
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }

    const after = useAppStore.getState();
    expect(after.messages.map((m) => m.id), "不许把 A 的历史拼进 B").toEqual(["b-1"]);
    expect(after.isLoadingMore).toBe(false);
    expect(
      after.loadMoreReadUnavailable,
      "被丢弃的回调不是「读不到」，不许把 B 的界面顶上一行告警",
    ).toBe(false);
  });
});

describe("LM-WIRE：界面上真的把这件事说出来了（否则修了等于没修）", () => {
  const read = (rel: string) => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", rel), "utf8");

  it("LM-WIRE-1: ChatPanel 渲染「读不到」分支并给重试入口", () => {
    const src = read("src/components/ChatPanel.tsx");
    expect(src, "必须按标记分支").toContain("loadMoreReadUnavailable");
    expect(src, "必须给测试锚点（真机/用例都能定位）").toContain('data-testid="load-more-unavailable"');
    expect(src, "普通提示条必须在「读不到」时不显示（否则两条自相矛盾）").toContain(
      "hasMoreMessages && !loadMoreReadUnavailable",
    );
  });

  it("LM-WIRE-2: NbChatPanel 同样分支（两个面板不许一个说一个不说）", () => {
    const src = read("src/components/NbChatPanel.tsx");
    expect(src).toContain("loadMoreReadUnavailable");
    expect(src).toContain('data-testid="nb-load-more-unavailable"');
    expect(src).toContain("hasMoreMessages && !loadMoreReadUnavailable");
  });
});
