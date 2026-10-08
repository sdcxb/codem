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
    /**
     * ★ 第 185 波（T6）：把**调用方给的真实 ctx 字段**透传下去。
     * 改动前 `run` 只收 `options`（`mode`），`execWorkflow` 又用空对象调工具 ⇒
     * `sdk.bash` 丢 cwd、`sdk.write` 的 `{ workspace: ctx.cwd }` 为 undefined
     * ⇒ S5 沙箱检查整条不做。现在 `cwd` / `sessionId` / `securityMode`（以及
     * provider 自己 context 上同名的那几个）都会被带下去。
     */
    async run(steps: any[], options?: {
      mode?: 'parallel' | 'serial';
      cwd?: string;
      sessionId?: string;
      securityMode?: 'ask' | 'auto' | 'full';
    }) {
      return execWorkflow(steps, {
        ...options,
        cwd: options?.cwd ?? ctx?.cwd,
        sessionId: options?.sessionId ?? ctx?.sessionId,
        securityMode: options?.securityMode ?? ctx?.securityMode,
      })
    },
  })

  return dispose
}
