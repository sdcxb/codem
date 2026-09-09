/**
 * LO-ADP — 遥测适配层（真实数据 → 图书馆快照）
 *
 * 全部用注入的 fake 依赖，不启动宿主服务；覆盖角色来源、指标聚合、
 * 活动分布、事件流、失败可见性与健康度。
 */
import { describe, it, expect } from "vitest";
import {
  collectSnapshotSync,
  computeHealth,
  toolToActivity,
  type AdapterDeps,
  type AgentTeamLike,
  type AppStateLike,
  type MessageLike,
  type ProjectStateLike,
} from "../plugins/library-ops/core/telemetry-adapter";

const NOW = 1_700_000_000_000;

function projectState(): ProjectStateLike {
  return {
    projects: [{ id: "p1", name: "mimo-gui", path: "C:/mimo-gui" }],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        title: "修复登录",
        lastMessageAt: NOW - 5_000,
        messageCount: 12,
        model: "deepseek-v4",
      },
      {
        id: "s2",
        projectId: "p1",
        title: "写文档",
        lastMessageAt: NOW - 3_600_000,
        messageCount: 4,
        executionMode: "git_worktree",
        worktreeBranch: "feat/docs",
      },
      {
        id: "s3",
        projectId: "p1",
        title: "旧会话",
        lastMessageAt: NOW - 5 * 86_400_000,
        messageCount: 2,
      },
    ],
    currentProject: { id: "p1", name: "mimo-gui", path: "C:/mimo-gui" },
    currentSession: { id: "s1", projectId: "p1", title: "修复登录", lastMessageAt: NOW, messageCount: 12 },
  };
}

function messages(): MessageLike[] {
  return [
    {
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: NOW - 2_000,
      toolCalls: [
        { id: "t1", tool: "read", status: "done", args: { file_path: "src/App.tsx" } },
        { id: "t2", tool: "write", status: "done", args: { file_path: "src/a.ts" }, result: "ok" },
        { id: "t3", tool: "bash", status: "error", args: { command: "npm test" }, result: "fail" },
      ],
      generatedFiles: ["src/a.ts"],
    },
    { id: "m2", role: "user", content: "继续", timestamp: NOW - 60_000 },
  ];
}

function appState(): AppStateLike {
  return {
    messages: messages(),
    activeSessions: new Set(["s1"]),
    llmStatus: "executing_tools",
    stepProgress: { current: 2, total: 5, title: "实现" },
    agentActivities: [{ type: "tool", label: "write", status: "running" }],
  };
}

function teams(): AgentTeamLike[] {
  return [
    {
      id: "team-1",
      name: "前端重构",
      captainSessionId: "s1",
      members: [
        { id: "c1", name: "小前", role: "前端实现", status: "working", model: "deepseek-v4" },
        { id: "c2", name: "小研", role: "研究分析", status: "idle" },
        { id: "c3", name: "小离", role: "运维部署", status: "absent" },
        { id: "c4", name: "小走", role: "写作", status: "removed" },
      ],
      tasks: [
        { id: "t1", subject: "实现登录页", status: "in_progress", assignee: "小前", dependencies: [], attempt: 1 },
        { id: "t2", subject: "调研方案", status: "completed", assignee: "小研", dependencies: [], attempt: 1 },
        { id: "t3", subject: "部署验证", status: "failed", assignee: "小离", dependencies: ["t2"], attempt: 2 },
        { id: "t4", subject: "写文档", status: "pending", dependencies: ["t1"], attempt: 0 },
      ],
      mailbox: [
        { id: "mb1", to: "小前", from: "captain" },
        { id: "mb2", to: "小研", from: "captain", deliveredAt: NOW },
      ],
      createdAt: NOW - 100_000,
      updatedAt: NOW - 1_000,
      archived: false,
    },
  ];
}

function baseDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    now: () => NOW,
    projectState,
    appState,
    teams,
    subagentTasks: () => [
      {
        id: "sub-1",
        name: "审计插件",
        parentId: "s1",
        agentId: "explore",
        status: "running",
        createdAt: NOW - 30_000,
        startedAt: NOW - 29_000,
        activities: [{ type: "tool", label: "grep", status: "running", startedAt: NOW - 1_000 }],
      },
      {
        id: "sub-2",
        name: "跑测试",
        parentId: "s1",
        agentId: "build",
        status: "completed",
        createdAt: NOW - 80_000,
        completedAt: NOW - 40_000,
      },
    ],
    costStats: () => ({
      totalRecords: 42,
      totalCost: 3.5,
      todayCost: 1.25,
      totalSessions: 3,
      totalInputTokens: 120_000,
      totalOutputTokens: 30_000,
    }),
    squads: () => [
      {
        id: "squad-1",
        name: "文档小队",
        members: [{ memberName: "小笔", roleDescription: "文档写作" }],
      },
    ],
    agentDefs: () => [{ id: "general", name: "通用", description: "通用智能体" }],
    telemetryEvents: () => [{ sessionId: "s1", name: "tool.executed", timestamp: NOW - 500, data: { tokens: 120 } }],
    ...overrides,
  };
}

describe("LO-ADP 遥测适配层", () => {
  it("LO-ADP-1: 会话 → 角色（队长/分支/主控），岗位按角色标签解析", () => {
    const snap = collectSnapshotSync(baseDeps());
    const s1 = snap.actors.find((a) => a.id === "session:s1")!;
    expect(s1.kind).toBe("captain"); // s1 是 team-1 的队长会话
    expect(s1.roleLabel).toContain("队长");
    expect(s1.teamName).toBe("前端重构");
    expect(s1.activity).toBe("working"); // 最近一次工具调用是 bash

    const s2 = snap.actors.find((a) => a.id === "session:s2")!;
    expect(s2.kind).toBe("session");
    expect(s2.roleLabel).toContain("分支会话");
    expect(s2.activity).toBe("idle");

    const s3 = snap.actors.find((a) => a.id === "session:s3")!;
    expect(s3.activity).toBe("sleeping"); // 5 天没动
  });

  it("LO-ADP-2: 团队成员 → 角色（已移除成员不出现），任务指标正确", () => {
    const snap = collectSnapshotSync(baseDeps());
    const names = snap.actors.filter((a) => a.kind === "member").map((a) => a.name);
    expect(names).toContain("小前");
    expect(names).toContain("小研");
    expect(names).toContain("小离");
    expect(names).not.toContain("小走"); // removed

    const qian = snap.actors.find((a) => a.id === "member:c1")!;
    expect(qian.activity).toBe("working");
    expect(qian.metrics.tasks).toBe(1);
    expect(qian.metrics.done).toBe(0);
    expect(qian.focus).toBe("实现登录页");
    expect(qian.preferredZoneId).toBe("code-forge");

    const li = snap.actors.find((a) => a.id === "member:c3")!;
    expect(li.activity).toBe("sleeping"); // absent
    expect(li.metrics.failed).toBe(1);
  });

  it("LO-ADP-3: 子智能体 → 角色，运行中按最近活动映射动作", () => {
    const snap = collectSnapshotSync(baseDeps());
    const running = snap.actors.find((a) => a.id === "subagent:sub-1")!;
    expect(running.kind).toBe("subagent");
    expect(running.activity).toBe("reading"); // 最近 activity label = grep
    expect(running.focus).toBe("grep");

    const done = snap.actors.find((a) => a.id === "subagent:sub-2")!;
    expect(done.activity).toBe("done");
  });

  it("LO-ADP-4: 团队模板角色补位；完全无数据时出现「值班馆员」", () => {
    const snap = collectSnapshotSync(baseDeps());
    const tpl = snap.actors.find((a) => a.id === "template:squad-1:小笔")!;
    expect(tpl).toBeTruthy();
    expect(tpl.activity).toBe("idle");
    expect(tpl.preferredZoneId).toBe("writing-studio");

    const empty = collectSnapshotSync({
      now: () => NOW,
      projectState: () => ({ projects: [], sessions: [], currentProject: null, currentSession: null }),
      appState: () => ({ messages: [], activeSessions: new Set(), llmStatus: "idle", stepProgress: null, agentActivities: [] }),
      teams: () => [],
      subagentTasks: () => [],
      costStats: () => null,
      squads: () => [],
      agentDefs: () => [],
      telemetryEvents: () => [],
    });
    expect(empty.actors.length).toBe(1);
    expect(empty.actors[0].id).toBe("system:library-clerk");
    expect(empty.actors[0].kind).toBe("system");
  });

  it("LO-ADP-5: 指标聚合 —— 任务/工具/错误/文件/成本/消息", () => {
    const snap = collectSnapshotSync(baseDeps());
    const m = snap.metrics;
    expect(m.sessions).toBe(3);
    expect(m.activeSessions).toBe(1);
    expect(m.teams).toBe(1);
    expect(m.tasksTotal).toBe(4);
    expect(m.tasksDone).toBe(1);
    expect(m.tasksFailed).toBe(1);
    expect(m.tasksRunning).toBe(1);
    expect(m.tasksPending).toBe(1);
    expect(m.toolCalls).toBe(3);
    expect(m.toolErrors).toBe(1);
    expect(m.filesTouched).toBe(1); // src/a.ts（generatedFiles + write 去重）
    expect(m.messages).toBe(2);
    expect(m.costTotal).toBe(3.5);
    expect(m.costToday).toBe(1.25);
    expect(m.tokensIn).toBe(120_000);
    expect(m.tokensOut).toBe(30_000);
    expect(m.actors).toBe(snap.actors.length);
    expect(m.actorsWorking).toBeGreaterThan(0);
  });

  it("LO-ADP-6: 事件流按时间倒序、id 去重、包含工具/任务/角色/遥测", () => {
    const snap = collectSnapshotSync(baseDeps());
    const ids = snap.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < snap.events.length; i++) {
      expect(snap.events[i - 1].at).toBeGreaterThanOrEqual(snap.events[i].at);
    }
    const kinds = new Set(snap.events.map((e) => e.kind));
    expect(kinds.has("tool")).toBe(true);
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("system")).toBe(true);
    // 失败工具事件严重度为 bad
    const badTool = snap.events.find((e) => e.kind === "tool" && e.severity === "bad");
    expect(badTool).toBeTruthy();
  });

  it("LO-ADP-7: 活动分布 —— 14 天补齐、小时分桶、会话类型", () => {
    const snap = collectSnapshotSync(baseDeps());
    expect(Object.keys(snap.activity.perDay).length).toBe(14);
    expect(snap.activity.perHour.length).toBe(24);
    expect(snap.activity.kinds.captain).toBe(1);
    expect(snap.activity.kinds.worktree).toBe(1);
    expect(snap.activity.kinds.chat).toBe(1);
    const hourSum = snap.activity.perHour.reduce((a, b) => a + b, 0);
    expect(hourSum).toBeGreaterThan(0);
  });

  it("LO-ADP-8: 依赖抛错 → 记入 sources.failed，不抛出（失败可见性）", () => {
    const snap = collectSnapshotSync(
      baseDeps({
        teams: () => {
          throw new Error("agent-teams 未初始化");
        },
        costStats: () => {
          throw new Error("cost tracker 不可用");
        },
      }),
    );
    expect(snap.sources.failed).toContain("agentTeams");
    expect(snap.sources.failed).toContain("costTracker");
    expect(snap.metrics.costTotal).toBe(0);
    expect(snap.actors.length).toBeGreaterThan(0); // 其余来源照常
  });

  it("LO-ADP-9: health 计算 —— 全绿偏高、全错偏低、无数据中性", () => {
    const good = computeHealth({
      sessions: 1, activeSessions: 1, teams: 1, tasksTotal: 10, tasksDone: 10, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: 4, actorsWorking: 4, actorsIdle: 0, actorsBlocked: 0,
      actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0, costToday: 0,
      toolCalls: 100, toolErrors: 0, filesTouched: 0, messages: 0, health: 1,
    });
    const bad = computeHealth({
      sessions: 1, activeSessions: 0, teams: 1, tasksTotal: 10, tasksDone: 0, tasksFailed: 10,
      tasksRunning: 0, tasksPending: 0, actors: 4, actorsWorking: 0, actorsIdle: 0, actorsBlocked: 0,
      actorsError: 4, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0, costToday: 0,
      toolCalls: 100, toolErrors: 60, filesTouched: 0, messages: 0, health: 1,
    });
    expect(good).toBeGreaterThan(0.8);
    expect(bad).toBeLessThan(0.5);
    expect(good).toBeGreaterThan(bad);
    const neutral = computeHealth({
      sessions: 0, activeSessions: 0, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: 0, actorsWorking: 0, actorsIdle: 0, actorsBlocked: 0,
      actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0, costToday: 0,
      toolCalls: 0, toolErrors: 0, filesTouched: 0, messages: 0, health: 1,
    });
    expect(neutral).toBeGreaterThan(0.4);
    expect(neutral).toBeLessThan(0.8);
  });

  it("LO-ADP-10: toolToActivity 映射覆盖主要工具族", () => {
    expect(toolToActivity("read")).toBe("reading");
    expect(toolToActivity("grep")).toBe("reading");
    expect(toolToActivity("glob")).toBe("reading");
    expect(toolToActivity("write")).toBe("writing");
    expect(toolToActivity("edit")).toBe("writing");
    expect(toolToActivity("multi_edit")).toBe("writing");
    expect(toolToActivity("bash")).toBe("working");
    expect(toolToActivity("run_code")).toBe("working");
    expect(toolToActivity("web_search")).toBe("searching");
    expect(toolToActivity("zvec_grep_search")).toBe("searching");
    expect(toolToActivity("ask_user_question")).toBe("blocked");
    expect(toolToActivity("exit_plan_mode")).toBe("blocked");
    expect(toolToActivity("spawn_subagent")).toBe("thinking");
    expect(toolToActivity("agent_teams_create")).toBe("thinking");
    expect(toolToActivity("update_plan")).toBe("thinking");
    expect(toolToActivity("load_skill")).toBe("reading");
    expect(toolToActivity("unknown_tool_xyz")).toBe("working");
  });

  it("LO-ADP-11: 适配层只读 —— 依赖对象在采集前后不变（零写入）", () => {
    const ps = projectState();
    const app = appState();
    const t = teams();
    const before = JSON.stringify({ ps, app, t });
    collectSnapshotSync(baseDeps({ projectState: () => ps, appState: () => app, teams: () => t }));
    expect(JSON.stringify({ ps, app, t })).toBe(before);
  });

  it("LO-ADP-12: 依赖缺省（全部 undefined）也不崩，产出可渲染快照", () => {
    const snap = collectSnapshotSync({ now: () => NOW });
    expect(snap.actors.length).toBe(1);
    expect(snap.metrics.sessions).toBe(0);
    expect(snap.sources.failed).toEqual([]);
    expect(snap.events.length).toBeGreaterThanOrEqual(1);
  });

  it("LO-ADP-13: activeSessions 为宿主真实形态 Map<id,boolean> 时也能识别活跃会话", () => {
    const snap = collectSnapshotSync(
      baseDeps({
        appState: () => ({ ...appState(), activeSessions: new Map([["s1", true]]) }),
      }),
    );
    expect(snap.metrics.activeSessions).toBe(1);
    const s1 = snap.actors.find((a) => a.id === "session:s1")!;
    // 活跃会话按最近工具映射（bash → working），而不是退化为 idle
    expect(s1.activity).toBe("working");
    // 未标记的会话不受影响
    const s2 = snap.actors.find((a) => a.id === "session:s2")!;
    expect(s2.activity).toBe("idle");
  });
});
