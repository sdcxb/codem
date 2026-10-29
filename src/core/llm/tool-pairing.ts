/**
 * 工具调用/结果配对 —— **请求侧最后一道结构保证**（P0：折叠是否保持成对）。
 *
 * ## 为什么必须存在
 *
 * OpenAI / DeepSeek 的严格配对要求：一条 `tool` 消息必须紧跟在**声明了它的那条**
 * assistant 消息之后；一条 assistant 声明了 N 个 `tool_calls`，就必须有 N 条对应的结果。
 * 少了任何一半，服务端直接 400（`insufficient tool messages following tool_calls message`），
 * 用户看到的是整轮失败。
 *
 * 上下文选择/折叠都只该改**文本**，不该拆散配对；但选择器按预算丢整条消息，
 * 于是真的可能出现「assistant 还在、它的结果被丢了」。所以这里在发送前统一清理，
 * 三种形态分别处理：
 *
 * 1. **孤儿 `tool` 结果**（选中窗口里没有任何 assistant 声明它）→ 丢掉；
 * 2. **assistant 的 `tool_calls` 一条结果都没有** → 整块剥掉，只留正文；
 * 3. **部分结果**（声明 N 个、只剩 M 个）→ 只保留有结果的 M 个调用。
 *
 * ## 与折叠的关系
 *
 * 折叠（`tool-output-fold.ts`）只改 `toolCalls[].result` 的**文本**，既不删消息也不删调用；
 * 这个函数是第二层保险：即使选择器丢了整条消息，也不会把非法形状发出去。
 *
 * ## 诚实边界
 *
 * - 剥掉的调用**不是没发生过**：调用数与消息数由调用方（`recordContextDrop`）投给界面，
 *   模型侧则通过 `[上下文精简]` 折叠行知道"早些的操作被精简了"；
 * - 这里只处理"已选中"的窗口；更上游的软删/隐藏如果造出孤儿，同样会被这一层清掉 ——
 *   但目前没有找到那样的生产路径（`restore`/`repair` 侧另有配对修复）。
 */

export interface ToolPairingResult {
  /** 清理后的消息（**同一批对象引用**，未改动的原样返回） */
  messages: any[];
  /** 被剥掉 `tool_calls`（整块或部分）的 assistant 消息数 */
  strippedToolCallMessages: number;
  /** 被剥掉的单个 tool_call 数 */
  strippedToolCalls: number;
  /** 被丢掉的孤儿 tool 结果数 */
  droppedOrphanToolResults: number;
}

/**
 * 清理工具调用/结果的配对。
 *
 * @param selected 已按预算选中的 LLM 消息（`role` = user/assistant/tool）
 */
export function enforceToolPairing(selected: any[]): ToolPairingResult {
  const declaredToolCallIds = new Set<string>();
  for (const msg of selected) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id) declaredToolCallIds.add(tc.id);
      }
    }
  }
  const presentToolResultIds = new Set<string>();
  for (const msg of selected) {
    if (msg?.role === "tool" && msg.toolCallId) presentToolResultIds.add(msg.toolCallId);
  }

  const messages: any[] = [];
  let strippedToolCallMessages = 0;
  let strippedToolCalls = 0;
  let droppedOrphanToolResults = 0;

  for (const msg of selected) {
    if (msg?.role === "tool") {
      // 1. 孤儿结果：选中窗口里没有 assistant 声明这个 id
      if (msg.toolCallId && declaredToolCallIds.has(msg.toolCallId)) {
        messages.push(msg);
      } else {
        droppedOrphanToolResults += 1;
      }
      continue;
    }

    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const matched = msg.tool_calls.filter((tc: any) => tc?.id && presentToolResultIds.has(tc.id));
      if (matched.length === 0) {
        // 2. 一条结果都没有 → 整块剥掉，模型只看到正文
        const { tool_calls, ...rest } = msg;
        messages.push(rest);
        strippedToolCallMessages += 1;
        strippedToolCalls += msg.tool_calls.length;
        console.warn(
          `[buildMessages] Stripped dangling tool_calls from assistant ${msg.id} (tool results were dropped by context selection)`,
        );
      } else if (matched.length !== msg.tool_calls.length) {
        // 3. 部分结果 → 只保留有结果的那些，让 API 的配对是精确的
        messages.push({ ...msg, tool_calls: matched });
        strippedToolCallMessages += 1;
        strippedToolCalls += msg.tool_calls.length - matched.length;
        console.warn(
          `[buildMessages] Stripped ${msg.tool_calls.length - matched.length} unfulfilled tool_calls from assistant ${msg.id} (results dropped by context selection)`,
        );
      } else {
        messages.push(msg);
      }
      continue;
    }

    messages.push(msg);
  }

  return { messages, strippedToolCallMessages, strippedToolCalls, droppedOrphanToolResults };
}
