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
const hub = readFileSync(join(ROOT, 'src/styles/skin-hub.css'), 'utf8')
const settings = readFileSync(join(ROOT, 'src/components/SettingsPanel.tsx'), 'utf8')
const tooltip = readFileSync(join(ROOT, 'src/components/ui/tooltip.tsx'), 'utf8')
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

  it('P0-5：设置项 31px，active 14% 软底 + accent-strong + 无 inset 条', () => {
    const item = block(codemUi, '.settings-sidebar-item')
    expect(item).toContain('height: 31px')
    expect(item).toContain('flex-shrink: 0')
    expect(item).toContain('font-size: var(--fs-sm)')
    expect(item).toContain('padding: 0 var(--space-4) 0 var(--space-6)')

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

  it('P1-left：侧栏 240/32/30/32/43，项目/会话按文件树层级排，不塞文件树', () => {
    const sidebar = readFileSync(join(ROOT, 'src/components/Sidebar.tsx'), 'utf8')
    expect(block(css, '.sidebar')).toContain('width: 240px')
    expect(block(css, '.sidebar-nav-item')).toContain('height: 32px')
    expect(block(css, '.sidebar-session')).toContain('height: 30px')
    expect(block(css, '.sidebar-project-header')).toContain('height: 32px')
    expect(block(css, '.sidebar-tool-item')).toContain('height: 43px')
    expect(sidebar).toContain('sidebar-session-time')
    expect(sidebar).toContain('MessageSquare')
    expect(sidebar).toContain('sidebar-project-count')
    expect(sidebar).not.toContain('<FileExplorer')
    expect(block(css, '.sidebar-project .sidebar-sessions')).toContain('border-left')
  })

  it('P1-chat：会话头 48 + 轮数/上下文/main，左栏不出现文件树', () => {
    const chat = readFileSync(join(ROOT, 'src/components/ChatPanel.tsx'), 'utf8')
    expect(block(css, '.chat-header')).toContain('height: 48px')
    expect(chat).toContain('chat-meta')
    expect(chat).toContain('turnCount')
    expect(chat).toContain('contextPercent')
    expect(chat).toContain('modeLabel')
    expect(chat).toContain('qa-turn-status-line')
    expect(block(css, '.right-sidebar')).toContain('background: var(--sidebar-bg)')
  })

  it('P2-1：设置 1080 工作台，侧栏 220，头部 52，内容区最高 760', () => {
    expect(block(css, '.settings-panel')).toContain('width: min(1080px, 95vw)')
    expect(block(css, '.settings-header')).toContain('min-height: 52px')
    expect(block(css, '.settings-panel')).toContain('display: flex')
    expect(block(css, '.settings-body')).toContain('flex: 1 1 auto')
    expect(block(css, '.settings-body')).toContain('min-height: 0')
    expect(block(codemUi, '.settings-sidebar')).toContain('width: var(--settings-side-width)')
  })

  it('P2-1b：设置整页视图有返回、8 组导航、26px 子导航、900 内容列', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    expect(settings).toContain('fullPage')
    expect(settings).toContain('settings-page')
    expect(settings).toContain('settings-back')
    expect((settings.match(/settings-nav-group-label/g) ?? []).length).toBe(8)
    expect(settings).toContain('settings-page-head')
    expect(settings).toContain('activeTabDef')
    expect(settings).toContain('settings-subnav')
    expect(codemUi).toContain('.settings-page-overlay')
    expect(codemUi).toContain('padding: var(--chrome-height) 0 0')
    expect(codemUi).toContain('.settings-page .settings-content')
    expect(codemUi).toContain('max-width: 900px')
    expect(block(codemUi, '.settings-subnav-pill')).toContain('height: 26px')
    // 真 hash 路由：刷新/后退可恢复设置页，而不是只换一个 class
    expect(app).toContain('window.location.hash === "#settings"')
    expect(app).toContain('window.history.pushState')
  })

  it('P3：动效 120/180/250，Hub active 14%', () => {
    expect(css).toContain('--duration-fast: 120ms')
    expect(css).toContain('--duration-normal: 180ms')
    expect(css).toContain('--duration-slow: 250ms')
    expect(hub).toContain('--hub-color-primary-muted: rgba(255, 107, 0, 0.14)')
  })

  it('P2-4：任务中心/用量/知识页头收到 44px', () => {
    const task = readFileSync(join(ROOT, 'src/components/TaskCenter.tsx'), 'utf8')
    expect(task).toContain('className="task-center-header"')
    expect(block(css, '.task-center-header')).toContain('min-height: 44px')
    expect(block(css, '.usage-stats-header')).toContain('min-height: 44px')
    expect(block(css, '.notebook-manager-header')).toContain('min-height: 44px')
  })

  it('P0-window：启动最大化，避免固定 1200×800 在小屏/高缩放下超出屏幕', () => {
    const conf = readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')
    expect(conf).toContain('"maximized": true')
    expect(conf).toContain('"minWidth": 800')
  })

  it('P2-2：右栏 1280 默认展开，1440 宽 360，≤1100 自动收起', () => {
    const right = readFileSync(join(ROOT, 'src/components/RightSidebar.tsx'), 'utf8')
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    expect(right).toContain('window.innerWidth <= 1440 ? 360 : 400')
    expect(app).toContain('window.innerWidth >= 1280')
    expect(app).toContain('window.innerWidth <= 1100')
    expect(app).toContain('codem-right-rail-open')
    expect(app).toContain('setSetting(RIGHT_RAIL_SETTING')
    expect(app).not.toContain('else if (window.innerWidth >= 1280) setRightRailOpen(true)')
  })

  it('P1-7：设置内容平铺无卡片，菜单/模态统一无阴影，Tooltip 500ms/11px', () => {
    const settingsContent = block(codemUi, '.settings-content')
    expect(settingsContent).toContain('background: transparent !important')
    expect(settingsContent).toContain('border: 0')
    expect(settingsContent).not.toContain('border-radius: var(--radius-lg)')
    expect(block(css, '.settings-content')).toContain('padding: var(--space-6)')
    expect(block(css, '.settings-content')).toContain('gap: var(--space-3)')
    expect(block(codemUi, '.settings-content > .setting-group')).toContain('padding: var(--space-3) 0')
    expect(codemUi).toContain('.settings-content > .setting-group + .setting-group')

    expect(css).toContain('min-width: 240px')
    expect(block(css, '.app-menu-item')).toContain('min-height: 28px')
    expect(block(css, '.modal-panel')).toContain('box-shadow: none')
    expect(block(css, '.tooltip-content')).toContain('font-size: var(--fs-xs)')
    expect(tooltip).toContain('delayDuration = 500')
  })

  it('P1-8：空态与错误继续走共享 Empty/StatusBanner，不另起一套', () => {
    expect(css).toContain('.empty-hint')
    expect(css).toContain('.status-banner')
    expect(css).toContain('.status-banner-retry')
  })

  it('P1-5：用户气泡保留原版半透明紫，不改成 OMP 实底', () => {
    expect(css).toContain('--message-bubble-user: rgba(107, 92, 231, 0.08)')
    expect(css).toContain('--message-bubble-user-border: rgba(107, 92, 231, 0.16)')
    expect(css).toContain('--message-bubble-user: rgba(124, 108, 240, 0.15)')
    expect(css).toContain('--message-bubble-user-border: rgba(124, 108, 240, 0.25)')
  })

  it('P1-4（方案 A）：工具卡去四边框，只留左侧状态轨', () => {
    const toolCard = block(codemUi, '.tool-card')
    expect(toolCard).toContain('border: 0')
    expect(toolCard).toContain('border-left: 2px solid var(--border-primary)')
    expect(toolCard).toContain('border-radius: 0')
    expect(toolCard).toContain('background: transparent')
    expect(codemUi).toContain('.tool-call-card-wrap[data-state="running"] .tool-card')
    expect(codemUi).toContain('.tool-call-card-wrap[data-state="error"] .tool-card')
    expect(codemUi).toContain('.tool-call-card-wrap[data-state="ok"] .tool-card')
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
