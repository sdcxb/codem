// @ts-nocheck
/**
 * @codem/computer-use — Cordis provider
 *
 * 服务面 ctx.computerUse：读/写模式设置 + 会话批准查询。
 * LLM 工具（computer_*）由 LLMEngine.setupDelegationTools 独立注册；
 * 本 provider 承载"插件可启停"语义与设置面（禁用 @codem/computer-use 后
 * ctx.computerUse 不可用；工具注册处仍注册但门禁按模式拒绝——为彻底关闭
 * 需插件管理器禁用 + 设置模式 disabled 双保险，见 UI 提示）。
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
