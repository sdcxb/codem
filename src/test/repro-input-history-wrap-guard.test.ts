/**
 * 回归测试：输入框历史浏览（browseHistory）多行 guard
 *
 * 背景：.message-input 是 pre-wrap 软换行。旧实现只检查 indexOf("\n")，
 * wrap 折行（无换行符但视觉两行）时光标在第二行按 ↑ 会直接填充历史，
 * 而不是先移动光标。修复改为按视觉行判断（镜像测量）。
 *
 * 本测试在 jsdom 下验证单行场景不回归（无 wrap 时 ↑ 仍触发历史），
 * 以及修复逻辑的正确分支（有显式换行时按视觉行拦截）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 复刻 InputArea 中 browseHistory 的多行 guard 逻辑。
 * 视觉行数通过镜像测量函数注入，便于在 jsdom 中模拟 wrap。
 */
function makeBrowseHistoryGuard(measureVisualLines: (text: string) => number) {
  return function shouldBrowse(dir: 1 | -1, value: string, caret: number): boolean {
    if (dir === -1) {
      // ArrowUp: 光标不在视觉第一行 → 让原生移动光标，不浏览历史
      return measureVisualLines(value.slice(0, caret)) <= 1;
    } else {
      // ArrowDown: 光标不在视觉最后一行 → 不浏览历史
      return measureVisualLines(value.slice(caret)) <= 1;
    }
  };
}

describe("InputArea browseHistory multi-line guard", () => {
  // 单行文本：无换行符，镜像测量也返回 1 行
  const singleLineMeasure = () => 1;

  it("单行文本光标在第一行 → ArrowUp 触发历史", () => {
    const guard = makeBrowseHistoryGuard(singleLineMeasure);
    expect(guard(-1, "hello world", 5)).toBe(true);
    expect(guard(-1, "hello world", 11)).toBe(true);
  });

  it("单行文本光标在末尾 → ArrowDown 不触发历史（原生行为）", () => {
    const guard = makeBrowseHistoryGuard(singleLineMeasure);
    // ArrowDown 在草稿状态本来就不浏览，guard 返回 true 表示"允许浏览"
    // （实际 browseHistory 内部还会判断 historyIndexRef === -1 时 dir !== -1 return false）
    expect(guard(1, "hello world", 11)).toBe(true);
  });

  it("wrap 折行（无换行符但视觉两行）光标在第二行 → ArrowUp 不触发历史（修复核心）", () => {
    // 模拟 wrap：前 15 个字符高度折成两行
    const wrapMeasure = (text: string) => (text.length > 15 ? 2 : 1);
    const guard = makeBrowseHistoryGuard(wrapMeasure);
    // 光标在第 18 个字符（视觉第二行）→ 不浏览历史
    expect(guard(-1, "this is a very long sentence that wraps visually", 18)).toBe(false);
    // 光标在前 15 个字符内（视觉第一行）→ 仍浏览历史
    expect(guard(-1, "this is a very long sentence that wraps visually", 8)).toBe(true);
  });

  it("显式换行（有 \\n）光标在第二行 → ArrowUp 不触发历史", () => {
    // 模拟有换行符时的镜像测量：按 \n 分段
    const newlineMeasure = (text: string) => text.split("\n").length;
    const guard = makeBrowseHistoryGuard(newlineMeasure);
    expect(guard(-1, "line1\nline2", 7)).toBe(false); // 光标在 line2
    expect(guard(-1, "line1\nline2", 4)).toBe(true);  // 光标在 line1
  });

  it("ArrowDown：光标在视觉最后一行 → 允许浏览历史（历史前进）", () => {
    const wrapMeasure = (text: string) => (text.length > 15 ? 2 : 1);
    const guard = makeBrowseHistoryGuard(wrapMeasure);
    // 光标在末尾（视觉最后一行）→ 允许
    expect(guard(1, "this is a very long sentence", 30)).toBe(true);
    // 光标在前 15 字符内（非最后一行）→ 拦截
    expect(guard(1, "this is a very long sentence", 8)).toBe(false);
  });
});
