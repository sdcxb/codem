/**
 * Security Mode — three-tier approval policy.
 *
 * Modes:
 * - "ask":  Every potentially destructive operation requires user confirmation.
 *           Write overwrites show Diff review dialog. Dangerous bash commands ask.
 * - "auto": App auto-approves safe/non-destructive operations. Only genuinely
 *           dangerous operations (rm -rf, git push --force, sudo, etc.) still ask.
 *           Write overwrites are auto-approved (no Diff dialog).
 * - "full": Full access. No human approval ever needed. All tools execute
 *           immediately without confirmation.
 *
 * Precedence (highest → lowest):
 *   1. Per-project security mode (stored in project config)
 *   2. Global security mode (stored in app settings)
 *   3. Default: "ask"
 */

import { getSetting, setSetting, removeSetting } from "../storage/settings";

// ========== Types ==========

export type SecurityMode = "ask" | "auto" | "full";

export interface SecurityModeInfo {
  mode: SecurityMode;
  label_zh: string;
  label_en: string;
  desc_zh: string;
  desc_en: string;
  icon: string;
}

// ========== Constants ==========

const GLOBAL_KEY = "codem-security-mode";
const PROJECT_KEY_PREFIX = "codem-security-mode-project:";

export const SECURITY_MODES: SecurityModeInfo[] = [
  {
    mode: "ask",
    label_zh: "请求批准",
    label_en: "Ask for Approval",
    desc_zh: "每次写入覆盖和潜在危险操作都会请求人工确认",
    desc_en: "Every write overwrite and potentially dangerous operation asks for confirmation",
    icon: "🛡️",
  },
  {
    mode: "auto",
    label_zh: "替我审批",
    label_en: "Auto-Approve",
    desc_zh: "安全操作自动通过，仅危险操作（rm -rf、git push --force、sudo 等）需确认",
    desc_en: "Safe operations auto-approved; only dangerous operations (rm -rf, git push --force, sudo) require confirmation",
    icon: "⚡",
  },
  {
    mode: "full",
    label_zh: "完全访问",
    label_en: "Full Access",
    desc_zh: "永不询问，所有操作直接执行，决策权完全交给 AI",
    desc_en: "Never ask. All operations execute immediately. Full control to AI",
    icon: "🚀",
  },
];

// ========== Global Security Mode ==========

/** Get the global security mode (stored in app settings) */
export function getGlobalSecurityMode(): SecurityMode {
  const val = getSetting(GLOBAL_KEY);
  if (val === "ask" || val === "auto" || val === "full") return val;
  return "ask"; // Default: ask for approval
}

/** Set the global security mode */
export function setGlobalSecurityMode(mode: SecurityMode): void {
  setSetting(GLOBAL_KEY, mode);
  // Notify listeners
  window.dispatchEvent(new CustomEvent("codem-security-mode-changed", { detail: { mode, scope: "global" } }));
}

// ========== Project Security Mode ==========

/** Get the per-project security mode override (null = not set, use global) */
export function getProjectSecurityMode(projectPath: string): SecurityMode | null {
  const val = getSetting(PROJECT_KEY_PREFIX + projectPath);
  if (val === "ask" || val === "auto" || val === "full") return val;
  return null; // No project override → use global
}

/** Set the per-project security mode override */
export function setProjectSecurityMode(projectPath: string, mode: SecurityMode | null): void {
  const key = PROJECT_KEY_PREFIX + projectPath;
  if (mode === null) {
    removeSetting(key);
  } else {
    setSetting(key, mode);
  }
  window.dispatchEvent(new CustomEvent("codem-security-mode-changed", { detail: { mode, scope: "project", projectPath } }));
}

// ========== Effective Mode Resolution ==========

/**
 * Get the effective security mode for a project.
 * Priority: project override > global > default("ask")
 */
export function getEffectiveSecurityMode(projectPath?: string): SecurityMode {
  if (projectPath) {
    const projectMode = getProjectSecurityMode(projectPath);
    if (projectMode) return projectMode;
  }
  return getGlobalSecurityMode();
}

// ========== Behavior Helpers ==========

/**
 * Whether to show the write-overwrite Diff confirmation dialog.
 * - "ask":   yes, always show for overwrites
 * - "auto":  no, auto-approve overwrites
 * - "full":  no, auto-approve everything
 */
export function shouldShowWriteConfirm(mode: SecurityMode): boolean {
  return mode === "ask";
}

/**
 * Whether to run the permission check (ask user for dangerous ops).
 * - "ask":   yes, run full permission check
 * - "auto":  yes, but only dangerous ops will trigger ask (safe ops auto-allow)
 * - "full":  no, skip all permission checks
 */
export function shouldCheckPermissions(mode: SecurityMode): boolean {
  return mode !== "full";
}

/**
 * Whether to auto-approve a tool call in "auto" mode.
 * Returns true if the operation is safe enough to auto-approve.
 *
 * In "auto" mode:
 * - Read-only tools (read, glob, grep, codebase_search, etc.) → always auto-approve
 * - Write/edit/multi_edit → auto-approve (no Diff dialog)
 * - Bash with dangerous patterns → still ask
 * - Everything else → auto-approve
 */
export function isAutoApprovable(tool: string, resource?: string): boolean {
  // Dangerous bash commands — never auto-approve
  if (tool === "bash" && resource) {
    const dangerousPatterns = [
      /rm\s+-rf/i,
      /git\s+push\s+--force/i,
      /git\s+reset\s+--hard/i,
      /chmod/i,
      /chown/i,
      /sudo/i,
      /mkfs/i,
      /dd\s+if=/i,
      /:\(\)\s*\{/i, // fork bomb
      /shutdown/i,
      /reboot/i,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(resource)) return false;
    }
  }

  // Everything else is auto-approvable in "auto" mode
  return true;
}

/**
 * Get the effective permission action for a tool call given the security mode.
 *
 * Returns "allow" | "ask" | "deny":
 * - "full" mode: always "allow" (unless hardcoded deny like .git)
 * - "auto" mode: "allow" for safe ops, "ask" for dangerous ops, "deny" for protected paths
 * - "ask" mode: delegate to normal permission evaluator
 */
export function evaluateWithSecurityMode(
  mode: SecurityMode,
  tool: string,
  resource: string | undefined,
  normalEvaluation: "allow" | "deny" | "ask",
): "allow" | "deny" | "ask" {
  // Protected paths (.git, .env, node_modules) are ALWAYS denied, regardless of mode
  // The normalEvaluation already includes these hard denies
  if (normalEvaluation === "deny") return "deny";

  switch (mode) {
    case "full":
      // Full access: allow everything (except hardcoded denies above)
      return "allow";

    case "auto":
      // Auto-approve safe operations, ask for dangerous ones
      if (isAutoApprovable(tool, resource)) {
        return "allow";
      }
      // Dangerous operation — still ask
      return "ask";

    case "ask":
    default:
      // Use normal evaluation
      return normalEvaluation;
  }
}
