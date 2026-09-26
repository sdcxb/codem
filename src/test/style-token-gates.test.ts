/**
 * 设计令牌两道新门禁的契约用例（第 155 轮 P0-1 / P0-4）。
 *
 * | # | 判据 | 为什么必须有 |
 * | --- | --- | --- |
 * | TOK-H1 | 同一作用域里重复定义几何令牌 → 红（**这就是真机那个 `--radius-xs` bug**） | 重复定义是"静默覆盖"，不报错不告警，只能靠门禁 |
 * | TOK-H2 | 皮肤只覆盖半个刻度家族 → 红 | 半套覆盖最难排查（一半是新值、一半是默认值） |
 * | TOK-H3 | 刻度非单调（xs > sm）→ 红 | 第 34 波踩过"命名与实际大小相反" |
 * | TOK-H4 | 几何令牌写成颜色/百分比 → 红 | 类型错位会静默失效 |
 * | TOK-OK | **本仓库真实文件 0 问题** | 防"门禁自己坏了却以为代码干净" |
 * | LIT-1~3 | 裸字面量算、`var(x, 兜底)` 不算、纯 `var(x)` 不算 | 口径踩过一次坑（负向断言 + `\s*` 把走令牌的也数进来） |
 * | LIT-4 | `border-radius`/`box-shadow` 必须进各自的族 | 踩过的第二个坑：颜色族分支 `continue` 把它们吃掉了 |
 * | LIT-5 | 棘轮：涨了要红、降了要提示收紧 | 棘轮的核心语义 |
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scanTokenHygiene, loadDefaultFiles as loadTokenFiles, SCALE_FAMILIES } from "../../tools/audit/scan-token-hygiene.mjs";
import { scanStyleLiterals, loadDefaultFiles as loadLiteralFiles, evaluateRatchet, readBaseline } from "../../tools/audit/scan-style-literals.mjs";

const ROOT = path.resolve(__dirname, "..", "..");
const scanTokens = (css, file = "fixture.css") => scanTokenHygiene({ files: [{ path: file, css }] });
const scanLiterals = (css, file = "fixture.css") => scanStyleLiterals({ files: [{ path: file, css }] });
const todos = (css) => new Set(SCALE_FAMILIES.radius);

describe("TOK：设计令牌卫生门禁（P0-1）", () => {
  it("TOK-H1：同一作用域里重复定义同一个几何令牌 → 报错（真机那个 `--radius-xs` bug）", () => {
    const css = `
:root { --radius-xs: 0.25rem; }
.somewhere { color: red; }
:root { --radius-xs: 8px; }
`;
    const { problems } = scanTokens(css);
    expect(problems.map((p) => p.rule)).toContain("H1");
    const h1 = problems.find((p) => p.rule === "H1");
    expect(h1.message).toContain("--radius-xs");
    expect(h1.message).toContain("后写者静默覆盖");
    // 两处行号都要报出来（不然看不出改哪一行）
    expect(h1.lines.length).toBe(2);
  });

  it("TOK-H1b：取值相同也算重复来源（同样报，只是措辞不同）", () => {
    const { problems } = scanTokens(`:root { --radius-sm: 6px; }\n:root { --radius-sm: 6px; }`);
    const h1 = problems.find((p) => p.rule === "H1");
    expect(h1, "重复定义必须报，不因为值相同就放过").toBeTruthy();
    expect(h1.message).toContain("取值相同");
  });

  it("TOK-H2：皮肤只覆盖半个 radius 阶梯 → 报错并列出缺哪些", () => {
    const css = `
:root { ${[...todos()].map((t, i) => `${t}: ${4 + i * 2}px;`).join(" ")} }
[data-skin="hub"] { --radius-sm: 4px; --radius: 6px; }
`;
    const { problems } = scanTokens(css);
    const h2 = problems.find((p) => p.rule === "H2");
    expect(h2, "半套覆盖必须被拦下").toBeTruthy();
    expect(h2.message).toContain("skin:hub");
    expect(h2.message).toContain("--radius-xs");
    expect(h2.message).toContain("--radius-full");
  });

  it("TOK-H3：刻度非单调（xs 比 sm 大）→ 报错", () => {
    const vals = [8, 4, 8, 10, 14, 20, 9999];
    const css = `:root { ${[...todos()].map((t, i) => `${t}: ${vals[i]}px;`).join(" ")} }`;
    const { problems } = scanTokens(css);
    const h3 = problems.find((p) => p.rule === "H3");
    expect(h3, "第 34 波踩过这个坑：--radius-xs 比 --radius-sm 还大").toBeTruthy();
    expect(h3.message).toContain("--radius-xs");
  });

  it("TOK-H4：几何令牌写成颜色/百分比 → 报错", () => {
    const vals = ["#fff", "6px", "8px", "10px", "14px", "20px", "9999px"];
    const css = `:root { ${[...todos()].map((t, i) => `${t}: ${vals[i]};`).join(" ")} }`;
    const { problems } = scanTokens(css);
    const h4 = problems.find((p) => p.rule === "H4");
    expect(h4, "几何刻度不接受颜色").toBeTruthy();
    expect(h4.message).toContain("不是长度/数字");
  });

  it("TOK-OK：本仓库真实样式文件 0 问题（正向对照：门禁没坏、代码也干净）", () => {
    const files = loadTokenFiles(ROOT);
    expect(files.length, "必须真的读到文件（否则这条断言是空转）").toBeGreaterThanOrEqual(3);
    const { defs, problems } = scanTokenHygiene({ files });
    expect(defs.length, "几何/刻度令牌定义必须真的被解析到").toBeGreaterThan(30);
    expect(problems, `令牌卫生问题：${problems.map((p) => `${p.rule} ${p.message}`).join("；")}`).toEqual([]);
  });

  it("TOK-OK2：`--radius-xs` 在默认档只有一处定义、且不再是 8px（P0-1 的回归位）", () => {
    const css = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    const defs = [...css.matchAll(/--radius-xs\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(defs, `--radius-xs 的定义次数：${defs.length}（发现 ${defs.join(" / ")}）`).toHaveLength(1);
    expect(defs[0]).not.toBe("8px");
  });
});

describe("LIT：样式写死值棘轮（P0-4）", () => {
  it("LIT-1：裸字面量算写死；`var(x, 兜底)` 不算；纯 `var(x)` 不算", () => {
    const { totals } = scanLiterals(`
.a { color: #ffffff; }
.b { color: var(--text-primary, #fff); }
.c { color: var(--text-primary); }
.d { line-height: 1.5; }
.e { line-height: var(--lh-base); }
`);
    expect(totals.color.raw, "只有 .a 是裸字面量").toBe(1);
    expect(totals.color.fallback, "只有 .b 是兜底").toBe(1);
    expect(totals["line-height"].raw).toBe(1);
  });

  it("LIT-2：`border-radius` 与 `box-shadow` 必须进各自的族（踩过的第二个坑）", () => {
    const { totals } = scanLiterals(`
.a { border-radius: 50%; }
.b { border-radius: var(--radius-sm); }
.c { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
.d { box-shadow: none; }
`);
    expect(totals["border-radius"]?.raw, "颜色族分支曾经把它们 `continue` 掉了，少报 20+6 处").toBe(1);
    expect(totals["box-shadow"]?.raw).toBe(2);
    expect(totals.color?.raw, "box-shadow 里的颜色同时算进颜色族").toBe(1);
  });

  it("LIT-3：默认档的裸颜色字面量必须仍然极少（P0 之后 ≤ 10，防漂移）", () => {
    const { totals } = scanStyleLiterals({ files: [{ path: "src/styles.css", css: readFileSync(path.join(ROOT, "src/styles.css"), "utf8") }] });
    expect(totals.color.raw, `默认档裸颜色字面量 ${totals.color.raw} 处`).toBeLessThanOrEqual(10);
  });

  it("LIT-4：棘轮语义 —— 涨了要红、降了要提示收紧、持平通过", () => {
    const baseline = { raw: { color: 10, "line-height": 5 } };
    expect(evaluateRatchet({ color: { raw: 10 }, "line-height": { raw: 5 } }, baseline).over).toEqual([]);
    expect(evaluateRatchet({ color: { raw: 11 }, "line-height": { raw: 5 } }, baseline).over).toEqual(["color"]);
    expect(evaluateRatchet({ color: { raw: 3 }, "line-height": { raw: 5 } }, baseline).tighten).toEqual(["color"]);
  });

  it("LIT-5：本仓库真实读数不超过入库基线（棘轮在当前代码上成立）", () => {
    const baseline = readBaseline();
    expect(baseline, "基线文件必须存在（tools/audit/style-literals-baseline.json）").toBeTruthy();
    const { totals } = scanStyleLiterals({ files: loadLiteralFiles(ROOT) });
    const { over } = evaluateRatchet(totals, baseline);
    expect(over, `这些族的写死值涨了：${over.join(", ")}`).toEqual([]);
  });
});
