/**
 * SCROLLBTN —— **"返回最新聊天"圆圈按钮的位置不许随未读标签跳动**（第 191 轮）。
 *
 * 用户原话：「对话中，返回最新聊天的圆圈按钮位置好像不对，检查一下。」
 *
 * ## 实测到的形态：同一颗按钮，两个位置（差 26px）
 *
 * `_probe-191-scrollbtn-states.mjs` 两种状态各量一次（装机版）：
 * ```
 *   无未读（只有按钮）      ：按钮 y=484..512   按钮下沿到输入区 80px
 *   有未读（按钮 + 下方标签）：按钮 y=458..486   按钮下沿到输入区 107px
 * ```
 * 成因：包装层是 `flex-direction: column` 且 `bottom: 80px` 锚的是**整块的下边**，
 * 而"新消息"标签渲染在按钮**下面** ⇒ 标签一出现就把按钮**往上顶**。
 * 滚动过程中未读态来回切换，按钮就上下跳 —— 这就是"位置好像不对"。
 *
 * 修法：**锚点必须是按钮本身** —— 包装层的高度等于按钮高度（箭头节点不能再被兄弟元素撑高），
 * 标签改成 `position: absolute` 挂在按钮下方（脱离文档流，不影响任何布局）。
 *
 * ## 判据（三条，对应"锚点成立"的三个必要条件）
 * - SCROLLBTN-1：包装层**不许有 `gap`**（flex 列里 gap 会把按钮从底边顶开）；
 * - SCROLLBTN-2：标签**必须 `position: absolute`**（在文档流里就会顶按钮）；
 * - SCROLLBTN-3：标签**必须 `pointer-events: none`**（它只是说明文字，不该吃掉消息区的点击）。
 *
 * ⚠️ 判据只能守"结构没退回"，守不了"像素位置对"——位置由 `_probe-191-scrollbtn-states.mjs`
 * 在装机版上量（本文件头注释里记了修复前后的两组读数，回归时与它对照）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

const bodyOf = (sel: string) => new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";

describe("SCROLLBTN：返回最新聊天按钮的位置稳定性（第 191 轮）", () => {
  it("SCROLLBTN-1：包装层不许有 flex gap（它会把按钮从 bottom 锚点上顶开）", () => {
    const wrap = bodyOf(".scroll-to-bottom-wrapper");
    expect(wrap, "找不到 .scroll-to-bottom-wrapper").not.toBe("");
    expect(
      /(?:^|;)\s*gap\s*:/.test(wrap),
      "包装层又写上了 gap —— 它是 flex 列，gap 会让按钮与'整块下边'分离；" +
        `一旦再多一个子元素（未读标签），按钮就被顶上去（实测 26px）。实际规则体：${wrap.trim()}`,
    ).toBe(false);
    /* 锚点本身必须还在（bottom 是"按底边定位"的来源） */
    expect(/(?:^|;)\s*bottom\s*:/.test(wrap), "包装层必须保留 bottom 锚点").toBe(true);
  });

  it("SCROLLBTN-2：未读标签必须脱离文档流（在流里就会顶动按钮）", () => {
    const label = bodyOf(".unread-label");
    expect(label, "找不到 .unread-label").not.toBe("");
    expect(
      /(?:^|;)\s*position\s*:\s*absolute/.test(label),
      "未读标签必须是 `position: absolute` —— 它原来在 flex 列里当第二个子元素，" +
        `一出现就把按钮往上顶 26px（用户看到的就是"位置不对"）。实际规则体：${label.trim()}`,
    ).toBe(true);
  });

  it("SCROLLBTN-3：未读标签不许吃掉点击（它只是说明文字）", () => {
    const label = bodyOf(".unread-label");
    expect(
      /(?:^|;)\s*pointer-events\s*:\s*none/.test(label),
      `未读标签要挂 pointer-events: none（否则它会挡住它下面那块消息区的点击）。实际规则体：${label.trim()}`,
    ).toBe(true);
  });

  it("SCROLLBTN-4：按钮本身仍然是一个 28×28 的圆（别在改布局时把尺寸带坏）", () => {
    const btn = bodyOf(".scroll-to-bottom-btn");
    expect(/(?:^|;)\s*width\s*:\s*28px/.test(btn), "按钮宽度应为 28px").toBe(true);
    expect(/(?:^|;)\s*height\s*:\s*28px/.test(btn), "按钮高度应为 28px").toBe(true);
    expect(/(?:^|;)\s*border-radius\s*:\s*var\(--radius-full\)/.test(btn), "按钮应当是圆形（--radius-full）").toBe(true);
  });
});
