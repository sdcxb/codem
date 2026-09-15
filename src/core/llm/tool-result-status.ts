/**
 * 工具结果状态判定 —— 「把失败写在 output 里」不等于成功。
 *
 * 背景（第 84 波审计，B 类缺陷：假成功）：
 * 本仓库 100+ 处工具失败路径写成 `output: "Error: ..."`，但两条执行链
 * （`ToolRegistry.execute` 与 `AgenticLoop` 的内联 handler）都**无条件**把结果标成
 * `status: "completed"`。后果：
 *   · 界面把失败显示成成功（tool part 绿色、`tool_end.status=completed`）；
 *   · 交付物/推进判定把"报错的写操作"当成"写下去了"；
 *   · 上层（子智能体、workflow、委派）拿不到失败信号，只能靠猜。
 *
 * 判定规则（保守、可解释）：
 *   1. 工具显式声明 `isError: true/false` → 以声明为准；
 *   2. **内容型工具**（read/grep/web_fetch…）的输出是"数据"，首行恰好以
 *      `Error:` 开头也可能是文件内容，**不做推断**；
 *   3. 其余工具：输出首行匹配 `Error:` / `错误：` / `失败：` → 判为 error。
 */
import type { ToolCallResult } from "./types";

/** 输出即"数据"的工具 —— 不对它们的输出做语义推断 */
const CONTENT_TOOLS = new Set([
  "read",
  "read_file",
  "read_attachment",
  "glob",
  "grep",
  "list_dir",
  "web_fetch",
  "session_search",
  "session_event_read",
  "session_event_search",
  "session_trace",
  "tool_search",
  "load_skill",
  "search_notebook",
  "terminal_read",
]);

/** 失败前缀：`Error:` / `ERROR -` / `错误：` / `失败：` */
const ERROR_PREFIX_RE = /^(?:error|错误|失败)\s*[:：-]/i;

export interface ToolStatusVerdict {
  status: "completed" | "error";
  /** 首行失败原因（status=error 时给出，供 UI/上层展示与判重） */
  error?: string;
}

function firstLine(output: unknown): string {
  if (typeof output !== "string") return "";
  const trimmed = output.replace(/^\s+/, "");
  const line = trimmed.split("\n", 1)[0] ?? "";
  return line.trim().slice(0, 300);
}

/**
 * 判定一次工具调用的最终状态。
 *
 * @param toolName 工具名
 * @param output   工具返回的输出文本
 * @param explicit 工具自己声明的失败标记（ToolExecuteResult.isError）
 */
export function classifyToolResult(
  toolName: string,
  output: unknown,
  explicit?: boolean,
): ToolStatusVerdict {
  if (explicit === true) {
    const line = firstLine(output);
    return { status: "error", error: line || `Tool "${toolName}" reported failure` };
  }
  if (explicit === false) return { status: "completed" };
  if (CONTENT_TOOLS.has(toolName)) return { status: "completed" };
  if (typeof output !== "string") return { status: "completed" };
  const line = firstLine(output);
  if (!ERROR_PREFIX_RE.test(line)) return { status: "completed" };
  return { status: "error", error: line };
}

/** 便捷函数：把判定结果套用到（可变的）ToolCallResult 上 */
export function applyToolResultStatus(
  result: ToolCallResult,
  output: unknown,
  explicit?: boolean,
): ToolCallResult {
  const verdict = classifyToolResult(result.name, output, explicit);
  result.status = verdict.status;
  if (verdict.error) result.error = verdict.error;
  return result;
}
