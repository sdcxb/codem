/**
 * 三套皮肤的**对比度门禁**（第 96 轮）。
 *
 * ## 为什么是这一条
 *
 * 覆盖率盘点发现 `src/core/theme/contrast-checker.ts`（139 行，WCAG 2.1 对比度计算）
 * **行覆盖 0%，而且没有任何调用方** —— 它只在 `src/core/theme/index.ts` 被 re-export，
 * 而它自己的文件头写着"用于验证三套皮肤（default / hub / dream）的颜色配对是否满足无障碍标准"。
 * 也就是说：**这个能力写了、但从来没被用过**。
 *
 * 这一轮把它变成**真在用的门禁**：直接读 `src/styles.css` 里三套主题的变量，
 * 用被测实现算对比度，卡住无障碍线。
 *
 * ## 实测（写门禁时的第一次测量，2026-09-24）
 *
 * | 配对 | dark | light | 要求 |
 * | --- | ---: | ---: | --- |
 * | `--text-primary` on `--bg-primary` | 12.95:1 | 16.50:1 | ≥ 7.0（AAA） |
 * | `--text-primary` on `--bg-secondary` | 11.55:1 | 15.79:1 | ≥ 7.0（AAA） |
 * | `--text-secondary` on `--bg-primary` | 8.85:1 | 7.37:1 | ≥ 7.0（AAA） |
 * | `--text-secondary` on `--bg-secondary` | 7.89:1 | 7.06:1 | ≥ 7.0（AAA） |
 * | `--text-muted` on `--bg-primary` | 5.42:1 | 5.25:1 | ≥ 4.5（AA） |
 *
 * ⚠️ `hub` / `dream` 皮肤**不覆盖**文字与底色变量（实测 0 个相关变量）⇒ 它们继承 dark/light 的值，
 * 所以这门禁同时也锁住了这两套皮肤（改皮肤时如果换了底色，这里会红）。
 *
 * 判据：
 * - CT-1：三套主题块必须都在（`[data-theme="light"]` / `[data-theme="dark"]`，且都能取到那 5 个变量）；
 * - CT-2：上表的对比度要求；
 * - CT-3：`hub` / `dream` 若不覆盖文字/底色变量，必须**明确记录**"继承"（避免下次误以为"皮肤没测"）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateContrast, formatRatio } from "../core/theme/contrast-checker";

const ROOT = join(__dirname, "..", "..");
const CSS = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

/** 取某个选择器块的**本层**自定义属性（花括号配平；嵌套块里的同名变量不算） */
function varsOf(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector);
  if (at < 0) return {};
  const open = CSS.indexOf("{", at);
  if (open < 0) return {};
  let depth = 0;
  let end = -1;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return {};
  const body = CSS.slice(open + 1, end);
  let layer = "";
  let d = 0;
  for (const ch of body) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
    else if (d === 0) layer += ch;
  }
  const out: Record<string, string> = {};
  for (const m of layer.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

const dark = varsOf('[data-theme="dark"]');
const light = varsOf('[data-theme="light"]');
const hub = varsOf('[data-skin="hub"]');
const dream = varsOf('[data-skin="dream"]');

/** 需要卡住的配对：[前景变量, 背景变量, 最低对比度, 等级说明] */
const PAIRS: Array<[string, string, number, string]> = [
  ["text-primary", "bg-primary", 7.0, "AAA"],
  ["text-primary", "bg-secondary", 7.0, "AAA"],
  ["text-secondary", "bg-primary", 7.0, "AAA"],
  ["text-secondary", "bg-secondary", 7.0, "AAA"],
  ["text-muted", "bg-primary", 4.5, "AA"],
];

describe("三套皮肤的对比度门禁（第 96 轮）", () => {
  it("CT-1 两套主题块都在，且 5 个变量齐（改了名字/搬了文件必须立刻红）", () => {
    for (const [name, vars] of [["dark", dark], ["light", light]] as const) {
      expect(Object.keys(vars).length, `${name} 主题块没找到（[data-theme="${name}"]）`).toBeGreaterThan(20);
      for (const key of ["--text-primary", "--text-secondary", "--text-muted", "--bg-primary", "--bg-secondary"]) {
        expect(vars[key], `${name} 缺少 ${key}`).toBeTruthy();
      }
    }
  });

  it("CT-2 每个配对的对比度都达标（实测值打印在下面，改主题的人能直接看到差多少）", () => {
    for (const [name, vars] of [["dark", dark], ["light", light]] as const) {
      for (const [fg, bg, min, grade] of PAIRS) {
        const f = vars[`--${fg}`];
        const b = vars[`--${bg}`];
        /* 第 159 轮 P1-2：文字三档现在是**派生令牌**（`color-mix` 自 `--text-base`）⇒
           必须把这一档的变量表一起传进去，检查器才解析得出来（见 `parseColorValue` 的口径）。 */
        const r = evaluateContrast(f, b, vars);
        expect(r, `${name}: ${f} / ${b} 解析失败`).toBeTruthy();
        expect(
          r!.ratio,
          `${name}: ${fg}(${f}) on ${bg}(${b}) = ${formatRatio(r!.ratio)}，低于 ${grade} 要求的 ${min}:1`,
        ).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("CT-3 hub / dream 若不覆盖文字与底色变量，要明确是「继承」（不是「没测」）", () => {
    const keys = ["--text-primary", "--text-secondary", "--text-muted", "--bg-primary", "--bg-secondary"];
    const hubOverrides = keys.filter((k) => hub[k]);
    const dreamOverrides = keys.filter((k) => dream[k]);
    // 现状：两套皮肤都不覆盖这些变量 ⇒ 继承主题值，因此上面的 CT-2 对它们同样成立。
    // 一旦将来覆盖了，就必须在这里为它们单独加一条对比度判据（否则会出现"皮肤没人管"的盲区）。
    expect(
      hubOverrides.length === 0 && dreamOverrides.length === 0,
      `hub 覆盖了 ${hubOverrides.join(",") || "—"}；dream 覆盖了 ${dreamOverrides.join(",") || "—"} —— ` +
        "有覆盖就必须为这套皮肤单独加对比度判据（现在的 CT-2 只测了继承值）",
    ).toBe(true);
  });
});
