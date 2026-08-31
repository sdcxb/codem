/**
 * PPT 数学公式渲染 (P2-6)
 *
 * 使用 KaTeX 将 LaTeX 公式渲染为 HTML。
 * 支持 $...$ (行内) 和 $$...$$ (块级) 语法。
 */

import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * 将文本中的 LaTeX 公式渲染为 HTML
 * 支持 $...$ (行内) 和 $$...$$ (块级) 语法
 */
export function renderMath(content: string): string {
  // 先处理块级 $$...$$
  let result = content.replace(/\$\$(.+?)\$\$/g, (_, expr) => {
    try {
      return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return `$$${expr}$$`;
    }
  });

  // 再处理行内 $...$ (不匹配已处理的块级)
  result = result.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_, expr) => {
    try {
      return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return `$${expr}$`;
    }
  });

  return result;
}

/**
 * 检查文本是否包含数学公式
 */
export function hasMath(content: string): boolean {
  return /\$\$.+?\$\$|\$.+?\$/.test(content);
}
