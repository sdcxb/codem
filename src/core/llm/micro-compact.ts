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
 * Generate a structured summary for a compacted tool result.
 * Instead of a generic placeholder, this produces tool-specific metadata
 * that helps the LLM understand what happened without re-reading the full output.
 */
function generateToolSummary(toolName: string, content: string): string {
  const originalLength = content.length;
  const lines = content.split("\n");
  const totalLines = lines.length;

  switch (toolName) {
    case "read": {
      // Try to extract file path from common output patterns
      const pathMatch = content.match(/^(?:---\s*)?(.+?\.\w+)(?:\s*---)?$/m);
      const filePath = pathMatch ? pathMatch[1].trim() : "file";
      // Extract key indicators from the content
      const hasError = content.toLowerCase().includes("error") || content.toLowerCase().includes("not found");
      const keyLines = lines.slice(0, 3).map(l => l.substring(0, 200)).join("\n");
      return `[Tool result compacted — read ${filePath} (${totalLines} lines, ${originalLength.toLocaleString()} chars)]\n` +
        `${hasError ? "Status: contains error/not-found\n" : ""}` +
        `Opening lines:\n${keyLines}\n` +
        `[Use 'read' to retrieve full content if needed]`;
    }

    case "bash": {
      // Extract exit code and command
      const exitMatch = content.match(/(?:exit code|exit_code|Exit code)\s*[:=]\s*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : "?";
      const cmdMatch = content.match(/^(?:Command|CMD|cmd|command)\s*[:=]\s*(.+)$/im);
      const cmd = cmdMatch ? cmdMatch[1].trim() : "command";
      const outputLines = lines.filter(l => l.trim()).slice(0, 5).map(l => l.substring(0, 200)).join("\n");
      return `[Tool result compacted — bash: ${cmd.substring(0, 80)} (exit ${exitCode}, ${originalLength.toLocaleString()} chars)]\n` +
        `Output preview:\n${outputLines}\n` +
        `[Re-run the command if you need fresh output]`;
    }

    case "grep": {
      // Count matches
      const matchCount = lines.filter(l => l.trim() && !l.startsWith("grep:")).length;
      const sampleMatches = lines.filter(l => l.trim() && !l.startsWith("grep:")).slice(0, 3).join("\n");
      return `[Tool result compacted — grep: ${matchCount} matches (${originalLength.toLocaleString()} chars)]\n` +
        `Sample matches:\n${sampleMatches}\n` +
        `[Use 'grep' to re-search if needed]`;
    }

    case "glob": {
      const fileCount = lines.filter(l => l.trim()).length;
      const sampleFiles = lines.filter(l => l.trim()).slice(0, 5).join("\n");
      return `[Tool result compacted — glob: ${fileCount} files found (${originalLength.toLocaleString()} chars)]\n` +
        `Sample paths:\n${sampleFiles}\n` +
        `[Use 'glob' to re-search if needed]`;
    }

    case "web_fetch":
    case "web_search": {
      const resultCount = content.match(/<result>/g)?.length || content.match(/^Title:/gm)?.length || totalLines;
      const preview = lines.slice(0, 4).map(l => l.substring(0, 200)).join("\n");
      return `[Tool result compacted — ${toolName}: ~${resultCount} results (${originalLength.toLocaleString()} chars)]\n` +
        `Preview:\n${preview}\n` +
        `[Re-run ${toolName} if you need the full content]`;
    }

    case "lsp":
    case "lsp_tool": {
      const symbolCount = content.match(/^Symbol:|^\s+[A-Za-z]/gm)?.length || totalLines;
      const preview = lines.slice(0, 4).map(l => l.substring(0, 200)).join("\n");
      return `[Tool result compacted — ${toolName}: ~${symbolCount} symbols/results (${originalLength.toLocaleString()} chars)]\n` +
        `Preview:\n${preview}\n` +
        `[Use 'lsp_tool' to re-query if needed]`;
    }

    case "codebase_search":
    case "tool_search": {
      const resultCount = lines.filter(l => l.match(/^\d+\.|^- |^File:|^Path:/)).length || totalLines;
      const preview = lines.slice(0, 4).map(l => l.substring(0, 200)).join("\n");
      return `[Tool result compacted — ${toolName}: ~${resultCount} results (${originalLength.toLocaleString()} chars)]\n` +
        `Preview:\n${preview}\n` +
        `[Re-run search if needed]`;
    }

    case "spawn_subagent":
    case "wait_for_subagent": {
      // Sub-agent results — extract key outcome
      const taskIdMatch = content.match(/SUBAGENT_TASK_ID:(\S+)/);
      const taskId = taskIdMatch ? taskIdMatch[1] : "?";
      const statusMatch = content.match(/(completed|failed|aborted|timeout)/i);
      const status = statusMatch ? statusMatch[1] : "done";
      const preview = lines.slice(0, 4).map(l => l.substring(0, 200)).join("\n");
      return `[Tool result compacted — ${toolName}: task ${taskId} (${status}, ${originalLength.toLocaleString()} chars)]\n` +
        `Result preview:\n${preview}\n` +
        `[The sub-agent's work is recorded in its session]`;
    }

    default: {
      // Generic fallback — still better than blank placeholder
      const preview = content.substring(0, 150);
      return `[Tool result compacted — ${toolName}: ${originalLength.toLocaleString()} chars, ${totalLines} lines]\n` +
        `Preview: ${preview}...\n` +
        `[Re-run the tool if you need the full output]`;
    }
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

    // Skip if already compacted (contains the placeholder)
    if (content.startsWith("[Tool result compacted")) continue;

    // Replace with a structured tool-specific summary
    const originalLength = content.length;
    const placeholder = generateToolSummary(toolName, content);

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
    (msg) => msg.role === "tool" && typeof msg.content === "string" && msg.content.startsWith("[Tool result compacted"),
  );
}
