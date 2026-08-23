// @ts-nocheck
/**
 * @codem/ui-jobs — 会话头部后台任务 UI 插件
 *
 * 对标 DSH packages/client/ui-jobs/src/client/index.ts。
 * 注册 JobsBadge 组件到 Slot（会话头部任务指示器），同时提供任务管理服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { JobsBadge } from '../../components/JobsBadge'

export const uiJobsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const s = {
      render(jobs) { return { type: 'jobs-badge', jobs } },
      async listJobs() { const auto = ctx.get('automation'); return auto && auto.list ? auto.list() : [] },
      async cancelJob(id) { const auto = ctx.get('automation'); return auto && auto.cancel ? auto.cancel(id) : true },
      async retryJob(id) { const auto = ctx.get('automation'); return auto && auto.retry ? auto.retry(id) : true },
    }

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.jobs-badge', id: 'r8-jobsbadge', priority: 5 }, JobsBadge)

    // 使用 slots.inject 声明消费依赖：conversation.session.header.actions 存在时注册
    const injectUnreg = slots.inject('conversation.session.header.actions', () =>
      slots.register({ name: 'conversation.session.header.actions', id: 'r8-jobsbadge-sub', priority: 5 }, JobsBadge)
    )

    const disp = ctx.provide('uiJobs', s)

    // Composite dispose: clean up both provide and slot registration
    return () => {
      if (disp) disp()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
