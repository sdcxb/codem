/**
 * LO-OV —— 概览页「去模板化」的结构判据。
 *
 * 改前：行 1 是「运行状态 / 最近会话 / 活动概览」三张等高并排卡，另有一张「场景实况」大卡；
 * 活动数据全为 0 时仍然摆出空热力图 + 空圆环 + 空小时柱。
 *
 * 现在：运行状态与最近会话合并成一张「当前工作」（状态行 + 最多 4 个会话），
 * 活动概览单独一张更宽的卡；14 天全 0 时退化成一行空状态 +「查看时间线」。
 * 场景画布只在「子智能体」页签，概览不再渲染它（但保留「场景 →」入口）。
 *
 * 第二轮收口（LO-OV-4/5）：团队/任务没有数据时不再摆一排 0%（健康环 / 完成率 / 错误率），
 * 团队卡空态给出「去哪儿建」+ 明确动作；任务卡空态不再渲染 8 个全零字段；
 * 真实数据源读数与「全部 →」「查看时间线」等入口一个不少。有数据时走原路径。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";
import { generateLook } from "../plugins/library-ops/data/characters";
import { useLibraryOps } from "../plugins/library-ops/store";
import { OverviewPanel } from "../plugins/library-ops/components/monitor/OverviewPanel";

const NOW = 1_800_000_000_000;
const DAY_KEYS = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 10).padStart(2, "0")}`);

const emptySeries = {
  tokens: [],
  cost: [],
  tools: [],
  actors: [],
  tasks: [],
  health: [],
};

function actor(id: string, kind: LibraryActor["kind"], activity: LibraryActor["activity"]): LibraryActor {
  return {
    id,
    name: `角色-${id}`,
    roleLabel: "成员 · 前端编码",
    kind,
    look: generateLook(id, "成员 · 前端编码"),
    activity,
    statusLabel: "执行中",
    focus: `正在处理 ${id}`,
    lastEventAt: NOW - 60_000,
    metrics: { tasks: 2, done: 1, failed: 0, tools: 5, tokens: 100, cost: 0.01, errors: 0 },
    preferredZoneId: "code-forge",
  };
}

/** 6 个会话：用来钉住「当前工作」最多只列 4 个 */
const SESSION_ACTORS: LibraryActor[] = [
  actor("s1", "captain", "working"),
  actor("s2", "session", "reading"),
  actor("s3", "session", "searching"),
  actor("s4", "session", "writing"),
  actor("s5", "session", "idle"),
  actor("s6", "session", "thinking"),
];

function makeSnapshot(
  activity: LibrarySnapshot["activity"],
  overrides: Partial<Omit<LibrarySnapshot, "metrics">> = {},
  metricOverrides: Partial<LibrarySnapshot["metrics"]> = {},
): LibrarySnapshot {
  return {
    at: NOW,
    actors: SESSION_ACTORS,
    teams: [],
    metrics: {
      sessions: 6,
      activeSessions: 4,
      teams: 0,
      tasksTotal: 3,
      tasksDone: 1,
      tasksFailed: 0,
      tasksRunning: 1,
      tasksPending: 1,
      actors: SESSION_ACTORS.length,
      actorsWorking: 4,
      actorsIdle: 1,
      actorsBlocked: 0,
      actorsError: 0,
      tokensIn: 120_000,
      tokensOut: 30_000,
      tokensCached: 0,
      costTotal: 3.5,
      costToday: 1.25,
      toolCalls: 12,
      toolErrors: 1,
      filesTouched: 3,
      messages: 8,
      health: 0.82,
      ...metricOverrides,
    },
    events: [],
    activity,
    sources: {
      sessions: 6,
      activeSessions: 4,
      teams: 0,
      teamMembers: 0,
      subagents: 0,
      teamTemplates: 0,
      agentProfiles: 0,
      telemetryEvents: 0,
      failed: [],
    },
    sampleMs: 1.2,
    ...overrides,
  };
}

/** 一个活动团队（有数据路径：团队卡必须画成员，而不是空态）。 */
const ACTIVE_TEAM: LibrarySnapshot["teams"][number] = {
  id: "team-1",
  name: "前端小队",
  captainSessionId: "s1",
  captainName: "角色-s1",
  memberCount: 2,
  members: [
    { id: "m1", name: "前队员", status: "working", tasks: 2, done: 1 },
    { id: "m2", name: "后队员", status: "idle", tasks: 1, done: 0 },
  ],
  tasks: [],
  taskCounts: { pending: 1, claimed: 0, in_progress: 1, completed: 1, failed: 0, cancelled: 0 },
  unread: 0,
  createdAt: NOW - 60_000,
  updatedAt: NOW,
  archived: false,
  completion: 1 / 3,
};

const ACTIVE_ACTIVITY: LibrarySnapshot["activity"] = {
  perDay: Object.fromEntries(DAY_KEYS.map((day, i) => [day, i])),
  perHour: Array.from({ length: 24 }, (_, h) => (h < 12 ? h : 0)),
  kinds: { chat: 1, captain: 1, worktree: 0 },
};

const EMPTY_ACTIVITY: LibrarySnapshot["activity"] = {
  perDay: Object.fromEntries(DAY_KEYS.map((day) => [day, 0])),
  perHour: new Array(24).fill(0),
  kinds: {},
};

function renderPanel(snapshot: LibrarySnapshot, overrides: Partial<Parameters<typeof OverviewPanel>[0]> = {}) {
  const onOpenLibrary = vi.fn();
  const onOpenTab = vi.fn();
  const utils = render(
    <OverviewPanel
      snapshot={snapshot}
      series={emptySeries}
      zh
      onOpenLibrary={onOpenLibrary}
      onOpenTab={onOpenTab}
      {...overrides}
    />,
  );
  return { ...utils, onOpenLibrary, onOpenTab };
}

describe("LO-OV 概览页去模板化", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useLibraryOps.getState()._reset();
  });

  it("LO-OV-1: 不再出现「场景实况」；运行状态 + 最近会话合并为「当前工作」（最多 4 个会话）", () => {
    const { container, onOpenLibrary } = renderPanel(makeSnapshot(ACTIVE_ACTIVITY));

    // 场景大卡与场景画布都不在概览页了
    expect(screen.queryByText("场景实况")).toBeNull();
    expect(screen.queryByText("Scene live")).toBeNull();
    expect(container.querySelector(".lo-card--scene")).toBeNull();
    expect(container.querySelector(".lo-scene-host")).toBeNull();

    // 卡片标题：当前工作 + 活动概览；不再有独立的「运行状态」「最近会话」卡
    const titles = [...container.querySelectorAll(".lo-card__title")].map((n) => n.textContent);
    expect(titles).toContain("当前工作");
    expect(titles).toContain("活动概览");
    expect(titles).not.toContain("运行状态");
    expect(titles).not.toContain("最近会话");

    // 总卡片数：当前工作 / 活动概览 / 团队 / 任务与工具 / 数据源与健康度
    expect(container.querySelectorAll(".lo-card").length).toBe(5);

    // 6 个会话只列 4 个
    const items = container.querySelectorAll(".lo-overview-current .lo-status__item");
    expect(items.length).toBe(4);

    // 点会话：仍然选中角色 + 请求宿主切到「子智能体 → 场景」
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("codem:open-task-center", listener);
    try {
      fireEvent.click(items[0]);
    } finally {
      window.removeEventListener("codem:open-task-center", listener);
    }
    expect(useLibraryOps.getState().selectedActorId).toBe("s1");
    expect(seen).toContainEqual({ tab: "subagents", view: "scene" });

    // 概览页的「场景 →」入口保留（调用方传入的 requestView("scene")）
    fireEvent.click(screen.getByText("场景 →"));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("LO-OV-2: 14 天全 0 → 不渲染空热力图/圆环/小时柱，显示空状态并可跳到时间线", () => {
    const { container, onOpenTab } = renderPanel(makeSnapshot(EMPTY_ACTIVITY));

    expect(screen.getByText("最近 14 天没有活动")).toBeTruthy();
    expect(container.querySelector(".lo-heatmap")).toBeNull();
    expect(container.querySelector(".lo-donut")).toBeNull();
    expect(container.querySelector(".lo-hourbars")).toBeNull();

    fireEvent.click(screen.getByText("查看时间线"));
    expect(onOpenTab).toHaveBeenCalledWith("timeline");
  });

  it("LO-OV-3: 有活动时保留 Heatmap / Donut / HourBars，不显示空状态", () => {
    const { container } = renderPanel(makeSnapshot(ACTIVE_ACTIVITY));

    expect(container.querySelector(".lo-heatmap")).toBeTruthy();
    expect(container.querySelector(".lo-donut")).toBeTruthy();
    expect(container.querySelector(".lo-hourbars")).toBeTruthy();
    expect(screen.queryByText("最近 14 天没有活动")).toBeNull();
  });

  it("LO-OV-4: 团队/任务无数据 → 不摆 0% 仪表模板；团队卡给明确动作，数据源口径不丢", () => {
    const snapshot = makeSnapshot(
      EMPTY_ACTIVITY,
      { teams: [], events: [] },
      {
        teams: 0,
        tasksTotal: 0,
        tasksDone: 0,
        tasksRunning: 0,
        tasksPending: 0,
        tasksFailed: 0,
        toolCalls: 0,
        toolErrors: 0,
        filesTouched: 0,
        health: 0.6,
      },
    );
    const { container } = renderPanel(snapshot);

    /* 没有样本时：健康环 + 两个 0% 速率字段都不渲染，只留一行说明 */
    expect(container.querySelector(".lo-ring"), "没有任务/工具样本时不画健康环").toBeNull();
    expect(screen.queryByText("任务完成率"), "完成率 0% 是空模板，不该出现").toBeNull();
    expect(screen.queryByText("工具错误率"), "错误率 0% 是空模板，不该出现").toBeNull();
    expect(container.querySelector('[data-empty="health"]'), "改为一句说明").toBeTruthy();

    /* 真实数据源读数仍然保留（口径不变，只是不再伪装成百分比仪表） */
    for (const label of ["运行时团队", "团队成员", "子智能体", "采样耗时"]) {
      expect(screen.getByText(label), `数据源读数不能丢：${label}`).toBeTruthy();
    }

    /* 团队卡空态：说明 + 明确动作；卡片自带的「全部 →」仍在 */
    const teamEmpty = container.querySelector<HTMLElement>('[data-empty="team"]');
    expect(teamEmpty, "团队空态有独立结构").toBeTruthy();
    expect(teamEmpty!.classList.contains("empty-hint")).toBe(true);
    expect(teamEmpty!.textContent).toContain("任务管理 → 团队");
    expect(screen.getAllByText("全部 →").length, "团队/任务两张卡的真实入口都保留").toBe(2);

    /* 任务卡空态：不再摆 8 个全零字段 */
    expect(container.querySelector('[data-empty="task"]'), "任务空态有独立结构").toBeTruthy();
    expect(screen.queryByText("团队任务总数"), "空态不渲染全零字段").toBeNull();
    expect(screen.queryByText("待领取"), "空态不渲染全零字段").toBeNull();

    /* 活动空态仍保留时间线入口；卡片数量不变（活动卡没被删掉） */
    expect(screen.getByText("查看时间线")).toBeTruthy();
    expect(container.querySelectorAll(".lo-card").length).toBe(5);

    /* 团队空态的「打开团队 →」落到任务管理的团队页签 */
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("codem:open-task-center", listener);
    try {
      fireEvent.click(screen.getByText("打开团队 →"));
    } finally {
      window.removeEventListener("codem:open-task-center", listener);
    }
    expect(seen).toContainEqual({ tab: "teams" });
  });

  it("LO-OV-5: 团队/任务有数据 → 走原路径（成员、字段、健康环都在，无空态）", () => {
    const { container } = renderPanel(
      makeSnapshot(ACTIVE_ACTIVITY, { teams: [ACTIVE_TEAM] }, { teams: 1, tasksTotal: 3 }),
    );

    expect(container.querySelector('[data-empty="team"]')).toBeNull();
    expect(container.querySelectorAll(".lo-team-mini").length, "团队卡画成员").toBe(1);
    expect(container.querySelector(".lo-team-mini__mtasks")?.textContent).toBe("1/2");

    expect(container.querySelector('[data-empty="task"]')).toBeNull();
    expect(screen.getByText("团队任务总数"), "有数据时字段口径不变").toBeTruthy();
    expect(screen.getByText("待领取")).toBeTruthy();

    expect(container.querySelector(".lo-ring"), "有样本时健康环保留").toBeTruthy();
    expect(screen.getByText("任务完成率")).toBeTruthy();
    expect(container.querySelector('[data-empty="health"]')).toBeNull();
  });
});
