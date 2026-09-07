/**
 * 测试：@codem/agent-teams 服务层（B3）— 无 subagent runtime 时的降级语义
 *
 * 覆盖 TEAMSVC-001 ~ TEAMSVC-006：
 *   - TEAMSVC-001: create 团队 + 一人一队限制
 *   - TEAMSVC-002: 加成员（无 runtime → status absent 或 idle）
 *   - TEAMSVC-003: createTask + claim/update 全链路（无唤醒，任务回滚保持 pending）
 *   - TEAMSVC-004: 队长身份 activeTeamOf
 *   - TEAMSVC-005: deleteTeam 归档
 *   - TEAMSVC-006: 订阅通知触发
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentTeamsService } from "../core/provider/agent-teams-service";

const svc = () => AgentTeamsService.getInstance();

describe("agent-teams 服务层", () => {
  beforeEach(() => {
    AgentTeamsService._reset();
  });

  it("TEAMSVC-001: create 团队；同队长二次建队被拒", () => {
    const t1 = svc().create({ name: "组A", captainSessionId: "cap-1" });
    expect(t1.captainSessionId).toBe("cap-1");
    expect(() => svc().create({ name: "组B", captainSessionId: "cap-1" })).toThrow(/already leads/);
    // 不同队长可建
    const t2 = svc().create({ name: "组C", captainSessionId: "cap-2" });
    expect(svc().listAll()).toHaveLength(2);
  });

  it("TEAMSVC-002: 加成员（无 runtime → absent）；重名拒绝", async () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    const { member } = await svc().addMember(team.id, {
      name: "研究员", role: "调研", parentSessionId: "cap-1",
    });
    expect(member.name).toBe("研究员");
    // 无 runtime 时成员状态为 absent（spawn 失败降级）或 idle
    expect(["absent", "idle"]).toContain(member.status);
    await expect(svc().addMember(team.id, { name: "研究员", parentSessionId: "cap-1" })).rejects.toThrow(/already exists/);
  });

  it("TEAMSVC-003: 任务 create→claim→update 全链路（无 runtime 回滚语义）", async () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    await svc().addMember(team.id, { name: "研究员", parentSessionId: "cap-1" });
    const { task } = svc().createTask(team.id, { subject: "写报告", assignee: "研究员" });
    expect(task.id).toBe("t1");

    // claim（队长代领）
    const r = svc().claim(team.id, "t1", "研究员");
    expect(r.attempt).toBe(1);
    expect(r.attemptId).toBeTruthy();

    // 更新：in_progress → completed
    const { task: t2 } = svc().update(team.id, "t1", {
      status: "in_progress", attemptId: r.attemptId, by: "研究员",
    });
    expect(t2.status).toBe("in_progress");
    const { task: t3 } = svc().update(team.id, "t1", {
      status: "completed", attemptId: r.attemptId, by: "研究员", output: "完成",
    });
    expect(t3.status).toBe("completed");
    expect(t3.output).toBe("完成");
  });

  it("TEAMSVC-004: activeTeamOf 返回队长当前活动团队", async () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-9" });
    expect(svc().activeTeamOf("cap-9")?.id).toBe(team.id);
    expect(svc().activeTeamOf("cap-nobody")).toBeUndefined();
  });

  it("TEAMSVC-005: deleteTeam 归档（listAll 不再返回，status 仍可读）", () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    svc().deleteTeam(team.id);
    expect(svc().listAll()).toHaveLength(0);
    // 归档后仍可查询（保留记录）
    expect(svc().status(team.id).id).toBe(team.id);
  });

  it("TEAMSVC-006: 变更订阅被触发", () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    let fired = 0;
    const unsub = svc().subscribe(() => { fired++; });
    svc().createTask(team.id, { subject: "任务" });
    expect(fired).toBeGreaterThanOrEqual(1);
    unsub();
    const before = fired;
    svc().createTask(team.id, { subject: "任务2" });
    expect(fired).toBe(before); // 取消订阅后不再通知
  });
});
