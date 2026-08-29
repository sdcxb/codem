// @ts-nocheck
/**
 * @codem/ui-pet — 宠物服务 Provider
 *
 * Cordis 插件化架构：通过 ctx.provide('pet', service) 注册宠物服务。
 * 独立窗口宠物的创建/销毁/状态同步/事件监听全部通过此 provider 管理。
 *
 * 对标 DSH：provider 模式，ctx.provide + ctx.get 服务注册。
 *
 * 宠物服务接口：
 * - init()                     — 初始化（加载设置、创建窗口）
 * - showBubble(msg, duration)  — 显示气泡通知
 * - showRawBubble(msg, duration) — 显示原始气泡（不带称呼前缀）
 * - setPetState(state)         — 设置宠物状态
 * - onLLMStatus(status)        — 处理 LLM 状态变化
 * - onStreamEvent(event)       — 处理流式事件
 * - setEnabled(enabled)         — 启用/禁用宠物
 * - setActivePet(slug)          — 切换宠物
 * - getState()                 — 获取当前状态快照
 */

import type { Plugin } from '../cordis/src/index.ts'
import { usePetStore } from '../pet/pet-store'
import type { PetState } from '../pet/pet-types'

export const uiPetProvider: Plugin = Object.assign(
  (ctx: any) => {
    const store = usePetStore

    /** 宠物服务 — 封装 usePetStore 的所有操作 */
    const petService = {
      /** 初始化宠物系统 */
      async init() {
        return store.getState().init()
      },

      /** 显示气泡通知（带用户称呼前缀） */
      showBubble(message: string, duration: number = 4000) {
        const s = store.getState()
        if (!s.enabled) return
        s.showBubble(message, duration)
      },

      /** 显示原始气泡通知（不带称呼前缀） */
      showRawBubble(text: string, duration: number = 4000) {
        const s = store.getState()
        if (!s.enabled) return
        s.showRawBubble(text, duration)
      },

      /** 设置宠物状态 */
      setPetState(state: PetState) {
        store.getState().setPetState(state)
      },

      /** 处理 LLM 状态变化 */
      onLLMStatus(status: string) {
        store.getState().onLLMStatus(status as any)
      },

      /** 处理流式事件 */
      onStreamEvent(event: any) {
        store.getState().onStreamEvent(event)
      },

      /** 启用/禁用宠物 */
      setEnabled(enabled: boolean) {
        store.getState().setEnabled(enabled)
      },

      /** 切换宠物 */
      async setActivePet(slug: string | null) {
        return store.getState().setActivePet(slug)
      },

      /** 获取当前状态快照 */
      getState() {
        return store.getState()
      },

      /** 宠物是否已启用 */
      get enabled() {
        return store.getState().enabled
      },
    }

    // 注册到 Cordis 服务容器 — 其他模块通过 ctx.get('pet') 获取
    const disp = ctx.provide('pet', petService)

    console.log('[ui-pet] Pet service provider registered (Cordis ctx.provide)')

    return () => {
      if (disp) disp()
    }
  },
  { inject: [] }
)
