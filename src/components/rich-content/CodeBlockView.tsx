/**
 * CodeBlockView — 代码块视图
 *
 * 在 ContentFrame 内渲染语法高亮代码块。
 * 复用项目已有的 react-syntax-highlighter。
 */

import { memo, useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { ContentFrame } from "./ContentFrame";
import { getSetting } from "../../core/storage/settings";

interface CodeBlockViewProps {
  code: string;
  language: string;
  /** 是否流式渲染中 */
  streaming?: boolean;
  /** 是否可折叠 */
  collapsible?: boolean;
}

export const CodeBlockView = memo(function CodeBlockView({
  code,
  language,
  streaming = false,
  collapsible = true,
}: CodeBlockViewProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const theme = (typeof getSetting === "function" ? getSetting("codem-theme") : "dark") as string;
  const isDark = theme !== "light";

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
  }, [code]);

  const lineCount = code.split("\n").length;
  const shouldCollapse = collapsible && lineCount > 20;

  if (fullscreen) {
    return (
      <div className="content-fullscreen-backdrop" onClick={() => setFullscreen(false)}>
        <div className="content-fullscreen" onClick={(e) => e.stopPropagation()}>
          <div className="content-fullscreen-header">
            <span className="content-fullscreen-title">{language || "code"}</span>
            <button className="content-fullscreen-close" onClick={() => setFullscreen(false)}>✕</button>
          </div>
          <div className="content-fullscreen-body">
            <SyntaxHighlighter
              language={language || "text"}
              style={isDark ? oneDark : oneLight}
              customStyle={{
                margin: 0,
                padding: "16px",
                background: "transparent",
                fontSize: "13px",
                lineHeight: "1.6",
              }}
              showLineNumbers={lineCount > 5}
              wrapLongLines
            >
              {code}
            </SyntaxHighlighter>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ContentFrame
      title={language || "text"}
      badge={`${lineCount} 行`}
      collapsible={shouldCollapse}
      defaultCollapsed={shouldCollapse && lineCount > 40}
      onCopy={handleCopy}
      fullscreenable
      onFullscreen={() => setFullscreen(true)}
      className={`code-block-view ${streaming ? "streaming" : ""}`}
    >
      <SyntaxHighlighter
        language={language || "text"}
        style={isDark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          padding: "12px 14px",
          background: "transparent",
          fontSize: "13px",
          lineHeight: "1.6",
          borderRadius: "0 0 8px 8px",
        }}
        showLineNumbers={lineCount > 5}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </ContentFrame>
  );
});
