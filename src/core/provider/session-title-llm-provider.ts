// @ts-nocheck
/**
 * @codem/session-title-llm — LLM 生成会话标题插件
 *
 * 使用 LLM 自动生成会话标题，替代默认的"对话 N"。
 * 可独立加载/卸载/热替换。
 *
 * 功能链路融入：
 * - 启动时：注册标题生成服务，新会话首条消息后自动调用
 * - 停止时：回退到默认标题"对话 N"，不影响主流程
 */
import type { Plugin } from '../cordis/src/index.ts'

class SessionTitleLLM {
  private pendingTitles: Map<string, { message: string; resolve: (title: string) => void }[]> = new Map()

  async generateTitle(sessionId: string, firstMessage: string): Promise<string> {
    // 尝试从 LLM 生成标题
    try {
      const ctx = (globalThis as any).__codemCtx
      if (ctx) {
        const llm = ctx.get('llm')
        if (llm) {
          const response = await llm.complete({
            messages: [
              { role: 'system', content: 'Generate a concise title (max 20 chars) for this conversation. Reply with ONLY the title, no quotes.' },
              { role: 'user', content: firstMessage.substring(0, 500) },
            ],
            model: 'mimo-auto',
            maxTokens: 30,
            temperature: 0.3,
          })
          const title = response.content?.trim().substring(0, 30) || '新对话'
          return title
        }
      }
    } catch (e) { console.warn('[sessionTitleLlm] generation failed', e) }

    // 回退：使用首条消息前 20 字符
    return firstMessage.substring(0, 20).trim() || '新对话'
  }
}

export const sessionTitleLLMProvider: Plugin = (ctx: any) => {
  const service = new SessionTitleLLM()

  const dispose = ctx.provide('sessionTitleLLM', {
    async generateTitle(sessionId: string, firstMessage: string) {
      return service.generateTitle(sessionId, firstMessage)
    },
  })

  return dispose
}
