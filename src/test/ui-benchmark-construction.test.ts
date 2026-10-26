/**
 * 第 205 轮 UI 对标施工合同（P0-1/2/3 + P1-6）。
 *
 * 这些不是“样式快照”，只钉住这次真的会改变观感的几件事：
 * - 正文列 820（gutter 48）+ Composer 820；
 * - 输入卡是 surface + 14px 圆角 + 无阴影，不是透明重阴影；
 * - 暗色画布/文字/边框走新档；
 * - 思考块默认 24px 折叠、body 按块渲染、位置在正文之前。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8')
const codemUi = readFileSync(join(ROOT, 'src/styles/codem-ui.css'), 'utf8')
const dream = readFileSync(join(ROOT, 'src/styles/skin-dream.css'), 'utf8')
const settings = readFileSync(join(ROOT, 'src/components/SettingsPanel.tsx'), 'utf8')
const reasoning = readFileSync(join(ROOT, 'src/components/ReasoningRow.tsx'), 'utf8')
const bubble = readFileSync(join(ROOT, 'src/components/MessageBubble.tsx'), 'utf8')

function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[2] ?? ''
}

describe('UI 对标施工合同', () => {
  it('正文列 820 + 48 gutter，Composer 同步 820', () => {
    expect(css).toContain('--reading-column: 820px')
    expect(css).toContain('--reading-gutter: 48px')
    expect(block(css, '.messages-container')).toContain('max-width: calc(var(--reading-column) + var(--reading-gutter) * 2)')
    const inputCard = block(css, '.input-area.input-card-container')
    expect(inputCard).toContain('width: min(100%, var(--reading-column))')
    expect(inputCard).toContain('max-width: var(--reading-column)')
  })

  it('输入卡是 surface + 14px 圆角 + 无阴影，且不再有 textarea 顶边', () => {
    const inputCard = block(css, '.input-area.input-card-container')
    expect(inputCard).toContain('background: var(--bg-secondary)')
    expect(inputCard).toContain('border: 1px solid var(--border-primary)')
    expect(inputCard).toContain('border-radius: var(--radius-lg)')
    expect(inputCard).toContain('box-shadow: none')
    expect(block(css, '.input-textarea-row')).toContain('border-top: none')
  })

  it('暗色画布/文字/边框切到新档，accent 保持不变', () => {
    expect(css).toContain('--bg-primary: #0f1217')
    expect(css).toContain('--text-base: #e6e7ea')
    expect(css).toContain('--border-primary: rgba(255, 255, 255, 0.12)')
    expect(css).toContain('--accent: #7c6cf0')
  })

  it('P0-5：设置项 30px，active 14% 软底 + accent-strong + 无 inset 条', () => {
    const item = block(codemUi, '.settings-sidebar-item')
    expect(item).toContain('height: 30px')
    expect(item).toContain('flex-shrink: 0')
    expect(item).toContain('font-size: var(--fs-sm)')
    expect(item).toContain('padding: 0 var(--space-3)')

    const active = block(codemUi, '.settings-sidebar-item.active')
    expect(active).toContain('background: var(--accent-selected)')
    expect(css).toContain('--accent-selected: color-mix(in srgb, var(--accent) 14%, transparent)')
    expect(active).toContain('color: var(--accent-strong)')
    expect(active).toContain('box-shadow: none')
    // 旧的实心规则和 aria-current inset 条都必须删掉；不能靠后加载压住
    expect(block(css, '.settings-sidebar-item.active')).toBe('')
    expect(css).not.toContain('.settings-sidebar-item[aria-current="page"]')
  })

  it('P0-6：Markdown 标题 16/15/14/13，不抢正文', () => {
    expect(block(css, '.message-content h1')).toContain('font-size: var(--fs-lg)')
    expect(block(css, '.message-content h2')).toContain('font-size: calc(var(--fs-lg) - 1px)')
    expect(block(css, '.message-content h3')).toContain('font-size: var(--fs-md)')
    expect(css).toMatch(/\.message-content h4,\s*\.message-content h5,\s*\.message-content h6\s*\{\s*font-size:\s*var\(--fs-base\)/)
  })

  it('P0-7：Dream 六个语义 token 齐备，设置搜索索引含记忆体检', () => {
    for (const token of [
      '--success:',
      '--warning:',
      '--error:',
      '--info:',
      '--dropdown-bg:',
      '--text-on-accent:',
    ]) {
      expect(dream).toContain(token)
    }
    expect(settings).toContain('["memory-checkup"')
    expect(settings).toContain('"记忆体检"')
  })

  it('P1-3（安全子集）：文件树 26px，Git 状态只留单字母不画药丸', () => {
    expect(block(css, '.file-entry')).toContain('height: 26px')
    expect(block(css, '.git-status-badge')).toContain('background: transparent')
    expect(css).toContain('.file-entry .git-status-badge')
    // 导航/会话行高与内边距继续由 RHYTHM-1/2 守，不在这一轮硬改
  })

  it('思考块默认 24px 折叠、正文分块、位置在正文之前', () => {
    expect(reasoning).toContain('latestCompletedParagraphFirstLine')
    expect(reasoning).toContain('splitReasoningChunks')
    expect(reasoning).toContain('data-expanded')
    expect(reasoning).toContain('useState(false)')
    expect(css).toContain('.reasoning-row:not([data-expanded])')
    expect(block(css, '.reasoning-row:not([data-expanded])')).toContain('height: 24px')
    expect(block(css, '.reasoning-row:not([data-expanded])')).toContain('contain: size layout')
    expect(block(css, '.reasoning-body')).toContain('max-height: 360px')
    expect(css).toContain('.reasoning-chunk')
    expect(css).toContain('content-visibility: auto')

    const reasoningAt = bubble.indexOf('message.reasoning && showReasoning')
    const contentAt = bubble.indexOf('className={`message-content-wrapper')
    expect(reasoningAt).toBeGreaterThan(0)
    expect(contentAt).toBeGreaterThan(0)
    expect(reasoningAt).toBeLessThan(contentAt)
  })
})
