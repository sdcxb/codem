import { useState, useEffect } from "react";
import { Message } from "../store";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { DefaultToolRenderer } from "../core/llm/tool-renderer";
import { getSubagentManager } from "../core/subagent/subagent";

// Handle link clicks - open files with system default app, external URLs in browser
function handleLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  e.preventDefault();
  e.stopPropagation();
  console.log("[handleLinkClick] href:", href);
  if (!href) return;
  
  // Check if it's a file path (starts with / or C:\ or contains path separators)
  const isFilePath = href.startsWith("/") || /^[A-Z]:\\/i.test(href) || href.includes("\\");
  
  if (isFilePath) {
    // Open file with system default app via Tauri
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (invoke) {
      console.log("[handleLinkClick] opening file:", href);
      invoke("open_file_external", { path: href }).then(() => {
        console.log("[handleLinkClick] file opened successfully");
      }).catch((err: any) => {
        console.error("[handleLinkClick] Failed to open file:", err);
      });
    } else {
      console.error("[handleLinkClick] Tauri not available");
    }
  } else {
    // Open external URL in default browser
    console.log("[handleLinkClick] opening URL:", href);
    window.open(href, "_blank");
  }
}

// Sub-agent status indicator
function SubagentStatus({ taskId, name }: { taskId: string; name?: string }) {
  const [status, setStatus] = useState<string>("running");
  const [summary, setSummary] = useState<string>("");

  useEffect(() => {
    const manager = getSubagentManager();
    const check = () => {
      const task = manager.getTask(taskId);
      if (!task) return;
      setStatus(task.status);
      if (task.result) setSummary(task.result.summary);
    };
    check();
    const interval = setInterval(check, 2000);
    return () => clearInterval(interval);
  }, [taskId]);

  const displayName = name || "子智能体";

  if (status === "completed") {
    return <span className="subagent-status done">✅ {displayName} 完成{summary ? `: ${summary}` : ""}</span>;
  }
  if (status === "failed") {
    return <span className="subagent-status failed">❌ {displayName} 失败</span>;
  }
  return <span className="subagent-status running">⏳ {displayName} 运行中...</span>;
}

const toolRenderer = new DefaultToolRenderer({ maxOutputLength: 200 });

interface MessageBubbleProps {
  message: Message;
  index?: number;
  onFork?: (messageIndex: number) => void;
  showReasoning?: boolean;
  onDeleteFiles?: (files: string[]) => void;
}

export function MessageBubble({ message, index, onFork, showReasoning = true, onDeleteFiles }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAttachment, setShowAttachment] = useState<string | null>(null);
  const [showFilesConfirm, setShowFilesConfirm] = useState(false);

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
              a({ href, children, ...props }) {
                return (
                  <a
                    {...props}
                    href={href}
                    onClick={(e) => handleLinkClick(e, href || "")}
                    style={{ color: "#7c6cf0", cursor: "pointer", textDecoration: "underline" }}
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        {message.reasoning && showReasoning && (
          <div className="reasoning-block">
            <button
              className="reasoning-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              💭 思考过程 {expanded ? "▼" : "▶"}
            </button>
            {expanded && (
              <pre className="reasoning-content">{message.reasoning}</pre>
            )}
          </div>
        )}

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
                  // Check if this is a spawn_subagent with a task ID
                  const subagentTaskId = tc.tool === "spawn_subagent" && tc.result?.startsWith("SUBAGENT_TASK_ID:")
                    ? tc.result.split("\n")[0].replace("SUBAGENT_TASK_ID:", "")
                    : null;

                  const rendered = tc.status === "done" && tc.result
                    ? toolRenderer.renderToolResult({ id: tc.id, name: tc.tool, input: tc.args, output: tc.result, status: "completed" })
                    : tc.status === "error"
                    ? toolRenderer.renderToolError(tc.result || "Unknown error", tc.id)
                    : toolRenderer.renderToolUse(tc.tool, tc.args, tc.id);

                  // For spawn_subagent, show the agent name and type
                  const agentId = tc.tool === "spawn_subagent" ? tc.args?.agentId as string : null;
                  // Extract name from args or from result string
                  let agentName = tc.tool === "spawn_subagent" ? tc.args?.name as string : null;
                  if (!agentName && tc.tool === "spawn_subagent" && tc.result) {
                    const nameMatch = tc.result.match(/(?:子智能体|Sub-agent)\s*"([^"]+)"/);
                    if (nameMatch) agentName = nameMatch[1];
                  }
                  const displayName = agentId ? `${agentName || "子智能体"} (${agentId})` : tc.tool;
                  const displayIcon = agentId ? (agentId === "explore" ? "🔍" : agentId === "general" ? "🤖" : agentId === "build" ? "🔨" : "🔧") : rendered.icon;

                  return (
                    <div key={tc.id} className={`tool-item ${tc.status}`}>
                      <span className="tool-name">{displayIcon} {displayName}</span>
                      <span className="tool-status">
                        {tc.status === "running" ? "⏳" : tc.status === "done" ? "✅" : "❌"}
                      </span>
                      {subagentTaskId && <SubagentStatus taskId={subagentTaskId} name={agentName || undefined} />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {message.generatedFiles && message.generatedFiles.length > 0 && (
          <div className="generated-files">
            {!showFilesConfirm ? (
              <button
                className="files-cleanup-btn"
                onClick={() => setShowFilesConfirm(true)}
              >
                🗑️ 清理过程文件 ({message.generatedFiles.length})
              </button>
            ) : (
              <div className="files-confirm">
                <div className="files-list">
                  {message.generatedFiles.map((file, i) => (
                    <div key={i} className="file-item">{file}</div>
                  ))}
                </div>
                <div className="files-actions">
                  <button
                    className="files-delete-btn"
                    onClick={() => {
                      onDeleteFiles?.(message.generatedFiles!);
                      setShowFilesConfirm(false);
                    }}
                  >
                    删除
                  </button>
                  <button
                    className="files-cancel-btn"
                    onClick={() => setShowFilesConfirm(false)}
                  >
                    取消
                  </button>
                </div>
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
