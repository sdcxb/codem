/**
 * 第 205 轮：思考块对齐 DSH 的单行 ReasoningRow。
 *
 * 关键判据：
 * - 流式摘要按「最近一个已完成段落的首行」推进，不逐字符横向抖；
 * - 默认折叠，body 不挂载；用户点开才挂；
 * - 展开态有 aria-controls / role=region，且正文分块。
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReasoningRow, latestCompletedParagraphFirstLine, splitReasoningChunks } from '../components/ReasoningRow'

describe('ReasoningRow DSH 单行', () => {
  it('流式摘要取最近一个已完成段落的首行', () => {
    const text = '第一段第一行\n第一段第二行\n\n第二段第一行\n第二段正在写'
    expect(latestCompletedParagraphFirstLine(text)).toBe('第二段第一行')
    expect(latestCompletedParagraphFirstLine('第一段第一行\n第一段第二行')).toBe('第一段第一行')
    expect(latestCompletedParagraphFirstLine('还没有换行的半句')).toBe('')
  })

  it('分块按 64 行切，完成块文本稳定', () => {
    const text = Array.from({ length: 130 }, (_, i) => `line-${i}`).join('\n')
    const chunks = splitReasoningChunks(text)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].split('\n')).toHaveLength(64)
    expect(chunks[1].split('\n')).toHaveLength(64)
    expect(chunks[2]).toBe('line-128\nline-129')
  })

  it('默认折叠不挂 body，点击后展开并带 aria 关联', () => {
    const { container, rerender } = render(
      <ReasoningRow text={'第一段第一行\n第一段第二行\n\n第二段第一行\n第二段正在写'} running />,
    )

    const toggle = screen.getByRole('button')
    expect(toggle).toHaveTextContent('第二段第一行')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.reasoning-body')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const body = container.querySelector('.reasoning-body')
    expect(body).not.toBeNull()
    expect(body).toHaveAttribute('role', 'region')
    expect(toggle.getAttribute('aria-controls')).toBe(body?.getAttribute('id'))

    rerender(<ReasoningRow text={'第一段第一行\n第一段第二行\n\n第二段第一行\n第二段正在写'} running={false} />)
  })
})
