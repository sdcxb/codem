// @ts-nocheck
/**
 * Workflow Provider 插件 — 包装真实 Workflow 引擎并接入 ctx。
 *
 * 真实实现源：src/core/llm/workflow-engine.ts（133 行完整实现）
 * 支持：fan-out 子智能体 + WorkflowSDK + 并行/串行执行
 *
 * 接入点：
 * - LLM 工具通过 ctx.workflow 启动工作流
 * - AgenticLoop 可通过 ctx.workflow 编排多智能体协作
 */
import type { Plugin } from '../cordis/src/index.ts'
import { execWorkflow } from '../llm/workflow-engine.ts'

export const workflowProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('workflow', {
    async run(steps: any[], options?: { mode?: 'parallel' | 'serial' }) {
      return execWorkflow(steps, options)
    },
  })

  return dispose
}
