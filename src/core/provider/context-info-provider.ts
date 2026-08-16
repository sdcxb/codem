// @ts-nocheck
/**
 * Context Info Provider 插件 — 上下文信息服务。
 *
 * ⚠️ STUB — 无真实实现源。当前返回硬编码字符串。
 *
 * 开发计划：
 * - 将 prompt.ts 的 buildSystemPrompt() 上下文组装逻辑适配为 ContextService 接口
 * - getInstructions() 返回动态上下文（当前项目、文件树、Git 状态等）
 * - getTime() 返回格式化的当前时间
 * - getWorkspace() 返回工作区信息（路径、打开的文件、光标位置等）
 * - 支持第三方插件通过 ctx.contextInfo 注入自定义上下文
 */
import type { Plugin } from '../cordis/src/index.ts'

export const contextInfoProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('contextInfo', {
    getInstructions() { return 'You are a helpful AI coding assistant.' },
    getTime() { return new Date().toISOString() },
    getWorkspace() { return '/' },
    assemble() {
      return `${this.getInstructions()}\n\nCurrent time: ${this.getTime()}\nWorkspace: ${this.getWorkspace()}`
    },
  })

  return dispose
}
