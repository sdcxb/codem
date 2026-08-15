// @ts-nocheck
/**
 * @codem/ui-plugin-market — 插件市场 UI
 *
 * 浏览/搜索/安装/卸载/更新插件的 UI 面板。
 */
import { useState, useEffect, useCallback } from 'react'
import { useCtx } from '../consumer/index.ts'

export function PluginMarketPanel() {
  const ctx = useCtx()
  const [plugins, setPlugins] = useState<any[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'installed' | 'available'>('all')

  const refresh = useCallback(() => {
    if (!ctx?.pluginRegistry) return
    const results = search
      ? ctx.pluginRegistry.search(search)
      : ctx.pluginRegistry.list()
    setPlugins(results)
  }, [ctx, search])

  useEffect(() => { refresh() }, [refresh])

  const handleInstall = async (name: string) => {
    if (!ctx?.pluginInstaller) return
    await ctx.pluginInstaller.install(name)
    refresh()
  }

  const handleUninstall = async (name: string) => {
    if (!ctx?.pluginInstaller) return
    await ctx.pluginInstaller.uninstall(name)
    refresh()
  }

  const filteredPlugins = plugins.filter(p => {
    if (filter === 'installed') return ctx?.pluginInstaller?.isInstalled(p.name)
    if (filter === 'available') return !ctx?.pluginInstaller?.isInstalled(p.name)
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
              {ctx?.pluginInstaller?.isInstalled(p.name) ? (
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
  const ctx = useCtx()
  const [installed, setInstalled] = useState<string[]>([])

  useEffect(() => {
    if (!ctx?.pluginRegistry || !ctx?.pluginInstaller) return
    const all = ctx.pluginRegistry.list()
    setInstalled(all.filter(p => ctx.pluginInstaller.isInstalled(p.name)).map(p => p.name))
  }, [ctx])

  return (
    <div className="plugin-manager">
      <h3>Installed Plugins ({installed.length})</h3>
      <ul>
        {installed.map(name => (
          <li key={name}>
            {name}
            <button onClick={() => ctx.pluginInstaller.uninstall(name)}>Uninstall</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function apply() {
  const ctx = useCtx()
  ctx.slots.register('app.plugin-market', PluginMarketPanel)
  ctx.slots.register('app.plugin-manager', PluginManagerPanel)
}
