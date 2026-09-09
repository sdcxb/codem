/**
 * LO-REAL — 与宿主真实服务的端到端联动（不使用 fake 适配层）
 *
 * 这是「插件是否真的和团队 / 子智能体功能联动」的审计证据：
 * 直接驱动真实的 `AgentTeamsService`、`SquadManager`、`AgentRegistry`、
 * `CostTracker` 与真实 store，再经 `loadDefaultDeps()` 的真实依赖加载路径
 * 采集快照，断言图书馆里出现的角色 / 岗位 / 状态与宿主一致。
 *
 * 覆盖：
 * - LO-REAL-1 真实建队 + 加成员 + 建任务 → kick 派活 → 快照里出现队长与成员角色（成员 working）
 * - LO-REAL-2 任务完成 → 成员释放回 idle（宿主修复回归）
 * - LO-REAL-3 真实团队模板（SquadManager）→ 模板角色出现在馆内待命
 * - LO-REAL-4 真实 AgentRegistry / CostTracker 接线
 * - LO-REAL-5 loadDefaultDeps 每个来源都能取到正确形状
 * - LO-REAL-6 子智能体任务形状与适配层契约一致
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { setGlobalSubagentRuntime } from "../core/subagent";
import { flushDatabase } from "../core/storage/database";
import { loadDefaultDeps, collectSnapshotSync, type AdapterDeps } from "../plugins/library-ops/core/telemetry-adapter";

const SESSION_ID = "sess-real-1";

/** 最小可用的子智能体 runtime 桩：让 addMember / kick 的唤醒路径成立 */
function fakeRuntime() {
  const children: Array<{ id: string; label: string; status: string }> = [];
  return {
    children,
    startContinuable: async (spec: any) => {
      const childId = `child-${spec.label}-${children.length + 1}`;
      children.push({ id: childId, label: spec.label, status: "idle" });
      return { childId, messageId: `msg-${childId}` };
    },
    followup: async () => "delivered",
    getAllTasks: () =>
      children.map((c) => ({
        id: c.id,
        name: c.label,
        parentId: SESSION_ID,
        agentId: "general",
        status: c.status === "idle" ? "running" : "completed",
        createdAt: Date.now() - 1000,
        startedAt: Date.now() - 900,
        activities: [{ id: "a1", type: "tool", label: "grep", status: "running", startedAt: Date.now() - 100 }],
      })),
    listChildren: () => children.map((c) => ({ id: c.id, label: c.label, status: "idle" })),
  };
}

async function seedHost() {
  const { useProjectStore } = await import("../core/store");
  const { useAppStore } = await import("../store");

  const session = {
    id: SESSION_ID,
    projectId: "proj-1",
    title: "图书馆联动审计会话",
    createdAt: Date.now() - 60_000,
    lastMessageAt: Date.now() - 1000,
    messageCount: 6,
    model: "deepseek-v4",
  };
  useProjectStore.setState({
    projects: [{ id: "proj-1", name: "mimo-gui", path: "C:/mimo-gui", createdAt: 0, lastAccessedAt: 0 }],
    sessions: [session as any],
    currentProject: { id: "proj-1", name: "mimo-gui", path: "C:/mimo-gui", createdAt: 0, lastAccessedAt: 0 } as any,
    currentSession: session as any,
  });
  useAppStore.setState({
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 500,
        toolCalls: [
          { id: "t1", tool: "write", args: { file_path: "src/a.ts" }, status: "done" },
          { id: "t2", tool: "bash", args: { command: "npm test" }, status: "done" },
        ],
        generatedFiles: ["src/a.ts"],
      },
    ],
    activeSessions: new Map([[SESSION_ID, true]]),
    llmStatus: "executing_tools",
  });
  return { useProjectStore, useAppStore };
}

async function collectReal(extra: Partial<AdapterDeps> = {}) {
  const deps = await loadDefaultDeps();
  return collectSnapshotSync({ ...deps, ...extra });
}

describe("LO-REAL 与真实团队 / 子智能体联动", () => {
  beforeEach(async () => {
    localStorage.clear();
    const { AgentTeamsService } = await import("../core/provider/agent-teams-service");
    AgentTeamsService._reset();
    setGlobalSubagentRuntime(fakeRuntime() as any);
    await seedHost();
  });

  afterEach(() => {
    setGlobalSubagentRuntime(null);
  });

  // worker 收尾竞态规避：本文件驱动真实服务（SquadStorage / CostTracker）会写内存 DB
  // 并触发 500ms 防抖持久化；不清掉定时器就结束文件会触发
  // "Worker exited unexpectedly"（与 src/test/setup.ts 的 afterAll 同一处理思路）
  afterAll(async () => {
    try {
      await flushDatabase();
    } catch {
      /* 浏览器模式下无落盘，忽略 */
    }
    await new Promise((r) => setTimeout(r, 200));
  });

  it("LO-REAL-1: 真实建队 + 加成员 + 建任务 → kick 派活 → 快照出现队长与工作中成员", async () => {
    const { AgentTeamsService } = await import("../core/provider/agent-teams-service");
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "审计小队", captainSessionId: SESSION_ID });
    const { member } = await svc.addMember(team.id, {
      name: "小前",
      role: "前端实现",
      parentSessionId: SESSION_ID,
    });
    expect(member.status).toBe("idle");

    // 建任务（assignee 未指定 → 共享池）→ kick 应把任务派给空闲成员
    svc.createTask(team.id, { subject: "实现登录页" });
    const afterKick = svc.status(team.id);
    expect(afterKick.members.find((m) => m.name === "小前")?.status).toBe("working");
    expect(afterKick.tasks[0].status).toBe("claimed");
    expect(afterKick.tasks[0].assignee).toBe("小前");

    const snap = await collectReal();

    // 队长角色（会话 s1 带团队）
    const captain = snap.actors.find((a) => a.id === `session:${SESSION_ID}`)!;
    expect(captain).toBeTruthy();
    expect(captain.kind).toBe("captain");
    expect(captain.teamName).toBe("审计小队");
    expect(captain.metrics.tasks).toBe(1);

    // 成员角色：真实状态 working → 图书馆里也是工作中，且落在代码工坊
    const front = snap.actors.find((a) => a.kind === "member" && a.name === "小前")!;
    expect(front).toBeTruthy();
    expect(front.activity).toBe("working");
    expect(front.focus).toBe("实现登录页");
    expect(front.preferredZoneId).toBe("code-forge");
    expect(front.metrics.tasks).toBe(1);

    // 指标与团队一致
    expect(snap.metrics.teams).toBe(1);
    expect(snap.metrics.tasksTotal).toBe(1);
    expect(snap.metrics.tasksRunning).toBe(1);
    expect(snap.sources.teams).toBe(1);
    expect(snap.sources.teamMembers).toBeGreaterThanOrEqual(1);
  });

  it("LO-REAL-2: 任务完成 → 成员释放回 idle（宿主修复回归），快照同步为待命", async () => {
    const { AgentTeamsService } = await import("../core/provider/agent-teams-service");
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "审计小队", captainSessionId: SESSION_ID });
    await svc.addMember(team.id, { name: "小前", role: "前端实现", parentSessionId: SESSION_ID });
    svc.createTask(team.id, { subject: "实现登录页" });
    expect(svc.status(team.id).members[0].status).toBe("working");

    const taskId = svc.status(team.id).tasks[0].id;
    // 状态机要求 claimed → in_progress → completed
    svc.update(team.id, taskId, { status: "in_progress", by: "小前" });
    svc.update(team.id, taskId, { status: "completed", by: "小前", output: "done" });
    const after = svc.status(team.id);
    expect(after.tasks[0].status).toBe("completed");
    // 关键：成员不再卡在 working
    expect(after.members[0].status).toBe("idle");

    const snap = await collectReal();
    const front = snap.actors.find((a) => a.kind === "member" && a.name === "小前")!;
    expect(front.activity).toBe("idle");
    expect(front.metrics.done).toBe(1);
    expect(snap.metrics.tasksDone).toBe(1);
  });

  it("LO-REAL-2b: 成员名下有多个任务时，完成一个不会误释放（仍 working）", async () => {
    const { AgentTeamsService } = await import("../core/provider/agent-teams-service");
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "审计小队", captainSessionId: SESSION_ID });
    await svc.addMember(team.id, { name: "小前", role: "前端实现", parentSessionId: SESSION_ID });
    // 两个任务都指定给小前
    svc.createTask(team.id, { subject: "任务A", assignee: "小前" });
    svc.createTask(team.id, { subject: "任务B", assignee: "小前" });
    const tasks = svc.status(team.id).tasks;
    svc.claim(team.id, tasks[0].id, "小前");
    svc.update(team.id, tasks[0].id, { status: "in_progress", by: "小前" });
    svc.update(team.id, tasks[0].id, { status: "completed", by: "小前" });
    // 还有一个非终态任务 → 不能释放
    expect(svc.status(team.id).members[0].status).toBe("working");
  });

  it("LO-REAL-3: 真实团队模板（SquadManager）→ 模板角色入馆待命并落在对应岗位", async () => {
    const { getSquadManager } = await import("../core/squad/squad");
    const mgr = getSquadManager();
    const squad = mgr.createSquad({ name: "文档小队", leaderAgentId: "general", instructions: "写文档" });
    mgr.addMember(squad.id, {
      memberType: "agent",
      memberId: "writer",
      memberName: "小笔",
      roleDescription: "文档写作",
    });

    const snap = await collectReal();
    const tpl = snap.actors.find((a) => a.kind === "member" && a.name === "小笔")!;
    expect(tpl).toBeTruthy();
    expect(tpl.activity).toBe("idle");
    expect(tpl.preferredZoneId).toBe("writing-studio");
    expect(snap.sources.teamTemplates).toBeGreaterThanOrEqual(1);
  });

  it("LO-REAL-4: 真实 AgentRegistry / CostTracker 接线（成本进入指标）", async () => {
    const { getCostTracker } = await import("../core/llm/cost-tracker");
    const tracker = getCostTracker();
    tracker.clear();
    tracker.recordUsage({
      sessionId: SESSION_ID,
      model: "deepseek-v4",
      provider: "deepseek",
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      duration: 1200,
    } as any);

    const snap = await collectReal();
    expect(snap.metrics.tokensIn).toBeGreaterThanOrEqual(1000);
    expect(snap.metrics.tokensOut).toBeGreaterThanOrEqual(500);

    const { getAgentRegistry } = await import("../core/agent/agent");
    expect(getAgentRegistry().getAll().length).toBeGreaterThan(0);
    expect(snap.sources.agentProfiles).toBeGreaterThan(0);
  });

  it("LO-REAL-5: loadDefaultDeps 每个来源都能取到正确形状（无断链）", async () => {
    const deps = await loadDefaultDeps();
    expect(typeof deps.projectState).toBe("function");
    expect(typeof deps.appState).toBe("function");
    expect(typeof deps.teams).toBe("function");
    expect(typeof deps.subagentTasks).toBe("function");
    expect(typeof deps.costStats).toBe("function");
    expect(typeof deps.squads).toBe("function");
    expect(typeof deps.agentDefs).toBe("function");
    expect(typeof deps.telemetryEvents).toBe("function");

    // 逐个调用，形状正确且不抛
    expect(Array.isArray(deps.projectState!()!.sessions)).toBe(true);
    expect(deps.appState!()!.activeSessions).toBeInstanceOf(Map);
    expect(Array.isArray(deps.teams!())).toBe(true);
    expect(Array.isArray(deps.subagentTasks!())).toBe(true);
    const cost = deps.costStats!()!;
    expect(typeof cost.totalCost).toBe("number");
    expect(typeof cost.totalInputTokens).toBe("number");
    expect(Array.isArray(deps.squads!())).toBe(true);
    expect(Array.isArray(deps.agentDefs!())).toBe(true);
    expect(Array.isArray(deps.telemetryEvents!([SESSION_ID]))).toBe(true);
  });

  it("LO-REAL-6: 真实 SubagentTask 形状（经 runtime）→ 子智能体角色正确入馆", async () => {
    const rt = fakeRuntime();
    setGlobalSubagentRuntime(rt as any);
    await rt.startContinuable({ label: "team:小前", request: {}, signal: new AbortController().signal });
    const snap = await collectReal();
    const sub = snap.actors.find((a) => a.kind === "subagent")!;
    expect(sub).toBeTruthy();
    expect(sub.activity).toBe("reading"); // 最近 activity = grep
    expect(sub.preferredZoneId).toBe("reading-hall");
    expect(snap.sources.subagents).toBe(1);
  });

  it("LO-REAL-7: 团队删除/归档后不再出现在快照（不残留幽灵角色）", async () => {
    const { AgentTeamsService } = await import("../core/provider/agent-teams-service");
    const svc = AgentTeamsService.getInstance();
    const team = svc.create({ name: "临时小队", captainSessionId: SESSION_ID });
    await svc.addMember(team.id, { name: "小临", role: "前端实现", parentSessionId: SESSION_ID });
    expect((await collectReal()).actors.some((a) => a.name === "小临")).toBe(true);

    svc.deleteTeam(team.id);
    const snap = await collectReal();
    expect(snap.actors.some((a) => a.name === "小临")).toBe(false);
    expect(snap.metrics.teams).toBe(0);
    // 队长角色仍在（只是不再是 captain）
    const captain = snap.actors.find((a) => a.id === `session:${SESSION_ID}`)!;
    expect(captain.kind).toBe("session");
  });
});
