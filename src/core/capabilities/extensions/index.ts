// @ts-nocheck
/**
 * @codem/extensions — Self-Referential Runtime Service Definition
 *
 * 定义 Agent 运行时自修改能力的接口契约。
 * Agent 可以通过 tool-cordis 在运行时检查/定义/运行/撤销插件。
 *
 * 对标 dsh 的 extensions/ 包族。
 */
import type { Context } from '../../cordis/src/index.ts'

export interface DynamicCordisRunner {
  /** 检查所有已加载的插件和服务 */
  inspect(): { plugins: PluginInfo[]; services: string[] }
  /** 定义并加载一个新插件 */
  define(name: string, code: string): Promise<{ success: boolean; error?: string }>
  /** 运行已定义的插件 */
  run(name: string, args?: any): Promise<{ success: boolean; result?: any; error?: string }>
  /** 撤销已定义的插件 */
  retract(name: string): { success: boolean; error?: string }
  /** 列出所有动态定义的插件 */
  list(): string[]
}

export interface PluginInfo {
  name: string
  provides: string[]
  inject: string[]
  isDynamic: boolean
}

declare module '../../cordis/src/context.ts' {
  interface Context {
    /** Self-Referential Runtime — Agent 可运行时管理插件 */
    dynamicCordisRunner: DynamicCordisRunner
  }
}
