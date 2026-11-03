/**
 * 共享 Markdown 渲染（A 阶段 1：把桌面同款渲染能力引入 `packages/ui`）。
 *
 * - GFM（表格/任务列表/删除线）；
 * - 代码块高亮（Prism light，移动端不引 Shiki/WASM）；
 * - 危险协议直接丢弃（与桌面 `MessageBubble` 的 urlTransform 同规则）；
 * - 不开启 `rehype-raw`：模型输出的原始 HTML 一律当文本，避免 XSS。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("md", markdown);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("py", python);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("ts", typescript);

const SAFE_PROTO = /^(https?|ircs?|mailto|xmpp)$/i;

function safeUrl(url: string): string {
  if (url.startsWith("file://")) return url;
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  return SAFE_PROTO.test(url.slice(0, colon)) ? url : "";
}

export function Markdown(props: { text: string }): React.ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => <img src={src} alt={alt ?? ""} loading="lazy" />,
          code: ({ className, children, ...rest }) => {
            const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
            const text = String(children ?? "").replace(/\n$/, "");
            if (className?.includes("language-")) {
              return (
                <SyntaxHighlighter
                  language={lang ?? "text"}
                  style={oneDark}
                  PreTag="div"
                  customStyle={{ margin: "6px 0", borderRadius: 8, background: "rgba(0,0,0,.28)", fontSize: 12 }}
                  wrapLongLines
                >
                  {text}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
