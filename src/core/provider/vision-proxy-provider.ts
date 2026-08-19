// @ts-nocheck
/**
 * Vision Proxy Provider 插件 — 包装真实 VisionProxy 并接入 ctx。
 *
 * 真实实现源：src/core/llm/vision-proxy.ts（VisionProxy 类 + getVisionProxy()）
 *
 * 接入点：
 * - AgenticLoop 通过 ctx.get('visionProxy') 获取视觉代理
 * - 替代直接 import { getVisionProxy }
 */
import type { Plugin } from '../cordis/src/index.ts'
import { VisionProxy, getVisionProxy } from '../llm/vision-proxy.ts'

export const visionProxyProvider: Plugin = (ctx: any) => {
  const proxy = getVisionProxy()

  const dispose = ctx.provide('visionProxy', {
    _active: true,
    async analyzeImage(imageData: string, prompt?: string): Promise<string> {
      return proxy.analyze(imageData, prompt)
    },
    async analyzeImages(images: string[], prompt?: string): Promise<string> {
      return proxy.analyzeMultiple(images, prompt)
    },
    isAvailable(): boolean {
      return proxy.isAvailable()
    },
  })

  // Composite dispose — stop underlying proxy to eliminate double-track
  const compositeDispose = () => {
    if (proxy.dispose) proxy.dispose()
    dispose()
  }
  return compositeDispose
}
