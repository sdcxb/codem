// @ts-nocheck
/**
 * @codem/computer-use — Cordis provider
 *
 * 服务面 ctx.computerUse：读/写模式设置 + 会话批准查询。
 * LLM 工具（computer_*）由 LLMEngine.setupDelegationTools 独立注册；
 * 插件"禁用 = 关闭"由 App 联动实现：禁用时调用 setComputerPluginEnabled(false)，
 * modeGate 全拒（含 auto 模式）——与 KNOWN riskDescription 一致（审计 D2/B3 修复）。
 * 设置面「电脑操作」tab 在禁用后仍可进入但工具不可用，文案已同步。
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  getComputerSettings, setComputerMode, isSessionApproved, approveSession,
  type ComputerMode,
} from '../computer-use/computer-use'

export const computerUseProvider: Plugin = (ctx: any) => {
  const s = {
    getSettings: () => getComputerSettings(),
    setMode: (mode: ComputerMode) => setComputerMode(mode),
    isApproved: (sessionId: string) => isSessionApproved(sessionId),
    approve: (sessionId: string) => approveSession(sessionId),
  }
  return ctx.provide('computerUse', s)
}
