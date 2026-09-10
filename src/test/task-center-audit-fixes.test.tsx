/**
 * TC-AUDIT — 任务管理审计修复回归（v1.14.0）
 *
 * 覆盖子智能体审计发现的宿主缺陷（不是插件缺陷）：
 * - P1-6  「委派」页签统计与列表同口径（原先统计走全局 getStats，列表按项目过滤）
 * - P1-13 面板已打开时 `codem:open-task-center` 仍能切页签（原先只认挂载时 initialTab）
 * - P2-11 收件箱未读徽标按「项目整体未读」+ 点击穿透到 Issue 详情
 * - P2-12 无当前项目时不跨项目串数据、不创建孤儿 Issue
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { DelegationTask } from "../core/session";

// ---- 委派编排器替身：只实现「委派」页签/概览用到的查询方法 ----
const hoisted = vi.hoisted(() => {
  const state: { tasks: any[] } = { tasks: [] };
  return { state };
});

vi.mock("../core/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/session")>();
  return {
    ...actual,
    getDelegationOrchestrator: () => ({
      getAllDelegations: () => hoisted.state.tasks,
      getDelegationsBySource: (id: string) => hoisted.state.tasks.filter((t) => t.sourceSessionId === id),
      getDelegationsByTarget: (id: string) => hoisted.state.tasks.filter((t) => t.targetSessionId === id),
      getStats: () => ({ total: hoisted.state.tasks.length, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }),
      onStateChange: () => () => {},
    }),
  };
});

const PROJECT_A = "proj-audit-a";
const PROJECT_B = "proj-audit-b";

async function seedStores(projectId: string | null) {
  const { useProjectStore } = await import("../core/store");
  const project = { id: projectId, name: "审计项目", path: "C:/audit", createdAt: 0, lastAccessedAt: 0 };
  useProjectStore.setState({
    projects: projectId ? [project as any] : [],
    sessions: [],
    currentProject: projectId ? (project as any) : null,
    currentSession: null,
  });
  return useProjectStore;
}

function makeDelegation(overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    id: `del-${Math.random().toString(36).slice(2, 8)}`,
    sourceSessionId: "sess-1",
    targetSessionId: "sess-2",
    task: "实现登录页",
    status: "completed",
    projectId: PROJECT_A,
    createdAt: Date.now(),
    ...overrides,
  } as DelegationTask;
}

beforeEach(() => {
  hoisted.state.tasks = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TC-AUDIT-P1-6 委派统计与列表同口径", () => {
  it("列表只显示当前项目的委派，统计数字与列表条数一致", async () => {
    const { DelegationTab } = await import("../components/task-center/DelegationTab");
    hoisted.state.tasks = [
      makeDelegation({ projectId: PROJECT_A, task: "A-任务一" }),
      makeDelegation({ projectId: PROJECT_A, task: "A-任务二", status: "running" }),
      makeDelegation({ projectId: PROJECT_B, task: "B-任务（不该出现）" }),
    ];
    await seedStores(PROJECT_A);

    const { container } = render(<DelegationTab />);
    const text = container.textContent || "";

    expect(text).toContain("A-任务一");
    expect(text).toContain("A-任务二");
    expect(text).not.toContain("B-任务（不该出现）");
    // 统计「总计」= 2（与列表一致），不是全局 3
    const stats = Array.from(container.querySelectorAll("span")).map((n) => n.textContent);
    expect(stats.filter((t) => t === "2").length).toBeGreaterThan(0);
    expect(stats).not.toContain("3");
  });

  it("无当前项目时列表与统计都为空", async () => {
    const { DelegationTab } = await import("../components/task-center/DelegationTab");
    hoisted.state.tasks = [makeDelegation({ projectId: PROJECT_A })];
    await seedStores(null);

    const { container } = render(<DelegationTab />);
    expect(container.textContent).not.toContain("实现登录页");
    expect(container.textContent || "").toMatch(/尚未选择项目|No project selected/);
  });
});

describe("TC-AUDIT-P1-13 面板打开期间跟随页签请求", () => {
  it("initialTab 变化时切换页签", async () => {
    const { TaskCenter } = await import("../components/TaskCenter");
    await seedStores(PROJECT_A);

    const { rerender } = render(<TaskCenter onClose={() => {}} initialTab="overview" />);
    // 概览页含「收件箱」卡片
    expect(document.body.textContent).toContain("概览");

    rerender(<TaskCenter onClose={() => {}} initialTab="automation" />);
    await act(async () => {});
    expect(document.body.textContent).toContain("添加触发器");
  });

  it("面板已打开时派发 codem:open-task-center 会切页签", async () => {
    const { TaskCenter } = await import("../components/TaskCenter");
    await seedStores(PROJECT_A);

    render(<TaskCenter onClose={() => {}} initialTab="overview" />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("codem:open-task-center", { detail: { tab: "inbox" } }));
    });
    expect(document.body.textContent).toContain("收件箱");
    expect(document.body.textContent).toContain("暂无通知");
  });

  it("旧页签 id 兼容：library → board", async () => {
    const { TaskCenter } = await import("../components/TaskCenter");
    await seedStores(PROJECT_A);

    render(<TaskCenter onClose={() => {}} initialTab="overview" />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("codem:open-task-center", { detail: { tab: "library" } }));
    });
    // 看板页签：列标题「Backlog」出现
    expect(document.body.textContent).toContain("Backlog");
  });
});

describe("TC-AUDIT-P2-11 收件箱徽标与点击穿透", () => {
  it("未读徽标按项目整体统计，不随分类筛选变化", async () => {
    const { InboxTab } = await import("../components/task-center/InboxTab");
    const { getInboxManager } = await import("../core/inbox/inbox");
    await seedStores(PROJECT_A);

    const mgr = getInboxManager();
    mgr.add({ category: "issue", title: "Issue 未读", projectId: PROJECT_A, issueId: "issue-x" });
    mgr.add({ category: "automation", title: "自动化未读", projectId: PROJECT_A });

    const { container } = render(<InboxTab />);
    const badge = () => Array.from(container.querySelectorAll("span")).find((n) => n.textContent === "2");
    expect(badge()).toBeTruthy();

    // 切到「自动化」筛选：列表只剩 1 条，但徽标仍是 2（项目整体未读）
    const autoBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "自动化");
    expect(autoBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(autoBtn!);
    });
    expect(container.textContent).toContain("自动化未读");
    expect(container.textContent).not.toContain("Issue 未读");
    expect(badge()).toBeTruthy();
  });

  it("点击通知派发 codem:open-task-center 并带上 issueId", async () => {
    const { InboxTab } = await import("../components/task-center/InboxTab");
    const { getInboxManager } = await import("../core/inbox/inbox");
    await seedStores(PROJECT_A);

    getInboxManager().add({
      category: "issue",
      title: "点我跳转",
      projectId: PROJECT_A,
      issueId: "issue-42",
    });

    const events: any[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("codem:open-task-center", listener);
    try {
      const { container } = render(<InboxTab />);
      const row = Array.from(container.querySelectorAll("div")).find(
        (d) => d.textContent?.includes("点我跳转") && d.getAttribute("style")?.includes("cursor: pointer"),
      );
      expect(row).toBeTruthy();
      await act(async () => {
        fireEvent.click(row!);
      });
      expect(events).toEqual([{ tab: "issues", issueId: "issue-42" }]);
    } finally {
      window.removeEventListener("codem:open-task-center", listener);
    }
  });

  it("收件箱点击穿透 → 任务管理直接打开该 Issue 详情", async () => {
    const { TaskCenter } = await import("../components/TaskCenter");
    const { getIssueManager } = await import("../core/issue/issue");
    const { getInboxManager } = await import("../core/inbox/inbox");
    await seedStores(PROJECT_A);

    const issue = getIssueManager().create({ title: "穿透目标 Issue", projectId: PROJECT_A });
    getInboxManager().add({ category: "issue", title: "有未读", projectId: PROJECT_A, issueId: issue.id });

    render(<TaskCenter onClose={() => {}} initialTab="inbox" />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("codem:open-task-center", { detail: { tab: "issues", issueId: issue.id } }),
      );
    });
    expect(document.body.textContent).toContain("穿透目标 Issue");
  });
});

describe("TC-AUDIT-P2-12 无项目不串数据 / 不建孤儿 Issue", () => {
  it("有项目时只列出本项目 Issue", async () => {
    const { IssuesTab } = await import("../components/task-center/IssuesTab");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedStores(PROJECT_A);

    getIssueManager().create({ title: "A 项目 Issue", projectId: PROJECT_A });
    getIssueManager().create({ title: "B 项目 Issue", projectId: PROJECT_B });

    const { container } = render(<IssuesTab />);
    expect(container.textContent).toContain("A 项目 Issue");
    expect(container.textContent).not.toContain("B 项目 Issue");
  });

  it("无项目时不显示任何项目的 Issue，并禁用新建", async () => {
    const { IssuesTab } = await import("../components/task-center/IssuesTab");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedStores(null);

    getIssueManager().create({ title: "孤儿候选 Issue", projectId: PROJECT_A });

    const { container } = render(<IssuesTab />);
    expect(container.textContent).not.toContain("孤儿候选 Issue");
    expect(container.textContent || "").toMatch(/尚未选择项目|No project selected/);

    const newBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("新建 Issue"),
    ) as HTMLButtonElement | undefined;
    expect(newBtn?.disabled).toBe(true);
  });

  it("无项目时看板也不显示其他项目 Issue", async () => {
    const { IssueBoard } = await import("../components/task-center/IssueBoard");
    const { getIssueManager } = await import("../core/issue/issue");
    await seedStores(null);

    getIssueManager().create({ title: "看板里的别的项目 Issue", projectId: PROJECT_B });

    const { container } = render(<IssueBoard />);
    expect(container.textContent).not.toContain("看板里的别的项目 Issue");
  });

  it("无项目时收件箱不显示其他项目通知", async () => {
    const { InboxTab } = await import("../components/task-center/InboxTab");
    const { getInboxManager } = await import("../core/inbox/inbox");
    await seedStores(null);

    getInboxManager().add({ category: "issue", title: "别的项目通知", projectId: PROJECT_B });

    const { container } = render(<InboxTab />);
    expect(container.textContent).not.toContain("别的项目通知");
    expect(container.textContent || "").toMatch(/尚未选择项目|No project selected/);
  });
});
