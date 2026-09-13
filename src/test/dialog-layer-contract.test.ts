/**
 * 对话框层叠契约（第 73 波）—— 拦住"确认框被压在模态后面"这一类静默事故
 *
 * 事故现场（用户报「技能管理里删除技能卡死」的最终根因）：
 *   - 技能管理器本身是模态：`.modal-overlay { z-index: var(--z-modal) }` = 1300
 *   - 它内部的"确认删除"弹窗只拿到 `.alert-dialog-content { z-index: var(--z-dropdown) }` = 1000
 *   两者一旦落在不同的层叠上下文里（不同皮肤 / 插件 / 祖先样式都会造成），确认框就排到模态
 *   后面：**看不见、点不到**；而 Radix 打开模态时已把 `body { pointer-events: none }`，
 *   于是整个窗口"点不动"，而主线程完全正常 —— 控制台、日志、性能面板全都没有线索。
 *   用户那份落盘轨迹正是这样：心跳 drift ±10ms（线程活着），却永远没有"确认"这一步。
 *
 * 所以这条约束必须变成机器可读的**层叠顺序契约**：
 *   ① 存在高于 `--z-modal` 的对话框令牌；
 *   ② 对话框/遮罩确实使用这些令牌（而不是回落到 dropdown 那一档）。
 *
 * jsdom 不做布局，所以这类"位置/层叠"的正确性只能靠 CSS 契约来守（与仓库里其它布局契约测试一致）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const styles = readFileSync(join(ROOT, "styles.css"), "utf8");
const uiCss = readFileSync(join(ROOT, "styles", "codem-ui.css"), "utf8");

/** 读 `:root` 里的 z-index 令牌值 */
function token(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)\\s*;`).exec(styles);
  expect(match, `styles.css 应定义 --${name}`).toBeTruthy();
  return Number(match![1]);
}

/** 读某条规则块里的某个属性值 */
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  expect(match, `应能定位规则 ${selector}`).toBeTruthy();
  return match![1];
}

describe("对话框层叠契约 — 对话框必须高于模态", () => {
  it("LAYER-1: 对话框令牌存在且严格高于 --z-modal（模态内部弹出的确认框不能再被压住）", () => {
    const modal = token("z-modal");
    const dialogOverlay = token("z-dialog-overlay");
    const dialog = token("z-dialog");

    expect(dialogOverlay).toBeGreaterThan(modal);
    expect(dialog).toBeGreaterThan(modal);
    expect(dialog).toBeGreaterThan(dialogOverlay);
  });

  it("LAYER-2: .alert-dialog-content 用对话框令牌（事故里它回落到 --z-dropdown）", () => {
    const block = ruleBlock(styles, ".alert-dialog-content");
    expect(block).toMatch(/z-index:\s*var\(--z-dialog\)/);
    expect(block).not.toMatch(/z-index:\s*var\(--z-dropdown\)/);
  });

  it("LAYER-3: Radix Dialog 的遮罩与内容同样用对话框令牌", () => {
    const overlay = ruleBlock(uiCss, ".dialog-overlay");
    expect(overlay).toMatch(/z-index:\s*var\(--z-dialog-overlay\)/);
    const content = ruleBlock(uiCss, ".dialog-content");
    expect(content).toMatch(/z-index:\s*var\(--z-dialog\)/);
  });

  it("LAYER-4: 技能管理的删除确认不再使用嵌套模态弹窗（这才是不再依赖层叠运气的修法）", () => {
    const skillManager = readFileSync(join(ROOT, "components", "SkillManager.tsx"), "utf8");
    // 删除确认必须走面板内联确认，而不是"模态里再开一个模态"
    expect(skillManager).toContain("skill-delete-confirm");
    expect(skillManager).not.toMatch(/AlertDialog open=\{!!deleteTarget\}/);
    // 内联确认块必须在 styles.css 里有落地样式（否则"确认"按钮样式会退化）
    expect(styles).toMatch(/\.skill-delete-confirm\s*\{/);
    expect(styles).toMatch(/\.skill-delete-confirm-actions\s*\{/);
  });
});
