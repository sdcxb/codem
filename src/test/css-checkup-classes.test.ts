/**
 * 记忆体检 / 记忆管理视图的 CSS 契约判据（CSS-CHECKUP-1 / CSS-CHECKUP-2）。
 *
 * ## 为什么要单独一组判据
 *
 * 这两个组件的样式规则曾被**整体丢失**（`styles.css` 被恢复成改动前的版本，
 * 只抽回了顶层规则，而嵌套在 `@media` / 复合选择器里的 `.mc-*` 规则没被抽回），
 * 现场表现是 `ui-consistency` 报 **71 处 `css-class-undefined`**（等于这些类名"等于没样式"）。
 * 事后复盘发现真正缺的不是某一条规则，而是**一条能逐类对账的判据**：
 * 原来的 `css-class-undefined` 只看 `className` 的**静态片段**，
 * 模板串里 `${cond ? "selected" : ""}` 这类**条件类名**整段被剥掉 ⇒ 漏检。
 *
 * ## 判据（两条，都能变红）
 *
 * | # | 判据 | 变异（必须红） |
 * | --- | --- | --- |
 * | CSS-CHECKUP-1 | 组件里 `className` 用到的**每一个**类名（含模板串静态段与条件类名）都能在 CSS 选择器里找到定义 | 删掉任意一条规则（如 `.mc-group-title { … }`） |
 * | CSS-CHECKUP-2 | `styles.css` 里本段新增规则**没有写死值**（字号/字重/颜色/圆角/间距一律走令牌） | 段里塞一条 `font-weight: 600` 或 `color: #fff` |
 *
 * ⚠️ CSS-CHECKUP-1 **不是**"CSS 文本里包含某个字符串"：
 * 它先用 `className=` 逐处解析（字符串字面量 / JSX 表达式 / 模板串），
 * 把类名 token 取出来，再与**选择器解析**得到的类名集合逐个比对。
 * 因此 `content: "mc-entry"` 这类声明值、注释里的示例都**不算**定义。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const STYLES = "src/styles.css";

/** 被守的组件：体检视图本体 + 同批新增了「写入审批 / 待批准 / 自动提取批次」的记忆管理 */
const COMPONENTS = ["src/components/MemoryCheckupView.tsx", "src/components/MemoryManager.tsx"];

/** 本段新增规则的边界标记（CSS-CHECKUP-2 只扫这一段，不碰无关的既有规则） */
const SEGMENT_BEGIN = "/* ===== CSS-CHECKUP-BEGIN ===== */";
const SEGMENT_END = "/* ===== CSS-CHECKUP-END ===== */";

// ============================ 提取：className → 类名 ============================

/** 去掉模板串里的 `${…}`（含嵌套花括号），只留静态片段 */
function stripTemplateExprs(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 0;
      i += 1;
      do {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        i++;
      } while (i < s.length && depth > 0);
      out += " ";
    } else {
      out += s[i++];
    }
  }
  return out;
}

/** 取出模板串里每个 `${…}` 的内部源码（嵌套花括号按配对走） */
function templateExprs(t: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    if (t[i] === "$" && t[i + 1] === "{") {
      let depth = 0;
      const start = i + 2;
      i += 1;
      do {
        if (t[i] === "{") depth++;
        else if (t[i] === "}") depth--;
        i++;
      } while (i < t.length && depth > 0);
      out.push(t.slice(start, i - 1));
    } else {
      i++;
    }
  }
  return out;
}

/**
 * 从一份 TSX 源码里取出**所有** `className` 用到的类名。
 *
 * 覆盖三种写法：
 *   `className="a b"`、`className={'a b'}`、
 *   `` className={`a ${cond ? "selected" : ""}`} `` ← 条件类名（旧审计器在这里漏检）
 * 只认**字符串字面量**与模板串静态段 —— 裸标识符（`filterScope` / `scope` 这类变量名）不是类名。
 */
export function classNamesInComponent(src: string): Set<string> {
  const found = new Set<string>();
  const addText = (text: string) => {
    for (const tok of text.split(/[\s`"'{}]+/)) if (/^-?[_a-zA-Z][\w-]*$/.test(tok)) found.add(tok);
  };
  const re = /className\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (/\s/.test(src[i])) i++;
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      addText(src.slice(i + 1, end));
      re.lastIndex = end + 1;
      continue;
    }
    if (ch !== "{") continue;
    // 花括号配对（跳过字符串/模板字面量内部的花括号）
    let depth = 0;
    let j = i;
    while (j < src.length) {
      const c = src[j];
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        j++;
        while (j < src.length && src[j] !== q) {
          if (src[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    const region = src.slice(i + 1, j);
    const templates = region.match(/`[^`]*`/g) ?? [];
    if (templates.length) {
      for (const t of templates) {
        addText(stripTemplateExprs(t.slice(1, -1))); // 模板串静态段
        for (const inner of templateExprs(t)) {
          // 条件类名：`${cond ? "a" : "b"}` 里只取字符串字面量
          for (const lit of inner.matchAll(/"([^"]*)"|'([^']*)'/g)) addText(lit[1] ?? lit[2]);
        }
      }
    } else {
      for (const lit of region.matchAll(/"([^"]*)"|'([^']*)'/g)) addText(lit[1] ?? lit[2]);
    }
    re.lastIndex = j + 1;
  }
  return found;
}

// ============================ 提取：CSS → 已定义类名 ============================

/**
 * 从一份 CSS 里取出**选择器里**出现过的类名。
 *
 * 做法是**解析**而不是搜索：按 `{` / `}` 切块，只在前一个块结束到 `{` 之间的**选择器段**里找 `.class`。
 * ⇒ 声明值里的字符串（`content: "mc-entry"`）、注释里的示例都不会被当成"有定义"。
 */
export function definedClassNames(cssText: string): Set<string> {
  const code = cssText.replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, " "));
  const out = new Set<string>();
  let buf = "";
  for (const ch of code) {
    if (ch === "{") {
      for (const sel of buf.split(",")) for (const mm of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(mm[1]);
      buf = "";
    } else if (ch === "}") {
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

/** 全项目 CSS（不含测试夹具）里定义过的类名 */
function allDefinedClassNames(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".css") && !/\.test\./.test(entry)) {
        for (const c of definedClassNames(readFileSync(full, "utf8"))) out.add(c);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

// ============================ CSS-CHECKUP-1 ============================

describe("CSS-CHECKUP-1：组件用到的每个类名都必须在 CSS 里有定义", () => {
  const defined = allDefinedClassNames();

  it("类名表不是空集（否则下面的逐类比对是空转）", () => {
    expect(defined.size, "全项目 CSS 里一个类名都没解析到 ⇒ 选择器解析写错了").toBeGreaterThan(1000);
  });

  for (const rel of COMPONENTS) {
    it(`${rel}：className 提取出的类名逐个比对，缺一个就红`, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      const used = [...classNamesInComponent(src)].sort();
      const missing = used.filter((c) => !defined.has(c));

      expect(used.length, `${rel} 一个类名都没提取到 ⇒ 提取器失效（等于判据空转）`).toBeGreaterThan(20);
      expect(
        missing,
        `${rel} 里这些类名**没有任何 CSS 选择器定义**（等于没样式）：\n  - ${missing.join("\n  - ")}`,
      ).toEqual([]);
    });
  }

  it("提取器确实能看见模板串里的条件类名（旧审计器在这里漏检）", () => {
    const src = readFileSync(path.join(ROOT, COMPONENTS[0]), "utf8");
    const used = classNamesInComponent(src);
    // 这三个只出现在 `${…}` 的条件分支或模板串静态段里
    for (const cls of ["not-injected", "unresolved", "selected", "expanded"]) {
      expect(used.has(cls), `条件类名 ${cls} 没被提取到（提取器只看了静态片段？）`).toBe(true);
    }
    // 变量名不是类名：`filterScope` / `scope` 出现在 className 表达式里，但不能算类名
    const manager = classNamesInComponent(readFileSync(path.join(ROOT, COMPONENTS[1]), "utf8"));
    expect(manager.has("scope"), "表达式里的变量名被当成类名了（提取器过于宽松）").toBe(false);
  });

  it("阴性对照：真删掉一条规则时，这条判据会红（fixture 版）", () => {
    const component =
      '<div className={`mc-entry ${cond ? "selected" : ""}`}><span className="mc-entry-key" /><span className="mc-group-title" /></div>';
    const withRules =
      ".mc-entry { color: red; }\n.mc-entry.selected { color: blue; }\n.mc-entry-key { color: green; }\n.mc-group-title { color: grey; }";
    const withoutRule =
      ".mc-entry { color: red; }\n.mc-entry.selected { color: blue; }\n.mc-entry-key { color: green; }";

    const check = (css: string) =>
      [...classNamesInComponent(component)].filter((c) => !definedClassNames(css).has(c)).sort();

    expect(check(withRules), "规则齐全时不该报缺失").toEqual([]);
    expect(check(withoutRule), "删掉 `.mc-group-title` 规则后必须报出来").toEqual(["mc-group-title"]);
  });
});

// ============================ CSS-CHECKUP-2 ============================

/** 本段新增规则的源码（按边界标记切片） */
function checkupSegment(): string {
  const css = readFileSync(path.join(ROOT, STYLES), "utf8");
  const begin = css.indexOf(SEGMENT_BEGIN);
  const end = css.indexOf(SEGMENT_END);
  expect(begin, `找不到段起点标记 ${SEGMENT_BEGIN}`).toBeGreaterThan(-1);
  expect(end, `找不到段终点标记 ${SEGMENT_END}`).toBeGreaterThan(begin);
  return css.slice(begin + SEGMENT_BEGIN.length, end);
}

/** 一行里所有 `var(...)` 的区间：`var(--x, #fallback)` 的兜底是正当写法，不算写死 */
function varRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    const at = line.indexOf("var(", i);
    if (at < 0) break;
    let j = at + 3;
    let depth = 0;
    do {
      if (line[j] === "(") depth++;
      else if (line[j] === ")") depth--;
      j++;
    } while (j < line.length && depth > 0);
    ranges.push([at, j]);
    i = j;
  }
  return ranges;
}

const COLOR_PROPS = /^(color|background|background-color|border|border-[a-z-]+|outline|outline-color|accent-color|caret-color)$/;
const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap|padding-[a-z]+|margin-[a-z]+)$/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const NAMED_COLOR =
  /(?:^|[\s,:(])(white|black|red|green|blue|gray|grey|orange|purple|pink|yellow|cyan|magenta|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?=[\s,;)]|$)/i;

/**
 * 扫描一段 CSS 里的"写死值"。
 * 口径：字号/字重/圆角/间距的属性值必须走 `var(--…)`；颜色族里除 `var()` 兜底外不许出现颜色字面量。
 */
export function findHardcodedValues(segment: string): string[] {
  const code = segment.replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, " "));
  const problems: string[] = [];
  for (const decl of code.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
    const prop = decl[1].toLowerCase();
    const value = decl[2].trim();
    if (!prop || !value) continue;
    const hasVar = /var\(--/.test(value);

    if (prop === "font-size") {
      // 走令牌还不够：`calc(11px * var(--ui-font-scale))` 这种"半截令牌"不算（数字仍然写死）
      const bareNumber = /(^|[\s(])[0-9.]+(px|rem|pt)\b/.test(value);
      if (!hasVar || bareNumber) problems.push(`font-size: ${value}（必须走 var(--fs-*)）`);
      continue;
    }
    if (prop === "font-weight") {
      if (!/var\(--weight-/.test(value)) problems.push(`font-weight: ${value}（必须走 var(--weight-*)）`);
      continue;
    }
    if (prop === "border-radius" || /^border(-[a-z]+)?-radius$/.test(prop)) {
      if (!hasVar && !/^(0|2px|50%|inherit|initial|unset)$/.test(value)) {
        problems.push(`border-radius: ${value}（必须走 var(--radius*)）`);
      }
      continue;
    }
    if (SPACING_PROPS.test(prop)) {
      const bad = value
        .split(/\s+/)
        .filter((part) => /^-?[0-9.]+px$/.test(part))
        .filter((part) => part !== "0" && part !== "1px" && !part.startsWith("-"));
      if (bad.length) problems.push(`${prop}: ${value}（刻度间距必须走 var(--space-*)）`);
      continue;
    }
    if (COLOR_PROPS.test(prop)) {
      const ranges = varRanges(value);
      const outside = (o: number) => !ranges.some(([s, e]) => o >= s && o < e);
      const hex = COLOR_LITERAL.exec(value);
      const named = NAMED_COLOR.exec(value);
      if ((hex && outside(hex.index)) || (named && outside(named.index))) {
        problems.push(`${prop}: ${value}（颜色必须走语义令牌）`);
      }
    }
  }
  return problems;
}

describe("CSS-CHECKUP-2：新增规则里不许有写死值", () => {
  it("新增段存在、且真的扫到了规则（否则这条判据空转）", () => {
    const segment = checkupSegment();
    const ruleCount = [...segment.matchAll(/\{/g)].length;
    expect(ruleCount, `本段一条规则都没有 ⇒ 段标记或提取失效`).toBeGreaterThan(20);
    expect(segment.includes(".mc-entry"), "本段应包含体检视图的规则").toBe(true);
  });

  it("字号/字重/颜色/圆角/间距全部走令牌", () => {
    const problems = findHardcodedValues(checkupSegment());
    expect(problems, `本段出现写死值：\n  - ${problems.join("\n  - ")}`).toEqual([]);
  });

  it("阴性对照：塞写死值必须被这条判据抓住", () => {
    expect(findHardcodedValues(".x { font-weight: 600; }")).toEqual([
      "font-weight: 600（必须走 var(--weight-*)）",
    ]);
    expect(findHardcodedValues(".x { color: #ffffff; }").length, "裸颜色字面量必须报").toBe(1);
    expect(findHardcodedValues(".x { font-size: 13px; }").length, "裸字号必须报").toBe(1);
    expect(findHardcodedValues(".x { border-radius: 6px; }").length, "裸圆角必须报").toBe(1);
    expect(findHardcodedValues(".x { padding: 12px var(--space-2); }").length, "半截走令牌的间距必须报").toBe(1);
    // 走令牌 + var() 兜底不算写死
    expect(
      findHardcodedValues(".x { font-weight: var(--weight-semibold); color: var(--text-primary, #1f1f1e); }"),
      "走令牌与 var() 兜底都不算写死",
    ).toEqual([]);
  });
});
