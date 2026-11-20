/**
 * WATER-POLL：水位刷新从「每 3 秒整会话读」改为「**事件驱动 + 30s 兜底**」（第 6 轮，带回归基线）。
 *
 * ## 基线（改之前）
 *
 * 挂载后每 3 秒无条件 `readContextWaterLevel()` 一次，而它第一句就是 `listVisibleMessages()`
 * （整会话读：合并权威日志 + 索引 + 附件）—— 10 秒 3 次，什么都没变也照读。
 *
 * ## 改之后
 *
 * - 挂载读 1 次；随后 9 秒内不再读（3s 周期已经不存在）；
 * - store 的 `messages` 引用变化（发消息/删除/编辑）⇒ 2s 节流后读一次；
 * - `isStreaming` 由 true 变 false ⇒ **立即**读一次（回合结束是水位跳变点）；
 * - 30s 兜底一次；页面隐藏一律不读，切回立即补拍。
 *
 * 判据看的是「真的读了几次」：注入 `listVisibleMessages` 计数（模块内函数无法被外部 mock，
 * 只能从它依赖的那一层下手）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

let readCount = 0;

vi.mock("../core/storage/message", async () => {
  const actual = await vi.importActual<typeof import("../core/storage/message")>("../core/storage/message");
  return {
    ...actual,
    isHiddenStateAuthoritative: () => true,
    listVisibleMessages: () => {
      readCount += 1;
      return [{ id: `m-${readCount}`, role: "user", content: `第 ${readCount} 次读`, timestamp: readCount, status: "done" }];
    },
  };
});

import { useStableContextWaterLevel } from "../core/context/water-level";
import { useAppStore } from "../store";

let hidden = false;

beforeEach(() => {
  hidden = false;
  readCount = 0;
  useAppStore.setState({ messages: [], isStreaming: false } as never);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WATER-POLL：事件驱动 + 30s 兜底", () => {
  it("挂载读 1 次；随后 9 秒不再读（3s 周期已删）", () => {
    renderHook(() => useStableContextWaterLevel("s1"));
    expect(readCount, "挂载时必须读一次（否则横幅永远不出）").toBe(1);
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(readCount, "9 秒里还按 3s 读 ⇒ 就是被修掉的那笔常态成本").toBe(1);
  });

  it("messages 变化 ⇒ 2s 节流后读一次（多次变化合并）", () => {
    renderHook(() => useStableContextWaterLevel("s1"));
    const before = readCount;
    act(() => {
      for (let i = 0; i < 5; i++) {
        useAppStore.setState({ messages: [{ id: `x-${i}`, role: "assistant", content: "x", timestamp: i, status: "streaming" }] } as never);
      }
      vi.advanceTimersByTime(2100);
    });
    expect(readCount, "消息变了不重算 ⇒ 提示条永远停在旧水位").toBe(before + 1);
  });

  it("流式结束 ⇒ 立即读一次（不等节流窗口）", () => {
    renderHook(() => useStableContextWaterLevel("s1"));
    const before = readCount;
    act(() => {
      useAppStore.setState({ isStreaming: true } as never);
      vi.advanceTimersByTime(3000);
      useAppStore.setState({ isStreaming: false } as never);
    });
    expect(readCount, "回合结束是水位跳变点，必须立刻更新").toBeGreaterThan(before);
  });

  it("30s 兜底（订阅覆盖不到的变化）", () => {
    renderHook(() => useStableContextWaterLevel("s1"));
    const before = readCount;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(readCount, "兜底没了 ⇒ 镜像重载/引擎侧变化永远不同步").toBe(before + 1);
  });

  it("隐藏：节流与兜底都不读；切回立即补拍", () => {
    renderHook(() => useStableContextWaterLevel("s1"));
    hidden = true;
    const before = readCount;
    act(() => {
      useAppStore.setState({ messages: [{ id: "y", role: "assistant", content: "y", timestamp: 1, status: "done" }] } as never);
      vi.advanceTimersByTime(31_000);
    });
    expect(readCount, "隐藏时还在读 ⇒ 后台白烧 CPU/IO").toBe(before);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(readCount, "切回来要立刻看到新值").toBe(before + 1);
  });
});
