/**
 * StatsLine 紧凑化判据（design/unslop-v2）
 *
 * ## 守的是什么
 *
 * | # | 行为 |
 * |---|---|
 * | SL-1 | 默认是**折叠**的 `<details>`：summary 只有轮/步/总耗时，原始指标不在 summary 里 |
 * | SL-2 | 展开后原有指标**一项不少**（LLM/工具耗时、TTFT、tok/s、缓存、token、费用） |
 * | SL-3 | `cacheReported !== true` 的消息**不显示缓存命中率**（老消息不许被读成 0%） |
 * | SL-4 | 没有额外指标时**不画空 details**（只有一行摘要） |
 * | SL-5 | 回合墙钟已包含工具耗时 ⇒ 摘要总耗时用墙钟，不重复相加 |
 * | SL-6 | 不新增内联样式（视觉类名留给集成方） |
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { StatsLine } from '../components/StatsLine'
import type { Message } from '../store'

afterEach(cleanup)

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: 'done',
    timestamp: Date.now(),
    status: 'done',
    ...overrides,
  }
}

const FULL_USAGE = {
  promptTokens: 12_000,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 1_000,
  uncachedInputTokens: 4_000,
  completionTokens: 500,
  cost: 0.042,
  cacheReported: true,
}

function fullMessage(): Message {
  return makeMessage({
    metadata: {
      llmDuration: 8_200,
      ttftMs: 500,
      decodeMs: 2_000,
      outputTokens: 100,
      usage: FULL_USAGE,
    },
    toolCalls: [
      {
        id: 't1',
        tool: 'run_command',
        args: { command: 'npx tsc --noEmit' },
        status: 'done',
        metadata: { duration: 4_300 },
      },
    ],
  })
}

describe('StatsLine 紧凑运行详情', () => {
  it('SL-1/SL-2/SL-6：默认折叠；summary 只有轮/步/总耗时；展开后全部指标仍在，且无内联样式', () => {
    const { container } = render(<StatsLine message={fullMessage()} />)

    const details = container.querySelector('details.stats-line--compact') as HTMLDetailsElement
    expect(details, '有原始指标时必须渲染可折叠的 details').toBeTruthy()
    expect(details.open, '默认必须是折叠的').toBe(false)

    const summary = container.querySelector('summary.stats-line-summary')!
    expect(summary.textContent).toContain('1 轮')
    expect(summary.textContent).toContain('1 步')
    expect(summary.textContent, '总耗时 = llm 8.2s + 工具 4.3s').toContain('总耗时 12.5s')
    expect(summary.textContent, '原始指标不许留在 summary').not.toContain('tok/s')
    expect(summary.textContent, '原始指标不许留在 summary').not.toContain('缓存命中')

    fireEvent.click(summary)

    const opened = container.querySelector('details') as HTMLDetailsElement
    expect(opened.open, '点 summary 之后必须展开').toBe(true)
    const body = container.querySelector('.stats-line-body')!.textContent ?? ''
    expect(body, '耗时拆分不能丢').toContain('LLM 8.2s')
    expect(body, '工具耗时不能丢').toContain('工具 4.3s')
    expect(body, 'TTFT 不能丢').toContain('TTFT 0.5s')
    expect(body, '解码吞吐不能丢').toContain('50 tok/s')
    expect(body, '缓存读数不能丢').toContain('缓存命中：61.5%')
    expect(body, 'token 计数不能丢').toContain('13K 入 / 500 出')
    expect(body, '费用不能丢').toContain('≈$0.04')

    expect(container.querySelectorAll('[style]'), '不许新增内联样式').toHaveLength(0)
  })

  it('SL-3：cacheReported 不为 true 时报文不出现缓存命中（老消息不许显示 0%）', () => {
    const message = makeMessage({
      metadata: {
        usage: {
          promptTokens: 1_000,
          completionTokens: 100,
          // 旧聚合会把未上报初始化成 0；这里的 0 不代表"确定没命中"
          cacheHitTokens: 0,
        },
      },
    })
    const { container } = render(<StatsLine message={message} />)
    fireEvent.click(container.querySelector('summary')!)

    const body = container.querySelector('.stats-line-body')!.textContent ?? ''
    expect(body, '未上报就不许出现缓存命中读数').not.toContain('缓存命中')
    expect(body, '未上报不许显示 0%').not.toContain('0%')
    expect(body, 'token 计数仍要照常显示').toContain('1K 入 / 100 出')
  })

  it('SL-4：没有额外指标 ⇒ 只有摘要，不画空折叠壳', () => {
    const { container } = render(<StatsLine message={makeMessage()} />)
    expect(container.querySelector('details'), '没有可折叠内容时不许画 details').toBeNull()
    expect(
      container.querySelector('.stats-line-summary'),
      '静态摘要不许套 summary 类（集成方 CSS 会加展开箭头，等于假装可点）',
    ).toBeNull()
    expect(container.querySelector('.stats-line--compact')!.textContent).toBe('1 轮 · 1 步')
  })

  it('SL-5：回合墙钟与工具耗时重叠时，摘要总耗时取墙钟而不是相加', () => {
    const message = makeMessage({
      metadata: { turnStartTime: 1_000, turnEndTime: 9_000 },
      toolCalls: [
        {
          id: 't1',
          tool: 'run_command',
          args: {},
          status: 'done',
          metadata: { duration: 3_000 },
        },
      ],
    })
    const { container } = render(<StatsLine message={message} />)
    const summary = container.querySelector('summary')!
    expect(summary.textContent, '墙钟 8s 已含工具 3s，不许显示 11s').toContain('总耗时 8s')
    expect(summary.textContent).not.toContain('11s')
  })
})
