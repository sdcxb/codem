// @ts-nocheck
/**
 * @codem/ui-cordis — Cordis 管理面板 UI 插件
 *
 * 提供查看/管理动态加载插件的 UI 面板。
 */
import { useState, useEffect, useCallback } from 'react'
import { tryGetCtx } from '../../consumer/index.ts'

export function CordisPanel() {
  // 使用 tryGetCtx 避免在 Context 未初始化时抛出错误
  const ctx = tryGetCtx()
  const [plugins, setPlugins] = useState<any[]>([])
  const [services, setServices] = useState<string[]>([])
  const [dynamicList, setDynamicList] = useState<string[]>([])

  const refresh = useCallback(() => {
    if (!ctx) return
    const runner = ctx.get('dynamicCordisRunner')
    if (!runner) return
    const info = runner.inspect()
    setPlugins(info.plugins)
    setServices(info.services)
    setDynamicList(runner.list())
  }, [ctx])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleRetract = (name: string) => {
    if (!ctx) return
    const runner = ctx.get('dynamicCordisRunner')
    if (!runner) return
    runner.retract(name)
    refresh()
  }

  return (
    <div className="cordis-panel">
      <h3>Cordis Runtime</h3>

      <section>
        <h4>Services ({services.length})</h4>
        <ul>
          {services.map(s => <li key={s}>{s}</li>)}
        </ul>
      </section>

      <section>
        <h4>Dynamic Plugins ({dynamicList.length})</h4>
        <ul>
          {dynamicList.map(name => (
            <li key={name}>
              {name}
              <button onClick={() => handleRetract(name)}>Retract</button>
            </li>
          ))}
        </ul>
      </section>

      <button onClick={refresh}>Refresh</button>
    </div>
  )
}

export function apply() {
  const ctx = useCtx()
  const slots = ctx.get('slots')
  slots.register('app.cordis', CordisPanel)
}
