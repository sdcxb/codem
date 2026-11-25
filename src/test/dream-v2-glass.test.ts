/** Dream × v2：透明度/模糊滑杆必须真的落到 v2 表面令牌与 backdrop-filter 上。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const dream = fs.readFileSync("src/styles/skin-dream.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const v2 = fs.readFileSync("src/styles/unslop-v2.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("Dream × v2 玻璃", () => {
  it("v2 表面令牌重新绑定 dream 的 alpha 变量，滑杆才会生效", () => {
    const block = dream.match(/:root\[data-ui="v2"\]\[data-skin="dream"\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(block).toContain("--ui-surface: var(--dream-bg-card");
    expect(block).toContain("--ui-surface-raised: var(--dream-bg-panel");
    expect(block).toContain("--ui-sidebar: var(--dream-bg-card");
    expect(block).toContain("--ui-bg: transparent");
    expect(block).toContain("--ui-text: var(--dream-text-main");
  });

  it("v2 的 backdrop-filter:none 在 dream 下有更高特异性的 blur 反制", () => {
    const block = v2.match(/\[data-ui="v2"\]\[data-skin="dream"\] :is\([\s\S]*?\{[\s\S]*?\}/)?.[0] ?? "";
    expect(block).toContain("backdrop-filter: blur(var(--dream-blur-px");
    expect(block).toContain("-webkit-backdrop-filter: blur(var(--dream-blur-px");
    expect(block).toContain("!important");
    expect(block).toContain(".task-center-panel");
  });

  it("管理面卡片也吃同一份 alpha + blur", () => {
    expect(v2).toMatch(/\[data-ui="v2"\]\[data-skin="dream"\] :is\([\s\S]*?\.lo-card[\s\S]*?backdrop-filter:\s*blur\(/);
    expect(v2).toContain('[class*="card"]');
  });
});
