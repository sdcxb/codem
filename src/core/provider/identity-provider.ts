// @ts-nocheck
/**
 * Identity Provider 插件 — 身份服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const identityProvider: Plugin = (ctx: any) => {
  const id = crypto.randomUUID()

  const dispose = ctx.provide('identity', {
    getId() { return id },
    getName() { return 'Anonymous' },
  })

  return dispose
}
