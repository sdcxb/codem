// @ts-nocheck
/**
 * Vision Proxy Provider 插件 — 直接暴露 VisionProxy 实例到 ctx。
 *
 * 真实实现源：src/core/llm/vision-proxy.ts（VisionProxy 类 + getVisionProxy()）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('visionProxy') 获取视觉代理
 * - 替代直接 import { getVisionProxy }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { getVisionProxy } from '../llm/vision-proxy.ts'

export const visionProxyProvider: Plugin = (ctx: any) => {
  const proxy = getVisionProxy()

  // 直接暴露实例 — 与 DSH 模式一致
  const dispose = ctx.provide('visionProxy', proxy)

  return dispose
}
