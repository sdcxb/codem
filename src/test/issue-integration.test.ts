/**
 * Issue 集成测试 — 验证 IssueManager + 工具定义 + DB schema
 */

import { describe, it, expect } from "vitest";

describe("Issue 工具定义", () => {
  it("issue_create 工具 — schema 正确", async () => {
    const { createIssueCreateTool } = await import("../core/issue/issue-tools");
    const tool = createIssueCreateTool();
    expect(tool.id).toBe("issue_create");
    expect(tool.parameters).toBeDefined();
    const params = tool.parameters as any;
    expect(params.properties.title).toBeDefined();
    expect(params.required).toContain("title");
  });

  it("issue_update 工具 — schema 正确", async () => {
    const { createIssueUpdateTool } = await import("../core/issue/issue-tools");
    const tool = createIssueUpdateTool();
    expect(tool.id).toBe("issue_update");
    const params = tool.parameters as any;
    expect(params.properties.issue_id).toBeDefined();
    expect(params.required).toContain("issue_id");
    expect(params.properties.status.enum).toContain("done");
  });

  it("issue_comment 工具 — schema 正确", async () => {
    const { createIssueCommentTool } = await import("../core/issue/issue-tools");
    const tool = createIssueCommentTool();
    expect(tool.id).toBe("issue_comment");
    const params = tool.parameters as any;
    expect(params.properties.issue_id).toBeDefined();
    expect(params.properties.content).toBeDefined();
    expect(params.required).toContain("issue_id");
    expect(params.required).toContain("content");
  });

  it("issue_list 工具 — schema 正确", async () => {
    const { createIssueListTool } = await import("../core/issue/issue-tools");
    const tool = createIssueListTool();
    expect(tool.id).toBe("issue_list");
    expect(tool.execute).toBeTypeOf("function");
  });
});

describe("Issue 类型完整性", () => {
  it("IssueManager — getIssueManager 返回单例", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const mgr1 = getIssueManager();
    const mgr2 = getIssueManager();
    expect(mgr1).toBe(mgr2);
  });

  it("IssueManager — list 返回数组", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const mgr = getIssueManager();
    const issues = mgr.list();
    expect(Array.isArray(issues)).toBe(true);
  });

  it("IssueManager — get 不存在的 issue 返回 null", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const mgr = getIssueManager();
    const issue = mgr.get("nonexistent-id");
    expect(issue).toBeNull();
  });

  it("IssueManager — onIssueChange 返回 unsubscribe 函数", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const mgr = getIssueManager();
    const unsub = mgr.onIssueChange(() => {});
    expect(unsub).toBeTypeOf("function");
    unsub();
  });

  it("IssueManager — getStats 返回所有状态", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const mgr = getIssueManager();
    const stats = mgr.getStats();
    expect(stats.backlog).toBeTypeOf("number");
    expect(stats.todo).toBeTypeOf("number");
    expect(stats.in_progress).toBeTypeOf("number");
    expect(stats.done).toBeTypeOf("number");
  });

  it("IssueManager — assignToSquad 对不存在的 issue 返回失败", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const mgr = getIssueManager();
    const result = mgr.assignToSquad("nonexistent", "nonexistent");
    expect(result.success).toBe(false);
  });
});

describe("Issue DB Schema", () => {
  it("issues 和 issue_comments 表在 SCHEMA 中定义", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dbSource = fs.readFileSync(
      path.join(__dirname, "../core/storage/database.ts"),
      "utf-8",
    );
    expect(dbSource).toContain("CREATE TABLE IF NOT EXISTS issues");
    expect(dbSource).toContain("CREATE TABLE IF NOT EXISTS issue_comments");
    expect(dbSource).toContain("idx_issues_project");
    expect(dbSource).toContain("idx_issues_status");
    expect(dbSource).toContain("idx_issues_squad");
    expect(dbSource).toContain("idx_issue_comments_issue");
  });
});

describe("Issue 工具已在 LLMEngine 中注册", () => {
  it("LLMEngine.setupDelegationTools 包含 issue 工具注册", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const engineSource = fs.readFileSync(
      path.join(__dirname, "../core/llm/index.ts"),
      "utf-8",
    );
    expect(engineSource).toContain("createIssueCreateTool");
    expect(engineSource).toContain("createIssueUpdateTool");
    expect(engineSource).toContain("createIssueCommentTool");
    expect(engineSource).toContain("createIssueListTool");
  });
});

describe("TaskCenter 包含 Issues 和 Board Tab", () => {
  it("TaskCenter 导入并渲染 IssuesTab 和 BoardTab", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const tcSource = fs.readFileSync(
      path.join(__dirname, "../components/TaskCenter.tsx"),
      "utf-8",
    );
    expect(tcSource).toContain("IssuesTab");
    expect(tcSource).toContain("BoardTab");
    expect(tcSource).toContain("available: true");
  });
});
