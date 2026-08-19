// @ts-nocheck
/**
 * @codem/agent-instructions — Agent 指令上下文，系统级指令注入和管理
 */
import type { Plugin } from '../cordis/src/index.ts'

export const agentInstructionsProvider: Plugin = (ctx: any) => {
  const s = {
    instructions: new Map(),
    add(k: string, v: string) { this.instructions.set(k, v) },
    remove(k: string) { this.instructions.delete(k) },
    get(k: string) { return this.instructions.get(k) },
    buildSystemPrompt(extra?: string): string {
      const parts = [...this.instructions.values()]
      if (extra) parts.push(extra)
      return parts.join('\n\n')
    },
    list() { return [...this.instructions.entries()].map(([k, v]) => ({ key: k, instruction: v })) },
  }
  return ctx.provide('agentInstructions', s)
}
