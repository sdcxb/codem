/**
 * GitCommitService — Auto-generate commit message via LLM and auto-commit
 *
 * Flow:
 *   1. file-change-tracker.finalize() → if autoCommitEnabled → trigger
 *   2. git status --short + git diff --cached --stat + git diff --cached (truncated 50KB)
 *   3. Call LLM (compaction slot, temp=0.3) → commit message
 *   4. git add -A + git commit -m "message"
 *   5. emit("auto_committed") → GitInfoPanel refreshes
 */

import { buildGitCommand } from "../utils/ps-command";

export interface AutoCommitResult {
  success: boolean;
  message: string | null;
  filesChanged: number;
  error?: string;
}

type AutoCommitListener = (result: AutoCommitResult) => void;
const listeners = new Set<AutoCommitListener>();

export function onAutoCommitted(listener: AutoCommitListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(result: AutoCommitResult): void {
  listeners.forEach((l) => {
    try { l(result); } catch (e) { console.warn("[GitCommitService] listener error:", e); }
  });
}

/** Settings flag: whether auto-commit is enabled */
let autoCommitEnabled = false;

export function setAutoCommitEnabled(enabled: boolean): void {
  autoCommitEnabled = enabled;
  try {
    localStorage.setItem("auto_commit_enabled", enabled ? "1" : "0");
  } catch {}
}

export function isAutoCommitEnabled(): boolean {
  try {
    const stored = localStorage.getItem("auto_commit_enabled");
    if (stored !== null) autoCommitEnabled = stored === "1";
  } catch {}
  return autoCommitEnabled;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { invoke } = (window as any).__TAURI__.core;
  // FIX: build a PowerShell-safe command (args like commit messages may contain
  // single quotes / `$` / backticks / `;` — previously spliced raw into a
  // double-quoted string, causing PowerShell interpretation / injection).
  // 30s 有界超时；Rust 侧超时会杀进程树。
  const result = await invoke("execute_command", {
    command: buildGitCommand(cwd, args),
    cwd,
    timeout_ms: 30_000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.exitCode ?? 0,
  };
}

/**
 * Generate a commit message from current staged changes.
 * Uses a simple heuristic: summarize changed files + additions/deletions.
 * If an LLM engine is provided, uses it for a richer message.
 */
export async function generateCommitMessage(
  workspace: string,
  llmEngine?: { complete: (prompt: string, systemPrompt?: string) => Promise<string> },
): Promise<string> {
  const statusResult = await runGit(workspace, ["status", "--short"]);
  const statResult = await runGit(workspace, ["diff", "--cached", "--stat"]);
  const diffResult = await runGit(workspace, ["diff", "--cached"]);

  const statusShort = statusResult.stdout.trim();
  const stat = statResult.stdout.trim();
  const diff = diffResult.stdout.slice(0, 50_000); // Truncate at 50KB

  const fileCount = statusShort ? statusShort.split("\n").length : 0;
  if (fileCount === 0) return "";

  // If LLM engine available, generate richer message
  if (llmEngine) {
    const prompt = `Based on the following git changes, generate a concise commit message (first line max 50 chars, optional body). Use conventional commits format (feat/fix/refactor/docs/chore).\n\nGit status:\n${statusShort}\n\nDiff stat:\n${stat}\n\nDiff (truncated):\n${diff}\n\nCommit message:`;
    try {
      const message = await llmEngine.complete(prompt, "You are a helpful assistant that generates git commit messages.");
      return message.trim();
    } catch (e) {
      console.warn("[GitCommitService] LLM commit message failed, using heuristic:", e);
    }
  }

  // Heuristic fallback: generate from file list
  const files = statusShort.split("\n").map((line) => line.substring(3).trim());
  const added = (stat.match(/(\d+) insertion/)?.[1]) || "0";
  const deleted = (stat.match(/(\d+) deletion/)?.[1]) || "0";

  if (files.length === 1) {
    const file = files[0].split(/[/\\]/).pop() || files[0];
    return `update ${file} (+${added} -${deleted})`;
  }
  return `update ${files.length} files (+${added} -${deleted})`;
}

/**
 * Execute git add -A + git commit with the given message.
 */
export async function autoCommit(
  workspace: string,
  message: string,
): Promise<AutoCommitResult> {
  if (!message) {
    return { success: false, message: null, filesChanged: 0, error: "No message generated" };
  }

  try {
    // Stage all changes
    const addResult = await runGit(workspace, ["add", "-A"]);
    if (addResult.exitCode !== 0) {
      return { success: false, message: null, filesChanged: 0, error: addResult.stderr };
    }

    // Commit
    const commitResult = await runGit(workspace, ["commit", "-m", message]);
    if (commitResult.exitCode !== 0) {
      // "nothing to commit" is not an error
      if (commitResult.stdout.includes("nothing to commit") || commitResult.stdout.includes("no changes")) {
        return { success: true, message: null, filesChanged: 0 };
      }
      return { success: false, message: null, filesChanged: 0, error: commitResult.stderr };
    }

    // Count changed files
    const statusResult = await runGit(workspace, ["status", "--short"]);
    const remainingChanges = statusResult.stdout.trim().split("\n").filter(Boolean).length;

    const result: AutoCommitResult = {
      success: true,
      message,
      filesChanged: remainingChanges,
    };
    emit(result);
    return result;
  } catch (e: any) {
    const result: AutoCommitResult = {
      success: false,
      message: null,
      filesChanged: 0,
      error: e.message,
    };
    emit(result);
    return result;
  }
}

/**
 * Try to auto-commit if enabled. Called after file-change-tracker.finalize().
 */
export async function tryAutoCommit(
  workspace: string,
  llmEngine?: { complete: (prompt: string, systemPrompt?: string) => Promise<string> },
): Promise<AutoCommitResult | null> {
  if (!isAutoCommitEnabled()) return null;

  const message = await generateCommitMessage(workspace, llmEngine);
  if (!message) return null;

  return autoCommit(workspace, message);
}
