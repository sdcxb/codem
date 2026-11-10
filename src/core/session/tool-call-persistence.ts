/**
 * 工具调用/结果落库的**唯一实现** —— UI 执行器（`executor.ts`）与 Bot/子智能体路径
 * （`LLMEngine.processSubagent`）共用这一份，**禁止再各写一套**。
 *
 * ## 为什么抽到一处（这条缺陷的真身）
 *
 * `AgenticLoop` 每一轮都从消息表重建上下文（`buildMessages` → `messagesToLLMMessages`），
 * 而工具调用/结果只有落进**某条助手消息的 `toolCalls`** 才会被带进下一轮请求。
 * UI 路径由 `executor.ts` 写（`addToolCall` / `updateToolCall`），所以正常聊天看得到工具结果；
 * Bot 子智能体路径以前只转发事件、一个字节都不写 ⇒ 下一轮模型看到的是
 * 「我还没调用过任何工具」⇒ 重发同一个调用，直到迭代上限/空转。
 *
 * 语义只能有一份：结果规范化（字符串 / `{ output, metadata }` / 其它 JSON）、
 * 超大结果溢出（`retainToolResult`）、状态流转（running → done/error）——
 * 两条路径各写一遍必然分叉，这个仓库已经在别处反复吃过「同一事实两份实现」的亏。
 *
 * ## 空 id 的 `tool_error` 不落
 *
 * `AgenticLoop` 在 **LLM 调用失败**时也会 yield `tool_error`，但那条事件的
 * `toolCall` 是 `{ id: "", name: "" }`（并没有一次真实调用）。把它写进去会造出一条
 * id 为空的「幽灵工具调用」——下一轮它还会被当成一条已完成的 `tool_call` +
 * 一条 tool 结果发给模型。这里显式跳过（`id` 为空 = 不是一次真实调用）。
 */
import * as MessageStorage from "../storage/message";
import { reportPersistFailure } from "../storage/persist-failure";
import { retainToolResult } from "../storage/spill";

/**
 * 循环事件里工具调用的**最小形状**（`tool_start` / `tool_complete` / `tool_error` 都带它）。
 *
 * 刻意只声明落库用得到的字段，而不是 import `StreamingToolCall`：
 * 这个模块是存储边界，不该依赖 LLM 循环的内部类型（两条路径都能传入自己的形状）。
 */
export interface PersistableToolCall {
  id: string;
  name?: string;
  input?: Record<string, unknown>;
  /** 少数 provider 把工具名放在 metadata 里（与 `args.name` 的兜底同源，见 `persistToolCallStart`） */
  metadata?: { name?: string };
}

/** 结果正文规范化后的形状（`metadata` 只在工具结果对象显式给了才出现） */
interface NormalizedToolResult {
  text: string;
  metadata?: Record<string, any>;
}

/**
 * 工具结果 → 文本 + 结构化元数据（**唯一口径**）。
 *
 * 三种形态与 `executor.ts` 改前的实现逐字一致：
 * 1. 字符串：原样用；
 * 2. `{ output, metadata }`：取 `output`，`metadata` 一并留下（如 subagentId）；
 * 3. 其它：`JSON.stringify`（`null`/`undefined` 归一成空串）。
 *
 * ⚠️ `output` 理论上应是字符串，但工具自己 return 一个数字/对象时旧实现会在
 * `resultStr.replace(...)` 处**直接抛**（把整个回合炸掉）。这里显式 `String(...)`：
 * 落库失败绝不该杀死任务本身。
 */
function normalizeToolResult(result: unknown): NormalizedToolResult {
  if (typeof result === "string") return { text: result };
  if (result && typeof result === "object" && "output" in (result as Record<string, unknown>)) {
    const output = (result as Record<string, unknown>).output;
    const metadata = (result as { metadata?: Record<string, any> }).metadata;
    const text =
      typeof output === "string" ? output : output === undefined || output === null ? "" : String(output);
    return metadata ? { text, metadata } : { text };
  }
  try {
    return { text: JSON.stringify(result || "") };
  } catch {
    /* 循环引用等 JSON 化失败：退回 String（宁可少结构，也不许把回合炸掉） */
    return { text: String(result ?? "") };
  }
}

/** 与其余读取口径一致：`<system-reminder>` 是机器注入，不该进工具结果正文 */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/**
 * `tool_start`：把这次调用挂到**真实存在**的助手消息上（`status: "running"`）。
 *
 * `args` 的形状与 `executor.ts` 改前逐字一致（`{ ...input, name: input.name || metadata.name }`）——
 * 有些工具把名字放在参数里，历史读侧依赖它。
 *
 * @returns 是否真的写了（空 id ⇒ false；写失败也 false，但一定上报过）
 */
export function persistToolCallStart(messageId: string, toolCall: PersistableToolCall | null | undefined): boolean {
  const id = typeof toolCall?.id === "string" ? toolCall.id : "";
  if (!id || !messageId) return false;
  try {
    MessageStorage.addToolCall(messageId, {
      id,
      tool: String(toolCall?.name ?? ""),
      args: { ...(toolCall?.input ?? {}), name: toolCall?.input?.name || toolCall?.metadata?.name },
      status: "running",
    });
    return true;
  } catch (e) {
    reportPersistFailure(
      "toolCall.persistStart",
      e,
      `工具 ${toolCall?.name || id}（${id}）的开始状态没写进消息 ${messageId}` +
        `（下一轮模型可能看不到这次调用）`,
    );
    return false;
  }
}

/**
 * `tool_complete`：把结果写回工具调用（`status: "done"`）。
 *
 * 包含两道**必须共用**的语义：
 * 1. 结果正文规范化（`normalizeToolResult`）+ 剥 `system-reminder`；
 * 2. 超大结果溢出到会话私有文件（`retainToolResult`，失败退回原文 —— 宁可库大一点，
 *    也不能把工具结果变成一句「保存失败」）。
 *
 * @returns 是否真的写了（空 id / 无消息 id ⇒ false；写失败也 false，但一定上报过）
 */
export async function persistToolCallSuccess(params: {
  sessionId: string;
  messageId: string;
  toolCall: PersistableToolCall | null | undefined;
  result: unknown;
}): Promise<boolean> {
  const { sessionId, messageId, toolCall, result } = params;
  const id = typeof toolCall?.id === "string" ? toolCall.id : "";
  if (!id || !messageId) return false;
  try {
    const normalized = normalizeToolResult(result);
    let resultStr = stripSystemReminders(normalized.text);
    try {
      const retained = await retainToolResult(resultStr, {
        sessionId,
        toolName: toolCall?.name,
        callId: id,
      });
      if (retained.spilled) {
        console.log(
          `[Spill] 工具结果 ${retained.totalBytes} 字节超过上限，已省略 ${retained.omittedBytes} 字节；全文：${retained.locator}`,
        );
      }
      resultStr = retained.text;
    } catch (e) {
      /* 溢出只是"省空间"，失败必须退回原文（与改前的处置一致） */
      console.warn("[Spill] 溢出保存失败，保留完整结果:", e);
    }
    MessageStorage.updateToolCall(messageId, id, {
      status: "done",
      result: resultStr,
      ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
    });
    return true;
  } catch (e) {
    reportPersistFailure(
      "toolCall.persistSuccess",
      e,
      `工具 ${toolCall?.name || id}（${id}）的结果没写进消息 ${messageId}` +
        `（下一轮模型会看不到它 ⇒ 可能重发同一调用）`,
    );
    return false;
  }
}

/**
 * `tool_error`：把失败写回工具调用（`status: "error"` + 错误正文）。
 *
 * 错误正文同样进模型上下文（`messagesToLLMMessages` 只认 done/error 为已完成），
 * 模型据此知道「这次调用失败了、别再原样重发」。
 *
 * @returns 是否真的写了（空 id / 无消息 id ⇒ false；写失败也 false，但一定上报过）
 */
export function persistToolCallError(
  messageId: string,
  toolCall: PersistableToolCall | null | undefined,
  error: unknown,
): boolean {
  const id = typeof toolCall?.id === "string" ? toolCall.id : "";
  if (!id || !messageId) return false;
  try {
    MessageStorage.updateToolCall(messageId, id, {
      status: "error",
      result: typeof error === "string" ? error : error === undefined || error === null ? "Unknown error" : String(error),
    });
    return true;
  } catch (e) {
    reportPersistFailure(
      "toolCall.persistError",
      e,
      `工具 ${toolCall?.name || id}（${id}）的失败结果没写进消息 ${messageId}` +
        `（下一轮模型会看不到它 ⇒ 可能重发同一调用）`,
    );
    return false;
  }
}
