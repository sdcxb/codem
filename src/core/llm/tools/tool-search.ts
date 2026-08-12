/**
 * Tool Search — P0-2 延迟加载的配套工具
 *
 * 当 LLM 需要使用某个 deferred 工具时，先调用 tool_search 获取完整 schema，
 * 下一轮迭代时 LLM 就能看到完整参数定义并调用目标工具。
 *
 * 使用方式：
 *   tool_search({ query: "lsp" })      → 按名称搜索，返回完整 schema
 *   tool_search({ query: "select:lsp" }) → 同上，Claude Code 兼容语法
 *   tool_search({ query: "code navigation" }) → 按关键词模糊搜索 searchHint
 *
 * 返回格式：
 *   如果匹配到 1 个工具 → 返回完整 schema（name + description + parameters）
 *   如果匹配到多个工具 → 返回所有匹配的名称列表，让 LLM 精确选择
 *   如果没有匹配 → 返回所有可用的 deferred 工具列表
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";
import type { ToolRegistry } from "../tools";

interface ToolSearchInput {
  query: string;
}

export function createToolSearchTool(registry: ToolRegistry): ToolDef {
  return {
    id: "tool_search",
    description:
      "Search for and load a deferred tool's full schema. " +
      "Some tools (like 'lsp') are not loaded by default to save tokens. " +
      "Call this tool with the tool name or keyword to retrieve the full parameter schema. " +
      "After calling this tool, you can use the target tool in the next iteration.\n\n" +
      "Usage:\n" +
      '  tool_search({ query: "lsp" }) — load the LSP tool schema\n' +
      '  tool_search({ query: "code navigation" }) — search by keyword\n' +
      '  tool_search({ query: "select:lsp" }) — explicit select syntax',
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Tool name (e.g. 'lsp') or keyword to search for. " +
            "Use 'select:<name>' syntax for explicit selection.",
        },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const input = args as unknown as ToolSearchInput;
      const query = (input.query || "").trim();

      if (!query) {
        return {
          title: "tool_search: Error",
          output: "Error: query parameter is required.",
        };
      }

      // Strip "select:" prefix (Claude Code compatibility)
      const searchTerm = query.startsWith("select:")
        ? query.substring(7).trim()
        : query;

      // Get all deferred definitions
      const deferredList = registry.getDeferredDefinitions();

      if (deferredList.length === 0) {
        return {
          title: "tool_search: No deferred tools",
          output: "No deferred tools are available. All tools are already loaded with full schemas.",
        };
      }

      // Exact name match
      const exactMatch = deferredList.find(
        (t) => t.name.toLowerCase() === searchTerm.toLowerCase(),
      );

      if (exactMatch) {
        const fullDef = registry.getDeferredDefinition(exactMatch.name);
        if (fullDef) {
          return {
            title: `tool_search: ${exactMatch.name} loaded`,
            output:
              `Tool "${exactMatch.name}" schema loaded successfully.\n\n` +
              `You can now call this tool. Here is the full schema:\n\n` +
              JSON.stringify(fullDef, null, 2) +
              `\n\nCall ${exactMatch.name} with the appropriate parameters in your next response.`,
          };
        }
      }

      // Fuzzy search in searchHint
      const fuzzyMatches = deferredList.filter((t) => {
        const hint = t.searchHint.toLowerCase();
        const name = t.name.toLowerCase();
        const term = searchTerm.toLowerCase();
        return (
          name.includes(term) ||
          hint.includes(term) ||
          term.split(/\s+/).some((word) => hint.includes(word))
        );
      });

      if (fuzzyMatches.length === 1) {
        const fullDef = registry.getDeferredDefinition(fuzzyMatches[0].name);
        if (fullDef) {
          return {
            title: `tool_search: ${fuzzyMatches[0].name} loaded`,
            output:
              `Tool "${fuzzyMatches[0].name}" schema loaded successfully.\n\n` +
              `You can now call this tool. Here is the full schema:\n\n` +
              JSON.stringify(fullDef, null, 2) +
              `\n\nCall ${fuzzyMatches[0].name} with the appropriate parameters in your next response.`,
          };
        }
      }

      if (fuzzyMatches.length > 1) {
        return {
          title: `tool_search: ${fuzzyMatches.length} matches`,
          output:
            `Multiple tools matched "${searchTerm}". Please specify the exact tool name:\n\n` +
            fuzzyMatches
              .map((t) => `- ${t.name}: ${t.searchHint}`)
              .join("\n") +
            `\n\nCall tool_search again with the exact name, e.g. tool_search({ query: "${fuzzyMatches[0].name}" })`,
        };
      }

      // No match — list all available deferred tools
      return {
        title: "tool_search: No match",
        output:
          `No deferred tool matched "${searchTerm}".\n\n` +
          `Available deferred tools:\n` +
          deferredList
            .map((t) => `- ${t.name}: ${t.searchHint}`)
            .join("\n") +
            `\n\nCall tool_search with one of the above tool names.`,
      };
    },
  };
}
