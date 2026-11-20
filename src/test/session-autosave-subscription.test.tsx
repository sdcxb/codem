/**
 * AUTOSAVE-SUB：自动保存从「App 的 effect」搬到「store 订阅」后，语义必须逐条不变。
 *
 * ## 为什么值得搬
 *
 * 原实现让 **App 必须订阅 `messages`**：流式期间每 100ms 一次 `appendToMessage`，
 * App 就重渲染一次（连带它渲染的 TitleBar / Sidebar / RightSidebar / ChatPanel）。
 * 自动保存只需要"看到变化就写库"，不需要重渲染。
 *
 * ## 判据（对应原 effect 的每一条）
 *
 * 1. 流式追加 ⇒ **2 秒防抖**，连续多次变化只写一次；
 * 2. 非流式变化 ⇒ **立即**写；
 * 3. 回合结束（isStreaming true→false）⇒ 立即写一次；
 * 4. 归属是 `loadedSessionId`（不是 currentSession）—— 写错归属会被守卫拒绝；
 * 5. 没有归属 / 消息为空 ⇒ 一次都不写；
 * 6. 卸载时未触发的防抖计时器必须清掉（否则会写一个已切走的会话）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAppStore, type Message } from "../store";
import { useSessionAutosave } from "../hooks/useSessionAutosave";

const save = vi.fn();
const msg = (id: string): Message => ({ id, role: "assistant", content: id, timestamp: 1, status: "streaming" }) as Message;

function seed(state: { messages?: Message[]; isStreaming?: boolean; loadedSessionId?: string | null }) {
  act(() => {
    useAppStore.setState({
      messages: state.messages ?? [],
      isStreaming: state.isStreaming ?? false,
      loadedSessionId: state.loadedSessionId === undefined ? "s1" : state.loadedSessionId,
    } as never);
  });
}

beforeEach(() => {
  save.mockClear();
  seed({ messages: [], isStreaming: false, loadedSessionId: "s1" });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AUTOSAVE-SUB：订阅驱动的自动保存", () => {
  it("流式追加：2 秒防抖，多次变化只写一次", () => {
    renderHook(() => useSessionAutosave(save));
    act(() => {
      for (let i = 1; i <= 5; i++) {
        useAppStore.setState({ messages: [msg(`m${i}`)], isStreaming: true } as never);
      }
    });
    expect(save, "收一条写一次 ⇒ 每 100ms 一次库写").not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("s1");
  });

  it("非流式变化：立即写", () => {
    renderHook(() => useSessionAutosave(save));
    seed({ messages: [msg("m1")], isStreaming: false });
    expect(save, "回合结束后改消息必须立刻落库").toHaveBeenCalledWith("s1");
  });

  it("回合结束（true→false）：立即写", () => {
    renderHook(() => useSessionAutosave(save));
    seed({ messages: [msg("m1")], isStreaming: true });
    act(() => {
      useAppStore.setState({ isStreaming: false } as never);
    });
    expect(save).toHaveBeenCalledWith("s1");
  });

  it("归属是 loadedSessionId（不是 currentSession）", () => {
    seed({ messages: [msg("m1")], isStreaming: false, loadedSessionId: "notebook-42" });
    renderHook(() => useSessionAutosave(save));
    act(() => {
      useAppStore.setState({ messages: [msg("m2")] } as never);
    });
    expect(save).toHaveBeenCalledWith("notebook-42");
  });

  it("没有归属 / 消息为空 ⇒ 不写", () => {
    seed({ messages: [], isStreaming: false, loadedSessionId: "s1" });
    renderHook(() => useSessionAutosave(save));
    seed({ messages: [msg("m1")], isStreaming: false, loadedSessionId: null });
    expect(save).not.toHaveBeenCalled();
  });

  it("卸载时清掉未触发的防抖（不写已切走的会话）", () => {
    const { unmount } = renderHook(() => useSessionAutosave(save));
    seed({ messages: [msg("m1")], isStreaming: true });
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(save, "卸载后还在写 ⇒ 会把旧会话的内容写到别处/已关闭的会话").not.toHaveBeenCalled();
  });
});
