// @ts-nocheck
/**
 * PluginManager — 插件市场 UI 组件。
 *
 * 功能：
 * 1. 展示所有插件列表（卡片式布局，对齐 SkillManager 样式）
 * 2. 每个插件显示：图标、名称、描述、类型标签、依赖信息、开关按钮
 * 3. 核心插件（core: true）标记为"核心"并禁用开关按钮
 * 4. 关闭有依赖的插件时，弹出级联确认对话框
 * 5. 启用插件时，自动启用缺失依赖
 * 6. 搜索和分类过滤
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Lock } from 'lucide-react'
import { PanelIcons, ActionIcons, StatusIcons, CommonIcons, McpIcons } from '../core/icons/icon-map'
import { useLang } from '../core/i18n/lang'
import { Switch } from './ui/switch'
import { Badge } from './ui/badge'
import {
  type PluginMeta,
  type PluginTag,
  RISK_LEVEL_CONFIG,
  PluginDependencyGraph,
} from '../core/plugin-loader/dependency-graph'
import {
  type PluginStatus,
  type DisableConfirmationRequest,
  PluginManagerService,
  getPluginManager,
  initPluginManager,
} from '../core/plugin-loader/plugin-manager-service'
import { tryGetCtx } from '../core/consumer'
import { runtimePluginList } from '../core/provider/plugin-registry-provider'
import { PluginMarketTab } from './plugin-market/PluginMarketTab'

interface PluginManagerProps {
  onClose: () => void
}

/** 类型标签的显示配置 */
const TAG_CONFIG: Record<PluginTag, { label: string; variant: 'default' | 'success' | 'warning' | 'info' | 'muted' }> = {
  service:   { label: '服务定义', variant: 'info' },
  provider:  { label: '服务实现', variant: 'success' },
  ui:        { label: '界面组件', variant: 'default' },
  tool:      { label: '工具', variant: 'warning' },
  bridge:    { label: '桥接适配', variant: 'muted' },
  infra:     { label: '基础设施', variant: 'info' },
  agent:     { label: 'Agent 能力', variant: 'success' },
  storage:   { label: '存储', variant: 'warning' },
  runtime:   { label: '运行时', variant: 'warning' },
  security:  { label: '安全权限', variant: 'muted' },
}

/** 分类配置（支持 i18n） */
function getCategoryConfig(zh: boolean) {
  return [
    { key: 'all',      label: zh ? '全部' : 'All',         icon: <CommonIcons.info size={14} /> },
    { key: 'core',     label: zh ? '核心' : 'Core',         icon: <PanelIcons.plugins size={14} /> },
    { key: 'provider', label: zh ? 'Provider' : 'Provider', icon: <McpIcons.connect size={14} /> },
    { key: 'ui',       label: zh ? '界面' : 'UI',           icon: <PanelIcons.agent size={14} /> },
    { key: 'compat',   label: zh ? '兼容' : 'Compat',       icon: <ActionIcons.link size={14} /> },
    { key: 'tool',     label: zh ? '工具' : 'Tool',         icon: <PanelIcons.tools size={14} /> },
  ]
}

/** 插件状态图标 */
function StatusIcon({ status }: { status: PluginStatus }) {
  switch (status) {
    case 'enabled':  return <StatusIcons.success size={14} style={{ color: 'var(--success)' }} />
    case 'disabled': return <ActionIcons.toggle size={14} style={{ color: 'var(--text-muted)' }} />
    case 'loading':  return <StatusIcons.loading size={14} className="spin" style={{ color: 'var(--accent)' }} />
    case 'error':    return <StatusIcons.danger size={14} style={{ color: 'var(--error)' }} />
  }
}

/** 插件卡片 */
function PluginCard({
  plugin,
  onToggle,
  onRestart,
  isSelected,
  onSelect,
}: {
  plugin: any
  onToggle: (name: string) => void
  onRestart: (name: string) => void
  isSelected: boolean
  onSelect: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isEnabled = plugin.status === 'enabled'
  const isCore = plugin.core || plugin.locked
  const tags: PluginTag[] = plugin.tags || []

  return (
    <div
      className={`market-skill-card ${isSelected ? 'selected' : ''} ${!isEnabled ? 'installed' : ''}`}
      onClick={onSelect}
    >
      {/* 头部：图标 + 名称 + 版本 + 状态 */}
      <div className="market-skill-card-header">
        <span className="market-skill-icon">{plugin.icon || <CommonIcons.package size={16} />}</span>
        <div className="market-skill-card-title">
          <span className="market-skill-name">{plugin.name}</span>
          {plugin.version && <Badge variant="muted">v{plugin.version}</Badge>}
          {isCore && (
            <Badge variant="info">
              <Lock size={10} className="icon-inline plugin-mgr-risk-icon" />
              核心
            </Badge>
          )}
        </div>
        <StatusIcon status={plugin.status} />
      </div>

      {/* 描述 */}
      <div className="market-skill-desc">{plugin.description}</div>

      {/* 类型标签 */}
      {tags.length > 0 && (
        <div className="plugin-mgr-tag-row">
          {tags.map(tag => {
            const cfg = TAG_CONFIG[tag] || { label: tag, variant: 'default' as const }
            return <Badge key={tag} variant={cfg.variant}>{cfg.label}</Badge>
          })}
          {/* 风险等级标识 */}
          {(() => {
            const risk = RISK_LEVEL_CONFIG[plugin.riskLevel || 'safe']
            if (plugin.riskLevel === 'safe') return null
            return (
              <Badge variant={plugin.riskLevel === 'danger' ? 'warning' : 'muted'}>
                <span className="plugin-mgr-risk-icon">{risk.icon}</span>
                {risk.label}
              </Badge>
            )
          })()}
        </div>
      )}

      {/* 依赖信息摘要 */}
      {(plugin.dependencies?.length > 0 || plugin.dependents?.length > 0) && (
        <div
          className="plugin-mgr-deps"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
        >
          {expanded ? <ActionIcons.expand size={12} /> : <ActionIcons.collapse size={12} />}
          {plugin.dependencies.length > 0 && (
            <span className="plugin-mgr-dep-accent">
              依赖 {plugin.dependencies.length} 个
            </span>
          )}
          {plugin.dependents.length > 0 && (
            <span className="plugin-mgr-dep-warn">
              被 {plugin.dependents.length} 个依赖
            </span>
          )}
          {!plugin.canSafelyDisable && !isCore && (
            <span className="plugin-mgr-dep-warn">
              <StatusIcons.danger size={12} className="icon-inline" />
              关闭将影响其他插件
            </span>
          )}
        </div>
      )}

      {/* 展开的详细信息 */}
      {expanded && (
        <div className="plugin-mgr-detail">
          {/* 风险说明 */}
          {plugin.riskLevel && plugin.riskLevel !== 'safe' && (
            <div className={`plugin-mgr-box ${plugin.riskLevel === 'danger' ? 'is-danger' : 'is-warn'}`}>
              <div className="plugin-mgr-box-title" style={{ color: RISK_LEVEL_CONFIG[plugin.riskLevel].color }}>
                {RISK_LEVEL_CONFIG[plugin.riskLevel].icon} {RISK_LEVEL_CONFIG[plugin.riskLevel].label}
              </div>
              <div className="plugin-mgr-box-text">{plugin.riskDescription}</div>
            </div>
          )}
          {plugin.dependencies?.length > 0 && (
            <div className="plugin-mgr-section">
              <div className="plugin-mgr-section-title">依赖的插件：</div>
              <div className="plugin-mgr-list">
                {plugin.dependencies.map((dep: string) => (
                  <div key={dep} className="plugin-mgr-list-item is-accent">→ {dep}</div>
                ))}
              </div>
            </div>
          )}
          {plugin.dependents?.length > 0 && (
            <div className="plugin-mgr-section">
              <div className="plugin-mgr-section-title">被以下插件依赖：</div>
              <div className="plugin-mgr-list">
                {plugin.dependents.map((dep: string) => (
                  <div key={dep} className="plugin-mgr-list-item is-warn">← {dep}</div>
                ))}
              </div>
            </div>
          )}
          {plugin.provides?.length > 0 && (
            <div className="plugin-mgr-section">
              <div className="plugin-mgr-section-title">提供的服务：</div>
              <div className="plugin-mgr-inline-tags">
                {plugin.provides.map((s: string) => <Badge key={s} variant="success">{s}</Badge>)}
              </div>
            </div>
          )}
          {plugin.inject?.length > 0 && (
            <div>
              <div className="plugin-mgr-section-title">消费的服务：</div>
              <div className="plugin-mgr-inline-tags">
                {plugin.inject.map((s: string) => <Badge key={s} variant="info">{s}</Badge>)}
              </div>
            </div>
          )}
          {/* UI 影响声明 — P1-1 */}
          {plugin.uiImpact && (
            <div className="plugin-mgr-box is-accent plugin-mgr-impact">
              <div className="plugin-mgr-impact-title">
                🖥️ UI 影响
              </div>
              {plugin.uiImpact.slots?.length > 0 && (
                <div className="plugin-mgr-impact-row">
                  <span className="plugin-mgr-impact-key">影响槽位：</span>
                  {plugin.uiImpact.slots.map((slot: string) => (
                    <Badge key={slot} variant="default">{slot}</Badge>
                  ))}
                </div>
              )}
              {plugin.uiImpact.buttons?.length > 0 && (
                <div className="plugin-mgr-impact-row">
                  <span className="plugin-mgr-impact-key">影响按钮：</span>
                  {plugin.uiImpact.buttons.map((btn: string) => (
                    <Badge key={btn} variant="warning">{btn}</Badge>
                  ))}
                </div>
              )}
              {plugin.uiImpact.panels?.length > 0 && (
                <div className="plugin-mgr-impact-row">
                  <span className="plugin-mgr-impact-key">影响面板：</span>
                  {plugin.uiImpact.panels.map((panel: string) => (
                    <Badge key={panel} variant="info">{panel}</Badge>
                  ))}
                </div>
              )}
              {plugin.uiImpact.degradedTo && (
                <div className="plugin-mgr-impact-degraded">
                  ↳ 降级为：{plugin.uiImpact.degradedTo}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 底部：作者 + 开关 */}
      <div className="market-skill-card-footer">
        <div className="market-skill-meta">
          {plugin.author && <span className="hint-sm">@{plugin.author}</span>}
          {plugin.hot && <Badge variant="warning">可热重载</Badge>}
        </div>
        <div className="plugin-mgr-switch-row">
          {plugin.hot && isEnabled && (
            <button
              className="market-skill-link-btn plugin-mgr-hot-btn"
              title="热重载"
              onClick={(e) => { e.stopPropagation(); onRestart(plugin.name) }}
            >
              <ActionIcons.refresh size={12} />
            </button>
          )}
          {/* 核心插件禁用开关 */}
          <Switch
            checked={isEnabled}
            onCheckedChange={() => onToggle(plugin.name)}
            disabled={isCore || plugin.status === 'loading'}
            aria-label={`${plugin.name}: ${plugin.status === 'enabled' ? 'disable plugin' : 'enable plugin'}`}
          />
        </div>
      </div>

      {/* 错误信息 */}
      {plugin.error && (
        <div className="plugin-mgr-error">
          {plugin.error}
        </div>
      )}
    </div>
  )
}

/** 级联关闭确认对话框（含风险提示） */
function CascadeConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: DisableConfirmationRequest
  onConfirm: () => void
  onCancel: () => void
}) {
  const cascade = request.cascadeList
  const hasCascade = cascade.affected.length > 1
  const targetMeta = cascade.affected.find(a => a.name === request.targetPlugin)

  return (
    <div className="modal-overlay" style={{ zIndex: "var(--z-modal-stacked)" }} onClick={onCancel}>
      <div
        className="modal-editor plugin-mgr-dialog"
        onClick={e => e.stopPropagation()}
      >
        <div className="plugin-mgr-dialog-head">
          <StatusIcons.danger size={20} className="plugin-mgr-dep-warn" />
          <span className="plugin-mgr-dialog-title">
            {hasCascade ? '关闭插件将影响其他插件' : '确认关闭插件'}
          </span>
        </div>

        <div className="plugin-mgr-dialog-lead">
          您即将关闭 <strong className="plugin-mgr-dialog-lead-strong">{request.targetPlugin}</strong>
        </div>

        {/* 风险提示区域 */}
        {request.riskLevel && request.riskLevel !== 'safe' && (
          <div className={`plugin-mgr-dialog-risk ${request.riskLevel === 'danger' ? 'is-danger' : 'is-warn'}`}>
            <div className="plugin-mgr-dialog-risk-title" style={{ color: RISK_LEVEL_CONFIG[request.riskLevel].color }}>
              {RISK_LEVEL_CONFIG[request.riskLevel].icon} 风险等级：{RISK_LEVEL_CONFIG[request.riskLevel].label}
            </div>
            <div className="plugin-mgr-dialog-risk-desc">
              {request.riskDescription}
            </div>
          </div>
        )}

        {/* 级联关闭列表 */}
        {hasCascade && (
          <>
            <div className="plugin-mgr-dialog-list-lead">
              以下插件依赖它，将同时被关闭：
            </div>
            <div className="plugin-mgr-dialog-list">
              {cascade.affected.filter(a => a.name !== request.targetPlugin).map(item => (
                <div key={item.name} className="plugin-mgr-dialog-item">
                  <StatusIcons.danger size={12} className="plugin-mgr-dep-warn" />
                  <span className="plugin-mgr-dialog-item-name">{item.name}</span>
                  <span className="hint-sm">— {item.reason}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="plugin-mgr-dialog-actions">
          <button className="skill-detail-btn" onClick={onCancel}>取消</button>
          <button
            className={`skill-detail-btn delete plugin-mgr-confirm-btn ${request.riskLevel === 'danger' ? 'is-danger' : 'is-warn'}`}
            onClick={onConfirm}
          >
            {hasCascade ? '确认全部关闭' : '确认关闭'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 插件管理器主组件 */
export function PluginManager({ onClose }: PluginManagerProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [manager, setManager] = useState<PluginManagerService | null>(null)
  const [, setForceUpdate] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [confirmRequest, setConfirmRequest] = useState<DisableConfirmationRequest | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'warning' } | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null)
  const [tab, setTab] = useState<'installed' | 'market'>('installed')

  // 初始化 PluginManagerService — 带重试机制，等待 Cordis Context 就绪
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    function attemptInit(retryCount: number = 0) {
      if (cancelled) return
      const ctx = tryGetCtx()
      if (!ctx) {
        // Cordis Context 尚未初始化 — 首次用静态清单建临时实例立即渲染（只读列表），
        // 后续重试不再重建（ctx-ready 单例由 initPluginManager 幂等缓存）
        try {
          if (retryCount === 0) {
            const graph = new PluginDependencyGraph()
            for (const meta of runtimePluginList) {
              graph.register(meta)
            }
            initPluginManager(null as any, graph).then(mgr => {
              if (cancelled) return
              setManager(mgr)
            }).catch(err => {
              if (cancelled) return
              console.error('[PluginManager] fallback init error:', err)
            })
          }
        } catch (err: any) {
          if (cancelled) return
          console.error('[PluginManager] fallback error:', err)
        }
        // 同时延迟重试，ctx 就绪后用真实单例刷新
        if (retryCount < 100) {
          retryTimer = setTimeout(() => attemptInit(retryCount + 1), 100)
        }
        return
      }

      try {
        // 通过 ctx.get() 正式 API 获取 pluginRegistry 服务
        const registry = ctx.get('pluginRegistry')
        if (!registry) {
          // Fiber 还在加载 — 先用 fallback 数据渲染，后台继续重试
          if (retryCount === 0) {
            const graph = new PluginDependencyGraph()
            for (const meta of runtimePluginList) {
              graph.register(meta)
            }
            initPluginManager(ctx, graph).then(mgr => {
              if (cancelled) return
              setManager(mgr)
            }).catch(() => {})
          }
          if (retryCount < 100) {
            retryTimer = setTimeout(() => attemptInit(retryCount + 1), 100)
          }
          return
        }

        const graph = new PluginDependencyGraph()
        for (const meta of registry.list()) {
          graph.register(meta)
        }

        initPluginManager(ctx, graph).then(mgr => {
          if (cancelled) return
          setManager(mgr)
        }).catch(err => {
          if (cancelled) return
          console.error('Failed to init PluginManager:', err)
          setToast({ msg: '初始化失败: ' + err.message, type: 'error' })
        })
      } catch (err: any) {
      if (cancelled) return
      console.error('[PluginManager] attemptInit error:', err)
      if (retryCount < 100) {
          retryTimer = setTimeout(() => attemptInit(retryCount + 1), 100)
        } else {
          setToast({ msg: '初始化失败: ' + err.message, type: 'error' })
        }
      }
    }

    attemptInit()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  // 订阅状态变化
  useEffect(() => {
    if (!manager) return
    const unsub = manager.subscribe(() => setForceUpdate(n => n + 1))
    return unsub
  }, [manager])

  // 处理开关切换
  const handleToggle = useCallback(async (name: string) => {
    if (!manager) return
    const state = manager.getPluginState(name)
    if (!state) return

    if (state.status === 'loading') {
      setToast({ msg: `${name} 正在加载中，请稍候...`, type: 'warning' })
      return
    }

    if (state.status === 'error') {
      // 上次启用失败 → 允许重试恢复（error 态已持久化为未启用）
      setToast({ msg: `正在重试启用 ${name}...`, type: 'warning' })
      const result = await manager.enable(name)
      if (result.success) {
        setToast({ msg: `已启用 ${name}`, type: 'success' })
      } else if (result.error) {
        setToast({ msg: result.error, type: 'error' })
      }
      return
    }

    if (state.status === 'enabled') {
      // 关闭：先检查依赖
      const cascade = manager.getDependencyGraph().getCascadeDisable(name)
      if (cascade.lockedReason) {
        setToast({ msg: cascade.lockedReason, type: 'error' })
        return
      }

      // 获取插件元数据中的风险信息
      const meta = manager.getDependencyGraph().get(name)
      const riskLevel = meta?.riskLevel || 'safe'
      const riskDescription = meta?.riskDescription

      // 如果有依赖链或有风险，弹出确认对话框
      if (cascade.needsConfirmation || riskLevel !== 'safe') {
        setConfirmRequest({
          targetPlugin: name,
          cascadeList: cascade,
          resolve: () => {},
          riskLevel,
          riskDescription,
        })
        return
      }

      // 安全插件直接关闭
      const result = await manager.disable(name)
      if (result.success) {
        setToast({ msg: `已关闭 ${name}`, type: 'success' })
      } else if (result.error) {
        setToast({ msg: result.error, type: 'error' })
      }
    } else if (state.status === 'disabled') {
      const result = await manager.enable(name)
      if (result.success) {
        setToast({
          msg: result.enabledList.length > 1
            ? `已启用 ${result.enabledList.length} 个插件（含依赖）`
            : `已启用 ${name}`,
          type: 'success',
        })
      } else if (result.error) {
        setToast({ msg: result.error, type: 'error' })
      }
    }
  }, [manager])

  // 处理级联确认
  const handleConfirmCascade = useCallback(async () => {
    if (!confirmRequest || !manager) return
    const result = await manager.disable(confirmRequest.targetPlugin)
    setConfirmRequest(null)
    if (result.success) {
      setToast({ msg: `已关闭 ${result.disabledList.length} 个插件（含级联依赖）`, type: 'success' })
    } else if (result.error) {
      setToast({ msg: result.error, type: 'error' })
    }
  }, [confirmRequest, manager])

  const handleCancelCascade = useCallback(() => {
    setConfirmRequest(null)
  }, [])

  // 获取过滤后的插件列表
  const plugins = useMemo(() => {
    if (!manager) return []
    let list = manager.getPluginStates()
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.keywords?.some((k: string) => k.toLowerCase().includes(q)) ||
        p.tags?.some((t: string) => t.toLowerCase().includes(q))
      )
    }
    if (activeCategory !== 'all') {
      list = list.filter(p => (p.category || 'core') === activeCategory)
    }
    return list
  }, [manager, searchQuery, activeCategory])

  // 统计数量
  const totalCount = manager?.getPluginStates().length || 0
  const enabledCount = manager?.getPluginStates().filter(p => p.status === 'enabled').length || 0

  return (
    <div className="skill-manager">
      {/* Header */}
      <div className="skill-manager-header">
        <div className="skill-manager-title">
          <PanelIcons.plugins size={20} className="skill-manager-icon-svg" />
          <span>{zh ? '插件管理' : 'Plugin Manager'}</span>
          <Badge variant="muted">{totalCount}</Badge>
          <Badge variant="success">{enabledCount} 启用</Badge>
        </div>
        <button className="skill-manager-close" onClick={onClose}>
          <ActionIcons.close size={16} />
        </button>
      </div>

      {/* Tab：已安装 / 插件市场 */}
      <div className="plugin-mgr-tabs">
        {([['installed', zh ? '已安装' : 'Installed'], ['market', zh ? '插件市场' : 'Market']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`plugin-mgr-tab ${tab === key ? 'is-active' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 插件市场 Tab：加载 dsh 插件市场（浏览/评估/安装等价） */}
      {tab === 'market' ? (
        <PluginMarketTab
          manager={manager}
          zh={zh}
          onToggle={handleToggle}
          notify={(msg, type) => setToast({ msg, type })}
        />
      ) : (
        <>
      {/* Search */}
      <div className="skill-manager-toolbar">
        <div className="skill-search-box">
          <ActionIcons.search size={14} className="skill-search-icon" />
          <input
            type="text"
            placeholder={zh ? '搜索插件...' : 'Search plugins...'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="skill-search-input"
          />
        </div>
      </div>

      {/* 分类过滤（动态：只显示实际存在插件的分类 + 全部，避免恒 0 的空分类按钮） */}
      <div className="skill-manager-filters">
        {getCategoryConfig(zh)
          .filter(cat => {
            if (cat.key === 'all') return true
            if (!manager) return false
            return manager.getPluginStates().some(p => (p.category || 'core') === cat.key)
          })
          .map(cat => {
          const count = cat.key === 'all'
            ? totalCount
            : manager?.getPluginStates().filter(p => (p.category || 'core') === cat.key).length || 0
          return (
            <button
              key={cat.key}
              className={`skill-filter-btn ${activeCategory === cat.key ? 'active' : ""}`}
              onClick={() => setActiveCategory(cat.key)}
            >
              {cat.icon} {cat.label}
              <span className="skill-filter-count">{count}</span>
            </button>
          )
        })}
      </div>

      {/* 插件网格 */}
      <div className="skill-market-grid">
        {plugins.length === 0 ? (
          <div className="skill-empty">
            {manager ? (zh ? '没有找到匹配的插件' : 'No matching plugins') : (zh ? '正在加载...' : 'Loading...')}
          </div>
        ) : (
          plugins.map(plugin => (
            <PluginCard
              key={plugin.name}
              plugin={plugin}
              onToggle={handleToggle}
              onRestart={async (name) => {
                if (!manager) return
                setToast({ msg: `正在重启 ${name}...`, type: 'warning' })
                const result = await manager.restart(name)
                setToast({
                  msg: result.success ? `${name} 已重启` : `重启失败: ${result.error}`,
                  type: result.success ? 'success' : 'error',
                })
              }}
              isSelected={selectedPlugin === plugin.name}
              onSelect={() => setSelectedPlugin(selectedPlugin === plugin.name ? null : plugin.name)}
            />
          ))
        )}
      </div>

      {/* 核心插件说明 */}
      <div className="plugin-mgr-footnote">
        💡 {zh ? '标有「核心」的插件是系统运行的基础设施，关闭会导致系统崩溃，已锁定不可关闭。其他插件可自由开关，系统会在关闭前检查依赖关系。' : 'Plugins marked as "Core" are system infrastructure. Disabling them would crash the system, so they are locked. Other plugins can be freely toggled; the system checks dependencies before disabling.'}
      </div>
        </>
      )}

      {/* 级联关闭确认对话框 */}
      {confirmRequest && (
        <CascadeConfirmDialog
          request={confirmRequest}
          onConfirm={handleConfirmCascade}
          onCancel={handleCancelCascade}
        />
      )}

      {/* Toast 消息 */}
      {toast && (
        <>
          <div className={`plugin-mgr-toast ${toast.type === 'success' ? 'is-success' : toast.type === 'error' ? 'is-error' : 'is-warn'}`}>
            {toast.msg}
          </div>
          <TimeoutToast key={toast.msg} onDismiss={() => setToast(null)} />
        </>
      )}
    </div>
  )
}

/** 自动消失的 toast */
function TimeoutToast({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000)
    return () => clearTimeout(timer)
  }, [])
  return null
}
