// @ts-nocheck
/**
 * @codem/uiUserQuestions — UI Provider
 *
 * app.user-questions slot 现在在 App.tsx 中通过 SlotBridge 消费（fallback 为 null）。
 * 使用 inject 声明依赖 slots 服务。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiUserQuestionsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(question) { return {type:'user-question',question} },
      async ask(question, options) { const uq=ctx.get('userQuestions'); if(uq&&uq.ask)return uq.ask(question, options); return {answer:'simulated',question} },
      async batchAsk(questions) { return questions.map(q=>({question:q,answer:'simulated'})) },
    }

    // 不在此注册 InteractiveFormDialog 到 app.user-questions slot。
    // InteractiveFormDialog 需要 questions/onSubmit/onCancel props，
    // 而 App.tsx 中的 SlotBridge 以无 props 方式消费该 slot，会导致崩溃。
    // InteractiveFormDialog 应通过 App.tsx 中的条件渲染路径使用。

    const disp = ctx.provide('uiUserQuestions', s)

    return () => {
      if (disp) disp()
    }
  },
  { inject: ['slots'] }
)
