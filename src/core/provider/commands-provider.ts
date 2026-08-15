// @ts-nocheck
/**
 * Commands Provider 插件 — 命令注册/执行服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const commandsProvider: Plugin = (ctx: any) => {
  const commandsMap = new Map<string, any>()

  const dispose = ctx.provide('commands', {
    register(name: string, handler: any, description?: string) { commandsMap.set(name, { handler, description }) },
    execute(name: string, args?: any) { return commandsMap.get(name)?.handler(args) },
    list() { return [...commandsMap.entries()].map(([name, { description }]) => ({ name, description })) },
  })

  return dispose
}
