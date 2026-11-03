/**
 * 共享消息气泡（第 2 步：桌面默认渲染路径已切换到本实现）。
 *
 * 边界（`docs/architecture/UI-UNIFY-PLAN.md`）：
 * - **共享**：气泡 DOM / 类名 / data-*、折叠与展开状态机、系统提醒折叠行、
 *   引用来源 chip、生成文件确认、悬浮工具栏（复制/编辑/精选/朗读/折叠/反馈）、
 *   推理与统计等**位置**、流式揭示与「历史消息默认折叠」口径；
 * - **注入**（`ChatPlatform`，全部必填）：正文渲染器（RichContent / Markdown）、
 *   附件与画廊、工具区、反馈、推理行、错误卡、行内编辑、统计行、turn 状态行、
 *   来源引用面板、TTS、文件链接、提示气泡、消息语义分类。
 *
 * 没有「有适配器 / 没适配器」两条路径：缺 Provider 直接抛错，
 * 宿主必须显式实现每一个槽位（手机端可以先给能力最小的实现，但必须是显式的）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  BookX,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Clock,
  Pencil,
  PencilLine,
  Pin,
  PinOff,
  Square as StopIcon,
  Trash2,
  Undo2,
  User,
  Volume2,
  Zap,
} from "lucide-react";

import { useChatPlatform } from "./chat-platform";
import type { MessageLike } from "./message-model";

// Threshold for long message collapse (in pixels)
const COLLAPSE_THRESHOLD = 400;
// P2: 折叠字符阈值 —— content-visibility: auto 下屏外消息 scrollHeight 不可靠
// （布局被跳过），用字符长度估算作为主判断。约 1500 字符 ≈ 400px 文本高度。
const COLLAPSE_CHARS = 1500;

export interface MessageBubbleProps {
  message: MessageLike;
  index?: number;
  showReasoning?: boolean;
  onDeleteFiles?: (files: string[]) => void;
  /** true if this is the last assistant message in the current Q&A turn */
  isLastInTurn?: boolean;
  /** true if this is the newest assistant message in the whole session */
  isLatestMessage?: boolean;
  /** Called when user clicks a citation — opens SourceViewer */
  onCitationClick?: (sourceName: string) => void;
  /** Called when user clicks a source in the metadata-driven sources panel */
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
  /** P0: Called when user edits a message and wants to resend */
  onEditAndResend?: (messageId: string, newContent: string) => void;
  /** P0 (message-rewind 对标): Edit a past user message and rewind — the edited
   *  message is resent in a NEW forked session (original session untouched),
   *  instead of destructive in-place resend. */
  onEditAndRewind?: (messageId: string, newContent: string) => void;
  /** P0 (dsh-navbar 精选 pin 对标): assistant 消息精选到右侧导航条 */
  pinned?: boolean;
  onTogglePin?: (messageId: string) => void;
  /** P0: Called when user wants to restore a message to the input box */
  onReEdit?: (content: string) => void;
  /** P0: Session ID for DB persistence (feedback) */
  sessionId?: string;
  /** P0: Whether editing is allowed (e.g. disabled during streaming) */
  canEdit?: boolean;
}

/** User avatar — 只是外观；头像来源由宿主设置注入 */
function UserAvatar({ src }: { src: string }) {
  if (src) {
    return (
      <div className="user-msg-avatar" style={{
        width: 24, height: 24, borderRadius: "50%", overflow: "hidden",
        flexShrink: 0, border: "1px solid var(--border-primary)",
      }}>
        <img src={src} alt="me" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div className="user-msg-avatar" style={{
      width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
      background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <User size={14} style={{ color: "var(--text-muted)" }} />
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  index,
  showReasoning = true,
  onDeleteFiles,
  isLastInTurn,
  isLatestMessage,
  onCitationClick,
  onSourceClick,
  onEditAndResend,
  onEditAndRewind,
  onReEdit,
  sessionId,
  canEdit = true,
  pinned,
  onTogglePin,
}: MessageBubbleProps) {
  const platform = useChatPlatform();
  const lang = platform.lang;
  const strings = platform.strings;
  const displayMode = platform.displayMode;
  const isStreaming = message.status === "streaming";

  const [showFilesConfirm, setShowFilesConfirm] = useState(false);
  const [contentCollapsed, setContentCollapsed] = useState(false);
  const [systemExpanded, setSystemExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingRewind, setIsEditingRewind] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  /**
   * 消息语义由宿主判定（机器注入提醒 / 跨会话委派 / 运行中引导语 / 自动成链），
   * 共享层只消费结果 —— 否则两边会各写一份判定，迟早分叉。
   *
   * 不做 memo：流式期间 message 引用会随 token 变化，缓存反而可能读到上一帧正文
   * （第 233 轮的教训：气泡的热路径上只允许纯计算）。
   */
  const desc = platform.describe(message);
  const isUser = desc.isUser;
  const isSystem = desc.isSystem;
  const delegatedTask = desc.isDelegatedTask;
  const machineInjected = desc.isMachineInjected;
  const midTurnGuidance = desc.midTurnGuidance;
  const displayContent = desc.displayContent;
  const rawContent = desc.rawContent;
  const isError = message.status === "error";

  // P1: Stream reveal — 揭示计数由正文渲染器自己算（RichContent 需要），
  // 气泡只负责把 streaming 标记传下去。

  const handleCopyMessage = useCallback(() => {
    navigator.clipboard.writeText(rawContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [rawContent]);

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
    // so the user can read it immediately. 重开会话时“最新一条”同样不折叠。
    if (wasStreamedRef.current || isLatestMessage) return;
    // P2: content-visibility: auto 下屏外消息不布局，scrollHeight 不可靠。
    // 用字符长度估算为主（稳定、不依赖布局），scrollHeight 作为补充测量。
    const estimatedTall = displayContent.length > COLLAPSE_CHARS;
    const measured = contentRef.current && contentRef.current.scrollHeight > COLLAPSE_THRESHOLD;
    if (estimatedTall || measured) {
      setContentCollapsed(true);
    }
  }, [isStreaming, displayContent, isLatestMessage]);

  /**
   * 机器注入的 [SYSTEM] 提醒是给模型的上下文，不是用户消息。
   * 不隐藏它（SYSINJ 要求提醒内容仍可取证），但压成一行状态；
   * 原始大段只在点开后显示，避免它抢走整轮对话的视觉主体。
   */
  if (isSystem && machineInjected && !delegatedTask) {
    const noticeText = displayContent.replace(/^\[SYSTEM\]\s*/, "").replace(/\*\*/g, "");
    const noticeSummary = noticeText.split("\n")[0]?.slice(0, 160) || noticeText.slice(0, 160);
    return (
      <div
        className="message message-bubble system system-status"
        data-message-id={message.id}
        data-message-kind="system"
      >
        <button
          className="system-status-head"
          aria-expanded={systemExpanded}
          onClick={() => setSystemExpanded((v) => !v)}
        >
          <AlertTriangle className="icon-sm system-status-icon" />
          <span className="system-status-title">{strings.systemNoticeTitle}</span>
          <span className="system-status-summary">{noticeSummary}</span>
          {systemExpanded ? <ChevronUp className="icon-xs" /> : <ChevronDown className="icon-xs" />}
        </button>
        {systemExpanded && (
          <div className="system-status-body">{noticeText}</div>
        )}
      </div>
    );
  }

  const canCollapse =
    (contentRef.current && contentRef.current.scrollHeight > COLLAPSE_THRESHOLD) ||
    displayContent.length > COLLAPSE_CHARS;

  return (
    <div
      className={`message message-bubble ${isUser ? "user" : isSystem ? "system" : "assistant"} ${delegatedTask ? "delegated-task" : ""} ${displayMode === "unified" ? "unified-mode" : ""}`}
      data-message-id={message.id}
      data-message-kind={delegatedTask ? "delegated-task" : isUser ? "user" : isSystem ? "system" : "assistant"}
    >
      {isUser && !delegatedTask && <UserAvatar src={platform.avatarSrc} />}
      <div className="message-body">
        {/*
          ## 委派任务记录：**不能长得像用户自己说的话**（第 194 波，GAP-LIST O-56）

          真机现场：别的会话委派进来的任务（正文是一份完整交接），在界面上就是一条**普通用户气泡** ——
          用户看到"最新一条是交接记录、我后面聊的变成历史"时，无法判断这是**别人派进来的任务**
          还是**自己刚说的话**。这里给它一条明确的抬头 + 独立的类名（`delegated-task`），
          正文照旧渲染（它确实是给这一轮用的指令），只是**身份**不再含糊。
        */}
        {delegatedTask && (
          <div className="delegated-task-header">
            {/* 不加图标：`ICON-1` 棘轮钉住"TSX 里的字面图标尺寸只许降"，这处没有既有尺寸常量可复用 */}
            <span className="delegated-task-label">
              {strings.delegatedTaskLabel}
            </span>
          </div>
        )}
        {/* AI message inline header — replaces avatar (aligned with wecode/frakio) */}
        {!isUser && !isSystem && (
          <div className="ai-msg-header">
            <Bot size={16} />
            <span className="ai-msg-name">Codem</span>
            {message.timestamp > 0 && (
              <span className="ai-msg-time">
                {new Date(message.timestamp).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
        {/* 思考块：DSH 单行，放在正文之前；计算顺序是“思考 → 正文 → 工具回执”。 */}
        {!isUser && !isSystem && message.reasoning && showReasoning && (
          platform.renderReasoning({ message, running: isStreaming })
        )}

        {/* 运行中追加的标记（区别于"回合结束后才说的话"） */}
        {midTurnGuidance && (
          <div className="midturn-guidance-header">
            <Zap className="icon-xs" />
            <span className="midturn-guidance-label">
              {strings.midRunGuidanceLabel}
            </span>
          </div>
        )}

        {/* Attachments / gallery / video（宿主负责读正文与画廊转场） */}
        {platform.renderAttachments(message)}

        {/*
          P1 #20: Error card for error messages
          这张卡片挂在**助手**的错误行上；`onEditAndResend` 的语义是
          "编辑并重发**用户消息**"，这条路径上不存在重试入口，
          所以宿主必须如实渲染（`retryable={false}`，不画按不动的按钮）。
        */}
        {isError && !isUser && platform.renderError({ message, lang })}

        {/* Long message collapse wrapper (#3) */}
        <div
          className={`message-content-wrapper ${contentCollapsed && !isStreaming ? "collapsed" : ""}`}
        >
          {isEditing && isUser ? (
            platform.renderEditor({
              initialContent: rawContent,
              onSave: (newContent: string) => {
                setIsEditing(false);
                const rewind = isEditingRewind;
                setIsEditingRewind(false);
                if (rewind) {
                  onEditAndRewind?.(message.id, newContent);
                } else {
                  onEditAndResend?.(message.id, newContent);
                }
              },
              onCancel: () => { setIsEditing(false); setIsEditingRewind(false); },
            })
          ) : (
          <div className="message-content" ref={contentRef}>
            {platform.renderBody({
              message,
              content: displayContent,
              isUser,
              streaming: isStreaming,
              onCitationClick,
            })}
          </div>
          )}
          {/* Collapse overlay with expand button */}
          {!isEditing && contentCollapsed && !isStreaming && (
            <div className="collapse-overlay" onClick={() => setContentCollapsed(false)}>
              <span className="collapse-btn">{strings.expand} ▼</span>
            </div>
          )}
        </div>

        {/* Collapsed indicator (when collapsed, show a small expand hint) */}
        {!isEditing && contentCollapsed && !isStreaming && (
          <button className="content-collapsed-hint" onClick={() => setContentCollapsed(false)}>
            {strings.expand} · {contentRef.current?.scrollHeight ?? 0}px →
          </button>
        )}

        {/* Sources panel — structured metadata-driven citations (对标 NotebookLM) */}
        {!isUser && citationSources.length > 0 && !isStreaming && (
          <div className="nb-msg-sources">
            <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.5, alignSelf: 'center' }}>
              {strings.sourcesLabel}
            </span>
            {citationSources.map((src) => (
              <button
                key={src.sourceId}
                className="nb-msg-source-chip"
                onClick={() => onSourceClick?.(src.sourceId, src.chunkIndex)}
                title={src.snippet}
                style={{
                  fontSize: 'var(--fs-xs)',
                  padding: '2px 8px',
                  background: 'var(--bg-tertiary, #25252b)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: "var(--radius-md)",
                  color: 'var(--text-secondary, #a0a0a8)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)';
                  e.currentTarget.style.color = 'var(--accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-primary)';
                  e.currentTarget.style.color = 'var(--text-secondary, #a0a0a8)';
                }}
              >
                <BookOpen size={14} className="icon-inline" /> {src.sourceName}
              </button>
            ))}
          </div>
        )}

        {/* 工具区（专用卡 / 连续合并 / 插件槽都在宿主；槽位本身是共享位置） */}
        {message.toolCalls && message.toolCalls.length > 0 && platform.renderTools({ message })}

        {message.generatedFiles && message.generatedFiles.length > 0 && (
          <div className="generated-files">
            {!showFilesConfirm ? (
              <button
                className="files-cleanup-btn"
                onClick={() => setShowFilesConfirm(true)}
              >
                {/* 第 46 波：文案里的 emoji 换成与项目一致的线性图标 */}
                <Trash2 size={14} className="icon-inline" />
                <span>{strings.cleanFiles} ({message.generatedFiles.length})</span>
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
                    {strings.delete}
                  </button>
                  <button
                    className="files-cancel-btn"
                    onClick={() => setShowFilesConfirm(false)}
                  >
                    {strings.cancel}
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
              platform.renderTip({
                label: strings.editAndResend,
                children: (
                  <button className="toolbar-btn" aria-label={strings.editAndResend} onClick={() => { setIsEditing(true); setIsEditingRewind(false); }}>
                    <Pencil size={14} />
                  </button>
                ),
              })
            )}
            {isUser && canEdit && onEditAndRewind && (
              platform.renderTip({
                label: strings.editAndRewind,
                children: (
                  <button className="toolbar-btn" aria-label={strings.editAndRewind} onClick={() => { setIsEditing(true); setIsEditingRewind(true); }}>
                    <Undo2 size={14} />
                  </button>
                ),
              })
            )}
            {isUser && canEdit && onReEdit && (
              platform.renderTip({
                label: strings.reEdit,
                children: (
                  /*
                    ⚠️ 第 63 轮（UI 走查抓到）：这一组工具栏按钮里，只有这三个**没有可访问名**
                    （既无 `aria-label` 也无 `title`，里面只有一个 `<svg>`），而左右相邻的按钮都有。
                    后果不是"看不见"而是"说不出来"：读屏软件只念"按钮"，键盘/自动化也拿不到名字
                    —— 真机走查里它们就是那三个 `label: ""` 的条目。
                  */
                  <button className="toolbar-btn" aria-label={strings.reEdit} onClick={() => onReEdit(rawContent)}>
                    <PencilLine size={14} />
                  </button>
                ),
              })
            )}
            {platform.renderTip({
              label: copied ? strings.copied : strings.copyMessage,
              children: (
                <button
                  className="toolbar-btn"
                  aria-label={copied ? strings.copied : strings.copyMessage}
                  onClick={handleCopyMessage}
                >
                  {copied ? <Check size={14} /> : <Clipboard size={14} />}
                </button>
              ),
            })}
            {/* P0 (dsh-navbar 精选 pin 对标): assistant 消息精选到右侧导航条 */}
            {!isUser && !isSystem && onTogglePin && sessionId && (
              platform.renderTip({
                label: pinned ? strings.unpinFromNav : strings.pinToNav,
                children: (
                  <button
                    className={`toolbar-btn ${pinned ? "pin-active" : ""}`}
                    aria-label={pinned ? strings.unpinFromNav : strings.pinToNav}
                    onClick={() => onTogglePin(message.id)}
                  >
                    {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                ),
              })
            )}
            {/* P3-26: Read aloud (TTS) — only for assistant messages */}
            {!isUser && !isSystem && platform.readAloud.supported && (
              platform.renderTip({
                label: platform.readAloud.isSpeaking(message.id) ? strings.stopReading : strings.readAloud,
                children: (
                  <button
                    className="toolbar-btn"
                    aria-label={
                      platform.readAloud.isSpeaking(message.id)
                        ? strings.stopReading
                        : strings.readAloud
                    }
                    onClick={() => platform.readAloud.toggle(message)}
                    disabled={platform.readAloud.isLoading(message.id)}
                    style={platform.readAloud.isLoading(message.id) ? { opacity: 0.5 } : {}}
                  >
                    {platform.readAloud.isSpeaking(message.id)
                      ? <StopIcon size={14} fill="currentColor" />
                      : platform.readAloud.isLoading(message.id)
                      ? <Clock size={14} />
                      : <Volume2 size={14} />
                    }
                  </button>
                ),
              })
            )}
            {contentCollapsed && (
              platform.renderTip({
                label: strings.expand,
                children: (
                  <button className="toolbar-btn" aria-label={strings.expand} onClick={() => setContentCollapsed(false)}>
                    <BookOpen size={14} />
                  </button>
                ),
              })
            )}
            {!contentCollapsed && canCollapse && (
              platform.renderTip({
                label: strings.collapse,
                children: (
                  <button className="toolbar-btn" aria-label={strings.collapse} onClick={() => setContentCollapsed(true)}>
                    <BookX size={14} />
                  </button>
                ),
              })
            )}
            {/* Feedback buttons inline in toolbar — same row as copy/collapse */}
            {!isUser && !isSystem && !isStreaming && message.content && (
              platform.renderFeedback({ message, sessionId, inline: true })
            )}
          </div>
        )}

        {/* P0: Feedback buttons removed from here — now inline in toolbar above */}

        {/* StatsLine — 对标 DSH 助手消息统计行：turn 耗时/token/吞吐量 */}
        {!isUser && !isSystem && !isStreaming && message.content && platform.renderStats(message)}

        {/* TurnStatus — 对标 DSH 持久化 turn 级状态行（error/max-tokens/retry） */}
        {!isUser && !isSystem && message.metadata?.turnStatus && platform.renderTurnStatus(message)}

        {/* P2: Source references for RAG-based messages */}
        {!isUser && !isSystem && message.metadata?.sources && (message.metadata.sources as any[]).length > 0 && (
          platform.renderSourceReferences({
            sources: (message.metadata.sources as any[]).map(s => ({
              sourceId: s.sourceId || s.id || "",
              sourceName: s.sourceName || s.name || "",
              chunkIndex: s.chunkIndex || 0,
              snippet: s.snippet || s.content || "",
              score: s.score || 0,
            })),
            onSourceClick,
          })
        )}
      </div>
    </div>
  );
});
