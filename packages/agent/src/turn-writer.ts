/**
 * **TurnWriter** —— 一个回合的"落库契约"（阶段 1 抽出）。
 *
 * ## 为什么需要它（三次真机/Spike 事故的合并结论）
 *
 * 1. **进入会话要 hydrate 权威日志**：`listMessagesMerged` 在日志镜像为空时短路成"只返回索引"，
 *    不 hydrate 就等于"本回合写的行看不见"；
 * 2. **工具结果必须在下一轮请求定稿前落库**：否则模型看不到 `role:"tool"`，会重复调同一个工具
 *    直到空转（Host/无人值守实测）；
 * 3. **收尾必须写正文**：否则界面上留下一条永远 streaming 的空壳，且"没有正文"会被误判成成功。
 *
 * 这三步原来散在 `runtime.ts` 与 `message.ts` 的注释里；现在收口到这里，
 * Host / 未来的 Tauri 2.0 后台执行器 / 测试都可以复用同一份顺序。
 *
 * 本文件**不直接依赖**渲染侧存储模块（由调用方注入），于是可以在 Node、测试、渲染侧三处复用。
 */

export interface TurnWriterStorage {
  createMessage(message: unknown, sessionId: string): void;
  updateMessage(id: string, patch: unknown): void;
  addToolCall(messageId: string, call: unknown): void;
  updateToolCall(messageId: string, toolId: string, patch: unknown): void;
  /** 进入会话时把权威日志读进内存镜像（失败不应阻断回合） */
  hydrateSessionLog(sessionId: string): Promise<number>;
}

export interface TurnWriterOptions {
  sessionId: string;
  storage: TurnWriterStorage;
  /** 注入时钟（测试用） */
  now?: () => number;
  /** id 前缀（Host 用 `host`，测试可换） */
  idPrefix?: string;
}

export interface ToolResultInfo {
  toolCall: { id: string; name: string; input?: unknown };
  result: unknown;
}

export interface TurnWriter {
  /** 进入会话：hydrate + 建 user 行 + 建 assistant 空壳；返回两个 id */
  begin(userText: string): Promise<{ userId: string; assistantId: string }>;
  /** 工具完成：写 `role:"tool"` 行 + 回填工具调用状态（**在下一轮请求前调用**） */
  onToolResult(info: ToolResultInfo): void;
  /** 收尾：把累积正文写回助手行 */
  finish(text: string, state: "succeeded" | "failed" | "cancelled"): void;
}

export function createTurnWriter(opts: TurnWriterOptions): TurnWriter {
  const { sessionId, storage } = opts;
  const now = opts.now ?? (() => Date.now());
  const prefix = opts.idPrefix ?? "turn";

  let userId = "";
  let assistantId = "";
  let started = false;

  return {
    async begin(userText: string): Promise<{ userId: string; assistantId: string }> {
      if (started) throw new Error("TurnWriter.begin 只能调用一次（一个回合一条助手行）");
      started = true;
      // ① hydrate 必须早于任何写：否则本回合的行在重建上下文时不可见
      await storage.hydrateSessionLog(sessionId).catch(() => 0);
      const base = now();
      userId = `${prefix}-user-${base}`;
      assistantId = `${prefix}-assistant-${base}`;
      storage.createMessage({ id: userId, role: "user", content: userText, timestamp: base, status: "done" }, sessionId);
      storage.createMessage(
        { id: assistantId, role: "assistant", content: "", timestamp: base + 1, status: "done" },
        sessionId,
      );
      return { userId, assistantId };
    },

    onToolResult(info: ToolResultInfo): void {
      const call = info?.toolCall;
      if (!call?.id || !assistantId) return;
      const output = String((info.result as { output?: string } | undefined)?.output ?? "");
      storage.addToolCall(assistantId, {
        id: call.id,
        tool: call.name,
        args: (call.input ?? {}) as Record<string, unknown>,
        status: "running",
      });
      storage.createMessage(
        {
          id: `${prefix}-tool-${call.id}`,
          role: "tool",
          content: output,
          toolCallId: call.id,
          // 工具名必须随行落库：重开历史时 assistant.toolCalls 可能没有持久化，
          // 只靠事件回放会丢名字（真机：历史工具卡显示 tool）。
          metadata: { toolName: call.name },
          timestamp: now(),
          status: "done",
        },
        sessionId,
      );
      storage.updateToolCall(assistantId, call.id, { status: "done", result: output });
    },

    finish(text: string, state: "succeeded" | "failed" | "cancelled"): void {
      if (!assistantId) return;
      storage.updateMessage(assistantId, {
        content: text,
        // 取消也写 error：界面上不能留一条永远 streaming 的空壳
        status: state === "succeeded" ? "done" : "error",
      });
    },
  };
}
