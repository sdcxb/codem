/**
 * 记忆面板「按钮全挤在右上角」布局回归（组件层）+ 根因判据。
 *
 * ## 用户报的缺陷
 * 「记忆系统弹出面板的按钮有问题，都挤到右上角了」
 *
 * ## 真机取证（`.preview-shot/audit-memory-layout-05-before.json`，VP 1200×727）
 * 面板容器 `.memory-manager` = x∈[121, 1079] × y∈[73.7, 653.3]（958 × 579.6）。
 * 6 个按钮（+ 新增 / JSON / MD / 导入 / 整合 / 关闭）只落在**两个** x 值上
 * （936.65 与 1004.99），联合包围盒 = **126.35 × 98.67**（面板宽度的 13.19%、高度的 17.02%），
 * 贴在标题栏右端；标题栏 `.memory-manager-header` 因此被撑到 **123.67px** 高
 * （标题 `.memory-manager-title` 自身只有 21px）。修复后同一量法：
 * 联合包围盒 = **327.02 × 28**（一行放完），标题栏回落到 **53px**。
 *
 * ## 根因（已定位到行）
 * `src/styles.css` 的 `.memory-manager-actions` 被第 36-37 波「grid 对齐原语铺到重复行（225 处）」
 * 批量改写成了 `display: grid; grid-template-columns: repeat(2, max-content)` ——
 * **两列网格是给叶子节点（图标 + 文字）用的，套到按钮组容器上就变了味**：
 * 该组现有 6 个孩子，只有 2 条列轨道 ⇒ 自动排布折成 3 行；而 grid 容器的固有宽度
 * 只等于两条轨道之和（60.34 + 58.01 ≈ 126px），于是整组缩成一个小方块挂在右端。
 * 同一个坑第 50 波在 `codem-ui.css` 的 `.panel-sidebar-tabs` 上已经踩过一次
 * （当时 5 个 tab 折成 3 行后被 `overflow: hidden` 裁掉，只剩 2 个可见）。
 *
 * ## 为什么这条测试只能"退化为结构与声明断言"（**这是弱判据，必须知道**）
 * vitest 跑的是 happy-dom，**happy-dom 没有布局引擎**：实测
 * `document.querySelector('.memory-manager').getBoundingClientRect()` 返回
 * `{x:0,y:0,width:0,height:0,...}`，6 个按钮的 rect 宽度也全是 0；连
 * `getComputedStyle(actions).display` 都只是初始值 `"block"`（样式表根本没参与计算）。
 * 因此**无法**在单测里断言"按钮落在容器内部且彼此不重叠"。
 * 本文件用两条替代判据把根因锁死：
 *   ① 结构判据：按钮组必须是标题栏的直接孩子、且直接持有全部可交互控件，并且**没有**内联定位
 *      （`position: absolute` 找不到 `relative` 祖先 = 另一类"挤到角落"成因）；
 *   ② 声明判据：`.memory-manager-actions` 的**列轨道数必须 ≥ 实际子元素数**——
 *      这正是原缺陷的充要条件（旧 CSS `repeat(2, …)` 对 6 个孩子必然折行）。
 * 几何判据留在真机脚本 `.preview-shot/audit-memory-layout-05-verify.mjs`（同一套量法，改前/改后对照），
 * 出包后必须重跑一次才算真机验证。
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryManager } from "../components/MemoryManager";

const ROOT = join(__dirname, "..", "..");
const STYLES_PATH = join(ROOT, "src", "styles.css");
const STYLES = readFileSync(STYLES_PATH, "utf8");

afterEach(() => cleanup());

/** 取某选择器的**顶层**规则体（选择器必须独占一行开头，避免命中 `.x .y` 里的子串）。 */
function ruleBody(css: string, selector: string): string | null {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`, "m");
  const m = css.match(re);
  return m ? m[2] : null;
}

/** 把规则体拆成 声明名 → 值（值里可能含括号，但本用例的值都很简单）。 */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(";")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (!name) continue;
    out[name] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * 数 `grid-template-columns` 的**列轨道条数**。
 * `none`/空 ⇒ null（不是网格）；`repeat(N, …)` ⇒ N；否则按顶层空白切分 token。
 */
function columnTrackCount(value: string | undefined): number | null {
  const v = (value ?? "").trim();
  if (!v || v === "none") return null;
  const repeat = v.match(/^repeat\(\s*(\d+)\s*,/);
  if (repeat) return Number(repeat[1]);
  let depth = 0;
  let tracks = 0;
  let inToken = false;
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    const isSep = /\s/.test(ch) && depth === 0;
    if (isSep) { inToken = false; continue; }
    if (!inToken) { inToken = true; tracks++; }
  }
  return tracks;
}

const INTERACTIVE_SELECTOR = ".memory-action-btn, .memory-manager-close";

describe("记忆面板布局回归：按钮组必须一行排开、落在标题栏里", () => {
  it("结构：标题栏直接持有「标题 + 按钮组」，按钮组又直接持有全部可交互控件（DOM 顺序 = 视觉顺序）", () => {
    render(<MemoryManager onClose={() => {}} />);

    const header = document.querySelector(".memory-manager-header");
    const actions = document.querySelector(".memory-manager-actions");
    expect(header, "缺少 .memory-manager-header").not.toBeNull();
    expect(actions, "缺少 .memory-manager-actions").not.toBeNull();
    expect(actions!.parentElement, "按钮组必须直接挂在标题栏下（不能另起浮层）").toBe(header);

    // 标题 + 按钮组 = 标题栏的全部孩子；顺序上标题在前、按钮组在后
    const structural = Array.from(header!.children).filter(
      (c) => c.classList.contains("memory-manager-title") || c.classList.contains("memory-manager-actions"),
    );
    expect(structural.map((c) => c.className)).toEqual([
      "memory-manager-title",
      "memory-manager-actions",
    ]);

    // 全部可交互控件都必须是按钮组的**直接孩子**（历史缺陷是它们被折成多行、挤成一团）
    const buttons = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    expect(buttons.length, "记忆面板应渲染 5 个动作按钮 + 1 个关闭按钮").toBe(6);
    for (const b of buttons) {
      expect(b.parentElement, `${b.className} 的父节点应是按钮组`).toBe(actions);
    }
    // DOM 顺序即视觉顺序：关闭按钮永远在最后一个
    expect(buttons[buttons.length - 1].classList.contains("memory-manager-close")).toBe(true);
  });

  it("没有内联绝对定位（`absolute` 找不到 `relative` 祖先 = 另一类「挤到角落」成因）", () => {
    render(<MemoryManager onClose={() => {}} />);
    const nodes = [
      document.querySelector(".memory-manager")!,
      document.querySelector(".memory-manager-header")!,
      document.querySelector(".memory-manager-actions")!,
      ...Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)),
    ];
    for (const el of nodes) {
      const inline = (el as HTMLElement).getAttribute("style") ?? "";
      expect(inline, `${el.className} 不应带内联样式（含定位）`).not.toMatch(/position\s*:\s*(absolute|fixed)/);
    }
  });

  it("声明：`.memory-manager-actions` 走不换行的一行布局，且列轨道数 ≥ 子元素数（旧 CSS 在此必红）", () => {
    render(<MemoryManager onClose={() => {}} />);
    const childCount = document.querySelectorAll(`${INTERACTIVE_SELECTOR}`).length;

    const body = ruleBody(STYLES, ".memory-manager-actions");
    expect(body, `styles.css 里找不到 .memory-manager-actions 规则`).toBeTruthy();
    const d = declarations(body!);

    // 一行放完：不换行的 flex（与 codem-ui.css 第 50 波 .panel-sidebar-tabs 同款结论）
    expect(d.display, ".memory-manager-actions 应是 flex").toBe("flex");
    expect(d["flex-wrap"], ".memory-manager-actions 必须显式不换行").toBe("nowrap");

    // 根因判据：只要它是网格，列轨道就必须够铺下所有孩子 —— 否则自动排布必然折行
    const tracks = columnTrackCount(d["grid-template-columns"]);
    if (tracks !== null) {
      expect(
        tracks,
        `.memory-manager-actions 有 ${childCount} 个子元素，但只有 ${tracks} 条列轨道 ⇒ 会折成 ${Math.ceil(childCount / tracks)} 行并缩成一个小方块（这正是用户看到的"挤到右上角"）`,
      ).toBeGreaterThanOrEqual(childCount);
    }
  });

  it("声明：标题栏自身不裁剪按钮组（不重演第 50 波 overflow:hidden 裁掉溢出按钮的事故）", () => {
    const body = ruleBody(STYLES, ".memory-manager-header");
    expect(body, "styles.css 里找不到 .memory-manager-header 规则").toBeTruthy();
    const d = declarations(body!);
    expect(d.display, ".memory-manager-header 应是 flex（标题左、按钮组右）").toBe("flex");
    expect(d["justify-content"], "标题与按钮组应两端对齐").toBe("space-between");
    // 若哪天为了"补右端"给它加 overflow:hidden + 固定高度，多出来的按钮会被静默裁掉
    if (d.overflow === "hidden") {
      expect(d.height, "overflow:hidden 时必须显式给足高度，否则按钮组会被裁掉").not.toBeUndefined();
    }
  });

  it("诚实标注：happy-dom 无布局引擎，几何判据（按钮组在容器内、彼此不重叠）只能由真机脚本承担", () => {
    render(<MemoryManager onClose={() => {}} />);
    const mm = document.querySelector(".memory-manager")!.getBoundingClientRect();
    const btn = document.querySelector(INTERACTIVE_SELECTOR)!.getBoundingClientRect();
    // 本条不是"布局正确"的断言，而是把"单测量不到布局"这件事钉成事实：
    // 一旦哪天换成带布局引擎的环境，这里会红，提醒把几何断言补回来。
    const allZero = (r: DOMRect) => r.width === 0 && r.height === 0 && r.x === 0 && r.y === 0;
    expect(
      allZero(mm) && allZero(btn),
      "happy-dom 现在给出了真实 rect —— 请把 audit-memory-layout-05-verify.mjs 里的几何断言（按钮组落在面板容器内 / 彼此不重叠 / 标题栏高度不为 0）上移到本文件",
    ).toBe(true);
  });
});
