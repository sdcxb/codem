/**
 * 第 84 波审计修正：`exit_plan_mode` 审批通过后**必须真的切到 Default 模式**。
 *
 * 修复前的真实缺陷（"假成功 + 后续全部失败"）：
 *   · 工具只要拿到 `approved: true` 就无条件输出 "You are now in Default mode"；
 *   · 而 App 的审批回调只 `resolve({approved:true})` —— 既没有 `setCollaborationMode("default")`，
 *     也没有触及**正在运行**的那个 AgenticLoop；
 *   · 于是模型在同一个回合里继续调用 write/edit，全部被 PlanModeGuard 拦下
 *     （"Cannot use ... in Plan mode"），模型以为自己已经在 Default 模式，
 *     反复重试或被卡死在计划模式里。
 *
 * 修复后：
 *   1. UI 的批准回调真的切模式（`handleModeChange`），并把结果如实回报给工具；
 *   2. `LLMEngine.setCollaborationModeForSession()` 让模式切换对**活动 loop** 立即生效；
 *   3. 工具只在 UI 明确报告成功时才宣称已进入 Default 模式。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createExitPlanModeTool,
  setPlanApprovalCallback,
  clearPlanApprovalCallback,
  type PlanApprovalOutcome,
} from "../core/llm/tools/exit-plan-mode";
import { LLMEngine } from "../core/llm/index";
import { initDefaultPipeline, getToolPipeline } from "../core/llm/tool-pipeline";

const tool = createExitPlanModeTool();
const ctx = {} as any;
const exec = (plan: string) => tool.execute({ plan }, ctx);

afterEach(() => clearPlanApprovalCallback());

describe("exit_plan_mode 的诚实汇报", () => {
  it("EPM-1: UI 明确报告切换成功 → 才宣称已进入 Default 模式", async () => {
    setPlanApprovalCallback(async () => ({
      approved: true,
      modeSwitched: true,
      modeNote: "协作模式已切到 default；当前活动 loop 切换数=1",
    } as PlanApprovalOutcome));

    const r: any = await exec("# 计划\n1. 改 A");
    expect(r.output).toContain("You are now in Default mode");
    expect(r.output).toContain("活动 loop 切换数=1");
  });

  it("EPM-2: UI 报告切换失败 → 不许宣称已切模式，并明确让模型别写文件", async () => {
    setPlanApprovalCallback(async () => ({
      approved: true,
      modeSwitched: false,
      modeNote: "切换协作模式时出错：boom",
    }));

    const r: any = await exec("# 计划");
    expect(r.output).not.toContain("You are now in Default mode");
    expect(r.output).toMatch(/没有切换成功|仍在 Plan/);
    expect(r.output).toContain("boom");
    expect(r.output).toMatch(/不要继续尝试写入/);
  });

  it("EPM-3: UI 未报告切换结果（老接线/插件覆盖）→ 不做无根据的断言", async () => {
    setPlanApprovalCallback(async () => ({ approved: true }));

    const r: any = await exec("# 计划");
    expect(r.output).not.toContain("You are now in Default mode");
    expect(r.output).toMatch(/模式切换结果未被 UI 确认/);
    // 关键：给出可判定的下一步依据，而不是让模型空转
    expect(r.output).toMatch(/写入工具仍然报/);
  });

  it("EPM-4: 拒绝 → 留在计划模式，要求修订后重新提交", async () => {
    setPlanApprovalCallback(async () => ({ approved: false, feedback: "第 2 步不对" }));

    const r: any = await exec("# 计划");
    expect(r.output).toContain("Plan rejected");
    expect(r.output).toContain("第 2 步不对");
  });

  it("EPM-5: 空计划 / 没有审批通道 → 报错而不是假装成功", async () => {
    clearPlanApprovalCallback();
    expect(String((await exec("")).output)).toMatch(/plan parameter is required/);
    expect(String((await exec("# 计划")).output)).toMatch(/not available/);
  });
});

describe("活动 loop 的模式切换（真实管线）", () => {
  beforeEach(() => clearPlanApprovalCallback());

  it("EPM-6（修复点）: 审批通过后，同一回合内的写工具必须不再被 PlanModeGuard 拦下", async () => {
    const engine = new LLMEngine();
    // 建一个真实的会话 loop 并置于计划模式（等价于用户点了 Plan 模式后发消息）
    const loop: any = engine.getAgenticLoop(undefined, "s-plan");
    loop.updateConfig({ collaborationMode: "plan" });

    // 与 AgenticLoop.run() 里 initDefaultPipeline 的接线保持一致
    await initDefaultPipeline({
      isPlanMode: () => loop.config.collaborationMode === "plan",
      isSandboxEnabled: () => false,
      isPathWithinWorkspace: () => true,
      checkPermission: async () => ({ allowed: true }),
    });
    const pipeline = getToolPipeline();
    const pipelineCtx: any = {
      sessionId: "s-plan",
      messageId: "m1",
      cwd: "C:/proj",
      messages: [],
      abort: new AbortController().signal,
      metadata: () => {},
    };
    const handler = async (name: string, args: Record<string, unknown>) => ({
      id: "t1",
      name,
      input: args,
      output: "written",
      status: "completed" as const,
    });

    const before = await pipeline.execute("write", { path: "C:/proj/a.ts", content: "x" }, pipelineCtx, handler);
    expect(before.result.status, "计划模式下写操作必须被拦").toBe("error");
    expect(String(before.result.output)).toMatch(/Plan mode/i);

    // —— 用户点了"批准"：UI 走 handleModeChange → 引擎同步活动 loop
    const switched = engine.setCollaborationModeForSession("s-plan", "default");
    expect(switched).toBe(1);
    expect(engine.getActiveCollaborationMode("s-plan")).toBe("default");

    const after = await pipeline.execute("write", { path: "C:/proj/a.ts", content: "x" }, pipelineCtx, handler);
    expect(after.result.status, "审批通过后同一回合的写操作必须放行").toBe("completed");
  });

  it("EPM-7: 没有活动 loop 时返回 0（不谎报切了 loop），但也不抛错", () => {
    const engine = new LLMEngine();
    expect(engine.setCollaborationModeForSession("nope", "default")).toBe(0);
    expect(engine.getActiveCollaborationMode("nope")).toBeNull();
  });

  it("EPM-8: 源码契约 —— App 的批准回调必须真的切模式并回报 modeSwitched", () => {
    const fs = require("fs");
    const path = require("path");
    const app = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");
    const idx = app.indexOf("onApprove={");
    expect(idx).toBeGreaterThan(-1);
    const block = app.slice(idx, idx + 1200);
    expect(block, "批准回调必须切协作模式").toContain('handleModeChange("default")');
    expect(block, "必须把切换结果如实回报给工具").toMatch(/modeSwitched:/);

    const modeFn = app.indexOf("const handleModeChange = useCallback");
    expect(modeFn).toBeGreaterThan(-1);
    const modeBlock = app.slice(modeFn, modeFn + 700);
    expect(modeBlock, "模式切换必须同时作用于活动 loop").toContain("setCollaborationModeForSession");
  });
});
