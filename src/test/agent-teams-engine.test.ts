/**
 * 测试：@codem/agent-teams 引擎纯逻辑层（B3，对标 EAC dsh-agent-teams）
 *
 * 覆盖 TEAM-001 ~ TEAM-014：
 * 建队/成员/任务：TEAM-001~004
 * 依赖与领取：TEAM-005~008
 * attempt 防覆盖：TEAM-009~011
 * 转派与回滚：TEAM-012~013
 * 邮箱：TEAM-014
 */
import { describe, it, expect } from "vitest";
import {
  createTeam, addMember, createTask, claimTask, updateTask, beginReassign,
  finishReassign, rollbackClaim, removeMember, nextReadyTask, depsSatisfied,
  appendMailbox, unreadMailbox, claimMailbox, acknowledgeMailbox, releaseMailbox,
  snapshot,
} from "../core/agent-teams/engine";

function makeTeam() {
  const team = createTeam({ name: "审计组", captainSessionId: "cap-session" });
  addMember(team, { id: "child-1", name: "研究员", role: "调研" });
  addMember(team, { id: "child-2", name: "工程师", role: "实现" });
  return team;
}

describe("agent-teams 引擎 — 基础", () => {
  it("TEAM-001: 建队 + 加成员", () => {
    const team = makeTeam();
    expect(team.id).toMatch(/^team-/);
    expect(team.members).toHaveLength(2);
    expect(team.members[0].name).toBe("研究员");
    expect(team.members[0].status).toBe("idle");
  });

  it("TEAM-002: 重名成员拒绝", () => {
    const team = makeTeam();
    expect(() => addMember(team, { id: "x", name: "研究员" })).toThrow(/already exists/);
  });

  it("TEAM-003: 建任务 id 自增 t1/t2；无效 assignee 拒绝", () => {
    const team = makeTeam();
    createTask(team, { subject: "调研 A", assignee: "研究员" });
    createTask(team, { subject: "实现 B" });
    expect(team.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(() => createTask(team, { subject: "X", assignee: "不存在的人" })).toThrow(/not a member/);
  });

  it("TEAM-004: 依赖不存在的任务拒绝", () => {
    const team = makeTeam();
    expect(() => createTask(team, { subject: "X", dependencies: ["t99"] })).toThrow(/does not exist/);
  });
});

describe("agent-teams 引擎 — 依赖与领取", () => {
  it("TEAM-005: 依赖未完成不可领取", () => {
    const team = makeTeam();
    createTask(team, { subject: "调研 A" });                              // t1
    createTask(team, { subject: "实现 B", dependencies: ["t1"] });       // t2
    expect(depsSatisfied(team, team.tasks[1])).toBe(false);
    expect(() => claimTask(team, "t2", "工程师")).toThrow(/unsatisfied dependencies/);
  });

  it("TEAM-006: 依赖完成后可领取；共享池任务任一成员可领", () => {
    const team = makeTeam();
    createTask(team, { subject: "调研 A" });
    createTask(team, { subject: "实现 B", dependencies: ["t1"] });
    // 研究员完成 t1（claimed → in_progress → completed）
    const { attemptId } = claimTask(team, "t1", "研究员");
    updateTask(team, "t1", { status: "in_progress", attemptId, by: "研究员" });
    updateTask(team, "t1", { status: "completed", attemptId, by: "研究员" });
    expect(depsSatisfied(team, team.tasks[1])).toBe(true);
    const r = claimTask(team, "t2", "工程师");
    expect(r.attempt).toBe(1);
    expect(team.tasks[1].status).toBe("claimed");
  });

  it("TEAM-007: 已被他人认领不可再领", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    claimTask(team, "t1", "研究员");
    expect(() => claimTask(team, "t1", "工程师")).toThrow(/assigned to "研究员"/);
  });

  it("TEAM-008: 幂等领取返回同一 attemptId", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    const first = claimTask(team, "t1", "研究员");
    const second = claimTask(team, "t1", "研究员");
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.attempt).toBe(1); // 不重复 ++
  });
});

describe("agent-teams 引擎 — attempt 防覆盖", () => {
  it("TEAM-009: 旧 attempt 更新被拒（stale）", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    const old = claimTask(team, "t1", "研究员");
    // 转派给工程师并完成新 attempt
    beginReassign(team, "t1", "工程师");
    const r = finishReassign(team, "t1", "工程师");
    // 研究员用旧 attemptId 更新 → stale
    expect(() => updateTask(team, "t1", { status: "completed", attemptId: old.attemptId, by: "研究员" })).toThrow(/stale attempt/);
    expect(r.task.status).toBe("claimed");
  });

  it("TEAM-010: 携带正确 attemptId 可推进 in_progress → completed", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    const { attemptId } = claimTask(team, "t1", "研究员");
    updateTask(team, "t1", { status: "in_progress", attemptId, by: "研究员" });
    updateTask(team, "t1", { status: "completed", attemptId, by: "研究员", output: "完成摘要" });
    expect(team.tasks[0].status).toBe("completed");
    expect(team.tasks[0].output).toBe("完成摘要");
    expect(team.tasks[0].attemptId).toBeUndefined(); // 终态清令牌
  });

  it("TEAM-011: 非法迁移拒绝（pending → completed 必须经 claim）", () => {
    const team = makeTeam();
    createTask(team, { subject: "A" });
    expect(() => updateTask(team, "t1", { status: "completed", by: "研究员" })).toThrow(/invalid transition/);
  });
});

describe("agent-teams 引擎 — 转派/回滚/移除", () => {
  it("TEAM-012: 转派 = 撤销旧 attempt → 静默 → 新 attempt", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    claimTask(team, "t1", "研究员");
    const { previousAssignee } = beginReassign(team, "t1", "工程师");
    expect(previousAssignee).toBe("研究员");
    expect(team.tasks[0].reassigning).toBe(true);
    expect(team.tasks[0].attemptId).toBeUndefined();
    const r = finishReassign(team, "t1", "工程师");
    expect(r.task.assignee).toBe("工程师");
    expect(r.task.attempt).toBe(2); // 新代
  });

  it("TEAM-013: 投递失败回滚仅当 attemptId 一致（防并发覆盖）", () => {
    const team = makeTeam();
    createTask(team, { subject: "A" });
    const { attemptId } = claimTask(team, "t1", "工程师");
    rollbackClaim(team, "t1", attemptId);
    expect(team.tasks[0].status).toBe("pending");
    expect(team.tasks[0].attemptId).toBeUndefined();
    expect(nextReadyTask(team, "研究员")?.id).toBe("t1"); // 回池可再领
  });

  it("TEAM-013b: 移除成员撤销其未完成任务回池", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    claimTask(team, "t1", "研究员");
    removeMember(team, "研究员");
    expect(team.members[0].status).toBe("removed");
    expect(team.tasks[0].status).toBe("pending");
    expect(team.tasks[0].assignee).toBeUndefined();
  });
});

describe("agent-teams 引擎 — 邮箱与快照", () => {
  it("TEAM-014: 邮箱投递租赁/ack/release 语义", () => {
    const team = makeTeam();
    appendMailbox(team, { to: "工程师", from: "研究员", content: "帮我查下依赖" });
    appendMailbox(team, { to: "工程师", from: "研究员", content: "第二条" });
    expect(unreadMailbox(team, "工程师")).toHaveLength(2);
    // 租赁
    const msgs = unreadMailbox(team, "工程师");
    claimMailbox(team, msgs.map((m) => m.id));
    // 租赁未过期：不再出现在 unread（防双投）
    expect(unreadMailbox(team, "工程师", Date.now() + 1000)).toHaveLength(0);
    // 直投成功 → ack
    acknowledgeMailbox(team, msgs.map((m) => m.id));
    expect(team.mailbox.every((m) => m.deliveredAt !== undefined)).toBe(true);
    // 再 append 一条并 release → 可重投
    appendMailbox(team, { to: "工程师", from: "研究员", content: "第三条" });
    const m3 = unreadMailbox(team, "工程师");
    claimMailbox(team, m3.map((m) => m.id));
    releaseMailbox(team, m3.map((m) => m.id));
    expect(unreadMailbox(team, "工程师")).toHaveLength(1);
  });

  it("TEAM-014b: 快照含未读计数与任务摘要", () => {
    const team = makeTeam();
    createTask(team, { subject: "A", assignee: "研究员" });
    appendMailbox(team, { to: "工程师", from: "研究员", content: "hi" });
    const snap = snapshot(team);
    expect(snap.tasks[0].subject).toBe("A");
    expect(snap.unreadFor["工程师"]).toBe(1);
  });
});
