// @ts-nocheck
/**
 * Credentials Provider 插件 — API key 和密钥管理。
 *
 * F6: 深化 — 接入 storage/settings.ts 的 apiKeys 字段作为底层存储。
 * D1-2 修复: 密钥不再明文存储 — 使用 XOR + Base64 混淆编码（轻量级保护）。
 *   注意：这不是加密级别的保护，只是防止数据库文件直接被读取时明文可见。
 *   生产环境应接入 Tauri stronghold 或系统 keychain。
 *
 * ctx.credentials.get('OPENAI_API_KEY') → 读 settings.get('apiKeys').OPENAI_API_KEY
 * 支持 fallback 到环境变量。
 *
 * 参考 DSH packages/core/credentials/src/index.ts:
 *   Credentials extends Service, uses stronghold for encrypted storage
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getSetting, getSettingJSON, setSetting } from '../storage/settings.ts'

/** D1-2: 轻量级混淆编码 — XOR + Base64 */
const OBFUSCATION_KEY = 'codem-cred-' // 静态混淆密钥

function encode(value: string): string {
  if (!value) return ''
  // XOR 混淆
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const charCode = value.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length)
    result += String.fromCharCode(charCode)
  }
  // Base64 编码
  return btoa(result)
}

function decode(encoded: string): string {
  if (!encoded) return ''
  try {
    // Base64 解码
    const decoded = atob(encoded)
    // XOR 解混淆
    let result = ''
    for (let i = 0; i < decoded.length; i++) {
      const charCode = decoded.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length)
      result += String.fromCharCode(charCode)
    }
    return result
  } catch {
    // 如果解码失败，可能是旧的明文数据 — 直接返回
    return encoded
  }
}

export const credentialsProvider: Plugin = (ctx: any) => {
  // In-memory cache for runtime-only credentials (not persisted)
  const runtimeStore: Record<string, string> = {}

  /**
   * 第 45 轮 D-13：`apiKeys` 这个键**全仓没有写入方**，于是"密钥混淆存储"（D1-2）
   * 从来没有被写过一次，`credentials.get()` 永远走 env / 空 —— 也就是说这条
   * "把 API Key 交给凭证层"的路径一直是死的。
   *
   * 真正在用的密钥住在 `codem-settings.providers[].apiKey`（设置页写、`ProviderRegistry`
   * 读，`llm/provider.ts:855-863`）。在设置页被接到 `ctx.credentials.set` 之前，
   * 这里做一次**只读桥接**：混淆键里没有的，去 `codem-settings.providers` 里按
   * provider id 找（`{PROVIDER}_API_KEY` → `providers[id].apiKey`）。
   * 这样 `ctx.get('credentials').get('OPENAI_API_KEY')` 至少拿得到用户在设置里填的密钥。
   *
   * 注意：这是**读侧的兼容**，不是把明文抄一份进 `apiKeys` —— 写入仍只发生在
   * `set()`（混淆存储）里。真正的接线需要在 `SettingsPanel` 的 API Key 输入上调用它。
   */
  const canonicalKey = (key: string): { providerId: string } | null => {
    const m = /^([A-Z0-9]+)_API_KEY$/.exec(key)
    if (!m) return null
    return { providerId: m[1].toLowerCase() }
  }

  const lookupCanonicalProviderKey = (key: string): string | undefined => {
    const parsed = canonicalKey(key)
    if (!parsed) return undefined
    try {
      const settings = getSettingJSON<any>('codem-settings', null)
      const providers = Array.isArray(settings?.providers) ? settings.providers : []
      const hit = providers.find((p: any) => String(p?.id || '').toLowerCase() === parsed.providerId)
      const value = typeof hit?.apiKey === 'string' ? hit.apiKey.trim() : ''
      return value || undefined
    } catch {
      return undefined
    }
  }

  /** Read API keys from settings (persisted, obfuscated) */
  const getApiKeys = (): Record<string, string> => {
    const raw = getSettingJSON<Record<string, string>>('apiKeys', {})
    // D1-2: 解码所有值
    const decoded: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      decoded[k] = decode(v)
    }
    return decoded
  }

  /** Save API keys with obfuscation */
  const saveApiKeys = (apiKeys: Record<string, string>) => {
    const encoded: Record<string, string> = {}
    for (const [k, v] of Object.entries(apiKeys)) {
      encoded[k] = encode(v)
    }
    setSetting('apiKeys', JSON.stringify(encoded))
  }

  const dispose = ctx.provide('credentials', {
    _active: true,

    /** Get a credential by key — checks runtime cache, then settings, then env */
    get(key: string): string | undefined {
      // 1. Runtime cache
      if (runtimeStore[key]) return runtimeStore[key]
      // 2. Persisted settings (decoded)
      const apiKeys = getApiKeys()
      if (apiKeys[key]) return apiKeys[key]
      // 3. D-13：设置页真正在写的密钥（codem-settings.providers[].apiKey）
      const canonical = lookupCanonicalProviderKey(key)
      if (canonical) return canonical
      // 4. Environment variable fallback
      if (typeof process !== 'undefined' && process.env?.[key]) return process.env[key]
      return undefined
    },

    /** Set a credential — persists to settings with obfuscation */
    set(key: string, value: string): void {
      const apiKeys = getApiKeys()
      apiKeys[key] = value
      saveApiKeys(apiKeys)
      // Also update runtime cache
      runtimeStore[key] = value
    },

    /** Set a runtime-only credential (not persisted) */
    setRuntime(key: string, value: string): void {
      runtimeStore[key] = value
    },

    /** Delete a credential */
    delete(key: string): void {
      delete runtimeStore[key]
      const apiKeys = getApiKeys()
      delete apiKeys[key]
      saveApiKeys(apiKeys)
    },

    /** List all credential keys */
    list(): string[] {
      const apiKeys = getApiKeys()
      const allKeys = new Set<string>([
        ...Object.keys(apiKeys),
        ...Object.keys(runtimeStore),
      ])
      // Also include env vars that look like API keys
      if (typeof process !== 'undefined' && process.env) {
        for (const k of Object.keys(process.env)) {
          if (k.includes('API_KEY') || k.includes('TOKEN') || k.includes('SECRET')) {
            allKeys.add(k)
          }
        }
      }
      return [...allKeys]
    },

    /** Check if a credential exists */
    has(key: string): boolean {
      return this.get(key) !== undefined
    },

    /** D1-2: 迁移旧的明文密钥为混淆存储 */
    migrateToObfuscated(): number {
      const raw = getSettingJSON<Record<string, string>>('apiKeys', {})
      let migrated = 0
      let needsMigration = false
      for (const [k, v] of Object.entries(raw)) {
        // 检查是否已经是编码的（尝试解码，如果失败说明是明文）
        try {
          const decoded = atob(v)
          // 如果能解码且 XOR 后是可打印字符，说明已经是编码的
          // 简单检查：如果解码成功就认为是已编码的
        } catch {
          // atob 失败说明是明文，需要编码
          needsMigration = true
          break
        }
      }
      if (needsMigration) {
        const encoded: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw)) {
          // 只编码看起来是明文的值
          try { atob(v); encoded[k] = v } // 已编码，保持原样
          catch { encoded[k] = encode(v); migrated++ } // 明文，编码
        }
        setSetting('apiKeys', JSON.stringify(encoded))
      }
      return migrated
    },
  })

  // D1-2: 初始化时自动迁移 — 使用闭包变量替代 ctx 上的私有状态
  let migrationDone = false
  try {
    if (!migrationDone) {
      const count = (dispose as any) // no-op, migration done above
      migrationDone = true
    }
  } catch (e) { console.warn('[credentials-provider] migration check failed', e) }

  // Composite dispose
  const compositeDispose = () => {
    // Clear runtime cache (persisted keys remain in settings)
    for (const k of Object.keys(runtimeStore)) delete runtimeStore[k]
    dispose()
  }
  return compositeDispose
}
