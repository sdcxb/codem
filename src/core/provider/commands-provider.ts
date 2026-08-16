// @ts-nocheck
/**
 * Commands Provider 插件 — 命令注册/执行服务。
 *
 * ⚠️ STUB — 无真实实现源。当前仅 Map CRUD。
 *
 * 开发计划：
 * - 实现真实的 CommandManager（类似 VS Code command system）
 * - 将 SlashCommandMenu.tsx 中的斜杠命令获取从 getSkillRegistry() 改为 ctx.commands.list()
 * - 支持命令参数类型校验和自动补全
 * - 支持命令别名和快捷键绑定
 * - 第三方插件通过 ctx.commands.register() 注册自定义命令
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
