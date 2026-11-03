/**
 * 共享消息 Markdown 渲染（第 1 步：从桌面 `MessageBubble` 抽出纯展示层）。
 *
 * 抽出的边界：
 * - **共享**：react-markdown 的组件映射（代码块外壳、引用上标、链接、图片、hr）、
 *   危险协议过滤、Mermaid 图表的默认渲染；
 * - **注入**：代码高亮器（桌面仍用 Shiki，移动端可换 Prism/纯文本）、
 *   点击回调（文件链接在桌面走 Tauri，在其它宿主可以走自己的实现）、
 *   引用点击回调；
 * - 不依赖桌面 store / Tauri invoke / 桌面 React context，宿主数据全部由 props 进入。
 *
 * 这样桌面气泡与后续的移动端气泡只保留**一套** Markdown 渲染逻辑，
 * 而不是两边各抄一份 `urlTransform` / code block / citation 处理。
 */
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";

import { MermaidDiagram } from "./mermaid-diagram";

/** 与桌面 `MessageBubble` 原先的 urlTransform **逐字一致**（危险协议丢弃）。 */
export function messageMarkdownUrlTransform(url: string): string {
  if (url.startsWith("file://")) return url;
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const proto = url.slice(0, colon);
  if (/^(https?|ircs?|mailto|xmpp)$/i.test(proto)) return url;
  return "";
}

export interface MessageCodeBlockProps {
  code: string;
  language: string;
  /** 复制按钮文案（由宿主按语言注入） */
  copyLabel?: string;
  /**
   * 代码高亮器。桌面注入 Shiki；不注入时用无高亮的 `<pre>`，
   * 保证共享层不把 Shiki/WASM 变成移动端的硬依赖。
   */
  renderHighlight?: (code: string, language: string) => React.ReactNode;
}

/**
 * 代码块外壳（标题 + 复制按钮）的**唯一**实现。
 * 桌面原来的 DOM 结构逐字保留（`.code-block` / `.code-header` / `.copy-btn`）。
 */
export const MessageCodeBlock = memo(function MessageCodeBlock({
  code,
  language,
  copyLabel = "Copy",
  renderHighlight,
}: MessageCodeBlockProps) {
  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language}</span>
        <button
          className="copy-btn"
          onClick={() => navigator.clipboard.writeText(code)}
        >
          {copyLabel}
        </button>
      </div>
      {renderHighlight ? (
        renderHighlight(code, language)
      ) : (
        <pre className="code-block-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});

export interface MessageMarkdownProps {
  content: string;
  /** 复制按钮文案（桌面传 `S.bubble.copy[lang]`） */
  copyLabel?: string;
  /** 代码高亮器（桌面传 Shiki） */
  renderHighlight?: (code: string, language: string) => React.ReactNode;
  /** 图表渲染器；缺省用共享 `MermaidDiagram` */
  renderDiagram?: (chart: string) => React.ReactNode;
  /** 点击 `#cite-N` 引用时回调（参数是 title 里的来源名） */
  onCitationClick?: (sourceName: string) => void;
  /** 普通链接点击；桌面注入 `handleFileLinkClick`（签名与桌面工具函数一致） */
  onLinkClick?: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
  /** 普通链接右键菜单；桌面注入 `handleFileLinkContextMenu` */
  onLinkContextMenu?: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}

/**
 * 消息正文 Markdown。
 *
 * 与桌面原实现保持同一套 DOM/类名/行为；不额外包 wrapper，
 * 因此 `.message-content` 下的结构不变。
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  copyLabel,
  renderHighlight,
  renderDiagram,
  onCitationClick,
  onLinkClick,
  onLinkContextMenu,
}: MessageMarkdownProps) {
  const components = useMemo(() => {
    const diagram =
      renderDiagram ?? ((chart: string) => <MermaidDiagram chart={chart} />);

    return {
      code({ className, children, ...props }: any) {
        const match = /language-(\w+)/.exec(className || "");
        const codeStr = String(children).replace(/\n$/, "");
        if (match) {
          // B6: Render mermaid diagrams inline
          if (match[1] === "mermaid") {
            return diagram(codeStr);
          }
          return (
            <MessageCodeBlock
              code={codeStr}
              language={match[1]}
              copyLabel={copyLabel}
              renderHighlight={renderHighlight}
            />
          );
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      // Also detect file paths in inline code for user messages
      // (assistant messages use RichContent which has its own file path detection)
      a({ href, children, ...props }: any) {
        // P1-2: Handle citation links
        if (href && href.startsWith("#cite-")) {
          const sourceName = props.title || "";
          return (
            <sup
              className="nb-citation-link"
              title={sourceName}
              onClick={(e) => {
                e.preventDefault();
                if (onCitationClick) {
                  onCitationClick(sourceName);
                } else {
                  // Fallback: toggle a visual indicator
                  const el = e.currentTarget;
                  el.classList.toggle("active");
                }
              }}
              style={{ cursor: "pointer" }}
            >
              {children}
            </sup>
          );
        }
        return (
          <a
            {...props}
            href={href}
            onClick={(e: React.MouseEvent<HTMLAnchorElement>) => onLinkClick?.(e, href || "")}
            onContextMenu={(e: React.MouseEvent<HTMLAnchorElement>) => onLinkContextMenu?.(e, href || "")}
            style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
          >
            {children}
          </a>
        );
      },
      img({ src, alt, ...props }: any) {
        return (
          <img
            src={src}
            alt={alt || ""}
            {...props}
            style={{ maxWidth: "100%", borderRadius: "var(--radius)", marginTop: 8, marginBottom: 8 }}
            onError={(e) => {
              console.error("[Image render error]", alt, src?.substring(0, 50));
            }}
          />
        );
      },
      hr() {
        return <div className="unified-separator" />;
      },
    };
  }, [copyLabel, renderHighlight, renderDiagram, onCitationClick, onLinkClick, onLinkContextMenu]);

  return (
    <ReactMarkdown
      urlTransform={messageMarkdownUrlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});
