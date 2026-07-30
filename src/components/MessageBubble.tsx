import { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import { Message, useAppStore } from "../store";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { DefaultToolRenderer } from "../core/llm/tool-renderer";
import { getSubagentManager } from "../core/subagent/subagent";
import { getLang, useLang, S } from "../core/i18n/lang";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { InlineMessageEdit } from "./InlineMessageEdit";
import { FeedbackButtons } from "./FeedbackButtons";
import { SourceReferences } from "./SourceReferences";
import { ImageGallery } from "./ImageGallery";
import { VideoPlayer } from "./VideoPlayer";

// B6: Mermaid diagram renderer component
const MermaidDiagram = memo(function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "loose",
          fontFamily: "inherit",
        });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError("");
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [chart]);

  if (loading) {
    return <div className="mermaid-loading">Rendering diagram...</div>;
  }
  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-title">Diagram render error:</div>
        <pre className="mermaid-error-detail">{error}</pre>
        <details>
          <summary>Source code</summary>
          <pre className="mermaid-source">{chart}</pre>
        </details>
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      className="mermaid-container"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

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
function SubagentStatus({ taskId, name, toolStatus }: { taskId: string; name?: string; toolStatus?: string }) {
const [status, setStatus] = useState<string>("init");
const [summary, setSummary] = useState<string>("");

useEffect(() => {
const manager = getSubagentManager();
const check = () => {
const task = manager.getTask(taskId);
if (task) {
setStatus(task.status);
if (task.result) setSummary(task.result.summary);
} else {
// Task not in memory (historical session) — fall back to tool call status
if (toolStatus === "done") {
setStatus("completed");
} else if (toolStatus === "error") {
setStatus("failed");
} else {
setStatus("running");
}
}
};
check();
const interval = setInterval(check, 2000);
return () => clearInterval(interval);
}, [taskId, toolStatus]);

const zh = getLang() === "zh";
const displayName = name || (zh ? "子智能体" : "Sub-agent");

// While initializing, don't show anything (avoids brief "running" flash)
if (status === "init") return null;

if (status === "completed") {
    return <span className="subagent-status done">✅ {displayName} {zh ? "完成" : "completed"}{summary ? `: ${summary}` : ""}</span>;
  }
  if (status === "failed") {
    return <span className="subagent-status failed">❌ {displayName} {zh ? "失败" : "failed"}</span>;
  }
  return <span className="subagent-status running">⏳ {displayName} {zh ? "运行中..." : "running..."}</span>;
}

const toolRenderer = new DefaultToolRenderer({ maxOutputLength: 200 });

// Threshold for long message collapse (in pixels)
const COLLAPSE_THRESHOLD = 400;

interface MessageBubbleProps {
  message: Message;
  index?: number;
  showReasoning?: boolean;
  onDeleteFiles?: (files: string[]) => void;
  /** true if this is the last assistant message in the current Q&A turn */
  isLastInTurn?: boolean;
  /** Called when user clicks a citation — opens SourceViewer */
  onCitationClick?: (sourceName: string) => void;
  /** Called when user clicks a source in the metadata-driven sources panel */
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
  /** P0: Called when user edits a message and wants to resend */
  onEditAndResend?: (messageId: string, newContent: string) => void;
  /** P0: Called when user wants to restore a message to the input box */
  onReEdit?: (content: string) => void;
  /** P0: Session ID for DB persistence (feedback) */
  sessionId?: string;
  /** P0: Whether editing is allowed (e.g. disabled during streaming) */
  canEdit?: boolean;
}

export const MessageBubble = memo(function MessageBubble({ message, index, showReasoning = true, onDeleteFiles, isLastInTurn, onCitationClick, onSourceClick, onEditAndResend, onReEdit, sessionId, canEdit = true }: MessageBubbleProps) {
const lang = useLang();
  const displayMode = useAppStore((s) => s.displayMode);
  const [expanded, setExpanded] = useState(displayMode !== "unified");
  const [toolsExpanded, setToolsExpanded] = useState(displayMode !== "unified");
  const [showAttachment, setShowAttachment] = useState<string | null>(null);
  const [showFilesConfirm, setShowFilesConfirm] = useState(false);
  const [contentCollapsed, setContentCollapsed] = useState(false);
const [copied, setCopied] = useState(false);
const [isEditing, setIsEditing] = useState(false);
const [galleryImages, setGalleryImages] = useState<string[] | null>(null);
const [galleryIndex, setGalleryIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isStreaming = message.status === "streaming";

  // For user messages: strip <attachment> blocks from displayed content.
  // Attachment content is inlined into message.content for the LLM (with data-isolation
  // markers), but the UI should only show the user's actual text — attachments are
  // already rendered as separate cards above. Without this, uploaded file content
  // (e.g. another AI's system prompt) would be fully displayed in the chat bubble.
  const rawContent = isUser
    ? message.content.replace(/<attachment>[\s\S]*?<\/attachment>\s*/g, "").trim()
    : message.content;

  // P1-2: Process citations — convert [Source N: name] to clickable markdown links
  // This is a fallback for models that embed citations in text.
  // Primary citation rendering is via structured metadata (see SourcesPanel below).
  const displayContent = isUser
    ? rawContent
    : rawContent.replace(/\[Source\s+(\d+):\s*([^\]]+)\]/g, '[📖 $1](#cite-$1 "$2")');

  // Extract source citations from both:
  // 1. message.retrievedSources — auto-retrieved from notebook RAG (metadata-driven, not prompt-based)
  // 2. search_notebook tool metadata — when LLM explicitly calls the search tool
  const citationSources = useMemo(() => {
    if (isUser) return [];
    const sources: Array<{ index: number; sourceId: string; sourceName: string; chunkIndex: number; snippet: string }> = [];
    // 1. Auto-retrieved sources from notebook knowledge context
    for (const src of message.retrievedSources || []) {
      if (!sources.find(s => s.sourceId === src.sourceId)) {
        sources.push({
          index: sources.length + 1,
          sourceId: src.sourceId,
          sourceName: src.sourceName,
          chunkIndex: src.chunkIndex,
          snippet: src.snippet,
        });
      }
    }
    // 2. Tool-call-based sources (search_notebook)
    for (const tc of message.toolCalls || []) {
      if (tc.tool === 'search_notebook' && tc.metadata?.sources && tc.status === 'done') {
        for (const src of tc.metadata.sources) {
          // Deduplicate by sourceId — keep the first occurrence
          if (!sources.find(s => s.sourceId === src.sourceId)) {
            sources.push(src);
          }
        }
      }
    }
    return sources;
  }, [message.retrievedSources, message.toolCalls, isUser]);

  // Memoize ReactMarkdown components config to prevent re-creation on every render
  const markdownComponents = useMemo(() => ({
    code({ className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || "");
      const codeStr = String(children).replace(/\n$/, "");
      if (match) {
        // B6: Render mermaid diagrams inline
        if (match[1] === "mermaid") {
          return <MermaidDiagram chart={codeStr} />;
        }
        return (
          <div className="code-block">
            <div className="code-header">
              <span>{match[1]}</span>
              <button
                className="copy-btn"
                onClick={() => navigator.clipboard.writeText(codeStr)}
              >
                {S.bubble.copy[lang]}
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
    a({ href, children, ...props }: any) {
      // P1-2: Handle citation links
      if (href && href.startsWith('#cite-')) {
        const sourceName = props.title || '';
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
                el.classList.toggle('active');
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            {children}
          </sup>
        );
      }
      return (
        <a
          {...props}
          href={href}
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => handleLinkClick(e, href || "")}
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
          style={{ maxWidth: "100%", borderRadius: 8, marginTop: 8, marginBottom: 8 }}
          onError={(e) => {
            console.error("[Image render error]", alt, src?.substring(0, 50));
          }}
        />
      );
    },
  }), [lang, onCitationClick]);

  // Check if content should be collapsible (after render, not during streaming)
  useEffect(() => {
    if (isStreaming) {
      setContentCollapsed(false);
      return;
    }
    if (contentRef.current && contentRef.current.scrollHeight > COLLAPSE_THRESHOLD) {
      // Auto-collapse long messages, but only once per message
      setContentCollapsed(true);
    }
  }, [isStreaming, displayContent]);

const handleCopyMessage = useCallback(() => {
navigator.clipboard.writeText(rawContent).then(() => {
setCopied(true);
setTimeout(() => setCopied(false), 2000);
});
}, [rawContent]);

  return (
    <div 
      className={`message ${isUser ? "user" : isSystem ? "system" : "assistant"} ${displayMode === "unified" ? "unified-mode" : ""}`}
      data-message-id={message.id}
    >
      <div className="message-avatar">
        {isUser ? "👤" : isSystem ? "⚙️" : "🤖"}
      </div>

      <div className="message-body">
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="message-attachment" onClick={() => setShowAttachment(showAttachment === att.id ? null : att.id)}>
                {att.type === "image" && att.content ? (
                  <img
                    src={att.content}
                    alt={att.name}
                    className="attachment-image"
                    onClick={(e) => {
                      e.stopPropagation();
                      const imgs = message.attachments?.filter(a => a.type === "image" && a.content).map(a => a.content!) || [];
                      setGalleryImages(imgs);
                      setGalleryIndex(imgs.indexOf(att.content || ""));
                    }}
                  />
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

        {/* P3: Image gallery lightbox */}
        {galleryImages && galleryImages.length > 0 && (
          <ImageGallery
            images={galleryImages}
            initialIndex={galleryIndex}
            onClose={() => setGalleryImages(null)}
          />
        )}

        {/* P3: Video player for video attachments */}
        {message.attachments?.filter(a => a.type === "video" && a.content).map(att => (
          <VideoPlayer
            key={`video-${att.id}`}
            src={att.content!}
            title={att.name}
          />
        ))}

        {/* Long message collapse wrapper (#3) */}
        <div
          className={`message-content-wrapper ${contentCollapsed && !isStreaming ? "collapsed" : ""}`}
        >
          {isEditing && isUser ? (
            <InlineMessageEdit
              initialContent={rawContent}
              onSave={(newContent) => {
                setIsEditing(false);
                onEditAndResend?.(message.id, newContent);
              }}
              onCancel={() => setIsEditing(false)}
            />
          ) : (
          <div className="message-content" ref={contentRef}>
            <ReactMarkdown
              components={{
                ...markdownComponents,
                hr: () => <div className="unified-separator" />,
              }}
            >
              {displayContent}
            </ReactMarkdown>
          </div>
          )}
          {/* Collapse overlay with expand button */}
          {!isEditing && contentCollapsed && !isStreaming && (
            <div className="collapse-overlay" onClick={() => setContentCollapsed(false)}>
              <span className="collapse-btn">{S.bubble.expand[lang]} ▼</span>
            </div>
          )}
        </div>

        {/* Collapsed indicator (when collapsed, show a small expand hint) */}
        {!isEditing && contentCollapsed && !isStreaming && (
          <button className="content-collapsed-hint" onClick={() => setContentCollapsed(false)}>
            {S.bubble.expand[lang]} · {contentRef.current?.scrollHeight ?? 0}px →
          </button>
        )}

        {/* Sources panel — structured metadata-driven citations (对标 NotebookLM) */}
        {!isUser && citationSources.length > 0 && !isStreaming && (
          <div className="nb-msg-sources" style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            <span style={{ fontSize: '11px', opacity: 0.5, alignSelf: 'center' }}>
              {lang === 'zh' ? '来源:' : 'Sources:'}
            </span>
            {citationSources.map((src) => (
              <button
                key={src.sourceId}
                className="nb-msg-source-chip"
                onClick={() => onSourceClick?.(src.sourceId, src.chunkIndex)}
                title={src.snippet}
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  background: 'var(--bg-tertiary, #25252b)',
                  border: '1px solid var(--border-color, #2a2a30)',
                  borderRadius: '10px',
                  color: 'var(--text-secondary, #a0a0a8)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent, #6366f1)';
                  e.currentTarget.style.color = 'var(--accent, #6366f1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-color, #2a2a30)';
                  e.currentTarget.style.color = 'var(--text-secondary, #a0a0a8)';
                }}
              >
                📖 {src.sourceName}
              </button>
            ))}
          </div>
        )}

        {message.reasoning && showReasoning && (
          <div className="reasoning-block">
            <button
              className="reasoning-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              {S.bubble.reasoning[lang]} {expanded ? "▼" : "▶"}
            </button>
            {expanded && (
              <pre className="reasoning-content">{message.reasoning}</pre>
            )}
          </div>
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (() => {
// B9: Detect note operation tools for prominent display
const noteOps = message.toolCalls!.filter(tc =>
['create_note', 'edit_note', 'link_notes', 'delete_note'].includes(tc.tool)
);
          const hasNoteOps = noteOps.length > 0;
          return (
          <div className="tool-calls">
            {/* B9: Note operation notifications — always visible */}
            {hasNoteOps && (
              <div className="note-op-notifications" style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                marginBottom: '6px',
              }}>
                {noteOps.map((tc) => {
                  const isDone = tc.status === 'done';
                  const isError = tc.status === 'error';
                  const zh = getLang() === 'zh';
const opLabel = tc.tool === 'create_note'
? (zh ? '创建笔记' : 'Created note')
: tc.tool === 'edit_note'
? (zh ? '编辑笔记' : 'Edited note')
: tc.tool === 'delete_note'
? (zh ? '删除笔记' : 'Deleted note')
: (zh ? '链接笔记' : 'Linked notes');
                  const title = tc.args?.title || tc.args?.targetTitle || '';
                  return (
                    <div
                      key={tc.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 10px',
                        background: isError
                          ? 'rgba(239, 68, 68, 0.1)'
                          : isDone
                          ? 'rgba(99, 102, 241, 0.1)'
                          : 'rgba(234, 179, 8, 0.1)',
                        border: `1px solid ${
                          isError ? 'rgba(239, 68, 68, 0.3)'
                          : isDone ? 'rgba(99, 102, 241, 0.3)'
                          : 'rgba(234, 179, 8, 0.3)'
                        }`,
                        borderRadius: '6px',
                        fontSize: '12px',
                        color: 'var(--text-secondary, #a0a0a8)',
                      }}
                    >
                      <span>{isError ? '❌' : isDone ? '📝' : '⏳'}</span>
                      <span style={{ fontWeight: 500 }}>
                        {opLabel}{title ? `: "${title}"` : ''}
                      </span>
                      {isDone && tc.result && (
                        <span style={{ opacity: 0.6, fontSize: '11px' }}>✓</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button
              className="tool-toggle"
              onClick={() => setToolsExpanded(!toolsExpanded)}
            >
              🔧 {message.toolCalls.length} {S.bubble.toolCalls[lang]} {toolsExpanded ? "▼" : "▶"}
            </button>
            {toolsExpanded && (
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
                  const displayName = agentId ? `${agentName || (getLang() === "zh" ? "子智能体" : "Sub-agent")} (${agentId})` : tc.tool;
                  const displayIcon = agentId ? (agentId === "explore" ? "🔍" : agentId === "general" ? "🤖" : agentId === "build" ? "🔨" : "🔧") : rendered.icon;

                  return (
                    <div key={tc.id} className={`tool-item ${tc.status}`}>
                      <span className="tool-name">{displayIcon} {displayName}</span>
                      <span className="tool-status">
                        {tc.status === "running" ? "⏳" : tc.status === "done" ? "✅" : "❌"}
                      </span>
                      {subagentTaskId && <SubagentStatus taskId={subagentTaskId} name={agentName || undefined} toolStatus={tc.status} />}
                      {tc.status === "error" && tc.result && (
                        <div className="tool-error-detail">{tc.result}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
        })()}

        {message.generatedFiles && message.generatedFiles.length > 0 && (
          <div className="generated-files">
            {!showFilesConfirm ? (
              <button
                className="files-cleanup-btn"
                onClick={() => setShowFilesConfirm(true)}
              >
                {S.bubble.cleanFiles[lang]} ({message.generatedFiles.length})
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
                    {S.bubble.delete[lang]}
                  </button>
                  <button
                    className="files-cancel-btn"
                    onClick={() => setShowFilesConfirm(false)}
                  >
                    {S.bubble.cancel[lang]}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* #2: Floating toolbar — shown on hover, not during streaming */}
        {!isStreaming && !isSystem && message.content && !isEditing && (
          <div className="message-toolbar">
            {isUser && canEdit && onEditAndResend && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => setIsEditing(true)}>
                    ✏️
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.editAndResend[lang]}</TooltipContent>
              </Tooltip>
            )}
            {isUser && canEdit && onReEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => onReEdit(rawContent)}>
                    📝
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.reEdit[lang]}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="toolbar-btn" onClick={handleCopyMessage}>
                  {copied ? "✓" : "📋"}
                </button>
              </TooltipTrigger>
              <TooltipContent>{copied ? S.bubble.copied[lang] : S.bubble.copyMessage[lang]}</TooltipContent>
            </Tooltip>
            {contentCollapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => setContentCollapsed(false)}>
                    📖
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.expand[lang]}</TooltipContent>
              </Tooltip>
            )}
            {!contentCollapsed && contentRef.current && contentRef.current.scrollHeight > COLLAPSE_THRESHOLD && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => setContentCollapsed(true)}>
                    📕
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.collapse[lang]}</TooltipContent>
              </Tooltip>
            )}
            {/* Feedback buttons inline in toolbar — same row as copy/collapse */}
            {!isUser && !isSystem && !isStreaming && message.content && (
              <FeedbackButtons message={message} sessionId={sessionId} inline />
            )}
          </div>
        )}

        {/* P0: Feedback buttons removed from here — now inline in toolbar above */}

        {/* P2: Source references for RAG-based messages */}
        {!isUser && !isSystem && message.metadata?.sources && (message.metadata.sources as any[]).length > 0 && (
          <SourceReferences
            sources={(message.metadata.sources as any[]).map(s => ({
              sourceId: s.sourceId || s.id || "",
              sourceName: s.sourceName || s.name || "",
              chunkIndex: s.chunkIndex || 0,
              snippet: s.snippet || s.content || "",
              score: s.score || 0,
            }))}
            onSourceClick={(sourceId, chunkIndex) => onSourceClick?.(sourceId, chunkIndex)}
          />
        )}
      </div>
    </div>
  );
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
