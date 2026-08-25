/**
 * Micro-Compact — Selective tool result replacement
 *
 * Design (from CLAUDE-CODE-IMPACT-ANALYSIS.md):
 *
 * Does NOT modify the DB. Operates on the LLM-facing messages only,
 * replacing old tool_result content with a short placeholder. This
 * preserves the conversation structure (tool calls remain visible)
 * while drastically reducing token usage.
 *
 * When contextPressure > threshold, the agentic-loop calls microCompact()
 * BEFORE triggering full compaction. If micro-compact reduces pressure
 * enough, full compaction (expensive LLM summary) is avoided.
 *
 * Two-level compaction strategy:
 *   Level 1 (micro): Replace old tool results with placeholders (cheap, instant)
 *   Level 2 (full):  LLM-generated summary of old messages (expensive, lossy)
 */

// ========== Constants ==========

/**
 * Tool names whose results are safe to micro-compact.
 * These tools produce large read-only outputs that the LLM
 * typically doesn't need verbatim after a few turns.
 */
const COMPACTABLE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "bash",
  "web_fetch",
  "codebase_search",
  "lsp",
]);

/**
 * Tool names whose results must NEVER be compacted.
 * These contain critical information the LLM needs for continuation.
 */
const NEVER_COMPACT_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "spawn_subagent",
  "wait_for_subagent",
  "delegate_to_session",
  "wait_for_delegation",
  "query_session_result",
  "list_sessions",
  "show_todo",
  "ask_clarification",
  "fact_check",
  "tts",
  "image_gen",
]);

/**
 * Minimum number of recent messages to always keep intact (no micro-compact).
 * The LLM needs recent tool results for context.
 */
const KEEP_RECENT_MESSAGES = 10;

/**
 * Minimum result size (in chars) to be worth compacting.
 * Very short results are not worth replacing with a placeholder.
 */
const MIN_RESULT_SIZE_TO_COMPACT = 500;

/**
 * Head/tail retention sizes for the DSH-style prune strategy.
 * Instead of extracting a "summary" (which loses the actual content),
 * we retain the first HEAD_CHARS and last TAIL_CHARS of the tool result,
 * replacing the middle with a prune marker.
 *
 * This mirrors DSH's ToolResultPruner defaults (head=4096, tail=1024),
 * but scaled down slightly for our smaller context windows.
 */
const HEAD_CHARS = 3000;
const TAIL_CHARS = 800;

/** Marker substituted for the removed middle span (aligned with DSH's PRUNE_MARKER). */
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

/** Lines that belong to the anti-injection wrapper — skipped when extracting summaries. */
const WRAPPER_PATTERNS = [
  /^╔+/,
  /^║/,
  /^╚+/,
];

/**
 * Check if a line is part of the anti-injection data-marker wrapper.
 */
function isWrapperLine(line: string): boolean {
  return WRAPPER_PATTERNS.some(p => p.test(line.trim()));
}

/**
 * Skip leading wrapper/prefix lines and return the index of the first real content line.
 * Handles multiple layers of prefix:
 *   1. [CACHE HIT] / [ALREADY COLLECTED] prefix from AgenticLoop dedup
 *   2. [Tool result pruned ...] prefix from prior micro-compact pass
 *   3. Anti-injection wrapper (╔══, ║ ..., ╚══, empty lines, "文件: xxx")
 */
function skipWrapper(lines: string[]): number {
  let i = 0;
  // Skip [CACHE HIT] / [ALREADY COLLECTED] prefix block
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { i++; continue; }
    if (trimmed.startsWith('[CACHE HIT]') || trimmed.startsWith('[ALREADY COLLECTED]')) { i++; continue; }
    if (trimmed.startsWith('File:') || trimmed.startsWith('文件:')) { i++; continue; }
    // Skip "Use the content below" guidance text
    if (trimmed.startsWith('Use the content') || trimmed.startsWith('Do NOT call')) { i++; continue; }
    if (trimmed.startsWith('You already called') || trimmed.startsWith('If you have collected')) { i++; continue; }
    if (trimmed.startsWith('Here is the cached') || trimmed.startsWith('The sub-agent')) { i++; continue; }
    if (trimmed.startsWith('If you have collected') || trimmed.startsWith('proceed to the next')) { i++; continue; }
    // Skip [Tool result pruned ...] prefix from prior micro-compact
    if (trimmed.startsWith('[Tool result pruned')) { i++; continue; }
    // Skip anti-injection wrapper (╔══, ║ ..., ╚══)
    if (isWrapperLine(lines[i])) { i++; continue; }
    break;
  }
  return i;
}

// ========== Types ==========

export interface MicroCompactResult {
  /** Number of tool results that were compacted */
  compactedCount: number;
  /** Estimated chars saved */
  charsSaved: number;
  /** The modified messages (new array, original untouched) */
  messages: any[];
}

// ========== Structured Tool Summary Generator ==========

/**
 * Generate a pruned version of a tool result using DSH's head/tail strategy.
 *
 * Instead of extracting a "summary" (which loses actual content and can be
 * fooled by anti-injection wrapper lines), we retain the first HEAD_CHARS
 * and last TAIL_CHARS of the actual content, replacing the middle with
 * a prune marker.
 *
 * For read results wrapped in anti-injection markers (╔══...╚══),
 * the wrapper is preserved and the head/tail are taken from the file content
 * inside the wrapper.
 */
function pruneToolResult(toolName: string, content: string): string {
  const originalLength = content.length;
  const lines = content.split("\n");
  const totalLines = lines.length;

  // For 'read' results, skip the anti-injection wrapper to find real content
  const contentStartIdx = toolName === "read" || toolName === "read_file"
    ? skipWrapper(lines)
    : 0;

  // Extract the real content (after wrapper header, before wrapper footer)
  let realContentStart = contentStartIdx;
  let realContentEnd = lines.length;
  if (contentStartIdx > 0) {
    // Find the closing wrapper (╔══ ... ╚══)
    for (let i = lines.length - 1; i >= contentStartIdx; i--) {
      if (isWrapperLine(lines[i])) {
        realContentEnd = i;
        break;
      }
    }
  }

  const realLines = lines.slice(realContentStart, realContentEnd);
  const realContent = realLines.join("\n");

  // If real content is short enough, keep it all (just the wrapper + content)
  if (realContent.length <= HEAD_CHARS + TAIL_CHARS + 200) {
    return content; // Don't prune — content is small enough
  }

  // Head/tail prune: keep first HEAD_CHARS and last TAIL_CHARS of real content
  const headText = realContent.substring(0, HEAD_CHARS);
  const tailText = realContent.substring(realContent.length - TAIL_CHARS);
  const prunedContent = headText + PRUNE_MARKER + tailText;

  // Reconstruct with wrapper if present
  if (contentStartIdx > 0) {
    const wrapperHeader = lines.slice(0, contentStartIdx).join("\n");
    const wrapperFooter = lines.slice(realContentEnd).join("\n");
    return `[Tool result pruned — ${toolName}: ${totalLines} lines, ${originalLength.toLocaleString()} chars → ${prunedContent.length.toLocaleString()} chars]\n` +
      wrapperHeader + "\n" +
      prunedContent + "\n" +
      wrapperFooter;
  }

  // Tool-specific prefix for non-read tools
  const toolLabel = getToolLabel(toolName, content, totalLines, originalLength);
  return `[Tool result pruned — ${toolLabel}]\n` +
    prunedContent;
}

/** Generate a short tool label for the prune prefix. */
function getToolLabel(toolName: string, content: string, totalLines: number, originalLength: number): string {
  switch (toolName) {
    case "read":
    case "read_file": {
      const pathMatch = content.match(/(?:文件|File):\s*(.+)/i);
      const filePath = pathMatch ? pathMatch[1].trim() : "file";
      return `read ${filePath} (${totalLines} lines, ${originalLength.toLocaleString()} chars)`;
    }
    case "bash": {
      const exitMatch = content.match(/(?:exit code|exit_code|Exit code)\s*[:=]\s*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : "?";
      const cmdMatch = content.match(/^(?:Command|CMD|cmd|command)\s*[:=]\s*(.+)$/im);
      const cmd = cmdMatch ? cmdMatch[1].trim().substring(0, 80) : "command";
      return `bash: ${cmd} (exit ${exitCode}, ${originalLength.toLocaleString()} chars)`;
    }
    case "grep": {
      const matchCount = content.split("\n").filter(l => l.trim() && !l.startsWith("grep:")).length;
      return `grep: ${matchCount} matches (${originalLength.toLocaleString()} chars)`;
    }
    case "glob": {
      const fileCount = content.split("\n").filter(l => l.trim()).length;
      return `glob: ${fileCount} files (${originalLength.toLocaleString()} chars)`;
    }
    default:
      return `${toolName}: ${originalLength.toLocaleString()} chars, ${totalLines} lines`;
  }
}

// ========== Core Logic ==========

/**
 * Replace old tool result content with placeholders in LLM-facing messages.
 *
 * @param llmMessages - The messages array returned by convertMessagesToLLM()
 * @returns A new messages array with old tool results replaced by placeholders
 */
export function microCompact(llmMessages: any[]): MicroCompactResult {
  const totalMessages = llmMessages.length;

  // If the conversation is too short, don't bother
  if (totalMessages <= KEEP_RECENT_MESSAGES) {
    return { compactedCount: 0, charsSaved: 0, messages: llmMessages };
  }

  // Find the cutoff index: messages before this index are "old"
  const cutoffIndex = totalMessages - KEEP_RECENT_MESSAGES;

  // We need to find tool results that belong to old assistant messages.
  // In the LLM message format:
  //   - assistant message has tool_calls[]
  //   - following "tool" role messages contain the results
  //
  // Strategy: iterate through messages. Track the index of each tool result.
  // If the tool result's index < cutoffIndex AND the tool is compactable,
  // replace its content with a placeholder.

  const result = [...llmMessages]; // shallow copy — we'll replace elements
  let compactedCount = 0;
  let charsSaved = 0;

  // Build a map of toolCallId → tool name from assistant messages
  const toolCallIdToName = new Map<string, string>();
  for (const msg of llmMessages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName.set(tc.id, tc.function?.name || "");
      }
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (i >= cutoffIndex) break; // Don't touch recent messages

    const msg = result[i];
    if (msg.role !== "tool") continue;

    // Look up the tool name from the corresponding tool_call
    const toolName = toolCallIdToName.get(msg.toolCallId) || "";

    // Skip if the tool is not compactable
    if (!COMPACTABLE_TOOLS.has(toolName)) continue;
    if (NEVER_COMPACT_TOOLS.has(toolName)) continue;

    // Skip if the result is too short to be worth compacting
    const content = msg.content || "";
    if (content.length < MIN_RESULT_SIZE_TO_COMPACT) continue;

    // Skip if already pruned (contains the prune marker)
    if (content.startsWith("[Tool result pruned")) continue;

    // Replace with a pruned version using head/tail strategy (DSH-aligned)
    const originalLength = content.length;
    const placeholder = pruneToolResult(toolName, content);

    // If pruneToolResult returned the content unchanged (too short), skip
    if (placeholder === content) continue;

    result[i] = {
      ...msg,
      content: placeholder,
    };

    compactedCount++;
    charsSaved += originalLength - placeholder.length;
  }

  if (compactedCount > 0) {
    console.log(
      `[micro-compact] Compacted ${compactedCount} tool results, saved ~${charsSaved.toLocaleString()} chars`,
    );
  }

  return {
    compactedCount,
    charsSaved,
    messages: result,
  };
}

/**
 * Check if micro-compact has already been applied to the messages.
 * This prevents re-compacting already-compacted messages on subsequent iterations.
 */
export function isAlreadyMicroCompacted(llmMessages: any[]): boolean {
  return llmMessages.some(
    (msg) => msg.role === "tool" && typeof msg.content === "string" &&
    (msg.content.startsWith("[Tool result pruned") || msg.content.startsWith("[Tool result compacted")),
  );
}
