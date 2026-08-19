// @ts-nocheck
/**
 * @codem/ui-model-selection — 模型选择 UI 插件
 *
 * 对标 DSH packages/client/ui-model-selection/src/client/index.ts。
 * 注册 ModelSelector 组件到 Slot，同时提供模型选择服务。
 * 关闭此 Provider 后，Slot 中的组件被移除，SlotBridge 回退到 fallback。
 *
 * inject: ['slots', 'modelProfile'] — 框架保证依赖可用后才执行。
 */
import { lazy } from 'react'
import type { Plugin } from '../cordis/src/index.ts'

const ModelSelector = lazy(() => import('../../components/ModelSelector'))

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

export const uiModelSelectionProvider: Plugin = Object.assign(
  (ctx: any) => {
    const service = new ModelSelectionService()

    // 从 modelProfile 服务加载模型列表 — inject 保证 modelProfile 可用
    try {
      const modelProfile = ctx.get('modelProfile')
      if (modelProfile) {
        const profiles = modelProfile.listProfiles?.() || []
        const models = profiles.map((p: any) => ({
          id: p.id,
          name: p.name,
          provider: p.provider,
          contextWindow: p.contextWindow,
        }))
        service.setAvailableModels(models)
      }
    } catch (e) { console.warn('[ui-model-selection-provider.ts]', e) }

    const dispose = ctx.provide('uiModelSelection', {
      setAvailableModels: (models: any) => service.setAvailableModels(models),
      getAvailableModels: () => service.getAvailableModels(),
      selectModel: (modelId: string) => service.selectModel(modelId),
      getCurrentModel: () => service.getCurrentModel(),
      subscribe: (listener: any) => service.subscribe(listener),
    })

    // Register React component to Slot — inject 保证 slots 可用
    const slots = ctx.get('slots')
    const unreg = slots.register({ name: 'app.model-selector', id: 'r8-modelselector', priority: 5 }, ModelSelector)

    // 使用 slots.inject 声明消费依赖：conversation.composer.bar 存在时注册
    const injectUnreg = slots.inject('conversation.composer.bar', () =>
      slots.register({ name: 'conversation.composer.bar', id: 'r8-modelselector-sub', priority: 5 }, ModelSelector)
    )

    return () => {
      if (dispose) dispose()
      unreg()
      injectUnreg()
    }
  },
  { inject: ['slots', 'modelProfile'] }
)
