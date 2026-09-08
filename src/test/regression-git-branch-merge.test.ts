/**
 * 回归测试 — Git 分支选择器从标题栏合并至右侧栏 Git 面板
 *
 * 背景：TitleBar 顶部的 GitBranchSelector（新建分支/当前分支/切换）
 * 已合并进右侧栏 Git tab 的 GitInfoPanel，标题栏不再驻留该控件。
 *
 * 通过源码 lint 断言结构契约：
 * 1. GitInfoPanel 嵌入 GitBranchSelector 且接通 onBranchChange 联动刷新
 * 2. TitleBar 不再引用 GitBranchSelector
 * 3. GitBranchSelector 保留 onBranchChange 回调契约
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(__dirname, "..", "components");

describe("Git 分支选择器合并：标题栏 → 右侧栏 Git 面板", () => {
  it("GitInfoPanel 嵌入 GitBranchSelector（承担分支显示/切换/新建）", () => {
    const src = readFileSync(join(componentsDir, "GitInfoPanel.tsx"), "utf-8");
    expect(src).toContain('import { GitBranchSelector } from "./GitBranchSelector";');
    expect(src).toContain("<GitBranchSelector");
  });

  it("GitInfoPanel 接通 onBranchChange 联动刷新", () => {
    const src = readFileSync(join(componentsDir, "GitInfoPanel.tsx"), "utf-8");
    expect(src).toContain("onBranchChange={handleBranchChange}");
    expect(src).toContain("handleBranchChange");
  });

  it("TitleBar 不再引用 GitBranchSelector", () => {
    const src = readFileSync(join(componentsDir, "TitleBar.tsx"), "utf-8");
    expect(src).not.toContain("GitBranchSelector");
  });

  it("GitBranchSelector 保留 onBranchChange 回调契约", () => {
    const src = readFileSync(join(componentsDir, "GitBranchSelector.tsx"), "utf-8");
    expect(src).toContain("onBranchChange?: (branchName: string) => void");
    expect(src).toContain("onBranchChange?.(branchName)");
  });
});
