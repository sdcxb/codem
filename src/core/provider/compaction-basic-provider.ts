// @ts-nocheck
/**
 * @codem/compaction-basic — 压缩策略**占位**插件
 *
 * ## ⚠️ 这个插件不做任何压缩决策
 *
 * 它的存在只有一个作用：让 `ctx.get('compactionBasic')` 拿得到东西。
 * `agentic-loop.ts` 里唯一的消费点是**存在性检查**：
 *
 * ```ts
 * if (!this._ctx.get('compaction') && !this._ctx.get('compactionBasic')) { …告警… }
 * ```
 *
 * **真正的压缩阈值不在本文件里**，在 `agentic-loop.ts`：
 * - 阈值：`contextPressure > compactionThreshold`，默认 `0.8`（比值，不是 token 数），
 *   压力由 `token-tracker.ts::estimatePressure()` 返回 `Math.min(1, tokens / contextWindow)`
 * - 熔断：`consecutiveCompactions >= 3` → 可见地结束并提示开新对话
 * - 保留策略：`doCompactMessages()` —— 最近 ≤20 条 + 按体积收缩 + 轮次边界对齐
 * - 反应式压缩：provider 报超窗时走语义匹配（`provider-errors.ts`）后重试当前 step
 *
 * ## 为什么把原来的 `threshold = 80000` 删掉
 *
 * 本文件原来有 `private threshold = 80000 // 80K tokens`，文件头注释还写着
 * 「上下文超过阈值时自动触发」。**两句话都是假的**：没有任何调用方会读这个字段，
 * 阈值实际是 0.8 比值。
 *
 * 代价是真实的：做 zcode/DSH 对标时，我（AI）读到这个常量就得出「我方压缩阈值
 * 写死 80K、比两边都激进一倍」的结论，并写进了对标报告 —— 直到去核对
 * `shouldCompact` 的调用方才发现它一次都没被调用过。
 *
 * 一个**永远不生效**的数值比没有这个数值更糟：它会被后来者当成事实。
 * 所以这里删掉字段本身，而不是加一句「已废弃」的注释。
 *
 * 保留类（`CompactionBasic`）也一并删除：它同样没有任何外部消费者。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const compactionBasicProvider: Plugin = (ctx: any) => {
  // 只提供「服务存在」这一事实。压缩决策全在 agentic-loop.ts，见文件头。
  return ctx.provide('compactionBasic', {
    /** 保留此方法仅为兼容既有的存在性探测；不承担任何策略语义。 */
    isPlaceholder: true,
  })
}
