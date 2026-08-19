// @ts-nocheck
/**
 * Preset Provider 插件 — 配置预设管理。
 *
 * F6: 深化 — 接入 storage/settings.ts 持久化预设。
 * apply() 批量写入 settings。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSettingJSON, setSetting, setSettingJSON } from '../storage/settings.ts'

// Built-in presets
const BUILTIN_PRESETS: Record<string, any> = {
  'strict_security': {
    description: '严格安全模式 — 限制所有危险操作',
    settings: {
      'security-mode': 'strict',
      'auto-approve-tools': 'false',
      'telemetry-enabled': 'false',
    },
  },
  'relaxed': {
    description: '宽松模式 — 自动审批大部分操作',
    settings: {
      'security-mode': 'relaxed',
      'auto-approve-tools': 'true',
      'telemetry-enabled': 'true',
    },
  },
  'development': {
    description: '开发模式 — 平衡安全与效率',
    settings: {
      'security-mode': 'normal',
      'auto-approve-tools': 'false',
      'telemetry-enabled': 'true',
    },
  },
}

export const presetProvider: Plugin = (ctx: any) => {
  // Load user presets from settings
  const loadUserPresets = (): Record<string, any> => {
    return getSettingJSON<Record<string, any>>('user-presets', {})
  }

  let userPresets = loadUserPresets()

  /** Get all presets (builtin + user) */
  const getAllPresets = (): Record<string, any> => {
    return { ...BUILTIN_PRESETS, ...userPresets }
  }

  const dispose = ctx.provide('preset', {
    _active: true,

    /** Load a preset by name */
    async load(name: string): Promise<any> {
      const all = getAllPresets()
      return all[name]
    },

    /** Save a user preset */
    async save(name: string, config: any): Promise<void> {
      userPresets[name] = { ...config, isUserPreset: true }
      setSettingJSON('user-presets', userPresets)
    },

    /** Delete a user preset */
    async delete(name: string): Promise<void> {
      delete userPresets[name]
      setSettingJSON('user-presets', userPresets)
    },

    /** List all presets */
    list(): Array<{ name: string; description: string; isBuiltin: boolean }> {
      const result: Array<{ name: string; description: string; isBuiltin: boolean }> = []
      for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
        result.push({ name, description: preset.description || '', isBuiltin: true })
      }
      for (const [name, preset] of Object.entries(userPresets)) {
        result.push({ name, description: (preset as any).description || '', isBuiltin: false })
      }
      return result
    },

    /** Apply a preset to settings */
    async apply(name: string): Promise<void> {
      const all = getAllPresets()
      const preset = all[name]
      if (!preset) {
        throw new Error(`Preset "${name}" not found`)
      }

      console.log(`[preset] Applying preset: ${name}`)
      const settings = preset.settings || preset

      // Apply each setting
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value === 'object') {
          setSettingJSON(key, value)
        } else {
          setSetting(key, String(value))
        }
      }

      // Emit event for UI to refresh
      ctx?.emit?.('preset:applied', { name, settings })
    },

    /** Get the currently active preset (best guess) */
    getActivePreset(): string | null {
      // Check which preset's settings match current settings
      for (const [name, preset] of Object.entries(getAllPresets())) {
        const settings = preset.settings || preset
        let matches = true
        for (const [key, value] of Object.entries(settings)) {
          const current = getSettingJSON(key, null)
          if (current !== value && String(current) !== String(value)) {
            matches = false
            break
          }
        }
        if (matches) return name
      }
      return null
    },
  })

  // Composite dispose
  const compositeDispose = () => {
    dispose()
  }
  return compositeDispose
}
