/**
 * 聊天平台适配层（第 2 步）。
 *
 * `MessageBubble` 的结构、状态机、类名与 DOM 只有**一份**（本包）。
 * 宿主差异（富文本渲染器、附件读取、工具卡、反馈、TTS、文件链接、消息分类）
 * 全部由宿主通过 `ChatPlatform` 注入 —— 没有「有适配器 / 没适配器」两条渲染路径：
 * 所有字段都是**必填**，缺任何一项都编译不过（运行期缺 Provider 直接抛错）。
 */
import { createContext, useContext } from "react";
import type { MouseEvent, ReactNode } from "react";

import type { Lang, MessageLike, RetrievedSourceLike } from "./message-model";

/** 正文渲染（助手 RichContent / 用户 Markdown 由宿主决定，共享层不猜） */
export interface BodyRenderContext {
  message: MessageLike;
  /** 最终展示用正文（已剥离附件块 / 已应用引用与文件路径链接） */
  content: string;
  isUser: boolean;
  streaming: boolean;
  /** 点击正文里的 `#cite-N` 引用上标 */
  onCitationClick?: (sourceName: string) => void;
}

/** 工具区（连续工具合并、专用卡、插件槽都由宿主决定） */
export interface ToolsRenderContext {
  message: MessageLike;
}

/** 反馈按钮（桌面走插件槽 + 领域状态） */
export interface FeedbackRenderContext {
  message: MessageLike;
  sessionId?: string;
  inline: boolean;
}

export interface ReasoningRenderContext {
  message: MessageLike;
  running: boolean;
}

export interface ErrorRenderContext {
  message: MessageLike;
  lang: Lang;
}

export interface EditorRenderContext {
  initialContent: string;
  onSave: (newContent: string) => void;
  onCancel: () => void;
}

export interface SourceReferencesRenderContext {
  sources: RetrievedSourceLike[];
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
}

/** 语音朗读（桌面：浏览器 TTS / 云端 TTS；其它宿主可 `supported: false`） */
export interface ReadAloudApi {
  supported: boolean;
  isSpeaking: (messageId: string) => boolean;
  isLoading: (messageId: string) => boolean;
  toggle: (message: MessageLike) => void;
}

/** 文件链接（桌面走 Tauri；其它宿主走自己的实现） */
export interface FileLinkApi {
  /** 直接打开一个路径（用于文件提及 resolver 等无事件场景） */
  open: (path: string) => void;
  click: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
  contextMenu: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

/**
 * 消息语义分类 + 展示正文。
 *
 * 这些判定属于宿主的存储/引擎口径（机器注入提醒、跨会话委派任务、
 * 运行中追加的引导语、裸路径自动成链），共享层只消费结果，
 * 不自己再写一份判定（否则两边会分叉）。
 */
export interface MessageDescription {
  isUser: boolean;
  isSystem: boolean;
  isDelegatedTask: boolean;
  isMachineInjected: boolean;
  midTurnGuidance: boolean;
  /** 最终展示正文 */
  displayContent: string;
  /** 复制按钮要复制的原文（用户消息已剥离附件块） */
  rawContent: string;
}

/** 共享气泡需要的最小文案集（宿主按语言提供） */
export interface BubbleStrings {
  copyMessage: string;
  copied: string;
  editAndResend: string;
  editAndRewind: string;
  reEdit: string;
  pinToNav: string;
  unpinFromNav: string;
  expand: string;
  collapse: string;
  cleanFiles: string;
  delete: string;
  cancel: string;
  readAloud: string;
  stopReading: string;
  delegatedTaskLabel: string;
  systemNoticeTitle: string;
  midRunGuidanceLabel: string;
  sourcesLabel: string;
}

/** 悬浮提示（桌面 Radix Tooltip；其它宿主可用原生 title，但必须注入） */
export interface TipRenderContext {
  label: string;
  children: ReactNode;
}

export interface ChatPlatform {
  lang: Lang;
  /** 桌面 `unified` / `segmented`；共享层只用它决定初始折叠与容器类名 */
  displayMode: string;
  strings: BubbleStrings;
  /** 用户头像（设置里的自定义头像；空串表示用默认图标） */
  avatarSrc: string;
  describe: (message: MessageLike) => MessageDescription;
  renderBody: (ctx: BodyRenderContext) => ReactNode;
  renderAttachments: (message: MessageLike) => ReactNode;
  renderTools: (ctx: ToolsRenderContext) => ReactNode;
  renderFeedback: (ctx: FeedbackRenderContext) => ReactNode;
  renderReasoning: (ctx: ReasoningRenderContext) => ReactNode;
  renderError: (ctx: ErrorRenderContext) => ReactNode;
  renderEditor: (ctx: EditorRenderContext) => ReactNode;
  renderStats: (message: MessageLike) => ReactNode;
  renderTurnStatus: (message: MessageLike) => ReactNode;
  renderSourceReferences: (ctx: SourceReferencesRenderContext) => ReactNode;
  renderTip: (ctx: TipRenderContext) => ReactNode;
  readAloud: ReadAloudApi;
  fileLinks: FileLinkApi;
}

const ChatPlatformContext = createContext<ChatPlatform | null>(null);

export function ChatPlatformProvider({
  value,
  children,
}: {
  value: ChatPlatform;
  children: ReactNode;
}) {
  return <ChatPlatformContext.Provider value={value}>{children}</ChatPlatformContext.Provider>;
}

export function useChatPlatform(): ChatPlatform {
  const platform = useContext(ChatPlatformContext);
  if (!platform) {
    throw new Error(
      "MessageBubble 需要 <ChatPlatformProvider>：宿主必须注入 ChatPlatform（没有「无适配器」的默认路径）",
    );
  }
  return platform;
}
