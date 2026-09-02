/**
 * 语义步骤计划 + 动态插入测试 — 对标 dsh-desktop 客户端 todo 语义列表
 *
 * 覆盖：
 * STEP-P1 任务意图检测（修复/排查/实现… → 需要语义计划；闲聊/问候 → 不需要）
 * STEP-P2 applyPlanUpdate：insert_before 到当前进行中步骤前（用户主场景：编号顺延）
 * STEP-P3 applyPlanUpdate：insert_after / append
 * STEP-P4 applyPlanUpdate 边界：插入已完成区段拒绝 / 空标题 / 重复 / 总步数上限
 * STEP-P5 update_plan 工具 schema + execute（无 ctx.updatePlan 报错；有则调用）
 * STEP-P6 update_plan 是 recon（不推进 X/X 宏步骤）
 * STEP-P7 计划标题语义化回归（LLM 计划失败时任务句不再回退成"回答问题"）
 */
import { describe, it, expect } from "vitest";
import {
  looksLikeExecutableTask,
  applyPlanUpdate,
  renderPlanSection,
  MAX_PLAN_STEPS,
  type StepPlan,
  type PlanUpdateOp,
} from "../core/llm/plan-utils";
import { createUpdatePlanTool } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";

function plan(titles: string[]): StepPlan[] {
  return titles.map((title) => ({ title }));
}

describe("语义步骤计划 + 动态插入（对标 dsh todo 语义列表）", () => {
  it("STEP-P1: 任务意图检测 — 修复/排查类中文任务需要语义计划", () => {
    expect(looksLikeExecutableTask("修复卡死的问题")).toBe(true);
    expect(looksLikeExecutableTask("帮我排查一下登录失败的原因")).toBe(true);
    expect(looksLikeExecutableTask("分析为什么页面会崩溃")).toBe(true);
    expect(looksLikeExecutableTask("实现一个文件导出功能")).toBe(true);
    expect(looksLikeExecutableTask("Can you fix this crash?")).toBe(true);
    expect(looksLikeExecutableTask("why does the app freeze")).toBe(true);
  });

  it("STEP-P1b: 任务意图检测 — 闲聊/问候/纯问题不算执行型任务", () => {
    expect(looksLikeExecutableTask("你好")).toBe(false);
    expect(looksLikeExecutableTask("hi")).toBe(false);
    expect(looksLikeExecutableTask("谢谢！")).toBe(false);
    expect(looksLikeExecutableTask("你是谁")).toBe(false);
    expect(looksLikeExecutableTask("嗯")).toBe(false);
    expect(looksLikeExecutableTask("")).toBe(false);
  });

  it("STEP-P2: insert_before 当前进行中步骤前 — 编号顺延（用户主场景）", () => {
    // 初始：1 分析原因 2 诊断链路 3 修复卡死 4 测试验证；正执行第 3 步时
    // 发现要先修复调用链路 → insert_before index=3
    const items = plan(["分析卡死原因", "诊断调用链路", "修复卡死", "验证卡死不再出现"]);
    const op: PlanUpdateOp = { action: "insert_before", index: 3, titles: ["修复调用链路"] };
    const result = applyPlanUpdate(items, op, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((s) => s.title)).toEqual([
      "分析卡死原因",
      "诊断调用链路",
      "修复调用链路",
      "修复卡死",
      "验证卡死不再出现",
    ]);
    expect(result.message).toContain("修复调用链路");
    expect(result.message).toContain("共 5 步");
  });

  it("STEP-P2b: 插入到未来步骤前也允许（不落在已完成区段）", () => {
    const items = plan(["A", "B", "C", "D"]);
    // 正执行第 2 步，把新步骤插到第 4 步前（未来区）
    const result = applyPlanUpdate(items, { action: "insert_before", index: 4, titles: ["X"] }, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((s) => s.title)).toEqual(["A", "B", "C", "X", "D"]);
  });

  it("STEP-P2c: insert_before/insert_after 省略 index → 默认相对当前进行中的步骤", () => {
    const items = plan(["分析原因", "诊断链路", "修复卡死", "测试"]);
    // 正执行第 3 步，省略 index → 插到第 3 步前
    const r1 = applyPlanUpdate(items, { action: "insert_before", titles: ["修复调用链路"] }, 3);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.items.map((s) => s.title)).toEqual(["分析原因", "诊断链路", "修复调用链路", "修复卡死", "测试"]);
    // insert_after 省略 index → 插到当前第 3 步后
    const r2 = applyPlanUpdate(items, { action: "insert_after", titles: ["补回归用例"] }, 3);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.items.map((s) => s.title)).toEqual(["分析原因", "诊断链路", "修复卡死", "补回归用例", "测试"]);
  });

  it("STEP-P3: insert_after / append", () => {
    const items = plan(["A", "B", "C"]);
    const after = applyPlanUpdate(items, { action: "insert_after", index: 2, titles: ["B2"] }, 3);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.items.map((s) => s.title)).toEqual(["A", "B", "B2", "C"]);
    const app = applyPlanUpdate(items, { action: "append", titles: ["D"] }, 2);
    expect(app.ok).toBe(true);
    if (app.ok) expect(app.items.map((s) => s.title)).toEqual(["A", "B", "C", "D"]);
  });

  it("STEP-P4a: 拒绝插入到已完成区段（index < 当前进行中步骤）", () => {
    const items = plan(["A", "B", "C", "D"]);
    // 正执行第 3 步，不允许插到第 1/2 步（已完成）前
    const r1 = applyPlanUpdate(items, { action: "insert_before", index: 1, titles: ["X"] }, 3);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("当前进行中");
    const r2 = applyPlanUpdate(items, { action: "insert_after", index: 1, titles: ["X"] }, 3);
    expect(r2.ok).toBe(false);
  });

  it("STEP-P4b: 边界 — 空标题 / 全部重复 / 总步数超上限", () => {
    const items = plan(["A", "B"]);
    expect(applyPlanUpdate(items, { action: "append", titles: ["  "] }, 1).ok).toBe(false);
    expect(applyPlanUpdate(items, { action: "append", titles: ["A"] }, 1).ok).toBe(false);
    const many = plan(Array.from({ length: MAX_PLAN_STEPS }, (_, i) => `S${i + 1}`));
    const over = applyPlanUpdate(many, { action: "append", titles: ["too-many"] }, 1);
    expect(over.ok).toBe(false);
  });

  it("STEP-P5: update_plan 工具 schema 与 execute 回调", async () => {
    const tool = createUpdatePlanTool();
    expect(tool.id).toBe("update_plan");
    expect((tool.parameters as any).required).toContain("action");
    expect((tool.parameters as any).required).toContain("titles");
    // 无 ctx.updatePlan（非对话任务）→ 报错提示
    const noCtx = await tool.execute({ action: "append", titles: ["X"] }, {} as any);
    expect(noCtx.output).toContain("没有可更新的执行计划");
    // 有 ctx.updatePlan → 传递 op；成功回执携带详细计划消息
    const calls: PlanUpdateOp[] = [];
    const okCtx = await tool.execute(
      { action: "insert_before", index: 3, titles: ["修复调用链路"] },
      { updatePlan: (op) => { calls.push(op); return { ok: true, message: "已插入步骤：修复调用链路。当前计划共 5 步：1. A；…" }; } } as any,
    );
    expect(okCtx.output).toContain("已插入步骤");
    expect(okCtx.output).toContain("修复调用链路");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: "insert_before", index: 3, titles: ["修复调用链路"] });
    // 失败回执 → Error 前缀透传
    const errCtx = await tool.execute(
      { action: "append", titles: ["X"] },
      { updatePlan: () => ({ ok: false, error: "update_plan: 报错" }) } as any,
    );
    expect(errCtx.output).toContain("Error: update_plan: 报错");
  });

  it("STEP-P6: update_plan 是 recon 工具（修改计划不推进 X/X 宏步骤）", () => {
    expect(AgenticLoop.isReconTool("update_plan")).toBe(true);
  });

  it("STEP-P8: 计划上下文注入 — 模型每轮可见当前步骤状态", () => {
    const items = plan(["分析卡死原因", "诊断调用链路", "修复卡死", "验证"]);
    const section = renderPlanSection(items, 3);
    expect(section).toContain("第 3/4 步");
    expect(section).toContain("1. [完成] 分析卡死原因");
    expect(section).toContain("2. [完成] 诊断调用链路");
    expect(section).toContain("3. [进行中] 修复卡死");
    expect(section).toContain("4. [待办] 验证");
    expect(section).toContain("update_plan");
    // 无计划 → 空串（不污染纯问答的 prompt）
    expect(renderPlanSection(null, 1)).toBe("");
    expect(renderPlanSection([], 1)).toBe("");
    // macroStep 越界（耗尽后）不越界显示
    const beyond = renderPlanSection(items, 9);
    expect(beyond).toContain("第 4/4 步");
  });
});
