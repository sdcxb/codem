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

  list(filters?: { projectId?: string; unreadOnly?: boolean; category?: InboxCategory }): InboxItem[] {
    return InboxStorage.listAll(filters).map(rowToItem);
  }

  markRead(id: string): void {
    InboxStorage.markRead(id);
    this.notify();
  }

  markAllRead(projectId?: string): void {
    InboxStorage.markAllRead(projectId);
    this.notify();
  }

  archive(id: string): void {
    InboxStorage.archive(id);
    this.notify();
  }

  getUnreadCount(projectId?: string): number {
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
