/**
 * 「图标按钮必须有可访问名」扫描器（**唯一实现**）
 *
 * ## 为什么单独一个文件
 *
 * 同一条规则有两个使用者：门禁 `src/test/icon-button-a11y.test.ts`（判据）
 * 与审计脚本 `.preview-shot/audit-icon-buttons.mjs`（看清单）。
 * 规则写两遍必然漂 —— 本仓库已经吃过这个亏很多次 —— 所以收在这里，两边都 import 它。
 *
 * ## 为什么不用正则截开始标签（踩过的坑）
 *
 * 第一版用 `<button\b([\s\S]*?)>` 取"属性区"，而 `onClick={() => …}` 里的 `=>` 带着 `>`：
 * 非贪婪正则在**箭头函数的 `>`** 处就截断了 ⇒ 属性区不完整、内容区从半截开始，
 * 于是"有可见文字"被误判（把 `foo()}` 当成文字）⇒ **大量漏报**（审计当时只报 55 处，
 * 而按正确的标签扫描是 80+）。现在按字符扫描：跳过引号里的内容、跟踪花括号深度，只在**顶层**的 `>` 收尾。
 *
 * ## 判定规则
 *
 * 一个 `<button>` 只要满足下面三条，就算"只有图标、没有可访问名"：
 * 1. 开始标签里没有 `aria-label` / `aria-labelledby` / `title`；
 * 2. 内容是**图标**：含 `<svg` 或 `<\大写组件…`（lucide 图标组件就是这种）；
 * 3. 内容里**没有可见文字**（去掉标签与 `{…}` 表达式后为空）。
 *
 * ## 边界（如实写）
 *
 * - 内容若是 `{children}` / `{icon}` 这类**动态**表达式，无法知道画的是什么 ⇒ **不报**
 *   （宁可漏报，也不要误报到让人去改本来就对的代码）；
 * - 不做 `aria-hidden` / 复杂嵌套的完全解析；它是"发现线索"的工具，不是合规判定。
 */
import fs from "node:fs";
import path from "node:path";

/** 生产源码树（排除测试与技能自带脚本） */
export function prodTsx(root) {
  const out = [];
  const stack = ["src"];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "src/test" || e.name === "node_modules") continue;
        if (rel === "src/core/skills/skill-creator/scripts") continue;
        stack.push(rel);
      } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/** 找 `<button` 开始标签的边界（跳过引号与花括号里的 `>`） */
export function buttonTags(code) {
  const out = [];
  const re = /<button\b/g;
  let m;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    let quote = null;
    let brace = 0;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === quote && code[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") { brace++; continue; }
      if (c === "}") { brace--; continue; }
      if (c === ">" && brace === 0) break;
    }
    out.push({ start: m.index, end: i + 1, tag: code.slice(m.index, i + 1) });
  }
  return out;
}

/** 取 className 的字面量值（模板串与花括号字符串都能取；动态拼接取不到就返回 ""） */
export function classNameOf(tag) {
  return /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/.exec(tag)?.slice(1).find(Boolean) ?? "";
}

/**
 * 去掉 JSX **标签**（保留花括号表达式的内容），跳过引号与嵌套花括号。
 *
 * 为什么要自己走一遍字符：`/<[^>]+>/g` 会在属性里的 `=>`（`onClick={() => …}`）
 * 或 `size={12}` 这类地方截错，也会把 `<></>` 片段当成标签删掉。
 */
function stripJsxTags(body) {
  const ranges = [];
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "<") {
      out += c;
      continue;
    }
    // 标签开始：`<` 后面是字母 / `/` / `>`（片段）
    const next = body[i + 1] ?? "";
    if (!/[A-Za-z/>]/.test(next)) {
      out += c;
      continue;
    }
    let j = i + 1;
    let quote = null;
    let brace = 0;
    for (; j < body.length; j++) {
      const d = body[j];
      if (quote) {
        if (d === quote && body[j - 1] !== "\\") quote = null;
        continue;
      }
      if (d === '"' || d === "'" || d === "`") {
        quote = d;
        continue;
      }
      if (d === "{") brace++;
      else if (d === "}") brace--;
      else if (d === ">" && brace === 0) break;
    }
    ranges.push([i, j]);
    i = j; // 跳过整个标签
  }
  return { skeleton: out, ranges };
}

/** 取花括号表达式的内容（**嵌套花括号也算对**；跳过引号里的 `{}`），并带上起始位置 */
function braceExpressionsWithPos(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let quote = null;
    let j = i;
    for (; j < text.length; j++) {
      const d = text[j];
      if (quote) {
        if (d === quote && text[j - 1] !== "\\") quote = null;
        continue;
      }
      if (d === '"' || d === "'" || d === "`") {
        quote = d;
        continue;
      }
      if (d === "{") depth++;
      else if (d === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ text: text.slice(i + 1, j), start: i });
    i = j;
  }
  return out;
}

/**
 * 按钮内容：只有图标、且没有可见文字？（**含字符串字面量的表达式算文字**）
 *
 * ⚠️ 第 85 轮修正的**第三类误报**：第一版把 `{…}` 一律当"没有文字"，
 * 于是 `{isZh ? '选择文件' : 'Choose File'}`、`{S.cicd.refresh[lang]}`、
 * `{zh ? "返回列表" : "Back to list"}` 这类**会渲染出文字**的表达式被当成"只有图标" ⇒
 * 把一堆**本来就有可见文字**的按钮报成"无名图标按钮"（第 84 轮的 156 里含这一批）。
 *
 * ⚠️ 第 91 轮修正的**第四类误报**（这一轮做 O-4 时抓到的）：
 * ① **非字面量的表达式**也会渲染出文字 —— `{item.title}` / `{S.ollama.save[lang]}`，
 *    旧判据只看"字面量"，于是把它们当"没有文字"报了出来（而它们**本来就有可见文字**，
 *    给它加 `aria-label` 反而会**盖掉**读屏要念的那段文字，是负优化）；
 * ② **嵌套花括号**（`{a === b ? <><Clock size={12}/> 恢复中...</> : …}`）会让
 *    `/\{[^}]*\}/g` 在第一个 `}`（`size={12}` 的）处截断 ⇒ 里面的字面量扫不到 ⇒ 又误报。
 *
 * 现在的判定（与本文件开头「边界」那段一致：**宁可漏报，也不误报**）：
 * - 标签外还有非空白文字 → 有文字；
 * - 花括号表达式里**不含 JSX 且非空**（`{item.title}` / `{count}` / `{fn()}`）→ 视为**不可判定**，
 *   按"可能有文字"处理 ⇒ **不报**；
 * - 花括号表达式里的**字符串字面量** → 有文字（含嵌套花括号里那些）；
 * - 只有当表达式**整体是 JSX**（`{playing ? <Pause/> : <Play/>}`）且没有任何字面量时才认定"只有图标"。
 */
export function bodyHasVisibleText(body) {
  const { skeleton, ranges } = stripJsxTags(body);
  const outside = skeleton.replace(/\{[^}]*\}/g, "").trim();
  if (outside.replace(/\s+/g, "").length > 0) return true;
  /**
   * ⚠️ 表达式要在**原始 body** 上取（不是在 skeleton 上）：因为"这段表达式是不是 JSX"
   * 正是判据之一，而 skeleton 已经把 JSX 删掉了（第一版就栽在这里：
   * `{playing ? <Pause/> : <Play/>}` 被删成 `{playing ?  : }`，于是它看起来"像文字" ⇒ 漏报）。
   * 同时要跳过**落在标签内部**的 `{…}`（例如 `<Icon size={20} />` 的 `size={20}`）。
   */
  const inTag = (pos) => ranges.some(([a, b]) => pos >= a && pos <= b);
  for (const { text: expr, start } of braceExpressionsWithPos(body)) {
    if (inTag(start)) continue;
    const hasJsx = /<\s*[A-Za-z/>]/.test(expr);
    if (!hasJsx && expr.trim().length > 0) return true; // {item.title} / {count} / {fn()}：不可判定 ⇒ 当有文字
    for (const lit of expr.matchAll(/['"`]([^'"`]{1,80})['"`]/g)) {
      if (lit[1].trim().length > 0) return true;
    }
    if (hasJsx && jsxTextNodeIn(expr)) return true;
  }
  return false;
}

/**
 * 含 JSX 的表达式里，有没有**渲染出来的文字**？
 *
 * 这里要区分两样东西（第 91 轮踩的坑）：
 * - JSX 的**文本节点**：`<>恢复中...</>` 里的「恢复中...」——它**会显示给用户**；
 * - JS 的**代码**：`playing ? <Pause/> : <Play/>` 里的条件与 `?:` 运算符 —— 它不显示。
 *
 * 判据：取 `>` 与下一个 `<` 之间的片段（那是 JSX 文本节点的位置），去掉其中的 `{…}` 后，
 * 若还剩下**字母或汉字且不含代码运算符（`? : = & |`）**，就认定是文字。
 * （`> : <` 这种三元运算符的间隔因此被排除，而 `> 恢复中...<` 被认出来。）
 */
function jsxTextNodeIn(expr) {
  for (const m of expr.matchAll(/>([^<]*)</g)) {
    let seg = m[1];
    // 去掉片段里的 {…}（那是 JS 表达式，由上面的规则单独判）
    for (const region of braceExpressionsWithPos(seg).reverse()) {
      seg = seg.slice(0, region.start) + seg.slice(region.start + region.text.length + 2);
    }
    if (/[?::=&|]/.test(seg)) continue;
    if (/[\p{L}]/u.test(seg)) return true;
  }
  return false;
}

export function isIconOnlyBody(code, from) {
  const end = code.indexOf("</button>", from);
  if (end < 0) return false;
  const body = code.slice(from, end);
  if (bodyHasVisibleText(body)) return false;
  return /<svg\b/.test(body) || /<[A-Z][A-Za-z0-9_]*(\s*\/>|\b)/.test(body);
}

/** 有没有可访问名（属性层面） */
export function hasAccessibleName(tag) {
  return /aria-label\s*=|aria-labelledby\s*=|\btitle\s*=/.test(tag);
}

/** 全量扫描：返回"只有图标、且没有任何可访问名"的按钮 */
export function scanNamelessIconButtons(root) {
  const findings = [];
  for (const rel of prodTsx(root)) {
    const code = fs.readFileSync(path.join(root, rel), "utf8");
    for (const b of buttonTags(code)) {
      if (hasAccessibleName(b.tag)) continue;
      if (!isIconOnlyBody(code, b.end)) continue;
      findings.push({
        rel,
        line: code.slice(0, b.start).split(/\r?\n/).length,
        cls: classNameOf(b.tag),
      });
    }
  }
  return findings;
}
