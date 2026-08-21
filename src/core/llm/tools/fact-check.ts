/**
 * fact_check 工具 — 对 AI 回复进行事实核查，返回修正建议。
 *
 * 用途：Correction 模式下，AI 回复完成后调用此工具进行事实核查。
 *       调用专用的 Correction 模型，返回修正后的内容和差异。
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";

interface FactCheckInput {
  content: string;
}

interface FactCheckResult {
  original: string;
  corrected: string;
  changes: string[];
}

/**
 * Fact check tool — calls a correction model to verify facts
 */
export function createFactCheckTool(): ToolDef {
  return {
    id: "fact_check",
    guidance: "Use fact_check to verify a claim against known sources. Returns whether the claim is supported, contradicted, or uncertain.",
    description: "对 AI 回复进行事实核查，返回修正建议。需要提供待核查的内容。",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "需要核查的内容（AI 的原始回复）",
        },
      },
      required: ["content"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const input = args as unknown as FactCheckInput;
      const { content } = input;

      if (!content || content.trim().length === 0) {
        return {
          title: "Error",
          output: "内容不能为空",
        };
      }

      try {
        // Get correction provider/model from context (added by App.tsx)
        const correctionProvider = ctx.correctionProvider || "openai";
        const correctionModel = ctx.correctionModel || "gpt-4-turbo";

        // Call correction model
        const result = await callCorrectionModel(content, correctionProvider, correctionModel);

        return {
          title: "Fact Check Result",
          output: JSON.stringify(result, null, 2),
        };
      } catch (error) {
        return {
          title: "Error",
          output: `事实核查失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Call the correction model to fact-check the content
 */
async function callCorrectionModel(
  content: string,
  provider: string,
  model: string,
): Promise<FactCheckResult> {
  // Build correction prompt
  const prompt = `You are a fact-checking expert. Review the following AI response for:
1. Factual errors
2. Inaccuracies
3. Misleading statements

Original AI response:
"""
${content}
"""

Return a JSON response with this structure:
{
  "corrected": "Corrected version of the content (fix all errors)",
  "changes": ["Change 1 description", "Change 2 description", ...]
}

If the content is accurate and no corrections are needed, return:
{
  "corrected": "[No corrections needed]",
  "changes": []
}`;

  // In a real implementation, this would call the actual LLM provider
  // For now, return a mock result (to be replaced with actual API call)
  // This is a placeholder that needs to be integrated with the existing LLM provider system

  // TODO: Integrate with LLM provider system from src/core/llm/provider/
  // For now, return the original content with no changes
  return {
    original: content,
    corrected: content,
    changes: [],
  };
}