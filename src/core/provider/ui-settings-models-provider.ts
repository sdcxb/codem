// @ts-nocheck
/**
 * @codem/uiSettingsModels — UI Provider
 *
 * app.settings.models slot 已移除 — SettingsPanel 已通过 app.settings slot 消费。
 * 此 provider 仅保留 service 注册。
 *
 * ## 第 45 轮 D-15 修复：调用的方法在真实对象上都**不存在**
 *
 * `ctx.get('modelProfile')` 提供的是 `ModelProfileManager`
 * （`core/provider/model-profile-provider.ts:17`），其公开 API 只有
 * `getAll/getActiveProfile/getActiveProfileId/resolveSlot/setActiveProfile/createProfile/
 * updateProfile/deleteProfile/updateSlot`（`core/llm/model-profile.ts:175-308`）。
 *
 * 旧实现每个方法都用 `mp.list?` / `mp.add?` / `mp.remove?` / `mp.setDefault?` 的可选调用
 * —— 四个名字一个都不存在，于是 **`render()` 恒返回空列表、add/remove/setDefault 恒返回
 * 静默的"成功"值**（`return true`）却什么也没做。这是最坏的一种：调用方拿到的是成功。
 *
 * 现在映射到真实 API：`render` → `getAll()`、`addModel` → `createProfile()`、
 * `removeModel` → `deleteProfile()`、`setDefault` → `setActiveProfile()`；
 * 服务不可用时**如实返回失败**（不是伪造成功）。
 */
import type { Plugin } from '../cordis/src/index.ts'

export const uiSettingsModelsProvider: Plugin = (ctx: any) => {
  /** 取真实的 ModelProfileManager（不可用时返回 null） */
  const getManager = () => {
    const mp = ctx?.get?.('modelProfile')
    return mp && typeof mp.getAll === 'function' ? mp : null
  }

  const s = {
    render() {
      const mp = getManager()
      const profiles = mp ? mp.getAll() : []
      return { type: 'settings-models', models: profiles, available: !!mp }
    },
    async addModel(config) {
      const mp = getManager()
      if (!mp) return { ok: false, reason: 'modelProfile 服务不可用' }
      try {
        // `createProfile` 要的是完整档案（`slots` 必需，id/isBuiltIn 由它生成）
        const created = mp.createProfile({
          name: config?.name || config?.id || 'new-profile',
          description: config?.description || '',
          slots: {},
        })
        if (!created?.id) return { ok: false, reason: 'createProfile 未返回档案' }
        if (config?.model) {
          // 新档案的槽位配置：用真实存在的 updateSlot，并把 profileId 显式传进去（D-6 的教训）
          const wrote = mp.updateSlot('chat', { provider: config.provider || 'unknown', model: config.model }, created.id)
          if (wrote !== true) return { ok: false, reason: '槽位写入失败（档案可能是内置档案）', profile: created }
        }
        return { ok: true, profile: created }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
    async removeModel(id) {
      const mp = getManager()
      if (!mp) return { ok: false, reason: 'modelProfile 服务不可用' }
      try {
        return { ok: mp.deleteProfile(id) === true }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
    async setDefault(id) {
      const mp = getManager()
      if (!mp) return { ok: false, reason: 'modelProfile 服务不可用' }
      try {
        return { ok: mp.setActiveProfile(id) === true }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
  }

  const disp = ctx.provide('uiSettingsModels', s)

  return () => {
    if (disp) disp()
  }
}
