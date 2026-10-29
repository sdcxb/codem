/**
 * Dream 皮肤语义令牌（第 233 轮 D4 第二步）。
 *
 * ## 背景
 *
 * 复审把「缺口」分成两类（见 `docs/audit/dream-skin-token-gap.md`）：
 * - **自适应**（35 个）：默认值已是 `color-mix(… var(--accent) …)`，dream 覆盖 `--accent` 后自动跟随；
 * - **写死字面色**（28 个）：dream 不定义就永远停在默认浅色板，这才是真缺口。
 *
 * 本轮补了其中使用次数最高的 8 个。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | DREAM-TOK-1 | 8 个写死缺口在 dream 里都有定义 |
 * | DREAM-TOK-2 | 它们绑 `--dream-accent` / `--dream-text-main` 或 `--dream-c*`，不是写死的新色值 |
 * | DREAM-TOK-3（反向对照） | **自适应令牌不许在 dream 里重复定义**（重复定义会冻住「跟随强调色」） |
 *
 * 变异自证：删掉 `--accent-strong` ⇒ DREAM-TOK-1 红；把 `--accent-strong` 改成 `#5b46cf` ⇒ DREAM-TOK-2 红；
 * 把 `--accent-surface` 抄进 dream ⇒ DREAM-TOK-3 红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const dream = readFileSync(join(ROOT, "src/styles/skin-dream.css"), "utf8");
const base = readFileSync(join(ROOT, "src/styles.css"), "utf8");

/** 取 dream 文件里某个令牌的「全部定义值」 */
function values(token: string): string[] {
  const re = new RegExp(`^\\s*${token}:\\s*([^;]+);`, "gm");
  return [...dream.matchAll(re)].map((m) => m[1].trim());
}

const FILLED = [
  "--accent-strong",
  "--reasoning-accent",
  "--text-base",
  "--border-strong",
  "--shadow-color",
  "--shadow-color-soft",
  "--text-on-status",
  "--text-ramp-paper",
];

/** 这些令牌的默认值已经是 color-mix(… var(--accent)/var(--text-base) …)，dream 不许再定义 */
const ADAPTIVE = [
  "--accent-surface",
  "--accent-border",
  "--accent-border-strong",
  "--error-surface",
  "--error-border",
  "--focus-ring-color",
  "--hairline-ink",
];

describe("Dream 皮肤语义令牌", () => {
  it("DREAM-TOK-1: 8 个写死缺口在 dream 里都有定义", () => {
    for (const tok of FILLED) {
      expect(values(tok).length, `${tok} 在 skin-dream.css 里没有定义`).toBeGreaterThan(0);
    }
  });

  it("DREAM-TOK-2: 取值绑 dream 的动态令牌，不是新写死的色值", () => {
    for (const tok of FILLED) {
      const vals = values(tok);
      expect(vals.length).toBeGreaterThan(0);
      for (const v of vals) {
        expect(
          /var\(--dream-(accent|text-main|c\d+)/.test(v),
          `${tok} 的值没有绑 dream 动态令牌：${v}`,
        ).toBe(true);
      }
    }
  });

  it("DREAM-TOK-3（反向对照）: 自适应令牌不许在 dream 里重复定义", () => {
    for (const tok of ADAPTIVE) {
      // 只允许出现在 color-mix 之外的"默认值"里？这里要求：dream 文件里不得有它的定义
      expect(values(tok).length, `${tok} 是自适应令牌，重复定义会冻住「跟随强调色」`).toBe(0);
      // 反向对照的前提：它确实在默认样式里有 color-mix 派生定义
      const re = new RegExp(`^\\s*${tok}:\\s*([^;]+);`, "gm");
      const defaults = [...base.matchAll(re)].map((m) => m[1].trim());
      expect(defaults.some((v) => /color-mix\(|var\(--(accent|text-base|error)/.test(v)), `${tok} 在默认样式里应已是派生值`).toBe(
        true,
      );
    }
  });
});
