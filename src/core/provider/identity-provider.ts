// @ts-nocheck
/**
 * Identity Provider 插件 — 身份服务。
 *
 * F6: 深化 — 接入 config/loader.ts 的 AppIdentity 系统。
 * 读取用户配置的身份信息（名称、emoji、creature 等），支持运行时更新。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { loadAppIdentity, saveAppIdentity } from '../config/loader.ts'
import type { AppIdentity } from '../types.ts'

export const identityProvider: Plugin = (ctx: any) => {
  let identity: AppIdentity = loadAppIdentity()

  const dispose = ctx.provide('identity', {
    _active: true,
    getId() { return identity.name || 'anon-' + (crypto.randomUUID().slice(0, 8)) },
    getName() { return identity.name || 'Anonymous' },
    getEmoji() { return identity.emoji || '🤖' },
    getCreature() { return identity.creature || 'AI Assistant' },
    getVibe() { return identity.vibe || 'helpful' },
    getAvatar() { return identity.avatar || '' },
    isOnboarded() { return identity.onboarded || false },
    getIdentity(): AppIdentity { return { ...identity } },
    updateIdentity(patch: Partial<AppIdentity>): void {
      identity = { ...identity, ...patch }
      saveAppIdentity(identity)
    },
  })

  // Composite dispose
  const compositeDispose = () => {
    dispose()
  }
  return compositeDispose
}
