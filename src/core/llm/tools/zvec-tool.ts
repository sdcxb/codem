/**
 * zvec-grep（zg）MCP 工具同步 —— 仿 codegraph 模式，但直接可用（非 defer）。
 *
 * zg 的 zvec_grep_search 等经 MCP stdio（server: zvec_grep）暴露；
 * MCP 工具不会自动进入 ToolRegistry，这里把已连接服务器的工具注册为
 * 普通 ToolDef（description 携带官方路由意图），LLM 可直接调用。
 *
 * 双轨路由原则（与内置 grep 并行）：
 * - 精确锚点（标识符/引号/文件名/正则）→ 内置 grep；
 * - 措辞/位置未知、语义/模糊/跨文件/调用链综合 → zvec_grep_search；
 * - 混合任务 → 先 zvec_grep_search 发现，再 grep/read 验证。
 */

import type { ToolDef, ToolExecuteResult, ToolRegistry } from "../tools";
import type { MCPTool } from "../../mcp/mcp";
import { getMCPRegistry } from "../../mcp/mcp";

/** zg MCP 服务器名（与 core/zvec-grep 一致，避免循环依赖故内联常量） */
export const ZVEC_MCP_SERVER_NAME = "zvec_grep";

/** MCP 结果 → 文本 */
function mcpResultToText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
  if (!r) return String(result);
  return (r.content || [])
    .map((c) => (c.type === "text" ? c.text || "" : JSON.stringify(c)))
    .filter(Boolean)
    .join("\n");
}

/** 是否 zg MCP 工具 */
export function isZvecMcpTool(tool: { server: string }): boolean {
  return tool.server === ZVEC_MCP_SERVER_NAME;
}

/** 包装 zg MCP 工具为可直接调用的 ToolDef */
export function createZvecTool(tool: MCPTool & { server: string }): ToolDef {
  const name = tool.name;
  const description =
    tool.description ||
    `zvec-grep 语义检索工具（${name}）—— 本地索引的语义/词法混合搜索，返回按文件分组的证据（行号+片段）。`;
  const parameters: Record<string, unknown> = { ...(tool.inputSchema || {}) };
  return {
    id: name,
    description,
    parameters,
    execute: async (args, _ctx): Promise<ToolExecuteResult> => {
      try {
        const result = await getMCPRegistry().callTool(ZVEC_MCP_SERVER_NAME, name, args as Record<string, unknown>);
        const text = mcpResultToText(result as any);
        /**
         * 第 D10b 波（假成功 A 类）：zg 的 MCP 结果用 `isError` 表示"检索自身失败"
         * （例如索引未就绪 / 查询语法错），而这里的失败文本以 `[zvec-grep error]` 开头 ——
         * 首字符是 `[`，**永远不可能**匹配 `tool-result-status.ts` 的首行前缀正则
         * （`/^(?:error|错误|失败)\s*[:：-]/i`），而 `zvec_*` 也不在 `CONTENT_TOOLS` 里。
         * 于是失败被判成 `completed`。
         *
         * 修法：文本照旧（`[zvec-grep error]` 对模型是有用的诊断内容），
         * 失败由显式 `isError` 表达。**注意只在 MCP 自报 isError 时才声明失败** ——
         * "检索成功但零命中"仍是正常结果（下面 `text || JSON.stringify(result)` 那条路径），
         * 不能把「没有结果」变成错误。
         */
        const failed = !!(result && (result as any).isError);
        return {
          title: name,
          output: failed ? `[zvec-grep error]\n${text || JSON.stringify(result)}` : text || JSON.stringify(result),
          isError: failed,
        };
      } catch (e: any) {
        // 第 D10b 波：调用本身抛错（MCP 未连接 / 服务器崩了 / 超时）——
        // 检索从未发生，必须显式声明失败。
        return { title: name, output: `[zvec-grep error] ${e?.message || e}`, isError: true };
      }
    },
  };
}

/**
 * 同步 zg 工具到 ToolRegistry（与 MCP 连接状态一致，幂等）。
 * 调用时机：每次构建系统提示时（与 syncCodeGraphTools 同点）。
 */
export function syncZvecTools(registry: ToolRegistry, mcpTools: Array<MCPTool & { server: string }>): void {
  const active = new Set<string>();
  for (const t of mcpTools) {
    if (!isZvecMcpTool(t)) continue;
    active.add(t.name);
    if (!registry.get(t.name)) {
      registry.register(createZvecTool(t));
    }
  }
  // 断连/不再存在的 zg 工具残留 → 移除（提示与可调用集合一致）
  for (const def of registry.getAll()) {
    if (def.id.startsWith("zvec_") && !active.has(def.id)) {
      registry.remove(def.id);
    }
  }
}
