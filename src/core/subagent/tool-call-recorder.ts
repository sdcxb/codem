/**
 * Bot/子智能体回合的**工具调用落库记录器**（`LLMEngine.processSubagent` 专用）。
 *
 * ## 为什么需要它
 *
 * `processSubagent` 消费 `AgenticLoop.run()` 的事件流，但从来没有写入者像
 * `executor.ts` 那样把 `tool_start` / `tool_complete` / `tool_error` 落进消息表。
 * 结果就是 Bot 会话里「模型调过工具」这件事**不存在**：下一轮 `buildMessages`
 * 只从消息表读 ⇒ 模型看到的是「我还没调用过任何工具」⇒ 重发同一个调用，直到空转。
 *
 * ## 与 UI 执行器**同源**（不是第二套语义）
 *
 * 落库动作全部走 `../session/tool-call-persistence`（`addToolCall` / `updateToolCall`
 * 与结果规范化、溢出策略只有那一份实现）；本文件只负责**什么时候写哪一条**：
 *
 * | 事件 | 动作 |
 * |---|---|
 * | `start`（新迭代） | 上一条助手行定稿（`status: "done"`），下一次工具调用换挂新行 |
 * | `tool_start` | 按需建助手行 + `addToolCall`（`running`） |
 * | `tool_complete` | `updateToolCall`（`done` + 结果，含溢出/元数据） |
 * | `tool_error` | `updateToolCall`（`error` + 错误正文） |
 *
 * ## 两个刻意的取舍
 *
 * 1. **懒建行**：只在真有工具调用时建助手行（`ensureMessage` 由 `tool_*` 触发）。
 *    不能像执行器那样在每个 `start` 就建行 —— Bot 会话里模型不调工具的轮次会让历史
 *    多出一串空白助手气泡；而 `resolveAssistantMessageId` 回调也必须**只返回已有行**，
 *    否则每一轮都会触发一次建行。
 * 2. **同一行内按调用 id 去重**：真实循环对同一次调用会发两条 `tool_start`
 *    （见 `startedCallIds` 的说明），只写第一条；写入失败**不标记已写**，
 *    让重放事件仍有机会补上（同时一定 `reportPersistFailure`，不静默）。
 */
import type { LoopEvent } from "../llm/agentic-loop";
import * as MessageStorage from "../storage/message";
import { reportPersistFailure } from "../storage/persist-failure";
import {
  persistToolCallError,
  persistToolCallStart,
  persistToolCallSuccess,
} from "../session/tool-call-persistence";

export interface SubagentToolCallRecorder {
  /**
   * 当前迭代的助手行 id（**没有行时返回 `undefined`，绝不建行**）。
   *
   * 接进 `AgenticLoopConfig.resolveAssistantMessageId`：工具执行时引擎拿它写
   * `tool_call` / `tool_result` 事件的 `messageId`（用引擎自造的 `msg-…` 会让
   * 那两条事件引用一条不存在的消息）。
   */
  currentAssistantMessageId(): string | undefined;
  /** 处理一条循环事件（在事件转发给消费方**之前**调用） */
  handle(event: LoopEvent): Promise<void>;
  /** 回合收尾：把最后一条助手行定稿（幂等；不会建行） */
  finalize(): void;
}

export interface CreateSubagentToolCallRecorderOptions {
  sessionId: string;
  /** 助手行 id 前缀（默认 `assistant`，与执行器同一形态；测试可换） */
  idPrefix?: string;
  /** 注入时钟（测试用；默认 `Date.now`） */
  now?: () => number;
}

/**
 * 建一个「本回合」的记录器。
 *
 * 每个 `processSubagent` 调用建一个、随生成器结束丢弃 —— 状态（当前行 id、
 * 本行已写过的调用 id）只属于这一次回合，不跨回合共享。
 */
export function createSubagentToolCallRecorder(
  options: CreateSubagentToolCallRecorderOptions,
): SubagentToolCallRecorder {
  const { sessionId } = options;
  const prefix = options.idPrefix ?? "assistant";
  const now = options.now ?? (() => Date.now());

  let currentId = "";
  let sequence = 0;
  /**
   * 保证新行的时间戳严格递增：同一毫秒内建两行时，读侧排序才不会把两轮揉在一起。
   *
   * 初值取**建记录器的时刻**（而不是 0）：`processSubagent` 在它之前刚写过那条 user
   * 消息，助手行的时间戳必须晚于它，否则「user → assistant(工具调用) → tool 结果」
   * 的先后顺序在按时间戳排序的读侧可能翻掉。
   */
  let lastTimestamp = now();
  const createdIds = new Set<string>();
  /**
   * **本行**已写过的调用 id（去重范围 = 当前助手行，即当前迭代）。
   *
   * 真实循环对同一次调用会发**两条** `tool_start`（流式 `tool_use_end` 一条、
   * 真正开始执行一条）—— 只写第一条即可。刻意**不跨行**去重：不同迭代里模型
   * 若复用同一个 call id，执行器的做法是各自成条（第二次也带正确工具名），
   * 这里保持同一语义，而不是把它误判成重复事件。
   */
  let startedCallIds = new Set<string>();

  const nextTimestamp = (): number => {
    const stamp = Math.max(now(), lastTimestamp + 1);
    lastTimestamp = stamp;
    return stamp;
  };

  /** 按需建一条**空的流式**助手行（与执行器 `ensureAssistantMessage` 同形） */
  const ensureMessage = (): string => {
    if (!currentId) {
      sequence += 1;
      currentId = `${prefix}-${now()}-${sequence}`;
    }
    if (!createdIds.has(currentId)) {
      createdIds.add(currentId);
      try {
        MessageStorage.createMessage(
          {
            id: currentId,
            role: "assistant",
            content: "",
            timestamp: nextTimestamp(),
            status: "streaming",
          },
          sessionId,
        );
      } catch (e) {
        reportPersistFailure(
          "subagent.toolCall.createAssistant",
          e,
          `Bot/子智能体会话 ${sessionId} 的助手行 ${currentId} 没建起来：工具调用与结果将无处挂载` +
            `（下一轮模型会看不到它们）`,
        );
      }
    }
    return currentId;
  };

  /** 上一条助手行定稿并换行（下一轮的调用不再挂在上一轮的行上） */
  const settleAndRotate = (): void => {
    if (!currentId) return;
    const settledId = currentId;
    currentId = "";
    /* 去重范围跟着行走（见 `startedCallIds` 的说明） */
    startedCallIds = new Set<string>();
    if (!createdIds.has(settledId)) return;
    try {
      MessageStorage.updateMessage(settledId, { status: "done" });
    } catch (e) {
      reportPersistFailure(
        "subagent.toolCall.settleAssistant",
        e,
        `Bot/子智能体会话 ${sessionId} 的助手行 ${settledId} 没能定稿（会一直显示为流式中）`,
      );
    }
  };

  return {
    currentAssistantMessageId(): string | undefined {
      /* 只回**已有**的行：引擎会在每次工具批之前问一次，这里若建行就会给纯文本轮次留空壳 */
      return createdIds.has(currentId) ? currentId : undefined;
    },

    async handle(event: LoopEvent): Promise<void> {
      try {
        switch (event.type) {
          case "start": {
            /* 新迭代：与执行器一致，上一轮的行定稿、调用换挂到新行 */
            settleAndRotate();
            return;
          }
          case "tool_start": {
            const toolCall = event.toolCall;
            if (!toolCall?.id) return;
            if (startedCallIds.has(toolCall.id)) return;
            /* 只有真的写成功才记「已写」：写失败时同一事件重放仍有机会补上 */
            if (persistToolCallStart(ensureMessage(), toolCall)) {
              startedCallIds.add(toolCall.id);
            }
            return;
          }
          case "tool_complete": {
            const toolCall = event.toolCall;
            if (!toolCall?.id) return;
            await persistToolCallSuccess({
              sessionId,
              messageId: ensureMessage(),
              toolCall,
              result: event.result,
            });
            return;
          }
          case "tool_error": {
            const toolCall = event.toolCall;
            /* 空 id 的 tool_error 是 LLM 级失败（不是一次真实调用），这里不落（见落库模块头） */
            if (!toolCall?.id) return;
            persistToolCallError(ensureMessage(), toolCall, event.error);
            return;
          }
          default:
            return;
        }
      } catch (e) {
        /* 兜底：落库模块自己已按站点上报；这里是「谁都没接住」的最后一道网（不静默、不打断回合） */
        reportPersistFailure(
          "subagent.toolCall",
          e,
          `Bot/子智能体会话 ${sessionId} 处理事件 ${String((event as { type?: string })?.type ?? "?")} 时落库失败` +
            `（这一轮的工具结果可能进不了模型上下文）`,
        );
      }
    },

    finalize(): void {
      settleAndRotate();
    },
  };
}
