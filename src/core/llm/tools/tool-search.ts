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

/**
 * 工具别名（**中文/英文都收**）—— 解决"换个说法就找不到了"。
 *
 * 为什么需要：`searchHint` 是英文为主，而用户（以及被用户措辞带偏的模型）常用中文说
 * 「跳转定义」「找引用」「工作流」。旧实现的模糊匹配只做**子串/空格分词**：
 * 中文整串在英文 hint 里必然 miss；英文多词（"jump to definition"）又会因为 "to" 这种词
 * 命中一堆工具。别名表 + 打分把"同义说法"变成一等公民。
 *
 * 纪律：别名只做**召回**，最终仍按分数排序；分数并列时返回列表让模型自己选，
 * 不猜（猜错会直接调错工具）。
 */
const TOOL_ALIASES: Record<string, string[]> = {
  lsp: [
    "代码导航",
    "代码跳转",
    "跳转定义",
    "转到定义",
    "查找引用",
    "找引用",
    "符号定义",
    "符号列表",
    "code navigation",
    "go to definition",
    "jump to definition",
    "find references",
    "document symbols",
    "definition",
    "references",
    "hover",
  ],
  workflow: ["工作流", "流程编排", "并行子代理", "多个子代理", "fan out", "subagent workflow", "workflow"],
  github_tool: ["github", "pull request", "pr review", "拉取请求", "代码评审", "评审"],
  figma_fetch: ["figma", "设计稿", "设计文件", "设计规范"],
  browser_automate: ["浏览器", "无头浏览器", "playwright", "网页截图", "页面截图"],
  tts: ["朗读", "语音", "text to speech", "tts"],
  image_gen: ["生成图片", "画图", "图像生成", "image generation", "draw", "image"],
  generate_ppt: ["ppt", "幻灯片", "演示文稿", "slides"],
  cordis_define: ["动态插件", "cordis", "自定义插件"],
  cordis_inspect: ["动态插件", "cordis", "插件列表"],
  cordis_run: ["动态插件", "cordis", "运行插件"],
  cordis_stop: ["动态插件", "cordis", "停止插件"],
  cordis_undefine: ["动态插件", "cordis", "卸载插件"],
};

/** 归一化：小写、去首尾空白、把常见标点压成空格 */
function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：()（）\[\]【】"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 给一个 deferred 工具打分：名称 > 别名 > hint 子串 > 空格分词。
 * 0 分 = 不相关。
 */
function scoreTool(query: string, tool: { name: string; searchHint: string }): number {
  const q = normalize(query);
  if (!q) return 0;
  const name = tool.name.toLowerCase();
  const hint = normalize(tool.searchHint);
  const aliases = (TOOL_ALIASES[tool.name] ?? []).map(normalize);

  if (name === q) return 1000;
  if (q.length >= 3 && (name.includes(q) || q.includes(name))) return 400;

  let best = 0;
  for (const alias of aliases) {
    if (!alias) continue;
    if (alias === q) best = Math.max(best, 300);
    else if (q.length >= 2 && (alias.includes(q) || q.includes(alias))) best = Math.max(best, 200);
  }
  if (best > 0) return best;

  if (hint.includes(q)) return 150;
  /** 英文多词：只把**长度 ≥ 3** 的词算数（"to" / "of" 这类虚词命中一切） */
  const words = q.split(" ").filter((w) => w.length >= 3);
  if (words.length > 0) {
    const hits = words.filter((w) => hint.includes(w) || name.includes(w)).length;
    if (hits > 0) return 40 + hits * 20;
  }
  return 0;
}


export function createToolSearchTool(registry: ToolRegistry): ToolDef {
  return {
    id: "tool_search",
    contract: { sideEffectScope: "session", accessScope: "session" },
    guidance: "Use tool_search to load the full schema of a deferred tool (e.g. lsp). Some tools are not loaded by default to save tokens. Call this before using a tool you haven't seen in the available tools list.",
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
          output: "Error: query parameter is required.", isError: true,
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
          output: "No deferred tools are available. All tools are already loaded with full schemas.", isError: false,
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
              `\n\nCall ${exactMatch.name} with the appropriate parameters in your next response.`, isError: false,
          };
        }
      }

      // Fuzzy search：别名 + hint + 分词打分（见 `scoreTool` 的说明）
      const scored = deferredList
        .map((t) => ({ tool: t, score: scoreTool(searchTerm, t) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

      /**
       * 高分且领先第二名足够多 ⇒ 直接加载（旧行为：唯一匹配时返回完整 schema）。
       * 否则返回**排序后的候选列表**，让模型自己确认 —— 猜错的成本是调错工具，不是省一次调用。
       */
      const top = scored[0];
      const second = scored[1];
      const decisive = top && (top.score >= 300 || !second || top.score >= second.score + 100);
      const fuzzyMatches = decisive && top ? [top.tool] : scored.map((x) => x.tool);

      if (fuzzyMatches.length === 1) {
        const fullDef = registry.getDeferredDefinition(fuzzyMatches[0].name);
        if (fullDef) {
          return {
            title: `tool_search: ${fuzzyMatches[0].name} loaded`,
            output:
              `Tool "${fuzzyMatches[0].name}" schema loaded successfully.\n\n` +
              `You can now call this tool. Here is the full schema:\n\n` +
              JSON.stringify(fullDef, null, 2) +
              `\n\nCall ${fuzzyMatches[0].name} with the appropriate parameters in your next response.`, isError: false,
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
            `\n\nCall tool_search again with the exact name, e.g. tool_search({ query: "${fuzzyMatches[0].name}" })`, isError: false,
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
            `\n\nCall tool_search with one of the above tool names.`, isError: false,
      };
    },
  };
}
