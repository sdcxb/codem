/**
 * Inbox Manager — 全局通知聚合中心
 *
 * 聚合来源：Issue 状态变更、委派完成/失败、子智能体完成、自动化触发、Squad 事件。
 * 对标 Multica Inbox：只给用户看，Agent 不读 Inbox。
 */

import { InboxStorage, type InboxRow, type InboxCategory, type InboxPriority } from "./inbox-storage";

export type { InboxCategory, InboxPriority };

// ========== Types ==========

export interface InboxItem {
  id: string;
  category: InboxCategory;
  title: string;
  body: string | null;
  sourceType: string | null;
  sourceId: string | null;
  projectId: string | null;
  squadId: string | null;
  issueId: string | null;
  priority: InboxPriority;
  read: boolean;
  archived: boolean;
  createdAt: number;
}

export type InboxListener = () => void;

// ========== InboxManager ==========

class InboxManagerClass {
  private listeners: Set<InboxListener> = new Set();

  add(params: {
    category: InboxCategory;
    title: string;
    body?: string;
    sourceType?: string;
    sourceId?: string;
    projectId?: string;
    squadId?: string;
    issueId?: string;
    priority?: InboxPriority;
  }): InboxItem {
    const id = `inbox-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const row = InboxStorage.create({
      id,
      category: params.category,
      title: params.title,
      body: params.body ?? null,
      source_type: params.sourceType ?? null,
      source_id: params.sourceId ?? null,
      project_id: params.projectId ?? null,
      squad_id: params.squadId ?? null,
      issue_id: params.issueId ?? null,
      priority: params.priority || "normal",
    });
    this.notify();
    return rowToItem(row);
  }

  /**
   * 列出通知。
   *
   * `includeArchived`（第 44 轮）：归档原来是**不可逆且看不见**的 ——
   * `archive()` 只写 `archived = 1`，而这个读路径**恒传** `archived: 0`，
   * 界面上的"归档"按钮因此等价于永久删除（提示"归档"却再也找不回来）。
   * 现在给出显式开关（**默认行为一个字没变**：仍然只列未归档）。
   *
   * `projectId`（第 72 轮）：**三态**，语义见 `InboxStorage.listAll` 的长注释 ——
   * `undefined` 不设边界 / `null` 只要全局通知 / 字符串 = 该项目 + 全局。
   */
  list(filters?: {
    projectId?: string | null;
    unreadOnly?: boolean;
    category?: InboxCategory;
    includeArchived?: boolean;
  }): InboxItem[] {
    return InboxStorage.listAll(filters).map(rowToItem);
  }

  markRead(id: string): void {
    InboxStorage.markRead(id);
    this.notify();
  }

  markAllRead(projectId?: string | null): void {
    InboxStorage.markAllRead(projectId);
    this.notify();
  }

  archive(id: string): void {
    InboxStorage.archive(id);
    this.notify();
  }

  /**
   * 取消归档（恢复）。返回 `false` = 写入未被接受（存储未就绪 / 该行不存在），
   * **调用方必须如实提示**，不能当成恢复成功。
   */
  unarchive(id: string): boolean {
    const ok = InboxStorage.unarchive(id);
    if (ok) this.notify();
    return ok;
  }

  /** 未读数。`projectId` 三态语义与 `list` 一致（否则徽标与列表会各说各话）。 */
  getUnreadCount(projectId?: string | null): number {
    return InboxStorage.getUnreadCount(projectId);
  }

  onInboxChange(listener: InboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

// ========== Singleton ==========

let instance: InboxManagerClass | null = null;

export function getInboxManager(): InboxManagerClass {
  if (!instance) instance = new InboxManagerClass();
  return instance;
}

// ========== Helpers ==========

function rowToItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    category: row.category as InboxCategory,
    title: row.title,
    body: row.body,
    sourceType: row.source_type,
    sourceId: row.source_id,
    projectId: row.project_id,
    squadId: row.squad_id,
    issueId: row.issue_id,
    priority: row.priority as InboxPriority,
    read: row.read === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
  };
}
