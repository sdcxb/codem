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
 * Get the list of tool names that should NEVER have their results persisted.
 * These tools return critical information (task IDs, short confirmations)
 * that the LLM must always see in full.
 */
export const NEVER_PERSIST_TOOLS = new Set([
  "read",               // Prevents infinite persist→read→persist loops
  "subagent",           // Returns subagent ID for background tracking
  "send_message",       // Returns message delivery confirmation
  "interrupt_agent",    // Returns interrupt confirmation
  "list_agents",        // Returns agent list (short)
  "report",             // Returns report acceptance
  "delegate_to_session", // Returns delegation task ID
  "wait_for_delegation", // Returns delegation results
  "list_sessions",      // Returns session list (usually small)
  "show_todo",          // Returns todo list (usually small)
  "ask_clarification",  // Returns user answer
  "fact_check",         // Returns fact check result
  "tts",                // Returns short confirmation
  "image_gen",          // Returns markdown image (not text)
]);
