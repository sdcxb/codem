/**
 * Pet Module — 桌面宠物系统。
 *
 * 基于 Petdex (MIT) 的宠物包格式，适配 Codem 的 Agent 事件模型。
 *
 * 模块组成：
 * - pet-types.ts:   类型定义
 * - pet-manager.ts: 安装/卸载/列表管理
 * - pet-market-client.ts: Petdex 市场客户端
 * - pet-store.ts:   运行时状态管理（Zustand）
 *
 * UI 组件（在 src/components/ 下）：
 * - PetSprite.tsx:       精灵图渲染
 * - PetOverlay.tsx:      浮窗容器
 * - PetMarketDialog.tsx: 市场浏览对话框
 */

// Types
export type { PetState, PetAnimationFrame, PetDefinition, MarketPet, InstalledPet, PetSettings } from "./pet-types";
export { ALL_PET_STATES, DEFAULT_PET_SETTINGS } from "./pet-types";

// Manager
export {
  getPetSettings,
  savePetSettings,
  parsePetJson,
  installPet,
  uninstallPet,
  listInstalledPets,
  getInstalledPet,
  isPetInstalled,
  loadSpritesheetAsDataUrl,
  loadInstalledPets,
  getAnimationForState,
} from "./pet-manager";

// Market Client
export {
  listMarketPets,
  installMarketPet,
  isMarketPetInstalled,
} from "./pet-market-client";

// Store
export { usePetStore } from "./pet-store";
