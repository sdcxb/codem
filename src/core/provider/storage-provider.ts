// @ts-nocheck
/**
 * Storage Provider 插件 — 可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const storageProvider: Plugin = (ctx: any) => {
  const dispose = ctx.provide('storage', {
    get: <T>(key: string): T | undefined => {
      const v = localStorage.getItem(`codem:${key}`)
      return v ? JSON.parse(v) : undefined
    },
    set: <T>(key: string, value: T) => {
      localStorage.setItem(`codem:${key}`, JSON.stringify(value))
    },
    delete: (key: string) => localStorage.removeItem(`codem:${key}`),
    list: (prefix?: string) => {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!
        if (k.startsWith('codem:') && (!prefix || k.includes(prefix))) {
          keys.push(k.replace('codem:', ''))
        }
      }
      return keys
    },
  })

  return dispose
}
