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
    const registry = ctx.get('pluginRegistry')
    if (!registry) return
    const results = search
      ? registry.search(search)
      : registry.list()
    setPlugins(results)
  }, [ctx, search])

  useEffect(() => { refresh() }, [refresh])

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
    const registry = ctx.get('pluginRegistry')
    const installer = ctx.get('pluginInstaller')
    if (!registry || !installer) return
    const all = registry.list()
    setInstalled(all.filter(p => installer.isInstalled(p.name)).map(p => p.name))
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

export function apply() {
  const ctx = useCtx()
  const slots = ctx.get('slots')
  slots.register('app.plugin-market', PluginMarketPanel)
  slots.register('app.plugin-manager', PluginManagerPanel)
}
