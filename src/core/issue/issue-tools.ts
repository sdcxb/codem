/**
 * Issue Tools — LLM 工具注册
 *
 * 四个工具：
 * 1. issue_create — 创建 Issue
 * 2. issue_update — 更新 Issue 状态/分配
 * 3. issue_comment — 在 Issue 上评论
 * 4. issue_list — 列出当前项目的 Issue
 */

import type { ToolDef } from "../llm/tools";
import { getIssueManager } from "./issue";
import { useProjectStore } from "../store";
import { getLang } from "../i18n/lang";
import type { IssueStatus, IssuePriority } from "./issue-storage";

// ========== 1. issue_create ==========

export function createIssueCreateTool(): ToolDef {
  return {
    id: "issue_create",
  guidance: "Use issue_create to create a new issue in the issue tracker.",
    description:
      "Create a new issue (structured task) with a title, description, and optional assignee. " +
      "Issues are persistent work items that can be assigned to agents, squads, or users. " +
      "Returns the issue ID.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the issue" },
        description: { type: "string", description: "Detailed description including requirements and acceptance criteria" },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Priority level (default: normal)",
        },
        assignee_type: {
          type: "string",
          enum: ["user", "agent", "squad"],
          description: "Type of assignee (optional)",
        },
        assignee_id: {
          type: "string",
          description: "ID of the assignee (agent ID or squad ID, depending on assignee_type)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels for categorization (optional)",
        },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const mgr = getIssueManager();
      const projectId = useProjectStore.getState().currentProject?.id;

      // 无当前项目时不创建：否则会写入 project_id = NULL 的孤儿 Issue，
      // 而 UI 按 project_id 过滤（IssueStorage.listAll），用户永远看不到它。
      if (!projectId) {
        return {
          title: "issue_create",
          output: zh
            ? "尚未选择项目，无法创建 Issue（Issue 必须归属到某个项目）。请先在侧栏选择或新建项目。"
            : "No project selected — issues are project-scoped. Select or create a project first.",
        };
      }

      const issue = mgr.create({
        title: args.title as string,
        description: args.description as string | undefined,
        priority: args.priority as IssuePriority | undefined,
        assigneeType: args.assignee_type as any | undefined,
        assigneeId: args.assignee_id as string | undefined,
        projectId,
        labels: args.labels as string[] | undefined,
      });

      // Auto-transition if assigned
      if (issue.assigneeId) {
        mgr.transitionOnAssign(issue.id);
      }

      return {
        title: `issue_create: ${issue.title}`,
        output:
          (zh ? "Issue 已创建" : "Issue created") +
          `\nID: ${issue.id}` +
          `\nTitle: ${issue.title}` +
          `\nStatus: ${issue.status}` +
          `\nPriority: ${issue.priority}` +
          (issue.assigneeId ? `\nAssignee: ${issue.assigneeType}/${issue.assigneeId}` : ""),
        metadata: { issueId: issue.id },
      };
    },
  };
}

// ========== 2. issue_update ==========

export function createIssueUpdateTool(): ToolDef {
  return {
    id: "issue_update",
  guidance: "Use issue_update to modify an existing issue (status, assignee, labels, etc.).",
    description:
      "Update an issue's status, priority, assignee, or description. " +
      "Common status transitions: todo → in_progress → in_review → done. " +
      "Use issue_list to find issue IDs.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "The issue ID to update" },
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
          description: "New status (optional)",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "New priority (optional)",
        },
        assignee_type: {
          type: "string",
          enum: ["user", "agent", "squad"],
          description: "New assignee type (optional)",
        },
        assignee_id: { type: "string", description: "New assignee ID (optional)" },
        title: { type: "string", description: "New title (optional)" },
        description: { type: "string", description: "New description (optional)" },
      },
      required: ["issue_id"],
    },
    async execute(args, _ctx) {
      const zh = getLang() === "zh";
      const mgr = getIssueManager();
      const issueId = args.issue_id as string;

      const issue = mgr.get(issueId);
      if (!issue) {
        return { title: "issue_update", output: (zh ? "错误: Issue 不存在" : "Error: Issue not found") };
      }

      // 校验枚举：非法 status/priority 会让 UI 的 STATUS_CONFIG[status] 取到 undefined
      // 并在渲染时抛错（IssueCard / IssueDetailPanel），必须在这里拦掉。
      const VALID_STATUS = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
      const VALID_PRIORITY = ["low", "normal", "high", "urgent"];
      const nextStatus = args.status as string | undefined;
      const nextPriority = args.priority as string | undefined;
      if (nextStatus !== undefined && !VALID_STATUS.includes(nextStatus)) {
        return {
          title: "issue_update",
          output: (zh ? "错误: 非法 status（可选值: " : "Error: invalid status (allowed: ") + VALID_STATUS.join(", ") + ")",
        };
      }
      if (nextPriority !== undefined && !VALID_PRIORITY.includes(nextPriority)) {
        return {
          title: "issue_update",
          output: (zh ? "错误: 非法 priority（可选值: " : "Error: invalid priority (allowed: ") + VALID_PRIORITY.join(", ") + ")",
        };
      }

      mgr.update(issueId, {
        status: nextStatus as IssueStatus | undefined,
        priority: nextPriority as IssuePriority | undefined,
        assigneeType: args.assignee_type as any | undefined,
        assigneeId: args.assignee_id as string | undefined,
        title: args.title as string | undefined,
        description: args.description as string | undefined,
      });

      return {
        title: `issue_update: ${issue.title}`,
        output: (zh ? "Issue 已更新" : "Issue updated") + `\nID: ${issueId}` + (args.status ? `\nNew status: ${args.status}` : ""),
      };
    },
  };
}

// ========== 3. issue_comment ==========

export function createIssueCommentTool(): ToolDef {
  return {
    id: "issue_comment",
  guidance: "Use issue_comment to add a comment to an existing issue.",
    description:
      "Add a comment to an issue. Comments are visible to all participants. " +
      "Agents should use this to report progress, ask questions, or share results. " +
      "System comments (status changes, assignment changes) are added automatically.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "The issue ID to comment on" },
        content: { type: "string", description: "Comment content" },
      },
      required: ["issue_id", "content"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const mgr = getIssueManager();
      const issueId = args.issue_id as string;
      const content = args.content as string;

      const issue = mgr.get(issueId);
      if (!issue) {
        return { title: "issue_comment", output: (zh ? "错误: Issue 不存在" : "Error: Issue not found") };
      }

      mgr.addComment(issueId, {
        authorType: "agent",
        authorId: ctx.sessionId,
        authorName: "Agent",
        content,
      });

      return {
        title: `issue_comment: ${issue.title}`,
        output: (zh ? "评论已添加" : "Comment added") + `\nIssue: ${issueId}\nContent: ${content.substring(0, 200)}`,
      };
    },
  };
}

// ========== 4. issue_list ==========

export function createIssueListTool(): ToolDef {
  return {
    id: "issue_list",
  guidance: "Use issue_list to list issues from the tracker, optionally filtered by status or assignee.",
    description:
      "List all issues in the current project. Optionally filter by status. " +
      "Returns issue ID, title, status, priority, and assignee for each issue.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
          description: "Filter by status (optional)",
        },
      },
      required: [],
    },
    async execute(args, _ctx) {
      const zh = getLang() === "zh";
      const mgr = getIssueManager();
      const projectId = useProjectStore.getState().currentProject?.id;

      // 无当前项目时不查库：IssueStorage.listAll 在 projectId 为空时会退化成全库查询，
      // 把其它项目的 Issue 也返回给模型（与工具描述 "in the current project" 矛盾）。
      if (!projectId) {
        return {
          title: "issue_list",
          output: zh
            ? "尚未选择项目，无法列出 Issue。请先在侧栏选择或新建项目。"
            : "No project selected — issues are project-scoped. Select or create a project first.",
        };
      }

      const issues = mgr.list({
        projectId,
        status: args.status as IssueStatus | undefined,
      });

      if (issues.length === 0) {
        return {
          title: "issue_list",
          output: zh ? "当前项目暂无 Issue。" : "No issues found in the current project.",
        };
      }

      const lines: string[] = [];
      lines.push(zh ? `找到 ${issues.length} 个 Issue:` : `Found ${issues.length} issue(s):`);
      lines.push("");

      const statusIcons: Record<string, string> = {
        backlog: "○", todo: "○", in_progress: "◐", in_review: "◑", done: "●", blocked: "✕", cancelled: "—",
      };

      for (const issue of issues) {
        const icon = statusIcons[issue.status] || "?";
        const assignee = issue.assigneeId ? ` @${issue.assigneeType}/${issue.assigneeId}` : "";
        lines.push(`${icon} ${issue.id} | ${issue.title} | ${issue.status} | ${issue.priority}${assignee}`);
      }

      return { title: `issue_list: ${issues.length} issue(s)`, output: lines.join("\n") };
    },
  };
}
