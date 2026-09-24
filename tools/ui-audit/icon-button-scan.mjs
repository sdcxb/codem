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
 * 按钮内容：只有图标、且没有可见文字？（**含字符串字面量的表达式算文字**）
 *
 * ⚠️ 第 85 轮修正的**第三类误报**：第一版把 `{…}` 一律当"没有文字"，
 * 于是 `{isZh ? '选择文件' : 'Choose File'}`、`{S.cicd.refresh[lang]}`、
 * `{zh ? "返回列表" : "Back to list"}` 这类**会渲染出文字**的表达式被当成"只有图标" ⇒
 * 把一堆**本来就有可见文字**的按钮报成"无名图标按钮"（第 84 轮的 156 里含这一批）。
 *
 * 现在的判定：
 * - 标签外的字面文字 → 有文字；
 * - `{…}` 表达式里的**字符串字面量** → 也算文字（`{icon}`、`{count}` 这类没有字面量的才算"不可判定"）；
 * - 不可判定 + 有图标 ⇒ 报（宁可漏报，也不误报）。
 */
export function bodyHasVisibleText(body) {
  const outside = body.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
  if (outside.length > 0) return true;
  for (const expr of body.matchAll(/\{[^}]*\}/g)) {
    for (const lit of expr[0].matchAll(/['"`]([^'"`]{1,80})['"`]/g)) {
      if (lit[1].trim().length > 0) return true;
    }
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
