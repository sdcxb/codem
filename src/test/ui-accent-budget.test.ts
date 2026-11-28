/** unslop 收口：accent 预算。每屏只保留主操作/当前选择的 accent，装饰色不得再用金。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync("src/styles/unslop-v2.css", "utf8");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("v2 accent 预算", () => {
  it("accent 声明总数不超过 15（当前只剩主操作/选择/进度）", () => {
    const count = (clean.match(/var\(--ui-accent\)/g) ?? []).length;
    expect(count, `accent 仍有 ${count} 处，新增装饰性用色请改中性令牌`).toBeLessThanOrEqual(15);
  });

  it("装饰性选择器不再直接消费 accent", () => {
    const forbidden = [
      /\.sidebar-task-count[^{}]*\{[^}]*var\(--ui-accent\)/,
      /\.agent-badge[^{}]*\{[^}]*var\(--ui-accent\)/,
      /\.chat-header-action\.active[^{}]*\{[^}]*var\(--ui-accent\)/,
      /\.quote-context-card[^{}]*\{[^}]*var\(--ui-accent\)/,
      /\.toast-item[^{}]*\{[^}]*var\(--ui-accent\)/,
      /\.memory-notice[^{}]*\{[^}]*var\(--ui-accent\)/,
    ];
    for (const pattern of forbidden) expect(clean, pattern.source).not.toMatch(pattern);
  });

  it("主操作/当前选择仍保留品牌色（主操作可走填充令牌）", () => {
    expect(clean).toMatch(/\.send-btn\s*\{[^}]*var\(--ui-(?:primary|accent)\)/);
    expect(clean).toMatch(/\.settings-panel[^{}]*\.save-btn[^{}]*\{[^}]*var\(--ui-(?:primary|accent)\)/);
  });
});
