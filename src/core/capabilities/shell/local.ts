// @ts-nocheck
/**
 * @codem/shell-local — 本地 Shell Provider
 *
 * P2-2: 消除架构级重复 — re-export provider/shell-provider.ts 的实现。
 * @deprecated 直接从 src/core/provider/shell-provider.ts 导入。
 */
export { shellProvider as shellLocalProvider } from '../../provider/shell-provider.ts'
