/**
 * FileChangeTracker — Per-turn file change tracking via git tree snapshots
 *
 * Lifecycle:
 *   start(workspace)  → capture before-tree (git rev-parse HEAD^{tree})
 *   finalize()         → capture after-tree → generate patch → store to SQLite → emit event
 *   revert(turnId)    → apply reverse patch → restore before state
 *
 * Key design:
 *   - Only invoked at iteration boundaries (not inside tool execution)
 *   - Gracefully degrades for non-git workspaces (returns false, no error)
 *   - Patch truncated at 500KB; files list truncated at 2MB
 *   - Binary files: only track path, not content
 *   - Independent from v2_sessions.messages JSON — not affected by compaction
 */

import { executeCommand } from "../file-api";
import { FileChangeStorage, type ChangedFile } from "../storage/file-change-storage";

const MAX_PATCH_BYTES = 500_000;
const MAX_FILES_LIST_BYTES = 2_000_000;
const GIT_TIMEOUT_MS = 15_000;

export interface FileChangeResult {
  artifactId: string;
  changedFiles: ChangedFile[];
  patchTruncated: boolean;
  beforeTree: string | null;
  afterTree: string | null;
}

type Listener = (result: FileChangeResult) => void;
const listeners = new Set<Listener>();

export function onFileChangesTracked(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(result: FileChangeResult): void {
  listeners.forEach((l) => {
    try {
      l(result);
    } catch (e) {
      console.warn("[FileChangeTracker] listener error:", e);
    }
  });
}

/** Simple SHA-256 implementation using Web Crypto API */
async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateId(): string {
  return `tfc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const result = await invoke("execute_command", {
      command: `git -C "${cwd}" ${args.join(" ")}`,
      cwd,
    });
    // execute_command returns { stdout, stderr, exitCode }
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const exitCode = result.exitCode ?? 0;
    if (exitCode !== 0 && !stdout) {
      throw new Error(stderr || `git exited with code ${exitCode}`);
    }
    return stdout.trim();
  } catch (e: any) {
    throw new Error(`git ${args.join(" ")} failed: ${e.message}`);
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const output = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return output === "true";
  } catch {
    return false;
  }
}

export class FileChangeTracker {
  private workspace: string;
  private beforeTree: string | null = null;
  private active = false;
  private sessionId: string;
  private messageId: string;
  private turnIndex: number;

  constructor(
    workspace: string,
    sessionId: string,
    messageId: string,
    turnIndex: number,
  ) {
    this.workspace = workspace;
    this.sessionId = sessionId;
    this.messageId = messageId;
    this.turnIndex = turnIndex;
  }

  /**
   * Capture the git tree before agent executes tools.
   * Returns false if not a git repo — caller should skip tracking.
   */
  async start(): Promise<boolean> {
    if (!(await isGitRepo(this.workspace))) {
      return false;
    }

    try {
      this.beforeTree = await runGit(this.workspace, ["rev-parse", "HEAD^{tree}"]);
      this.active = true;
      return true;
    } catch (e) {
      console.warn("[FileChangeTracker] start failed:", e);
      return false;
    }
  }

  /**
   * Capture the git tree after agent completes tools.
   * Generate patch, store to SQLite, emit event.
   * Returns null if tracking not active or no changes.
   */
  async finalize(): Promise<FileChangeResult | null> {
    if (!this.active || !this.beforeTree) {
      return null;
    }
    this.active = false;

    try {
      const afterTree = await runGit(this.workspace, ["rev-parse", "HEAD^{tree}"]);

      // No changes — same tree
      if (afterTree === this.beforeTree) {
        return null;
      }

      // Get changed files list
      const nameStatus = await runGit(this.workspace, [
        "diff",
        "--name-status",
        this.beforeTree,
        afterTree,
      ]);

      const changedFiles = this.parseNameStatus(nameStatus);

      // Pre-check: get diff stat to estimate patch size before running full binary diff
      // This avoids running a potentially huge git diff --binary for very large changes
      let patch = "";
      let patchTruncated = false;
      try {
        // Get stat first to estimate size
        const statOutput = await runGit(this.workspace, [
          "diff",
          "--stat",
          this.beforeTree,
          afterTree,
        ]);
        // Estimate: if stat output mentions many files or large line counts, skip full patch
        const statLines = statOutput.split("\n").filter(Boolean);
        const summaryLine = statLines[statLines.length - 1] || "";
        // Extract total insertions/deletions from summary like "10 files changed, 500 insertions(+), 200 deletions(-)"
        const insertionMatch = summaryLine.match(/(\d+) insertion/);
        const totalChanges = insertionMatch ? parseInt(insertionMatch[1]) : 0;
        const fileCount = statLines.length > 1 ? statLines.length - 1 : 0;

        // If estimated patch would be very large (> 2MB), skip full patch entirely
        // Individual file diffs can still be viewed on demand via FileChangesList
        const ESTIMATED_LARGE_THRESHOLD = 200_000; // ~200K line changes → likely > 2MB patch
        if (totalChanges > ESTIMATED_LARGE_THRESHOLD || fileCount > 100) {
          patch = `[Large diff: ${fileCount} files, ${totalChanges} line changes — use individual file diff viewer]`;
          patchTruncated = true;
        } else {
          // Get the full binary patch
          const rawPatch = await runGit(this.workspace, [
            "diff",
            "--binary",
            "--find-renames",
            this.beforeTree,
            afterTree,
          ]);
          if (rawPatch.length > MAX_PATCH_BYTES) {
            patch = rawPatch.slice(0, MAX_PATCH_BYTES);
            patchTruncated = true;
          } else {
            patch = rawPatch;
          }
        }
      } catch {
        // Binary diff may fail for some files — skip patch
        patch = "";
        patchTruncated = true;
      }

      // Build changed files JSON (with hashes if available)
      const changedFilesJson = JSON.stringify(changedFiles).slice(0, MAX_FILES_LIST_BYTES);

      // Compute SHA-256
      const patchSha = patch ? await sha256(patch) : null;

      // Build current brief (借鉴 Topic 概念)
      const brief = `Turn ${this.turnIndex}: ${changedFiles.length} file(s) changed (${changedFiles.filter((f) => f.status === "A").length} added, ${changedFiles.filter((f) => f.status === "M").length} modified, ${changedFiles.filter((f) => f.status === "D").length} deleted)`;

      const artifactId = generateId();

      // Store to SQLite
      FileChangeStorage.create({
        id: artifactId,
        session_id: this.sessionId,
        message_id: this.messageId,
        turn_index: this.turnIndex,
        before_tree: this.beforeTree,
        after_tree: afterTree,
        patch,
        changed_files: changedFilesJson,
        patch_sha256: patchSha,
        current_brief: brief,
        status: "completed",
        created_at: Date.now(),
      });

      const result: FileChangeResult = {
        artifactId,
        changedFiles,
        patchTruncated,
        beforeTree: this.beforeTree,
        afterTree,
      };

      emit(result);
      return result;
    } catch (e) {
      console.warn("[FileChangeTracker] finalize failed:", e);
      return null;
    }
  }

  /**
   * Parse `git diff --name-status` output into ChangedFile[].
   * Format: "M\tpath/to/file\nA\tpath/to/new\nD\tpath/to/old\nR100\told\tnew"
   */
  private parseNameStatus(output: string): ChangedFile[] {
    const lines = output.split("\n").filter((l) => l.trim());
    const files: ChangedFile[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      const status = parts[0]?.charAt(0) || "M";

      if (status === "R" && parts.length >= 3) {
        // Rename: R100\told_path\tnew_path
        files.push({ path: parts[2], status: "R" });
      } else if (parts.length >= 2) {
        files.push({ path: parts[1], status });
      }
    }

    return files;
  }

  /**
   * Revert to a specific turn's before state by applying reverse patch.
   */
  static async revert(artifactId: string, workspace: string): Promise<boolean> {
    const record = FileChangeStorage.getById(artifactId);
    if (!record || !record.patch) {
      console.warn("[FileChangeTracker] revert: no patch found for", artifactId);
      return false;
    }

    try {
      // Apply reverse patch
      const { invoke } = (window as any).__TAURI__.core;
      // Write patch to temp file, then apply with --reverse
      const tempPath = `${workspace}/.git/revert-${artifactId}.patch`;
      await invoke("write_file", { path: tempPath, content: record.patch });

      const result = await invoke("execute_command", {
        command: `git -C "${workspace}" apply --reverse "${tempPath}"`,
        cwd: workspace,
      });

      // Cleanup temp file
      try {
        await invoke("execute_command", {
          command: `del "${tempPath}" 2>nul || rm -f "${tempPath}"`,
          cwd: workspace,
        });
      } catch {}

      if (result.exitCode !== 0) {
        console.warn("[FileChangeTracker] revert: git apply failed:", result.stderr);
        return false;
      }

      FileChangeStorage.updateStatus(artifactId, "reverted");
      return true;
    } catch (e) {
      console.error("[FileChangeTracker] revert failed:", e);
      return false;
    }
  }

  /**
   * Check if a workspace is a git repo (useful before creating tracker).
   */
  static async isGitWorkspace(workspace: string): Promise<boolean> {
    return isGitRepo(workspace);
  }
}
