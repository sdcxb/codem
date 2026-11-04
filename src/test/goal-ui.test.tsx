/**
 * 判据：目标模式 UI 与「模型不能自行改契约」（GOAL-9 的运行时部分 / GOAL-15 的可读性 / A1 的界面语义）。
 *
 * 三件事：
 * 1. **没有默认「继续」**：目标 active 时状态条只给「停止 / 改目标 / 计划证据」，
 *    **不出现** ContinueBar 的「继续」；paused/blocked 时出现的是「继续目标」（恢复目标，不是发一句话）。
 * 2. **可读**：状态条显示「目标执行中 · 阶段 2/3 · 自动推进」与自动继续次数；面板能展开
 *    计划/证据/决策/设置。
 * 3. **契约只能由用户改**：`changeGoalContract` 是唯一写入路径，会 bump version 并暂停目标；
 *    规划器/运行器没有任何改契约的入口（用"跑一次规划不会动已有契约"来行为验证）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("../core/goal/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/goal/store")>();
  return {
    ...actual,
    getGoalStore: () => mem.store,
  };
});

import { createMemoryGoalStore } from "../core/goal/store";
import type { GoalStore } from "../core/goal/store";
import { changeGoalContract, getGoalDetails, registerGoalRuntimeHost } from "../core/goal/runtime";
import { refreshGoalView } from "../core/goal/state";
import { planGoal } from "../core/goal/planner";
import { GoalModeBar } from "../components/GoalModeBar";
import type { GoalPlan, PlanPhase } from "../core/goal/types";

const SESSION = "s-goal-ui";
const ROOT = join(__dirname, "..", "..");

function phase(key: string, order: number, dep: string[], status: PlanPhase["status"] = "pending"): PlanPhase {
  return {
    key,
    order,
    title: `${key} 里程碑`,
    outcome: `${key} 的交付物已经可用`,
    acceptance: [{ id: `${key}.a1`, kind: "command", description: `${key} 验收`, command: "npm test" }],
    covers: ["A1"],
    dependsOn: dep,
    risks: [],
    status,
    attempts: 0,
  };
}

function seed(store: GoalStore, opts: { phases?: PlanPhase[] } = {}) {
  const goal = store.createGoal({
    sessionId: SESSION,
    statement: "把导出链路做对，且回归测试证明不再丢字段",
    principles: ["不破坏既有行为"],
    nonGoals: ["不改 UI 文案"],
    acceptance: [{ id: "A1", kind: "test", description: "整体回归为绿", command: "npm test" }],
    constraints: [],
  }, { id: "goal-ui" });
  const plan: GoalPlan = {
    goalId: goal.id,
    version: 1,
    contractVersion: 1,
    strategy: "先数据层，再端到端，最后兼容性确认",
    invariants: ["不破坏既有行为"],
    phases: opts.phases ?? [phase("p1", 0, [], "active"), phase("p2", 1, ["p1"]), phase("p3", 2, ["p2"])],
    createdAt: 1,
  };
  store.savePlan(plan);
  return { goal, plan };
}

beforeEach(() => {
  const store = createMemoryGoalStore(() => 1000);
  mem.store = store;
});

describe("目标模式状态条（UI）", () => {
  it("active：显示阶段进度与自动推进，**没有**「继续」按钮（默认继续路径已删除）", () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    store.addDecision({
      id: "gd-auto",
      goalId: goal.id,
      kind: "auto_continue",
      reason: "自动继续（第 1 次）",
      createdAt: 2,
    });
    refreshGoalView(SESSION);

    render(<GoalModeBar sessionId={SESSION} />);

    expect(screen.getByTestId("goal-mode-bar").textContent).toContain("阶段 1/3");
    expect(screen.getByTestId("goal-mode-bar").textContent).toContain("自动推进");
    expect(screen.getByTestId("goal-mode-bar").textContent).toContain("自动继续 1 次");
    expect(screen.getByTestId("goal-stop"), "运行中必须能停止").toBeTruthy();
    expect(screen.queryByTestId("goal-continue"), "active 时不该出现「继续」").toBeNull();
    // ContinueBar 的门控：有目标就不出现
    const chat = readFileSync(join(ROOT, "src/components/ChatPanel.tsx"), "utf8");
    expect(chat).toMatch(/const canContinue =[\s\S]*?!goalView[\s\S]*?!isSessionStreaming/);
  });

  it("paused：出现的是「继续目标」（恢复目标），不是发一句话的「继续」", () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    store.updateGoal(goal.id, { status: "paused", blockedReason: "用户停止" });
    refreshGoalView(SESSION);

    render(<GoalModeBar sessionId={SESSION} />);
    expect(screen.getByTestId("goal-mode-bar").textContent).toContain("目标已暂停");
    expect(screen.getByTestId("goal-continue")).toBeTruthy();
    expect(screen.queryByTestId("goal-stop")).toBeNull();
  });

  it("paused：必须能「取消目标」——并中止会话回合（真机：暂停后挂住）", () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    store.updateGoal(goal.id, { status: "paused", blockedReason: "用户停止" });
    refreshGoalView(SESSION);

    const abortSession = vi.fn();
    registerGoalRuntimeHost({
      getEngine: () => null,
      getCwd: () => "",
      onPermissionRequest: async () => ({ behavior: "deny" } as any),
      abortSession,
    });

    try {
      render(<GoalModeBar sessionId={SESSION} />);
      const cancel = screen.getByTestId("goal-cancel");
      expect(cancel.textContent).toContain("取消目标");
      fireEvent.click(cancel);

      expect(abortSession, "取消必须把还在流的回合一起停掉").toHaveBeenCalledWith(SESSION);
      expect(store.getGoal(goal.id)?.status).toBe("cancelled");
      expect(screen.queryByTestId("goal-mode-bar"), "取消后目标条应消失").toBeNull();
    } finally {
      registerGoalRuntimeHost(null);
    }
  });

  it("active：点「停止」也必须中止会话回合（不只是改目标状态）", () => {
    const store = mem.store as GoalStore;
    seed(store);
    refreshGoalView(SESSION);
    const abortSession = vi.fn();
    registerGoalRuntimeHost({
      getEngine: () => null,
      getCwd: () => "",
      onPermissionRequest: async () => ({ behavior: "deny" } as any),
      abortSession,
    });
    try {
      render(<GoalModeBar sessionId={SESSION} />);
      fireEvent.click(screen.getByTestId("goal-stop"));
      expect(abortSession).toHaveBeenCalledWith(SESSION);
    } finally {
      registerGoalRuntimeHost(null);
    }
  });

  it("blocked：原因可见（不是一句「出错了」）", () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    store.updateGoal(goal.id, { status: "blocked", blockedReason: "重规划次数已达上限 5 次：阶段 p1 在 3 次尝试后仍未通过" });
    refreshGoalView(SESSION);

    render(<GoalModeBar sessionId={SESSION} />);
    expect(screen.getByTestId("goal-reason").textContent).toContain("重规划次数已达上限");
  });

  it("面板：能展开计划/证据/决策与设置；没有目标时不渲染任何东西", () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    store.addEvidence({
      id: "ev-ui",
      goalId: goal.id,
      planVersion: 1,
      phaseKey: "p1",
      attempt: 1,
      kind: "command",
      acceptanceId: "p1.a1",
      summary: "p1.a1 失败：退出码 1",
      passed: false,
      createdAt: 3,
    });
    refreshGoalView(SESSION);

    const { rerender } = render(<GoalModeBar sessionId={SESSION} />);
    fireEvent.click(screen.getByTestId("goal-details-toggle"));
    const panel = screen.getByTestId("goal-mode-panel");
    expect(panel.textContent).toContain("里程碑计划");
    expect(panel.textContent).toContain("p2 里程碑");
    expect(panel.textContent).toContain("p1.a1 失败");
    expect(panel.textContent).toContain("决策日志");
    expect(screen.getByTestId("goal-settings")).toBeTruthy();

    // 反向对照：没有目标的会话 ⇒ 不渲染（不是一块永远在的条）
    mem.store = createMemoryGoalStore(() => 1000);
    refreshGoalView("s-empty");
    rerender(<GoalModeBar sessionId="s-empty" />);
    expect(screen.queryByTestId("goal-mode-bar")).toBeNull();
  });
});

describe("GOAL-9 契约只能由用户改（模型没有入口）", () => {
  it("changeGoalContract：bump 契约版本 + 暂停 + 留 decision；旧计划仍标记 contractVersion=1", () => {
    const store = mem.store as GoalStore;
    const { goal, plan } = seed(store);

    const result = changeGoalContract({ sessionId: SESSION, store, patch: { statement: "改成只读校验，不再导出" } });
    expect(result.ok).toBe(true);

    const after = store.getGoal(goal.id)!;
    expect(after.version, "契约版本必须 +1（旧计划需要重规划）").toBe(2);
    expect(after.statement).toBe("改成只读校验，不再导出");
    expect(after.status).toBe("paused");
    expect(after.blockedReason).toContain("重新规划");
    expect(store.listDecisions(goal.id).some((d) => d.kind === "contract_changed")).toBe(true);
    expect(store.getActivePlan(goal.id)!.contractVersion, "旧计划不被偷偷改写").toBe(plan.contractVersion);
  });

  it("规划器不碰已有契约：跑一次规划的产出只回到调用方，库里的目标逐字不变", async () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    const before = store.getGoal(goal.id)!;

    await planGoal({
      sessionId: SESSION,
      userMessage: "另一件多阶段任务",
      cwd: "C:\\repo",
      deps: {
        briefing: async () => "",
        readTextFile: async () => "",
        complete: async () =>
          JSON.stringify({
            classification: "multi-phase",
            statement: "被模型改写的目标（不该生效）",
            principles: [],
            nonGoals: [],
            constraints: [],
            goalAcceptance: [{ kind: "test", description: "a", command: "npm test" }],
            strategy: "随便写的策略至少十个字",
            invariants: ["i"],
            phases: [1, 2, 3].map((i) => ({
              key: `p${i}`,
              title: `阶段${i}`,
              outcome: `第 ${i} 个交付物已经可用`,
              covers: ["A1"],
              acceptance: [{ kind: "test", description: "a", command: "npm test" }],
              dependsOn: i === 1 ? [] : [`p${i - 1}`],
              risks: [],
            })),
          }),
      },
    });

    expect(store.getGoal(goal.id)!.statement, "规划器没有写契约的能力").toBe(before.statement);
    expect(store.getGoal(goal.id)!.version).toBe(before.version);
  });
});

describe("面板数据（getGoalDetails）", () => {
  it("有界投影：计划/阶段/证据/决策都来自存储（面板展开时现读，不把整份计划塞进全局状态）", () => {
    const store = mem.store as GoalStore;
    const { goal } = seed(store);
    store.addEvidence({
      id: "ev-details",
      goalId: goal.id,
      planVersion: 1,
      phaseKey: "p1",
      attempt: 1,
      kind: "command",
      acceptanceId: "p1.a1",
      summary: "ok",
      passed: true,
      createdAt: 1,
    });
    // `getGoalDetails` 走 `getGoalStore()`（本文件已把它 mock 成内存实现）
    const details = getGoalDetails(SESSION)!;
    expect(details.goal.id).toBe(goal.id);
    expect(details.plan?.phases.map((p) => p.key)).toEqual(["p1", "p2", "p3"]);
    expect(details.evidence[0].summary).toBe("ok");
    expect(Array.isArray(details.decisions)).toBe(true);
  });
});
