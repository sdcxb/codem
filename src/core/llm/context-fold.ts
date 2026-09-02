/**
 * 上下文折叠（无 LLM 的紧凑摘要）— 修复 token 浪费根因之一。
 *
 * Codem 的 selectMessagesByPriority 在上下文超预算时**直接丢弃**最早消息
 * （无摘要替换）。长"修 bug"任务中，被丢的是早期 read/glob/grep 结果与
 * 旧轮次 —— 模型下一轮就"失忆"，倾向于重新读取/重新执行，每轮请求的
 * token 反而随轮次增长（重复劳动的恶性循环），是"同样任务比 dsh 消耗大
 * 数倍"的主因。
 *
 * dsh 的做法是 compaction（LLM 总结后 surface 替换）；这里先给截断路径补
 * 一个零成本的规则摘要：把被丢弃的中间操作折叠成一行提示，保留下文可读，
 * 不额外调用 LLM。
 */

export interface FoldStats {
  /** 被折叠的轮次/消息数（不含注入的上下文消息）。 */
  droppedMessages: number;
  /** 按工具名计数的操作次数，如 { read: 3, bash: 2 }。 */
  toolCounts: Record<string, number>;
  /** 被折叠的纯文本 assistant 回复条数。 */
  droppedTextReplies: number;
}

export const FOLD_PREFIX = "[上下文精简]";

/**
 * 统计一批被丢弃的 LLM 消息的操作构成。
 * @param dropped - 被 selectMessagesByPriority 丢弃的消息（有序子集）。
 */
export function foldStats(dropped: any[]): FoldStats {
  const toolCounts: Record<string, number> = {};
  let droppedTextReplies = 0;
  for (const msg of dropped) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc?.function?.name || tc?.name || "tool";
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      }
    } else if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 0) {
      droppedTextReplies++;
    }
  }
  return { droppedMessages: dropped.length, toolCounts, droppedTextReplies };
}

/** 把统计结果渲染为一行的折叠提示（中文，模型可见）。 */
export function renderFoldSummary(stats: FoldStats, lang: "zh" | "en" = "zh"): string {
  if (lang === "zh") {
    const toolPart = Object.entries(stats.toolCounts)
      .map(([name, count]) => `${name}×${count}`)
      .join("、");
    const parts: string[] = [];
    if (toolPart) parts.push(`较早的 ${stats.droppedMessages} 条消息（${toolPart}）因上下文长度被精简`);
    else if (stats.droppedTextReplies > 0) parts.push(`较早的 ${stats.droppedTextReplies} 轮回复因上下文长度被精简`);
    else parts.push(`较早的 ${stats.droppedMessages} 条消息因上下文长度被精简`);
    parts.push("如需这些细节，请重新调用相应工具读取或执行，不要凭记忆猜测文件内容。");
    return `${FOLD_PREFIX} ${parts.join("；")}`;
  }
  const toolPart = Object.entries(stats.toolCounts)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  const detail = toolPart
    ? `earlier ${stats.droppedMessages} messages (${toolPart}) were folded to fit the context`
    : `earlier ${stats.droppedMessages} messages were folded to fit the context`;
  return `${FOLD_PREFIX} ${detail}. Re-run the relevant tools if you need those details; never guess file contents from memory.`;
}

/**
 * 判断某条消息是否已是折叠提示（避免每轮重复插入累积）。
 */
export function isFoldMessage(msg: any): boolean {
  return !!msg && typeof msg.content === "string" && msg.content.startsWith(FOLD_PREFIX);
}

// ===== 陈旧大工具结果 head+tail 裁剪（对标 dsh tool-result-pruner）=====
// dsh 把每个超过 ~8KB 的工具结果裁为 head(4096)+marker+tail(1024)（约 1.3k
// token/条），Codem 此前把 ≤50k 字符的工具结果全量保留数轮（read 结果
// ≈12-25k token/条 × 多轮 = 上下文大头）。裁剪保留 head+tail（含错误尾部），
// marker 引导模型按需重读/续读 —— 对标 dsh read_at 的语义。

export const TOOL_RESULT_PRUNE_THRESHOLD = 8192;
export const TOOL_RESULT_HEAD_CHARS = 4096;
export const TOOL_RESULT_TAIL_CHARS = 1024;
export const TOOL_RESULT_PRUNE_MARKER =
  "\n\n[... 工具结果中段已裁剪；如需完整内容请重新执行该工具或用 offset/分页读取 ...]\n\n";

/** 单条超长工具结果 → head + marker + tail。未超阈值原样返回。 */
export function pruneLargeToolResult(content: string): string {
  if (!content || content.length <= TOOL_RESULT_PRUNE_THRESHOLD) return content;
  const head = content.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = content.slice(content.length - TOOL_RESULT_TAIL_CHARS);
  return `${head}${TOOL_RESULT_PRUNE_MARKER}${tail}`;
}

/**
 * 在 LLM 消息列表上执行陈旧大结果裁剪：保留最近 keepRecent 条 tool 结果
 * 完整（模型当前正依赖它们），更早的超大结果裁剪为 head+tail。
 * @param messages LLM 消息（role: user/assistant/tool…）
 * @param keepRecent 保留完整的最新 N 条 tool 结果
 * @returns 新消息数组（不修改入参）
 */
export function pruneStaleToolResults(messages: any[], keepRecent = 2): any[] {
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") toolIdx.push(i);
  }
  const keepFrom = Math.max(0, toolIdx.length - keepRecent);
  const keepSet = new Set(toolIdx.slice(keepFrom));
  let changed = false;
  const out = messages.map((msg, i) => {
    if (msg?.role !== "tool" || keepSet.has(i)) return msg;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= TOOL_RESULT_PRUNE_THRESHOLD) return msg;
    changed = true;
    return { ...msg, content: pruneLargeToolResult(content) };
  });
  return changed ? out : messages;
}
