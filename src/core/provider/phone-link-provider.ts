// @ts-nocheck
/**
 * @codem/phone-link — Cordis provider
 *
 * 服务面 ctx.phoneLink：手机连接（dsh-phone 对标）状态/设置/启动。
 * Rust LAN HTTP 地基（配对门卫 + 静态页 + 请求代理）在 src-tauri/src/phone/；
 * 引擎半层（路由到会话/消息/chat）在 core/phone-link/。
 * 禁用本插件后 ctx.phoneLink 不可用；LAN 服务启停由设置卡 + autoStart 控制。
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  getPhoneStateCache, getPhoneSettings, savePhoneSettings, startPhoneLink,
  type PhoneBridgeSettings,
} from '../phone-link/phone-link'

export const phoneLinkProvider: Plugin = (ctx: any) => {
  const s = {
    /** 最近 phone-state 缓存（无 IPC 轮询） */
    getStatus: () => getPhoneStateCache(),
    getSettings: (): PhoneBridgeSettings => getPhoneSettings(),
    saveSettings: (patch: Partial<PhoneBridgeSettings>) => savePhoneSettings(patch),
    /** 启动桥（幂等）：监听 phone-* 事件 + autoStart 拉起 LAN 服务 */
    start: () => startPhoneLink(),
  }
  return ctx.provide('phoneLink', s)
}
