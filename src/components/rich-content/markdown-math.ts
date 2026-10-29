/**
 * KaTeX 的**按需加载壳**（第 233 轮审计 · 冷启动）。
 *
 * ## 为什么单独一个文件
 *
 * `rehype-katex` + `katex` + `katex.min.css` 一共约 270KB（主包的 7%），
 * 而绝大多数消息里没有公式。把它们放进这个模块，让 `RichContent` 用
 * **动态 `import()`** 拉取，Vite 就会把它切成独立 chunk：
 * 只有真的出现数学消息时才下载一次。
 *
 * ## 代价（如实记）
 *
 * 带公式的消息第一次出现时，会先按"没有数学插件"的方式渲染一帧（`$…$` 原样显示），
 * chunk 到了再重新渲染成公式。这个闪动**只影响带公式的消息**，
 * 且全应用只发生一次（chunk 之后进入模块缓存）。
 */
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// KaTeX CSS 走本地打包（CSP 不允许 CDN）；它随本 chunk 一起按需注入
import "katex/dist/katex.min.css";

/** 给 `RichContent` 用：拿到插件后塞进 `remarkPlugins` / `rehypePlugins` */
export const mathRemarkPlugins = [remarkMath];
export const mathRehypePlugins = [rehypeKatex];
