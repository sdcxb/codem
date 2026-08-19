// @ts-nocheck
/**
 * Commands Provider 插件 — 命令注册/执行服务。
 *
 * F6: 深化 — 接入 skill/registry.ts 的技能列表作为命令源。
 * SlashCommandMenu.tsx 可通过 ctx.commands.list() 获取所有可用命令（技能）。
 * 支持第三方插件通过 ctx.commands.register() 注册自定义命令。
 */
import type { Plugin } from '../cordis/src/index.ts'

export interface CommandEntry {
  name: string
  description?: string
  category?: string
  handler: (args?: any) => any
}

export const commandsProvider: Plugin = (ctx: any) => {
  const commandsMap = new Map<string, CommandEntry & { source: string }>()

  const dispose = ctx.provide('commands', {
    _active: true,

    /** Register a command */
    register(name: string, handler: (args?: any) => any, description?: string, category?: string) {
      commandsMap.set(name, { name, handler, description, category, source: 'plugin' })
    },

    /** Unregister a command */
    unregister(name: string) {
      commandsMap.delete(name)
    },

    /** Execute a command by name */
    async execute(name: string, args?: any) {
      const cmd = commandsMap.get(name)
      if (!cmd) {
        // Try to find in skill registry if available
        const skillReg = ctx?.get?.('skills')
        if (skillReg?.get) {
          const skill = skillReg.get(name)
          if (skill?.execute) return skill.execute(args)
        }
        throw new Error(`Command not found: ${name}`)
      }
      return cmd.handler(args)
    },

    /** List all registered commands */
    list(): Array<CommandEntry & { source: string }> {
      const entries = [...commandsMap.values()]

      // Merge with skill registry commands if available
      const skillReg = ctx?.get?.('skills')
      if (skillReg?.getAll) {
        const skills = skillReg.getAll()
        for (const skill of skills) {
          if (!commandsMap.has(skill.name)) {
            entries.push({
              name: skill.name,
              description: skill.description,
              category: 'skill',
              handler: skill.execute || (() => {}),
              source: 'skill',
            })
          }
        }
      }

      return entries
    },

    /** Check if a command exists */
    has(name: string) {
      return commandsMap.has(name)
    },
  })

  // Composite dispose
  const compositeDispose = () => {
    commandsMap.clear()
    dispose()
  }
  return compositeDispose
}
