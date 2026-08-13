/**
 * Issue Manager — 结构化任务追踪
 *
 * 核心职责：
 * 1. 管理 Issue 生命周期（创建/编辑/删除/状态流转）
 * 2. 管理 Issue 评论（人类 + agent 都可以评论）
 * 3. 与 Squad 集成：Issue 可分配给 Squad
 * 4. 状态自动流转：分配给 agent/squad 后自动 in_progress
 */

import {
  IssueStorage,
  type IssueRow,
  type IssueCommentRow,
  type IssueStatus,
  type IssuePriority,
  type AssigneeType,
} from "./issue-storage";
import { getSquadManager } from "../squad/squad";
import { notifyIssueStatusChange } from "../automation/automation-manager";
import { getInboxManager } from "../inbox/inbox";

// ========== Types ==========

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  projectId: string | null;
  squadId: string | null;
  sessionId: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
}

export interface IssueComment {
  id: string;
  issueId: string;
  authorType: "user" | "agent" | "system";
  authorId: string | null;
  authorName: string | null;
  content: string;
  isSystem: boolean;
  createdAt: number;
}

export interface IssueWithComments extends Issue {
  comments: IssueComment[];
}

export type IssueListener = (issueId: string) => void;

// ========== Issue Manager ==========

class IssueManagerClass {
  private listeners: Set<IssueListener> = new Set();

  // ========== Issue CRUD ==========

  create(params: {
    title: string;
    description?: string;
    priority?: IssuePriority;
    assigneeType?: AssigneeType;
    assigneeId?: string;
    projectId?: string;
    squadId?: string;
    sessionId?: string;
    labels?: string[];
  }): Issue {
    const id = `issue-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const row = IssueStorage.create({
      id,
      title: params.title,
      description: params.description ?? null,
      status: "todo",
      priority: params.priority || "normal",
      assignee_type: params.assigneeType ?? null,
      assignee_id: params.assigneeId ?? null,
      project_id: params.projectId ?? null,
      squad_id: params.squadId ?? null,
      session_id: params.sessionId ?? null,
      labels: params.labels?.join(",") ?? null,
    });

    // Add system comment for creation
    IssueStorage.addComment({
      id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      issue_id: id,
      author_type: "system",
      author_id: null,
      author_name: "System",
      content: `Issue created: ${params.title}`,
      is_system: 1,
    });

    this.notify(id);
    return rowToIssue(row);
  }

  get(id: string): IssueWithComments | null {
    const row = IssueStorage.getById(id);
    if (!row) return null;
    const comments = IssueStorage.getComments(id).map(rowToComment);
    return { ...rowToIssue(row), comments };
  }

  list(filters?: { projectId?: string; status?: IssueStatus; squadId?: string; assigneeId?: string }): Issue[] {
    return IssueStorage.listAll(filters).map(rowToIssue);
  }

  update(id: string, updates: Partial<{
    title: string;
    description: string;
    status: IssueStatus;
    priority: IssuePriority;
    assigneeType: AssigneeType;
    assigneeId: string;
    squadId: string;
    sessionId: string;
    labels: string[];
  }>): void {
    const dbUpdates: any = {};
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.priority !== undefined) dbUpdates.priority = updates.priority;
    if (updates.assigneeType !== undefined) dbUpdates.assignee_type = updates.assigneeType;
    if (updates.assigneeId !== undefined) dbUpdates.assignee_id = updates.assigneeId;
    if (updates.squadId !== undefined) dbUpdates.squad_id = updates.squadId;
    if (updates.sessionId !== undefined) dbUpdates.session_id = updates.sessionId;
    if (updates.labels !== undefined) dbUpdates.labels = updates.labels.join(",");

    IssueStorage.update(id, dbUpdates);

    // Add system comment for status changes
    if (updates.status) {
      this.addSystemComment(id, `Status changed to: ${updates.status}`);
      // Notify automation engine of status change
      const issue = IssueStorage.getById(id);
      notifyIssueStatusChange(id, updates.status, issue?.project_id ?? null);
      // Write to Inbox
      try {
        getInboxManager().add({
          category: "issue",
          title: `Issue 状态变更: ${issue?.title || id}`,
          body: `状态 → ${updates.status}`,
          sourceType: "issue",
          sourceId: id,
          projectId: issue?.project_id ?? undefined,
          issueId: id,
          priority: updates.status === "blocked" ? "high" : "normal",
        });
      } catch {}
    }
    if (updates.assigneeId !== undefined) {
      this.addSystemComment(id, `Assignee changed to: ${updates.assigneeId || "unassigned"}`);
    }

    this.notify(id);
  }

  delete(id: string): void {
    IssueStorage.delete(id);
    this.notify(id);
  }

  // ========== Comments ==========

  addComment(issueId: string, params: {
    authorType: "user" | "agent";
    authorId?: string;
    authorName?: string;
    content: string;
  }): IssueComment {
    const row = IssueStorage.addComment({
      id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      issue_id: issueId,
      author_type: params.authorType,
      author_id: params.authorId ?? null,
      author_name: params.authorName ?? null,
      content: params.content,
      is_system: 0,
    });
    this.notify(issueId);
    return rowToComment(row);
  }

  private addSystemComment(issueId: string, content: string): void {
    IssueStorage.addComment({
      id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      issue_id: issueId,
      author_type: "system",
      author_id: null,
      author_name: "System",
      content,
      is_system: 1,
    });
  }

  getComments(issueId: string): IssueComment[] {
    return IssueStorage.getComments(issueId).map(rowToComment);
  }

  // ========== Stats ==========

  getStats(projectId?: string): Record<IssueStatus, number> {
    return IssueStorage.getStats(projectId);
  }

  // ========== Squad Integration ==========

  /**
   * Assign an issue to a squad. This triggers the squad leader to process the issue.
   * Returns the squad dispatch result.
   */
  assignToSquad(issueId: string, squadId: string): { success: boolean; error?: string } {
    const issue = this.get(issueId);
    if (!issue) return { success: false, error: "Issue not found" };

    const squad = getSquadManager().getSquad(squadId);
    if (!squad) return { success: false, error: "Squad not found" };
    if (squad.archived) return { success: false, error: "Squad is archived" };

    // Update issue assignment
    this.update(issueId, {
      assigneeType: "squad",
      assigneeId: squadId,
      squadId,
      status: "in_progress",
    });

    return { success: true };
  }

  /**
   * Auto-transition issue status based on events.
   * - When assigned to agent/squad → in_progress
   * - When agent reports completion → in_review
   */
  transitionOnAssign(issueId: string): void {
    const issue = this.get(issueId);
    if (!issue) return;
    if (issue.status === "backlog" || issue.status === "todo") {
      this.update(issueId, { status: "in_progress" });
    }
  }

  transitionOnComplete(issueId: string): void {
    const issue = this.get(issueId);
    if (!issue) return;
    if (issue.status === "in_progress") {
      this.update(issueId, { status: "in_review" });
    }
  }

  // ========== Listeners ==========

  onIssueChange(listener: IssueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(issueId: string): void {
    this.listeners.forEach((l) => l(issueId));
  }
}

// ========== Singleton ==========

let instance: IssueManagerClass | null = null;

export function getIssueManager(): IssueManagerClass {
  if (!instance) instance = new IssueManagerClass();
  return instance;
}

// ========== Helpers ==========

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    assigneeType: row.assignee_type as AssigneeType | null,
    assigneeId: row.assignee_id,
    projectId: row.project_id,
    squadId: row.squad_id,
    sessionId: row.session_id,
    labels: row.labels ? row.labels.split(",").filter(Boolean) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToComment(row: IssueCommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    authorType: row.author_type as "user" | "agent" | "system",
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    isSystem: row.is_system === 1,
    createdAt: row.created_at,
  };
}
