// @ts-nocheck
/**
 * MiMo Auth Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 将 MiMoAuth 注册为正式的 Cordis 服务，而非在 App.tsx 中直接 ctx.provide()。
 * 这样可以：
 * - 声明 inject 依赖
 * - 有生命周期管理（fiber、dispose 等）
 * - 被 YAML 配置控制（可以 disabled）
 * - 添加 _active 属性兼容 MiMoAuthService 接口
 *
 * 注意：MiMoAuth 依赖 Tauri 环境（window.__TAURI__）。
 * 在非 Tauri 环境中，方法会 catch 错误并返回 null。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getMiMoAuth, MiMoAuth } from '../auth/mimo'

export const mimoAuthProvider: Plugin = (ctx: any) => {
  const auth = getMiMoAuth()

  // 包装为兼容 MiMoAuthService 接口的服务对象
  const service = {
    _active: true,
    getActiveAccount: () => auth.getActiveAccount(),
    loadFromAuthJson: () => auth.loadFromAuthJson(),
    login: () => auth.login(),
    logout: (accountId: string) => auth.logout(accountId),
    getValidToken: (account: any) => auth.getValidToken(account),
  }

  const dispose = ctx.provide('mimoAuth', service)

  return dispose
}
