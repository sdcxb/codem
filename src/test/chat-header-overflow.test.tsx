/**
 * 聊天头部"更多"菜单（Batch 1B）的结构契约。
 *
 * 为什么值得单测：它是把 7 个图标入口收成 1 个菜单的那一步 —— 一旦"某项点了不生效"
 * 或"Escape 关不掉"，用户会直接失去一个视图入口，而截图看不出来（菜单是展开态才可见）。
 * 判据覆盖：可访问名、勾选态、选中后关闭、Escape 关闭并把焦点还给触发器、禁用项不可点。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HeaderOverflowMenu, type HeaderMenuItem } from "../components/chat/HeaderOverflowMenu";

afterEach(cleanup);

const icon = <span data-testid="icon" />;

function items(onSelect = vi.fn()): HeaderMenuItem[] {
  return [
    { id: "history", label: "完整历史", icon, active: true, onSelect: () => onSelect("history") },
    { id: "reasoning", label: "思考过程", icon, active: false, onSelect: () => onSelect("reasoning") },
    { id: "snapshot", label: "文件快照", icon, active: false, disabled: true, onSelect: () => onSelect("snapshot") },
  ];
}

describe("HeaderOverflowMenu", () => {
  it("触发按钮有可访问名与 aria-expanded；默认不渲染菜单", () => {
    render(<HeaderOverflowMenu items={items()} label="更多操作" menuLabel="视图与面板" />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("打开后每项是 menuitemcheckbox，aria-checked 反映当前态", () => {
    render(<HeaderOverflowMenu items={items()} label="更多操作" />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    const checks = screen.getAllByRole("menuitemcheckbox");
    expect(checks.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(checks.map((el) => el.textContent)).toEqual(["完整历史✓", "思考过程", "文件快照"]);
  });

  it("点某项会调用它的 handler 并关闭菜单", () => {
    const onSelect = vi.fn();
    render(<HeaderOverflowMenu items={items(onSelect)} label="更多操作" />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /思考过程/ }));
    expect(onSelect).toHaveBeenCalledWith("reasoning");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("禁用项不可点（不回退成「点了没反应也不报错」）", () => {
    const onSelect = vi.fn();
    render(<HeaderOverflowMenu items={items(onSelect)} label="更多操作" />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const disabled = screen.getByRole("menuitemcheckbox", { name: /文件快照/ }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    fireEvent.click(disabled);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Escape 关闭菜单并把焦点还给触发按钮", () => {
    render(<HeaderOverflowMenu items={items()} label="更多操作" />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    /* 浏览器里点按钮会先聚焦它（jsdom 不会），这里显式复现那一步 ——
       共享浮层层就是靠"打开前的 activeElement"来还焦点的。 */
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
