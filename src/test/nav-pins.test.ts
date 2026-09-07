/**
 * 测试：消息精选 pin（nav-pins，对标 dsh-navbar 📌 精选）
 *
 * 覆盖 NAVPIN-001 ~ NAVPIN-004：
 *   - NAVPIN-001: toggle 添加/移除精选，按会话隔离持久化
 *   - NAVPIN-002: isPinned / listPinnedIds 读取正确
 *   - NAVPIN-003: clearPins 清空该会话
 *   - NAVPIN-004: 非法存储内容安全降级为空列表
 */
import { describe, it, expect, beforeEach } from "vitest";
import { listPinnedIds, isPinned, togglePin, clearPins } from "../core/nav-pins";

const SID_A = "session-a";
const SID_B = "session-b";

describe("nav-pins — 消息精选 pin", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("NAVPIN-001: toggle 添加精选，再次 toggle 移除", () => {
    const afterAdd = togglePin(SID_A, "m1");
    expect(afterAdd).toEqual(["m1"]);
    expect(isPinned(SID_A, "m1")).toBe(true);

    const afterRemove = togglePin(SID_A, "m1");
    expect(afterRemove).toEqual([]);
    expect(isPinned(SID_A, "m1")).toBe(false);
  });

  it("NAVPIN-002: 精选按会话隔离（不串会话）", () => {
    togglePin(SID_A, "m1");
    togglePin(SID_A, "m2");
    togglePin(SID_B, "mX");

    expect(listPinnedIds(SID_A).sort()).toEqual(["m1", "m2"]);
    expect(listPinnedIds(SID_B)).toEqual(["mX"]);
    expect(isPinned(SID_B, "m1")).toBe(false);
  });

  it("NAVPIN-003: clearPins 仅清空指定会话", () => {
    togglePin(SID_A, "m1");
    togglePin(SID_B, "mX");
    clearPins(SID_A);
    expect(listPinnedIds(SID_A)).toEqual([]);
    expect(listPinnedIds(SID_B)).toEqual(["mX"]);
  });

  it("NAVPIN-004: 非法/缺失存储安全降级为空", () => {
    localStorage.setItem("codem-navbar:pins:" + SID_A, "{not-json");
    expect(listPinnedIds(SID_A)).toEqual([]);
    expect(listPinnedIds("session-nonexistent")).toEqual([]);
  });
});
