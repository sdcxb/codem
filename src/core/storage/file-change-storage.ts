/**
 * FileChangeStorage — Per-turn file change tracking persistence
 *
 * Stores git tree snapshots + binary diffs + artifact metadata.
 * Independent from v2_sessions.messages JSON — not affected by context compaction.
 */

import { getDatabase, persistDatabase, tryGetDatabase } from "./database";
import { runGuarded } from "./write-guard";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, writeShouldFallBackToLegacy } from "./domain-store";

export interface TurnFileChangeRecord {
  id: string;
  session_id: string;
  message_id: string;
  turn_index: number;
  before_tree: string | null;
  after_tree: string | null;
  patch: string | null;
  changed_files: string | null; // JSON [{path, status, before_hash, after_hash}]
  patch_sha256: string | null;
  current_brief: string | null;
  status: "completed" | "reverted" | "pending_review";
  created_at: number;
}

export interface ChangedFile {
  path: string;
  status: string; // M, A, D, R
  before_hash?: string;
  after_hash?: string;
}

const TABLE = "turn_file_changes";

/** 列名本来就是 snake_case，线协议行可直接用（这里只补齐缺省值） */
function rowToRecord(row: any): TurnFileChangeRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    message_id: row.message_id,
    turn_index: row.turn_index,
    before_tree: row.before_tree,
    after_tree: row.after_tree,
    patch: row.patch,
    changed_files: row.changed_files,
    patch_sha256: row.patch_sha256,
    current_brief: row.current_brief,
    status: row.status || "completed",
    created_at: row.created_at,
  };
}

/** 记录 → 线协议行（列名一致，显式列出以避免把多余字段带进去） */
function recordToWire(r: TurnFileChangeRecord): Record<string, unknown> {
  return {
    id: r.id,
    session_id: r.session_id,
    message_id: r.message_id,
    turn_index: r.turn_index,
    before_tree: r.before_tree,
    after_tree: r.after_tree,
    patch: r.patch,
    changed_files: r.changed_files,
    patch_sha256: r.patch_sha256,
    current_brief: r.current_brief,
    status: r.status,
    created_at: r.created_at,
  };
}

export const FileChangeStorage = {
  create(record: TurnFileChangeRecord): void {
    if (domainWrite(TABLE, [recordToWire(record)], { scope: "fileChange.create", note: "文件变更记录未保存" })) {
      return;
    }
  /*
   * 两态分流（B0-2）：`getDatabase()` **从不返回 null**（它抛错），
   * 所以原来的 `if (!db) return;` 是**无效防御** —— 永不触发，实际在 B 态直接抛。
   * 改为真判据：A 态（端口未注册）才回退；B 态已如实上报。
   */
    if (!writeShouldFallBackToLegacy("fileChange.create", "文件变更记录未保存")) return;
    const db = getDatabase();
    db.run(
      `INSERT INTO turn_file_changes
       (id, session_id, message_id, turn_index, before_tree, after_tree, patch, changed_files, patch_sha256, current_brief, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.session_id,
        record.message_id,
        record.turn_index,
        record.before_tree,
        record.after_tree,
        record.patch,
        record.changed_files,
        record.patch_sha256,
        record.current_brief,
        record.status,
        record.created_at,
      ],
    );
    persistDatabase();
  },

  listBySession(sessionId: string): TurnFileChangeRecord[] {
    const rust = domainReadMany(TABLE, rowToRecord, { session_id: sessionId });
    if (rust) return rust.sort((a, b) => b.turn_index - a.turn_index);
    // P5 第 7 段：旧库在 rust 模式下刻意不存在 → 返回空（端口就绪后调用方会重载）
    const db = tryGetDatabase();
    if (!db) return [];
    const result = db.exec(
      `SELECT * FROM turn_file_changes WHERE session_id = ? ORDER BY turn_index DESC`,
      [sessionId],
    );
    if (!result.length || !result[0].values.length) return [];
    const columns = result[0].columns;
    return result[0].values.map((row) => {
      const obj: any = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return rowToRecord(obj);
    });
  },

  getById(id: string): TurnFileChangeRecord | null {
    const rust = domainReadOne(TABLE, { id }, rowToRecord);
    if (rust !== undefined) return rust;
    const db = tryGetDatabase();
    if (!db) return null;
    const result = db.exec(`SELECT * FROM turn_file_changes WHERE id = ?`, [id]);
    if (!result.length || !result[0].values.length) return null;
    const columns = result[0].columns;
    const row = result[0].values[0];
    const obj: any = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return rowToRecord(obj);
  },

  /**
   * 更新某条文件变更记录的状态。
   *
   * 第 84 波（A 类：静默空写）：原来直接 `db.run(UPDATE … WHERE id = ?)`，
   * 影响 0 行时**没有任何痕迹**（记录不存在 / id 拼错 → 状态永远停在旧值，
   * 界面上却以为已经改成 reverted/pending_review）。改走 runGuarded 让它可见。
   *
   * @returns 真正被更新的行数（0 = 目标记录不存在）
   */
  updateStatus(id: string, status: string): number {
    // 迁移期：从镜像读出记录 → 改状态 → 整体写回。
    // **必须保住 A 类语义**：目标记录不存在时返回 0（调用方据此知道"没改成"），
    // 而不是静默当成成功（第 84 波修过一次，不能再退化）。
    const current = domainReadOne(TABLE, { id }, rowToRecord);
    if (current !== undefined) {
      if (!current) return 0;
      const next = { ...current, status } as TurnFileChangeRecord;
      domainWrite(TABLE, [recordToWire(next)], {
        mode: "replace",
        scope: "fileChange.updateStatus",
        note: "文件变更状态未更新（记录不存在或写入失败）",
      });
      return 1;
    }
  /*
   * 两态分流（B0-2）：`getDatabase()` **从不返回 null**（它抛错），
   * 所以原来的 `if (!db) return;` 是**无效防御** —— 永不触发，实际在 B 态直接抛。
   * 改为真判据：A 态（端口未注册）才回退；B 态已如实上报。
   */
    if (!writeShouldFallBackToLegacy("fileChange.updateStatus", "文件变更状态未更新")) return 0;
    const db = getDatabase();
    const modified = runGuarded(
      db,
      `UPDATE turn_file_changes SET status = ? WHERE id = ?`,
      [status, id],
      { table: "turn_file_changes", op: "updateStatus", id, from: "FileChangeStorage.updateStatus" },
    );
    persistDatabase();
    return modified;
  },

  deleteBySession(sessionId: string): void {
    if (domainDelete(TABLE, { session_id: sessionId }, { scope: "fileChange.deleteBySession", note: "文件变更记录未删除" })) {
      return;
    }
  /*
   * 两态分流（B0-2）：`getDatabase()` **从不返回 null**（它抛错），
   * 所以原来的 `if (!db) return;` 是**无效防御** —— 永不触发，实际在 B 态直接抛。
   * 改为真判据：A 态（端口未注册）才回退；B 态已如实上报。
   */
    if (!writeShouldFallBackToLegacy("fileChange.deleteBySession", "文件变更记录未删除")) return;
    const db = getDatabase();
    db.run(`DELETE FROM turn_file_changes WHERE session_id = ?`, [sessionId]);
    persistDatabase();
  },

  parseChangedFiles(record: TurnFileChangeRecord): ChangedFile[] {
    if (!record.changed_files) return [];
    try {
      return JSON.parse(record.changed_files);
    } catch {
      return [];
    }
  },
};