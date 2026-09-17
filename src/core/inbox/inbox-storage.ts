/**
 * Inbox Storage — DB CRUD for inbox table
 */

import { reportPersistFailure } from "../storage/persist-failure";
import {
  domainDelete,
  domainDeleteWhere,
  domainReadMany,
  domainReadOne,
  domainWrite,
} from "../storage/domain-store";

// ========== Types ==========

export type InboxCategory = "issue" | "squad" | "delegation" | "automation" | "system" | "agent";
export type InboxPriority = "low" | "normal" | "high" | "urgent";

export interface InboxRow {
  id: string;
  category: string;
  title: string;
  body: string | null;
  source_type: string | null;
  source_id: string | null;
  project_id: string | null;
  squad_id: string | null;
  issue_id: string | null;
  priority: string;
  read: number;
  archived: number;
  created_at: number;
}

// ========== CRUD ==========

const TABLE = "inbox";
/** 通知保留期：只增不减会让数据库持续膨胀（自动化触发器每次触发都插一行） */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 线协议行就是 snake_case，直接用（字段显式列出，避免多余列混进返回值） */
function wireToInbox(row: Record<string, unknown>): InboxRow {
  return {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    body: (row.body as string) ?? null,
    source_type: (row.source_type as string) ?? null,
    source_id: (row.source_id as string) ?? null,
    project_id: (row.project_id as string) ?? null,
    squad_id: (row.squad_id as string) ?? null,
    issue_id: (row.issue_id as string) ?? null,
    priority: String(row.priority ?? "normal"),
    read: Number(row.read ?? 0),
    archived: Number(row.archived ?? 0),
    created_at: Number(row.created_at),
  };
}

/** `InboxRow` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function inboxToWire(row: InboxRow): Record<string, unknown> {
  return { ...row };
}

export const InboxStorage = {
  create(item: Omit<InboxRow, "read" | "archived" | "created_at">): InboxRow {
    const now = Date.now();
    const created: InboxRow = {
      ...item,
      body: item.body ?? null,
      source_type: item.source_type ?? null,
      source_id: item.source_id ?? null,
      project_id: item.project_id ?? null,
      squad_id: item.squad_id ?? null,
      issue_id: item.issue_id ?? null,
      priority: item.priority || "normal",
      read: 0,
      archived: 0,
      created_at: now,
    };

    if (domainWrite(TABLE, [inboxToWire(created)], { scope: "inbox.create", note: "通知未保存" })) {
      // 顺带清掉过期通知。**必须走域端口**：镜像已接手时若只删旧库，
      // 下一次整行写回会把旧库里"其实早已被清掉"的行重新插回 Rust（复活已删除数据）。
      const removed = domainDeleteWhere(
        TABLE,
        (row) => Number(row.created_at) < now - RETENTION_MS,
        "id",
        { scope: "inbox.sweep", note: "过期通知未清理" },
      );
      if (removed !== null) return created;
      // 写入已接手、但清理没接手（两者用同一个端口判据，理论上不可达）：
      // 如实上报"清理没做"，**不要**掉进下面那句"通知未保存"（那会把一次成功的写入说成失败）。
      reportPersistFailure(
        "inbox.sweep",
        new Error("端口未接手（该域镜像未注册或未就绪）"),
        "过期通知未清理",
      );
      return created;
    }

    /**
     * **旧库写入已删除**（L4 第 18 轮）：端口没接手时**如实上报**，不再写旧库。
     *
     * 返回值形状（`InboxRow`）保持不变 —— 调用方拿它去更新界面，但这次上报会通过
     * `codem:persist-failed` 让"没保存成功"可见，绝不静默当成写入成功。
     */
    reportPersistFailure(
      "inbox.create",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知未保存",
    );
    return created;
  },

  listAll(filters?: { projectId?: string; unreadOnly?: boolean; category?: InboxCategory }): InboxRow[] {
    const rust = domainReadMany(TABLE, wireToInbox, { archived: 0 });
    if (rust) {
      const filtered = rust.filter((r) => {
        if (filters?.projectId && r.project_id !== filters.projectId && r.project_id !== null) return false;
        if (filters?.unreadOnly && r.read !== 0) return false;
        if (filters?.category && r.category !== filters.category) return false;
        return true;
      });
      // 与旧 SQL 一致：created_at DESC + LIMIT 100
      return filtered.sort((a, b) => b.created_at - a.created_at).slice(0, 100);
    }
    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
    return [];
  },

  markRead(id: string): void {
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current !== undefined) {
      // 行不存在时用 `current === null` 判断，**不要**写成 `!current`：
      // 那是"假值"判断，行不存在与"字段为空"会被混为一谈（这里踩过一次）。
      if (current === null || current.read === 1) return;
      domainWrite(TABLE, [inboxToWire({ ...current, read: 1 })], {
        mode: "replace",
        scope: "inbox.markRead",
        note: "通知未标记为已读",
      });
      return;
    }
    // **旧库更新已删除**（L4 第 18 轮）：端口没接手时如实上报，绝不静默当成标记成功
    reportPersistFailure(
      "inbox.markRead",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知已读状态未更新",
    );
  },

  markAllRead(projectId?: string): void {
    const rust = domainReadMany(TABLE, wireToInbox, { read: 0 });
    if (rust) {
      const targets = rust.filter(
        (row) => !projectId || row.project_id === projectId || row.project_id === null,
      );
      if (targets.length === 0) return;
      domainWrite(TABLE, targets.map((row) => inboxToWire({ ...row, read: 1 })), {
        mode: "replace",
        scope: "inbox.markAllRead",
        note: "通知未批量标记为已读",
      });
      return;
    }
    // **旧库更新已删除**（L4 第 18 轮）：端口没接手时如实上报
    reportPersistFailure(
      "inbox.markAllRead",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知已读状态未更新",
    );
  },

  archive(id: string): void {
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current !== undefined) {
      if (current === null || current.archived === 1) return;
      domainWrite(TABLE, [inboxToWire({ ...current, archived: 1 })], {
        mode: "replace",
        scope: "inbox.archive",
        note: "通知未归档",
      });
      return;
    }
    // **旧库更新已删除**（L4 第 18 轮）：端口没接手时如实上报
    reportPersistFailure(
      "inbox.archive",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知归档状态未更新",
    );
  },

  delete(id: string): void {
    if (domainDelete(TABLE, { id }, { scope: "inbox.delete", note: "通知未删除" })) return;
    // **旧库删除已删除**（L4 第 18 轮）：端口没接手时如实上报，绝不静默当成删成功
    reportPersistFailure(
      "inbox.delete",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知未删除",
    );
  },

  getUnreadCount(projectId?: string): number {
    const rust = domainReadMany(TABLE, wireToInbox, { read: 0, archived: 0 });
    if (rust) {
      return rust.filter(
        (r) => !projectId || r.project_id === projectId || r.project_id === null,
      ).length;
    }
    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果（0 条未读）
    return 0;
  },

  deleteOlderThan(timestamp: number): void {
    const removed = domainDeleteWhere(
      TABLE,
      (row) => Number(row.created_at) < timestamp,
      "id",
      { scope: "inbox.deleteOlderThan", note: "过期通知未删除" },
    );
    if (removed !== null) return;
    // **旧库删除已删除**（L4 第 18 轮）：端口没接手时如实上报
    reportPersistFailure(
      "inbox.deleteOlderThan",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "过期通知未清理",
    );
  },
};
