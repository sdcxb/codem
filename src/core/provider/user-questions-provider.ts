// @ts-nocheck
/**
 * User Questions Provider 插件 — 用户交互问答服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const userQuestionsProvider: Plugin = (ctx: any) => {
  const pendingQuestions: any[] = []

  const dispose = ctx.provide('userQuestions', {
    ask(question: string, options?: string[]) {
      const id = crypto.randomUUID()
      return new Promise(resolve => { pendingQuestions.push({ id, question, options, resolve }) })
    },
    getPending() { return pendingQuestions.map(({ id, question, options }) => ({ id, question, options })) },
    answer(id: string, answer: string) {
      const idx = pendingQuestions.findIndex(p => p.id === id)
      if (idx >= 0) { pendingQuestions[idx].resolve(answer); pendingQuestions.splice(idx, 1) }
    },
  })

  return dispose
}
