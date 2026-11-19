/**
 * DRAFT-IPC：草稿落盘必须**防抖**，不能每敲一个字发一次 IPC（第 5 轮真实缺陷）。
 *
 * ## 现场
 *
 * 原实现把「防抖 500ms」与「切换/卸载立即冲刷」写在**同一条 effect** 里：
 * 依赖含 `draft`，cleanup 里无条件 `writeDraft(...)`。于是每次输入都会先跑上一版 effect 的
 * cleanup ⇒ **每敲 1 个字 = 1 次 `settings.set` IPC**，防抖完全失效。
 * 用户可感：输入越长越卡（每次击键一次跨进程写），长粘贴成串触发。
 *
 * ## 判据
 * - 连续输入 N 个字后（< 500ms 内）：`settings.set` **0 次**；
 * - 停止输入 500ms 后：恰好 1 次，且值是**最后一次**的文本；
 * - 切换会话（key 变化）：立即把**旧 key** 的草稿写回（丢字场景），且不写到新 key 上；
 * - 草稿为空且从没落过盘：卸载时不写（避免"路过会话"攒空行）。
 *
 * 用 `renderHook` + fake timers，`settings` 模块整体 mock：判据只看"跨进程写的次数"。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const writes: Array<{ key: string; value: string }> = [];
const removes: string[] = [];

vi.mock("../core/storage/settings", () => ({
  getSetting: () => undefined,
  setSetting: (key: string, value: string) => {
    writes.push({ key, value });
  },
  removeSetting: (key: string) => {
    removes.push(key);
  },
}));

import { useDraftPersistence } from "../hooks/useDraftPersistence";

beforeEach(() => {
  writes.length = 0;
  removes.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DRAFT-IPC：草稿防抖", () => {
  it("连续输入 10 个字（未满 500ms）不发任何 IPC", () => {
    const { result } = renderHook(() => useDraftPersistence("s1"));
    act(() => {
      for (let i = 0; i < 10; i++) result.current.setDraft("x".repeat(i + 1));
    });
    expect(writes, "每敲一个字就写一次 IPC，说明防抖被 cleanup 绕过了").toEqual([]);
  });

  it("停止输入 500ms 后只写一次，值是最后的文本", () => {
    const { result } = renderHook(() => useDraftPersistence("s1"));
    act(() => {
      result.current.setDraft("你");
      result.current.setDraft("你好");
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(writes).toEqual([{ key: "composer-draft-s1", value: "你好" }]);
  });

  it("切换会话：立即把旧 key 的草稿写回，不写新 key", () => {
    const { result, rerender } = renderHook(({ k }) => useDraftPersistence(k), { initialProps: { k: "s1" } });
    act(() => {
      result.current.setDraft("旧会话的字");
    });
    /* 还没到 500ms 就切换 —— 旧实现会在这里丢掉（或写错 key） */
    rerender({ k: "s2" });
    expect(writes, "切换会话必须立即冲刷旧 key").toEqual([{ key: "composer-draft-s1", value: "旧会话的字" }]);
  });

  it("没落过盘的空草稿：卸载不写（不攒空行）", () => {
    const { unmount } = renderHook(() => useDraftPersistence("s1"));
    unmount();
    expect(writes, "路过的会话不该留空草稿").toEqual([]);
  });
});
