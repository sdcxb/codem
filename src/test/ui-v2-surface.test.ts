/** v2 表面预算：管理面不再用旧装饰（渐变/glow/玻璃/uppercase）。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync("src/styles/unslop-v2.css", "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

describe("v2 表面预算", () => {
  const clean = stripComments(css);
  it("chrome 不引入彩色渐变 / glow / 玻璃（Dream 皮肤唯一例外）", () => {
    /* Dream 的壁纸画在 webview 内部，必须有 CSS 毛玻璃；只放行同时带
       [data-ui=v2][data-skin=dream] 的规则，默认 v2 chrome 仍不许玻璃。 */
    const nonDream = clean.replace(/\[data-ui="v2"\]\[data-skin="dream"\][^{]*\{[^}]*\}/g, "");
    expect(nonDream).not.toMatch(/radial-gradient\(/);
    expect(nonDream).not.toMatch(/linear-gradient\(/);
    expect(nonDream).not.toMatch(/--shadow-glow/);
    expect(nonDream).not.toMatch(/backdrop-filter:\s*(?!none)[a-z]/);
    expect(clean).toMatch(/\[data-ui="v2"\]\[data-skin="dream"\][\s\S]*?backdrop-filter:\s*blur\(/);
  });

  it("管理面不再用 uppercase 标签", () => {
    expect(clean).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("设置层级：section 不大于 page title", () => {
    expect(clean).toMatch(/\.settings-section-title\s*\{[^}]*font-size:\s*var\(--fs-lg\)/);
    expect(clean).toMatch(/\.settings-title\s*\{[^}]*font-size:\s*var\(--fs-2xl\)/);
  });

  it("开关打开态不再用 accent 铺满", () => {
    expect(clean).toMatch(/\.switch-root\[data-state="checked"\]\s*\{[^}]*background:\s*var\(--ui-text-secondary\)/);
  });

  it("v2 阅读刻度不小于 12/14，且图标描边统一 1.5", () => {
    expect(clean).toMatch(/--fs-2xs:\s*calc\(12px/);
    expect(clean).toMatch(/--fs-base:\s*calc\(14px/);
    expect(clean).toMatch(/svg\.lucide\s*\{[^}]*stroke-width:\s*1\.5/);
  });

  it("顶部图标按钮不小于 32px 点击目标", () => {
    expect(clean).toMatch(/\.chat-header-action\s*\{[^}]*min-width:\s*32px/);
    expect(clean).toMatch(/\.chat-header-action\s*\{[^}]*height:\s*32px/);
  });
});
