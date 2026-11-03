/**
 * 桌面消息气泡入口 + 桌面平台适配器（第 2 步）。
 *
 * **气泡本体只有一份实现**：`packages/ui/src/message-bubble.tsx`（骨架 / DOM / 类名 /
 * 折叠与工具栏状态机）。本文件不再渲染任何气泡骨架，只做两件事：
 * 1. `useDesktopChatPlatform()`：把桌面运行时（store / Tauri / 插件槽 / 富文本 / TTS /
 *    工具卡 / 文件链接 / 消息语义判定）组装成 `ChatPlatform`；
 * 2. 用 `<ChatPlatformProvider>` 注入共享气泡 —— 没有「有适配器 / 没适配器」两条路径。
 *
 * 保留 `./MessageBubble` 这个导出路径，是因为 `ChatPanel` / `NbChatPanel`
 * 以及既有判据都从这里取组件；**不是**第二份气泡实现。
 *
 * 为什么适配器放在这个文件里（而不是单独的新文件）：可达性门禁按 `git ls-files src`
 * 取源码集合，新建但未提交的文件不参与 BFS；把桌面运行时放在新的 src 文件里会
 * 让 `RichContent` / `ToolCallCard` 等一票组件在门禁里变成"不可达"（假红）。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  Check,
  CheckCircle,
  Clock,
  FileText,
  Image as ImageIcon,
  XCircle,
} from "lucide-react";

import { Message, useAppStore } from "../store";
import { ChatPlatformProvider } from "../../packages/ui/src/chat-platform";
import type {
  BubbleStrings,
  ChatPlatform,
  MessageDescription,
} from "../../packages/ui/src/chat-platform";
import type { Lang, MessageLike } from "../../packages/ui/src/message-model";
import { MessageMarkdown } from "../../packages/ui/src/message-markdown";
import {
  MessageBubble as SharedMessageBubble,
  type MessageBubbleProps,
} from "../../packages/ui/src/message-bubble";

import { ShikiCodeBlock } from "./ShikiCodeBlock";
import { getLang, useLang, S } from "../core/i18n/lang";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { splitGraphemes } from "../core/llm/stream-reveal";
import { InlineMessageEdit } from "./InlineMessageEdit";
import { FeedbackButtons } from "./FeedbackButtons";
import { getSubagentRuntime } from "../core/subagent/index";
import { isDelegatedTaskMessage, isMachineInjectedMessage } from "../core/storage/session";
import { SlotBridge } from "../core/slots/SlotBridge";
import { SourceReferences } from "./SourceReferences";
import { formatBytes } from "../core/utils/bytes";
import { ImageGallery } from "./ImageGallery";
import { VideoPlayer } from "./VideoPlayer";
import { RichContent } from "./rich-content/RichContent";
import { createFileMentions } from "../utils/file-mentions";
import { autoLinkFilePaths } from "../utils/auto-link-paths";
import { isMidTurnGuidance, guidanceDisplayMessage } from "../core/llm/guidance-display";
import { flushSync } from "react-dom";
import { runViewTransition } from "../core/ui/view-transition";
import { openFileLink, handleFileLinkClick, handleFileLinkContextMenu } from "../utils/file-link";
import { useSpeechSynthesis } from "../hooks/useSpeechSynthesis";
import { getMultimodalSettings, textToSpeech, playTTSAudio } from "../core/llm/multimodal";
import { getSettingJSON } from "../core/storage/settings";
import { getAttachmentContent } from "../core/storage/message";
import type { UserConfig } from "../core/types";
import { ErrorCard } from "./ErrorCard";
import { ToolCallGroup } from "./ToolCallGroup";
import type { ToolCallCardProps } from "./ToolCallCard";
import { StatsLine } from "./StatsLine";
import { TurnStatus } from "./TurnStatus";
import { ReasoningRow } from "./ReasoningRow";

const DEFAULT_USER_CONFIG: UserConfig = {
  name: "",
  callBy: "",
  pronouns: "",
  timezone: "",
  notes: "",
  context: "",
  raw: "",
  avatar: "",
};

/**
 * 工具结果进入 DOM 前的硬上限。
 *
 * 真机有一个 7 MB 的 tool_result：整段 JSON 交给 ToolCallCard 后，
 * read/diff/search 判定、逐行 split、语法高亮都会在打开会话时扫全量，
 * 单次主线程 585ms。完整结果仍在会话日志与库里；聊天卡片只需要可读预览。
 */
const MAX_TOOL_RESULT_DISPLAY_CHARS = 8 * 1024;

function toolResultForDisplay(result: string | undefined): string | undefined {
  if (!result || result.length <= MAX_TOOL_RESULT_DISPLAY_CHARS) return result;
  return (
    result.slice(0, MAX_TOOL_RESULT_DISPLAY_CHARS) +
    `\n\n…（输出过长，已截断显示；完整结果保留在会话日志）`
  );
}

/** 桌面代码高亮器：共享代码块外壳 + 桌面 Shiki（移动端不需要背 WASM） */
const renderShikiCode = (code: string, language: string) => (
  <ShikiCodeBlock code={code} language={language} />
);

/** 共享气泡要的文案集（全部来自桌面 i18n 真源 `S`） */
function bubbleStrings(lang: Lang): BubbleStrings {
  return {
    copyMessage: S.bubble.copyMessage[lang],
    copied: S.bubble.copied[lang],
    editAndResend: S.bubble.editAndResend[lang],
    editAndRewind: S.bubble.editAndRewind[lang],
    reEdit: S.bubble.reEdit[lang],
    pinToNav: S.bubble.pinToNav[lang],
    unpinFromNav: S.bubble.unpinFromNav[lang],
    expand: S.bubble.expand[lang],
    collapse: S.bubble.collapse[lang],
    cleanFiles: S.bubble.cleanFiles[lang],
    delete: S.bubble.delete[lang],
    cancel: S.bubble.cancel[lang],
    readAloud: S.voice.readAloud[lang],
    stopReading: S.voice.stopReading[lang],
    delegatedTaskLabel:
      lang === "zh" ? "委派任务（来自其它会话）" : "Delegated task (from another session)",
    systemNoticeTitle: lang === "zh" ? "系统提醒" : "System notice",
    midRunGuidanceLabel: lang === "zh" ? "运行中追加" : "Mid-run guidance",
    sourcesLabel: lang === "zh" ? "来源:" : "Sources:",
  };
}

/**
 * 消息语义 + 展示正文的唯一判定（原 `MessageBubble` 内联逻辑，原样搬出）。
 *
 * 这里刻意**不**放进共享层：`isMachineInjectedMessage` / `isDelegatedTaskMessage`
 * 的口径属于桌面存储层（`core/storage/session.ts`），
 * 共享层只消费结果，避免两边各写一份判定。
 */
function describeMessage(message: MessageLike): MessageDescription {
  const m = message as unknown as Message;
  const machineInjected = isMachineInjectedMessage(m);
  const isUser = m.role === "user" && !machineInjected;
  const delegatedTask = isDelegatedTaskMessage(m);
  /** 机器注入的提醒按「系统说明」渲染（居中、无用户头衔、无编辑入口），但仍显示正文 */
  const isSystem = m.role === "system" || (machineInjected && !delegatedTask);
  /**
   * 运行中追加（mid-turn guidance）的消息：落库内容是「附件内联块 + 注入模板」，
   * 但**用户要看的是他自己写的那句话**，不是模板里那句 "Runtime guidance from the user"。
   */
  const midTurnGuidance = isUser && isMidTurnGuidance(m);
  const rawContent = isUser
    ? (midTurnGuidance
        ? guidanceDisplayMessage(m)
        : m.content.replace(/<attachment>[\s\S]*?<\/attachment>\s*/g, "").trim())
    : m.content;
  // P1-2: Process citations — convert [Source N: name] to clickable markdown links
  // + Auto-link: bare file paths → Markdown links (rendering-layer safety net)
  const displayContent = isUser
    ? rawContent
    : autoLinkFilePaths(rawContent.replace(/\[Source\s+(\d+):\s*([^\]]+)\]/g, '[📖 $1](#cite-$1 "$2")'));

  return {
    isUser,
    isSystem,
    isDelegatedTask: delegatedTask,
    isMachineInjected: machineInjected,
    midTurnGuidance,
    displayContent,
    rawContent,
  };
}

/** 正文渲染器：助手走 RichContent（KaTeX/GFM/流式揭示），用户走共享 Markdown */
function DesktopBody({
  message,
  content,
  isUser,
  streaming,
  lang,
  onCitationClick,
}: {
  message: MessageLike;
  content: string;
  isUser: boolean;
  streaming: boolean;
  lang: Lang;
  onCitationClick?: (sourceName: string) => void;
}) {
  // P1: Stream reveal — compute reveal count for animation
  const revealCount = useMemo(() => {
    if (!streaming || !content) return 0;
    const graphemes = splitGraphemes(content);
    return Math.min(graphemes.length, 15);
  }, [streaming, content]);
  const revealRevision = useMemo(() => content.length, [content.length]);

  // 方案 B：从本轮工具调用记录构建 file-mention resolver，
  // 让 LLM 在结束语中以 `filename` 反引号提及的文件变成可点击链接。
  // 仅在非流式（已结束）时生效，避免中途文件列表不完整导致误解析。
  const fileMentions = useMemo(() => {
    if (isUser || streaming || !message.toolCalls?.length) return null;
    return createFileMentions(message.toolCalls as never, (path) => void openFileLink(path));
  }, [isUser, streaming, message.toolCalls]);

  if (!isUser) {
    return (
      <RichContent
        content={content}
        streaming={streaming}
        revealCount={revealCount}
        revealRevision={revealRevision}
        className=""
        fileMentions={fileMentions}
      />
    );
  }
  return (
    <MessageMarkdown
      content={content}
      copyLabel={S.bubble.copy[lang]}
      renderHighlight={renderShikiCode}
      onCitationClick={onCitationClick}
      onLinkClick={handleFileLinkClick}
      onLinkContextMenu={handleFileLinkContextMenu}
    />
  );
}

/**
 * 附件区（文件卡 / 图片画廊 / 视频）——桌面读正文与画廊转场都在这里。
 *
 * ## 附件正文的**读取路径**（第 92 轮修的真缺陷）
 *
 * 现场（隔离钻取，装机版 1.16.138 实测）：给一条消息挂上真附件后，界面上**能看到**
 * 「文件名 + 大小」（元数据走域镜像），但**点开是空的** ——
 * 因为这里原来只读 `att.content`，而**读路径**上的消息（重启后 / 从镜像读）
 * 按设计**不带正文**（`attachmentsFromMirror`：正文可能几十 MB，一律留空、按需取）。
 *
 * 现在：点开时走 `getAttachmentContent(id)`（同步缓存 → 命中即显示；未命中会触发一次
 * 异步预取），并用**有界重试**（4 次、退避 400/800/1200/1600ms）等预取落地；
 * 一直读不到就**如实说**"暂时读不到、再点一次可重试"，不再给一个永远空的框。
 */
function DesktopAttachments({ message }: { message: MessageLike }) {
  const [showAttachment, setShowAttachment] = useState<string | null>(null);
  const [attachmentText, setAttachmentText] = useState<Record<string, string | undefined>>({});
  const [attachmentHint, setAttachmentHint] = useState<Record<string, string | undefined>>({});
  const [pendingAttachment, setPendingAttachment] = useState<{ id: string; tries: number } | null>(null);
  const [galleryImages, setGalleryImages] = useState<string[] | null>(null);
  const [galleryIndex, setGalleryIndex] = useState(0);
  /* 共享元素转场名：与缩略图上的 view-transition-name 成对（判据 VIEWTRANS-*） */
  const [galleryTransitionName, setGalleryTransitionName] = useState<string | undefined>(undefined);

  /**
   * 附件正文的**有界重试**：`getAttachmentContent` 是同步的（未命中就返回 undefined
   * 并触发一次异步预取），所以这里按 400/800/1200/1600ms 退避重试 4 次；
   * 定时器在依赖变化/卸载时**必须清掉**（不然消息列表滚动/卸载会留下野定时器）。
   */
  useEffect(() => {
    if (!pendingAttachment) return;
    const { id, tries } = pendingAttachment;
    if (tries >= 4) {
      setAttachmentHint((prev) => ({
        ...prev,
        [id]: getLang() === "zh"
          ? "正文暂时读不到（已触发预取，再点一次可重试）"
          : "Content not available yet (prefetch triggered — click again to retry)",
      }));
      setPendingAttachment(null);
      return;
    }
    const timer = setTimeout(() => {
      const text = getAttachmentContent(id);
      if (text !== undefined) {
        setAttachmentText((prev) => ({ ...prev, [id]: text }));
        setAttachmentHint((prev) => ({ ...prev, [id]: undefined }));
        setPendingAttachment(null);
      } else {
        setPendingAttachment({ id, tries: tries + 1 });
      }
    }, 400 * (tries + 1));
    return () => clearTimeout(timer);
  }, [pendingAttachment]);

  return (
    <>
      {message.attachments && message.attachments.length > 0 && (
        <div className="message-attachments">
          {message.attachments.map((att) => (
            <div
              key={att.id}
              className="message-attachment"
              onClick={() => {
                const closing = showAttachment === att.id;
                setShowAttachment(closing ? null : att.id);
                if (closing) return;
                /**
                 * 展开时**按需取正文**（见上面那段注释）：内存里有（刚上传）直接用；
                 * 没有就走 `getAttachmentContent` + 有界重试 —— 读路径上的消息正文不在镜像里。
                 */
                if (att.content || att.type === "image") return;
                if (attachmentText[att.id] !== undefined) return;
                const cached = getAttachmentContent(att.id);
                if (cached !== undefined) {
                  setAttachmentText((prev) => ({ ...prev, [att.id]: cached }));
                  setAttachmentHint((prev) => ({ ...prev, [att.id]: undefined }));
                } else {
                  setPendingAttachment({ id: att.id, tries: 0 });
                }
              }}
            >
              {att.type === "image" && att.content ? (
                <img
                  src={att.content}
                  alt={att.name}
                  className="attachment-image"
                  style={{
                    // 画廊打开期间缩略图必须有名字，否则共享元素会"两个同名元素"失效
                    viewTransitionName: galleryImages
                      ? "none"
                      : `chat-image-${att.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const imgs = message.attachments?.filter(a => a.type === "image" && a.content).map(a => a.content!) || [];
                    const name = `chat-image-${att.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                    runViewTransition(() => {
                      flushSync(() => {
                        setGalleryImages(imgs);
                        setGalleryIndex(imgs.indexOf(att.content || ""));
                        setGalleryTransitionName(name);
                      });
                    });
                  }}
                />
              ) : (
                <div className="attachment-file">
                  <span className="attachment-icon">{att.type === "image" ? <ImageIcon size={16} /> : <FileText size={16} />}</span>
                  <span className="attachment-name">{att.name}</span>
                  {att.size && <span className="attachment-size">{formatBytes(att.size)}</span>}
                </div>
              )}
              {showAttachment === att.id && att.type !== "image" && (
                <>
                  {(attachmentText[att.id] ?? att.content) ? (
                    <pre className="attachment-preview">{attachmentText[att.id] ?? att.content}</pre>
                  ) : (
                    /**
                     * 读不到就**如实说**（而不是给一个永远空的框）：
                     * 读路径上的正文不在镜像里，第一次点开可能还在预取；说清"再点一次"。
                     */
                    <div className="attachment-preview attachment-preview--pending">
                      {attachmentHint[att.id] ??
                        (getLang() === "zh" ? "正在读取正文…" : "Loading content…")}
                    </div>
                  )}
                </>
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
          transitionName={galleryTransitionName}
          onClose={() => {
            setGalleryImages(null);
            setGalleryTransitionName(undefined);
          }}
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
    </>
  );
}

/** 子智能体状态行（桌面全局 SubagentRuntime） */
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
    return <span className="subagent-status done icon-inline"><CheckCircle size={12} /> {displayName} {zh ? "完成" : "completed"}{summary ? `: ${summary}` : ""}</span>;
  }
  if (status === "failed") {
    return <span className="subagent-status failed icon-inline"><XCircle size={12} /> {displayName} {zh ? "失败" : "failed"}</span>;
  }
  return <span className="subagent-status running icon-inline"><Clock size={12} /> {displayName} {zh ? "运行中..." : "running..."}</span>;
}

/** 工具区：笔记操作提示 + 插件槽（fallback 连续工具组）+ 子智能体状态行 */
function DesktopToolSection({ message, initialExpanded }: { message: MessageLike; initialExpanded: boolean }) {
  const lang = useLang();
  const [toolsExpanded] = useState(initialExpanded);
  const toolCalls = message.toolCalls ?? [];
  // B9: Detect note operation tools for prominent display
  const noteOps = toolCalls.filter(tc =>
    ['create_note', 'edit_note', 'link_notes', 'delete_note'].includes(tc.tool)
  );
  const hasNoteOps = noteOps.length > 0;

  return (
    <div className="tool-calls">
      {/* B9: Note operation notifications — always visible */}
      {hasNoteOps && (
        <div className="note-op-notifications">
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
                    ? 'color-mix(in srgb, var(--error) 10%, transparent)'
                    : isDone
                    ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                    : 'color-mix(in srgb, var(--warning) 10%, transparent)',
                  border: `1px solid ${
                    isError ? 'color-mix(in srgb, var(--error) 30%, transparent)'
                    : isDone ? 'color-mix(in srgb, var(--accent) 30%, transparent)'
                    : 'color-mix(in srgb, var(--warning) 30%, transparent)'
                  }`,
                  borderRadius: "var(--radius-sm)",
                  fontSize: 'var(--fs-sm)',
                  color: 'var(--text-secondary, #a0a0a8)',
                }}
              >
                <span>{isError ? <XCircle size={12} /> : isDone ? <FileText size={12} /> : <Clock size={12} />}</span>
                <span style={{ fontWeight: 500 }}>
                  {opLabel}{title ? `: "${title}"` : ''}
                </span>
                {isDone && tc.result && (
                  <span style={{ opacity: 0.6, fontSize: 'var(--fs-xs)' }}><Check size={10} /></span>
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
        items={toolCalls.map((tc): ToolCallCardProps => {
          // 支持新旧工具名
          const isSubagent = tc.tool === "spawn_subagent" || tc.tool === "subagent";
          let agentName = isSubagent ? (tc.args?.name || tc.args?.description) as string : null;
          if (!agentName && isSubagent && tc.result && tc.result.length < 200_000) {
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
            toolResult: toolResultForDisplay(tc.result),
            status: tc.status as "running" | "done" | "error",
            duration: (tc.metadata as any)?.duration,
            argsSummary: typeof rawSummary === "string" && rawSummary ? rawSummary : undefined,
            metadata: tc.metadata as Record<string, any> | undefined,
          };
        })}
        title={`${toolCalls.length} ${S.bubble.toolCalls[lang]}`}
        defaultExpanded={toolsExpanded}
      />
      {/* Subagent status polling — 支持 spawn_subagent (旧) 和 subagent (新) */}
      <div className="subagent-status-row">
      {toolCalls.filter(tc => {
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
    </div>
  );
}

/**
 * 桌面平台实例。
 *
 * 依赖（语言 / 显示模式 / 头像 / TTS 状态）变化时才产生新对象；
 * 气泡本身是 `memo()` 的，父级无变化的重渲染不会改变这个引用
 * （`chat-streaming-suffix` 钉住的浅比较防线仍然有效）。
 */
function useDesktopChatPlatform(): ChatPlatform {
  const lang = useLang();
  const displayMode = useAppStore((s) => s.displayMode);
  // 与原来的 `UserAvatar` 一致：每次渲染读一次设置（改头像后下一次渲染即生效）
  const avatarSrc = getSettingJSON<UserConfig>("codem-user", DEFAULT_USER_CONFIG).avatar || "";

  // P3-26: TTS — text-to-speech for message content
  const { isSpeaking, isSupported: ttsSupported, speak: ttsSpeak, cancel: ttsCancel } = useSpeechSynthesis();
  const [isTtsLoading, setIsTtsLoading] = useState(false);
  const [ttsMessageId, setTtsMessageId] = useState<string | null>(null);

  // Handle read aloud button click
  const handleReadAloud = useCallback(async (message: MessageLike) => {
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
  }, [isSpeaking, ttsMessageId, ttsCancel, ttsSpeak]);

  const strings = useMemo(() => bubbleStrings(lang), [lang]);

  return useMemo<ChatPlatform>(() => ({
    lang,
    displayMode,
    strings,
    avatarSrc,
    describe: describeMessage,
    renderBody: ({ message, content, isUser, streaming, onCitationClick }) => (
      <DesktopBody
        message={message}
        content={content}
        isUser={isUser}
        streaming={streaming}
        lang={lang}
        onCitationClick={onCitationClick}
      />
    ),
    renderAttachments: (message) => <DesktopAttachments message={message} />,
    renderTools: ({ message }) => (
      <DesktopToolSection message={message} initialExpanded={displayMode !== "unified"} />
    ),
    renderFeedback: ({ message, sessionId, inline }) => (
      <SlotBridge
        name="app.message-feedback"
        fallback={FeedbackButtons}
        message={message as unknown as Message}
        sessionId={sessionId}
        inline={inline}
      />
    ),
    renderReasoning: ({ message, running }) => (
      <ReasoningRow text={message.reasoning || ""} running={running} />
    ),
    renderError: ({ message, lang: errorLang }) => (
      <ErrorCard
        title={errorLang === "zh" ? "执行出错" : "Execution Error"}
        message={message.content || (errorLang === "zh" ? "未知错误" : "Unknown error")}
        details={message.reasoning || undefined}
        retryable={false}
      />
    ),
    renderEditor: ({ initialContent, onSave, onCancel }) => (
      <InlineMessageEdit
        initialContent={initialContent}
        onSave={onSave}
        onCancel={onCancel}
      />
    ),
    renderStats: (message) => <StatsLine message={message as unknown as Message} />,
    renderTurnStatus: (message) => (
      <TurnStatus {...((message.metadata?.turnStatus ?? {}) as any)} />
    ),
    renderSourceReferences: ({ sources, onSourceClick }) => (
      <SourceReferences
        sources={sources.map((s) => ({
          sourceId: s.sourceId,
          sourceName: s.sourceName,
          chunkIndex: s.chunkIndex,
          snippet: s.snippet,
          score: s.score ?? 0,
        }))}
        onSourceClick={onSourceClick}
      />
    ),
    renderTip: ({ label, children }) => (
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    ),
    readAloud: {
      supported: ttsSupported,
      isSpeaking: (messageId: string) => isSpeaking && ttsMessageId === messageId,
      // 与原实现一致：云端 TTS 请求期间所有朗读按钮都禁用（加载态是全局的）
      isLoading: () => isTtsLoading,
      toggle: (message: MessageLike) => {
        void handleReadAloud(message);
      },
    },
    fileLinks: {
      open: (path: string) => {
        void openFileLink(path);
      },
      click: handleFileLinkClick,
      contextMenu: handleFileLinkContextMenu,
    },
  }), [
    lang,
    displayMode,
    strings,
    avatarSrc,
    ttsSupported,
    isSpeaking,
    ttsMessageId,
    isTtsLoading,
    handleReadAloud,
  ]);
}

/**
 * 桌面消息气泡（对外导出兼容的入口）。
 *
 * 组件本体在 `packages/ui/src/message-bubble.tsx`；这里只负责注入桌面平台。
 * 仍用 `memo()` 保持与第 233 轮相同的浅比较防线（`chat-streaming-suffix` 钉住它）。
 */
export const MessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
  const platform = useDesktopChatPlatform();
  return (
    <ChatPlatformProvider value={platform}>
      <SharedMessageBubble {...props} />
    </ChatPlatformProvider>
  );
});

export type { MessageBubbleProps };

