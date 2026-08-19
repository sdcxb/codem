// @ts-nocheck
/**
 * @codem/cordis-host-runner — Self-Referential Runtime Provider
 *
 * P2-2/F3: 消除架构级重复 — 本文件现在 re-export provider/dynamic-runner-provider.ts 的实现。
 * 原始实现已迁移到 src/core/provider/dynamic-runner-provider.ts（CANONICAL）。
 * 此文件保留为向后兼容入口，标注 @deprecated。
 *
 * @deprecated 直接从 src/core/provider/dynamic-runner-provider.ts 导入。
 */
export { dynamicRunnerProvider, HostCordisRunner } from '../../provider/dynamic-runner-provider.ts'
