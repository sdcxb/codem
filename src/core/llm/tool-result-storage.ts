/**
 * Tool Result Disk Persistence
 *
 * When a tool result exceeds the threshold (default 50KB), it is saved to a
 * temporary file on disk. The LLM receives a preview + file path instead of
 * the full content. This prevents large outputs (e.g. cargo build logs,
 * find_references results) from consuming context window tokens.
 *
 * Design decisions (from CLAUDE-CODE-IMPACT-ANALYSIS.md):
 * 1. 'read' tool is EXEMPT (maxResultSizeChars = Infinity) — prevents infinite
 *    loops where LLM reads a persisted file, result is large again, gets
 *    persisted again, etc.
 * 2. Tools returning task IDs (subagent, delegate_to_session,
 *    send_message, wait_for_delegation) are EXEMPT — task IDs must
 *    remain visible to the LLM.
 * 3. Results are stored in `.codem-tool-results/<sessionId>/` under the
 *    workspace directory.
 * 4. Preview includes the first 500 chars + file path so the LLM can decide
 *    whether to read the full output.
 */

import { writeFile } from "../file-api";

// ========== Constants ==========

/** Default threshold for persisting tool results to disk (50KB) */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Number of characters to include in the preview */
const PREVIEW_CHARS = 500;

/** Subdirectory name for tool results */
const TOOL_RESULTS_SUBDIR = ".codem-tool-results";

// ========== Types ==========

export interface PersistResult {
  /** Whether the result was persisted to disk */
  persisted: boolean;
  /** The output to send to the LLM (either original or preview+path) */
  output: string;
  /** The file path where the full result was saved (if persisted) */
  filePath?: string;
}

// ========== Core Logic ==========

/**
 * Check if a tool result should be persisted to disk.
 * Returns a PersistResult with the output to send to the LLM.
 *
 * @param toolName - The name of the tool that produced the result
 * @param output - The tool's output string
 * @param sessionId - The current session ID (for organizing output files)
 * @param cwd - The current working directory (for storing output files)
 * @param maxResultSizeChars - The threshold for persistence. Infinity = never persist.
 *                             If not provided, uses the default threshold.
 */
export async function maybePersistToolResult(
  toolName: string,
  output: string,
  sessionId: string,
  cwd: string,
  maxResultSizeChars?: number,
): Promise<PersistResult> {
  // Determine the effective threshold
  const threshold = maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;

  // If threshold is Infinity, never persist
  if (threshold === Infinity) {
    return { persisted: false, output };
  }

  // If output is small enough, no need to persist
  if (output.length <= threshold) {
    return { persisted: false, output };
  }

  // Persist to disk
  try {
    const fileName = `${toolName}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.txt`;
    const dirPath = `${cwd}/${TOOL_RESULTS_SUBDIR}/${sessionId}`;
    const filePath = `${dirPath}/${fileName}`;

    // Ensure directory exists (writeFile creates parent dirs via Tauri)
    await writeFile(filePath, output, { workspace: cwd });

    // Build preview: first N chars + truncated marker + file path
    const preview = output.substring(0, PREVIEW_CHARS);
    const truncated = output.length > PREVIEW_CHARS;
    const persistedOutput = [
      `<persisted-output>`,
      `Output too large (${output.length.toLocaleString()} chars), saved to disk.`,
      ``,
      `Preview (${preview.length} of ${output.length} chars):`,
      truncated ? `${preview}...` : preview,
      ``,
      `Full output file: ${filePath}`,
      `Use the 'read' tool with this path to view the complete output.`,
      `</persisted-output>`,
    ].join("\n");

    console.log(
      `[tool-result-storage] Persisted ${toolName} result: ${output.length} chars → ${filePath}`,
    );

    return {
      persisted: true,
      output: persistedOutput,
      filePath,
    };
  } catch (error: any) {
    // If persistence fails (e.g. disk full, permission denied),
    // fall back to truncation (same as before, but with a larger limit)
    console.warn(
      `[tool-result-storage] Failed to persist ${toolName} result: ${error.message}. Falling back to truncation.`,
    );
    const truncated = output.substring(0, threshold) + "\n... (truncated, output too large, disk persistence failed)";
    return { persisted: false, output: truncated };
  }
}

/**
 * 结果**永不落盘**的工具 —— 运行时注册工具的**兜底**表。
 *
 * ## 第 120 轮：主判据已改为工具契约的 `persistResult`
 *
 * 这些工具的结果是「短但关键」的：id、确认、清单。落盘会把模型要用的东西
 * 换成一个文件路径 —— 模型拿不到 id 就没法继续（例如子智能体 id）。
 *
 * 契约化之后，声明写在工具自己身上（`contract: { persistResult: false }`），
 * 由 `shouldPersistResult()` 统一判定。这张表**只**在拿不到契约时兜底，
 * 服务两类工具：
 *
 * 1. **运行时注册的工具**（MCP 等）—— 不可能带声明；
 * 2. **本仓不再存在的名字**（`delegate_to_session` / `wait_for_delegation`）——
 *    它们由别的注册路径提供，这里保留以免那条路径上行为变化。
 *
 * ⚠️ 不要把新工具加到这里 —— 加在工具自己的 `contract` 上。
 * 那张表越长，就越接近我们要消灭的「多份真相」。
 */
export const NEVER_PERSIST_TOOLS = new Set([
  "delegate_to_session", // Returns delegation task ID
  "wait_for_delegation", // Returns delegation results
]);

/**
 * 该工具的结果是否可以落盘。**唯一判据入口** —— 所有消费者都走这里。
 *
 * 顺序（与 `streaming-executor` 的并发判定同形态）：
 * 1. 能拿到契约 ⇒ 用 `contract.persistResult`（缺省 `true`）；
 * 2. 拿不到契约（未注入查询器 / 运行时注册的工具）⇒ 查 `NEVER_PERSIST_TOOLS` 兜底。
 *
 * 为什么不能反过来：名字表优先会让一份手写名单继续覆盖工具自己的声明，
 * 就又回到「7 组名单」的老问题。
 */
export function shouldPersistResult(
  toolName: string,
  contractOf?: (name: string) => { persistResult: boolean },
): boolean {
  if (contractOf) {
    try {
      return contractOf(toolName).persistResult;
    } catch {
      // 查询器抛错 ⇒ 保守：不落盘（宁可把内容原样给模型，也不要凭空少掉 id）
      return false;
    }
  }
  return !NEVER_PERSIST_TOOLS.has(toolName);
}
