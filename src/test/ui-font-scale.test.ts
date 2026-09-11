/**
 * 全局字号缩放契约（第 56 波）。
 *
 * 真实事故（用户报「点开设置，主页文字突然都变大了；关了设置也还是放大状态」）：
 * 同一个"界面字号"设置存在**两个键**里，且两处各带一个**不同的默认值**：
 *   - 启动路径（Sidebar 挂载）读旧扁平键 `codem-font-size` —— 没拖过滑杆就没有这个键 → 基准 13px；
 *   - 设置页打开时应用 `codem-settings.fontSize` —— 默认 14 → 全站放大 14/13 ≈ 7.7%。
 * 变量写在 `<html>` 行内样式上，关掉设置不会复原，重启又回到 13 —— 表现为"奇怪的跳变"。
 *
 * 这里把「单一来源 + 默认值与基准一致 + 启动就应用」三件事锁成契约。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUiFontPx, applyUiFontScale, FONT_BASE_PX } from "../core/ui-font";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("全局字号缩放（第 56 波）", () => {
  it("UI-FONT-1: 没有存值时回落到基准 13px（scale 1.0），不产生跳变", () => {
    expect(resolveUiFontPx({})).toBe(FONT_BASE_PX);
    expect(FONT_BASE_PX).toBe(13);
    expect(resolveUiFontPx({ fontSize: undefined, legacyRaw: null })).toBe(13);
    expect(resolveUiFontPx({ fontSize: "", legacyRaw: "" })).toBe(13);
    // 基准 → CSS 变量必须是 1.000（即"不缩放"）
    applyUiFontScale(FONT_BASE_PX);
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("1.000");
  });

  it("UI-FONT-2: 优先级 = 滑杆写入的旧键 → 设置对象里非旧默认值的字号 → 基准", () => {
    // ① 旧扁平键只由滑杆写入 ⇒ 用户明确选择，最优先
    expect(resolveUiFontPx({ fontSize: 16, legacyRaw: "12" })).toBe(12);
    expect(resolveUiFontPx({ legacyRaw: "15" })).toBe(15);
    // ② 没有旧键时用设置对象里的值（字符串也接受）
    expect(resolveUiFontPx({ fontSize: 17 })).toBe(17);
    expect(resolveUiFontPx({ fontSize: "16" })).toBe(16);
    // ③ 旧默认值 14 + 没有滑杆写入记录 = 从未设置过 → 基准（否则这批用户会被永久放大 7.7%）
    expect(resolveUiFontPx({ fontSize: 14, legacyRaw: null })).toBe(13);
    expect(resolveUiFontPx({ fontSize: 14, legacyRaw: "" })).toBe(13);
    // ④ 但用户确实拖过滑杆到 14 时，14 是明确选择，照用
    expect(resolveUiFontPx({ fontSize: 14, legacyRaw: "14" })).toBe(14);
  });

  it("UI-FONT-3: 越界与垃圾值都被钳制/回落，绝不写出 NaN", () => {
    expect(resolveUiFontPx({ fontSize: 100 })).toBe(20);
    expect(resolveUiFontPx({ fontSize: 1 })).toBe(10);
    expect(resolveUiFontPx({ fontSize: Number.NaN, legacyRaw: "abc" })).toBe(13);
    expect(resolveUiFontPx({ fontSize: "abc", legacyRaw: "xyz" })).toBe(13);
    applyUiFontScale(100);
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe((20 / 13).toFixed(3));
  });

  it("UI-FONT-4: 设置页的字号默认值必须等于缩放基准（两边默认值不同就是本次 bug 的根）", () => {
    const panel = read("src/components/SettingsPanel.tsx");
    expect(panel, "设置页默认字号应写成 FONT_BASE_PX").toMatch(/fontSize:\s*FONT_BASE_PX/);
    expect(panel, "不应再出现写死的 14").not.toMatch(/fontSize:\s*14\b/);
    // 滑杆范围也要与钳制范围一致
    expect(panel).toMatch(/min="10"/);
    expect(panel).toMatch(/max="20"/);
  });

  it("UI-FONT-5: 启动时就应用字号（数据库就绪后），而不是等打开设置才应用", () => {
    const app = read("src/App.tsx");
    const initIdx = app.indexOf("await initDatabase()");
    const applyIdx = app.indexOf("applyStoredUiFont()");
    expect(initIdx, "App.tsx 应有 await initDatabase()").toBeGreaterThan(0);
    expect(applyIdx, "App.tsx 应在数据库就绪后调用 applyStoredUiFont()").toBeGreaterThan(0);
    expect(applyIdx, "applyStoredUiFont() 必须在 initDatabase() 之后（设置存在 SQLite 里）").toBeGreaterThan(initIdx);
    // 侧栏启动路径也必须用同一个解析器（不能再直接读旧键）
    const sidebar = read("src/components/Sidebar.tsx");
    expect(sidebar).toMatch(/applyStoredUiFont\(\)/);
    expect(sidebar, "侧栏不应再自己读旧键去应用字号").not.toMatch(/applyStoredUiFont\(getSetting\)/);
  });

  it("UI-FONT-6: 设置页打开时用的是同一个解析器（不再直接应用 parsed.fontSize）", () => {
    const panel = read("src/components/SettingsPanel.tsx");
    expect(panel).toMatch(/applyStoredUiFont\(\)/);
    expect(panel, "不应再直接应用 parsed.fontSize（那正是跳变的来源）").not.toMatch(/applyUiFontScale\(\(parsed as Settings\)\.fontSize/);
  });
});
