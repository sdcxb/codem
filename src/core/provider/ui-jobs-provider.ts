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
    /**
     * 第 86 波（假成功）：`automation` 服务不存在时，原来 `cancelJob`/`retryJob` 直接
     * `return true` —— 调用方（插件/界面）看到 true 会以为"取消/重试成功了"，
     * 实际什么都没发生，任务还在跑。现在明确抛错，让调用方能分辨。
     */
    const requireAutomation = (op: string) => {
      const auto = ctx.get('automation')
      if (!auto) {
        throw new Error(`uiJobs.${op}: automation 服务不可用（@codem/automation 插件未启用），本次操作没有执行`)
      }
      return auto
    }

    const s = {
      render(jobs) { return { type: 'jobs-badge', jobs } },
      async listJobs() { const auto = ctx.get('automation'); return auto && auto.list ? auto.list() : [] },
      async cancelJob(id) {
        const auto = requireAutomation('cancelJob')
        if (typeof auto.cancel !== 'function') {
          throw new Error(`uiJobs.cancelJob: automation 服务没有 cancel 能力，任务 ${id} 未被取消`)
        }
        return auto.cancel(id)
      },
      async retryJob(id) {
        const auto = requireAutomation('retryJob')
        if (typeof auto.retry !== 'function') {
          throw new Error(`uiJobs.retryJob: automation 服务没有 retry 能力，任务 ${id} 未被重试`)
        }
        return auto.retry(id)
      },
    }

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.jobs-badge', id: 'r8-jobsbadge', priority: 5 }, JobsBadge)

    /**
     * 第 62 轮（清理第 4 包）：删掉 `conversation.session.header.actions` 那条 `-sub` 注册 ——
     * 它的唯一出口在 `components/ConversationSession.tsx`（从未被渲染）；
     * 真正在用的是上面 `app.jobs-badge`（`ChatPanel` 头部挂载）。
     */

    const disp = ctx.provide('uiJobs', s)

    // Composite dispose: clean up both provide and slot registration
    return () => {
      if (disp) disp()
      unreg()
    }
  },
  { inject: ['slots'] }
)
