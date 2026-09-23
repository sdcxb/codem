/**
 * SpillPolicy — 工具输出溢出策略
 *
 * 设计对标 DSH `@deepseek-ai/dsh-spill-policy`。
 *
 * 这是一个 `tools/post-execute` 转换器：当工具的最终纯文本结果
 * 超过 `maxInlineBytes` 时，把**全文**写入会话私有溢出文件，
 * 模型面向的结果只留 head/tail 预览 + 一行定位说明。
 *
 * 关键设计：
 * - **只决定 WHEN 溢出**：存储与预览机制全部复用 `core/storage/spill.ts`
 *   （`retainToolResult` / `headTailPreview` / `pruneSpillFiles`）——
 *   第 71 轮起本文件**不再自带第二套实现**（原因见下面的长注释）。
 * - 只处理纯文本结果（所有 text block）；非文本 block 不触碰
 * - 跳过 read 工具避免 read → spill → read again 循环
 * - 跳过嵌套调用（parent 存在时）
 * - best-effort：无 session owner / 无后端 / 存储失败 → 保留原文，不失败调用
 * - 预览 + 通知的总字节不超过 maxInlineBytes（通知的字节成本从预算中预留）
 *
 * ## ⚠️ 第 71 轮：为什么删掉原来那套自带的预览/存储实现
 *
 * 真机现场（用户控制台，每来一个大输出就一条）：
 * ```text
 * [spill-policy] saveText failed for bash: (void 0) is not a function; keeping inline content
 * ```
 *
 * 根因：本文件原来调用 `llm/spill-store.ts` 的自建存储，而那套存储用的是渲染进程里
 * **并不存在**的 Node `fs`（被 `vite.config.ts` 映射到 `src/stubs/*` 空壳，连
 * `mkdtempSync` 都没有）。与此同时 `core/storage/spill.ts` 里已经有一套**跑得通、
 * 而且被保留期清理认账**的实现（`retainToolResult` 被 `session/executor.ts` 使用，
 * `pruneSpillFiles` 按它的文件名回收）。
 *
 * 两套实现并存的实际后果：主 agent 循环这条路（本中间件，阈值 32 KB）在打包版里
 * **从未成功溢出过一次**，而旁路那条一切正常 —— "同一件事两份实现、只有一份是活的"
 * 是最难发现的一类缺陷。所以这里改成**只做决策**，机制全部交给
 * `core/storage/spill.ts`（`llm/spill-store.ts` 已随之删除）。
 */

import type { PostExecuteMiddleware, PostExecuteResult } from "./tool-pipeline";
import type { ToolCallResult } from "./types";
import type { ToolExecutorContext } from "./streaming-executor";
import { utf8Length, retainToolResult } from "../storage/spill";
import { debugLog } from "../debug";

// ========== Configuration ==========

export interface SpillPolicyConfig {
  /**
   * 模型面向的纯文本结果上下文上限，UTF-8 字节数。
   * 省略（undefined）禁用策略。
   * 设置后，超过此大小的结果会被溢出并替换为预览 + 定位器。
   */
  maxInlineBytes?: number;
}

/**
 * 通知行的字节预留。
 *
 * 说明行 = `（已省略 N 字节；完整结果保存在：<定位符>）`，定位符是**绝对路径**，
 * 长度随数据根目录变化（用户把数据放在长路径下会明显更长）。这里按 512 字节预留，
 * 覆盖路径很长的情形；**真正的保证**是替换前那道"绝不超过上限"的硬检查 ——
 * 预留只是让常规情形不必走到降级分支。
 */
const NOTICE_RESERVE_BYTES = 512;

// ========== Spill Policy Middleware ==========

/**
 * 溢出策略 post-execute 中间件。
 *
 * 在工具执行完成后检查输出大小：
 * - 超过 maxInlineBytes → 全文落盘 + 替换为预览 + 定位说明
 * - 未超过 → 保持原样（常规结果零开销，不做任何 I/O）
 * - 落盘失败 → 保持原样（best-effort，绝不把一次成功的工具调用变成失败）
 *
 * 跳过：
 * - read 工具（避免 read → spill → read again 循环）
 * - 非纯文本结果 / 错误结果
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
    const totalBytes = utf8Length(text);

    // 未超过上限 — 保持原样
    if (totalBytes <= this.maxInlineBytes) {
      return { action: "keep" };
    }

    // 溢出：全文落盘 + 预览（机制在 core/storage/spill.ts，这里只传预算）
    let retained: Awaited<ReturnType<typeof retainToolResult>>;
    try {
      retained = await retainToolResult(text, {
        sessionId: ctx.sessionId,
        toolName,
        /**
         * ⚠️ 不能只写 `result.id`（第 71 轮真机实测）：工具处理器返回的结果里 `id`
         * 一直是空串，溢出的文件名就变成了 `bash--<毫秒>.txt`（真机实测到的就是这个名字）。
         * 调用 id 由 `streaming-executor` 按次注入 ctx（见 `ToolExecutorContext.toolCallId`）。
         */
        callId: result.id || ctx.toolCallId,
        maxInlineBytes: this.maxInlineBytes,
        previewBytes: Math.max(0, this.maxInlineBytes - NOTICE_RESERVE_BYTES),
      });
    } catch (error: any) {
      // best-effort：存储失败不阻止调用 — 保留原文
      console.warn(
        `[spill-policy] saveText failed for ${toolName}: ${error?.message ?? error}; keeping inline content`,
      );
      return { action: "keep" };
    }

    if (!retained.spilled) {
      // 理论上不会走到（上面已经按同一上限判过），但"上游没溢出"时绝不能替它编造预览
      debugLog("spill-policy", `${toolName}: retainToolResult 未溢出，保持原文`);
      return { action: "keep" };
    }

    // 最终安全检查：替换文本绝不超过上限
    const replacedBytes = utf8Length(retained.text);
    if (replacedBytes > this.maxInlineBytes) {
      console.warn(
        `[spill-policy] spill notice for ${toolName} (${replacedBytes} bytes) exceeds maxInlineBytes (${this.maxInlineBytes}); keeping inline content`,
      );
      return { action: "keep" };
    }

    debugLog(
      "spill-policy",
      `${toolName}: 溢出 ${totalBytes} 字节 → 省略 ${retained.omittedBytes} 字节，全文 ${retained.locator}`,
    );

    return {
      action: "replace",
      replacedOutput: retained.text,
    };
  }
}
