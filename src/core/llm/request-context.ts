/**
 * 最近一次真实模型请求的上下文快照。
 *
 * 水位原先只能"按当前消息再估算一遍"——system、tools、运行时提醒与实际请求
 * 不可能逐项对齐。这里在请求发出前记录本次请求的**可见消息 id 集合**、system 字符数、
 * 工具 schema 大小；响应后补上 provider 上报的 `promptTokens`。水位在 id 集合完全一致的
 * 这一拍直接使用真实 promptTokens；集合变了（新消息/删除/压缩）就退回估算。
 */
import { estimateTokens, estimateToolDefinitionTokens } from "./token-tracker";

export interface RequestContextSnapshot {
  sessionId: string;
  at: number;
  model?: string;
  /** 请求发出时模型可见的消息 id（顺序一致才算同一集合） */
  visibleIds: string[];
  /** id + 内容/思考/工具长度指纹：同 id 被编辑/工具结果变化时也必须失效 */
  visibleFingerprint: string;
  /** 请求时的窗口；换模型/窗口变化后旧 promptTokens 不可复用 */
  contextWindow: number;
  systemPromptChars: number;
  systemTokens: number;
  toolTokens: number;
  /** provider 上报的真实 prompt tokens；0 = 尚未拿到 */
  promptTokens: number;
}

/**
 * 可见消息的内容指纹。只用 id 会在“编辑同一 id / 工具结果更新”时误用旧快照；
 * 只用长度会在“等长编辑”时漏判，所以对正文做轻量 FNV-1a 哈希。
 */
export function messageSetFingerprint(messages: Array<{
  id: string;
  content?: unknown;
  reasoning?: unknown;
  toolCalls?: Array<{ args?: unknown; result?: unknown }>;
}>): string {
  return messages.map((m) => {
    const content = typeof m.content === "string" ? hashText(m.content) : "0";
    const reasoning = typeof m.reasoning === "string" ? hashText(m.reasoning) : "0";
    let tools = "0";
    for (const tc of m.toolCalls ?? []) {
      if (typeof tc.result === "string") tools = hashText(tools + tc.result);
      if (tc.args !== undefined) tools = hashText(tools + JSON.stringify(tc.args));
    }
    return `${m.id}#${content}#${reasoning}#${tools}`;
  }).join("|");
}

function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const snapshots = new Map<string, RequestContextSnapshot>();
const completedRequests = new Map<string, { promptTokens: number; at: number; visibleCount: number; contextWindow: number }>();
const MAX_AGE_MS = 30 * 60 * 1000;

export function recordRequestContext(input: {
  sessionId: string;
  visibleIds: string[];
  visibleFingerprint: string;
  contextWindow: number;
  systemPrompt: string;
  tools: unknown[];
  model?: string;
}): void {
  if (!input.sessionId) return;
  const systemPromptChars = input.systemPrompt.length;
  snapshots.set(input.sessionId, {
    sessionId: input.sessionId,
    at: Date.now(),
    model: input.model,
    visibleIds: [...input.visibleIds],
    visibleFingerprint: input.visibleFingerprint,
    contextWindow: Math.max(0, Math.floor(Number(input.contextWindow) || 0)),
    systemPromptChars,
    systemTokens: estimateTokens(input.systemPrompt),
    toolTokens: estimateToolDefinitionTokens(input.tools),
    promptTokens: 0,
  });
}

/** 响应 usage 到达后补真实 prompt tokens；没有快照时忽略（不凭 usage 猜会话） */
export function recordRequestPromptTokens(sessionId: string, promptTokens: number): void {
  if (!sessionId || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
  const current = snapshots.get(sessionId);
  if (!current) return;
  completedRequests.set(sessionId, {
    promptTokens: Math.floor(promptTokens),
    at: Date.now(),
    visibleCount: current.visibleIds.length,
    contextWindow: current.contextWindow,
  });
  snapshots.set(sessionId, { ...current, promptTokens: Math.floor(promptTokens), at: Date.now() });
}

/** 最近一次真实请求完成后 provider 上报的 promptTokens（真机取证；不是当前水位） */
export function readLastCompletedRequest(sessionId: string): { promptTokens: number; at: number } | null {
  const v = completedRequests.get(sessionId);
  if (!v) return null;
  return { promptTokens: v.promptTokens, at: v.at };
}

export function readRequestContext(sessionId: string): RequestContextSnapshot | null {
  const snapshot = snapshots.get(sessionId);
  if (!snapshot) return null;
  if (Date.now() - snapshot.at > MAX_AGE_MS) {
    snapshots.delete(sessionId);
    return null;
  }
  return snapshot;
}

/** 仅判据使用：清空快照，避免用例互相污染 */
export function __resetRequestContextForTests(): void {
  snapshots.clear();
  completedRequests.clear();
}
