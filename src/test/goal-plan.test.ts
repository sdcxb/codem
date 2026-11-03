/**
 * 判据：深规划只读 + 计划校验（GOAL-2 / GOAL-3）。
 *
 * ## GOAL-2：规划只读，且产出的计划通过校验
 *
 * - **结构**：`planner.ts` 从 `file-api` 只 import 读能力（readFile / listDirectory /
 *   isPathWithinWorkspace）—— 规划阶段**没有**写文件 / 跑命令的能力，不是靠提示词约束；
 * - **行为**：模型请求读工作区外的文件 ⇒ 被拒绝（不是静默读）；请求读工作区内文件 ⇒
 *   内容进入下一次请求；模型可以请求多轮补读，但有上限；
 * - **产出**：通过校验的计划被原样返回（含目标验收与阶段覆盖）。
 *
 * ## GOAL-3：计划拒绝「读文件 / 跑测试」这类动作型 phase
 *
 * 正例与反例都要有（只有反例 = 把所有计划都拒了也能绿）：
 * - 反例：「读取 src/foo.ts」「跑一次测试」「list files」「修改这个文件」必须红；
 * - 正例：「失败路径有回归测试且为绿」「缓存层可被禁用且默认关闭」必须通过。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { formatViolations, validatePlanDraft, type PlanDraft } from "../core/goal/plan-validate";
import { planGoal } from "../core/goal/planner";

const ROOT = join(__dirname, "..", "..");

function draft(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    classification: "multi-phase",
    statement: "把导出链路做对，并且有回归测试证明它不再丢字段",
    principles: ["不破坏既有行为"],
    nonGoals: ["不改 UI 文案"],
    constraints: ["Node 24"],
    goalAcceptance: [{ kind: "test", description: "导出链路回归测试为绿", command: "npm test" }],
    strategy: "先在数据层补齐字段，再用端到端测试锁住行为",
    invariants: ["不破坏既有行为", "不引入新依赖"],
    phases: [
      {
        key: "p1",
        title: "字段补齐",
        outcome: "导出结果包含全部约定字段，并有单测覆盖",
        covers: ["A1"],
        acceptance: [{ kind: "test", description: "单测为绿", command: "npm test" }],
        dependsOn: [],
        risks: ["字段来源分散"],
      },
      {
        key: "p2",
        title: "端到端回归",
        outcome: "端到端导出不再丢字段，回归测试为绿",
        covers: ["A1"],
        acceptance: [{ kind: "test", description: "端到端为绿", command: "npm test" }],
        dependsOn: ["p1"],
        risks: [],
      },
      {
        key: "p3",
        title: "兼容性确认",
        outcome: "旧版导出的消费方仍可读取新结果（向后兼容）",
        covers: ["A1"],
        acceptance: [{ kind: "command", description: "旧消费方脚本退出码 0", command: "node compat.mjs" }],
        dependsOn: ["p2"],
        risks: [],
      },
    ],
    ...overrides,
  };
}

describe("GOAL-2 规划只读（结构性）", () => {
  it("planner 只 import 读能力，没有任何写/执行入口", () => {
    const src = readFileSync(join(ROOT, "src/core/goal/planner.ts"), "utf8");
    const importLine = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/file-api"/);
    expect(importLine, "planner 必须从 file-api 取值（没 import 说明读取能力走了别的路）").toBeTruthy();
    const names = importLine![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(["isPathWithinWorkspace", "listDirectory", "readFile"]);
    for (const forbidden of ["writeFile", "deletePath", "deleteFile", "executeCommand", "renameFile", "appendFile"]) {
      expect(names, `规划器不许有写能力：${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("GOAL-2 规划行为（只读边界 + 契约）", () => {
  it("工作区外的读请求被拒绝；工作区内的内容进入下一次请求；最终产出通过校验", async () => {
    const readTextFile = vi.fn(async (abs: string) => `// content of ${abs}\nline2`);
    const briefing = vi.fn(async () => "（侦察摘要）");
    const requests: string[] = [];
    const complete = vi.fn(async ({ user }: { user: string }) => {
      requests.push(user);
      if (requests.length === 1) {
        return JSON.stringify({
          classification: "need-reads",
          reads: [
            { path: "../../etc/passwd", lines: 10 },
            { path: "src/core/app.ts", lines: 40 },
          ],
        });
      }
      return JSON.stringify(draft());
    });

    const result = await planGoal({
      sessionId: "s-goal-2",
      userMessage: "把导出链路做对，并加回归测试",
      cwd: "C:\\repo",
      deps: { complete, readTextFile, briefing },
    });

    expect(result.kind, "合法计划必须被接受（否则下面两条边界断言只是‘全都拒了’）").toBe("multi-phase");
    expect(complete).toHaveBeenCalledTimes(2);
    // 第二轮请求里必须出现：被拒绝的说明 + 允许读到的内容
    expect(requests[1]).toContain("拒绝：规划阶段只能读工作区内的文件");
    expect(requests[1]).toContain("content of C:\\repo\\src/core/app.ts");
    // 只读了工作区内那一个文件（工作区外的根本没读）
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  it("补读有轮数上限：连续请求 need-reads 不会无限读", async () => {
    const readTextFile = vi.fn(async () => "x");
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      // 永远要求补读；规划器应在 3 轮之后改口要求直接给计划（这里给非法 JSON 以结束循环）
      return JSON.stringify({ classification: "need-reads", reads: [{ path: "a.ts", lines: 5 }] });
    });
    const result = await planGoal({
      sessionId: "s-goal-2b",
      userMessage: "多阶段任务",
      cwd: "C:\\repo",
      deps: { complete, readTextFile, briefing: async () => "" },
      maxPlanAttempts: 4,
    });
    expect(result.kind).toBe("failed");
    // 补读轮数被限制在 3 轮（每轮 1 个文件）；模型调用总数 = 补读轮 + 计划尝试轮，有界
    expect(readTextFile.mock.calls.length).toBeLessThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(4 + 3);
  });
});

describe("GOAL-3 拒绝动作型 phase", () => {
  const actionOutcomes = [
    "读取 src/core/app.ts 并理解调用链",
    "跑一次测试看看是不是绿的",
    "list files in src",
    "修改这个文件里的函数名",
    "看一下日志",
  ];

  it.each(actionOutcomes)("拒绝动作型 outcome：%s", (outcome) => {
    const d = draft();
    d.phases![0] = { ...d.phases![0], outcome };
    const result = validatePlanDraft(d);
    expect(result.ok, `动作型 outcome 必须被拒：${outcome}`).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("action-phase");
      expect(formatViolations(result.violations)).toContain("不是可验收的结果");
    }
  });

  it("正例：结果导向的 outcome 必须通过（反向对照，防‘全都拒了’）", () => {
    const result = validatePlanDraft(draft());
    expect(result.ok, result.ok ? "" : formatViolations(result.violations)).toBe(true);
  });
});

describe("计划结构校验（覆盖 / DAG / 粒度 / 重复 / 不变式）", () => {
  it("目标验收没有被任何阶段覆盖 ⇒ coverage", () => {
    const d = draft();
    d.goalAcceptance = [
      { kind: "test", description: "A1", command: "npm test" },
      { kind: "command", description: "A2", command: "node ok.mjs" },
    ];
    const result = validatePlanDraft(d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("coverage");
  });

  it("依赖成环 ⇒ dag-cycle；依赖不存在的阶段 ⇒ unknown-dependency", () => {
    const cyclic = draft();
    cyclic.phases![0] = { ...cyclic.phases![0], dependsOn: ["p3"] };
    const r1 = validatePlanDraft(cyclic);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.violations.map((v) => v.code)).toContain("dag-cycle");

    const unknown = draft();
    unknown.phases![1] = { ...unknown.phases![1], dependsOn: ["p1", "p9"] };
    const r2 = validatePlanDraft(unknown);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.violations.map((v) => v.code)).toContain("unknown-dependency");
  });

  it("阶段数少于 3 / 多于 12 ⇒ phase-count", () => {
    const two = draft({ phases: draft().phases!.slice(0, 2) });
    const r1 = validatePlanDraft(two);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.violations.map((v) => v.code)).toContain("phase-count");

    const many = draft();
    many.phases = Array.from({ length: 13 }, (_, i) => ({
      key: `p${i + 1}`,
      title: `阶段${i + 1}`,
      outcome: `第 ${i + 1} 个可验收交付物已经可用`,
      covers: ["A1"],
      acceptance: [{ kind: "test", description: "绿", command: "npm test" }],
      dependsOn: i === 0 ? [] : [`p${i}`],
      risks: [],
    }));
    const r2 = validatePlanDraft(many);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.violations.map((v) => v.code)).toContain("phase-count");
  });

  it("两个阶段同一 outcome ⇒ duplicate-outcome", () => {
    const d = draft();
    d.phases![2] = { ...d.phases![2], outcome: d.phases![0].outcome! };
    const result = validatePlanDraft(d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("duplicate-outcome");
  });

  it("没有验收 / 没有不变式 ⇒ missing-acceptance / no-invariants", () => {
    const d = draft();
    d.phases![0] = { ...d.phases![0], acceptance: [] };
    d.invariants = [];
    const result = validatePlanDraft(d);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("missing-acceptance");
      expect(codes).toContain("no-invariants");
    }
  });

  it("校验失败时**一次给出全部**问题（模型重写需要完整清单）", () => {
    const d = draft();
    d.statement = "";
    d.invariants = [];
    d.phases![0] = { ...d.phases![0], outcome: "", acceptance: [] };
    const result = validatePlanDraft(d);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.map((v) => v.code);
      expect(codes.length >= 4).toBe(true);
      expect(codes).toContain("no-statement");
      expect(codes).toContain("phase-missing-outcome");
    }
  });
});
