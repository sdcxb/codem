/**
 * exit_plan_mode 工具 — Plan Mode 退出审批
 *
 * Design (对标 DeepSeek Harness exit_plan_mode):
 *
 * 当 AI 在 Plan Mode 下完成分析和计划后，调用此工具提交计划给用户审批。
 * 用户可以选择：
 * - Approve: 切换到 Default 模式，自动开始执行计划
 * - Reject: 保持 Plan 模式，AI 需要修改计划后重新提交
 *
 * 对齐 dsh 6 段提示词规范：
 * 1. 模式声明：Stay in plan mode until exit_plan_mode succeeds
 * 2. 探索优先：Use non-mutating reads, searches, static analysis
 * 3. 工具目录不变：The tool catalog stays the same across modes
 * 4. ask_user 限制：Use ask_user only for user-owned choices
 * 5. 计划完整性：Make the plan decision-complete
 * 6. exit_plan_mode 调用：Make it the only and final tool call
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";

// ========== Plan Approval Callback ==========

/**
 * 审批结果。`modeSwitched` 是**由 UI 侧汇报的事实**，不是工具自己推断的：
 * 第 84 波审计发现，原来只要 approved=true，工具就无条件宣称"你现在是 Default 模式"，
 * 而 UI 并没有切模式（也没触及正在运行的 loop），于是模型在计划模式下继续尝试写操作、
 * 全部被 PlanModeGuard 拦下 —— 典型的"假成功"。现在必须由 UI 明确报告切换结果。
 */
export interface PlanApprovalOutcome {
  approved: boolean;
  feedback?: string;
  /** approve 时：协作模式是否**确实**已切到 default（附带正在运行的 loop 数） */
  modeSwitched?: boolean;
  /** 供人阅读的补充说明（例如"已切换，活动 loop=1"） */
  modeNote?: string;
}

let planApprovalCallback:
  | ((plan: string) => Promise<PlanApprovalOutcome>)
  | null = null;

/**
 * Set the callback that handles plan approval UI.
 * Called by App.tsx to wire the tool to the UI.
 */
export function setPlanApprovalCallback(
  cb: (plan: string) => Promise<PlanApprovalOutcome>,
): void {
  planApprovalCallback = cb;
}

/**
 * Clear the callback (e.g., on session change).
 */
export function clearPlanApprovalCallback(): void {
  planApprovalCallback = null;
}

// ========== Tool Definition ==========

export function createExitPlanModeTool(): ToolDef {
  return {
    id: "exit_plan_mode",
    guidance: "Use exit_plan_mode to transition from planning to execution. Call this when the plan is ready and you want to start implementing.",
    description: `Exit Plan Mode by submitting your plan for user approval.

Call this tool when you have completed your analysis and are ready to present your plan.

The plan should be decision-complete:
- Goal: What the user wants to achieve
- Success criteria: How to verify the goal is met
- Subsystems: Which files/modules are affected
- Edge cases: What could go wrong and how to handle it

This must be the ONLY and FINAL tool call in your response. After calling this tool, do not call any other tools — wait for the user's decision.

If the user approves, you will be switched to Default mode and can begin executing the plan.
If the user rejects, stay in Plan mode, revise the plan based on their feedback, and call exit_plan_mode again.`,
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "The complete plan in Markdown format. Include: Goal, Success criteria, Subsystems affected, Steps, Edge cases.",
        },
      },
      required: ["plan"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const plan = args.plan as string;

      if (!plan || plan.trim().length === 0) {
        return {
          title: "exit_plan_mode",
          output: "Error: plan parameter is required and must not be empty.",
        };
      }

      if (!planApprovalCallback) {
        return {
          title: "exit_plan_mode",
          output: "Error: Plan approval UI is not available. The user will need to manually switch to Default mode.",
        };
      }

      try {
        const result = await planApprovalCallback(plan);

        if (result.approved) {
          // 只有 UI 明确报告"模式已切换"时才宣称已进入 Default 模式；
          // 报告失败 → 明确告诉模型仍在计划模式，别去写文件；
          // 未报告 → 不臆断，提示以写操作是否被拒绝为准。
          if (result.modeSwitched === false) {
            return {
              title: "Plan Approved (mode switch failed)",
              output: `⚠️ 用户已批准计划，但**协作模式没有切换成功**（仍在 Plan 模式），写操作仍会被拦下。\n${result.modeNote ? `\n细节：${result.modeNote}\n` : ""}\n请不要继续尝试写入/执行；请让用户手动把模式切到 Default 后再说"继续"，或重新调用 exit_plan_mode。\n\n计划原文：\n${plan}`,
            };
          }
          if (result.modeSwitched === undefined) {
            return {
              title: "Plan Approved",
              output: `✅ 用户已批准计划。模式切换结果未被 UI 确认 —— 如果接下来的写入工具仍然报 "Cannot use ... in Plan mode"，说明模式没有切换，请停下来告诉用户手动切换到 Default 模式，不要反复重试。${result.modeNote ? `\n\n细节：${result.modeNote}` : ""}\n\n${plan}`,
            };
          }
          return {
            title: "Plan Approved",
            output: `✅ Plan approved by user. You are now in Default mode. Begin executing the plan.${result.modeNote ? `\n\n(${result.modeNote})` : ""}\n\n${plan}`,
          };
        } else {
          const feedback = result.feedback || "No specific feedback provided.";
          return {
            title: "Plan Rejected",
            output: `❌ Plan rejected by user. Stay in Plan mode.\n\nUser feedback:\n${feedback}\n\nRevise your plan and call exit_plan_mode again when ready.`,
          };
        }
      } catch (err: any) {
        return {
          title: "exit_plan_mode",
          output: `Error during plan approval: ${err.message}`,
        };
      }
    },
  };
}
