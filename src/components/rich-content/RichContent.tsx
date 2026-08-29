/**
 * RichContent — 统一富内容 Markdown 渲染器
 *
 * 基于 react-markdown，集成以下富内容视图：
 * - 代码块（语法高亮 + 复制 + 折叠 + 全屏）
 * - 表格（滚动 + 行列统计）
 * - Mermaid 图表（渲染 + 全屏）
 * - 数学公式（KaTeX 渲染）
 * - 图片（预览 + 全屏）
 * - JSON（格式化 + 复制）
 * - HTML（沙箱预览）
 *
 * 支持流式文本揭示动画。
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 *
 * 自主实现，组件命名和逻辑均独立编写。
 */

import { memo, useState, useCallback, useRef, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Copy, Check, Quote } from "lucide-react";
import { CodeBlockView } from "./CodeBlockView";
import { TableScrollView } from "./TableScrollView";
import { MermaidCanvasView } from "./MermaidCanvasView";
import { ImagePreviewView } from "./ImagePreviewView";
import { fixCjkBoldMarkdown } from "../../core/llm/stream-reveal";
import { handleFileLinkClick, handleFileLinkContextMenu } from "../../utils/file-link";
import type { FileMentions } from "../../utils/file-mentions";

/**
 * ParagraphWithActions — P2 #31: 段落级 hover 操作按钮
 *
 * 在鼠标悬停段落时显示复制和引用按钮。
 */

const ParagraphWithActions = memo(function ParagraphWithActions({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const pRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(() => {
    const text = pRef.current?.textContent || "";
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleQuote = useCallback(() => {
    const text = pRef.current?.textContent || "";
    // Dispatch a custom event that SelectionTooltip / ChatPanel can listen to
    const selection = window.getSelection();
    if (selection) {
      // Use the QuoteProvider mechanism via custom event
      window.dispatchEvent(new CustomEvent("rich-content-quote", { detail: { text } }));
    }
  }, []);

  return (
    <div className="rich-content-p" ref={pRef}>
      {children}
      <span className="paragraph-actions" contentEditable={false}>
        <button
          className="paragraph-action-btn"
          onClick={handleCopy}
          title="复制段落"
          aria-label="复制段落"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          className="paragraph-action-btn"
          onClick={handleQuote}
          title="引用段落"
          aria-label="引用段落"
        >
          <Quote size={12} />
        </button>
      </span>
    </div>
  );
});

// 延迟加载 KaTeX CSS（避免首屏加载开销）
let katexCssLoaded = false;
function ensureKatexCss() {
  if (katexCssLoaded) return;
  katexCssLoaded = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}

export interface RichContentProps {
  /** Markdown 内容 */
  content: string;
  /** 是否流式渲染中 */
  streaming?: boolean;
  /** 流式揭示尾部字素数 */
  revealCount?: number;
  /** 流式揭示修订号 */
  revealRevision?: number;
  /** 自定义类名 */
  className?: string;
  /** 文件提及解析器：基于本轮工具调用记录，将 inline code 中的文件名解析为可点击链接 */
  fileMentions?: FileMentions | null;
}

export const RichContent = memo(function RichContent({
  content,
  streaming = false,
  revealCount = 0,
  revealRevision = 0,
  className = "",
  fileMentions = null,
}: RichContentProps) {
  const [fullscreenNode, setFullscreenNode] = useState<ReactNode | null>(null);

  // 确保 KaTeX CSS 已加载（当内容包含数学公式时）
  if (/\$\$|\\\(|\\\[/.test(content)) {
    ensureKatexCss();
  }

  // P2 #33: 判断内联代码是否为"单个单词或短词组"
  // 如果是，降级为普通文本样式，不渲染代码框
  const isSimpleInlineTerm = useCallback((text: string): boolean => {
    return text.length <= 80 &&
      !text.includes("\n") &&
      !text.includes(";") &&
      !text.includes("{") &&
      !text.includes("}") &&
      !text.includes("|") &&
      !text.includes("=>") &&
      !text.includes("==") &&
      !text.includes("!=") &&
      !text.includes("//") &&
      !text.includes("/*") &&
      !(text.includes("(") && text.includes(")"));
  }, []);

  // P2 #30: 修复 CJK 粗体标记 — CommonMark 在 `**粗体**` 后紧跟 CJK 字符时不渲染粗体
  const processedContent = useMemo(() => fixCjkBoldMarkdown(content), [content]);

  // 代码块渲染器
  const codeRenderer = useCallback(({ inline, className: cls, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(cls || "");
    const language = match ? match[1] : "";
    const code = String(children).replace(/\n$/, "");

    // Mermaid 图表
    if (language === "mermaid") {
      return <MermaidCanvasView chart={code} />;
    }

    // JSON 视图
    if (language === "json" && code.length > 50) {
      try {
        JSON.parse(code);
        return <CodeBlockView code={code} language="json" streaming={streaming} />;
      } catch {
        // 非法 JSON，走普通代码块
      }
    }

    // 内联代码 — 对单个单词/短词组降级为普通文本样式
    // LLM 常用反引号包裹工具名、文件名等单个词组（如 `read`、`bash`），
    // 这些不需要代码框样式，渲染为普通文本即可（保留等宽字体但不带背景框）
    if (inline) {
      const text = String(children);

      // ─── 方案 B：DSH 风格的 file-mention 解析 ───
      // 优先使用上层传入的 fileMentions resolver（基于本轮工具调用记录），
      // 如果 inline code 的值能解析为实际创建/修改的文件，就变成可点击按钮。
      // 这比正则猜测更安全：只链接确实被创建/修改过的文件。
      if (fileMentions && !streaming) {
        const mention = fileMentions.resolve(text.trim());
        if (mention !== undefined) {
          return (
            <code className="inline-code file-mention-code" {...props}>
              <button
                type="button"
                className="file-mention-btn"
                title={mention.title}
                aria-label={mention.label}
                onClick={mention.open}
                style={{ cursor: "pointer", background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", textDecoration: "underline", textDecorationStyle: "dashed", textUnderlineOffset: "2px" }}
              >
                {children}
              </button>
            </code>
          );
        }
      }

      // ─── 兜底：正则扩展名匹配（当没有 fileMentions 或未命中时） ───
      // e.g., xxx.md, src/index.ts, config.json, ./path/file.py
      const knownExtensions = /\.(md|txt|json|yaml|yml|ts|tsx|js|jsx|mjs|py|sh|bat|ps1|css|html|svg|png|jpg|jpeg|gif|toml|ini|cfg|rs|go|java|c|cpp|h|hpp|sql|xml|csv|log|env|lock|gitignore|dockerfile)$/i;
      const isFilePath = knownExtensions.test(text.trim()) &&
        !text.includes(" ") && text.length < 200;
      if (isFilePath) {
        return (
          <a
            href={text}
            onClick={(e) => handleFileLinkClick(e, text)}
            onContextMenu={(e) => handleFileLinkContextMenu(e, text)}
            className="rich-content-link file-path-link inline-file-link"
            title={`点击打开: ${text}`}
            style={{ cursor: "pointer" }}
          >
            <code className="inline-code" {...props}>{children}</code>
          </a>
        );
      }
      // 判断是否为"单个单词或短词组"：不含换行、不含分号/大括号/管道符等代码结构
      const isSimpleWord = isSimpleInlineTerm(text);
      if (isSimpleWord) {
        // 单个单词/词组：渲染为普通文本，不带代码框样式
        return (
          <span className="inline-term" {...props}>
            {children}
          </span>
        );
      }
      // 真正的内联代码表达式：保留代码样式
      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      );
    }

    // 块级代码块 — 如果只有 1 行且是简单词组，也降级为内联文本
    // LLM 有时用三反引号围栏包裹单个单词（如 ```read```），这会被解析为块级代码
    if (!inline && !language && code.split("\n").length === 1) {
      const text = code.trim();
      if (isSimpleInlineTerm(text)) {
        return (
          <span className="inline-term" {...props}>
            {text}
          </span>
        );
      }
    }

    // 普通代码块
    return <CodeBlockView code={code} language={language} streaming={streaming} />;
  }, [streaming, fileMentions]);

  // 表格渲染器
  const tableRenderer = useCallback(({ children }: any) => {
    // 从 children 提取 headers 和 rows
    let headers: string[] = [];
    let rows: string[][] = [];

    const extractText = (node: any): string => {
      if (typeof node === "string") return node;
      if (node?.props?.children) {
        if (Array.isArray(node.props.children)) {
          return node.props.children.map(extractText).join("");
        }
        return extractText(node.props.children);
      }
      return "";
    };

    const walk = (node: any) => {
      if (!node) return;
      const tag = node?.type;
      if (tag === "thead") {
        const tr = node.props?.children;
        if (Array.isArray(tr)) {
          const trNode = tr.find((c: any) => c?.type === "tr");
          if (trNode?.props?.children) {
            headers = (Array.isArray(trNode.props.children) ? trNode.props.children : [trNode.props.children])
              .map((th: any) => extractText(th));
          }
        }
      }
      if (tag === "tbody") {
        const trs = node.props?.children;
        if (Array.isArray(trs)) {
          rows = trs.filter((c: any) => c?.type === "tr").map((tr: any) => {
            const tds = Array.isArray(tr.props?.children) ? tr.props.children : [tr.props.children];
            return tds.map((td: any) => extractText(td));
          });
        }
      }
      if (node?.props?.children && Array.isArray(node.props.children)) {
        node.props.children.forEach(walk);
      }
    };

    if (Array.isArray(children)) {
      children.forEach(walk);
    }

    if (headers.length > 0) {
      return <TableScrollView headers={headers} rows={rows} />;
    }

    // 降级：使用原生 table
    return <table className="content-table-fallback">{children}</table>;
  }, []);

  // 图片渲染器
  const imageRenderer = useCallback(({ src, alt, title }: any) => {
    if (typeof src === "string") {
      return <ImagePreviewView src={src} alt={alt || ""} title={title} />;
    }
    return <img src={src} alt={alt} title={title} />;
  }, []);

  return (
    <div
      className={`rich-content ${streaming ? "streaming" : ""} ${className}`}
      data-reveal-count={revealCount}
      data-reveal-revision={revealRevision}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code: codeRenderer,
          table: tableRenderer,
          img: imageRenderer,
          // 流式文本揭示：在最后一个文本节点尾部添加动画类
          p: ({ children }) => (
            <ParagraphWithActions>{children}</ParagraphWithActions>
          ),
          // 链接：文件路径通过 Tauri 打开文件管理器，外部 URL 在浏览器打开
          a: ({ href, children, ...props }) => {
            const isExternal = href && (/^https?:\/\//i.test(href) || /^mailto:/i.test(href));
            if (isExternal) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" className="rich-content-link" {...props}>
                  {children}
                </a>
              );
            }
            // File path — intercept click and context menu
            return (
              <a
                {...props}
                href={href}
                onClick={(e) => handleFileLinkClick(e, href || "")}
                onContextMenu={(e) => handleFileLinkContextMenu(e, href || "")}
                className="rich-content-link file-path-link"
                title={`点击打开文件位置: ${href}`}
              >
                {children}
              </a>
            );
          },
          // 引用块样式
          blockquote: ({ children }) => (
            <blockquote className="rich-content-quote">{children}</blockquote>
          ),
          // 水平线
          hr: () => <hr className="rich-content-hr" />,
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});
