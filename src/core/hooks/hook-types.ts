/**
 * Hook Types — Type definitions for the hooks event system
 *
 * Design (from CLAUDE-CODE-IMPACT-ANALYSIS.md):
 * - 4 event types: PreToolUse, PostToolUse, SessionStart, Stop
 * - 2 hook types: command (shell), function (JS callback)
 * - Hooks are optional — default 0 hooks registered
 * - PreToolUse can deny or modify input
 * - PostToolUse can modify result
 */

// ========== Event Types ==========

export type HookEventType =
  | "PreToolUse"    // P0-2: Layer 1 pre-execute (existing)
  | "PostToolUse"   // P0-2: Layer 4 post-execute (existing)
  | "SessionStart"  // Session lifecycle (existing)
  | "Stop"          // Session lifecycle (existing)
  // P0-2: New guard and finalize event types for the 5-layer pipeline
  | "Guard"         // Layer 2: monotonic guard (can deny, cannot modify)
  | "Finalize";     // Layer 5: post-execution finalization (read-only)

// ========== Hook Definition ==========

export interface HookCondition {
  /** Tool name pattern (supports glob: "Bash(git *)" or just "bash") */
  tool?: string;
  /** If condition — only fire when this evaluates to true */
  if?: string;
}

export interface HookDefinition {
  id: string;
  /** Event type this hook fires on */
  event: HookEventType;
  /** Display name */
  name: string;
  /** Condition for firing */
  condition?: HookCondition;
  /** Hook type: command (shell) or function (JS callback) */
  type: "command" | "function";
  /** For command type: the shell command to execute */
  command?: string;
  /** For function type: the JS function body (evaluated in sandbox) */
  function?: string;
  /** Whether this hook is enabled */
  enabled: boolean;
  /** Timeout in milliseconds (default 10000) */
  timeoutMs?: number;
}

// ========== Hook Execution Result ==========

export interface PreToolHookResult {
  /** Whether to allow the tool to proceed */
  action: "allow" | "deny" | "modify";
  /** If action is "deny", the error message to return to the LLM */
  denyMessage?: string;
  /** If action is "modify", the modified input to use instead */
  modifiedInput?: Record<string, unknown>;
}

export interface PostToolHookResult {
  /** Whether to modify the result */
  action: "keep" | "modify";
  /** If action is "modify", the modified output to use */
  modifiedOutput?: string;
  /** Additional metadata to attach */
  metadata?: Record<string, any>;
}

// ========== Hook Context ==========

export interface HookContext {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  cwd: string;
}

// ========== Hook Configuration ==========

export interface HookConfig {
  hooks: HookDefinition[];
}

export const DEFAULT_HOOK_CONFIG: HookConfig = {
  hooks: [],
};

// ========== Hook Matching ==========

/**
 * Match a tool name against a hook condition's tool pattern.
 * Supports:
 * - Exact match: "bash" matches "bash"
 * - Glob match: "Bash(git *)" matches "bash" when the command starts with "git"
 */
export function matchesTool(pattern: string, toolName: string, input?: Record<string, unknown>): boolean {
  // Case-insensitive comparison for tool name
  const lowerPattern = pattern.toLowerCase();
  const lowerTool = toolName.toLowerCase();

  // Simple exact match
  if (lowerPattern === lowerTool) return true;

  // Bash(git *) pattern → extract tool name and command prefix
  const bashPatternMatch = lowerPattern.match(/^(\w+)\((.*)\)$/);
  if (bashPatternMatch) {
    const [, patternTool, patternContent] = bashPatternMatch;
    if (patternTool !== lowerTool) return false;

    // For bash, check if the command matches the glob pattern
    if (patternContent.endsWith("*")) {
      const prefix = patternContent.slice(0, -1).trim();
      const command = (input?.command as string || "").toLowerCase();
      return command.startsWith(prefix.toLowerCase());
    }
    // Exact command match
    const command = (input?.command as string || "").toLowerCase();
    return command === patternContent;
  }

  return false;
}

/**
 * Check if a hook should fire for the given tool and event.
 */
export function shouldFireHook(hook: HookDefinition, event: HookEventType, toolName: string, input?: Record<string, unknown>): boolean {
  if (!hook.enabled) return false;
  if (hook.event !== event) return false;
  if (hook.condition?.tool) {
    if (!matchesTool(hook.condition.tool, toolName, input)) return false;
  }
  return true;
}
