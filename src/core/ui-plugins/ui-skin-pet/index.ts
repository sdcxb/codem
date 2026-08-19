// @ts-nocheck
/**
 * @codem/skin-pet — 宠物皮肤插件
 *
 * 注册宠物皮肤配色变体（默认未激活）。
 * 可独立加载/卸载/热替换 — 用户可在设置中切换皮肤。
 */
export function applySkinPet() {
  console.log('[skin-pet] Pet skin registered (inactive by default)')
  // TODO: 宠物皮肤配色变体注册到 ThemeManager，供用户选择切换
}

export function apply(_ctx?: any) {
  applySkinPet()
}
