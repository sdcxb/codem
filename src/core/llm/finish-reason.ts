/**
 * ★ 第 184 波（审计修复）：**供应商的 `finish_reason` 必须原样传下去**（只做必要的归一）。
 *
 * ## 缺陷形态
 *
 * 非流式 `complete()` 原来写死 `choice?.finish_reason === "tool_calls" ? "tool_use" : "stop"`
 * —— 把其余取值（尤其 **`length`**）**全部吞成"正常结束"**。而：
 * · `types.ts` 的 `finishReason` 取值域本来就含 `length`；
 * · 主循环**专门**据它判截断（`finishReason === "length"` 的那条续写分支）；
 * · 走 `complete()` 的**压缩摘要**与**计划生成**直接 `return response.content`
 *   ⇒ 被截断的**半截摘要**会被当成完整摘要写回，谁都不知道。
 *
 * 这是"假成功"类：失败（输出被截断）被呈现为成功（正常结束）。
 *
 * ## 归一只做必要的几处，**陌生取值一律归 `error`**
 *
 * · `tool_calls` → `tool_use`（OpenAI 的叫法 → 我们内部的叫法，UI 与循环都按后者判）；
 * · `length` / `stop` / `error` / `content_filter` 原样；
 * · **别的任何词 → `error`**：那是"我们不知道它为什么结束"，按"非正常结束"如实上抛，
 *   **绝不**再说成 `stop`（那正是本条要修的错）。
 */
export type FinishReason = "stop" | "tool_use" | "length" | "error" | "content_filter";

export function mapFinishReason(raw: unknown): FinishReason {
  if (typeof raw !== "string" || raw.length === 0) return "stop";
  if (raw === "tool_calls") return "tool_use";
  if (raw === "length" || raw === "stop" || raw === "error" || raw === "content_filter") return raw;
  // 陌生取值：不认识的结束原因**不是**"正常结束"
  return "error";
}
