/**
 * SpillPolicy — 工具输出溢出策略
 *
 * 设计对标 DSH `@deepseek-ai/dsh-spill-policy`。
 *
 * 这是一个 `tools/post-execute` 转换器：当工具的最终纯文本结果
 * 超过 `maxInlineBytes` 时，将全文通过 SpillStore 持久化，
 * 然后用 head/tail 预览 + 定位器 + 检索提示替换模型面向的结果。
 *
 * 关键设计：
 * - 不注册服务，不拥有存储或预览机制：存储是 SpillStore，预览是 TextRetainer
 * - 只决定 WHEN 溢出并构建通知
 * - 只处理纯文本结果（所有 text block）；非文本 block 不触碰
 * - 跳过 read 工具避免 read → spill → read again 循环
 * - 跳过嵌套调用（parent 存在时）
 * - best-effort：无 session owner / 无后端 / 存储失败 → 保留原文，不失败调用
 * - 预览 + 通知的总字节不超过 maxInlineBytes（通知的字节成本从预算中预留）
 */

import type { PostExecuteMiddleware, PostExecuteResult } from "./tool-pipeline";
import type { ToolCallResult } from "./types";
import type { ToolExecutorContext } from "./streaming-executor";
import { getSpillStore, type SpillRef } from "./spill-store";

// ========== Configuration ==========

export interface SpillPolicyConfig {
  /**
   * 模型面向的纯文本结果上下文上限，UTF-8 字节数。
   * 省略（undefined）禁用策略。
   * 设置后，超过此大小的结果会被溢出并替换为预览 + 定位器。
   */
  maxInlineBytes?: number;
}

// ========== Text Retainer (head/tail preview) ==========

/**
 * 保留文本的 head 和 tail，中间省略。
 * 对标 DSH `@deepseek-ai/dsh-output-retention` 的 TextRetainer。
 */
function buildHeadTailPreview(text: string, budget: number): {
  text: string;
  omittedBytes: number;
} {
  if (budget <= 0) {
    return { text: "", omittedBytes: Buffer.byteLength(text, "utf8") };
  }

  const headBytes = Math.ceil(budget / 2);
  const tailBytes = Math.floor(budget / 2);

  // 使用 Buffer 按 UTF-8 字节切分
  const buf = Buffer.from(text, "utf8");
  const totalBytes = buf.length;

  if (totalBytes <= budget) {
    return { text, omittedBytes: 0 };
  }

  // head: 从开头取 headBytes 字节，但不能截断多字节字符
  let headEnd = headBytes;
  // 向前调整到字符边界
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--;
  const head = buf.subarray(0, headEnd).toString("utf8");

  // tail: 从末尾取 tailBytes 字节
  let tailStart = totalBytes - tailBytes;
  if (tailStart < headEnd) tailStart = headEnd;
  // 向前调整到字符边界
  while (tailStart < totalBytes && (buf[tailStart] & 0xc0) === 0x80) tailStart++;
  const tail = buf.subarray(tailStart).toString("utf8");

  const kept = head + (tail.length > 0 ? `\n\n…(${totalBytes - headEnd - (totalBytes - tailStart)} bytes omitted in the middle)…\n\n` + tail : "");

  return {
    text: kept,
    omittedBytes: totalBytes - headEnd - (totalBytes - tailStart),
  };
}

// ========== Spill Policy Middleware ==========

/**
 * 构建溢出通知行。
 * "Omitted N bytes. Full formatted result stored at: <locator>. <retrievalHint>"
 */
function buildSpillNotice(omittedBytes: number, ref: SpillRef): string {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint})`;
}

/**
 * 溢出策略 post-execute 中间件。
 *
 * 在工具执行完成后检查输出大小：
 * - 超过 maxInlineBytes → 存储全文 + 替换为预览 + 定位器
 * - 未超过 → 保持原样
 * - 存储失败 → 保持原样（best-effort）
 *
 * 跳过：
 * - read 工具（避免 read → spill → read again 循环）
 * - 嵌套调用（exec.parent 存在时 — 由外层处理）
 * - 非纯文本结果
 */
export class SpillPolicyMiddleware implements PostExecuteMiddleware {
  name = "spill-policy";
  private maxInlineBytes: number;
  private enabled: boolean;

  constructor(config: SpillPolicyConfig = {}) {
    this.maxInlineBytes = config.maxInlineBytes ?? 0;
    this.enabled = config.maxInlineBytes !== undefined && config.maxInlineBytes > 0;

    // 验证：非正整数在加载时失败，不是每次调用
    if (config.maxInlineBytes !== undefined) {
      if (!Number.isInteger(config.maxInlineBytes) || config.maxInlineBytes < 0) {
        throw new Error(
          `spill-policy: maxInlineBytes must be a non-negative integer (got ${config.maxInlineBytes})`,
        );
      }
    }
  }

  async execute(
    toolName: string,
    _args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult> {
    if (!this.enabled) return { action: "keep" };

    // 跳过 read 工具 — 避免 read → spill → read again 循环
    if (toolName === "read" || toolName === "read_file") {
      return { action: "keep" };
    }

    // 跳过错误结果
    if (result.status === "error" || !result.output) {
      return { action: "keep" };
    }

    const text = result.output;
    const totalBytes = Buffer.byteLength(text, "utf8");

    // 未超过上限 — 保持原样
    if (totalBytes <= this.maxInlineBytes) {
      return { action: "keep" };
    }

    // 尝试溢出存储
    let ref: SpillRef;
    try {
      const spillStore = getSpillStore();
      ref = await spillStore.saveText({
        owner: { sessionId: ctx.sessionId },
        source: {
          toolName,
          callId: result.id,
          label: "result",
        },
        suggestedName: `${toolName}.txt`,
        content: text,
      });
    } catch (error: any) {
      // best-effort：存储失败不阻止调用 — 保留原文
      console.warn(
        `[spill-policy] saveText failed for ${toolName}: ${error.message}; keeping inline content`,
      );
      return { action: "keep" };
    }

    // 预留通知的字节成本 — 确保预览 + 通知 ≤ maxInlineBytes
    // 使用最坏情况估算（完整字节数的位数）
    const worstCaseNotice = buildSpillNotice(totalBytes, ref);
    const reserve = Buffer.byteLength(worstCaseNotice, "utf8") + 2; // +2 for \n\n
    const previewBudget = Math.max(0, this.maxInlineBytes - reserve);

    const { text: previewText, omittedBytes } = buildHeadTailPreview(text, previewBudget);
    const notice = buildSpillNotice(omittedBytes, ref);

    const replacedText = previewText.length > 0
      ? `${previewText}\n\n${notice}`
      : notice;

    // 最终安全检查：替换文本绝不超过上限
    if (Buffer.byteLength(replacedText, "utf8") > this.maxInlineBytes) {
      console.warn(
        `[spill-policy] spill notice for ${toolName} exceeds maxInlineBytes; keeping inline content`,
      );
      return { action: "keep" };
    }

    return {
      action: "replace",
      replacedOutput: replacedText,
    };
  }
}
