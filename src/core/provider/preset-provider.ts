// @ts-nocheck
/**
 * Preset Provider 插件 — 配置预设管理。
 *
 * F6: 深化 — 接入 storage/settings.ts 持久化预设。
 * apply() 批量写入 settings。
 *
 * ## 第 45 轮 D-10：这条链路此前写的是**没有任何读取方的键**
 *
 * 旧实现（逐字）：
 * ```ts
 * 'strict_security': { settings: { 'security-mode': 'strict',
 *                                  'auto-approve-tools': 'false',
 *                                  'telemetry-enabled': 'false' } },
 * ```
 * 三个键名**全都不对**：
 * - 真实的安全模式键是 `codem-security-mode`，取值是 `"ask" | "auto" | "full"`
 *   （`core/permission/security-mode.ts:37/70-81`，默认 `"ask"`）——旧值 `"strict"` 连枚举
 *   都对不上，所以即使键名写对了也会被 `getGlobalSecurityMode()` 判为非法值而回落默认；
 * - `auto-approve-tools` / `telemetry-enabled` **全仓没有任何读取方**（grep 只有这一处写入）。
 *
 * 也就是说：`apply('strict_security')` 写进去的东西**一个字节都不会生效**，
 * 而 `getActivePreset()` 又读回同一批错的键，于是应用完还会自称"strict_security 生效中"
 * ——典型"设置看起来能存、其实没有生效点"。
 *
 * 现在的做法（按审计给的最小方案）：**复用真实解析层**
 * ——安全模式走 `setGlobalSecurityMode()`（真实键 + 合法值校验 + 广播
 * `codem-security-mode-changed`），并把那两个无读取方的键从内置预设里删掉；
 * 判断"当前生效预设"也改为按**同一个真实键**比较。
 * （顺带修掉一处编码错位：旧 `getActivePreset` 用 `getSettingJSON` 读，而 `apply` 用
 * `setSetting` 写裸串 —— `JSON.parse("ask")` 必然抛，于是永远判不出"正在生效"。）
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSetting, getSettingJSON, setSetting, setSettingJSON } from '../storage/settings.ts'
import { getGlobalSecurityMode, setGlobalSecurityMode } from '../permission/security-mode.ts'

/**
 * 预设里唯一能真正生效的字段名。
 *
 * 用 `securityMode` 这个**中性字段名**而不是直接沿用键名：预设是"语义层"，
 * 该映射到哪个真实键（`codem-security-mode`）由这一层负责，调用方不必知道。
 */
const SECURITY_MODE_FIELD = 'securityMode'

/** 历史值 → 真实枚举值（用户自己存的旧预设里可能有 `strict` / `relaxed` / `normal`） */
function normalizeSecurityMode(value: unknown): 'ask' | 'auto' | 'full' | null {
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'ask' || s === 'auto' || s === 'full') return s
  if (s === 'strict') return 'ask' // 严格 = 每次都要批准
  if (s === 'relaxed' || s === 'normal' || s === 'development') return 'auto' // 宽松/开发 = 安全操作自动通过
  return null
}

// Built-in presets
const BUILTIN_PRESETS: Record<string, any> = {
  strict_security: {
    description: '严格安全模式 — 危险操作与写入覆盖一律请求人工批准',
    settings: { [SECURITY_MODE_FIELD]: 'ask' },
  },
  development: {
    description: '开发模式 — 安全操作自动通过，危险操作仍需批准',
    settings: { [SECURITY_MODE_FIELD]: 'auto' },
  },
  relaxed: {
    description: '宽松模式 — 永不询问，所有操作直接执行（完全访问）',
    settings: { [SECURITY_MODE_FIELD]: 'full' },
  },
}

/** 预设里除安全模式字段之外的键：按原样写（用户自定义预设可能带别的键） */
function applyRawSetting(key: string, value: unknown): void {
  if (typeof value === 'object') setSettingJSON(key, value)
  else setSetting(key, String(value))
}

/** 期望值的比较文本（对象走 JSON，标量走字符串） */
function expectedText(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 读回某个预设字段当前的真实值，返回可直接比较的文本 */
function currentText(key: string): string | null {
  // 安全模式字段要按**真实读取方**（getGlobalSecurityMode）比较：
  // 它带默认值与合法性回落，拿裸存储值比会永远判不相等。
  if (key === SECURITY_MODE_FIELD) return getGlobalSecurityMode()
  const raw = getSetting(key)
  if (raw === null) return null
  // 值可能是 JSON（`applyRawSetting` 对对象用 setSettingJSON）。这里**只做等价的规范化**，
  // 而不是退回 `getSettingJSON` —— 旧实现正是用 `getSettingJSON` 读 `setSetting` 写的裸串
  // （`JSON.parse("ask")` 抛 → 永远判不出"正在生效"）。
  try {
    return JSON.stringify(JSON.parse(raw))
  } catch {
    return raw
  }
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
        if (key === SECURITY_MODE_FIELD) {
          const mode = normalizeSecurityMode(value)
          if (mode === null) {
            // 非法值不写（写进去只会被解析层判非法并回落默认，还让 getActivePreset 撒谎）
            throw new Error(`Preset "${name}" 的安全模式取值不合法：${String(value)}`)
          }
          setGlobalSecurityMode(mode)
          continue
        }
        applyRawSetting(key, value)
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
          const current = currentText(key)
          const expected =
            key === SECURITY_MODE_FIELD
              ? (normalizeSecurityMode(value) ?? expectedText(value))
              : expectedText(value);
          if (current !== expected) {
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
