/**
 * FileChangeStorage — Per-turn file change tracking persistence
 *
 * Stores git tree snapshots + binary diffs + artifact metadata.
 * Independent from v2_sessions.messages JSON — not affected by context compaction.
 */

import { reportPersistFailure } from "./persist-failure";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

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
    /**
     * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，绝不写一份读路径看不见的副本。
     *
     * 原实现回到 `getDatabase()` 写旧库 —— 但回滚开关已退役、旧库在 rust 模式下刻意不加载，
     * A 态（端口未注册）在生产里已不可能出现；那时 `getDatabase()` 只会抛
     * "Database not initialized"，把一个"未就绪"的瞬时状态变成真故障。
     */
    reportPersistFailure(
      "fileChange.create",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "文件变更记录未保存",
    );
  },

  listBySession(sessionId: string): TurnFileChangeRecord[] {
    const rust = domainReadMany(TABLE, rowToRecord, { session_id: sessionId });
    if (rust) return rust.sort((a, b) => b.turn_index - a.turn_index);
    /**
     * **旧库读取已删除**（L4 收尾）：端口没接手 → 该域的合理空结果（空数组）。
     *
     * 与原来 `if (!db) return [];` 的**语义完全一致**（原来也只是返回空），
     * 区别只是不再去碰一份不存在的旧库 —— 调用方在端口就绪后重载即可。
     */
    return [];
  },

  getById(id: string): TurnFileChangeRecord | null {
    const rust = domainReadOne(TABLE, { id }, rowToRecord);
    if (rust !== undefined) return rust;
    // 端口没接手 → 该域读不到这一行（旧库已从渲染进程移除）→ 如实返回 null
    return null;
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
    /**
     * **旧库更新已删除**（L4 收尾）：端口没接手时**如实返回 0** ——
     * 调用方据此知道"状态根本没改成"，而不是拿到一个假成功。
     *
     * 这保住了第 84 波那次的 A 类语义（"返回真实影响行数"）：0 的**含义不变**，
     * 只是从"SQL UPDATE 影响 0 行"变成"连写都没发生"。
     * 注意这里**不能**上报成 persist 失败后返回 1 —— 那正好就是它要修的假成功。
     */
    return 0;
  },

  deleteBySession(sessionId: string): void {
    if (domainDelete(TABLE, { session_id: sessionId }, { scope: "fileChange.deleteBySession", note: "文件变更记录未删除" })) {
      return;
    }
    // 端口没接手 → 未执行任何删除，如实上报（绝不静默当成已删除）
    reportPersistFailure(
      "fileChange.deleteBySession",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "文件变更记录未删除",
    );
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