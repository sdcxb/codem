/**
 * 应用级菜单栏（第 41 波）—— 键盘可达性与 ARIA 约定。
 *
 * 为什么值得单测：菜单栏是**纯自研**的（项目没有引入 Radix 之类的菜单原语），
 * 键盘行为是它存在的意义的一半 —— 鼠标能点的东西很多，菜单栏的价值在于
 * "命令可读 + 键盘可用"。行为回归了肉眼很难发现（鼠标路径一切正常）。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { AppMenuBar } from "../components/AppMenuBar";
import type { AppMenuSection } from "../components/AppMenuBar";

afterEach(cleanup);

const makeMenus = (spy: (id: string) => void): AppMenuSection[] => [
  {
    id: "file",
    label: "文件",
    items: [
      { id: "new", label: "新建对话", shortcut: "Ctrl+N", onSelect: () => spy("new") },
      { id: "settings", label: "设置", separatorBefore: true, onSelect: () => spy("settings") },
    ],
  },
  {
    id: "view",
    label: "视图",
    items: [{ id: "theme", label: "切换主题", onSelect: () => spy("theme") }],
  },
];

describe("应用菜单栏 — AppMenuBar", () => {
  it("menubar/menuitem/haspopup 语义齐备，初始 aria-expanded=false", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    const bar = screen.getByRole("menubar");
    expect(bar).toBeTruthy();
    const triggers = screen.getAllByRole("menuitem");
    expect(triggers).toHaveLength(2);
    expect(triggers[0].getAttribute("aria-haspopup")).toBe("menu");
    expect(triggers[0].getAttribute("aria-expanded")).toBe("false");
    // 未展开时不应渲染 menu
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("点击展开菜单、aria-expanded 变 true、再点关闭", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    const trigger = screen.getAllByRole("menuitem")[0];
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ArrowDown 打开并把焦点放到第一项；ArrowDown/ArrowUp 在项间循环", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    const trigger = screen.getAllByRole("menuitem")[0];
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    // 只在展开的那张菜单里取项（DOM 顺序是 [触发器, 菜单项…, 触发器…]）
    const menuItems = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(menuItems).toHaveLength(2);
    expect(document.activeElement).toBe(menuItems[0]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItems[1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItems[0]); // 循环回第一项
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(menuItems[1]);
  });

  it("ArrowRight 在菜单之间横向切换（展开态下）", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    const triggers = screen.getAllByRole("menuitem").slice(0, 2);
    fireEvent.keyDown(triggers[0], { key: "ArrowDown" });
    expect(triggers[0].getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowRight" });
    expect(triggers[0].getAttribute("aria-expanded")).toBe("false");
    expect(triggers[1].getAttribute("aria-expanded")).toBe("true");
  });

  it("Esc 关闭菜单并把焦点交回触发器", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    const trigger = screen.getAllByRole("menuitem")[0];
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点击菜单项触发回调并关闭菜单", () => {
    const spy = vi.fn();
    render(<AppMenuBar zh menus={makeMenus(spy)} />);
    fireEvent.click(screen.getAllByRole("menuitem")[0]);
    const settings = screen.getByText("设置");
    fireEvent.click(settings);
    expect(spy).toHaveBeenCalledWith("settings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("分隔线用 role=separator 表达（不是装饰性的 div）", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    fireEvent.click(screen.getAllByRole("menuitem")[0]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("快捷键提示用 aria-keyshortcuts 暴露给读屏", () => {
    render(<AppMenuBar zh menus={makeMenus(vi.fn())} />);
    fireEvent.click(screen.getAllByRole("menuitem")[0]);
    const withShortcut = screen.getAllByRole("menuitem").find((el) => el.getAttribute("aria-keyshortcuts") === "Ctrl+N");
    expect(withShortcut).toBeTruthy();
  });
});
