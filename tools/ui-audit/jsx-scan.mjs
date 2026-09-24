/**
 * JSX 扫描的**共用底层**（第 95 轮抽出来；三个扫描器踩过同一个坑，不该再各写一份）。
 *
 * ## 为什么必须共用
 *
 * `onChange={() => f()}` / `onClick={() => x}` 里的 **`=>` 带一个 `>`**。
 * 用 `/<button\b([\s\S]*?)>/` 或 `/<input\b[^>]*>/` 这类朴素正则，会在箭头函数处**截断**：
 *  - 第 84 轮：icon-button 扫描器因此把属性区截半 ⇒ 漏报（报 55 处，真实 195 处）；
 *  - 第 95 轮：labeled-inputs 扫描器因此**看不到 `onChange` 之后的 `aria-label`** ⇒ 把有名字的
 *    复选框误报成没名字（M1 变异又把它试出来一次）。
 *
 * 所以"取一个开始标签的边界"只写一份：**跳过引号、跟踪花括号深度，只在顶层 `>` 收尾**。
 *
 * ## 用法
 *
 *   import { findTags, stripJsxTags } from "./jsx-scan.mjs";
 *   for (const t of findTags(code, "input")) { t.tag / t.start / t.end / t.line }
 *   const text = stripJsxTags("<b>{a => b()}</b>");  // 去掉标签，保留表达式内容
 */

/** 取某个标签名的所有**开始标签**（大小写敏感；自闭合与普通标签都认） */
export function findTags(code, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b`, "g");
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
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") {
        brace++;
        continue;
      }
      if (c === "}") {
        brace--;
        continue;
      }
      if (c === ">" && brace === 0) break;
    }
    out.push({
      start: m.index,
      end: i + 1,
      tag: code.slice(m.index, i + 1),
      line: code.slice(0, m.index).split(/\r?\n/).length,
    });
  }
  return out;
}

/** 去掉 JSX 标签（跳过引号与花括号，`=>` 不会截断），保留 `{...}` 表达式的内容 */
export function stripJsxTags(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "<") {
      out += c;
      continue;
    }
    let j = i + 1;
    let quote = null;
    let brace = 0;
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
      if (d === "{") brace++;
      else if (d === "}") brace--;
      else if (d === ">" && brace === 0) break;
    }
    i = j;
  }
  return out;
}
