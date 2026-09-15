/**
 * 第 84 波审计修正：agent-teams 的三个"永久卡死 / 假成功"缺陷
 *
 * ① **重启零对账**：团队状态持久化在 localStorage，但重启后进程里没有任何东西在跑。
 *    `working` 成员让 `kick()` 永远跳过；`reassigning` 任务让 `nextReadyTask`/`claimTask`
 *    永远拒绝；带 attemptId 的 claimed 任务指向不存在的执行 —— 界面显示"工作中"，
 *    实际永远没人做。
 * ② **转派给成员后卡在静默期**：只有 `newAssignee === CAPTAIN` 才调用
 *    `finishReassign`，转派给普通成员时任务永久停在 `reassigning: true`。
 * ③ **先领取再唤醒（幽灵占用）**：`claimTask` 之后才 `followup`，而重启后 followup
 *    必然抛 "is not live or has settled" → 任务被不存在的成员占住、别人再也看不到。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const STORE_KEY = "codem-agent-teams:v1";

vi.mock("../core/subagent/index", () => ({
  getSubagentRuntime: vi.fn(() => null),
}));

import { AgentTeamsService, AgentTeamsServiceClass } from "../core/provider/agent-teams-service";
import { getSubagentRuntime } from "../core/subagent/index";

const svc = () => AgentTeamsService.getInstance();

/** 直接构造一个服务实例（用于模拟"重启后从 localStorage 恢复"） */
function freshService(): AgentTeamsServiceClass {
  return new AgentTeamsServiceClass();
}

beforeEach(() => {
  AgentTeamsService._reset();
  localStorage.clear();
  vi.mocked(getSubagentRuntime).mockReturnValue(null);
});

describe("重启对账（localStorage 恢复）", () => {
  it("TEAMR-1: working 成员 / reassigning 任务 / 幽灵领取令牌在重启后都被清算", () => {
    // 造一个"崩溃前"的团队并写进 localStorage
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "working", addedAt: Date.now() });
    team.tasks.push({
      id: "t1", subject: "转派中的任务", status: "pending", assignee: "研究员",
      dependencies: [], attempt: 1, reassigning: true, handoffId: "ho-1",
      createdAt: Date.now(), updatedAt: Date.now(),
    } as any);
    team.tasks.push({
      id: "t2", subject: "领取后崩溃的任务", status: "claimed", assignee: "研究员",
      dependencies: [], attempt: 1, attemptId: "attempt-x",
      createdAt: Date.now(), updatedAt: Date.now(),
    } as any);
    localStorage.setItem(STORE_KEY, JSON.stringify([team]));

    // 模拟重启
    const restarted = freshService();
    const snap = restarted.status(team.id);

    expect(snap.members[0].status, "working 必须重置为 idle").toBe("idle");
    const t1 = snap.tasks.find((x) => x.id === "t1")!;
    const t2 = snap.tasks.find((x) => x.id === "t2")!;
    expect(t1.status).toBe("pending");
    expect((t1 as any).reassigning, "静默期必须被清除，否则永久卡死").toBeFalsy();
    expect(t2.status, "幽灵领取回共享池").toBe("pending");
    expect(t2.hasAttemptId, "失效令牌必须作废").toBe(false);
    // 对账结果必须报告出来（不能只写 console）
    expect(snap.alerts?.join("\n")).toMatch(/重启对账/);
    expect(snap.alerts?.join("\n")).toMatch(/研究员/);
  });

  it("TEAMR-2: 对账后的任务真的能被重新领取（不是只改了显示）", () => {
    const team = svc().create({ name: "组B", captainSessionId: "cap-2" });
    team.tasks.push({
      id: "t1", subject: "x", status: "pending", assignee: "研究员",
      dependencies: [], attempt: 1, reassigning: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as any);
    localStorage.setItem(STORE_KEY, JSON.stringify([team]));

    const restarted = freshService();
    const r = restarted.claim(team.id, "t1", "研究员");
    expect(r.attemptId).toBeTruthy();
    expect(r.attempt).toBe(2);
  });

  it("TEAMR-3: 损坏的持久化数据不能静默变成空团队", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(STORE_KEY, "{ not json");
    const s = freshService();
    expect(s.listAll()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/损坏/);
    warn.mockRestore();
  });
});

describe("转派给成员不能卡在静默期", () => {
  it("TEAMR-4（修复点）: reassign 到普通成员后必须开出新 attempt", () => {
    // 成员子会话都存在（正常运行时）——否则 kick 会把成员标成离线
    vi.mocked(getSubagentRuntime).mockReturnValue({
      getTask: (id: string) => ({ id, status: "idle" }),
      followup: vi.fn().mockResolvedValue("ok"),
    } as any);
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "idle", addedAt: Date.now() });
    team.members.push({ id: "member-2", name: "工程师", status: "idle", addedAt: Date.now() });
    const { task } = svc().createTask(team.id, { subject: "写报告", assignee: "研究员" });
    svc().claim(team.id, task.id, "研究员");

    const r: any = svc().reassign(team.id, task.id, "工程师");
    expect(r.previousAssignee).toBe("研究员");
    expect(r.claimed, "必须真的开出新领取").toBe(true);

    const snap = svc().status(team.id);
    const t = snap.tasks.find((x) => x.id === task.id)!;
    expect(t.status, "转派后应处于已领取状态而不是静默期").toBe("claimed");
    expect(t.assignee).toBe("工程师");
    expect(t.hasAttemptId).toBe(true);
    // 旧负责人被释放
    expect(snap.members.find((m) => m.name === "研究员")!.status).toBe("idle");
  });

  it("TEAMR-5: 依赖未满足导致无法开新领取时，也必须清掉静默期并报出原因", () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "idle", addedAt: Date.now() });
    const dep = svc().createTask(team.id, { subject: "前置任务" }).task;
    const { task } = svc().createTask(team.id, { subject: "后续任务", dependencies: [dep.id] });

    const r: any = svc().reassign(team.id, task.id, "研究员");
    expect(r.claimed).toBe(false);
    expect(r.note).toMatch(/依赖|dependenc/i);

    const t = svc().status(team.id).tasks.find((x) => x.id === task.id)!;
    expect((t as any).reassigning ?? false, "不能留在静默期").toBeFalsy();
    expect(t.status).toBe("pending");
    // 依赖完成后仍可正常领取（证明没有留下"永久拒绝"的状态）
    const c = svc().claim(team.id, dep.id, "captain");
    svc().update(team.id, dep.id, { status: "in_progress", by: "captain", attemptId: c.attemptId });
    svc().update(team.id, dep.id, { status: "completed", by: "captain", attemptId: c.attemptId });
    const claim2 = svc().claim(team.id, task.id, "研究员");
    expect(claim2.attemptId).toBeTruthy();
  });

  it("TEAMR-6: 转派给 captain 仍然立刻接管（原有行为不回退）", () => {
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "working", addedAt: Date.now() });
    const { task } = svc().createTask(team.id, { subject: "任务", assignee: "研究员" });
    svc().claim(team.id, task.id, "研究员");

    const r: any = svc().reassign(team.id, task.id, "captain");
    expect(r.claimed).toBe(true);
    const t = svc().status(team.id).tasks.find((x) => x.id === task.id)!;
    expect(t.assignee).toBe("captain");
    expect(t.status).toBe("claimed");
  });
});

describe("先验证可唤醒再领取（幽灵占用）", () => {
  it("TEAMR-7（修复点）: 成员子会话不存在时不领取任务，并把成员标为离线 + 告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "idle", addedAt: Date.now() });
    // runtime 存在，但里面没有这个子会话（= 重启后的真实情况）
    vi.mocked(getSubagentRuntime).mockReturnValue({ getTask: () => undefined, followup: vi.fn() } as any);

    const { task } = svc().createTask(team.id, { subject: "写报告", assignee: "研究员" });

    const snap = svc().status(team.id);
    const t = snap.tasks.find((x) => x.id === task.id)!;
    expect(t.status, "任务必须留在共享池（不能被幽灵成员占住）").toBe("pending");
    expect(t.hasAttemptId).toBe(false);
    expect(snap.members.find((m) => m.name === "研究员")!.status).toBe("absent");
    expect(snap.alerts?.join("\n")).toMatch(/无法唤醒/);
    expect(snap.alerts?.join("\n")).toMatch(/captain/);
    warn.mockRestore();
  });

  it("TEAMR-8: 子会话存在时正常领取并唤醒（正常路径不回退）", async () => {
    const followup = vi.fn().mockResolvedValue("ok");
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "idle", addedAt: Date.now() });
    vi.mocked(getSubagentRuntime).mockReturnValue({
      getTask: (id: string) => (id === "member-1" ? { id, status: "idle" } : undefined),
      followup,
    } as any);

    const { task } = svc().createTask(team.id, { subject: "写报告" });
    const snap = svc().status(team.id);
    const t = snap.tasks.find((x) => x.id === task.id)!;
    expect(t.status).toBe("claimed");
    expect(t.hasAttemptId).toBe(true);
    expect(snap.members.find((m) => m.name === "研究员")!.status).toBe("working");
    expect(followup).toHaveBeenCalledTimes(1);
    // 参数顺序必须是 (parentSessionId, childId, message, options)
    expect(vi.mocked(followup).mock.calls[0][0]).toBe("cap-1");
    expect(vi.mocked(followup).mock.calls[0][1]).toBe("member-1");
  });

  it("TEAMR-9: 唤醒失败（followup 抛错）必须回滚领取并把原因写进告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const team = svc().create({ name: "组A", captainSessionId: "cap-1" });
    team.members.push({ id: "member-1", name: "研究员", status: "idle", addedAt: Date.now() });
    vi.mocked(getSubagentRuntime).mockReturnValue({
      getTask: () => ({ id: "member-1", status: "idle" }),
      followup: vi.fn().mockRejectedValue(new Error("boom delivery")),
    } as any);

    const { task } = svc().createTask(team.id, { subject: "写报告" });
    await new Promise((r) => setTimeout(r, 10)); // 等异步 catch

    const snap = svc().status(team.id);
    const t = snap.tasks.find((x) => x.id === task.id)!;
    expect(t.status, "唤醒失败必须回滚领取").toBe("pending");
    expect(t.hasAttemptId).toBe(false);
    expect(snap.members.find((m) => m.name === "研究员")!.status).toBe("idle");
    expect(snap.alerts?.join("\n")).toMatch(/唤醒成员 研究员 失败/);
    warn.mockRestore();
  });
});
