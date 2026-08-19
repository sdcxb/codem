// @ts-nocheck
/**
 * @codem/ui-plugin-market — 插件市场 UI
 *
 * 浏览/搜索/安装/卸载/更新插件的 UI 面板。
 */
import { useState, useEffect, useCallback } from 'react'
import { tryGetCtx } from '../consumer/index.ts'

export function PluginMarketPanel() {
  // 使用 tryGetCtx 避免在 Context 未初始化时抛出错误
  const ctx = tryGetCtx()
  const [plugins, setPlugins] = useState<any[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'installed' | 'available'>('all')

  const refresh = useCallback(() => {
    if (!ctx) return
    // 使用 strict 默认模式（true），确保 Provider fiber 处于 ACTIVE 状态。
    // 对标 DSH Cordis 架构：消费者必须等待服务完全就绪后才访问。
    const registry = ctx.get('pluginRegistry')
    if (!registry) return
    const results = search
      ? registry.search(search)
      : registry.list()
    setPlugins(results)
  }, [ctx, search])

  useEffect(() => {
    // 重试机制：Provider fiber 可能还在 LOADING 中，
    // 等待其变为 ACTIVE 后 ctx.get() 才会返回服务实例。
    let retry = 0
    const timer = setInterval(() => {
      const ok = ctx?.get('pluginRegistry')
      if (ok) {
        clearInterval(timer)
        refresh()
      } else if (++retry > 50) {
        clearInterval(timer)
      }
    }, 100)
    return () => clearInterval(timer)
  }, [ctx, refresh])

  const handleInstall = async (name: string) => {
    if (!ctx) return
    const installer = ctx.get('pluginInstaller')
    if (!installer) return
    await installer.install(name)
    refresh()
  }

  const handleUninstall = async (name: string) => {
    if (!ctx) return
    const installer = ctx.get('pluginInstaller')
    if (!installer) return
    await installer.uninstall(name)
    refresh()
  }

  const filteredPlugins = plugins.filter(p => {
    if (!ctx) return true
    const installer = ctx.get('pluginInstaller')
    if (!installer) return true
    if (filter === 'installed') return installer.isInstalled(p.name)
    if (filter === 'available') return !installer.isInstalled(p.name)
    return true
  })

  return (
    <div className="plugin-market">
      <h3>Plugin Market</h3>

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search plugins..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={filter} onChange={e => setFilter(e.target.value as any)}>
          <option value="all">All</option>
          <option value="installed">Installed</option>
          <option value="available">Available</option>
        </select>
      </div>

      <div className="plugin-list">
        {filteredPlugins.map(p => (
          <div key={p.name} className="plugin-card">
            <h4>{p.name} <span className="version">v{p.version}</span></h4>
            <p>{p.description}</p>
            {p.provides.length > 0 && (
              <div className="provides">
                <strong>Provides:</strong> {p.provides.join(', ')}
              </div>
            )}
            {p.inject.length > 0 && (
              <div className="inject">
                <strong>Injects:</strong> {p.inject.join(', ')}
              </div>
            )}
            <div className="actions">
              {ctx?.get('pluginInstaller')?.isInstalled(p.name) ? (
                <button onClick={() => handleUninstall(p.name)}>Uninstall</button>
              ) : (
                <button onClick={() => handleInstall(p.name)}>Install</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function PluginManagerPanel() {
  // 使用 tryGetCtx 避免在 Context 未初始化时抛出错误
  const ctx = tryGetCtx()
  const [installed, setInstalled] = useState<string[]>([])

  useEffect(() => {
    if (!ctx) return
    // 重试机制：等待 Provider fiber 变为 ACTIVE
    let retry = 0
    const timer = setInterval(() => {
      // strict 模式：确保 Provider 完全 ACTIVE 后才消费
      const registry = ctx.get('pluginRegistry')
      const installer = ctx.get('pluginInstaller')
      if (registry && installer) {
        clearInterval(timer)
        const all = registry.list()
        setInstalled(all.filter(p => installer.isInstalled(p.name)).map(p => p.name))
      } else if (++retry > 50) {
        clearInterval(timer)
      }
    }, 100)
    return () => clearInterval(timer)
  }, [ctx])

  return (
    <div className="plugin-manager">
      <h3>Installed Plugins ({installed.length})</h3>
      <ul>
        {installed.map(name => (
          <li key={name}>
            {name}
            <button onClick={() => ctx.get('pluginInstaller')?.uninstall(name)}>Uninstall</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function apply(ctx: any) {
  const slots = ctx.get('slots')
  slots.register('app.plugin-market', PluginMarketPanel)
  slots.register('app.plugin-manager', PluginManagerPanel)
}
