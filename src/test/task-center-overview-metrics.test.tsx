/**
 * TC-OVERVIEW-METRICS —— 概览页「一条紧凑指标条」的结构/交互判据。
 *
 * 改前：四张等宽 KPI 卡（收件箱 / Issues / 委派 / 自动化），每张 3 个数字，
 * 全是大字号数字 + 边框 + 箭头。
 *
 * 现在：一条指标条，只有 4 个数字（未读 / 运行中委派 / 今日自动化触发 / 进行中 Issue），
 * 每项 = 数字 + 小标签，点一下跳到对应页签；插件槽位与最近活动 fallback 不动。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { useProjectStore } from "../core/store";
import { OverviewTab } from "../components/task-center/OverviewTab";

const h = vi.hoisted(() => ({
  delegations: [] as Array<Record<string, unknown>>,
  automation: { triggers: [] as Array<Record<string, unknown>>, history: [] as Array<Record<string, unknown>> },
  issueStats: {} as Record<string, number>,
  unread: 0,
}));

vi.mock("../core/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/session")>();
  return {
    ...actual,
    getDelegationOrchestrator: () => ({
      getAllDelegations: () => h.delegations,
      onStateChange: () => () => {},
      getLimits: () => ({}),
    }),
  };
});

vi.mock("../core/automation/automation-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/automation/automation-manager")>();
  return {
    ...actual,
    getAutomationConfig: () => h.automation,
  };
});

vi.mock("../core/issue/issue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/issue/issue")>();
  return {
    ...actual,
    getIssueManager: () => ({ getStats: () => h.issueStats }),
  };
});

vi.mock("../core/inbox/inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/inbox/inbox")>();
  return {
    ...actual,
    getInboxManager: () => ({ getUnreadCount: () => h.unread }),
  };
});

describe("TC-OVERVIEW-METRICS 概览指标条", () => {
  beforeEach(() => {
    cleanup();
    h.delegations = [
      { id: "d1", status: "running", task: "进行中的委派", projectId: "", createdAt: 1 },
      { id: "d2", status: "completed", task: "已完成的委派", projectId: "", createdAt: 2 },
    ];
    h.automation = {
      triggers: [{ enabled: true }, { enabled: false }],
      history: [{ timestamp: Date.now(), triggerName: "每日检查" }],
    };
    h.issueStats = { in_progress: 2, in_review: 1, done: 3 };
    h.unread = 7;
    useProjectStore.setState({
      projects: [],
      sessions: [],
      currentProject: { id: "proj-overview", name: "概览项目", path: "C:/overview", createdAt: 0, lastAccessedAt: 0 } as any,
      currentSession: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("只有 4 个数字；值取自真实数据；点击分别跳到 inbox / delegation / automation / issues", async () => {
    const onNavigate = vi.fn();
    let container!: HTMLElement;

    await act(async () => {
      ({ container } = render(<OverviewTab onNavigate={onNavigate} />));
    });

    const strip = container.querySelector<HTMLElement>(".task-overview-metrics");
    expect(strip, "概览应渲染指标条").toBeTruthy();

    const metrics = [...strip!.querySelectorAll<HTMLButtonElement>(".task-overview-metric")];
    expect(metrics.length, "指标条只应有 4 项").toBe(4);

    // 只有 4 个数字，顺序与取值都是这四个真实读数
    const values = [...strip!.querySelectorAll(".task-overview-metric__value")].map((el) => el.textContent);
    expect(values).toEqual(["7", "1", "1", "2"]);

    const labels = [...strip!.querySelectorAll(".task-overview-metric__label")].map((el) => el.textContent);
    expect(labels).toEqual(["未读", "运行中委派", "今日自动化触发", "进行中 Issue"]);

    // 每项可点击，落到对应页签
    for (const metric of metrics) fireEvent.click(metric);
    expect(onNavigate.mock.calls.map(([tab]) => tab)).toEqual([
      "inbox",
      "delegation",
      "automation",
      "issues",
    ]);

    // fallback 仍在（插件未接管概览时用户仍能看到最近活动）
    expect(container.textContent).toContain("最近活动");
  });
});
