/**
 * TC-AUDIT-2 — 任务管理第二轮审计修复回归（v1.14.0）
 *
 * 覆盖第二轮（独立子智能体）审计发现的宿主缺陷：
 * - P1-1  issue_create / issue_list 工具在无当前项目时跨项目串数据 / 建孤儿 Issue
 * - P1-2  未知 status 不再让 IssueCard / IssueDetailPanel 崩掉整个应用
 * - P2-3  详情面板点「当前状态」不写假的状态变更评论 + 收件箱通知
 * - P2-4  自动化「停止所有」状态跨页签一致，暂停期间 refresh 不静默重启
 * - P2-5  cron 步长为零（star-slash-0）不再抛 RangeError 让后续触发器失效
 * - P2-6  概览的委派统计在无项目时与「委派」页签同为 0
 * - P2-7  重启后委派历史（completed/failed）能恢复（getRecentDelegations）
 * - P2-8  切换项目时 Issues / 看板 / 收件箱重新查询
 * - P2-9  single 槽位「最高优先级胜出」（原先最低优先级胜出）
 * - P3-13 收件箱写入时裁掉 30 天前的旧通知
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { Context } from "../core/cordis/src/index.ts";
import { SlotsService } from "../core/slots/index.ts";
import { SlotBridge } from "../core/slots/SlotBridge.tsx";
import { setActiveContext } from "../core/consumer/index.ts";

const PROJECT_A = "proj-audit2-a";
const PROJECT_B = "proj-audit2-b";

async function seedProject(projectId: string | null) {
  const { useProjectStore } = await import("../core/store");
  const project = { id: projectId, name: "审计项目2", path: "C:/audit2", createdAt: 0, lastAccessedAt: 0 };
  useProjectStore.setState({
    projects: projectId ? [project as any] : [],
    sessions: [],
    currentProject: projectId ? (project as any) : null,
    currentSession: null,
  });
  return useProjectStore;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TC-AUDIT2-P1-1 issue 工具的项目边界", () => {
  it("无项目时 issue_create 拒绝创建（不写孤儿 Issue）", async () => {
    const { createIssueCreateTool } = await import("../core/issue/issue-tools");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedProject(null);

    const before = getIssueManager().list().length;
    const tool = createIssueCreateTool();
    const result = await tool.execute({ title: "孤儿" } as any, {} as any);

    expect(result.output).toMatch(/尚未选择项目|No project selected/);
    expect(getIssueManager().list().length).toBe(before);
  });

  it("无项目时 issue_list 不返回其它项目的 Issue", async () => {
    const { createIssueListTool } = await import("../core/issue/issue-tools");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedProject(PROJECT_A);
    getIssueManager().create({ title: "A 项目 Issue", projectId: PROJECT_A });

    await seedProject(null);
    const tool = createIssueListTool();
    const result = await tool.execute({} as any, {} as any);

    expect(result.output).toMatch(/尚未选择项目|No project selected/);
    expect(result.output).not.toContain("A 项目 Issue");
  });

  it("有项目时 issue_list 只返回当前项目的 Issue", async () => {
    const { createIssueListTool } = await import("../core/issue/issue-tools");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedProject(PROJECT_A);
    getIssueManager().create({ title: "本项目 Issue", projectId: PROJECT_A });
    getIssueManager().create({ title: "别的项目 Issue", projectId: PROJECT_B });

    const result = await createIssueListTool().execute({} as any, {} as any);
    expect(result.output).toContain("本项目 Issue");
    expect(result.output).not.toContain("别的项目 Issue");
  });

  it("issue_update 拒绝非法 status（避免 UI 渲染时崩）", async () => {
    const { createIssueUpdateTool } = await import("../core/issue/issue-tools");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedProject(PROJECT_A);
    const issue = getIssueManager().create({ title: "状态校验", projectId: PROJECT_A });

    const result = await createIssueUpdateTool().execute(
      { issue_id: issue.id, status: "in-progress" } as any,
      {} as any,
    );
    expect(result.output).toMatch(/非法 status|invalid status/);
    expect(getIssueManager().get(issue.id)!.status).toBe("todo");
  });
});

describe("TC-AUDIT2-P1-2 未知状态不崩溃", () => {
  it("IssueCard 遇到未知 status 回退 todo 而不是抛错", async () => {
    const { IssueCard } = await import("../components/task-center/IssueCard");
    const bad = {
      id: "issue-bad",
      title: "状态被改坏的行",
      description: null,
      status: "in-progress" as any,
      priority: "normal" as any,
      assigneeType: null,
      assigneeId: null,
      squadId: null,
      sessionId: null,
      labels: [],
      projectId: PROJECT_A,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { container } = render(<IssueCard issue={bad as any} />);
    expect(container.textContent).toContain("状态被改坏的行");
  });

  it("IssueDetailPanel 遇到未知 status 回退 todo 而不是抛错", async () => {
    const { IssueDetailPanel } = await import("../components/task-center/IssueDetailPanel");
    const bad = {
      id: "issue-bad",
      title: "详情未知状态",
      description: null,
      status: "Done" as any,
      priority: "normal" as any,
      assigneeType: null,
      assigneeId: null,
      squadId: null,
      sessionId: null,
      labels: [],
      projectId: PROJECT_A,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      comments: [],
    };
    const { container } = render(
      <IssueDetailPanel issue={bad as any} onClose={() => {}} onRefresh={() => {}} />,
    );
    expect(container.textContent).toContain("详情未知状态");
  });
});

describe("TC-AUDIT2-P2-3 详情面板状态变更守卫", () => {
  it("点击当前状态不写状态变更评论、不发收件箱通知", async () => {
    const { IssueDetailPanel } = await import("../components/task-center/IssueDetailPanel");
    const { getIssueManager } = await import("../core/issue/issue");
    const { getInboxManager } = await import("../core/inbox/inbox");
    await seedProject(PROJECT_A);

    const issue = getIssueManager().create({ title: "点当前状态", projectId: PROJECT_A });
    const commentsBefore = getIssueManager().get(issue.id)!.comments.length;
    const inboxBefore = getInboxManager().getUnreadCount(PROJECT_A);

    const withComments = getIssueManager().get(issue.id)!;
    const { container } = render(
      <IssueDetailPanel issue={withComments} onClose={() => {}} onRefresh={() => {}} />,
    );
    // 找到「todo」状态按钮（当前状态）并点击
    const statusBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Todo",
    );
    expect(statusBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(statusBtn!);
    });

    expect(getIssueManager().get(issue.id)!.comments.length).toBe(commentsBefore);
    expect(getInboxManager().getUnreadCount(PROJECT_A)).toBe(inboxBefore);
  });
});

describe("TC-AUDIT2-P2-4 自动化暂停状态与引擎一致", () => {
  it("stop → isAutomationStopped=true；暂停期间 refresh 不重启；resume 恢复", async () => {
    const mgr = await import("../core/automation/automation-manager");

    // 未装配过 → 不能 resume（返回 false，按钮保持暂停态）
    mgr.stopAutomationEngines();
    expect(mgr.isAutomationStopped()).toBe(true);
    expect(mgr.resumeAutomationEngines()).toBe(false);

    // 装配 → 暂停 → refresh 应被忽略（不重启引擎）
    mgr.startAutomationEngines(() => {});
    expect(mgr.isAutomationStopped()).toBe(false);
    mgr.stopAutomationEngines();
    expect(mgr.isAutomationStopped()).toBe(true);
    mgr.refreshAutomationEngines();
    expect(mgr.isAutomationStopped()).toBe(true);

    // 恢复
    expect(mgr.resumeAutomationEngines()).toBe(true);
    expect(mgr.isAutomationStopped()).toBe(false);

    // 收尾：停掉引擎，避免遗留定时器
    mgr.stopAutomationEngines();
  });
});

describe("TC-AUDIT2-P2-5 cron 步长校验", () => {
  it("*/0 不抛 RangeError 且不触发", async () => {
    const { shouldFireCron } = await import("../core/automation/automation-manager");
    const date = new Date(2026, 8, 10, 9, 0, 0);
    expect(() => shouldFireCron("*/0 * * * *", date)).not.toThrow();
    expect(shouldFireCron("*/0 * * * *", date)).toBe(false);
    expect(shouldFireCron("*/abc * * * *", date)).toBe(false);
    // 正常表达式仍然可用
    expect(shouldFireCron("0 9 * * *", date)).toBe(true);
  });
});

describe("TC-AUDIT2-P2-6/P2-8 项目边界与切换重查", () => {
  it("概览在无项目时委派统计为 0（与委派页签一致）", async () => {
    const { OverviewTab } = await import("../components/task-center/OverviewTab");
    const { getDelegationOrchestrator } = await import("../core/session");
    const orch: any = getDelegationOrchestrator();
    vi.spyOn(orch, "getAllDelegations").mockReturnValue([
      {
        id: "d1",
        sourceSessionId: "s1",
        targetSessionId: "s2",
        task: "x",
        status: "completed",
        projectId: PROJECT_A,
        createdAt: Date.now(),
      } as any,
    ]);
    await seedProject(null);

    const { container } = render(<OverviewTab onNavigate={() => {}} />);
    // 委派卡片：运行中/已完成/等待中 三个数字都应为 0
    const card = Array.from(container.querySelectorAll("div")).find((d) =>
      d.textContent?.includes("委派任务"),
    );
    expect(card).toBeTruthy();
    const nums = Array.from(card!.querySelectorAll("div"))
      .map((d) => d.textContent?.trim())
      .filter((t) => t === "1");
    expect(nums.length).toBe(0);
  });

  it("切换项目后收件箱重新查询（不会继续显示上一个项目的通知）", async () => {
    const { InboxTab } = await import("../components/task-center/InboxTab");
    const { getInboxManager } = await import("../core/inbox/inbox");
    const store = await seedProject(PROJECT_A);
    getInboxManager().add({ category: "issue", title: "A 项目通知", projectId: PROJECT_A });
    getInboxManager().add({ category: "issue", title: "B 项目通知", projectId: PROJECT_B });

    const { container } = render(<InboxTab />);
    expect(container.textContent).toContain("A 项目通知");

    await act(async () => {
      store.setState({
        currentProject: { id: PROJECT_B, name: "B", path: "C:/b", createdAt: 0, lastAccessedAt: 0 } as any,
      });
    });
    expect(container.textContent).toContain("B 项目通知");
    expect(container.textContent).not.toContain("A 项目通知");
  });
});

describe("TC-AUDIT2-P2-7 委派历史恢复", () => {
  it("getRecentDelegations 返回已完成任务（供重启后恢复历史与统计）", async () => {
    const { createDelegationTask, updateDelegationTaskStatus, getRecentDelegations, getActiveDelegations } =
      await import("../core/session/delegation-storage");
    const ProjectStorage = await import("../core/storage/project");
    ProjectStorage.createProject({
      id: PROJECT_A, name: "委派历史", path: "C:/hist", createdAt: Date.now(), lastAccessedAt: Date.now(),
    });

    createDelegationTask({
      id: "del-hist-1",
      sourceSessionId: "s1",
      targetSessionId: "s2",
      task: "已完成的任务",
      status: "pending",
      projectId: PROJECT_A,
      createdAt: Date.now() - 1000,
    } as any);
    updateDelegationTaskStatus("del-hist-1", "completed", "结果");

    expect(getActiveDelegations().length).toBe(0);
    const recent = getRecentDelegations(50);
    expect(recent.some((t) => t.id === "del-hist-1" && t.status === "completed")).toBe(true);
  });
});

describe("TC-AUDIT2-P2-9 single 槽位最高优先级胜出", () => {
  it("两个注册项时渲染 priority 更高的组件", async () => {
    const ctx = new Context();
    const slots = new SlotsService(ctx);
    slots.declareSlot("test.single.slot", { kind: "single", scope: "root" }, "test");
    setActiveContext(ctx);

    const unregLow = slots.register({ name: "test.single.slot", id: "low", priority: 1 }, () => (
      <div data-testid="winner">low</div>
    ));
    const unregHigh = slots.register({ name: "test.single.slot", id: "high", priority: 99 }, () => (
      <div data-testid="winner">high</div>
    ));

    const { container } = render(<SlotBridge name="test.single.slot" fallback={() => <div>fallback</div>} />);
    expect(container.textContent).toBe("high");

    // 高优先级注销后回落到低优先级
    await act(async () => {
      unregHigh();
    });
    expect(container.textContent).toBe("low");

    unregLow();
    setActiveContext(new Context());
  });
});

describe("TC-AUDIT2-P3-13 收件箱裁剪", () => {
  it("写入新通知时删除 30 天前的旧行", async () => {
    const { InboxStorage } = await import("../core/inbox/inbox-storage");
    const { getDatabase } = await import("../core/storage/database");

    InboxStorage.create({
      id: "inbox-old",
      category: "automation",
      title: "很久以前的通知",
      body: null,
      source_type: null,
      source_id: null,
      project_id: PROJECT_A,
      squad_id: null,
      issue_id: null,
      priority: "low",
    } as any);
    const db = getDatabase();
    db.run("UPDATE inbox SET created_at = ? WHERE id = ?", [Date.now() - 40 * 24 * 60 * 60 * 1000, "inbox-old"]);

    InboxStorage.create({
      id: "inbox-new",
      category: "automation",
      title: "新通知",
      body: null,
      source_type: null,
      source_id: null,
      project_id: PROJECT_A,
      squad_id: null,
      issue_id: null,
      priority: "low",
    } as any);

    const rows = InboxStorage.listAll({ projectId: PROJECT_A });
    expect(rows.some((r) => r.id === "inbox-new")).toBe(true);
    expect(rows.some((r) => r.id === "inbox-old")).toBe(false);
  });
});
