// @ts-nocheck
/**
 * @codem/fs-local — 本地文件系统 Provider
 *
 * P2-2: 消除架构级重复 — 本文件现在 re-export provider/fs-provider.ts 的实现。
 * 原始实现已迁移到 src/core/provider/fs-provider.ts（CANONICAL）。
 * 此文件保留为向后兼容入口，标注 @deprecated。
 *
 * @deprecated 直接从 src/core/provider/fs-provider.ts 导入。
 */
export { fsProvider as fsLocalProvider } from '../../provider/fs-provider.ts'
export { LocalFileSystem } from './_local-impl'
