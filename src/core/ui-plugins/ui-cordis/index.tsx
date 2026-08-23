// @ts-nocheck
/**
 * @codem/ui-cordis — Cordis 管理面板 UI 插件
 *
 * 提供查看/管理动态加载插件的 UI 面板。
 *
 * 对标 DSH 模式：
 * - 不轮询、不 setTimeout 重试
 * - 服务不可用时显示空状态
 * - 用户可手动刷新
 */
import { useState, useCallback } from 'react'
import { tryGetCtx, useCtxReady } from '../../consumer/index.ts'

export function CordisPanel() {
  const ctxReady = useCtxReady()
  const ctx = tryGetCtx()
  const [plugins, setPlugins] = useState<any[]>([])
  const [services, setServices] = useState<string[]>([])
  const [dynamicList, setDynamicList] = useState<string[]>([])

  const refresh = useCallback(() => {
    if (!ctx) return
    const runner = ctx.get('dynamicCordisRunner')
    if (!runner) {
      // 服务未注册 — 显示空状态，不轮询
      setPlugins([])
      setServices([])
      setDynamicList([])
      return
    }
    const info = runner.inspect()
    setPlugins(info.plugins)
    setServices(info.services)
    setDynamicList(runner.list())
  }, [ctx])

  // ctx 就绪后同步刷新一次
  if (ctxReady && plugins.length === 0 && services.length === 0 && dynamicList.length === 0) {
    refresh()
  }

  const handleRetract = (name: string) => {
    if (!ctx) return
    const runner = ctx.get('dynamicCordisRunner')
    if (!runner) return
    runner.retract(name)
    refresh()
  }

  const runner = ctx?.get('dynamicCordisRunner')
  if (!ctxReady || !runner) {
    return (
      <div className="cordis-panel">
        <h3>Cordis Runtime</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {ctxReady ? '动态插件服务未就绪' : '正在初始化...'}
        </p>
      </div>
    )
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

export function apply(ctx: any) {
  const slots = ctx.get('slots')
  slots.register({ name: 'app.cordis', id: 'default-cordis-panel', priority: 0 }, CordisPanel)
}
