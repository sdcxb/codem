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
/** 取某个作用域块里的**最后一个**令牌声明（与 CSS 的层叠一致：后写覆盖先写） */
const token = (block: string, name: string): string | null => {
  const re = new RegExp(`--${name.slice(2)}\\s*:\\s*([^;]+);`, "g");
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(block))) last = m[1].trim();
  return last;
};
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
    expect(totals["box-shadow"]?.raw, "只有 .c 是写死的高度值").toBe(1);
    expect(totals.color?.raw, "box-shadow 里的颜色同时算进颜色族").toBe(1);
  });

  /**
   * LIT-2b：**取消/继承类关键字不算写死**（第 156 轮口径修正，与"字号 917"那次同类）。
   *
   * 起因：玻璃表面的降级块必须写 `box-shadow: none`（撤掉 `@supports` 里加的内高光），
   * 老口径把它算成"写死了一个阴影" ⇒ **正确做法反而把棘轮推高 2 处**。
   * 白名单只放 `none`/`inherit`/`initial`/`unset`/`revert`；
   * `bold`（真实字重 700）、`auto`、`normal` 照旧算写死。
   */
  it("LIT-2b：`none`/`inherit` 等取消继承关键字进 `keyword` 而不进 `raw`；`bold` 仍算写死", () => {
    const { totals } = scanLiterals(`
.a { box-shadow: none; }
.b { box-shadow: inherit; }
.c { font-weight: bold; }
.d { transition: none; }
`);
    expect(totals["box-shadow"]?.raw, "只有 .c 那类真实取值才算写死；这里 box-shadow 两条都不是").toBe(0);
    expect(totals["box-shadow"]?.keyword, "取消/继承要单独可见，不能悄悄消失").toBe(2);
    expect(totals["font-weight"]?.raw, "bold 是真实字重，必须继续算写死").toBe(1);
    expect(totals["animation/transition"]?.keyword).toBe(1);
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

  /**
   * LIT-6 / LIT-7：品牌色浅底/描边阶梯（D5）。
   * 背景：全项目曾有 **64 处**手写 `color-mix(in srgb, var(--accent) N%, transparent)`、
   * 一共发明了 **20 种百分比**（4%…85%）——"同一个品牌色在不同组件里深浅不一"。
   */
  it("LIT-6：四档品牌色浅底/描边令牌存在，且都是 `var(--accent)` 的派生（写死 rgba 就不跟皮肤）", () => {
    const css = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    const ladder: Array<[string, string]> = [
      ["--accent-surface", "8"],
      ["--accent-surface-strong", "15"],
      ["--accent-border", "30"],
      ["--accent-border-strong", "45"],
    ];
    for (const [name, pct] of ladder) {
      expect(css, `缺少 ${name}（浅底/描边阶梯四档之一）`).toContain(`${name}: color-mix(in srgb, var(--accent) ${pct}%, transparent);`);
      const literal = new RegExp(`${name}\\s*:\\s*(#|rgba?\\()`);
      expect(literal.test(css), `${name} 写成了颜色字面量 —— 皮肤改 --accent 时它不会跟着走`).toBe(false);
    }
  });

  it("LIT-7：`accent-tint` 族进棘轮（手写品牌色混色只许降），用令牌则不计", () => {
    const { totals } = scanLiterals(`.a { background: color-mix(in srgb, var(--accent) 37%, transparent); }`);
    expect(totals["accent-tint"]?.raw, "自编的 37% 必须被数出来").toBe(1);
    const { totals: viaToken } = scanLiterals(`
.b { background: var(--accent-surface); }
.c { border-color: var(--accent-border-strong); }
`);
    expect(viaToken["accent-tint"]?.raw ?? 0, "走令牌的不算").toBe(0);
  });

  /**
   * LIT-8：状态色四角色（P1-4）。与品牌色阶梯同源的问题：全项目曾有 **156 处**手写状态色混色
   * （光 error 就有 8 种百分比），而且**有一个实测到的可读性缺口** —— 57 处"状态色文字压在同色浅底上"，
   * 浅色档 20% 那档只有 3.87:1（都是 12px 小标签）。
   */
  it("LIT-8：四个状态 × 四角色令牌齐备，且都派生自各自的 var(--<status>)", () => {
    const css = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    for (const s of ["success", "warning", "error", "info"]) {
      for (const [role, pct] of [["surface", "10"], ["surface-strong", "20"], ["border", "30"]] as const) {
        expect(css, `缺 --${s}-${role}（应为 ${pct}% 的浅底/描边）`).toContain(`--${s}-${role}: color-mix(in srgb, var(--${s}) ${pct}%, transparent);`);
      }
      /* 文字角色：浅色档必须**压深**（写成原色就等于没修那个缺口） */
      const lightContent = new RegExp(`--${s}-content:\\s*color-mix\\(in srgb, var\\(--${s}\\) ([\\d.]+)%, var\\(--text-primary\\)\\)`).exec(css);
      expect(lightContent, `浅色档缺 --${s}-content 的压深配方`).toBeTruthy();
      expect(Number(lightContent![1]), `--${s}-content 混入比例 ${lightContent![1]}% 太高，压不深就没修缺口`).toBeLessThanOrEqual(90);
    }
  });

  it("LIT-9：`status-tint` 族进棘轮；状态色浅底/描边不得再手写百分比", () => {
    const { totals } = scanLiterals(`.a { background: color-mix(in srgb, var(--error) 15%, transparent); }`);
    expect(totals["status-tint"]?.raw, "自编的 15% 必须被数出来").toBe(1);
    const { totals: viaToken } = scanLiterals(`
.b { background: var(--error-surface); }
.c { border-color: var(--warning-border); }
.d { color: var(--success-content); }
`);
    expect(viaToken["status-tint"]?.raw ?? 0, "走令牌的不算").toBe(0);
  });

  /**
   * LIT-10 / LIT-11：**文字与品牌浅底必须解耦**（第 159 轮 P1-2）。
   *
   * 背景：改动前三档文字是每个主题/皮肤**各手工挑三个值**（默认主题 `#1f1f1e`/`#57564f`/`#6e6c66`，
   * hub 皮肤 `#e0e0e0`/`#888888`/`#666666`）—— 换个墨色要重配三处，还得自己保证三档关系正确；
   * `--accent-muted` 更是写死的 rgba（浅色档那个字面量甚至不是它自己的 accent），
   * 于是"皮肤改了 `--accent`，浅底 chip 不跟着变"。
   * 现在三档派生自 `--text-base`、浅底派生自 `--accent`，**门禁盯住"是不是派生"**。
   */
  it("LIT-10：三档文字在每个作用域都必须派生自 --text-base（而不是各写一个字面量）", () => {
    /* ⚠️ 这个文件里的 CSS 是**就地读**的（没有模块级 `styles` 常量）—— 第一版照抄了别的测试文件，
       报 "styles is not defined"。两套 CSS 要一起搜：默认主题在 styles.css、hub 皮肤在 skin-hub.css。 */
    const stylesText =
      readFileSync(path.join(ROOT, "src/styles.css"), "utf8") + readFileSync(path.join(ROOT, "src/styles/skin-hub.css"), "utf8");
    const scopes: Array<[string, RegExp]> = [
      ["默认/亮色", /:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/],
      ["暗色", /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/],
      ["hub 皮肤", /\[data-skin="hub"\]\s*\{([\s\S]*?)\n\}/],
    ];
    for (const [label, re] of scopes) {
      const block = re.exec(stylesText)?.[1] ?? "";
      expect(block.length, `${label} 块没解析到`).toBeGreaterThan(100);
      expect(token(block, "--text-base"), `${label} 缺 --text-base（墨色唯一真相源）`).toBeTruthy();
      expect(token(block, "--text-ramp-paper"), `${label} 缺 --text-ramp-paper（混向的纸色）`).toBeTruthy();
      expect(token(block, "--text-primary"), `${label} 的 --text-primary 应是 var(--text-base)`).toBe("var(--text-base)");
      for (const step of ["--text-secondary", "--text-muted"]) {
        const v = token(block, step) ?? "";
        expect(v, `${label} 的 ${step} 必须是从 --text-base 派生的 color-mix，实际：${v}`).toMatch(/^color-mix\(in srgb,\s*var\(--text-base\)\s+[\d.]+%,\s*var\(--text-ramp-paper\)\)$/);
      }
    }
  });

  it("LIT-11：品牌浅底（--accent-muted）必须派生自 --accent（皮肤换品牌色时浅底要跟着走）", () => {
    const allCss = readFileSync(path.join(ROOT, "src/styles.css"), "utf8") + readFileSync(path.join(ROOT, "src/styles/skin-hub.css"), "utf8");
    const scopes: Array<[string, RegExp]> = [
      ["默认/亮色", /:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/],
      ["暗色", /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/],
      ["hub 皮肤", /\[data-skin="hub"\]\s*\{([\s\S]*?)\n\}/],
    ];
    for (const [label, re] of scopes) {
      const block = re.exec(allCss)?.[1] ?? "";
      const v = token(block, "--accent-muted") ?? "";
      expect(v, `${label} 的 --accent-muted 必须派生自 var(--accent)，实际：${v}`).toMatch(/^color-mix\(in srgb,\s*var\(--accent\)\s+[\d.]+%,\s*transparent\)$/);
    }
  });
});

/**
 * DIS —— **禁用态不透明度**门禁（第 156 轮 P1-4，令牌卫生 H5）。
 *
 * 为什么要有：改动前"禁用态变淡"这一件事在项目里有 **0.3 / 0.4 / 0.45 / 0.5 / 0.55 / 0.6 六个数**
 * （styles.css 31 处 + codem-ui.css 4 处），同一个界面里两个禁用按钮的灰都不一样。
 * 收敛到 `--opacity-disabled` 之后必须有门禁守着，否则下一波改动又会各写各的。
 */
describe("DIS：禁用态不透明度必须走令牌（P1-4 / H5）", () => {
  const h5 = (css: string) => scanTokens(css).problems.filter((p: { rule: string }) => p.rule === "H5");

  it("DIS-1：禁用族选择器上写裸数值 → 红（`:disabled` / `.disabled` / `.is-disabled` / `[disabled]`）", () => {
    const found = h5(`
:root { --opacity-disabled: 0.5; }
.a:disabled { opacity: 0.5; }
.b.disabled { opacity: 0.4; }
.c.is-disabled { opacity: 0.55; }
.d[disabled] { opacity: 0.6; }
`);
    expect(found.length, "四个都是禁用态，都应报").toBe(4);
    expect(found.map((p: { message: string }) => /var\(--opacity-disabled\)/.test(p.message)).every(Boolean), "报错信息要指出正确写法").toBe(true);
  });

  it("DIS-2：走令牌不算；`:hover:not(:disabled)` 上的 opacity **不算**禁用态（别误伤）", () => {
    const found = h5(`
:root { --opacity-disabled: 0.5; }
.a:disabled { opacity: var(--opacity-disabled); }
/* 可用时的悬停微调，写 0.9 是正确的 —— 它不是禁用态 */
.b:hover:not(:disabled) { opacity: 0.9; }
.c:not(:disabled):active { opacity: 0.8; }
`);
    expect(found, `不该报，却报了：${JSON.stringify(found.map((p: { message: string }) => p.message))}`).toEqual([]);
  });

  it("DIS-3：写了 `var(--opacity-disabled)` 却没有任何作用域定义它 → 红（禁用态会整片退化成不透明）", () => {
    const found = h5(`
.a:disabled { opacity: var(--opacity-disabled); }
`);
    expect(found.length).toBe(1);
    expect(found[0].message).toMatch(/没有任何作用域定义/);
  });

  it("DIS-4（正向对照）：本仓库两个 sheet 上 0 处裸数值，且令牌只定义一次", () => {
    const problems = scanTokenHygiene({ files: loadTokenFiles(ROOT) }).problems.filter((p: { rule: string }) => p.rule === "H5");
    expect(problems, `还有裸数值：\n${problems.map((p: { file: string; lines: number[]; message: string }) => `  - ${p.file}:${p.lines.join(",")} ${p.message}`).join("\n")}`).toEqual([]);
    const defs = scanTokenHygiene({ files: loadTokenFiles(ROOT) }).defs.filter((d: { name: string }) => d.name === "--opacity-disabled");
    expect(defs.length, "`--opacity-disabled` 应只有一处定义（默认档）").toBe(1);
    expect(defs[0].value, "禁用态取值：众数 0.5（收敛前的六个值都归到它）").toBe("0.5");
  });
});
