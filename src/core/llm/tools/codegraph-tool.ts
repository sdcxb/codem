/**
 * CodeGraph MCP 工具接入（defer 按需加载，对齐 lsp/defer 机制）
 *
 * 背景：CodeGraph（codegraph CLI → MCP stdio）此前只在 systemPrompt 文本里
 * 提示"优先使用 codegraph_explore"，但 LLM 的 function-calling schema 里
 * **没有该工具**——指导落空（模型照调会报工具不存在）且浪费 token。
 *
 * 本模块把已连接的 codegraph MCP 工具包装为**可调用的 defer ToolDef**：
 * - shouldDefer: true —— 完整 schema 默认不进请求（省 token），只在 model
 *   调用 tool_search 拉取时才出现（该轮才计 schema 成本）；
 * - searchHint 写明"何时用"（调用链/谁调用/影响范围），普通读写仍走
 *   read/grep/glob —— 场景由模型按任务判断，不做强制门控；
 * - 提示与可调用集合严格一致：只有 codegraph MCP 真连接（工具注册）才出现
 *   在 Deferred hints 里；断连即移除（syncCodeGraphTools）。
 */

import type { ToolDef, ToolRegistry } from "../tools";
import { getMCPRegistry } from "../../mcp/mcp";
import type { MCPTool } from "../../mcp/mcp";

/** codegraph MCP server 名（与 mcp.ts CODEGRAPH_SERVER_NAME 一致） */
export const CODEGRAPH_SERVER = "codegraph";

/** codegraph 工具名前缀（codegraph_explore / codegraph_search …） */
const CODEGRAPH_TOOL_PREFIX = "codegraph_";

/** 判断一个 MCP 工具是否属于 codegraph（server 名或工具名前缀） */
export function isCodeGraphMcpTool(tool: { server: string; name: string }): boolean {
  return tool.server === CODEGRAPH_SERVER || tool.name.startsWith(CODEGRAPH_TOOL_PREFIX);
}

/** 把 MCP 工具名规整为 ToolDef id（原名，如 codegraph_explore） */
export function codeGraphToolId(name: string): string {
  return name;
}

/** 把 MCP 工具结果（content 数组）展平为文本 */
export function mcpResultToText(result: { content?: Array<{ type: string; text?: string }> }): string {
  if (!result?.content) return "";
  return result.content
    .map((c) => (c.type === "text" ? c.text || "" : JSON.stringify(c)))
    .filter(Boolean)
    .join("\n");
}

/** 包装一个已连接的 codegraph MCP 工具为 defer ToolDef */
export function createCodeGraphTool(tool: MCPTool & { server: string }): ToolDef {
  const name = tool.name;
  const description = tool.description || `CodeGraph ${name}`;
  // 参数：MCP 工具已带 JSON Schema（可能含非标准键，浅拷贝保留标准键）
  const parameters: Record<string, unknown> = { ...(tool.inputSchema || {}) };
  return {
    id: codeGraphToolId(name),
    description,
    parameters,
    shouldDefer: true,
    searchHint:
      "codegraph 代码图谱查询（调用链/谁调用/改动影响范围等代码关系问题）：" +
      `工具 ${name} 为 deferred——先调用 tool_search 获取完整参数 schema 再使用；` +
      "普通读文件用 read、按名搜用 glob、按内容搜用 grep。",
    execute: async (args, _ctx) => {
      try {
        const result = await getMCPRegistry().callTool(tool.server, name, args as Record<string, unknown>);
        const text = mcpResultToText(result as any);
        return {
          title: `CodeGraph ${name}`,
          output: result && (result as any).isError
            ? `[CodeGraph error]\n${text || JSON.stringify(result)}`
            : (text || JSON.stringify(result)),
        };
      } catch (e: any) {
        return { title: `CodeGraph ${name}`, output: `[CodeGraph error] ${e?.message || e}` };
      }
    },
  };
}

/**
 * 同步 codegraph 工具到 ToolRegistry（与 MCP 连接状态一致）。
 *
 * - 连接的 codegraph 工具缺失 → 注册（defer ToolDef）；
 * - 已断连/不再存在的 codegraph 工具残留 → 移除（提示与可调用集合一致）。
 * 幂等；engine 每次构建系统提示（autoDetect 后）调用。
 */
export function syncCodeGraphTools(registry: ToolRegistry, mcpTools: Array<MCPTool & { server: string }>): void {
  const active = new Set<string>();
  for (const t of mcpTools) {
    if (!isCodeGraphMcpTool(t)) continue;
    const id = codeGraphToolId(t.name);
    active.add(id);
    if (!registry.get(id)) {
      registry.register(createCodeGraphTool(t));
    }
  }
  for (const def of registry.getAll()) {
    if (def.id.startsWith(CODEGRAPH_TOOL_PREFIX) && !active.has(def.id)) {
      registry.remove(def.id);
    }
  }
}
