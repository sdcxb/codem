/**
 * 终版：Dream 皮肤里已无「写死字面色」的语义缺口。
 *
 * 判据：
 * | # | 行为 |
 * |---|---|
 * | DREAM-TOK-4 | 重算「所有档位都写死字面色」的缺口集合，除 `--skin-preview-hub-accent`（Hub 皮肤预览色块，**不该**在 dream 作用域覆盖）外必须为空 |
 * | DREAM-TOK-5 | 第二批 13 个令牌都定义了，且取值引用 dream 动态令牌 |
 *
 * 变异自证：删掉 `--dropdown-hover` ⇒ DREAM-TOK-5 红；把它改成 `rgb(31 31 30 / 7%)` ⇒ DREAM-TOK-4 红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const base = readFileSync(join(ROOT, "src/styles.css"), "utf8");
const dream = readFileSync(join(ROOT, "src/styles/skin-dream.css"), "utf8");
const themeManager = readFileSync(join(ROOT, "src/core/theme/theme-manager.ts"), "utf8");

/** 允许剩余的唯一"缺口"（描述其它皮肤的预览色） */
const ALLOWED = ["--skin-preview-hub-accent"];

const SECOND_BATCH = [
  "--dropdown-hover",
  "--surface-pressed",
  "--field-border-hover",
  "--tooltip-border",
  "--tooltip-bg",
  "--tooltip-text",
  "--error-hover",
  "--surface-content",
  "--surface-opaque-raised",
  "--surface-glass-raised",
  "--shadow-inner-highlight",
  "--terminal-bg",
  "--window-close-bg",
];

function dreamValues(token: string): string[] {
  const re = new RegExp(`^\\s*${token}:\\s*([^;]+);`, "gm");
  return [...dream.matchAll(re)].map((m) => m[1].trim());
}

function literalGaps(): string[] {
  const inDream = new Set([...dream.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  const injected = new Set([...themeManager.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]));

  const defaults = new Map<string, string[]>();
  for (const m of base.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    const list = defaults.get(m[1]) ?? [];
    list.push(m[2].trim());
    defaults.set(m[1], list);
  }
  const used = new Set([...base.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));

  const colorish = /bg|background|text|border|accent|color|shadow|surface|panel|sidebar|chat|scene|tooltip|hover|muted|ink|paper|glass|hairline|caret|ring|row|chrome|veil|bubble|status|error|warning|success|dropdown|input/;
  const structural = /^--(space|fs|radius|weight|font|z|blur|opacity|duration|transition|line|size|height|width|gap|pad|top|anim)/;
  const literal = (v: string) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(v) && !/var\(/.test(v);

  const gaps: string[] = [];
  for (const tok of used) {
    if (inDream.has(tok) || injected.has(tok)) continue;
    if (!colorish.test(tok) || structural.test(tok)) continue;
    const vals = defaults.get(tok) ?? [];
    if (vals.length === 0) continue;
    if (vals.every(literal)) gaps.push(tok);
  }
  return gaps.filter((t) => !ALLOWED.includes(t));
}

describe("Dream 皮肤：写死缺口已清零", () => {
  it("DREAM-TOK-4: 除 Hub 预览色外，没有剩余「所有档位都写死」的语义缺口", () => {
    const gaps = literalGaps();
    expect(gaps, `这些令牌在 dream 下仍会停在默认浅色板：${gaps.join(", ")}`).toEqual([]);
  });

  it("DREAM-TOK-5: 第二批 13 个令牌都定义且绑 dream 动态令牌", () => {
    for (const tok of SECOND_BATCH) {
      const vals = dreamValues(tok);
      expect(vals.length, `${tok} 没有定义`).toBeGreaterThan(0);
      for (const v of vals) {
        expect(/var\(--dream-|var\(--error/.test(v), `${tok} 没绑动态令牌：${v}`).toBe(true);
      }
    }
  });
});
