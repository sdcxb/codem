/** 可识别性：设置底栏的次操作必须是「看起来能点」的按钮，而不是一行灰字。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync("src/styles/unslop-v2.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tsx = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");

describe("按钮可识别性", () => {
  it("底栏次操作有边框、底色、内边距和最小高度", () => {
    const block = css.match(/\.settings-panel \.settings-footer \.settings-footer-action\.settings-footer-action--secondary\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("border: 1px solid var(--ui-line-strong)");
    expect(block).toContain("background: var(--ui-surface)");
    expect(block).toContain("height: 28px");
    expect(block).toContain("padding: 0 var(--space-4)");
  });

  it("设置里的次级按钮统一有可见外框", () => {
    const block = css.match(/\.settings-panel \.sp-btn--secondary\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("border: 1px solid var(--ui-line-strong)");
    expect(block).toContain("background: var(--ui-surface)");
  });

  it("模型行的「配置方案」附加动作有独立底色与外框", () => {
    const block = css.match(/\.settings-panel \.settings-model-profiles \.sp-btn\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("border: 1px solid var(--ui-line-strong)");
    expect(block).toContain("background: var(--ui-surface-active)");
  });

  it("底栏次操作复用 sp-btn 按钮类，不再只渲染文字", () => {
    const buttons = tsx.match(/className="settings-footer-action settings-footer-action--secondary[^"]*"/g) ?? [];
    expect(buttons.length).toBe(2);
    for (const cls of buttons) {
      expect(cls).toContain("sp-btn");
      expect(cls).toContain("sp-btn--secondary");
    }
  });
});
