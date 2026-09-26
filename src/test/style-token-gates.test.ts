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

/**
 * 皮肤文件的"可扫描区间"（SKIN-1 / SKIN-2 两个门禁**共用同一套口径**）。
 *
 * 口径只能有一处实现 —— 两个门禁各写一份正则，迟早会不一样，而"两套口径"正是这个仓库反复踩的坑
 * （第 163 轮就出过一次：装机版复核脚本自己另写了一个含 `transparent` 的宽松正则，报了 29 处假红）。
 *
 * 返回：
 * - `raw` 原文；`inComment(i)` 该偏移是否在注释里（注释里解释颜色是文档，不是取值）；
 * - `varSpans` `var(...)` 的区间（`var(--x, #fff)` 的兜底是正当写法）；
 * - `blockStart/blockEnd` 顶部**令牌块**的区间（块内是"数据"，不算规则体）；
 * - `lineOf(i)` 偏移 → 行号（⚠️ 必须按 `\n` 的真实位置算：这个文件是 **CRLF**，
 *   第一版用"每行长度 + 1"累加，130 行后偏了约 130 字符，于是令牌块内的字面量被当成规则体里的，报了 4 处假红）。
 */
const skinScan = (rel: string) => {
  const raw = readFileSync(path.join(ROOT, rel), "utf8");
  const commentSpans: Array<[number, number]> = [...raw.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => [m.index, m.index + m[0].length]);
  const inComment = (i: number) => commentSpans.some(([a, b]) => i >= a && i < b);
  /* 令牌块 = 第一个顶层块（块体里有 `--x: y;`） */
  const cleanLines = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split(/\r?\n/);
  let start = -1;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < cleanLines.length; i++) {
    if (start < 0 && cleanLines[i].includes("{")) {
      start = i;
      depth = 0;
    }
    if (start < 0) continue;
    for (const ch of cleanLines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && i > start) {
      if (/^\s*--[\w-]+\s*:/m.test(cleanLines.slice(start, i + 1).join("\n"))) {
        end = i;
        break;
      }
      start = -1;
    }
  }
  const lineStarts: number[] = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === "\n") lineStarts.push(i + 1);
  const blockStart = start >= 0 ? (lineStarts[start] ?? 0) : Number.MAX_SAFE_INTEGER;
  const blockEnd = start >= 0 ? (lineStarts[end] ?? raw.length) + (raw.split(/\r?\n/)[end]?.length ?? 0) : Number.MAX_SAFE_INTEGER;
  const varSpans: Array<[number, number]> = [...raw.matchAll(/var\([^)]*\)/g)].map((m) => [m.index, m.index + m[0].length]);
  const lineOf = (i: number) => raw.slice(0, i).split("\n").length;
  const inTokenBlock = (i: number) => i >= blockStart && i < blockEnd;
  const inVar = (i: number) => varSpans.some(([a, b]) => i >= a && i < b);
  return { raw, inComment, varSpans, blockStart, blockEnd, inTokenBlock, inVar, lineOf, found: start >= 0 && end > start };
};

/** CSS Color 4 的命名色（第 164 轮 SKIN-2 用）。`transparent`/`currentColor` **不在**这张表里：
 *  压缩器对它们**逐字保留**（装机版那份 CSS 实测：`background:transparent` 原样留着），
 *  而命名色会被改写成 `#fff` 这类颜色字面量。 */
const CSS_NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`
    .split(" ")
    .filter(Boolean),
);
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

  /**
   * LIT-12：**面的角色**收口（第 162 轮 P1-1 的第一半）。
   *
   * 背景：对标实现是"灰工作区 + 白卡"，我们是"画布与卡片同色"（卡片都用 `--bg-primary`）。
   * 这一轮把"卡片面"单独命名成 `--surface-raised` 并接上真实消费方 —— 取值**刻意等于** `--bg-primary`，
   * 所以是零视觉变化；它的价值是**把接口留出来**：将来要翻成"灰工作区 + 白卡"，
   * 只需改这一行 + 工作区底色，不必去翻几百条 `--bg-primary`。
   *
   * 同时锁住一条**取舍**：对标文档 P1-1 还提到 `--surface-subtle`（3% 局部着色），
   * 但我们已经有 `--surface-1` / `--surface-2` 两档局部浅面（codem-ui.css，被引用 19 次）——
   * 再加一个同义名就是"两套阶梯并存"。所以这里断言：**不许同时存在 `--surface-subtle` 与 `--surface-1`**
   * （要换名字就一次换干净，别并存）。
   */
  it("LIT-12：--surface-raised 是别名（不是写死色）、有 ≥3 个消费方、且不与 --surface-1 重名并存", () => {
    const stylesText = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    const codemUi = readFileSync(path.join(ROOT, "src/styles/codem-ui.css"), "utf8");
    const rootBlock = /^:root\s*\{([\s\S]*?)\n\}/m.exec(stylesText)?.[1] ?? "";
    const def = token(rootBlock, "--surface-raised");
    expect(def, "应在基础 :root 里定义 --surface-raised（卡片/面板面）").toBeTruthy();
    expect(def, `--surface-raised 不能写死颜色（否则又变成"卡片面各写一处"）：${def}`).toMatch(/^var\(--[\w-]+\)$/);
    const consumers = [...stylesText.matchAll(/var\(--surface-raised\)/g)].length;
    /* 阈值取**当前实测值**（4 个消费方：市场技能卡 / 多模态内嵌面板 / diff 面板 / 性能面板）——
       写 `≥3` 时"删掉一个消费方"这种变异根本不会红（实测），等于门槛没咬住。 */
    expect(consumers, `--surface-raised 只有 ${consumers} 个消费方（实测 4 个，门槛取 ≥4：少一个就说明有人把它换回 --bg-primary 了）`).toBeGreaterThanOrEqual(4);
    /* 两套"局部浅面"不许并存（见上面注释） */
    const hasSubtle = /--surface-subtle\s*:/.test(stylesText);
    const hasSurface1 = /--surface-1\s*:/.test(codemUi) || /--surface-1\s*:/.test(stylesText);
    expect(hasSubtle && hasSurface1, "同时存在 --surface-subtle 与 --surface-1：这是两套浅面阶梯，必须合成一套").toBe(false);
  });

  /**
   * SKIN-1：**皮肤文件里，规则体不许再有颜色字面量**（第 163 轮 P2-3 皮肤数据化）。
   *
   * 对标文档 P2-3 的判据就是这一条："hub/dream 迁移后，`skin-*.css` 里只剩令牌块（颜色字面量 0）"。
   * 做法：把两个皮肤文件规则体里的裸颜色收进各自顶部的**调色板令牌块**（值逐字相同 ⇒ 零视觉变化），
   * 规则体只引用 `var(--hub-cN)` / `var(--dream-cN)`。
   *
   * **零视觉变化的证据**不是"我觉得"：迁移后 `css-integrity.test.ts` 的 CSS-INTEGRITY-7
   * （2733 个类的**生效取值**快照）**没有 --write 就通过** ⇒ 所有类的计算值逐位不变。
   */
  it("SKIN-1：两套皮肤的规则体里不许出现颜色字面量（必须收进顶部令牌块）", () => {
    for (const rel of ["src/styles/skin-hub.css", "src/styles/skin-dream.css"]) {
      const s = skinScan(rel);
      expect(s.found, `${rel} 找不到令牌块（皮肤文件必须把颜色定义集中在顶部令牌块里）`).toBe(true);
      const stray: string[] = [];
      for (const m of s.raw.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
        const i = m.index!;
        if (s.inComment(i)) continue; // 注释里解释颜色是文档，不是取值
        if (s.inTokenBlock(i)) continue; // 令牌块内是"数据"
        if (s.inVar(i)) continue; // `var(--x, #fff)` 的兜底是正当写法
        stray.push(`${rel}:${s.lineOf(i)}  ${m[0]}`);
      }
      expect(stray, `${rel} 的规则体里还有颜色字面量（应收进顶部令牌块）：\n  - ${stray.slice(0, 8).join("\n  - ")}`).toEqual([]);
    }
  });

  /**
   * SKIN-2：皮肤规则体里不许用**命名色**（`white` / `black` / `red` …）（第 164 轮）。
   *
   * 为什么 SKIN-1 不够：SKIN-1 的口径是 `hex` 与 `rgb()/rgba()`（和全项目的算写死值口径一致），
   * 而 `color: white` 两种都不匹配 ⇒ 源码门禁全绿。**但压缩器会把命名色改写成 `#fff`**：
   * 装机版那份 CSS（`dist/assets/main-*.css`）里，Dream 皮肤的规则体里实测有 **2 处** `#fff`
   * —— 判据"skin-*.css 里只剩令牌块（颜色字面量 0）"在**产物**这一层被破了，而源码门禁看不见。
   *
   * 这个门禁就是把"源码口径"和"产物口径"对齐：命名色一律走令牌。
   * `transparent` / `currentColor` 明确豁免 —— 压缩器对它们逐字保留（产物里 `background:transparent`
   * 原样在），它们也不携带任何设计取值。
   *
   * 变异自证：`SKIN2-命名色 white` 会红。
   */
  it("SKIN-2：皮肤规则体里不许出现命名色（压缩器会把它改写成颜色字面量，绕过 SKIN-1）", () => {
    for (const rel of ["src/styles/skin-hub.css", "src/styles/skin-dream.css"]) {
      const s = skinScan(rel);
      expect(s.found, `${rel} 找不到令牌块`).toBe(true);
      const stray: string[] = [];
      /* 只看**声明的值**（选择器里的 `.hub-task-icon-blue` 这类类名不算颜色） */
      for (const d of s.raw.matchAll(/(^|[;{])\s*(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)/g)) {
        const valueAt = d.index! + d[0].length - d[3].length;
        if (s.inComment(d.index!)) continue;
        if (s.inTokenBlock(valueAt)) continue;
        if (s.inVar(valueAt)) continue; // 值里只要走 var()（含兜底）就不算
        for (const w of d[3].matchAll(/[a-zA-Z]{3,}/g)) {
          if (!CSS_NAMED_COLORS.has(w[0].toLowerCase())) continue;
          stray.push(`${rel}:${s.lineOf(valueAt + w.index!)}  ${d[2]}: ${d[3].trim()}  （命名色 \`${w[0]}\`）`);
        }
      }
      expect(stray, `${rel} 的规则体里还有命名色（压缩器会改写成颜色字面量、绕过 SKIN-1；请改用令牌）：\n  - ${stray.slice(0, 8).join("\n  - ")}`).toEqual([]);
    }
  });

  it("LIT-11：品牌浅底（--accent-muted）必须派生自 --accent（皮肤换品牌色时浅底要跟着走）", () => {    const allCss = readFileSync(path.join(ROOT, "src/styles.css"), "utf8") + readFileSync(path.join(ROOT, "src/styles/skin-hub.css"), "utf8");
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

  /**
   * SHELL-1：**内容必须是"一块浮在 chrome 上的圆角纸面"**（第 166 轮 P0-0）。
   *
   * 为什么立这条：对标文档 §13 实测出这一条比"行高"更能解释"看着廉价" ——
   * 对方的内容区是"圆角 24px（左侧两角）+ 左缘阴影"的纸面，浮在整壳一层玻璃之上；
   * 我们此前 `.app` / `.app-content` / `.main-area` / `.chat-panel` **全部圆角 0、阴影 none、零间距**：
   * 四块齐边矩形拼在一起。而**这一条跟"改什么颜色"无关** ⇒ 前五轮改令牌不可能带来观感变化。
   *
   * 判据（三条都是"层次成立"的必要条件）：
   *   ① 内容面必须有**左侧两角**圆角（右侧贴窗口，圆右角会切出窗口底色）；
   *   ② 内容面必须有非 none 阴影，且影子要有墨色输入（不是 `--shadow-raise-*` 那种通用档乱用）；
   *   ③ 壳（`.app`）的底色必须与内容面**不同** —— 否则圆角切出来还是同色，等于没做层次。
   *
   * 变异：去掉 `box-shadow` / 把半径改回 0 / 把 `.app` 改回 `--bg-primary`，三条各自会红。
   */
  it("SHELL-1：内容面必须是「左侧两角圆角 + 左缘阴影」，且壳体色与内容面不同（P0-0）", () => {
    const css = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const ruleOf = (sel: string) =>
      new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(cssNoComments)?.[2] ?? "";

    const main = ruleOf(".main-area");
    expect(main, "找不到 `.main-area` 规则").not.toBe("");
    expect(
      /border-radius:\s*var\(--surface-sheet-radius\)\s+0\s+0\s+var\(--surface-sheet-radius\)/.test(main),
      `内容面必须只圆**左侧两角**（用 --surface-sheet-radius），实际：${/border-radius:[^;]*/.exec(main)?.[0] ?? "（无）"}`,
    ).toBe(true);
    expect(
      /box-shadow:\s*var\(--shadow-sheet\)/.test(main),
      "内容面必须有左缘阴影（没有阴影就没有'浮起来'）",
    ).toBe(true);

    /* ③ 壳体与内容面必须是**不同**的面：`.app` 的底色不能等于内容面的 `--bg-primary` */
    const app = ruleOf(".app");
    expect(
      /background-color:\s*var\(--chrome-surface\)/.test(app),
      `壳（.app）必须用 --chrome-surface（比内容面暗一档），实际：${/background-color:[^;]*/.exec(app)?.[0] ?? "（无）"}`,
    ).toBe(true);

    /* 阴影与纸面半径必须在令牌块里有定义，且阴影带墨色（两档自动反向） */
    expect(css, "缺 --shadow-sheet 定义").toMatch(/--shadow-sheet:\s*-?\d+px[^;]*var\(--text-base\)/);
    expect(css, "缺 --surface-sheet-radius 定义").toMatch(/--surface-sheet-radius:\s*24px/);

    /* 侧栏与内容之间的分界必须是"墨色 hairline"（5% 的旧值在近白面上约等于不存在） */
    const sidebar = ruleOf(".sidebar");
    expect(sidebar, "侧栏右边界必须走 --hairline-ink（墨色派生，暗色档才看得见）").toMatch(/border-right:\s*1px solid var\(--hairline-ink\)/);
  });

  /**
   * RHYTHM-1：**侧栏的行节奏必须是一个常量**（第 166 轮 P0-2）。
   *
   * 判据来源（对标文档 §3）：对方侧栏所有行都是 **30px 一个常量**、分组标题 24px、
   * 行内边距 `0 8px`、列表外层 `2px 6px`、行间距 `2px`；
   * 我们此前是 **7 种行高**（22 / 26 / 28.33 / 31.5 / 38 / 40.33 / 59.06，三个是小数）、
   * **4 种相邻行间距**（0/4/8/16）、三套容器内边距 —— 像素侧"行距"在 4 个带宽里只有 1/4 能检出周期。
   *
   * 变异：把任一行的 `height: 30px` 改回 38px / 改回 `min-height` ⇒ 红。
   */
  it("RHYTHM-1：侧栏行高只能是 {30px}、分组标题 24px、行内边距 0 8px、容器外层 2px 6px、行间距 2px", () => {
    const css = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const ruleOf = (sel: string) =>
      new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(cssNoComments)?.[2] ?? "";

    const rows = [".sidebar-nav-item", ".sidebar-session", ".sidebar-project-header"];
    for (const sel of rows) {
      const body = ruleOf(sel);
      expect(body, `找不到 ${sel}`).not.toBe("");
      const h = /(?:^|;)\s*height:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? "";
      expect(h, `${sel} 的行高必须是 30px（侧栏只有一个行高常量），实际：${h || "（未声明）"}`).toBe("30px");
      expect(h, `${sel} 不能用 min-height 代替固定行高（那会让内容把行撑高、节奏再次散掉）`).toBe("30px");
      const pad = /(?:^|;)\s*padding:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? "";
      expect(pad, `${sel} 的行内边距必须是 "0 var(--space-2)"，实际：${pad || "（未声明）"}`).toBe("0 var(--space-2)");
    }

    const header = ruleOf(".sidebar-section-header");
    expect(/(?:^|;)\s*height:\s*24px/.test(header), "分组标题行高必须是 24px（对方 token 值）").toBe(true);

    /* ⚠️ 断言"生效的 px 值"而不是"写法"：仓库有 error 级门禁 `spacing-raw` 要求间距走 `var(--space-*)`，
       所以这里先解析令牌再比数值 —— 否则门禁会逼着我们把令牌改回裸 px（口径打架）。
       ⚠️ 刻度定义在**后面那个补刻度的 `:root` 块**（`第六十波` 补的），不是第一个 `:root` ——
       所以这里扫**全文**的所有 `--space-N: Xpx;` 声明，而不是只读第一个块（第一版就读错块、解析到 0 个）。 */
    const spaceTokens = new Map<string, number>();
    for (const m of cssNoComments.matchAll(/--space-([\w-]+)\s*:\s*(\d+(?:\.\d+)?)px;/g)) spaceTokens.set(`--space-${m[1]}`, Number(m[2]));
    expect(spaceTokens.size, "没解析到 --space-* 刻度").toBeGreaterThan(4);
    const px = (expr: string): number[] =>
      expr
        .trim()
        .split(/\s+/)
        .map((part) => {
          const tok = /^var\((--space-[\w-]+)\)$/.exec(part);
          if (tok) {
            const v = spaceTokens.get(tok[1]);
            expect(v, `令牌 ${tok[1]} 没有定义`).toBeTypeOf("number");
            return v!;
          }
          const lit = /^(\d+(?:\.\d+)?)px$/.exec(part);
          expect(lit, `无法解析的间距写法：${part}（应该走 var(--space-*)）`).toBeTruthy();
          return Number(lit![1]);
        });

    for (const [sel, want] of [[".sidebar-nav", [2, 6]], [".sidebar-projects", [2, 6]], [".sidebar-section", [2, 6]]] as const) {
      const pad = /(?:^|;)\s*padding:\s*([^;]+)/.exec(ruleOf(sel))?.[1]?.trim() ?? "";
      expect(pad, `${sel} 缺少 padding`).not.toBe("");
      expect(px(pad), `${sel} 的容器外层内边距必须生效为 ${want.join("/")}px（三套内边距会让左边缘文字起点各不相同），实际写法：${pad}`).toEqual([...want]);
    }

    const navGap = /(?:^|;)\s*gap:\s*([^;]+)/.exec(ruleOf(".sidebar-nav"))?.[1]?.trim() ?? "";
    expect(px(navGap), `行间距必须生效为 2px（对方 calc(space-1/2)），实际：${navGap}`).toEqual([2]);

    /* 反例守卫：侧栏里不许再出现这几个"历史小数行高" */
    for (const bad of ["40.33px", "31.5px", "28.33px", "59.06px"]) {
      expect(cssNoComments.includes(bad), `侧栏里又出现了历史小数行高 ${bad}（节奏常量被破坏）`).toBe(false);
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
