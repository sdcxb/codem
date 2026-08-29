/**
 * Monopoly Game Plugin — 插件入口
 * 导出 GameView 组件，可由 App 通过 SlotBridge 或直接导入使用
 */

export { GameView } from "./components/GameView";
export { GameEngine } from "./engine/GameEngine";
export { Dice } from "./engine/Dice";
export { Player } from "./engine/Player";
export { Property } from "./engine/Property";
export { CardSystem } from "./engine/CardSystem";
export { ToolSystem } from "./engine/ToolSystem";
export { ShopSystem } from "./engine/ShopSystem";
export { AuctionSystem } from "./engine/AuctionSystem";
export { FacilitySystem } from "./engine/FacilitySystem";
export { FortuneSystem } from "./engine/FortuneSystem";
export { StockSystem } from "./engine/StockSystem";
export { BankruptcySystem } from "./engine/BankruptcySystem";
export { AIPlayer } from "./engine/AIPlayer";

// 类型导出
export type {
  GameBoardMap,
  MapNode,
  LandTile,
  FacilityTile,
  CommercialTile,
  PlayerState,
  GameConfig,
  GamePhase,
  HUDState,
  CardDef,
  ToolDef,
  FortuneEvent,
  StockDef,
  CharacterDef,
} from "./types";
