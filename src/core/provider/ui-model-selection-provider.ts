// @ts-nocheck
/**
 * @codem/ui-model-selection — 模型选择 UI 插件
 *
 * 对标 DSH packages/client/ui-model-selection/src/client/index.ts。
 * 注册 ModelSelector 组件到 Slot，同时提供模型选择服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots', 'modelProfile'] — 框架保证依赖可用后才执行。
 *
 * ## 第 45 轮 D-15 修复：三个"接上就静默出错"的坑
 *
 * 1. 旧实现调用 `modelProfile.listProfiles?.()` —— `modelProfile` 服务提供的是
 *    `ModelProfileManager`（`core/provider/model-profile-provider.ts:17`），
 *    它的公开 API 只有 `getAll/getActiveProfile/getActiveProfileId/resolveSlot/
 *    setActiveProfile/createProfile/updateProfile/deleteProfile/updateSlot`。
 *    `listProfiles?.()` 永远返回 `undefined` ⇒ `|| []` ⇒ 模型列表恒为空（且因为
 *    可选调用，连报错都没有）。现在改成 `getAll()`（真实存在的方法）。
 * 2. `app.model-selector` slot **没有任何 `<SlotBridge name="app.model-selector">` 出口**
 *    （只在 `declare-slots.ts:133` 声明、在两个 provider 里注册）—— 注册得再对也不会渲染。
 *    这里不再注册这个"无出口"的 slot（声明与注册是死代码，见同名报告 D-15）。
 * 3. `conversation.composer.bar` 是有出口的（`ConversationComposer.tsx:48` 的
 *    `SlotListBridge`），会渲染这个组件 —— 所以 `ModelSelector` 必须能**空 props 渲染**
 *    （已在组件侧修好）。
 */
import type { Plugin } from '../cordis/src/index.ts'
import { ModelSelector } from '../../components/ModelSelector'

class ModelSelectionService {
  private currentModel: string | null = null
  private availableModels: Array<{ id: string; name: string; provider: string; contextWindow?: number }> = []
  private listeners: Array<(model: string | null) => void> = []

  setAvailableModels(models: Array<{ id: string; name: string; provider: string; contextWindow?: number }>) {
    this.availableModels = models
    if (this.currentModel && !models.find(m => m.id === this.currentModel)) {
      this.currentModel = models[0]?.id || null
      this.notify()
    }
  }

  getAvailableModels() { return this.availableModels }

  selectModel(modelId: string) {
    if (this.availableModels.find(m => m.id === modelId)) {
      this.currentModel = modelId
      this.notify()
    }
  }

  getCurrentModel() { return this.currentModel }

  subscribe(listener: (model: string | null) => void) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private notify() {
    this.listeners.forEach(l => {
      try { l(this.currentModel) } catch (e) { console.warn('[ui-model-selection-provider.ts]', e) }
    })
  }
}

/**
 * 从 `ModelProfileManager` 的档案槽位里抽出"可用模型"（D-15：方法名必须是真实存在的）。
 * 导出供测试直接验证"服务读到的 ≠ 空"。
 */
export function collectModelsFromProfiles(profiles: any[]): Array<{ id: string; name: string; provider: string }> {
  const models: Array<{ id: string; name: string; provider: string }> = []
  const seen = new Set<string>()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile?.slots) continue
    for (const slot of Object.values(profile.slots)) {
      const cfg = slot as { model?: string; provider?: string } | null
      if (cfg?.model && !seen.has(cfg.model)) {
        seen.add(cfg.model)
        models.push({ id: cfg.model, name: cfg.model, provider: cfg.provider || 'unknown' })
      }
    }
  }
  return models
}

export const uiModelSelectionProvider: Plugin = Object.assign(
  (ctx: any) => {
    const service = new ModelSelectionService()

    // 从 modelProfile 服务加载模型列表 — inject 保证 modelProfile 可用
    try {
      const modelProfile = ctx.get('modelProfile')
      if (modelProfile) {
        // D-15：真实 API 是 getAll()（旧写法 listProfiles?.() 永远 undefined）
        const profiles = typeof modelProfile.getAll === 'function' ? modelProfile.getAll() : []
        service.setAvailableModels(collectModelsFromProfiles(profiles))
      }
    } catch (e) { console.warn('[ui-model-selection-provider.ts]', e) }

    const dispose = ctx.provide('uiModelSelection', {
      setAvailableModels: (models: any) => service.setAvailableModels(models),
      getAvailableModels: () => service.getAvailableModels(),
      selectModel: (modelId: string) => service.selectModel(modelId),
      getCurrentModel: () => service.getCurrentModel(),
      subscribe: (listener: any) => service.subscribe(listener),
    })

    // 第 45 轮 D-15：这里**不再注册 `app.model-selector`** —— 那个 slot 全仓没有出口
    // （`git grep "<SlotBridge name=\"app.model-selector\""` 零命中），注册只是在假装有 UI。
    // 有出口的 `conversation.composer.bar` 保留注册（SlotListBridge 会渲染，组件已能空 props 渲染）。
    const slots = ctx.get('slots')

    // 使用 slots.inject 声明消费依赖：conversation.composer.bar 存在时注册
    const injectUnreg = slots.inject('conversation.composer.bar', () =>
      slots.register({ name: 'conversation.composer.bar', id: 'r8-modelselector-sub', priority: 5 }, ModelSelector)
    )

    return () => {
      if (dispose) dispose()
      injectUnreg()
    }
  },
  { inject: ['slots', 'modelProfile'] }
)
