// @ts-nocheck
/**
 * Permissions Provider 插件 — 权限预设服务，可独立加载/卸载/热替换。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const permissionsProvider: Plugin = (ctx: any) => {
  const permPresets = new Map<string, { id: string; label: string; rules: any[] }>([
    ['default', { id: 'default', label: 'Default', rules: [{ allow: ['read', 'write', 'list'] }] }],
    ['strict', { id: 'strict', label: 'Strict', rules: [{ allow: ['read'], deny: ['write', 'delete'] }] }],
    ['open', { id: 'open', label: 'Open', rules: [{ allow: '*' }] }],
  ])
  let currentPreset = 'default'

  const dispose = ctx.provide('permissions', {
    presets: () => [...permPresets.values()],
    applyPreset: (presetId: string) => { if (permPresets.has(presetId)) currentPreset = presetId },
    getCurrentPreset: () => currentPreset,
    registerPreset: (preset: { id: string; label: string; rules: any[] }) => { permPresets.set(preset.id, preset) },
  })

  return dispose
}
