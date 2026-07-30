/**
 * Prompt Draft Storage — Prompt 草稿版本管理
 *
 * 用于保存、加载、删除 Prompt 草稿，支持版本对比
 */

import { getDatabase, persistDatabase } from "./database";

export interface PromptDraft {
  id: string;
  sessionId: string;
  version: number;
  content: string;
  tags: string[];
  createdAt: number;
}

/**
 * Save a new prompt draft
 */
export function savePromptDraft(
  sessionId: string,
  content: string,
  tags?: string[]
): string {
  const db = getDatabase();
  const id = `draft-${sessionId}-${Date.now()}`;
  const now = Date.now();

  // Get current version count
  const result = db.exec(
    "SELECT MAX(version) as max_version FROM prompt_drafts WHERE session_id = ?",
    [sessionId]
  );
  const version = result.length > 0 && result[0].values[0][0]
    ? (result[0].values[0][0] as number) + 1
    : 1;

  db.run(
    "INSERT INTO prompt_drafts (id, session_id, version, content, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, sessionId, version, content, JSON.stringify(tags || []), now]
  );

  persistDatabase();
  return id;
}

/**
 * Load all prompt drafts for a session
 */
export function loadPromptDrafts(sessionId: string): PromptDraft[] {
  const db = getDatabase();
  const result = db.exec(
    "SELECT id, session_id, version, content, tags, created_at FROM prompt_drafts WHERE session_id = ? ORDER BY version DESC",
    [sessionId]
  );

  if (result.length === 0) return [];

  return result[0].values.map((row) => ({
    id: row[0] as string,
    sessionId: row[1] as string,
    version: row[2] as number,
    content: row[3] as string,
    tags: JSON.parse(row[4] as string || "[]") as string[],
    createdAt: row[5] as number,
  }));
}

/**
 * Delete a prompt draft
 */
export function deletePromptDraft(draftId: string): void {
  const db = getDatabase();
  db.run("DELETE FROM prompt_drafts WHERE id = ?", [draftId]);
  persistDatabase();
}

/**
 * Compare two prompt drafts and return diff
 */
export function comparePromptDrafts(
  draftId1: string,
  draftId2: string
): { draft1: PromptDraft; draft2: PromptDraft; diff: string } {
  const db = getDatabase();
  const result = db.exec(
    "SELECT * FROM prompt_drafts WHERE id IN (?, ?) ORDER BY version",
    [draftId1, draftId2]
  );

  if (result.length === 0 || result[0].values.length < 2) {
    throw new Error("Drafts not found");
  }

  const rows = result[0].values;
  const draft1: PromptDraft = {
    id: rows[0][0] as string,
    sessionId: rows[0][1] as string,
    version: rows[0][2] as number,
    content: rows[0][3] as string,
    tags: JSON.parse(rows[0][4] as string || "[]") as string[],
    createdAt: rows[0][5] as number,
  };
  const draft2: PromptDraft = {
    id: rows[1][0] as string,
    sessionId: rows[1][1] as string,
    version: rows[1][2] as number,
    content: rows[1][3] as string,
    tags: JSON.parse(rows[1][4] as string || "[]") as string[],
    createdAt: rows[1][5] as number,
  };

  // Simple line-by-line diff
  const lines1 = draft1.content.split("\n");
  const lines2 = draft2.content.split("\n");
  const diff: string[] = [];

  const maxLen = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLen; i++) {
    const line1 = lines1[i];
    const line2 = lines2[i];

    if (line1 === line2) {
      diff.push(`  ${line1 || ""}`);
    } else {
      if (line1 !== undefined) diff.push(`- ${line1}`);
      if (line2 !== undefined) diff.push(`+ ${line2}`);
    }
  }

  return {
    draft1,
    draft2,
    diff: diff.join("\n"),
  };
}