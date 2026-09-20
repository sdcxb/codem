// @ts-nocheck
/**
 * @codem/command-compact — 压缩命令插件 (P1-7.9)
 *
 * 提供 /compact 命令，用户可手动触发上下文压缩。
 *
 * 功能链路融入（文档 6.2 链路 C: 上下文压缩链）：
 * - 启动时：注册 /compact 命令，用户可在输入框中输入 /compact 触发
 * - 停止时：/compact 命令不可用，用户需通过自动压缩
 *
 * ## ⚠️ 第 84 波（功能上下文审计 C1）：上面这三行**不是事实**，`/compact` 今天没接线
 *
 * 原文案承诺"注册后用户可在输入框输入 `/compact` 触发"，实际相反：
 * - **零生产调用者**：全仓 grep `isCompactCommand` / `registerHandler` / `commandCompact`
 *   的命中只有"本文件定义"、"`builtin-registry.ts` / `provider/index.ts` 的注册"、
 *   "`plugin-registry-provider.ts` 的展示条目"—— **没有任何代码调它们**。
 * - **App 侧没有这个分支**：`src/App.tsx` 的命令分发里只有 `/feedback`
 *   （以及更早的那些内置命令），没有 `/compact` 分支；命令菜单
 *   （`components/SlashCommandMenu.tsx`）只列**技能**，所以 `/compact` 连菜单里都不出现。
 *   用户真的敲 `/compact`，它会被当作**普通消息发给模型**。
 * - 渲染侧**确实有**手动压缩能力，但挂在上下文面板的**按钮**上
 *   （`components/ContextMonitor.tsx` 的手动压缩 + `compaction-state` 闸门），与本插件无关。
 *
 * 本轮处置（**不新增功能**）：只把**面向用户的文案**改到与实现一致
 * （`plugin-registry-provider.ts` 里这条插件的 description / riskDescription），
 * 并在这里登记"未接线"。要不要真的把 `/compact` 接到 App 分发上 = **产品决策**，
 * 登记在 `docs/AUDIT-ZERO-GAP.md` 第 3.1 节（B 段末行 / E 段之后的说明）。
 */
import type { Plugin } from '../cordis/src/index.ts'

class CompactCommand {
  private handlers: Set<(sessionId: string) => Promise<void>> = new Set()

  registerHandler(handler: (sessionId: string) => Promise<void>) {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  async execute(sessionId: string): Promise<void> {
    for (const handler of this.handlers) {
      try { await handler(sessionId) } catch (e) {
        console.error('[CompactCommand] Handler failed:', e)
      }
    }
  }

  isCompactCommand(input: string): boolean {
    return input.trim().toLowerCase() === '/compact'
  }
}

export const commandCompactProvider: Plugin = (ctx: any) => {
  const cmd = new CompactCommand()

  const dispose = ctx.provide('commandCompact', {
    registerHandler(handler: any) { return cmd.registerHandler(handler) },
    async execute(sessionId: string) { return cmd.execute(sessionId) },
    isCompactCommand(input: string) { return cmd.isCompactCommand(input) },
  })

  return dispose
}
