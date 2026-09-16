/**
 * Prompt Draft Storage — Prompt 草稿版本管理
 *
 * 用于保存、加载、删除 Prompt 草稿，支持版本对比
 */

import { tryGetDatabase, persistDatabase } from "./database";
import { reportPersistFailure } from "./persist-failure";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

// ========== 迁移期分流（P3 第 13 段） ==========
//
// 骨架在 `domain-store.ts`（加载判定 / 写穿上报 / 超限回退），本文件只管行 shape 与语义。
// 注意 `version` 这一列：旧实现用 `MAX(version)+1` 在**数据库里**算，
// 走镜像时要在**镜像里**算同样的东西（见 maxVersion），语义保持一致。

const TABLE = "prompt_drafts";

/**
 * 旧库入口（P5 第 10 段）。
 *
 * ## 为什么这个文件要单独修
 *
 * 真机验收（打包版）实测：`app.conversation` 面板**整体崩溃**，
 * 控制台是 `Database not initialized. Call initDatabase() first.`，
 * 会话区一条消息都不渲染。堆栈落到本文件的 `listPromptDrafts`（渲染期同步调用）：
 *
 * - 端口分支用的是 `domainReadMany(...)`，而它在**镜像尚未加载完**时返回 `undefined`
 *   （这是设计：未加载完不路由，避免读写分裂）；
 * - 于是落到 `const db = getDatabase()` 这条回退；
 * - 而 rust 模式下旧库是**刻意不加载**的（省内存的前提），`getDatabase()` 按设计抛错；
 * - 渲染期抛出 = React 组件崩 → 面板变"此面板不可用"。
 *
 * 根因是**把"旧库不存在"当成了异常**。在新架构下它是正常状态，正确表达是
 * `tryGetDatabase()` 返回 null，由调用方给出"该域在 rust 模式下的合理结果"。
 *
 * ⚠️ 注意：`getDatabase()` 本身**保持抛错不变**（写路径上"没有库"是真错误，
 * 不该被静默吞掉）。所以这里逐个改为 `tryGetDatabase()` + 判空返回，
 * 而不是去改底层语义 —— 那种改法会把真实故障一起静默掉。
 */

/** 取旧库；rust 模式下旧库刻意不存在 → 返回 null（调用方给空结果，不抛） */
function legacyDb() {
  return tryGetDatabase();
}

/** 线协议行 → PromptDraft（tags 是 JSON 文本） */
function wireToDraft(row: Record<string, unknown>): PromptDraft {
  let tags: string[] = [];
  const rawTags = row.tags;
  if (typeof rawTags === "string" && rawTags.length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) tags = parsed as string[];
    } catch {
      tags = [];
    }
  }
  return {
    id: String(row.id ?? ""),
    sessionId: String(row.session_id ?? ""),
    version: Number(row.version ?? 0),
    content: String(row.content ?? ""),
    tags,
    createdAt: Number(row.created_at ?? 0),
  };
}

/** Draft → 线协议行 */
function draftToWire(d: PromptDraft): Record<string, unknown> {
  return {
    id: d.id,
    session_id: d.sessionId,
    version: d.version,
    content: d.content,
    tags: JSON.stringify(d.tags ?? []),
    created_at: d.createdAt,
  };
}

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
  const id = `draft-${sessionId}-${Date.now()}`;
  const now = Date.now();

  // 迁移期：版本号在**同一份数据**上算（镜像里算 = 旧实现的 MAX(version) 等价物）
  const existing = domainReadMany(TABLE, wireToDraft, { session_id: sessionId });
  if (existing) {
    const version = existing.reduce((m, d) => Math.max(m, d.version), 0) + 1;
    const draft: PromptDraft = { id, sessionId, version, content, tags: tags ?? [], createdAt: now };
    domainWrite(TABLE, [draftToWire(draft)], { scope: "promptDraft.save", note: "草稿未保存" });
    return id;
  }

  const db = legacyDb();
  if (!db) {
    // 写路径：不能静默，也不能抛（调用方多为 UI 动作）。如实上报为"未保存"。
    reportPersistFailure("promptDraft.save", new Error("旧库不存在且端口未接手"), "草稿未保存（查询索引不可用）");
    return id;
  }

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
  const rust = domainReadMany(TABLE, wireToDraft, { session_id: sessionId });
  if (rust) {
    // 与旧实现一致：version DESC
    return rust.sort((a, b) => b.version - a.version);
  }
  const db = legacyDb();
  if (!db) return []; // rust 模式且镜像未就绪：给空结果，绝不在渲染期抛
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
  if (domainDelete(TABLE, { id: draftId }, { scope: "promptDraft.delete", note: "草稿未删除" })) return;
  const db = legacyDb();
  if (!db) {
    reportPersistFailure("promptDraft.delete", new Error("旧库不存在且端口未接手"), "草稿未删除");
    return;
  }
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
  // 迁移期：两次按 id 读（旧实现用 `WHERE id IN (?, ?)`，语义等价）
  const d1 = domainReadOne(TABLE, { id: draftId1 }, wireToDraft);
  const d2 = domainReadOne(TABLE, { id: draftId2 }, wireToDraft);
  let draft1: PromptDraft;
  let draft2: PromptDraft;
  if (d1 !== undefined && d2 !== undefined) {
    if (!d1 || !d2) throw new Error("Drafts not found");
    // 与旧实现一致：按 version 升序排列
    [draft1, draft2] = d1.version <= d2.version ? [d1, d2] : [d2, d1];
  } else {
    const db = legacyDb();
    const result = db
      ? db.exec("SELECT * FROM prompt_drafts WHERE id IN (?, ?) ORDER BY version", [draftId1, draftId2])
      : [];

    if (result.length === 0 || result[0].values.length < 2) {
      // 读不到就是"找不到草稿"（业务语义），不该是"数据库没初始化"（基础设施语义）
      throw new Error("Drafts not found");
    }

    const rows = result[0].values;
    draft1 = {
      id: rows[0][0] as string,
      sessionId: rows[0][1] as string,
      version: rows[0][2] as number,
      content: rows[0][3] as string,
      tags: JSON.parse(rows[0][4] as string || "[]") as string[],
      createdAt: rows[0][5] as number,
    };
    draft2 = {
      id: rows[1][0] as string,
      sessionId: rows[1][1] as string,
      version: rows[1][2] as number,
      content: rows[1][3] as string,
      tags: JSON.parse(rows[1][4] as string || "[]") as string[],
      createdAt: rows[1][5] as number,
    };
  }

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