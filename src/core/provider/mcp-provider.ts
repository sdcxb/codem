// @ts-nocheck
/**
 * MCP Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getMCPRegistry } from '../mcp/mcp'

export const mcpProvider: Plugin = (ctx: any) => {
  const mcpRegistry = getMCPRegistry()

  const dispose = ctx.provide('mcp', {
    registerServer: async (config: any) => { await mcpRegistry.addServer(config) },
    unregisterServer: (id: string) => { mcpRegistry.removeServer(id) },
    listServers: () => mcpRegistry.listServers(),
    callTool: async (server: string, tool: string, input: any) => mcpRegistry.callTool(server, tool, input),
  })

  return dispose
}
