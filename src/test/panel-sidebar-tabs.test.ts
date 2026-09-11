/**
 * 右侧浮层面板（PanelSidebar）的标签行布局契约。
 *
 * 背景：这个面板的标签是 **Git / 文件 / 变更 / 工作台 / CI·CD** 五个，用户两次反馈这里不对：
 * ① 先是有横向滚动条（按钮区不该滚动）；
 * ② 去掉滚动条后只看得见前两个标签 —— 因为容器是 `repeat(2, max-content)` 的**两列网格**，
 *    五个标签被排成三行，而容器高度只有 38px 且 `overflow: hidden`，多出来的行直接被裁掉。
 *
 * jsdom 不做布局，所以用 CSS 契约把"标签行必须一行放完"锁住：
 * 容器必须是 `flex + nowrap`，不能再是固定列数的网格。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
/** 去掉注释再断言：注释里会解释"曾经是 repeat(2, …) 网格"，那不算违规（踩过一次的坑） */
const CSS = readFileSync(join(ROOT, "src", "styles", "codem-ui.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBlock(selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[\\s\\S]*?\\n\\}`).exec(CSS);
  return m?.[0] ?? "";
}

describe("PanelSidebar — 标签行布局契约（第 50 波）", () => {
  it("PANEL-TAB-1: 标签容器是一行排开的 flex（不再是两列网格），且不换行", () => {
    const block = ruleBlock(".panel-sidebar-tabs");
    expect(block, "应能定位 .panel-sidebar-tabs 规则").toBeTruthy();
    expect(block).toMatch(/display:\s*flex;/);
    expect(block).toMatch(/flex-wrap:\s*nowrap;/);
    // 关键回归点：固定两列的网格会把 5 个标签排成三行（高度 38px + overflow: hidden = 只看到前两个）
    expect(block, "不应再是固定列数的网格").not.toMatch(/grid-template-columns/);
    expect(block).toMatch(/overflow:\s*hidden;/);
  });

  it("PANEL-TAB-2: 标签按钮可压缩到省略号，关闭按钮不被压缩", () => {
    const tab = ruleBlock(".panel-sidebar-tab");
    expect(tab).toMatch(/flex-shrink:\s*1;/);
    expect(tab).toMatch(/min-width:\s*0;/);
    expect(ruleBlock(".panel-sidebar-tab-label")).toMatch(/text-overflow:\s*ellipsis;/);
    expect(ruleBlock(".panel-sidebar-close")).toMatch(/flex-shrink:\s*0;/);
  });

  it("PANEL-TAB-3: 面板宽度用令牌给出，且宽到能容下五个标签 + 关闭按钮", () => {
    const styles = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    const token = /--panel-sidebar-width:\s*(\d+)px/.exec(styles);
    expect(token, "应有 --panel-sidebar-width 令牌").toBeTruthy();
    expect(Number(token![1]), "五个标签 + 关闭按钮需要足够宽度（≥ 480px）").toBeGreaterThanOrEqual(480);
    const panel = readFileSync(join(ROOT, "src", "components", "PanelSidebar.tsx"), "utf8");
    expect(panel, "组件应使用该令牌而不是写死宽度").toContain("var(--panel-sidebar-width");
  });
});
