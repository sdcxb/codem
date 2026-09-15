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
    guidance: "Use ask_clarification when the user's request is ambiguous and you need more information to proceed. Asks the user a question.",
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
      //
      // 第 84 波（假成功）：**没有提问通道时必须报错**。
      // 原来 `answer` 为 undefined 时照样返回 "[用户回答: (未回答)]" —— 模型会以为
      // "已经问过用户、用户没回答"，于是继续瞎猜；而事实上问题**从未送达用户**
      // （例如后台会话/子智能体/无 UI 的调用方）。
      if (!ctx.onInteractiveForm) {
        return {
          title: "ask_clarification",
          output:
            `Error: 当前执行环境没有可用的用户交互通道，问题**没有**送达用户。` +
            `请改用普通文本向用户提问（在你的回复里直接问），不要假设用户已经看过这个问题。`,
          isError: true,
        };
      }

      const answer = await ctx.onInteractiveForm([{
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
    if (!textAnswer) {
      return `[用户回答: 未作答${required ? "（此问题为必答，但用户没有填写）" : ""}]\n用户**没有**回答这个问题 —— 不要自行假设答案，必要时再用普通文本追问。`;
    }
    return `[用户回答: ${textAnswer}]\n${textAnswer}`;
  }

  if (type === "radio") {
    const selectedOption = answers[formData.formId] as string | undefined;
    if (!selectedOption) {
      return `[用户选择: 未选择${required ? "（必答项未填）" : ""}]\n${question}\n用户**没有**做出选择 —— 不要自行替他选，必要时再用普通文本追问。`;
    }
    return `[用户选择: ${selectedOption}]\n${question}\n选择: ${selectedOption}`;
  }

  if (type === "checkbox") {
    const selectedOptions = answers[formData.formId] as string[] | undefined;
    const formatted = (selectedOptions || []).join(", ");
    if (!formatted) {
      return `[用户选择: 未选择${required ? "（必答项未填）" : ""}]\n${question}\n用户**没有**勾选任何选项 —— 不要自行假设，必要时再用普通文本追问。`;
    }
    return `[用户选择: ${formatted}]\n${question}\n选择: ${formatted}`;
  }

  return `[用户回答: (无法解析)]`;
}