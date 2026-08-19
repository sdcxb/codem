// @ts-nocheck
/**
 * Recovery Provider 插件 — 可独立加载/卸载/热替换。
 *
 * 在 Provider 内部创建 SessionRecoveryService 实例，生命周期与 fiber 绑定。
 * 不再使用模块级单例 getSessionRecoveryService()。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { SessionRecoveryService } from '../recovery/recovery'

export const recoveryProvider: Plugin = (ctx: any) => {
  const service = new SessionRecoveryService()

  const dispose = ctx.provide('recovery', {
    saveSession(session: any) { return service.saveSession(session) },
    loadSession(sessionId: string) { return service.loadSession(sessionId) },
    getAllSessions() { return service.getAllSessions() },
    getProjectSessions(projectId: string) { return service.getProjectSessions(projectId) },
    deleteSession(sessionId: string) { return service.deleteSession(sessionId) },
    setCurrentSession(sessionId: string | null) { return service.setCurrentSession(sessionId) },
    getCurrentSessionId() { return service.getCurrentSessionId() },
    addMessage(sessionId: string, message: any) { return service.addMessage(sessionId, message) },
    updateMessage(sessionId: string, messageId: string, updater: any) { return service.updateMessage(sessionId, messageId, updater) },
    getSessionState(sessionId: string) { return service.getSessionState(sessionId) },
    getRecoverySummary() { return service.getRecoverySummary() },
    stopAutoSave() { return service.stopAutoSave() },
  })

  return dispose
}
