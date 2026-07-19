/**
 * InteractiveFormProvider — D3: interactive 技能的 Provider。
 *
 * 提供一个工具：
 * - interactive_form_question: 向用户展示交互式表单并等待回复
 *
 * 工作机制：
 * 1. LLM 调用 interactive_form_question(questions=[...])
 * 2. 工具通过 ctx.onInteractiveForm 回调将问题传递给 UI
 * 3. UI 显示交互式表单，等待用户输入
 * 4. 用户提交答案后，回调返回结果
 * 5. 工具将答案返回给 LLM 继续处理
 *
 * IP 声明：本实现为 Codem 项目原创，参考了通用交互式表单模式。
 */

import type {
  ToolDef,
  ToolContext,
  ToolExecuteResult,
  InteractiveFormQuestion,
} from "../../llm/tools";
import type { SkillToolProvider, SkillProviderContext } from "../provider";

export class InteractiveFormProvider implements SkillToolProvider {
  readonly name = "interactive";
  private ctx?: SkillProviderContext;

  initialize?(ctx: SkillProviderContext): Promise<void> {
    this.ctx = ctx;
    return Promise.resolve();
  }

  getTools(): ToolDef[] {
    return [this.createInteractiveFormQuestionTool()];
  }

  /**
   * interactive_form_question 工具：
   * 向用户展示交互式表单并等待回复。
   */
  private createInteractiveFormQuestionTool(): ToolDef {
    return {
      id: "interactive_form_question",
      description:
        "Present an interactive form with questions to the user. " +
        "Use this to gather preferences, clarify ambiguous instructions, get decisions, or present options. " +
        "Never write options or questions as plain text — always use this tool. " +
        "Returns the user's answers as a JSON object.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "The full list of questions to render in the form.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique identifier for the question" },
                question: { type: "string", description: "Question text shown to the user" },
                input_type: {
                  type: "string",
                  enum: ["choice", "text"],
                  description: "Type of input: 'choice' for options, 'text' for free text",
                },
                options: {
                  type: "array",
                  description: "Options for choice questions",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                      recommended: { type: "boolean" },
                    },
                  },
                },
                multi_select: {
                  type: "boolean",
                  description: "Allow multiple selections (default: false)",
                },
                required: {
                  type: "boolean",
                  description: "Whether the question must be answered (default: true)",
                },
                placeholder: {
                  type: "string",
                  description: "Placeholder text for text input",
                },
              },
              required: ["id", "question", "input_type"],
            },
          },
        },
        required: ["questions"],
      },
      async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
        const questions = args.questions as InteractiveFormQuestion[];
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
          return {
            title: "interactive_form_question",
            output: "Error: 'questions' must be a non-empty array.",
          };
        }

        // Validate questions
        for (const q of questions) {
          if (!q.id || !q.question || !q.input_type) {
            return {
              title: "interactive_form_question",
              output: `Error: Each question must have 'id', 'question', and 'input_type'. Got: ${JSON.stringify(q)}`,
            };
          }
          if (q.input_type === "choice" && (!q.options || q.options.length === 0)) {
            return {
              title: "interactive_form_question",
              output: `Error: Question "${q.id}" has input_type 'choice' but no options.`,
            };
          }
        }

        // Check if interactive form callback is available
        if (!ctx.onInteractiveForm) {
          // Fallback: format as text for the LLM to present
          const formatted = questions
            .map((q) => {
              if (q.input_type === "choice") {
                const opts = q.options
                  ?.map((o) => `  - ${o.label}${o.recommended ? " (Recommended)" : ""}`)
                  .join("\n");
                return `**${q.question}**\n${opts}`;
              }
              return `**${q.question}**\n  [text input]`;
            })
            .join("\n\n");

          return {
            title: "interactive_form_question",
            output: `Interactive form is not available in this context. Please present these questions to the user as text and wait for their response:\n\n${formatted}`,
            metadata: { questionCount: questions.length },
          };
        }

        // Call the interactive form callback and wait for user response
        const answers = await ctx.onInteractiveForm(questions);

        // Format the response for the LLM
        const isSingleQuestion = questions.length === 1;
        if (isSingleQuestion) {
          const answer = answers[questions[0].id];
          return {
            title: "interactive_form_question",
            output: JSON.stringify({ answer }),
            metadata: { questionCount: 1 },
          };
        }

        return {
          title: "interactive_form_question",
          output: JSON.stringify({ answers }),
          metadata: { questionCount: questions.length },
        };
      },
    };
  }

  dispose?(): Promise<void> {
    return Promise.resolve();
  }
}
