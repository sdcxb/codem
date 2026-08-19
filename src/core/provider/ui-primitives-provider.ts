// @ts-nocheck
/**
 * @codem/ui-primitives — UI 原语库插件 (P2-7.14)
 *
 * 提供基础 UI 组件库（Button、Input、Modal、Tooltip 等），
 * 第三方插件可通过 ctx.get('uiPrimitives') 获取统一组件。
 *
 * 功能链路融入（文档 6.2 链路 F: UI 渲染链）：
 * - 启动时：注册 UI 原语，所有 UI 插件共享同一组件库
 * - 停止时：UI 插件回退到自己的组件实现
 */
import type { Plugin } from '../cordis/src/index.ts'

class UIPrimitives {
  private components: Map<string, any> = new Map()

  register(name: string, component: any) {
    this.components.set(name, component)
  }

  get(name: string): any | null {
    return this.components.get(name) || null
  }

  list(): string[] {
    return Array.from(this.components.keys())
  }
}

export const uiPrimitivesProvider: Plugin = (ctx: any) => {
  const primitives = new UIPrimitives()

  // 注册基础原语占位符（实际组件由 UI 层注入）
  const placeholder = ({ children }: any) => children || null
  ;['Button', 'Input', 'Modal', 'Tooltip', 'Badge', 'Spinner', 'Divider', 'Card'].forEach(name => {
    primitives.register(name, placeholder)
  })

  const dispose = ctx.provide('uiPrimitives', {
    register(name: string, component: any) { primitives.register(name, component) },
    get(name: string) { return primitives.get(name) },
    list() { return primitives.list() },
  })

  return dispose
}
