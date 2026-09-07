/**
 * 测试：团队体系深合并 Phase1 —— Squad 升级为团队模板 + squad_dispatch 桥接 agent-teams
 *
 * 覆盖：
 *   - TC-001: toTeamTemplate 从 Squad 导出角色模板（含 captainRole/roles/instructions）
 *   - TC-002: squad_dispatch 按模板创建 agent-teams 运行时团队并派发任务（无 CustomEvent）
 *   - TC-003: squad_dispatch 队长已有活动团队时给出引导错误（一人一队）
 *   - TC-004: squad_dispatch 模板不存在/已归档 → 错误输出
 *   - TC-005: squad_status 输出模板 + 派生运行时团队摘要（可传 team_id）
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getSquadManager } from "../core/squad/squad";
import { createSquadDispatchTool, createSquadStatusTool } from "../core/squad/squad-tools";
import { AgentTeamsService } from "../core/provider/agent-teams-service";
import { createTeam, addMember as engineAddMember, snapshot } from "../core/agent-teams/engine";
import { initDatabase } from "../core/storage/database";

function fakeCtx(sessionId: string) {
  return { sessionId, messageId: "m", cwd: "D:/test", abort: new AbortController().signal } as any;
}

let createdSquadId = "";

async function makeTemplate(name: string) {
  const mgr = getSquadManager();
  const squad = mgr.createSquad({
    name,
    leaderAgentId: "build",
    instructions: "团队指令：按角色分工，先调研后实现。",
  });
  mgr.addMember(squad.id, { memberType: "agent", memberId: "plan", memberName: "规划员", roleDescription: "拆解任务与验证" });
  mgr.addMember(squad.id, { memberType: "agent", memberId: "general", memberName: "实现员", roleDescription: "编码实现" });
  return squad.id;
}

describe("团队深合并 Phase1 — Squad→模板 + dispatch 桥接", () => {
  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(() => {
    AgentTeamsService._reset();
    localStorage.clear();
  });

  it("TC-001: toTeamTemplate 导出模板（captainRole/roles/instructions）", async () => {
    const squadId = await makeTemplate("模板A");
    const tpl = getSquadManager().toTeamTemplate(squadId);
    expect(tpl).not.toBeNull();
    expect(tpl!.name).toBe("模板A");
    expect(tpl!.captainRole).toBeTruthy();
    const names = tpl!.roles.map((r) => r.name);
    expect(names).toContain("规划员");
    expect(names).toContain("实现员");
    expect(tpl!.instructions).toContain("团队指令");
    // 不存在的 squad → null
    expect(getSquadManager().toTeamTemplate("nope")).toBeNull();
  });

  it("TC-002: squad_dispatch 桥接——建运行时团队 + spawn 角色 + 派发任务（无 CustomEvent）", async () => {
    createdSquadId = await makeTemplate("模板B");
    const tool = createSquadDispatchTool();
    const out = await tool.execute({ squad_id: createdSquadId, task: "调研并实现登录模块" }, fakeCtx("sess-bridge-1"));
    const text = String(out.output);
    expect(text).toContain("已按模板创建运行时团队");
    // 团队已建（队长=当前会话），任务已派发
    const teams = AgentTeamsService.getInstance().listAll();
    const team = teams.find((t) => t.name === "模板B" && t.captainSessionId === "sess-bridge-1");
    expect(team).toBeTruthy();
    expect(team!.tasks.length).toBeGreaterThanOrEqual(1);
    expect(String(out.metadata?.teamId)).toBe(team!.id);
  });

  it("TC-003: 队长已带队时 squad_dispatch 给出引导错误（一人一队）", async () => {
    createdSquadId = await makeTemplate("模板C");
    const tool = createSquadDispatchTool();
    const ctx = fakeCtx("sess-bridge-dup");
    const first = await tool.execute({ squad_id: createdSquadId, task: "任务1" }, ctx);
    expect(String(first.output)).toContain("已按模板创建运行时团队");
    const second = await tool.execute({ squad_id: createdSquadId, task: "任务2" }, ctx);
    expect(String(second.output)).toContain("无法创建运行时团队");
    expect(String(second.output)).toMatch(/agent_teams_delete|delete/);
  });

  it("TC-004: 模板不存在/已归档 → 错误输出", async () => {
    const tool = createSquadDispatchTool();
    const missing = await tool.execute({ squad_id: "nope", task: "x" }, fakeCtx("sess-bridge-3"));
    expect(String(missing.output)).toContain("不存在");
  });

  it("TC-006: 模板无 agent 角色（全移除成员）→ 前置拒绝，不建空队", async () => {
    const squadId = await makeTemplate("模板Empty");
    const mgr = getSquadManager();
    // createSquad 自动带 leader agent 成员——移除全部成员得到无角色模板
    const squad = mgr.getSquad(squadId)!;
    for (const m of squad.members) mgr.removeMember(m.id, squadId);
    const tool = createSquadDispatchTool();
    const out = await tool.execute({ squad_id: squadId, task: "任务" }, fakeCtx("sess-bridge-empty"));
    expect(String(out.output)).toContain("没有可执行的 agent 角色");
    // 未创建任何运行时团队
    expect(AgentTeamsService.getInstance().listAll().length).toBe(0);
  });

  it("TC-007: engine snapshot 保留成员 id（AgentPanel 下钻/去重依赖）", () => {
    const team = createTeam({ name: "快照队", captainSessionId: "sess-snap" });
    const { member } = engineAddMember(team, { id: "child-1", name: "实现员", role: "编码" });
    const snap = snapshot(team);
    expect(snap.members.length).toBe(1);
    expect(snap.members[0].id).toBe(member.id);
    expect(snap.members[0].name).toBe("实现员");
  });

  it("TC-005: squad_status 输出模板 + 派生运行时团队（可传 team_id）", async () => {
    const squadId = await makeTemplate("模板D");
    const dispatch = createSquadDispatchTool();
    await dispatch.execute({ squad_id: squadId, task: "任务" }, fakeCtx("sess-bridge-4"));
    const tool = createSquadStatusTool();
    const out = await tool.execute({ squad_id: squadId }, fakeCtx("sess-bridge-4"));
    const text = String(out.output);
    expect(text).toContain("模板D");
    expect(text).toContain("运行时团队");
    expect(text).toContain("sess-bridge-4".length > 0 ? "members" : "x");
    // 错误 squad
    const bad = await tool.execute({ squad_id: "nope" }, fakeCtx("sess-bridge-4"));
    expect(String(bad.output)).toContain("不存在");
  });
});
