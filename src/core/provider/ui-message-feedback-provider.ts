// @ts-nocheck
/**
 * @codem/ui-message-feedback — 消息反馈 UI 插件
 *
 * 提供用户对 AI 回复的反馈机制（点赞/点踩/复制/重新生成）。
 *
 * 功能链路融入：
 * - 启动时：注册反馈服务，对话 UI 可注册反馈组件
 * - 停止时：反馈 UI 不显示，但不影响对话功能
 */
import type { Plugin } from '../cordis/src/index.ts'

class MessageFeedbackService {
  private feedbacks: Map<string, { type: 'like' | 'dislike' | null; comment?: string; timestamp: number }> = new Map()
  private listeners: Array<(messageId: string, feedback: any) => void> = []

  record(messageId: string, type: 'like' | 'dislike' | null, comment?: string) {
    this.feedbacks.set(messageId, { type, comment, timestamp: Date.now() })
    this.notify(messageId, { type, comment })
  }

  get(messageId: string) {
    return this.feedbacks.get(messageId) || { type: null }
  }

  getAll() {
    return [...this.feedbacks.entries()].map(([id, f]) => ({ messageId: id, ...f }))
  }

  subscribe(listener: (messageId: string, feedback: any) => void) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private notify(messageId: string, feedback: any) {
    this.listeners.forEach(l => {
      try { l(messageId, feedback) } catch (e) { console.warn('[ui-message-feedback-provider.ts]', e) }
    })
  }
}

export const uiMessageFeedbackProvider: Plugin = (ctx: any) => {
  const service = new MessageFeedbackService()

  const dispose = ctx.provide('uiMessageFeedback', {
    record: (messageId: string, type: any, comment?: string) => service.record(messageId, type, comment),
    get: (messageId: string) => service.get(messageId),
    getAll: () => service.getAll(),
    subscribe: (listener: any) => service.subscribe(listener),
  })

  return dispose
}
