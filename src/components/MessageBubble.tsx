import { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import { Message, useAppStore } from "../store";
import ReactMarkdown from "react-markdown";
// P1 #17: Shiki replaces Prism for code highlighting
import { ShikiCodeBlock } from "./ShikiCodeBlock";
import { DefaultToolRenderer } from "../core/llm/tool-renderer";
import { tryGetCtx } from "../core/consumer";
import { getLang, useLang, S } from "../core/i18n/lang";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { splitGraphemes } from "../core/llm/stream-reveal";
import { InlineMessageEdit } from "./InlineMessageEdit";
import { FeedbackButtons } from "./FeedbackButtons";
import { getSubagentRuntime } from "../core/subagent/index";
import { SlotBridge } from "../core/slots/SlotBridge";
import { SourceReferences } from "./SourceReferences";
import { ImageGallery } from "./ImageGallery";
import { VideoPlayer } from "./VideoPlayer";
import { RichContent } from "./rich-content/RichContent";
import { createFileMentions } from "../utils/file-mentions";
import { autoLinkFilePaths } from "../utils/auto-link-paths";
import { openFileLink } from "../utils/file-link";
// P3-26: Voice output (TTS) — browser speech synthesis hook
import { useSpeechSynthesis } from "../hooks/useSpeechSynthesis";
import { getMultimodalSettings, textToSpeech, playTTSAudio } from "../core/llm/multimodal";
import { Bot, CheckCircle, XCircle, Clock, FileText, Image as ImageIcon, Pencil, PencilLine, Clipboard, Check, BookOpen, BookX, Brain, ChevronDown, ChevronUp, User, Volume2, Square as StopIcon } from "lucide-react";
import { getSettingJSON } from "../core/storage/settings";
import type { UserConfig } from "../core/types";
import { MessageActions } from "./MessageActions";
import { ErrorCard } from "./ErrorCard";
import { ToolCallGroup } from "./ToolCallGroup";
import type { ToolCallCardProps } from "./ToolCallCard";
import { StatsLine } from "./StatsLine";
import { TurnStatus } from "./TurnStatus";
import { ReasoningRow } from "./ReasoningRow";

/** User avatar component — reads avatar from settings, shows circle on user messages */
function UserAvatar() {
  const userConfig = getSettingJSON<UserConfig>("codem-user", { name: "", callBy: "", pronouns: "", timezone: "", notes: "", context: "", raw: "", avatar: "" });
  const avatar = userConfig.avatar;

  if (avatar) {
    return (
      <div className="user-msg-avatar" style={{
        width: 32, height: 32, borderRadius: "50%", overflow: "hidden",
        flexShrink: 0, border: "2px solid var(--border-primary)",
      }}>
        <img src={avatar} alt="me" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div className="user-msg-avatar" style={{
      width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
      background: "var(--bg-tertiary)", border: "2px solid var(--border-primary)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <User size={16} style={{ color: "var(--text-muted)" }} />
    </div>
  );
}

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

// Handle link clicks — delegates to shared file-link utility
import { handleFileLinkClick, handleFileLinkContextMenu } from "../utils/file-link";

// Sub-agent status indicator
function SubagentStatus({ taskId, name, toolStatus }: { taskId: string; name?: string; toolStatus?: string }) {
const [status, setStatus] = useState<string>("init");
const [summary, setSummary] = useState<string>("");

useEffect(() => {
  // DSH-style: 从全局 SubagentRuntime 获取状态
  // 对标 DSH ctx.subagents — 替代旧 SubagentManager
  const runtime = getSubagentRuntime();
if (!runtime) {
// Runtime 未就绪 — 用 toolStatus 降级显示
if (toolStatus === "done") setStatus("completed");
else if (toolStatus === "error") setStatus("failed");
else setStatus("running");
return;
}
const check = () => {
const task = runtime.getTask(taskId);
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
// DSH-style: 订阅事件而非轮询
const unsubscribe = runtime.subscribe(check);
return () => {
  if (unsubscribe) unsubscribe();
};
}, [taskId, toolStatus]);

const zh = getLang() === "zh";
const displayName = name || (zh ? "子智能体" : "Sub-agent");

// While initializing, don't show anything (avoids brief "running" flash)
if (status === "init") return null;

if (status === "completed") {
    return <span className="subagent-status done"><CheckCircle size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {displayName} {zh ? "完成" : "completed"}{summary ? `: ${summary}` : ""}</span>;
  }
  if (status === "failed") {
    return <span className="subagent-status failed"><XCircle size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {displayName} {zh ? "失败" : "failed"}</span>;
  }
  return <span className="subagent-status running"><Clock size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {displayName} {zh ? "运行中..." : "running..."}</span>;
}

// D2-1: 不在模块加载时获取服务 — 改为延迟获取，确保 Provider ACTIVE 后才消费
const getToolRenderer = () => {
    const ctx = tryGetCtx();
    const tr = ctx?.get('toolRender');
    if (tr) return { render: (r: any, c: any) => tr.render('default', r, c) };
    return new DefaultToolRenderer({ maxOutputLength: 200 });
  };

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
  const isStreaming = message.status === "streaming";
  // Historical messages (not streaming) default to collapsed reasoning.
  // Streaming messages start expanded — the streaming effect will keep it open.
  const [expanded, setExpanded] = useState(isStreaming ? true : (displayMode === "unified"));
  const [toolsExpanded, setToolsExpanded] = useState(displayMode !== "unified");
  const [showAttachment, setShowAttachment] = useState<string | null>(null);
  const [showFilesConfirm, setShowFilesConfirm] = useState(false);
  const [contentCollapsed, setContentCollapsed] = useState(false);
const [copied, setCopied] = useState(false);
const [isEditing, setIsEditing] = useState(false);
const [galleryImages, setGalleryImages] = useState<string[] | null>(null);
const [galleryIndex, setGalleryIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  // P3-26: TTS — text-to-speech for message content
  const { isSpeaking, isSupported: ttsSupported, speak: ttsSpeak, cancel: ttsCancel } = useSpeechSynthesis();
  const [isTtsLoading, setIsTtsLoading] = useState(false);
  const [ttsMessageId, setTtsMessageId] = useState<string | null>(null);

  // Handle read aloud button click
  const handleReadAloud = useCallback(async () => {
    if (!message.content?.trim()) return;

    // If currently speaking for this message, stop
    if (isSpeaking && ttsMessageId === message.id) {
      ttsCancel();
      setTtsMessageId(null);
      return;
    }

    // Cancel any existing speech
    ttsCancel();
    setTtsMessageId(message.id);

    // Strip markdown formatting for better TTS output
    const plainText = message.content
      .replace(/```[\s\S]*?```/g, " code block ") // Replace code blocks
      .replace(/`([^`]+)`/g, "$1")               // Inline code
      .replace(/!\[.*?\]\(.*?\)/g, "")             // Images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // Links → text
      .replace(/#{1,6}\s/g, "")                    // Headers
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")   // Bold/italic
      .replace(/\n{3,}/g, "\n\n")                  // Excessive newlines
      .trim();

    if (!plainText) return;

    // Check if cloud TTS is preferred and configured
    const mmSettings = getMultimodalSettings();
    const cloudTtsConfigured = mmSettings.tts && mmSettings.tts.enabled && mmSettings.tts.apiKey;
    const preferCloudTts = getSettingJSON<boolean>("codem-prefer-cloud-tts", false);

    if (preferCloudTts && cloudTtsConfigured) {
      // Use cloud TTS API
      setIsTtsLoading(true);
      try {
        const result = await textToSpeech({ text: plainText });
        const audio = playTTSAudio(result);
        audio.onended = () => {
          setTtsMessageId(null);
        };
      } catch (err) {
        // Fallback to browser TTS
        ttsSpeak(plainText);
      } finally {
        setIsTtsLoading(false);
      }
    } else {
      // Use browser built-in TTS
      ttsSpeak(plainText);
    }
  }, [message.id, message.content, isSpeaking, ttsMessageId, ttsCancel, ttsSpeak]);

  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isError = message.status === "error";

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
  // + Auto-link: bare file paths → Markdown links (rendering-layer safety net)
  const displayContent = isUser
    ? rawContent
    : autoLinkFilePaths(rawContent.replace(/\[Source\s+(\d+):\s*([^\]]+)\]/g, '[📖 $1](#cite-$1 "$2")'));

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
            <ShikiCodeBlock
              code={codeStr}
              language={match[1]}
            />
          </div>
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
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => handleFileLinkClick(e, href || "")}
          onContextMenu={(e: React.MouseEvent<HTMLAnchorElement>) => handleFileLinkContextMenu(e, href || "")}
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

  // 方案 B：从本轮工具调用记录构建 file-mention resolver，
  // 让 LLM 在结束语中以 `filename` 反引号提及的文件变成可点击链接。
  // 仅在非流式（已结束）时生效，避免中途文件列表不完整导致误解析。
  const fileMentions = useMemo(() => {
    if (isUser || isStreaming || !message.toolCalls?.length) return null;
    return createFileMentions(message.toolCalls, (path) => void openFileLink(path));
  }, [isUser, isStreaming, message.toolCalls]);

  // Track whether this message was ever streamed (i.e. it's the "latest" answer,
  // not a historical message loaded from DB). Historical messages default to
  // collapsed; streamed messages stay expanded even after streaming ends.
  const wasStreamedRef = useRef(false);
  if (isStreaming) wasStreamedRef.current = true;

  // Check if content should be collapsible (after render, not during streaming)
  useEffect(() => {
    if (isStreaming) {
      setContentCollapsed(false);
      return;
    }
    // Only auto-collapse historical messages (never streamed).
    // The latest answer that just finished streaming should stay expanded
    // so the user can read it immediately.
    if (wasStreamedRef.current) return;
    if (contentRef.current && contentRef.current.scrollHeight > COLLAPSE_THRESHOLD) {
      setContentCollapsed(true);
    }
  }, [isStreaming, displayContent]);

  // Reasoning collapse logic:
  // - During streaming: keep expanded (user sees reasoning in real-time)
  // - After streaming ends: keep expanded (user just received this answer, wants to read it)
  // - Historical messages (loaded from DB, never streamed): default collapsed
  const reasoningAutoCollapsedRef = useRef(false);
  const hasStreamedRef = useRef(false);
  useEffect(() => {
    if (isStreaming && message.reasoning) {
      setExpanded(true);
      hasStreamedRef.current = true;
      reasoningAutoCollapsedRef.current = false;
    }
    // When streaming ends, do NOT auto-collapse — the user just watched this answer
    // being generated and wants to read the reasoning. Only historical messages
    // (which were never in streaming state) should be collapsed by default.
  }, [isStreaming, message.reasoning]);

  // P1: Stream reveal — compute reveal count for animation
  const revealCount = useMemo(() => {
    if (!isStreaming || !displayContent) return 0;
    const graphemes = splitGraphemes(displayContent);
    return Math.min(graphemes.length, 15);
  }, [isStreaming, displayContent]);
  const revealRevision = useMemo(() => displayContent.length, [displayContent.length]);

const handleCopyMessage = useCallback(() => {
navigator.clipboard.writeText(rawContent).then(() => {
setCopied(true);
setTimeout(() => setCopied(false), 2000);
});
}, [rawContent]);

  return (
    <div 
      className={`message message-bubble ${isUser ? "user" : isSystem ? "system" : "assistant"} ${displayMode === "unified" ? "unified-mode" : ""}`}
      data-message-id={message.id}
    >
      {isUser && <UserAvatar />}
      <div className="message-body">
        {/* AI message inline header — replaces avatar (aligned with wecode/frakio) */}
        {!isUser && !isSystem && (
          <div className="ai-msg-header">
            <Bot size={16} />
            <span className="font-semibold">Codem</span>
            {message.timestamp > 0 && (
              <span className="ai-msg-time">
                {new Date(message.timestamp).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
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
                    <span className="attachment-icon">{att.type === "image" ? <ImageIcon size={16} /> : <FileText size={16} />}</span>
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

        {/* P1 #20: Error card for error messages */}
        {isError && !isUser && (
          <ErrorCard
            title={lang === "zh" ? "执行出错" : "Execution Error"}
            message={message.content || (lang === "zh" ? "未知错误" : "Unknown error")}
            details={message.reasoning || undefined}
            retryable
            onRetry={() => { /* retry handled by parent via onEditAndResend */ }}
          />
        )}

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
            {!isUser && !isEditing ? (
              <RichContent
                content={displayContent}
                streaming={isStreaming}
                revealCount={revealCount}
                revealRevision={revealRevision}
                className=""
                fileMentions={fileMentions}
              />
            ) : (
              <ReactMarkdown
                urlTransform={(url) => {
                  if (url.startsWith("file://")) return url;
                  const colon = url.indexOf(":");
                  if (colon === -1) return url;
                  const proto = url.slice(0, colon);
                  if (/^(https?|ircs?|mailto|xmpp)$/i.test(proto)) return url;
                  return "";
                }}
                components={{
                  ...markdownComponents,
                  hr: () => <div className="unified-separator" />,
                }}
              >
                {displayContent}
              </ReactMarkdown>
            )}
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
                <BookOpen size={14} style={{ display: "inline", verticalAlign: "middle" }} /> {src.sourceName}
              </button>
            ))}
          </div>
        )}

        {/* ReasoningRow — 对标 DSH Think 折叠行：流式最新行跟踪 + 灰底缩进展开 */}
        {message.reasoning && showReasoning && (
          <ReasoningRow text={message.reasoning} running={isStreaming} />
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
                      <span>{isError ? <XCircle size={12} /> : isDone ? <FileText size={12} /> : <Clock size={12} />}</span>
                      <span style={{ fontWeight: 500 }}>
                        {opLabel}{title ? `: "${title}"` : ''}
                      </span>
                      {isDone && tc.result && (
                        <span style={{ opacity: 0.6, fontSize: '11px' }}><Check size={10} /></span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* SlotBridge 消费 conversation.node.tool slot — fallback 到 ToolCallGroup */}
            <SlotBridge
              name="conversation.node.tool"
              fallback={ToolCallGroup}
              items={message.toolCalls.map((tc): ToolCallCardProps => {
                // 支持新旧工具名
                const isSubagent = tc.tool === "spawn_subagent" || tc.tool === "subagent";
                const agentId = isSubagent ? (tc.args?.agentId || tc.args?.description) as string : null;
                let agentName = isSubagent ? (tc.args?.name || tc.args?.description) as string : null;
                if (!agentName && isSubagent && tc.result) {
                  const nameMatch = tc.result.match(/(?:子智能体|Sub-agent|后台子智能体)\s*([^\.\s,]+)/);
                  if (nameMatch) agentName = nameMatch[1];
                }
                const displayName = isSubagent
                  ? `${agentName || (getLang() === "zh" ? "子智能体" : "Sub-agent")}`
                  : tc.tool;
                const rawSummary = tc.args
                  ? (tc.args.query || tc.args.file || tc.args.path || tc.args.title || tc.args.command || tc.args.prompt || tc.args.description || "")
                  : "";
                return {
                  toolName: displayName,
                  toolArgs: tc.args ? JSON.stringify(tc.args, null, 2) : undefined,
                  toolResult: tc.result || undefined,
                  status: tc.status as "running" | "done" | "error",
                  duration: (tc.metadata as any)?.duration,
                  argsSummary: typeof rawSummary === "string" && rawSummary ? rawSummary : undefined,
                  metadata: tc.metadata as Record<string, any> | undefined,
                };
              })}
              title={`${message.toolCalls.length} ${S.bubble.toolCalls[lang]}`}
              defaultExpanded={toolsExpanded}
            />
            {/* Subagent status polling — 支持 spawn_subagent (旧) 和 subagent (新) */}
            {message.toolCalls.filter(tc => {
              // 旧格式: tool=spawn_subagent, result 以 SUBAGENT_TASK_ID: 开头
              if (tc.tool === "spawn_subagent" && tc.result?.startsWith("SUBAGENT_TASK_ID:")) return true;
              // 新格式: tool=subagent, metadata.subagentId 存在
              if (tc.tool === "subagent" && (tc.metadata as any)?.subagentId) return true;
              // 新格式（前台模式）: tool=subagent, 有 result 但无 subagentId（一次性同步等待）
              return false;
            }).map((tc) => {
              // 提取 taskId — 兼容新旧格式
              let taskId: string;
              let agentName: string | undefined;
              if (tc.tool === "spawn_subagent") {
                taskId = tc.result!.split("\n")[0].replace("SUBAGENT_TASK_ID:", "");
                agentName = tc.args?.name as string;
              } else {
                taskId = (tc.metadata as any)?.subagentId as string;
                agentName = tc.args?.description as string;
              }
              return (
                <SubagentStatus
                  key={`sub-${tc.id}`}
                  taskId={taskId}
                  name={agentName || undefined}
                  toolStatus={tc.status}
                />
              );
            })}
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
          <div className="message-toolbar message-actions-bar">
            {isUser && canEdit && onEditAndResend && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => setIsEditing(true)}>
                    <Pencil size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.editAndResend[lang]}</TooltipContent>
              </Tooltip>
            )}
            {isUser && canEdit && onReEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => onReEdit(rawContent)}>
                    <PencilLine size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.reEdit[lang]}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="toolbar-btn" onClick={handleCopyMessage}>
                  {copied ? <Check size={14} /> : <Clipboard size={14} />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{copied ? S.bubble.copied[lang] : S.bubble.copyMessage[lang]}</TooltipContent>
            </Tooltip>
            {/* P3-26: Read aloud (TTS) — only for assistant messages */}
            {!isUser && !isSystem && ttsSupported && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="toolbar-btn"
                    onClick={handleReadAloud}
                    disabled={isTtsLoading}
                    style={isTtsLoading ? { opacity: 0.5 } : {}}
                  >
                    {isSpeaking && ttsMessageId === message.id
                      ? <StopIcon size={14} fill="currentColor" />
                      : isTtsLoading
                      ? <Clock size={14} />
                      : <Volume2 size={14} />
                    }
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {isSpeaking && ttsMessageId === message.id
                    ? S.voice.stopReading[lang]
                    : S.voice.readAloud[lang]
                  }
                </TooltipContent>
              </Tooltip>
            )}
            {contentCollapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => setContentCollapsed(false)}>
                    <BookOpen size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.expand[lang]}</TooltipContent>
              </Tooltip>
            )}
            {!contentCollapsed && contentRef.current && contentRef.current.scrollHeight > COLLAPSE_THRESHOLD && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="toolbar-btn" onClick={() => setContentCollapsed(true)}>
                    <BookX size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{S.bubble.collapse[lang]}</TooltipContent>
              </Tooltip>
            )}
            {/* Feedback buttons inline in toolbar — same row as copy/collapse */}
            {!isUser && !isSystem && !isStreaming && message.content && (
              <SlotBridge name="app.message-feedback" fallback={FeedbackButtons} message={message} sessionId={sessionId} inline />
            )}
          </div>
        )}

        {/* P0: Feedback buttons removed from here — now inline in toolbar above */}

        {/* StatsLine — 对标 DSH 助手消息统计行：turn 耗时/token/吞吐量 */}
        {!isUser && !isSystem && !isStreaming && message.content && (
          <StatsLine message={message} />
        )}

        {/* TurnStatus — 对标 DSH 持久化 turn 级状态行（error/max-tokens/retry） */}
        {!isUser && !isSystem && message.metadata?.turnStatus && (
          <TurnStatus {...(message.metadata.turnStatus as any)} />
        )}

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
