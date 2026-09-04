/**
 * PluginMarketTab — 【插件管理】弹窗里的"插件市场"页签。
 *
 * 加载 dsh 插件市场（dsh-desktop / deepseek-harness 生态），对标其"包 +
 * 分层装配 + Loader 激活"机制在 Codem 的落地形态：
 *   - 浏览：内置官方目录（真实 @deepseek-ai/dsh-* 包）+ 可选 npm 在线检索
 *   - 评估：bundled（Codem 内置等价，安装=启用对应内置插件）/ adaptable
 *     （dsh 协议插件，可经 dsh-compat 适配）/ unsupported（npm 依赖无法加载）
 *   - 安装/卸载：bundled 条目直接启用/禁用对应内置插件；其余诚实标注
 */
import { useCallback, useMemo, useState } from 'react'
import { PanelIcons, ActionIcons, StatusIcons, CommonIcons } from '../../core/icons/icon-map'
import { Badge } from '../ui/badge'
import type { PluginManagerService } from '../../core/plugin-loader/plugin-manager-service'
import {
  DSH_MARKET_CATALOG,
  searchDshNpmPackages,
  type DshMarketEntry,
  type DshMarketStatus,
  type NpmPluginHit,
} from '../../core/plugin-market/dsh-market-catalog'

interface Props {
  manager: PluginManagerService | null
  zh: boolean
  /** 切换插件（父组件统一处理级联确认与提示） */
  onToggle: (name: string) => void
  notify: (msg: string, type: 'success' | 'error' | 'warning') => void
}

const CATEGORY_LABEL: Record<string, { zh: string; en: string }> = {
  all: { zh: '全部', en: 'All' },
  capability: { zh: '能力', en: 'Capability' },
  tool: { zh: '工具', en: 'Tool' },
  ui: { zh: '界面', en: 'UI' },
  infra: { zh: '基础设施', en: 'Infra' },
}

function statusBadge(status: DshMarketStatus, zh: boolean): { text: string; color: string; bg: string } {
  switch (status) {
    case 'bundled':
      return { text: zh ? '内置等价' : 'Bundled', color: 'var(--success)', bg: 'var(--bg-hover)' }
    case 'adaptable':
      return { text: zh ? '可适配' : 'Adaptable', color: 'var(--warning)', bg: 'var(--bg-hover)' }
    default:
      return { text: zh ? '暂不兼容' : 'N/A', color: 'var(--text-muted)', bg: 'var(--bg-hover)' }
  }
}

export function PluginMarketTab({ manager, zh, onToggle, notify }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [online, setOnline] = useState<NpmPluginHit[] | null>(null)
  const [searching, setSearching] = useState(false)

  const filtered = useMemo(() => {
    let list = DSH_MARKET_CATALOG
    if (query) {
      const q = query.toLowerCase()
      list = list.filter(e =>
        e.dshName.toLowerCase().includes(q) ||
        e.dshDesc.toLowerCase().includes(q) ||
        (e.codemAnchor ?? '').toLowerCase().includes(q))
    }
    if (category !== 'all') list = list.filter(e => e.category === category)
    return list
  }, [query, category])

  // 分类动态派生：只显示目录中实际存在的分类（harness 无 UI 类核心插件时"界面"空分类不出现）
  const categories = useMemo(
    () => ['all', ...Array.from(new Set(DSH_MARKET_CATALOG.map(e => e.category)))],
    [],
  )

  const pluginStates = useMemo(() => {
    if (!manager) return null
    return new Map(manager.getPluginStates().map(p => [p.name, p]))
  }, [manager])

  const pluginState = useCallback((name?: string) => {
    if (!name || !pluginStates) return null
    return pluginStates.get(name)
  }, [pluginStates])

  const handleInstallBundled = useCallback(async (entry: DshMarketEntry) => {
    if (!entry.codemAnchor || !manager) return
    const state = pluginStates?.get(entry.codemAnchor)
    if (state?.status === 'enabled') {
      // 已启用 → 在已安装列表中禁用（卸载语义），走统一级联
      onToggle(entry.codemAnchor)
      return
    }
    if (state?.status === 'loading') return // 按钮已禁用，防御性兜底
    const result = await manager.enable(entry.codemAnchor)
    if (result.success) {
      notify(
        result.enabledList.length > 1
          ? `已安装并启用 ${entry.dshName}（等价内置 ${entry.codemAnchor}，含 ${result.enabledList.length - 1} 个依赖）`
          : `已安装并启用 ${entry.dshName}（等价内置 ${entry.codemAnchor}）`,
        'success',
      )
    } else {
      notify(result.error || '启用失败', 'error')
    }
  }, [manager, pluginStates, onToggle, notify])

  const handleOnlineSearch = useCallback(async () => {
    setSearching(true)
    // 跟随搜索框输入（空时用 dsh 生态宽搜默认值）
    const q = query.trim()
    const hits = await searchDshNpmPackages(q || 'dsh cordis plugin')
    setOnline(hits)
    setSearching(false)
    if (hits.length === 0) notify(zh ? '未检索到结果或网络不可用' : 'No results or network unavailable', 'warning')
  }, [query, zh, notify])

  return (
    // flex:1 + minHeight:0：接入 .skill-manager（modal-editor 80vh）的高度链，
    // 让目录网格 flex 滚动而非固定 maxHeight 撑破弹窗裁掉底部在线结果区
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {/* 工具栏：搜索 + 在线检索 */}
      <div className="skill-manager-toolbar">
        <div className="skill-search-box" style={{ flex: 1 }}>
          <ActionIcons.search size={14} className="skill-search-icon" />
          <input
            type="text"
            className="skill-search-input"
            placeholder={zh ? '搜索 dsh 插件市场...' : 'Search dsh plugin market...'}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <button
          className="save-btn"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-sm)', flexShrink: 0 }}
          onClick={handleOnlineSearch}
          disabled={searching}
        >
          <CommonIcons.package size={14} />
          {searching ? (zh ? '检索中...' : 'Searching...') : (zh ? '在线检索 npm' : 'Search npm')}
        </button>
      </div>

      {/* 分类（动态：目录实际存在的分类 + 全部） */}
      <div className="skill-manager-filters">
        {categories.map(cat => {
          const count = cat === 'all'
            ? DSH_MARKET_CATALOG.length
            : DSH_MARKET_CATALOG.filter(e => e.category === cat).length
          return (
            <button
              key={cat}
              className={`skill-filter-btn ${category === cat ? 'active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              <span>{CATEGORY_LABEL[cat][zh ? 'zh' : 'en']}</span>
              <span className="skill-filter-count">{count}</span>
            </button>
          )
        })}
      </div>      {/* 兼容性说明 */}
      <div style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)', flexShrink: 0, lineHeight: 1.5 }}>
        💡 {zh
          ? 'dsh 插件是 npm 包（依赖 Node 模块运行时）。Codem 桌面内无法直接加载任意 npm 包：<内置等价> 表示该能力已内置（安装=启用对应插件）；<可适配> 表示按 dsh 协议、无第三方依赖的插件可经 dsh-compat 桥接；其余标注暂不兼容。'
          : 'dsh plugins are npm packages (Node runtime). Codem cannot load arbitrary npm packages: "Bundled" means Codem already ships an equivalent (install = enable it); "Adaptable" means a dependency-free dsh-protocol plugin can run via the dsh-compat bridge; others are marked unsupported.'}
      </div>

      {/* 目录网格（flex 填满剩余高度滚动，适配小弹窗/窗口） */}
      <div className="skill-market-grid" style={{ overflowY: 'auto', flex: 1, minHeight: 80, maxHeight: 'calc(100vh - 300px)' }}>
        {filtered.map(entry => {
          const st = statusBadge(entry.status, zh)
          const state = pluginState(entry.codemAnchor)
          const isEnabled = state?.status === 'enabled'
          const isLoading = state?.status === 'loading'
          // 核心/被依赖插件恒启用且不可安全卸载——只允许"安装"，不提供"禁用"卸载入口
          const canDisable = !!state?.canSafelyDisable
          // manager 未就绪（Cordis 初始化中）时不提供安装动作
          const installable = entry.status === 'bundled' && !!entry.codemAnchor && !!manager
          return (
            <div key={entry.dshName} className="market-skill-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="market-skill-card-header">
                <span className="market-skill-icon" style={{ background: 'var(--bg-tertiary)' }}>
                  <CommonIcons.package size={16} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="market-skill-name" style={{ fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.dshName}
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
                    <Badge variant="muted">{CATEGORY_LABEL[entry.category][zh ? 'zh' : 'en']}</Badge>
                    <Badge variant={entry.status === 'bundled' ? 'success' : entry.status === 'adaptable' ? 'warning' : 'muted'}>
                      {st.text}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="market-skill-desc" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', lineHeight: 1.5, flex: 1 }}>
                {entry.dshDesc}
              </div>
              {entry.status === 'bundled' && entry.codemAnchor && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  → {entry.codemAnchor} {isEnabled ? `(${zh ? '已启用' : 'enabled'})` : `(${zh ? '未启用' : 'disabled'})`}
                </div>
              )}
              <div className="market-skill-card-footer">
                <div className="market-skill-meta" style={{ flex: 1 }} title={entry.note}>
                  {entry.note.length > 120 ? `${entry.note.slice(0, 120)}…` : entry.note}
                </div>
                {installable ? (
                  isLoading ? (
                    <button
                      className="save-btn"
                      disabled
                      style={{ flexShrink: 0, background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border-primary)', padding: '4px 12px', borderRadius: 6, fontSize: 'var(--fs-xs)', cursor: 'not-allowed' }}
                    >
                      {zh ? '启用中…' : 'Enabling…'}
                    </button>
                  ) : isEnabled && !canDisable ? (
                    <button
                      className="save-btn"
                      disabled
                      style={{ flexShrink: 0, background: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: '1px solid var(--border-primary)', padding: '4px 12px', borderRadius: 6, fontSize: 'var(--fs-xs)', cursor: 'not-allowed' }}
                      title={zh ? '核心内置插件，不可卸载' : 'Core built-in plugin, cannot be disabled'}
                    >
                      {zh ? '已启用（核心）' : 'Enabled (core)'}
                    </button>
                  ) : (
                    <button
                      className="save-btn"
                      style={{ flexShrink: 0, background: isEnabled ? 'var(--bg-tertiary)' : 'var(--accent)', color: isEnabled ? 'var(--text-primary)' : 'var(--text-on-accent)', border: '1px solid var(--border-primary)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-xs)' }}
                      onClick={() => handleInstallBundled(entry)}
                    >
                      {isEnabled ? (zh ? '禁用' : 'Disable') : (zh ? '安装并启用' : 'Install')}
                    </button>
                  )
                ) : (
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
                    {entry.status === 'bundled' ? (zh ? '初始化中…' : 'Loading…')
                      : entry.status === 'adaptable' ? (zh ? '待适配' : 'Adapt')
                      : (zh ? '不可安装' : 'Unavailable')}
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="skill-empty">{zh ? '没有匹配的 dsh 插件' : 'No matching dsh plugins'}</div>
        )}
      </div>

      {/* 在线检索结果（真实生态包：一律标注需移植） */}
      {online !== null && online.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-primary)', maxHeight: 180, overflowY: 'auto', flexShrink: 0 }}>
          <div style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
            {zh ? `npm 检索到 ${online.length} 个 dsh 生态包（仅元数据，均需移植/适配后运行）：` : `${online.length} npm packages found (metadata only — porting required):`}
          </div>
          {online.map(p => (
            <div key={p.name} style={{ padding: '4px 12px', display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-xs)', borderTop: '1px solid var(--border-primary)' }}>
              <CommonIcons.info size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>{p.name}</span>
              <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.description || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default PluginMarketTab
