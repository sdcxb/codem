// @ts-nocheck
/**
 * @codem/wechat-bridge — Cordis provider
 *
 * 服务面 ctx.wechatBridge：微信 ClawBot（iLink）桥的状态/设置/准入/启动/测试消息。
 * Rust 传输层（ilink_* commands + events）在 src-tauri/src/ilink/；
 * 引擎桥逻辑（peer→会话、命令、agent 驱动）在 core/wechat-bridge/。
 * 禁用本插件后 ctx.wechatBridge 不可用；事件监听由 App 按插件启用状态启动
 * （见 App.tsx——禁用即停桥，与 riskDescription 一致）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import {
  getSettings, saveSettings, startWechatBridge, getStateCache,
  loadAccess, approvePendingPeer, ignorePeer, allowPeerByInput,
  loadPeerMap, sendTestMessage, type WechatBridgeSettings,
} from '../wechat-bridge/wechat-bridge'

export const wechatBridgeProvider: Plugin = (ctx: any) => {
  const s = {
    /** 最近一次 ilink-status/ilink-state 缓存（无 IPC 轮询） */
    getStatus: () => getStateCache(),
    getSettings: (): WechatBridgeSettings => getSettings(),
    saveSettings: (patch: Partial<WechatBridgeSettings>) => saveSettings(patch),
    getAccess: () => loadAccess(),
    getPeerMap: () => loadPeerMap(),
    /** 启动桥（幂等）：监听 ilink-* 事件 + 挂载前缓冲兜底 */
    start: () => startWechatBridge(),
    approve: (peer: string) => approvePendingPeer(peer),
    ignore: (peer: string) => ignorePeer(peer),
    allowByInput: (peer: string) => allowPeerByInput(peer),
    /** 给已配对/白名单 peer 发一条测试消息（消耗该 peer 配额预算） */
    testMessage: (peer: string, text: string) => sendTestMessage(peer, text),
  }
  return ctx.provide('wechatBridge', s)
}
