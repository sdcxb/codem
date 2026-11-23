import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeaderViewActions, type HeaderViewAction } from "../components/chat/HeaderViewActions";

function items(onSelect = vi.fn()): HeaderViewAction[] {
  return [
    { id: "history", label: "完整历史", icon: <span data-testid="i-history" />, active: true, disabled: true, onSelect },
    { id: "reasoning", label: "思考过程", icon: <span data-testid="i-reasoning" />, active: false, onSelect },
    { id: "agents", label: "智能体与团队", icon: <span data-testid="i-agents" />, active: true, onSelect },
    { id: "snapshot", label: "文件快照", icon: <span />, onSelect },
    { id: "context", label: "上下文", icon: <span />, onSelect },
    { id: "trajectory", label: "执行轨迹", icon: <span />, onSelect },
    { id: "sidePanel", label: "侧边面板", icon: <span />, onSelect },
  ];
}

describe("HeaderViewActions（第 18 轮：视图开关常显）", () => {
  it("七个高频开关直接显示为工具条按钮，不再藏进菜单", () => {
    render(<HeaderViewActions label="视图与面板" items={items()} />);
    expect(screen.getByRole("toolbar", { name: "视图与面板" })).toBeTruthy();
    for (const label of ["完整历史", "思考过程", "智能体与团队", "文件快照", "上下文", "执行轨迹", "侧边面板"]) {
      expect(screen.getByRole("button", { name: label }), label).toBeTruthy();
    }
  });

  it("开关态用 aria-pressed 表达；disabled 不可点；点击调用对应 handler", () => {
    const calls: string[] = [];
    const list = items();
    list.forEach((item) => { item.onSelect = () => calls.push(item.id); });
    render(<HeaderViewActions label="视图" items={list} />);

    expect(screen.getByRole("button", { name: "完整历史" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "思考过程" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "完整历史" }));
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(calls).toEqual(["reasoning"]);
  });

  it("ChatPanel 不再使用旧「更多操作」菜单", () => {
    const src = require("node:fs").readFileSync("src/components/ChatPanel.tsx", "utf8");
    expect(src).toContain("HeaderViewActions");
    expect(src).not.toContain("HeaderOverflowMenu");
  });
});
