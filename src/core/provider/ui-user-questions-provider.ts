// @ts-nocheck
/**
 * @codem/uiUserQuestions — UI Provider
 *
 * app.user-questions slot 现在在 App.tsx 中通过 SlotBridge 消费（fallback 为 null）。
 * 使用 inject 声明依赖 slots 服务。
 */
import { lazy } from 'react'
import type { Plugin } from '../cordis/src/index.ts'

const InteractiveFormDialog = lazy(() => import('../../components/InteractiveFormDialog'))

export const uiUserQuestionsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(question) { return {type:'user-question',question} },
      async ask(question, options) { const uq=ctx.get('userQuestions'); if(uq&&uq.ask)return uq.ask(question, options); return {answer:'simulated',question} },
      async batchAsk(questions) { return questions.map(q=>({question:q,answer:'simulated'})) },
    }

    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.user-questions', id: 'r8-interactiveformdialog', priority: 5 }, InteractiveFormDialog)

    const disp = ctx.provide('uiUserQuestions', s)

    return () => {
      if (disp) disp()
      if (unreg) unreg()
    }
  },
  { inject: ['slots'] }
)
