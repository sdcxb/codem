/**
 * CodeBlockView — 代码块视图
 *
 * 在 ContentFrame 内渲染语法高亮代码块。
 * 复用项目已有的 react-syntax-highlighter。
 */

import { memo, useState, useCallback, useEffect } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { ensurePrismLanguagesRegistered, resolvePrismLanguage } from "./prism-languages";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { ContentFrame } from "./ContentFrame";
import { getSetting } from "../../core/storage/settings";
import { ActionIcons } from "../../core/icons/icon-map";

ensurePrismLanguagesRegistered();

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
  /**
   * 第 233 轮审计：`PrismLight` 只认**已注册**的语言名。
   * 别名（`ts` / `sh` / `yml` …）与未注册语言都归一到"已注册 or undefined"；
   * undefined ⇒ 渲染纯文本（`COLD-4` 钉着"不抛、要能显示"）。
   */
  const resolvedLanguage = resolvePrismLanguage(language);
  const CloseIcon = ActionIcons.close;
  const theme = typeof getSetting === "function" ? getSetting("codem-theme") : null;
  const [dataTheme, setDataTheme] = useState<string>(() =>
    typeof document === "undefined" ? "dark" : (document.documentElement.getAttribute("data-theme") || "dark"),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDataTheme(root.getAttribute("data-theme") || "dark");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  // 第 36 波：默认档位改为浅色；data-theme 是主题切换后的权威值。
  const isDark = theme === "hub" ? true : dataTheme !== "light";

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
  }, [code]);

  const lineCount = code.split("\n").length;
  const shouldCollapse = collapsible && lineCount > 20;

  // P1: 流式期间代码块降级为纯文本 pre，跳过 SyntaxHighlighter 高亮。
  // 代码块是流式渲染的最热点：Prism 高亮 + 行号 + wrapLongLines 对每次增量
  // 都全量重建。流式时用 pre 显示原始文本，流结束后（streaming=false）
  // 才执行一次完整高亮。
  if (streaming && !fullscreen) {
    return (
      <ContentFrame
        title={language || "text"}
        badge={`${lineCount} 行`}
        collapsible={false}
        onCopy={handleCopy}
        className={`code-block-view code-block-streaming ${streaming ? "streaming" : ""}`}
      >
        <pre className="code-block-streaming-pre">{code}</pre>
      </ContentFrame>
    );
  }

  if (fullscreen) {
    return (
      <div className="content-fullscreen-backdrop" onClick={() => setFullscreen(false)}>
        <div className="content-fullscreen" onClick={(e) => e.stopPropagation()}>
          <div className="content-fullscreen-header">
            <span className="content-fullscreen-title">{language || "code"}</span>
            <button aria-label="关闭" title="关闭" className="content-fullscreen-close" onClick={() => setFullscreen(false)}><CloseIcon size={16} /></button>
          </div>
          <div className="content-fullscreen-body">
            <SyntaxHighlighter
              language={resolvedLanguage ?? "text"}
              style={isDark ? oneDark : oneLight}
              customStyle={{
                margin: 0,
                padding: "16px",
                background: "transparent",
                fontSize: "var(--fs-base)",
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
        language={resolvedLanguage ?? "text"}
        style={isDark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          padding: "12px 14px",
          background: "transparent",
          fontSize: "var(--fs-base)",
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
