/**
 * 第 183 波：把 MCP **resources 三件套**按能力接进共享工具表。
 *
 * 与 `syncZvecTools` 同一套模式（注册 + 断连清理），差别只在**门控条件**：
 * 这三个工具不属于某个具体服务器，而是"任一服务器声明了 `resources` 能力"才注册。
 *
 * 门控的理由（平台稳定性与性能）：工具定义会进入**每一轮**请求的 function-calling schema
 * 与系统提示的 MCP 清单；绝大多数服务器不提供 resources，为它们注册三个用不上的工具
 * 等于每一轮都付 token 与选择噪声。
 */
import type { ToolRegistry } from "../tools";
import { createMcpResourceTools } from "./mcp-resources-tool";

/** 三件套的工具 id（用于判定残留） */
export const MCP_RESOURCE_TOOL_IDS = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

export function syncMcpResourceTools(registry: ToolRegistry, serversWithResources: string[]): void {
  const wanted = serversWithResources.length > 0;
  for (const def of createMcpResourceTools()) {
    if (wanted) {
      if (!registry.get(def.id)) registry.register(def);
    } else if (registry.get(def.id)) {
      // 没有服务器声明 resources ⇒ 移除残留（提示与可调用集合严格一致）
      registry.remove(def.id);
    }
  }
}

/** 便于判据断言：当前共享表里有没有三件套 */
export function mcpResourceToolsRegistered(registry: ToolRegistry): string[] {
  return MCP_RESOURCE_TOOL_IDS.filter((id) => Boolean(registry.get(id)));
}
