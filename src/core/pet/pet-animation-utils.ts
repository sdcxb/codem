/**
 * pet-animation-utils.ts — 宠物动画查找的纯函数。
 *
 * 从 pet-manager.ts 中提取，使宠物窗口的依赖链最小化。
 * PetSprite 只需要此函数，不需要 pet-manager 中的文件 I/O 和设置管理。
 */

import type { PetDefinition, PetState } from "./pet-types";

/**
 * 获取宠物在指定状态下的动画配置。
 * 如果该状态没有配置，回退到 idle 状态。
 */
export function getAnimationForState(
  definition: PetDefinition,
  state: PetState,
): PetDefinition["animations"][0] | null {
  const anim = definition.animations.find((a) => a.state === state);
  if (anim) return anim;

  // 回退到 idle
  const idle = definition.animations.find((a) => a.state === "idle");
  return idle || null;
}
