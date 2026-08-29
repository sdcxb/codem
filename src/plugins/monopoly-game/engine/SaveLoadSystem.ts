/**
 * SaveLoadSystem — 存档读档系统
 * 比照《大富翁4》的存档机制：
 *   - 支持多个存档槽位（最多3个）
 *   - 使用 localStorage 持久化
 *   - 保存/恢复 GameEngine 完整状态（玩家、地产、股票、物价、回合数等）
 */

import type { GameBoardMap, GameConfig, StockDef, PlayerState, LandTile } from "../types";

/** 存档数据结构 */
export interface SaveData {
  version: string;            // 存档版本
  timestamp: number;          // 保存时间戳
  saveName: string;           // 存档名称
  mapId: string;              // 地图ID（用于加载正确地图）
  // —— 引擎核心状态 ——
  round: number;
  totalRounds: number;
  date: number;
  priceIndex: number;
  phase: string;
  currentPlayerIdx: number;
  humanCharId: number;
  pendingMoveSteps: number;
  diceValues: number[];
  message: string;
  log: string[];
  logColors: string[];
  winningMultiplier: number;
  // —— 玩家状态 ——
  players: PlayerState[];
  // —— 地产运行时状态 ——
  lands: LandTile[];
  // —— 股票价格 ——
  stockPrices: { id: number; price: number; prevPrice: number; }[];
  // —— 玩家股票持仓 ——
  playerStocks: { playerId: number; holdings: { stockId: number; amount: number; avgCost: number; }[]; }[];
  // —— 放置在地图上的道具 ——
  placedTools: { toolId: number; nodeId: number; ownerId: number; timer?: number; }[];
}

/** 存档槽位信息 */
export interface SaveSlotInfo {
  slot: number;
  saveName: string;
  timestamp: number;
  round: number;
  mapName: string;
  playerCount: number;
  isEmpty: boolean;
}

const SAVE_PREFIX = "monopoly_save_";
const SAVE_VERSION = "1.0.0";
const MAX_SLOTS = 3;

export class SaveLoadSystem {
  /**
   * 保存游戏状态到指定槽位
   * @returns 保存成功返回 true
   */
  static save(slot: number, data: SaveData): boolean {
    try {
      const key = `${SAVE_PREFIX}${slot}`;
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error("[SaveLoad] 保存失败:", e);
      return false;
    }
  }

  /**
   * 从指定槽位加载游戏状态
   * @returns 存档数据，不存在返回 null
   */
  static load(slot: number): SaveData | null {
    try {
      const key = `${SAVE_PREFIX}${slot}`;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw) as SaveData;
      if (data.version !== SAVE_VERSION) {
        console.warn(`[SaveLoad] 存档版本不匹配: ${data.version} vs ${SAVE_VERSION}`);
      }
      return data;
    } catch (e) {
      console.error("[SaveLoad] 读取失败:", e);
      return null;
    }
  }

  /** 删除指定槽位的存档 */
  static deleteSave(slot: number): boolean {
    try {
      localStorage.removeItem(`${SAVE_PREFIX}${slot}`);
      return true;
    } catch {
      return false;
    }
  }

  /** 获取所有存档槽位信息 */
  static getSlotInfos(): SaveSlotInfo[] {
    const slots: SaveSlotInfo[] = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const data = this.load(i);
      if (data) {
        slots.push({
          slot: i,
          saveName: data.saveName,
          timestamp: data.timestamp,
          round: data.round,
          mapName: data.mapId,
          playerCount: data.players.length,
          isEmpty: false,
        });
      } else {
        slots.push({
          slot: i,
          saveName: "",
          timestamp: 0,
          round: 0,
          mapName: "",
          playerCount: 0,
          isEmpty: true,
        });
      }
    }
    return slots;
  }

  /** 检查是否有存档 */
  static hasSaves(): boolean {
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (this.load(i)) return true;
    }
    return false;
  }

  /** 获取最大槽位数 */
  static getMaxSlots(): number {
    return MAX_SLOTS;
  }

  /** 获取存档版本 */
  static getVersion(): string {
    return SAVE_VERSION;
  }
}
