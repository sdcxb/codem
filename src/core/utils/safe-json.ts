/**
 * D2-4: 公共安全 JSON 解析工具 — 防止数据库字段损坏导致崩溃
 *
 * 参考 DSH packages/core/utils/src/json.ts:
 *   safeJsonParse<T>(str, fallback) — 解析失败返回 fallback 而非抛出
 */

/**
 * 安全解析 JSON 字符串，解析失败时返回 fallback
 */
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch (e) {
    console.warn('[safeJsonParse] Failed to parse JSON, using fallback:', (e as Error).message, 'raw:', str.slice(0, 100))
    return fallback
  }
}

/**
 * 安全序列化为 JSON 字符串
 */
export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch (e) {
    console.warn('[safeJsonStringify] Failed to stringify:', (e as Error).message)
    return null
  }
}
