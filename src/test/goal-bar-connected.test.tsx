/**
 * GOAL-BAR：目标条必须**真的渲染**（第 5 轮修的接线缺陷）。
 *
 * ## 现场
 *
 * `app.goal-bar` 插槽的渲染点是 `<SlotBridge name="app.goal-bar" fallback={null} />` ——
 * **一个 props 都没传**；而 `GoalBar` 的判据是 `goal === undefined ⇒ return null`。
 * 结果是：目标模式创建成功、`uiGoal` 插件注册成功，界面**永远空白**
 * （没有加载态、没有空态），用户完全不知道目标还在不在。
 *
 * ## 判据（行为）
 *
 * - 有活动目标 ⇒ 输入区上方出现目标条，且文案是目标的 statement；
 * - 没有目标 / 已取消 ⇒ 不渲染（不占位、不显示假的"进行中"）；
 * - 点暂停 ⇒ 调 `stopSessionGoal(sessionId)`；点恢复 ⇒ 调 `resumeSessionGoal(sessionId)`；
 * - 目标事件到达时自动刷新。
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

type Details = {
  view: { status: string; statement: string };
  goal: { id: string; statement: string };
} | null;

let details: Details = null;
let goalEventListeners: Array<() => void> = [];

vi.mock("../core/goal/runtime", () => ({
  getGoalDetails: () => details,
  stopSessionGoal: vi.fn(() => true),
  resumeSessionGoal: vi.fn(() => ({ ok: true })),
}));

vi.mock("../core/goal/events", () => ({
  subscribeGoalEvents: (fn: () => void) => {
    goalEventListeners.push(fn);
    return () => {
      goalEventListeners = goalEventListeners.filter((x) => x !== fn);
    };
  },
}));

import { GoalBarConnected, readGoalSnapshot } from "../components/GoalBarConnected";
import { stopSessionGoal, resumeSessionGoal } from "../core/goal/runtime";
import { useAppStore } from "../store";

beforeEach(() => {
  details = null;
  goalEventListeners = [];
  vi.clearAllMocks();
  useAppStore.setState({ loadedSessionId: "s1" });
});

describe("GOAL-BAR：目标条渲染与操作", () => {
  it("有活动目标 ⇒ 渲染目标文本", () => {
    details = { view: { status: "active", statement: "把登录态修好" }, goal: { id: "g1", statement: "把登录态修好" } };
    render(<GoalBarConnected />);
    expect(screen.getByText(/把登录态修好/)).toBeTruthy();
  });

  it("没有目标 ⇒ 什么都不渲染（不占位）", () => {
    details = null;
    const { container } = render(<GoalBarConnected />);
    expect(container.firstChild).toBeNull();
  });

  it("已取消的目标不渲染（不谎报进行中）", () => {
    details = { view: { status: "cancelled", statement: "旧目标" }, goal: { id: "g1", statement: "旧目标" } };
    const { container } = render(<GoalBarConnected />);
    expect(container.firstChild).toBeNull();
  });

  it("点暂停调用 stopSessionGoal；点恢复调用 resumeSessionGoal", () => {
    details = { view: { status: "active", statement: "把登录态修好" }, goal: { id: "g1", statement: "把登录态修好" } };
    render(<GoalBarConnected />);
    /* GoalBar 的动作按钮用 aria-label（中英各一套），这里按中文找 */
    const pause = screen.queryByLabelText(/暂停/) ?? screen.queryByTitle(/暂停/);
    expect(pause, "目标条没有暂停入口").toBeTruthy();
    fireEvent.click(pause!);
    expect(stopSessionGoal).toHaveBeenCalledWith("s1");

    details = { view: { status: "paused", statement: "把登录态修好" }, goal: { id: "g1", statement: "把登录态修好" } };
    act(() => {
      goalEventListeners.forEach((fn) => fn());
    });
    const resume = screen.queryByLabelText(/恢复|继续/) ?? screen.queryByTitle(/恢复|继续/);
    expect(resume, "暂停后没有恢复入口").toBeTruthy();
    fireEvent.click(resume!);
    expect(resumeSessionGoal).toHaveBeenCalledWith("s1");
  });

  it("readGoalSnapshot：无会话 / 无 details 都返回 null", () => {
    expect(readGoalSnapshot(null)).toBeNull();
    details = null;
    expect(readGoalSnapshot("s1")).toBeNull();
  });
});
