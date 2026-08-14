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

let planApprovalCallback: ((plan: string) => Promise<{ approved: boolean; feedback?: string }>) | null = null;

/**
 * Set the callback that handles plan approval UI.
 * Called by App.tsx to wire the tool to the UI.
 */
export function setPlanApprovalCallback(
  cb: (plan: string) => Promise<{ approved: boolean; feedback?: string }>,
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
          return {
            title: "Plan Approved",
            output: `✅ Plan approved by user. You are now in Default mode. Begin executing the plan.\n\n${plan}`,
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
