/**
 * 测试 8：主题存储 — codem-theme 使用 SQLite
 *
 * 改动影响：
 *   - Sidebar.tsx 的 theme 从 localStorage.getItem("mimo-theme") 改为 getSetting("codem-theme")
 *   - 保存从 localStorage.setItem("mimo-theme") 改为 setSetting("codem-theme")
 *   - 如果有误，主题切换不会持久化，刷新后恢复默认
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getSetting, setSetting } from "../core/storage/settings";

describe("主题存储 — codem-theme 使用 SQLite", () => {
  beforeEach(async () => {
    await initDatabase();
    localStorage.clear();
  });

  it("默认主题为 dark 当无存储", () => {
    const theme = getSetting("codem-theme") as "dark" | "light" | null;
    const result = theme || "dark";
    expect(result).toBe("dark");
  });

  it("保存 light 主题后能读取", () => {
    setSetting("codem-theme", "light");
    const theme = getSetting("codem-theme") as "dark" | "light" | null;
    expect(theme).toBe("light");
  });

  it("保存 dark 主题后能读取", () => {
    setSetting("codem-theme", "dark");
    const theme = getSetting("codem-theme");
    expect(theme).toBe("dark");
  });

  it("切换主题：dark → light → dark", () => {
    setSetting("codem-theme", "dark");
    expect(getSetting("codem-theme")).toBe("dark");

    setSetting("codem-theme", "light");
    expect(getSetting("codem-theme")).toBe("light");

    setSetting("codem-theme", "dark");
    expect(getSetting("codem-theme")).toBe("dark");
  });

  it("不使用旧的 mimo-theme localStorage key", () => {
    const spy = vi.spyOn(localStorage, "setItem");

    setSetting("codem-theme", "light");

    // localStorage.setItem 不应被调用（主题存储走 SQLite）
    expect(spy).not.toHaveBeenCalledWith("mimo-theme", "light");
    expect(spy).not.toHaveBeenCalledWith("codem-theme", "light");
    spy.mockRestore();

    // localStorage 中不应该有 mimo-theme
    expect(localStorage.getItem("mimo-theme")).toBeNull();
  });

  it("不读取旧的 mimo-theme localStorage key", () => {
    // 旧 key 中有数据
    localStorage.setItem("mimo-theme", "light");

    // 新的读取方式不应读到旧 key
    const theme = getSetting("codem-theme") as "dark" | "light" | null;
    expect(theme).toBeNull(); // codem-theme 在 SQLite 中不存在
  });
});
