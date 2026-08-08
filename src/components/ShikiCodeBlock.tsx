/**
 * ShikiCodeBlock — 基于 Shiki 的代码高亮组件
 *
 * 替代 react-syntax-highlighter (Prism)。
 * 使用 Shiki 的 VSCode 主题，支持流式渲染。
 */

import { useState, useEffect, memo } from "react";

// Cache the highlighter singleton
let highlighterPromise: Promise<any> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [
          "javascript", "typescript", "jsx", "tsx", "python", "rust",
          "go", "java", "c", "cpp", "csharp", "php", "ruby",
          "bash", "shell", "powershell", "json", "yaml", "toml",
          "html", "css", "scss", "sql", "markdown", "dockerfile",
          "diff", "ini", "xml", "vue", "svelte",
        ],
      })
    );
  }
  return highlighterPromise;
}

interface ShikiCodeBlockProps {
  code: string;
  language: string;
  /** Theme to use — defaults to github-dark */
  theme?: "github-dark" | "github-light";
  /** Whether to show line numbers */
  showLineNumbers?: boolean;
}

export const ShikiCodeBlock = memo(function ShikiCodeBlock({
  code,
  language,
  theme = "github-dark",
  showLineNumbers = false,
}: ShikiCodeBlockProps) {
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const highlighter = await getHighlighter();
        // Normalize language name
        const lang = normalizeLang(language);
        // Check if language is supported
        const loadedLangs = highlighter.getLoadedLanguages();
        const finalLang = loadedLangs.includes(lang) ? lang : "text";

        const result = highlighter.codeToHtml(code, {
          lang: finalLang,
          theme,
        });

        if (!cancelled) {
          setHtml(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          // Fallback: render as plain text
          setHtml(`<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [code, language, theme]);

  if (loading) {
    return (
      <pre className="shiki-loading">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className={`shiki-code-block ${showLineNumbers ? "with-line-numbers" : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase().trim();
  const map: Record<string, string> = {
    "js": "javascript",
    "ts": "typescript",
    "py": "python",
    "rs": "rust",
    "sh": "bash",
    "shell": "bash",
    "ps1": "powershell",
    "yml": "yaml",
    "md": "markdown",
    "dockerfile": "dockerfile",
    "cs": "csharp",
    "cpp": "cpp",
    "c++": "cpp",
    "c": "c",
  };
  return map[lower] || lower;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
