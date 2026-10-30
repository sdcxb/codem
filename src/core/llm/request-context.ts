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
  systemPromptChars: number;
  systemTokens: number;
  toolTokens: number;
  /** provider 上报的真实 prompt tokens；0 = 尚未拿到 */
  promptTokens: number;
}

const snapshots = new Map<string, RequestContextSnapshot>();
const MAX_AGE_MS = 30 * 60 * 1000;

export function recordRequestContext(input: {
  sessionId: string;
  visibleIds: string[];
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
  snapshots.set(sessionId, { ...current, promptTokens: Math.floor(promptTokens), at: Date.now() });
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
}
