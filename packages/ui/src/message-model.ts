/**
 * 共享消息模型（第 2 步：桌面默认路径切到共享 `MessageBubble`）。
 *
 * 这里只描述**气泡需要看到的字段**，不复制桌面的 `store.ts`：
 * 桌面 `Message`（`src/store.ts`）在结构上是它的超集 ⇒ 可以直接传入，
 * 不需要在桌面侧做任何品牌/适配转换。
 *
 * 不引入桌面类型，是为了保证 `packages/ui` 不反向依赖 `src/`：
 * 宿主（桌面 / 手机 / 未来任何壳）只通过 `ChatPlatform` 注入运行时能力。
 */

export type Lang = "zh" | "en";

export interface RetrievedSourceLike {
  sourceId: string;
  sourceName: string;
  /** 桌面 `RetrievedSource` 必填；共享侧只读，因此放宽为可选 */
  chunkIndex: number;
  snippet: string;
  score?: number;
}

export type AttachmentKind = "file" | "image" | "code" | "url" | "video" | "audio";

export interface AttachmentLike {
  id: string;
  name: string;
  type: AttachmentKind;
  /** 仅「刚上传那一刻」在内存里；读路径上的消息正文按需取（宿主负责） */
  content?: string;
  preview?: string;
  mimeType?: string;
  size?: number;
  sandboxPath?: string;
}

export type ToolCallState = "pending" | "running" | "done" | "error";

export interface ToolCallLike {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status: ToolCallState;
  metadata?: Record<string, any>;
}

export interface MessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  toolCalls?: ToolCallLike[];
  attachments?: AttachmentLike[];
  status?: "pending" | "streaming" | "done" | "error";
  generatedFiles?: string[];
  retrievedSources?: RetrievedSourceLike[];
  metadata?: Record<string, any>;
}
