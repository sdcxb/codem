// @ts-nocheck
/**
 * Identity Provider 插件 — 身份服务。
 *
 * ⚠️ STUB — 无真实实现源。当前返回随机 UUID + 'Anonymous'。
 *
 * 开发计划：
 * - 实现真实的 identity 系统（用户认证、设备指纹、会话身份）
 * - 接入 Tauri stronghold 或系统 keychain 存储身份凭证
 * - 支持多用户切换
 * - 第三方插件通过 ctx.identity 获取当前用户身份
 */
import type { Plugin } from '../cordis/src/index.ts'

export const identityProvider: Plugin = (ctx: any) => {
  const id = crypto.randomUUID()

  const dispose = ctx.provide('identity', {
    getId() { return id },
    getName() { return 'Anonymous' },
  })

  return dispose
}
