/**
 * ask_clarification 工具 — AI 向用户提出结构化问题（单选/多选/文本）。
 *
 * 用途：当 AI 缺少必要信息时，调用此工具向用户提问，而不是猜测或编造。
 *       用户填写表单后，答案会格式化为 Markdown 消息发回 AI。
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";
import type { ClarificationFormData } from "../agentic-loop";

/**
 * Clarification tool schema — 支持单选、多选、文本输入
 */
export function createClarificationTool(): ToolDef {
  return {
    id: "ask_clarification",
    description: "向用户提出结构化问题以获取缺失信息。支持单选、多选、文本输入。",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "问题内容，清晰简洁",
        },
        type: {
          type: "string",
          enum: ["radio", "checkbox", "text"],
          description: "问题类型：radio=单选, checkbox=多选, text=文本输入",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "选项列表（单选/多选时必填，文本输入时可省略）",
        },
        required: {
          type: "boolean",
          description: "是否必答（true则用户必须填写才能继续）",
        },
      },
      required: ["question", "type"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const { question, type, options, required } = args as {
        question: string;
        type: "radio" | "checkbox" | "text";
        options?: string[];
        required?: boolean;
      };

      if (type !== "text" && (!options || options.length === 0)) {
        return {
          title: "Error",
          output: `单选/多选类型必须提供选项列表`,
        };
      }

      // Create form data structure
      const formData: ClarificationFormData = {
        question,
        type,
        options,
        required: required ?? false,
        formId: `clarification-${Date.now()}`,
      };

      // Note: The actual user interaction is handled via LoopEvent
      // This tool returns a placeholder; the UI will show the form
      const answer = await ctx.onInteractiveForm?.([{
        id: formData.formId,
        question,
        input_type: type === "text" ? "text" : "choice",
        multi_select: type === "checkbox",
        options: options?.map((opt) => ({ label: opt, value: opt })),
        required: required ?? false,
      }]);

      // Format answers as Markdown for AI to process
      const answerText = formatClarificationAnswers(formData, answer || {});

      return {
        title: "Clarification Answer",
        output: answerText,
      };
    },
  };
}

/**
 * Format user's clarification answers into Markdown message
 */
function formatClarificationAnswers(formData: ClarificationFormData, answers: Record<string, unknown>): string {
  const { question, type, required } = formData;

  if (type === "text") {
    const textAnswer = answers[formData.formId] as string | undefined;
    return `[用户回答: ${textAnswer || "(未回答)"}]\n${textAnswer || ""}`;
  }

  if (type === "radio") {
    const selectedOption = answers[formData.formId] as string | undefined;
    return `[用户选择: ${selectedOption || "(未选择)"}]\n${question}\n选择: ${selectedOption || "未选择"}`;
  }

  if (type === "checkbox") {
    const selectedOptions = answers[formData.formId] as string[] | undefined;
    const formatted = (selectedOptions || []).join(", ");
    return `[用户选择: ${formatted || "(未选择)"}]\n${question}\n选择: ${formatted || "无"}`;
  }

  return `[用户回答: (无法解析)]`;
}