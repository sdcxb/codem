// @ts-nocheck
/**
 * @codem/tool-cordis — Agent 自修改工具 Consumer
 *
 * 注册 cordis_inspect/cordis_define/cordis_run/cordis_retract 工具，
 * 让 Agent 可以在运行时检查/加载/卸载插件。
 */
import { defineTool, useCtx } from '../../consumer/index.ts'

export const inject = ['dynamicCordisRunner', 'tools'] as const

export function apply() {
  const ctx = useCtx()

  defineTool({
    name: 'cordis_inspect',
    description: 'Inspect all loaded plugins and services in the Cordis context',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const runner = ctx.get('dynamicCordisRunner')
      if (!runner) return 'Dynamic Cordis Runner not available'
      const result = runner.inspect()
      return JSON.stringify(result, null, 2)
    },
  })

  defineTool({
    name: 'cordis_define',
    description: 'Define and load a new plugin from code',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin name' },
        code: { type: 'string', description: 'Plugin code (JavaScript)' },
      },
      required: ['name', 'code'],
    },
    requirePermission: true,
    async execute({ name, code }: { name: string; code: string }) {
      const runner = ctx.get('dynamicCordisRunner')
      if (!runner) return 'Dynamic Cordis Runner not available'
      const result = await runner.define(name, code)
      return result.success
        ? `Plugin "${name}" defined successfully`
        : `Failed: ${result.error}`
    },
  })

  defineTool({
    name: 'cordis_run',
    description: 'Run a previously defined plugin',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin name' },
        args: { type: 'string', description: 'Arguments (JSON)' },
      },
      required: ['name'],
    },
    async execute({ name, args }: { name: string; args?: string }) {
      const runner = ctx.get('dynamicCordisRunner')
      if (!runner) return 'Dynamic Cordis Runner not available'
      const parsedArgs = args ? JSON.parse(args) : undefined
      const result = await runner.run(name, parsedArgs)
      return result.success
        ? `Result: ${JSON.stringify(result.result)}`
        : `Failed: ${result.error}`
    },
  })

  defineTool({
    name: 'cordis_retract',
    description: 'Retract a previously defined plugin',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin name' },
      },
      required: ['name'],
    },
    requirePermission: true,
    async execute({ name }: { name: string }) {
      const runner = ctx.get('dynamicCordisRunner')
      if (!runner) return 'Dynamic Cordis Runner not available'
      const result = runner.retract(name)
      return result.success
        ? `Plugin "${name}" retracted`
        : `Failed: ${result.error}`
    },
  })
}
