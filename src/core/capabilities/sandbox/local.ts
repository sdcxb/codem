// @ts-nocheck
/**
 * @codem/sandbox-local — 本地沙箱 Provider
 *
 * P2-2: 消除架构级重复 — re-export provider/sandbox-provider.ts 的实现。
 * @deprecated 直接从 src/core/provider/sandbox-provider.ts 导入。
 */
export { sandboxProvider as sandboxLocalProvider } from '../../provider/sandbox-provider.ts'
