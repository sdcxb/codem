/**
 * AgentMessageQueue — Async Agent→Agent message passing
 *
 * Unlike wait_for_subagent (synchronous blocking), this allows agents to
 * send messages to each other asynchronously. Results are consumed at
 * iteration boundaries (like guidance), not inside tool callbacks.
 *
 * Persistence: agent_messages SQLite table for session recovery.
 * Key design: messages are NOT stored in v2_sessions.messages JSON,
 * so context compaction does not affect them.
 */

export interface AgentMessage {
  id: string;
  sessionId: string;
  fromAgent: string;
  toAgent: string;
  messageType: "request" | "notification" | "reply";
  subject: string;
  body: string;
  status: "pending" | "consumed";
  sequence: number;
  createdAt: number;
}

const queues = new Map<string, AgentMessage[]>(); // keyed by toAgent
const sequenceCounter = new Map<string, number>();
/**
 * messageId → 回复正文。
 *
 * ⚠️ 第 62 轮（稳定性审计实测）：这里原来是**无上界**的 —— 每次 `send({messageType:"reply"})`
 * 都塞一整段回复正文进来，**从不删除**，于是"agent 之间来回对话越多、常驻内存越大"。
 * 审计里它属于"无上界内存结构"清单（`src/core/llm` 共 9 个）。
 * 现在给一个**条数上界 + 先进先出逐出**：回复在同一个回合内就会被读走
 * （`agentic-loop.ts` 的 `wait_for_subagent` 路径），超出窗口的老回复被逐出后
 * `getReply()` 返回 `null`（调用方本来就要处理"还没回复"这一态）。
 */
const consumedReplies = new Map<string, string>(); // messageId → response body
/** 保留的回复条数上界（正文可能很大，所以按条数而不是字节数控制，简单且可预测） */
const MAX_CONSUMED_REPLIES = 200;

function rememberReply(messageId: string, body: string): void {
  consumedReplies.set(messageId, body);
  // Map 的迭代顺序 = 插入顺序 ⇒ 删最早的键就是 FIFO
  while (consumedReplies.size > MAX_CONSUMED_REPLIES) {
    const oldest = consumedReplies.keys().next();
    if (oldest.done) break;
    consumedReplies.delete(oldest.value);
  }
}

type MessageListener = (message: AgentMessage) => void;
const listeners = new Set<MessageListener>();

export function onAgentMessage(listener: MessageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(message: AgentMessage): void {
  listeners.forEach((l) => {
    try { l(message); } catch (e) { console.warn("[AgentMessageQueue] listener error:", e); }
  });
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const AgentMessageQueue = {
  /**
   * Send a message from one agent to another.
   * The message is queued and will be consumed at the next iteration boundary
   * of the receiving agent.
   */
  send(params: {
    sessionId: string;
    fromAgent: string;
    toAgent: string;
    messageType: "request" | "notification" | "reply";
    subject: string;
    body: string;
    replyToId?: string;
  }): AgentMessage {
    const seq = (sequenceCounter.get(params.toAgent) || 0) + 1;
    sequenceCounter.set(params.toAgent, seq);

    const message: AgentMessage = {
      id: generateId(),
      sessionId: params.sessionId,
      fromAgent: params.fromAgent,
      toAgent: params.toAgent,
      messageType: params.messageType,
      subject: params.subject,
      body: params.body,
      status: "pending",
      sequence: seq,
      createdAt: Date.now(),
    };

    // If this is a reply, store the response body for the waiting sender
    if (params.messageType === "reply" && params.replyToId) {
      // 走有上界的写入（见 `rememberReply` 的说明：这里原来是无上界的常驻内存）
      rememberReply(params.replyToId, params.body);
    }

    let queue = queues.get(params.toAgent);
    if (!queue) {
      queue = [];
      queues.set(params.toAgent, queue);
    }
    queue.push(message);
    emit(message);
    return message;
  },

  /**
   * Consume pending messages for a specific agent.
   * Called at iteration boundaries (like guidance.consume).
   */
  consume(toAgent: string): AgentMessage[] {
    const queue = queues.get(toAgent);
    if (!queue || queue.length === 0) return [];
    const messages = [...queue];
    queues.set(toAgent, []);
    return messages;
  },

  /**
   * Check if there are pending messages for an agent.
   */
  hasPending(toAgent: string): boolean {
    const queue = queues.get(toAgent);
    return !!queue && queue.length > 0;
  },

  /**
   * Get reply for a specific message (used by wait_for_subagent alternative).
   * Returns null if reply not yet received.
   */
  getReply(messageId: string): string | null {
    return consumedReplies.get(messageId) || null;
  },

  /**
   * Clear all messages for a session.
   */
  clearSession(sessionId: string): void {
    for (const [agent, queue] of queues) {
      const filtered = queue.filter((m) => m.sessionId !== sessionId);
      queues.set(agent, filtered);
    }
  },

  /**
   * Get pending messages count for an agent (for UI display).
   */
  pendingCount(toAgent: string): number {
    return queues.get(toAgent)?.length || 0;
  },
};
