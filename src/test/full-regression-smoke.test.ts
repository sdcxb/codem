/**
 * 全量冒烟测试 — 今天所有改动的完整验证
 *
 * 覆盖范围：
 * 1. 数据层：DB schema（5 张新表）、Storage CRUD
 * 2. 工具层：7 个新 LLM 工具的 schema + 参数 + 注册
 * 3. 事件链：Inbox 填充、Issue 状态触发器、Squad dispatch 事件
 * 4. UI 入口：TaskCenter 8 Tab、Sidebar 变更、TopNavbar 变更、AgentManager 变更
 * 5. 类型完整性：SystemPromptConfig、DelegationTask、AutomationTrigger 扩展
 * 6. 死代码清除验证：DelegationPanel/AutomationSettingsSection/onAutomations 已移除
 * 7. 回归测试：现有核心功能不受影响
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), "utf-8");
}

// ========== 引擎侧 schema 真源（第 18 轮，L1 收尾） ==========
//
// 本文件原来把 `core/storage/database.ts`（sql.js 引擎模块）当 **schema 目录**读：
// `readFile("core/storage/database.ts")` + `toContain("CREATE TABLE IF NOT EXISTS …")`。
// 那个模块已随引擎删除 —— 引擎建库时真正执行的 DDL 是 `src-tauri/codem-db/sql/schema.sql`
// （`src-tauri/codem-db/src/schema.rs` 用 `include_str!` 编译进引擎，`apply()` 一次
// `execute_batch`；渲染进程不再持有 schema）。所以表 / 列 / 索引断言的**真源换成它**，
// 断言的表名列名一字不改（强度不变）。

/** 引擎建库执行的 DDL（`codem-db` 侧 `schema.rs` 读的就是它） */
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/codem-db/sql/schema.sql"),
  "utf-8",
);

/** 该表是否在引擎 schema 里声明（等价于旧库那一次 `sqlite_master` 查询） */
function schemaDeclaresTable(table: string): boolean {
  return new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`).test(SCHEMA_SQL);
}

// ========== 1. 数据层：DB Schema ==========

describe("数据层 — DB Schema", () => {
  it("squads 表已创建", () => {
    expect(schemaDeclaresTable("squads"), "引擎 schema 必须声明 squads").toBe(true);
    expect(SCHEMA_SQL).toContain("leader_agent_id TEXT NOT NULL");
  });

  it("squad_members 表已创建 + 外键", () => {
    expect(schemaDeclaresTable("squad_members"), "引擎 schema 必须声明 squad_members").toBe(true);
    expect(SCHEMA_SQL).toContain("FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE");
  });

  it("issues 表已创建 + 7 种状态字段", () => {
    expect(schemaDeclaresTable("issues"), "引擎 schema 必须声明 issues").toBe(true);
    expect(SCHEMA_SQL).toContain("status TEXT NOT NULL DEFAULT 'todo'");
    expect(SCHEMA_SQL).toContain("priority TEXT DEFAULT 'normal'");
  });

  it("issue_comments 表已创建 + 外键", () => {
    expect(schemaDeclaresTable("issue_comments"), "引擎 schema 必须声明 issue_comments").toBe(true);
    expect(SCHEMA_SQL).toContain("FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE");
  });

  it("inbox 表已创建 + 未读/归档字段", () => {
    expect(schemaDeclaresTable("inbox"), "引擎 schema 必须声明 inbox").toBe(true);
    expect(SCHEMA_SQL).toContain("read INTEGER DEFAULT 0");
    expect(SCHEMA_SQL).toContain("archived INTEGER DEFAULT 0");
  });

  it("所有索引已创建", () => {
    expect(SCHEMA_SQL).toContain("idx_squad_members_squad");
    expect(SCHEMA_SQL).toContain("idx_issues_project");
    expect(SCHEMA_SQL).toContain("idx_issues_status");
    expect(SCHEMA_SQL).toContain("idx_issues_squad");
    expect(SCHEMA_SQL).toContain("idx_issue_comments_issue");
    expect(SCHEMA_SQL).toContain("idx_inbox_read");
    expect(SCHEMA_SQL).toContain("idx_inbox_project");
    expect(SCHEMA_SQL).toContain("idx_inbox_created");
  });
});

// ========== 2. 工具层：LLM 工具 ==========

describe("工具层 — LLM 工具注册", () => {
  const engineSource = readFile("core/llm/index.ts");

  it("Squad 工具 (3 个) 已在 LLMEngine 中注册", () => {
    expect(engineSource).toContain("createSquadListTool");
    expect(engineSource).toContain("createSquadDispatchTool");
    expect(engineSource).toContain("createSquadStatusTool");
  });

  it("Issue 工具 (4 个) 已在 LLMEngine 中注册", () => {
    expect(engineSource).toContain("createIssueCreateTool");
    expect(engineSource).toContain("createIssueUpdateTool");
    expect(engineSource).toContain("createIssueCommentTool");
    expect(engineSource).toContain("createIssueListTool");
  });
});

describe("工具层 — 工具 Schema 验证", () => {
  it("squad_dispatch — required 参数包含 squad_id + task", async () => {
    const { createSquadDispatchTool } = await import("../core/squad/squad-tools");
    const tool = createSquadDispatchTool();
    const params = tool.parameters as any;
    expect(params.required).toContain("squad_id");
    expect(params.required).toContain("task");
    expect(params.properties.squad_id.type).toBe("string");
    expect(params.properties.task.type).toBe("string");
  });

  it("issue_create — required 参数包含 title", async () => {
    const { createIssueCreateTool } = await import("../core/issue/issue-tools");
    const tool = createIssueCreateTool();
    const params = tool.parameters as any;
    expect(params.required).toContain("title");
    expect(params.properties.title.type).toBe("string");
    expect(params.properties.priority.enum).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("issue_update — required 参数包含 issue_id", async () => {
    const { createIssueUpdateTool } = await import("../core/issue/issue-tools");
    const tool = createIssueUpdateTool();
    const params = tool.parameters as any;
    expect(params.required).toContain("issue_id");
    expect(params.properties.status.enum).toContain("done");
    expect(params.properties.status.enum).toContain("blocked");
  });

  it("issue_comment — required 参数包含 issue_id + content", async () => {
    const { createIssueCommentTool } = await import("../core/issue/issue-tools");
    const tool = createIssueCommentTool();
    const params = tool.parameters as any;
    expect(params.required).toContain("issue_id");
    expect(params.required).toContain("content");
  });

  it("所有工具都有 execute 函数", async () => {
    const squadTools = await import("../core/squad/squad-tools");
    const issueTools = await import("../core/issue/issue-tools");
    const toolFns = [
      squadTools.createSquadListTool,
      squadTools.createSquadDispatchTool,
      squadTools.createSquadStatusTool,
      issueTools.createIssueCreateTool,
      issueTools.createIssueUpdateTool,
      issueTools.createIssueCommentTool,
      issueTools.createIssueListTool,
    ];
    for (const fn of toolFns) {
      const tool = fn();
      expect(tool.execute).toBeTypeOf("function");
      expect(tool.id).toBeTypeOf("string");
      expect(tool.description).toBeTypeOf("string");
    }
  });
});

// ========== 3. 事件链：Inbox 填充 ==========

describe("事件链 — Inbox 通知填充", () => {
  it("orchestrator completeTask 调用 getInboxManager().add()", () => {
    const source = readFile("core/session/orchestrator.ts");
    expect(source).toContain("getInboxManager");
    // Verify completeTask has inbox write
    expect(source).toMatch(/completeTask.*getInboxManager.*add/s);
  });

  it("orchestrator failTask 调用 getInboxManager().add()", () => {
    const source = readFile("core/session/orchestrator.ts");
    expect(source).toMatch(/failTask.*getInboxManager.*add/s);
  });

  it("issue.ts status change 调用 getInboxManager().add()", () => {
    const source = readFile("core/issue/issue.ts");
    expect(source).toContain("getInboxManager");
    expect(source).toContain("category: \"issue\"");
  });

  it("automation-manager.ts TimerEngine fire 调用 getInboxManager().add()", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("getInboxManager");
    expect(source).toContain("category: \"automation\"");
  });

  it("automation-manager.ts FileWatchEngine 调用 getInboxManager().add()", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("文件监听触发");
  });

  it("automation-manager.ts CronEngine 调用 getInboxManager().add()", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("Cron 触发");
  });

  it("automation-manager.ts IssueStatusEngine 调用 getInboxManager().add()", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("Issue 触发自动化");
  });

  it("InboxManager — getInboxManager 返回单例", async () => {
    const { getInboxManager } = await import("../core/inbox/inbox");
    expect(getInboxManager()).toBe(getInboxManager());
  });

  it("InboxManager — getUnreadCount 返回数字", async () => {
    const { getInboxManager } = await import("../core/inbox/inbox");
    const count = getInboxManager().getUnreadCount();
    expect(typeof count).toBe("number");
  });

  it("InboxManager — onInboxChange 返回 unsubscribe 函数", async () => {
    const { getInboxManager } = await import("../core/inbox/inbox");
    const unsub = getInboxManager().onInboxChange(() => {});
    expect(unsub).toBeTypeOf("function");
    unsub();
  });
});

// ========== 3b. 事件链：Issue 状态触发器 ==========

describe("事件链 — Issue 状态触发器", () => {
  it("issue.ts 调用 notifyIssueStatusChange", () => {
    const source = readFile("core/issue/issue.ts");
    expect(source).toContain("notifyIssueStatusChange");
  });

  it("automation-manager.ts 导出 notifyIssueStatusChange", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("export function notifyIssueStatusChange");
  });

  it("automation-manager.ts IssueStatusEngine 有 notifyStatusChange 方法", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("notifyStatusChange(issueId");
  });

  it("AutomationTrigger 支持 issue_status 类型", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("\"issue_status\"");
    expect(source).toContain("issueStatusFilter");
    expect(source).toContain("issueProjectId");
  });
});

// ========== 3c. 事件链：Squad dispatch（B 深合并：已桥接 agent-teams） ==========

describe("事件链 — Squad dispatch（深合并为 agent-teams）", () => {
  it("squad-tools.ts 不再通过 CustomEvent 派发（改桥接 agent-teams 运行时）", () => {
    const source = readFile("core/squad/squad-tools.ts");
    expect(source).not.toContain("window.dispatchEvent");
    expect(source).not.toContain("codem-squad-dispatch");
    expect(source).toContain("AgentTeamsService");
    expect(source).toContain("svc.create");
  });

  it("App.tsx 不再监听 codem-squad-dispatch 事件（路由已随桥接删除）", () => {
    const source = readFile("App.tsx");
    expect(source).not.toContain("codem-squad-dispatch");
    expect(source).not.toContain("handleSquadDispatch");
  });

  it("squad-tools.ts 保留 toTeamTemplate 模板导出供建队", () => {
    const source = readFile("core/squad/squad-tools.ts");
    expect(source).toContain("toTeamTemplate");
  });

  it("__pendingSquadDispatch 死代码已清除", () => {
    const source = readFile("core/squad/squad-tools.ts");
    expect(source).not.toContain("__pendingSquadDispatch");
  });
});

// ========== 4. UI 入口验证 ==========

describe("UI 入口 — TaskCenter 8 Tab 全部可用", () => {
  const tcSource = readFile("components/TaskCenter.tsx");

  const tabs = [
    { id: "overview", label: "OverviewTab" },
    { id: "issues", label: "IssuesTab" },
    { id: "board", label: "BoardTab" },
    { id: "teams", label: "TeamTab" },
    { id: "delegation", label: "DelegationTab" },
    { id: "subagents", label: "SubagentsTab" },
    { id: "automation", label: "AutomationTab" },
    { id: "inbox", label: "InboxTab" },
  ];

  for (const tab of tabs) {
    it(`Tab "${tab.id}" — import ${tab.label}`, () => {
      expect(tcSource).toContain(tab.label);
    });

    it(`Tab "${tab.id}" — available: true`, () => {
      expect(tcSource).toContain(`"${tab.id}"`);
    });

    it(`Tab "${tab.id}" — 渲染条件存在`, () => {
      expect(tcSource).toContain(`activeTab === "${tab.id}"`);
    });
  }
});

describe("UI 入口 — Sidebar 变更", () => {
  const sidebarSource = readFile("components/Sidebar.tsx");

  it("onAutomations prop 已移除", () => {
    expect(sidebarSource).not.toContain("onAutomations?:");
  });

  it("onDelegation prop 已移除", () => {
    expect(sidebarSource).not.toContain("onDelegation?:");
  });

  it("onAgents prop 已添加", () => {
    expect(sidebarSource).toContain("onAgents?:");
  });

  it("Inbox 未读计数 useEffect 存在", () => {
    expect(sidebarSource).toContain("getInboxManager");
    expect(sidebarSource).toContain("inboxUnread");
  });

  it("Inbox 未读 badge 渲染存在（展开态）", () => {
    // v1.16.0 UI 统一：徽标底色改用语义令牌（原先硬编码 #ef4444）
    expect(sidebarSource).toMatch(/var\(--error[^)]*\)/);
    expect(sidebarSource).toContain("inboxUnread > 0");
  });

  it("Agents 工具栏按钮存在", () => {
    expect(sidebarSource).toContain("onAgents");
    expect(sidebarSource).toContain("智能体");
  });

  it("Bot 图标已 import", () => {
    expect(sidebarSource).toContain("Bot");
  });
});

describe("UI 入口 — TopNavbar 变更", () => {
  const navSource = readFile("components/TopNavbar.tsx");

  it("onAutomations prop 已移除", () => {
    expect(navSource).not.toContain("onAutomations?:");
  });

  it("tasks 标签改为'项目'/Projects", () => {
    expect(navSource).toContain("项目");
    expect(navSource).toContain("Projects");
  });

  it("不再有两个 Tasks 入口（tasks 改为 Projects）", () => {
    // taskcenter 保留 Tasks 标签是合理的，但 tasks 不应该再是 Tasks
    const navSource = readFile("components/TopNavbar.tsx");
    const tasksLine = navSource.match(/id: "tasks".*label:.*"([^"]*)"/);
    expect(tasksLine).toBeTruthy();
    expect(tasksLine![1]).not.toBe("Tasks");
  });
});

describe("UI 入口 — HubLayout 清理", () => {
  const hubSource = readFile("components/HubLayout.tsx");

  it("onAutomations 不再传递给 TopNavbar", () => {
    expect(hubSource).not.toContain("onAutomations");
  });
});

describe("UI 入口 — AgentManager 变更", () => {
  const amSource = readFile("components/AgentManager.tsx");

  it("Agent 图标已通过 icon-map 引用", () => {
    // 架构变更：lucide-react 直接 import → icon-map.ts 集中映射
    expect(amSource).toContain("PanelIcons.agent");
  });

  it("不再使用 emoji (🤖🦸✅❌)", () => {
    expect(amSource).not.toContain("🤖");
    expect(amSource).not.toContain("🦸");
    expect(amSource).not.toContain("✅");
    expect(amSource).not.toContain("❌");
  });

  it("Squad Leader 适配复选框存在", () => {
    expect(amSource).toContain("Squad Leader");
  });
});

describe("UI 入口 — App.tsx AgentManager 弹窗", () => {
  const appSource = readFile("App.tsx");

  it("AgentManager 已 import", () => {
    expect(appSource).toContain("import { AgentManager }");
  });

  it("showAgentManager state 存在", () => {
    expect(appSource).toContain("showAgentManager");
  });

  it("onAgents 传给 Sidebar", () => {
    expect(appSource).toContain("onAgents={()");
  });

  it("AgentManager 弹窗 render 存在", () => {
    expect(appSource).toContain("{showAgentManager &&");
  });
});

// ========== 5. 类型完整性 ==========

describe("类型完整性 — 扩展字段", () => {
  it("SystemPromptConfig 包含 squadRoster", () => {
    const source = readFile("core/prompt/prompt.ts");
    expect(source).toContain("squadRoster?: string");
    expect(source).toContain("config.squadRoster");
  });

  it("DelegationTask 包含 squadId 和 memberId", () => {
    const source = readFile("core/session/types.ts");
    expect(source).toContain("squadId?: string");
    expect(source).toContain("memberId?: string");
  });

  it("AutomationTrigger 包含 cronExpression + issueStatusFilter", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("cronExpression?: string");
    expect(source).toContain("issueStatusFilter?: string");
  });

  it("CostTracker 包含 getSquadCost 方法", () => {
    const source = readFile("core/llm/cost-tracker.ts");
    expect(source).toContain("getSquadCost(");
    expect(source).toContain("totalInputTokens");
    expect(source).toContain("totalOutputTokens");
  });

  it("Worktree maxWorktrees 从 15 调整为 30", () => {
    const source = readFile("core/environment/worktree-manager.ts");
    expect(source).toContain("maxWorktrees: 30");
    expect(source).not.toContain("maxWorktrees: 15");
  });
});

// ========== 6. 死代码清除验证 ==========

describe("死代码清除", () => {
  it("App.tsx 不再 import DelegationPanel", () => {
    const source = readFile("App.tsx");
    expect(source).not.toContain("import { DelegationPanel }");
  });

  it("App.tsx 不再有 showDelegationPanel state", () => {
    const source = readFile("App.tsx");
    expect(source).not.toContain("showDelegationPanel");
  });

  it("App.tsx 不再有 DelegationPanel render block", () => {
    const source = readFile("App.tsx");
    // 排除注释行后检查是否还有 DelegationPanel 引用
    const lines = source.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*'));
    const nonCommentCode = lines.join('\n');
    expect(nonCommentCode).not.toContain("DelegationPanel");
  });

  it("SettingsPanel 不再有 AutomationSettingsSection 函数定义", () => {
    const source = readFile("components/SettingsPanel.tsx");
    expect(source).not.toContain("function AutomationSettingsSection");
  });

  it("SettingsPanel automation tab 显示跳转提示", () => {
    const source = readFile("components/SettingsPanel.tsx");
    expect(source).toContain("moved to Task Center");
  });

  it("squad-tools.ts 不再有 __pendingSquadDispatch", () => {
    const source = readFile("core/squad/squad-tools.ts");
    expect(source).not.toContain("__pendingSquadDispatch");
  });
});

// ========== 7. 回归测试 — 现有功能不受影响 ==========

describe("回归 — 核心工具注册不受影响", () => {
  it("createDefaultToolRegistry 仍注册所有核心工具", async () => {
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const registry = createDefaultToolRegistry();
    const toolIds = registry.getAll().map(t => t.id);
    expect(toolIds).toContain("bash");
    expect(toolIds).toContain("read");
    expect(toolIds).toContain("write");
    expect(toolIds).toContain("edit");
    expect(toolIds).toContain("multi_edit");
    expect(toolIds).toContain("glob");
    expect(toolIds).toContain("grep");
  });
});

describe("回归 — 委派工具仍可用", () => {
  it("delegate_to_session 工具 schema 正确", async () => {
    const { createDelegateToSessionTool } = await import("../core/session/tools");
    const tool = createDelegateToSessionTool();
    expect(tool.id).toBe("delegate_to_session");
    const params = tool.parameters as any;
    expect(params.required).toContain("target_session_id");
    expect(params.required).toContain("task");
  });

  it("wait_for_delegation 工具 schema 正确", async () => {
    const { createWaitForDelegationTool } = await import("../core/session/tools");
    const tool = createWaitForDelegationTool();
    expect(tool.id).toBe("wait_for_delegation");
  });

  it("list_sessions 工具 schema 正确", async () => {
    const { createListSessionsTool } = await import("../core/session/tools");
    const tool = createListSessionsTool();
    expect(tool.id).toBe("list_sessions");
  });
});

describe("回归 — Subagent 工具仍可用", () => {
  it("subagent 工具 schema 正确", async () => {
    const { createSubagentTool } = await import("../core/llm/tools/subagent-tools");
    const tool = createSubagentTool();
    expect(tool.id).toBe("subagent");
    expect(tool.parameters.required).toContain("description");
    expect(tool.parameters.required).toContain("prompt");
  });

  it("send_message 工具 schema 正确", async () => {
    const { createSendMessageTool } = await import("../core/llm/tools/subagent-tools");
    const tool = createSendMessageTool();
    expect(tool.id).toBe("send_message");
    expect(tool.parameters.required).toContain("subagent_id");
    expect(tool.parameters.required).toContain("message");
  });

  it("report 工具 schema 正确", async () => {
    const { createReportTool } = await import("../core/llm/tools/subagent-tools");
    const tool = createReportTool();
    expect(tool.id).toBe("report");
    expect(tool.parameters.required).toContain("output");
  });

  it("interrupt_agent 工具 schema 正确", async () => {
    const { createInterruptAgentTool } = await import("../core/llm/tools/subagent-tools");
    const tool = createInterruptAgentTool();
    expect(tool.id).toBe("interrupt_agent");
    expect(tool.parameters.required).toContain("agent_id");
  });

  it("list_agents 工具 schema 正确", async () => {
    const { createListAgentsTool } = await import("../core/llm/tools/subagent-tools");
    const tool = createListAgentsTool();
    expect(tool.id).toBe("list_agents");
  });
});

describe("回归 — Squad/Issue 管理器单例稳定", () => {
  it("SquadManager 单例稳定", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    expect(getSquadManager()).toBe(getSquadManager());
  });

  it("IssueManager 单例稳定", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    expect(getIssueManager()).toBe(getIssueManager());
  });

  it("InboxManager 单例稳定", async () => {
    const { getInboxManager } = await import("../core/inbox/inbox");
    expect(getInboxManager()).toBe(getInboxManager());
  });
});

describe("回归 — 监听器注册/注销", () => {
  it("SquadManager.onSquadChange 返回 unsubscribe", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    const unsub = getSquadManager().onSquadChange(() => {});
    expect(unsub).toBeTypeOf("function");
    unsub();
  });

  it("IssueManager.onIssueChange 返回 unsubscribe", async () => {
    const { getIssueManager } = await import("../core/issue/issue");
    const unsub = getIssueManager().onIssueChange(() => {});
    expect(unsub).toBeTypeOf("function");
    unsub();
  });

  it("InboxManager.onInboxChange 返回 unsubscribe", async () => {
    const { getInboxManager } = await import("../core/inbox/inbox");
    const unsub = getInboxManager().onInboxChange(() => {});
    expect(unsub).toBeTypeOf("function");
    unsub();
  });
});

describe("回归 — 自动化引擎", () => {
  const amSource = readFile("core/automation/automation-manager.ts");

  it("startAutomationEngines 包含 timerEngine + fileWatchEngine + cronEngine", () => {
    expect(amSource).toContain("timerEngine.start()");
    expect(amSource).toContain("fileWatchEngine.start()");
    expect(amSource).toContain("cronEngine.start()");
  });

  it("stopAutomationEngines 包含 timerEngine + fileWatchEngine + cronEngine", () => {
    expect(amSource).toContain("timerEngine.stopAll()");
    expect(amSource).toContain("fileWatchEngine.stopAll()");
    expect(amSource).toContain("cronEngine.stopAll()");
  });

  it("TriggerType 包含 4 种类型", () => {
    expect(amSource).toContain("\"file_watch\"");
    expect(amSource).toContain("\"timer\"");
    expect(amSource).toContain("\"cron\"");
    expect(amSource).toContain("\"issue_status\"");
  });
});

describe("回归 — Cron 解析", () => {
  it("parseCronField 通配符 * 返回全部值", () => {
    // Access the internal function through the module
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("function parseCronField");
    expect(source).toContain("function shouldFireCron");
  });

  it("shouldFireCron 要求 5 段格式", () => {
    const source = readFile("core/automation/automation-manager.ts");
    expect(source).toContain("parts.length !== 5");
  });
});

describe("回归 — Prompt 系统提示词不变", () => {
  it("buildSystemPrompt 函数仍存在", () => {
    const source = readFile("core/prompt/prompt.ts");
    expect(source).toContain("export function buildSystemPrompt");
  });

  it("SystemPromptConfig 仍包含所有原有字段", () => {
    const source = readFile("core/prompt/prompt.ts");
    expect(source).toContain("agent: AgentDefinition");
    expect(source).toContain("identity?");
    expect(source).toContain("gitConfig?");
    expect(source).toContain("knowledgeContext?");
  });
});

/**
 * ⚠️ **第 18 轮（L1 收尾）退休：「getDatabase 导出仍存在」与「initDatabase 导出仍存在」。**
 *
 * 这两条断言的是**旧引擎模块的导出**（`src/core/storage/database.ts`：sql.js 句柄 + 建库入口）。
 * 该模块已随引擎删除 —— 现在渲染进程通过**存储端口**访问引擎
 * （`src/core/storage/port.ts` 的 `getStoragePort()` / `setStoragePort()`），建库由 Rust 侧
 * `src-tauri/codem-db/src/schema.rs::apply()` 执行。再断言"这两个导出存在"等于要求
 * 一个被刻意删掉的模块复活，属于**只对旧引擎有意义**的断言 → 退休。
 *
 * 覆盖移交：
 * - "渲染进程不再持有整库 / 没有整库导出" → `db-contract.test.ts` **C7**
 *   （命令清单里没有 `db.export` / `export` / `backup` / `sql.raw`）+ **C1**（`caps.no_whole_file_export === true`）；
 * - "建库入口仍然存在且在跑" → 本文件下面的「原有表仍存在于引擎 schema」+ `db-contract.test.ts` **C24**
 *   （反复打开同一个库幂等：schema 不重复执行、不报错）+ **C25**（data 目录被删后能重建）；
 * - 端口 API 本身就是"新的 getDatabase"：见 `message-index-cutover.test.ts`（读写分流契约）。
 */
describe("回归 — 存储层不变", () => {
  it("原有表仍存在于引擎 schema (projects, sessions, messages, tool_calls)", () => {
    for (const table of ["projects", "sessions", "messages", "tool_calls"]) {
      expect(schemaDeclaresTable(table), `引擎 schema 必须声明 ${table}`).toBe(true);
    }
  });
});
