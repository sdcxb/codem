/** v2 表面预算：管理面不再用旧装饰（渐变/glow/玻璃/uppercase）。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync("src/styles/unslop-v2.css", "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

describe("v2 表面预算", () => {
  const clean = stripComments(css);
  it("chrome 不引入彩色渐变 / glow / 玻璃", () => {
    expect(clean).not.toMatch(/radial-gradient\(/);
    expect(clean).not.toMatch(/linear-gradient\(/);
    expect(clean).not.toMatch(/--shadow-glow/);
    expect(clean).not.toMatch(/backdrop-filter:\s*(?!none)[a-z]/);
  });

  it("管理面不再用 uppercase 标签", () => {
    expect(clean).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("设置层级：section 不大于 page title", () => {
    expect(clean).toMatch(/\.settings-section-title\s*\{[^}]*font-size:\s*var\(--fs-lg\)/);
    expect(clean).toMatch(/\.settings-title\s*\{[^}]*font-size:\s*var\(--fs-xl\)/);
  });

  it("开关打开态不再用 accent 铺满", () => {
    expect(clean).toMatch(/\.switch-root\[data-state="checked"\]\s*\{[^}]*background:\s*var\(--ui-text-secondary\)/);
  });
});
