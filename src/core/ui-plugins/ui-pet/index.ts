// @ts-nocheck
/**
 * @codem/ui-pet — 宠物覆盖层 UI 插件
 *
 * 将宠物覆盖层组件注册到 app.overlay 槽位。
 * 可独立加载/卸载/热替换 — 不影响默认皮肤和其他 UI 组件。
 */
import { lazy } from 'react'
import { useCtx } from '../../consumer/index.ts'

export function applyUIPet() {
  const ctx = useCtx()
  const PetOverlay = lazy(() => import('../../../components/PetOverlay'))
  ctx.slots.register({ name: 'app.overlay', id: 'pet-overlay-skin', order: 100, priority: 50 }, PetOverlay)
  console.log('[ui-pet] Pet overlay registered')
}

export function apply() {
  applyUIPet()
}
