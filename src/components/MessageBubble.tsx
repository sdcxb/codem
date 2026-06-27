import { useState } from "react";
import { Message } from "../store";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { DefaultToolRenderer } from "../core/llm/tool-renderer";

const toolRenderer = new DefaultToolRenderer({ maxOutputLength: 200 });

interface MessageBubbleProps {
  message: Message;
  index?: number;
  onFork?: (messageIndex: number) => void;
}

export function MessageBubble({ message, index, onFork }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAttachment, setShowAttachment] = useState<string | null>(null);

  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <div className={`message ${isUser ? "user" : isSystem ? "system" : "assistant"}`}>
      <div className="message-avatar">
        {isUser ? "👤" : isSystem ? "⚙️" : "🤖"}
      </div>

      <div className="message-body">
        {/* Fork button */}
        {onFork && index !== undefined && (
          <button
            className="message-fork-btn"
            onClick={() => onFork(index)}
            title="从这条消息分叉新对话"
          >
            🔀
          </button>
        )}
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="message-attachment" onClick={() => setShowAttachment(showAttachment === att.id ? null : att.id)}>
                {att.type === "image" && att.content ? (
                  <img src={att.content} alt={att.name} className="attachment-image" />
                ) : (
                  <div className="attachment-file">
                    <span className="attachment-icon">{att.type === "image" ? "🖼️" : "📄"}</span>
                    <span className="attachment-name">{att.name}</span>
                    {att.size && <span className="attachment-size">{formatSize(att.size)}</span>}
                  </div>
                )}
                {showAttachment === att.id && att.content && att.type !== "image" && (
                  <pre className="attachment-preview">{att.content}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="message-content">
          <ReactMarkdown
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const codeStr = String(children).replace(/\n$/, "");
                if (match) {
                  return (
                    <div className="code-block">
                      <div className="code-header">
                        <span>{match[1]}</span>
                        <button
                          className="copy-btn"
                          onClick={() => navigator.clipboard.writeText(codeStr)}
                        >
                          复制
                        </button>
                      </div>
                      <SyntaxHighlighter
                        style={oneDark}
                        language={match[1]}
                        PreTag="div"
                      >
                        {codeStr}
                      </SyntaxHighlighter>
                    </div>
                  );
                }
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="tool-calls">
            <button
              className="tool-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              🔧 {message.toolCalls.length} 个工具调用 {expanded ? "▼" : "▶"}
            </button>
            {expanded && (
              <div className="tool-list">
                {message.toolCalls.map((tc) => {
                  const rendered = tc.status === "done" && tc.result
                    ? toolRenderer.renderToolResult({ id: tc.id, name: tc.tool, input: tc.args, output: tc.result, status: "completed" })
                    : tc.status === "error"
                    ? toolRenderer.renderToolError(tc.result || "Unknown error", tc.id)
                    : toolRenderer.renderToolUse(tc.tool, tc.args, tc.id);

                  return (
                    <div key={tc.id} className={`tool-item ${tc.status}`}>
                      <span className="tool-name">{rendered.icon} {tc.tool}</span>
                      <span className="tool-status">
                        {tc.status === "running" ? "⏳" : tc.status === "done" ? "✅" : "❌"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
