// @ts-nocheck
/**
 * Credentials Provider 插件 — API key 和密钥管理。
 *
 * 功能链：
 * - 上游：ProviderRegistry 初始化时获取 API key（provider.ts createDefaultProviders）
 *         dsh-compat 层的 dshCredentials 适配（dsh-compat/index.ts L239-L253）
 * - 下游：LLM API 调用
 * - 接入点：provider.ts 的 createDefaultProviders() → ctx.credentials.get()
 *           dsh-compat/index.ts L239 → dshCredentials.get() 委托 ctx.credentials
 *           settings.ts L113 → apiKeys 字段作为底层存储
 *
 * 当前为空壳实现，真实实现需：
 * 1. 包装 SettingsManager，以 apiKeys 字段为底层存储
 * 2. ctx.credentials.get('OPENAI_API_KEY') → 读 settings.get('apiKeys').OPENAI_API_KEY
 * 3. 未来扩展：支持 keychain/系统密钥库（Tauri tauri-plugin-stronghold）
 */
import type { Plugin } from '../cordis/src/index.ts'

export const credentialsProvider: Plugin = (ctx: any) => {
  const credStore: Record<string, string> = {}

  const dispose = ctx.provide('credentials', {
    get(key: string): string | undefined {
      return credStore[key] || (typeof process !== 'undefined' && process.env?.[key]) || undefined
    },
    set(key: string, value: string): void {
      credStore[key] = value
    },
    delete(key: string): void {
      delete credStore[key]
    },
    list(): string[] {
      return Object.keys(credStore)
    },
  })

  return dispose
}
