// @ts-nocheck
/**
 * PluginManager — 插件市场 UI 组件。
 *
 * 功能：
 * 1. 已安装插件用**密集列表行**展示（不再是三列 emoji 卡片墙）
 * 2. 每行：一个 lucide 图标 / 名称+版本 / 单行描述 / 类型 / 依赖数 / 开关
 * 3. 核心插件（core: true）标记为"核心"并禁用开关按钮
 * 4. 关闭有依赖的插件时，弹出级联确认对话框
 * 5. 启用插件时，自动启用缺失依赖
 * 6. 搜索和能力/界面分组过滤
 *
 * ## 为什么不再渲染 `plugin.icon`
 *
 * 插件清单里的 `icon` 是 emoji（拼图 / 机器人 / 屏幕等字符）。198 行各带一个 emoji + 2–3 个徽标
 * 正是「卡片墙看起来像噪音」的主因；manifest 里的 emoji 不再进入 DOM，图标位只放
 * **一个**按分类映射的 lucide（`PluginGlyph`），没有映射时退回 `CommonIcons.package`。
 *
 * ## 行高与列宽由集成样式决定
 *
 * 本文件只产出结构与类名（`.plugin-list` / `.plugin-row` / `.plugin-row-*`）。
 * 集成方在样式层给 `.plugin-row` 定 56–64px 行高与网格列宽；组件里不写死尺寸，
 * 避免和皮肤/密度档（`data-density="compact"`）打架。
 */

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
/* 第 181 轮审计整改：长列表分片渲染（一次渲染 208 张卡 = 6095 个节点） */
import { IncrementalList } from './ui/IncrementalList'
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
  type DisableConfirmationRequest,
  PluginManagerService,
  getPluginManager,
  initPluginManager,
} from '../core/plugin-loader/plugin-manager-service'
import { tryGetCtx } from '../core/consumer'
import { runtimePluginList } from '../core/provider/plugin-registry-provider'
import { PluginMarketTab } from './plugin-market/PluginMarketTab'
import { DshExternalPluginsCard } from './plugin-market/DshExternalPluginsCard'
// 第 201 波：免费模型插件（独立本地服务）的控制卡片
import { FreeModelPluginCard } from './FreeModelPluginCard'
// P2-15: 初始化失败要经既有上报通道（并配 setToast 的可见提示），不再静默吞掉
import { reportActionFailure } from '../core/storage/persist-failure'

interface PluginManagerProps {
  onClose: () => void
}

/** 类型标签的显示配置 */
/**
 * 「免费模型插件」卡片参与搜索的关键词（第 205 波）。
 *
 * 用户实报「在插件管理里搜 free 或者 model 都找不到这个插件」—— 它**不是** cordis 插件，
 * 不在 `manager.getPluginStates()` 里，所以搜索那个列表永远搜不到它。这些关键词让它能被搜出来。
 */
const FREE_MODEL_CARD_KEYWORDS = ["free", "model", "免费", "模型", "our free model", "插件"];

/** 免费模型插件在「已安装」网格里的合成条目（它不在 cordis 注册表里）。 */
const FREE_MODEL_PLUGIN_STUB = {
  name: "our-free-model",
  description: "独立本地服务：免费模型列表与起停控制；点击查看详情。",
  version: "",
  status: "enabled",
  category: "provider",
  tags: ["provider"],
  keywords: FREE_MODEL_CARD_KEYWORDS,
  core: false,
  dependencies: [],
  dependents: [],
};

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

/**
 * 分类 → **一个** lucide 图标。
 *
 * `plugin.icon` 不再渲染（manifest 里那是 emoji）；没有分类映射时退回 package。
 */
const PLUGIN_CATEGORY_ICONS = {
  core: PanelIcons.plugins,
  provider: McpIcons.connect,
  ui: PanelIcons.agent,
  tool: PanelIcons.tools,
  compat: ActionIcons.link,
} as const

/** 分类文案（类型标签为空时的兜底）。 */
const PLUGIN_CATEGORY_LABEL: Record<string, { zh: string; en: string }> = {
  core: { zh: '核心', en: 'Core' },
  provider: { zh: '服务', en: 'Provider' },
  ui: { zh: '界面', en: 'UI' },
  tool: { zh: '工具', en: 'Tool' },
  compat: { zh: '兼容', en: 'Compat' },
  /* 没有类别（或运行时出现未知类别）的插件统一归到这里，不另造一个分组。 */
  other: { zh: '其他', en: 'Other' },
}

/**
 * 「全部」视图里的分组顺序（插件类别是 `PluginMeta.category` 的五档 + 其他）。
 *
 * 顺序按能力面收敛：核心 → 服务 → 工具 → 界面 → 兼容 → 其他。
 * 分组标题只在「全部」筛选且没有搜索词时出现；搜索/筛选保持平铺（见 `groupedView`）。
 */
const PLUGIN_GROUP_ORDER = ['core', 'provider', 'tool', 'ui', 'compat', 'other'] as const

/** 插件所属分组 key：已知类别即类别，缺类别/未知类别归 `other`。 */
function pluginGroupKey(plugin: any): string {
  const category = plugin?.category
  return category && PLUGIN_CATEGORY_LABEL[category] ? category : 'other'
}

/** 分组标题文案（中英与类型标签同源，都取 `PLUGIN_CATEGORY_LABEL`）。 */
function pluginGroupLabel(key: string, zh: boolean): string {
  const entry = PLUGIN_CATEGORY_LABEL[key] ?? PLUGIN_CATEGORY_LABEL.other
  return zh ? entry.zh : entry.en
}

function PluginGlyph({ plugin, size = 16 }: { plugin: any; size?: number }) {
  const Icon = PLUGIN_CATEGORY_ICONS[(plugin.category || 'core') as keyof typeof PLUGIN_CATEGORY_ICONS]
    ?? CommonIcons.package
  return <Icon size={size} strokeWidth={1.5} aria-hidden="true" />
}

/** 4 个分组（全部 / 核心 / 能力 / 界面），覆盖原来的 5 个分类。 */
type PluginFilterKey = 'all' | 'core' | 'capability' | 'interface'

/** 分类配置（支持 i18n） */
function getCategoryConfig(zh: boolean) {
  return [
    { key: 'all' as PluginFilterKey,        label: zh ? '全部' : 'All',        icon: <CommonIcons.info size={14} /> },
    { key: 'core' as PluginFilterKey,       label: zh ? '核心' : 'Core',       icon: <PanelIcons.plugins size={14} /> },
    { key: 'capability' as PluginFilterKey, label: zh ? '能力' : 'Capability', icon: <PanelIcons.tools size={14} /> },
    { key: 'interface' as PluginFilterKey,  label: zh ? '界面' : 'Interface',  icon: <PanelIcons.agent size={14} /> },
  ]
}

/** 分组过滤：能力 = provider + tool；界面 = ui + compat。 */
function matchesCategory(plugin: any, key: string): boolean {
  const category = plugin.category || 'core'
  switch (key) {
    case 'all': return true
    case 'core': return category === 'core'
    case 'capability': return category === 'provider' || category === 'tool'
    case 'interface': return category === 'ui' || category === 'compat'
    default: return category === key
  }
}

/**
 * 已安装插件的一行。
 *
 * 列（由 `.plugin-row` 的网格在样式层落地）：图标 / 名称+版本 / 单行描述 /
 * 类型 / 依赖数 / 状态开关。行本身可以点开详情，键盘入口是名称按钮。
 */
function PluginRow({
  plugin,
  zh,
  onToggle,
  onRestart,
  onOpenDetail,
}: {
  plugin: any
  zh: boolean
  onToggle: (name: string) => void
  onRestart: (name: string) => void
  onOpenDetail: () => void
}) {
  const isEnabled = plugin.status === 'enabled'
  const isCore = plugin.core || plugin.locked
  const tags: PluginTag[] = plugin.tags || []
  const tag = tags[0]
  const tagLabel = tag ? (TAG_CONFIG[tag]?.label ?? tag) : undefined
  const category = PLUGIN_CATEGORY_LABEL[plugin.category as string]
  const typeLabel = tagLabel
    ?? (category ? (zh ? category.zh : category.en) : (zh ? '插件' : 'Plugin'))
  const depCount = plugin.dependencies?.length ?? 0
  /*
   * 风险只在「危险 + 用户真的能决定」时出现：核心插件是锁定的，挂个红点等于 198 行噪音。
   * 这里只是一个安静的文字标签（不是 Badge/pill），完整说明在详情里。
   */
  const showRisk = plugin.riskLevel === 'danger' && !isCore
  const description = plugin.description || (zh ? '暂无描述' : 'No description')

  return (
    <div
      className={`plugin-row ${isEnabled ? '' : 'is-off'} ${isCore ? 'is-core' : ''}`}
      data-plugin-row={plugin.name}
      data-plugin-status={plugin.status}
      onClick={onOpenDetail}
    >
      <span className="plugin-row-icon" aria-hidden="true">
        <PluginGlyph plugin={plugin} />
      </span>

      <span className="plugin-row-name">
        <button
          type="button"
          className="plugin-row-open"
          title={plugin.name}
          onClick={(e) => { e.stopPropagation(); onOpenDetail() }}
        >
          {plugin.name}
        </button>
        {plugin.version && <span className="plugin-row-version">v{plugin.version}</span>}
        {isCore && <span className="plugin-row-core">{zh ? '核心' : 'Core'}</span>}
      </span>

      <span className="plugin-row-desc" title={description}>{description}</span>

      <span className="plugin-row-type">{typeLabel}</span>

      <span
        className="plugin-row-deps"
        title={depCount > 0 ? plugin.dependencies.join('、') : undefined}
      >
        {/*
          依赖数为 0 时**不留「—」占位**：那时它传递的信息是「没有依赖」，
          而「—」在一列里会读成缺失值（真机上看起来像「服务 / —」随机字符）。
          列本身（这个 span）仍然渲染 —— 它是 `.plugin-row` 网格的第五格，
          少了子元素会让开关错列到「依赖」列。
        */}
        {depCount > 0 ? (zh ? `${depCount} 依赖` : `${depCount} dep`) : null}
      </span>

      <span className="plugin-row-actions" onClick={(e) => e.stopPropagation()}>
        {showRisk && (
          <span
            className="plugin-row-risk"
            title={plugin.riskDescription || (zh ? '关闭前需要确认' : 'Confirm before disabling')}
          >
            {zh ? '高风险' : 'Risk'}
          </span>
        )}
        {plugin.hot && isEnabled && (
          <button
            type="button"
            className="plugin-row-hot"
            title={zh ? '热重载' : 'Reload'}
            onClick={() => onRestart(plugin.name)}
          >
            {zh ? '重载' : 'Reload'}
          </button>
        )}
        {plugin.status === 'loading' && <span className="plugin-row-state">{zh ? '加载中' : 'Loading'}</span>}
        {plugin.status === 'error' && (
          <span className="plugin-row-state is-error" title={plugin.error}>{zh ? '错误' : 'Error'}</span>
        )}
        {/* 核心插件禁用开关 */}
        <Switch
          checked={isEnabled}
          onCheckedChange={() => onToggle(plugin.name)}
          disabled={isCore || plugin.status === 'loading'}
          title={isCore ? (zh ? '核心插件已锁定，不可关闭' : 'Core plugin: locked') : undefined}
          aria-label={`${plugin.name}: ${isEnabled ? 'disable plugin' : 'enable plugin'}`}
        />
      </span>
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
        role="dialog"
        aria-modal="true"
        aria-label="插件管理"
        onClick={e => e.stopPropagation()}
      >
        <div className="plugin-mgr-dialog-head">
          <StatusIcons.danger className="icon-lg plugin-mgr-dep-warn" />
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
              风险等级：{RISK_LEVEL_CONFIG[request.riskLevel].label}
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
/**
 * 插件详情弹层：点击任意插件卡打开。
 * 所有插件共用同一个详情页；FreeModel 的控制面板作为它的详情内容挂在这里，
 * 不再在列表里占一大块。
 */
function PluginDetailDialog({
  plugin,
  zh,
  onClose,
  onToggle,
  onRestart,
}: {
  plugin: any
  zh: boolean
  onClose: () => void
  onToggle: (name: string) => void
  onRestart: (name: string) => void
}) {
  const isCore = plugin.core || plugin.locked
  const tags: PluginTag[] = plugin.tags || []
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-editor plugin-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${plugin.name} 详情`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="plugin-detail-head">
          <span className="market-skill-icon"><PluginGlyph plugin={plugin} size={16} /></span>
          <div className="plugin-detail-title">
            <strong>{plugin.name}</strong>
            {plugin.version && <Badge variant="muted">v{plugin.version}</Badge>}
            {isCore && <Badge variant="info">{zh ? '核心' : 'Core'}</Badge>}
          </div>
          <button className="plugin-detail-close" onClick={onClose} aria-label={zh ? '关闭详情' : 'Close details'}>
            <ActionIcons.close />
          </button>
        </div>
        <p className="plugin-detail-desc">{plugin.description || (zh ? '暂无描述' : 'No description')}</p>
        {plugin.error && <div className="plugin-mgr-error">{plugin.error}</div>}
        {tags.length > 0 && (
          <div className="plugin-detail-tags">
            {tags.map((tag) => <Badge key={tag} variant={TAG_CONFIG[tag]?.variant ?? 'default'}>{TAG_CONFIG[tag]?.label ?? tag}</Badge>)}
          </div>
        )}
        {plugin.riskLevel && plugin.riskLevel !== 'safe' && (
          <div className={`plugin-detail-risk ${plugin.riskLevel === 'danger' ? 'is-danger' : 'is-warn'}`}>
            {RISK_LEVEL_CONFIG[plugin.riskLevel].label}
            {plugin.riskDescription ? ` — ${plugin.riskDescription}` : ''}
          </div>
        )}
        {plugin.dependencies?.length > 0 && (
          <div className="plugin-detail-section">
            <div className="plugin-detail-label">{zh ? '依赖的插件' : 'Dependencies'}</div>
            <div className="plugin-detail-chips">{plugin.dependencies.map((d: string) => <Badge key={d} variant="info">{d}</Badge>)}</div>
          </div>
        )}
        {plugin.dependents?.length > 0 && (
          <div className="plugin-detail-section">
            <div className="plugin-detail-label">{zh ? '被以下插件依赖' : 'Dependents'}</div>
            <div className="plugin-detail-chips">{plugin.dependents.map((d: string) => <Badge key={d} variant="warning">{d}</Badge>)}</div>
          </div>
        )}
        {(plugin.provides?.length > 0 || plugin.inject?.length > 0) && (
          <div className="plugin-detail-section">
            <div className="plugin-detail-label">{zh ? '服务' : 'Services'}</div>
            <div className="plugin-detail-chips">
              {(plugin.provides ?? []).map((s: string) => <Badge key={`p-${s}`} variant="success">提供 {s}</Badge>)}
              {(plugin.inject ?? []).map((s: string) => <Badge key={`i-${s}`} variant="muted">消费 {s}</Badge>)}
            </div>
          </div>
        )}
        <div className="plugin-detail-actions">
          {!isCore && (
            <button className="plugin-detail-btn" onClick={() => onToggle(plugin.name)}>
              {plugin.status === 'enabled' ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}
            </button>
          )}
          {plugin.status === 'error' && (
            <button className="plugin-detail-btn" onClick={() => onRestart(plugin.name)}>{zh ? '重启' : 'Restart'}</button>
          )}
          <span className="plugin-detail-status">{plugin.status}</span>
        </div>
      </div>
    </div>
  )
}

export function PluginManager({ onClose }: PluginManagerProps) {
  const lang = useLang()
  const zh = lang === 'zh'
  const [manager, setManager] = useState<PluginManagerService | null>(null)
  /**
   * 订阅驱动的版本号（第 48 轮）。
   *
   * 原来这里是 `const [, setForceUpdate] = useState(0)` —— **只取 setter、丢掉值**，
   * 于是"重渲染"发生了，但任何以 `useMemo` 缓存了插件状态的派生数据都不会重算
   * （memo 看不到版本号变化）。插件卡片列表与插件市场页签的"已安装/启用"标记
   * 都栽在这一点上：界面上的开关与真实状态长期不一致。
   *
   * 现在把值留下来，并作为那些 memo 的依赖（见 `plugins` 与 `PluginMarketTab`）。
   */
  const [stateVersion, setStateVersion] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [confirmRequest, setConfirmRequest] = useState<DisableConfirmationRequest | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'warning' } | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null)
  const [detailPlugin, setDetailPlugin] = useState<any | null>(null)
  const [freeModelDetail, setFreeModelDetail] = useState(false)
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
            }).catch(err => {
              // P2-15: 原实现是 `.catch(() => {})` —— 失败完全静默，
              // 面板会永久停在「正在加载...」，用户既看不到原因也无法重试。
              // 同函数 444-448 与 449-457 两个分支都会 setToast，这里补齐一致行为。
              if (cancelled) return
              console.error('[PluginManager] fallback init failed:', err)
              reportActionFailure('pluginManager.fallbackInit', err, '插件管理面板未能初始化')
              setToast({ msg: '初始化失败: ' + (err?.message ?? String(err)), type: 'error' })
            })
          }
          if (retryCount < 100) {
            retryTimer = setTimeout(() => attemptInit(retryCount + 1), 100)
          } else {
            // P2-15: 重试次数耗尽后同样必须可见（否则界面上永远只有「正在加载...」）
            reportActionFailure(
              'pluginManager.initTimeout',
              new Error('pluginRegistry service not registered after 100 retries'),
              '插件注册表未装配，插件管理不可用',
            )
            setToast({ msg: '初始化失败: 插件注册表未装配（已停止重试）', type: 'error' })
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
    const unsub = manager.subscribe(() => setStateVersion(n => n + 1))
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
        /**
         * 第 63 轮：**"状态改了"不等于"卸载了"**。
         *
         * 真机读数（`.preview-shot/out-pluginmanager-warning.txt`）：`@codem/ui-game`
         * 这类插件的 fiber 既不在 manager 手里、也不在 YAML 装配登记表里，
         * `doDisable` 两处 dispose 都落空 —— 此时状态确实变成 disabled、界面入口也隐藏了，
         * 但插件代码会一直跑到重启。原实现一律弹「已关闭 X」（success 绿色），
         * 那是一句与事实相反的承诺。现在按 `unloadedList` 如实分两种说法。
         */
        const unloadedAll = (result.unloadedList?.length ?? 0) >= result.disabledList.length
        if (unloadedAll) {
          setToast({ msg: `已关闭 ${name}`, type: 'success' })
        } else {
          setToast({
            msg: `已关闭 ${name}（已禁用，界面入口已隐藏；该插件本次未装载，或没有可卸载句柄，重启后彻底不加载）`,
            type: 'warning',
          })
        }
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

  /*
   * 热重载：列表行与详情弹层共用同一个处理器。
   *
   * 详情弹层原来接的是 `onRestart(name)` —— 那个标识符在组件作用域里**不存在**，
   * 点一下就是 ReferenceError（只是很少有人真去点详情里的重启）。抽出来一并修掉。
   */
  const handleRestart = useCallback(async (name: string) => {
    if (!manager) return
    setToast({ msg: `正在重启 ${name}...`, type: 'warning' })
    const result = await manager.restart(name)
    setToast({
      msg: result.success ? `${name} 已重启` : `重启失败: ${result.error}`,
      type: result.success ? 'success' : 'error',
    })
  }, [manager])

  // 处理级联确认
  const handleConfirmCascade = useCallback(async () => {
    if (!confirmRequest || !manager) return
    const result = await manager.disable(confirmRequest.targetPlugin)
    setConfirmRequest(null)
    if (result.success) {
      // 与单插件开关同一口径：只改了状态、没真卸载时必须说清（不许许愿"已关闭"）
      const unloadedAll = (result.unloadedList?.length ?? 0) >= result.disabledList.length
      setToast({
        msg: unloadedAll
          ? `已关闭 ${result.disabledList.length} 个插件（含级联依赖）`
          : `已关闭 ${result.disabledList.length} 个插件（含级联依赖）—— 其中 ${result.disabledList.length - (result.unloadedList?.length ?? 0)} 个未装载/无可卸载句柄，重启后彻底不加载`,
        type: unloadedAll ? 'success' : 'warning',
      })
    } else if (result.error) {
      setToast({ msg: result.error, type: 'error' })
    }
  }, [confirmRequest, manager])

  const handleCancelCascade = useCallback(() => {
    setConfirmRequest(null)
  }, [])

  // 分组标题只在「全部」且没有搜索词时出现；搜索/筛选保持平铺。
  const groupedView = activeCategory === 'all' && searchQuery.trim() === ''

  // 获取过滤后的插件列表
  //
  // ⚠️ 第 48 轮（真机发现的 P1）：`stateVersion` **必须**在依赖里。
  //
  // `manager.getPluginStates()` 每次调用都读**实时**状态，但它被包在一个 `useMemo` 里，
  // 而 memo 的依赖原来是 `[manager, searchQuery, activeCategory]` —— 这三个在
  // 一次开关切换之后**都不会变**。于是：
  //   - 顶部的 `totalCount` / `enabledCount`（在 render 里直接算，没有 memo）**会**更新；
  //   - 而卡片列表（`plugins`）**不会**重算，卡片上的开关与状态标签永远停在打开弹窗那一刻。
  //
  // 真机实测（打包版 1.16.76，插件管理面板）：点开关启用 `@codem/ui-game` 之后，
  // 权威介质当场写对了（`codem-disabled-plugins` 由 `["@codem/ui-game"]` 变为 `[]`，
  // 时间戳 `1789723668130` 与镜像一致），但卡片上的开关**仍然显示未启用**、
  // `aria-label` 仍然是「enable plugin」。此时再点一次，会走到"关闭"分支并弹出
  // 「确认关闭插件」对话框 —— 用户看到的是「点了没反应，再点却问我是不是要关闭」。
  //
  // `setStateVersion` 由 `manager.subscribe` 驱动（见下方订阅 effect），
  // 所以每次状态/加载/失败变化都会让这个 memo 重算 —— 卡片与顶部计数从此同源同帧。
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
      list = list.filter(p => matchesCategory(p, activeCategory))
    }
    const freeMatch = !searchQuery || FREE_MODEL_CARD_KEYWORDS.some(k => searchQuery.toLowerCase().includes(k));
    /* 免费模型插件的分类是 provider ⇒ 归在「能力」分组里。 */
    const freeCategory = activeCategory === 'all' || activeCategory === 'capability';
    if (freeMatch && freeCategory) list = [FREE_MODEL_PLUGIN_STUB, ...list];

    /*
     * 分组要**连续**才有意义：注册表里同类插件并不总是相邻
     * （UI 插件之后还有 R4/R5 的 provider）。直接按出现顺序插标题会把
     * 同一类别切成好几段，所以这里做稳定分桶（组内保持注册表原顺序），
     * 让「全部」视图成为 core → provider → tool → ui → compat → 其他 的连续分组。
     */
    if (groupedView) {
      const buckets = new Map<string, typeof list>()
      for (const key of PLUGIN_GROUP_ORDER) buckets.set(key, [])
      for (const plugin of list) buckets.get(pluginGroupKey(plugin))!.push(plugin)
      list = PLUGIN_GROUP_ORDER.flatMap((key) => buckets.get(key)!)
    }
    return list
  }, [manager, searchQuery, activeCategory, stateVersion, groupedView])

  /**
   * 分组标题的计数，以及「这一行是不是本组第一行」。
   * 只在 `groupedView` 下参与渲染；平铺视图不读它。
   */
  const pluginGroups = useMemo(() => {
    const counts: Record<string, number> = {}
    const starts: Record<string, boolean> = {}
    let previous: string | null = null
    for (const plugin of plugins) {
      const key = pluginGroupKey(plugin)
      counts[key] = (counts[key] ?? 0) + 1
      if (key !== previous) starts[plugin.name] = true
      previous = key
    }
    return { counts, starts }
  }, [plugins])

  // 统计数量
  const totalCount = (manager?.getPluginStates().length || 0) + 1
  const enabledCount = (manager?.getPluginStates().filter(p => p.status === 'enabled').length || 0) + 1

  /** 分组计数（免费模型插件是 provider ⇒ 只在「全部/能力」里 +1）。 */
  const countForFilter = (key: PluginFilterKey) => {
    const states = manager?.getPluginStates() ?? []
    const matched = states.filter(p => matchesCategory(p, key)).length
    if (key === 'all') return matched + 1
    return matched + (key === 'capability' ? 1 : 0)
  }

  return (
    <div className="skill-manager">
      {/* Header */}
      <div className="skill-manager-header">
        <div className="skill-manager-title">
          <PanelIcons.plugins className="icon-lg skill-manager-icon-svg" />
          <span>{zh ? '插件管理' : 'Plugin Manager'}</span>
          {/* 统计是一行 mono meta，不再是两个 pill */}
          <span className="plugin-mgr-stats" data-testid="plugin-mgr-stats">
            {zh
              ? `${totalCount} 个插件 · ${enabledCount} 个已启用`
              : `${totalCount} plugins · ${enabledCount} enabled`}
          </span>
        </div>
        <button className="skill-manager-close" aria-label={zh ? "关闭面板" : "Close panel"} onClick={onClose}>
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
        <>
          {/*
            第 201 波：「免费模型插件」（dsh-our-free-model 的 standalone 本地服务）的独立控制卡片。
            它**不是** cordis 插件（不受这里的启用/禁用注册表管），所以单独一张卡片、单独三个动作 ——
            用户的要求就是"独立存在、可开启/暂停/删除、不影响 codem"。
          */}
          <PluginMarketTab
            manager={manager}
            stateVersion={stateVersion}
            zh={zh}
            onToggle={handleToggle}
            notify={(msg, type) => setToast({ msg, type })}
          />
        </>
      ) : (
        <>
      {/* Search */}
      <div className="skill-manager-toolbar">
        <div className="skill-search-box">
          <ActionIcons.search size={14} className="skill-search-icon" />
          <input
            type="text"
            placeholder={zh ? '搜索插件' : 'Search plugins'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="skill-search-input" aria-label="搜索插件 / Search plugins"
          />
        </div>
      </div>

      {/*
        第 205 波（用户实报「在插件管理里搜 free 或者 model 都找不到这个插件」）：
        免费模型插件**不是** cordis 插件（它不受这里的启用/禁用注册表管），所以它不在
        `manager.getPluginStates()` 里 —— 搜索只过滤那个列表，自然搜不到它。

        修法：把那张卡片也放到**默认的「已安装」页签**里，并且让它**参与搜索**
        （关键词命中就显示：free / model / 免费 / 模型 …）。市场页签仍然常驻它。
      */}
      {/*
        外部 DSH 插件（dsh-ops 真实用例）：不是 cordis 内置插件，单独一张卡片，
        支持检查更新 / 升级安装 / 停用；停用只改 Codem 管理状态，不注入运行时。
      */}
      {(searchQuery.trim() === '' || /dsh|ops|插件|plugin/i.test(searchQuery)) && (
        <DshExternalPluginsCard zh={zh} notify={(msg, type) => setToast({ msg, type: type ?? 'info' })} />
      )}

      {/* 分组过滤（4 个以内分段；空分组不渲染） */}
      <div className="skill-manager-filters">
        {getCategoryConfig(zh)
          .filter(cat => cat.key === 'all' || countForFilter(cat.key) > 0)
          .map(cat => {
          const count = countForFilter(cat.key)
          return (
            <button
              key={cat.key}
              data-testid={`plugin-filter-${cat.key}`}
              className={`skill-filter-btn ${activeCategory === cat.key ? 'active' : ""}`}
              aria-pressed={activeCategory === cat.key}
              onClick={() => setActiveCategory(cat.key)}
            >
              {cat.icon} {cat.label}
              <span className="skill-filter-count">{count}</span>
            </button>
          )
        })}
      </div>

      {/* 插件列表
          第 181 轮审计整改：原来这里是 `plugins.map(...)` —— 207 个内置插件 + 1 个扩展
          **一次性造 208 张卡**，实测 6095 个 DOM 节点（含 1952 个内联 SVG 图标），
          而干净状态的整个应用只有 620 个节点。改走分片渲染：首屏 40 行，滚动/按钮追加。 */}
      {plugins.length > 0 && (
        <div className="plugin-list-head" aria-hidden="true">
          <span />
          <span>{zh ? '插件' : 'Plugin'}</span>
          <span>{zh ? '说明' : 'Description'}</span>
          <span>{zh ? '类型' : 'Type'}</span>
          <span>{zh ? '依赖' : 'Deps'}</span>
          <span>{zh ? '状态' : 'State'}</span>
        </div>
      )}
      {plugins.length === 0 ? (
        <div className="plugin-list">
          <div className="empty-hint">
            {manager ? (zh ? '没有找到匹配的插件' : 'No matching plugins') : (zh ? '正在加载...' : 'Loading...')}
          </div>
        </div>
      ) : (
        <IncrementalList
          className="plugin-list"
          items={plugins}
          resetKey={`${activeCategory}|${searchQuery}|${tab}`}
          initial={40}
          step={40}
          moreLabel={(rest) =>
            zh ? `加载更多（剩余 ${rest}）` : `Load more (${rest} left)`
          }
          renderItem={(plugin) => {
            /*
             * 分组标题是**行的兄弟节点**（同一个分片里、同一个 Fragment），
             * 不是分片元素本身 —— 40/40 的「行」计数与「加载更多（剩余 N）」
             * 仍是行数，不会因为多插了几个标题而变。
             */
            const groupKey = groupedView ? pluginGroupKey(plugin) : null
            return (
              <Fragment key={plugin.name}>
                {groupKey && pluginGroups.starts[plugin.name] && (
                  <div className="plugin-list-group" data-plugin-group={groupKey}>
                    <span className="plugin-list-group__label">{pluginGroupLabel(groupKey, zh)}</span>
                    <span className="plugin-list-group__count">{pluginGroups.counts[groupKey] ?? 0}</span>
                  </div>
                )}
                {plugin.name === "our-free-model" ? (
                  <FreeModelPluginCard compact onOpenDetail={() => setFreeModelDetail(true)} />
                ) : (
                  <PluginRow
                    plugin={plugin}
                    zh={zh}
                    onToggle={handleToggle}
                    onRestart={handleRestart}
                    onOpenDetail={() => setDetailPlugin(plugin)}
                  />
                )}
              </Fragment>
            )
          }}
        />
      )}

      {/* 核心插件说明 */}
      <div className="plugin-mgr-footnote">
        {zh ? '标有「核心」的插件是系统运行的基础设施，关闭会导致系统崩溃，已锁定不可关闭。其他插件可自由开关，系统会在关闭前检查依赖关系。' : 'Plugins marked as "Core" are system infrastructure. Disabling them would crash the system, so they are locked. Other plugins can be freely toggled; the system checks dependencies before disabling.'}
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

      {detailPlugin && (
        <PluginDetailDialog
          plugin={detailPlugin}
          zh={zh}
          onClose={() => setDetailPlugin(null)}
          onToggle={(name) => { void handleToggle(name); setDetailPlugin(null) }}
          onRestart={(name) => { void handleRestart(name) }}
        />
      )}

      {freeModelDetail && (
        <div className="modal-overlay" role="presentation" onClick={() => setFreeModelDetail(false)}>
          <div className="modal-editor plugin-detail-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="plugin-detail-head">
              <strong>{zh ? 'Our Free Model · 详情' : 'Our Free Model · Details'}</strong>
              <button className="plugin-detail-close" onClick={() => setFreeModelDetail(false)} aria-label={zh ? '关闭详情' : 'Close details'}>
                <ActionIcons.close />
              </button>
            </div>
            <FreeModelPluginCard />
          </div>
        </div>
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
