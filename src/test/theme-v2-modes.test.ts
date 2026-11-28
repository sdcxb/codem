/** v2 × 皮肤/模式：Hub 品牌色、高对比、减少透明度必须穿透 v2 桥接层。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const hub = fs.readFileSync("src/styles/skin-hub.css", "utf8");
const tokens = fs.readFileSync("src/core/theme/unslop-tokens.css", "utf8");
const v2 = fs.readFileSync("src/styles/unslop-v2.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("v2 × 皮肤/模式矩阵", () => {
  it("Hub 在 v2 下保留橙色品牌与自己的表面色", () => {
    const block = hub.match(/:root\[data-ui="v2"\]\[data-skin="hub"\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(block).toContain("--ui-accent: var(--hub-color-primary");
    expect(block).toContain("--ui-accent-text: var(--hub-color-primary");
    expect(block).toContain("--ui-surface: var(--hub-bg-card");
    expect(block).toContain("--ui-text: var(--hub-text-main");
    expect(block).toContain("--ui-danger: var(--hub-status-danger");
  });

  it("默认亮色是中性纸面、琥珀主操作与文字 accent，且没有紫色 chrome", () => {
    const tokens = fs.readFileSync("src/core/theme/unslop-tokens.css", "utf8");
    const light = tokens.match(/:root\[data-ui="v2"\]\[data-theme="light"\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(light).toContain("--ui-bg: #f4f4f2");
    expect(light).toContain("--ui-surface: #ffffff");
    expect(light).toContain("--ui-accent: #b7791f");
    expect(light).toContain("--ui-accent-text: #6d5423");
    expect(light).toContain("--ui-primary: #b7791f");
    expect(light, "unslop：默认亮色不允许紫色 chrome").not.toMatch(/#6555e0|#7c6cf0|#6c5ce7/i);
  });

  it("高对比在 v2 下直接改 ui 文本/线条，而不是被桥接层盖掉", () => {
    const block = tokens.match(/:root\[data-ui="v2"\]\[data-contrast="high"\][\s\S]*?\}/)?.[0] ?? "";
    expect(block).toContain("--ui-text-secondary");
    expect(block).toContain("--ui-line:");
    expect(block).toContain("--focus-ring-color: var(--ui-accent-text)");
  });

  it("紧凑密度会改 v2 控件高度，而不是只改旧控件令牌", () => {
    expect(v2).toMatch(/\[data-ui="v2"\]\[data-density="compact"\][\s\S]*?height:\s*var\(--control-xs\)\s*!important/);
    expect(v2).toContain("--control-xs");
  });

  it("减少透明度/高对比媒体查询会关掉梦幻玻璃", () => {
    expect(v2).toMatch(/@media[^{]*prefers-reduced-transparency[^{]*\{[\s\S]*?\[data-ui="v2"\]\[data-skin="dream"\][\s\S]*?backdrop-filter:\s*none\s*!important/);
  });
});
