// 类型 + parseTaskResult 从 subagent.ts 导出
// Runtime 从 runtime.ts 导出
export { SubagentRuntime } from "./runtime";

// ========== DSH-style 全局 Runtime 访问 ==========

import type { SubagentRuntime } from "./runtime";

/**
 * DSH-style 全局 SubagentRuntime 引用。
 * 对标 DSH 的 ctx.subagents — 在非 Cordis 上下文中提供对 runtime 的访问。
 * 由 LLMEngine 在初始化时设置。
 */
let _globalRuntime: SubagentRuntime | null = null;

/**
 * 设置全局 SubagentRuntime — 由 LLMEngine 构造时调用。
 * DSH 对标：ctx.provide('subagents', runtime)
 */
export function setGlobalSubagentRuntime(rt: SubagentRuntime | null): void {
  _globalRuntime = rt;
}

/**
 * 获取全局 SubagentRuntime — UI 组件和 workflow 通过此方法访问子智能体状态。
 * DSH 对标：ctx.get('subagents') / ctx.subagents
 */
export function getSubagentRuntime(): SubagentRuntime | null {
  return _globalRuntime;
}
