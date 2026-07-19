/**
 * PromptOptimizationProvider — D2: prompt-optimization 技能的 Provider。
 *
 * 提供两个工具：
 * - get_system_prompt: 获取当前系统提示词及其来源
 * - submit_prompt_changes: 提交提示词修改建议供用户审核
 *
 * IP 声明：本实现为 Codem 项目原创，参考了通用 prompt 管理模式。
 */

import type { ToolDef, ToolContext, ToolExecuteResult, PromptChange } from "../../llm/tools";
import type { SkillToolProvider, SkillProviderContext } from "../provider";

export class PromptOptimizationProvider implements SkillToolProvider {
  readonly name = "prompt-optimization";
  private ctx?: SkillProviderContext;

  initialize?(ctx: SkillProviderContext): Promise<void> {
    this.ctx = ctx;
    return Promise.resolve();
  }

  getTools(): ToolDef[] {
    return [this.createGetSystemPromptTool(), this.createSubmitPromptChangesTool()];
  }

  /**
   * get_system_prompt 工具：
   * 获取当前 AI 的系统提示词及其来源映射。
   */
  private createGetSystemPromptTool(): ToolDef {
    return {
      id: "get_system_prompt",
      description:
        "Get the current system prompt and its source mapping for the AI agent. " +
        "Returns the assembled prompt and an array of sources.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
        if (!ctx.getSystemPrompt) {
          return {
            title: "get_system_prompt",
            output: "Error: System prompt access is not available in this context.",
          };
        }

        const assembledPrompt = ctx.getSystemPrompt();

        if (!assembledPrompt) {
          return {
            title: "get_system_prompt",
            output: "The system prompt is empty or not yet configured.",
          };
        }

        // Return as a structured format that the LLM can parse
        const sources = [
          {
            type: "system",
            name: "system prompt",
            field: "systemPrompt",
            content: assembledPrompt,
          },
        ];

        const result = {
          assembled_prompt: assembledPrompt,
          sources,
        };

        return {
          title: "get_system_prompt",
          output: JSON.stringify(result, null, 2),
          metadata: { sourceCount: sources.length, promptLength: assembledPrompt.length },
        };
      },
    };
  }

  /**
   * submit_prompt_changes 工具：
   * 提交提示词修改建议，在 UI 上显示 diff 卡片供用户审核。
   */
  private createSubmitPromptChangesTool(): ToolDef {
    return {
      id: "submit_prompt_changes",
      description:
        "Submit optimized prompt changes for user review. Shows interactive diff cards " +
        "where the user can apply or cancel each change independently.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            description: "Array of prompt changes to submit for review.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", description: "Source type (e.g. 'system')" },
                name: { type: "string", description: "Display name for the source" },
                original: { type: "string", description: "Original prompt content" },
                suggested: { type: "string", description: "Optimized prompt content" },
              },
              required: ["type", "name", "original", "suggested"],
            },
          },
        },
        required: ["changes"],
      },
      async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
        const changes = args.changes as PromptChange[];
        if (!changes || !Array.isArray(changes) || changes.length === 0) {
          return {
            title: "submit_prompt_changes",
            output: "Error: 'changes' must be a non-empty array.",
          };
        }

        if (!ctx.onPromptChangeSubmit) {
          // Fallback: just return the changes as text for the LLM to present
          const summary = changes
            .map(
              (c: PromptChange, i: number) =>
                `### Change ${i + 1}: ${c.name} (${c.type})\n\n**Original:**\n${c.original}\n\n**Suggested:**\n${c.suggested}`,
            )
            .join("\n\n---\n\n");

          return {
            title: "submit_prompt_changes",
            output: `Prompt changes prepared (interactive review not available in this context). Please present these changes to the user:\n\n${summary}`,
            metadata: { changeCount: changes.length },
          };
        }

        const result = await ctx.onPromptChangeSubmit(changes);

        return {
          title: "submit_prompt_changes",
          output: result.message,
          metadata: { applied: result.applied, changeCount: changes.length },
        };
      },
    };
  }

  dispose?(): Promise<void> {
    return Promise.resolve();
  }
}
