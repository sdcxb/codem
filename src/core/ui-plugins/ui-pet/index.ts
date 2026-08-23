// @ts-nocheck
/**
 * @codem/ui-pet — 宠物覆盖层 UI 插件
 *
 * 对标 DSH：组件同步导入，不用 React.lazy。
 */
import { PetOverlay } from '../../../components/PetOverlay'

export function applyUIPet(ctx: any) {
  const slots = ctx.get('slots')
  slots.register({ name: 'app.overlay', id: 'pet-overlay-skin', order: 100, priority: 50 }, PetOverlay)
  console.log('[ui-pet] Pet overlay registered')
}

export function apply(ctx: any) {
  applyUIPet(ctx)
}
