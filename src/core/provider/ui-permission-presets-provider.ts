// @ts-nocheck
/**
 * @codem/ui-permission-presets — 权限预设 UI 插件
 *
 * 对标 DSH packages/client/ui-permission-presets/src/client/index.ts。
 * 注册 PermissionPresetSelector 组件到 Slot，同时提供权限预设服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots'] — 框架保证 ctx.get('slots') 可用后才执行。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { PermissionPresetSelector } from '../../components/PermissionPresetSelector'

interface PermissionPreset {
  id: string
  name: string
  description: string
  level: 'strict' | 'normal' | 'permissive'
  rules: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveShell: boolean
    autoApproveWeb: boolean
    requireConfirmationForDelete: boolean
    blockedPaths: string[]
  }
}

class PermissionPresetsService {
  private presets: Map<string, PermissionPreset> = new Map()
  private currentPreset: string = 'normal'
  private listeners: Array<(preset: string) => void> = []

  constructor() {
    const defaults: PermissionPreset[] = [
      {
        id: 'strict', name: '严格模式', description: '所有操作需确认，禁止写入和命令执行',
        level: 'strict',
        rules: { autoApproveRead: false, autoApproveWrite: false, autoApproveShell: false, autoApproveWeb: false, requireConfirmationForDelete: true, blockedPaths: ['**'] },
      },
      {
        id: 'normal', name: '标准模式', description: '读取自动批准，写入和命令执行需确认',
        level: 'normal',
        rules: { autoApproveRead: true, autoApproveWrite: false, autoApproveShell: false, autoApproveWeb: true, requireConfirmationForDelete: true, blockedPaths: [] },
      },
      {
        id: 'permissive', name: '宽松模式', description: '读写和命令执行自动批准，仅删除需确认',
        level: 'permissive',
        rules: { autoApproveRead: true, autoApproveWrite: true, autoApproveShell: true, autoApproveWeb: true, requireConfirmationForDelete: true, blockedPaths: [] },
      },
    ]
    for (const p of defaults) this.presets.set(p.id, p)
  }

  registerPreset(preset: PermissionPreset) { this.presets.set(preset.id, preset) }
  listPresets(): PermissionPreset[] { return [...this.presets.values()] }
  getPreset(id: string): PermissionPreset | undefined { return this.presets.get(id) }
  getCurrentPreset(): PermissionPreset | undefined { return this.presets.get(this.currentPreset) }
  selectPreset(id: string) { if (this.presets.has(id)) { this.currentPreset = id; this.notify(id) } }
  shouldAutoApprove(toolType: string): boolean { const preset = this.getCurrentPreset(); if (!preset) return false; switch (toolType) { case 'read': return preset.rules.autoApproveRead; case 'write': return preset.rules.autoApproveWrite; case 'shell': return preset.rules.autoApproveShell; case 'web': return preset.rules.autoApproveWeb; default: return false } }
  isPathBlocked(path: string): boolean { const preset = this.getCurrentPreset(); if (!preset) return false; return preset.rules.blockedPaths.some(p => { const regex = new RegExp(p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')); return regex.test(path) }) }
  subscribe(listener: (preset: string) => void) { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter(l => l !== listener) } }
  private notify(preset: string) { this.listeners.forEach(l => { try { l(preset) } catch (e) { console.warn('[uiPermissionPresets] listener failed', e) } }) }
}

export const uiPermissionPresetsProvider: Plugin = Object.assign(
  (ctx: any) => {
    const service = new PermissionPresetsService()

    const dispose = ctx.provide('uiPermissionPresets', {
      registerPreset: (preset: any) => service.registerPreset(preset),
      listPresets: () => service.listPresets(),
      getPreset: (id: string) => service.getPreset(id),
      getCurrentPreset: () => service.getCurrentPreset(),
      selectPreset: (id: string) => service.selectPreset(id),
      shouldAutoApprove: (toolType: string) => service.shouldAutoApprove(toolType),
      isPathBlocked: (path: string) => service.isPathBlocked(path),
      subscribe: (listener: any) => service.subscribe(listener),
    })

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.permission-preset-selector', id: 'r8-permissionpreset', priority: 5 }, PermissionPresetSelector)

    // 使用 slots.inject 声明消费依赖：conversation.composer.bar 存在时注册
    const injectUnreg = slots.inject('conversation.composer.bar', () =>
      slots.register({ name: 'conversation.composer.bar', id: 'r8-permissionpreset-sub', priority: 5 }, PermissionPresetSelector)
    )

    return () => {
      if (dispose) dispose()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots'] }
)
