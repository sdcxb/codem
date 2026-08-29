/**
 * Property — 地产/地块管理
 * 管理地块购买、升级、降级、查封、过路费计算
 */

import type { LandTile, CommercialTile } from "../types";

export class Property {
  private lands: LandTile[];
  private commercials: CommercialTile[];

  constructor(lands: LandTile[], commercials: CommercialTile[] = []) {
    this.lands = lands.map(l => ({
      ...l,
      owner: -1,
      level: 0,
      tmpState: "none",
      expiredDate: 0,
    }));
    this.commercials = commercials.map(c => ({
      ...c,
      owner: -1,
      level: 0,
    }));
  }

  /** 获取地块信息 */
  getLand(index: number): LandTile | undefined {
    return this.lands[index];
  }

  /** 获取所有地块 */
  getAllLands(): LandTile[] {
    return this.lands;
  }

  /** 获取商业地块 */
  getCommercial(index: number): CommercialTile | undefined {
    return this.commercials[index];
  }

  /** 购买地块 */
  buyLand(index: number, playerId: number): boolean {
    const land = this.lands[index];
    if (!land || land.owner !== -1) return false;
    land.owner = playerId;
    land.level = 0;
    return true;
  }

  /** 升级地块（最高3级：房屋→酒店→摩天楼） */
  upgradeLand(index: number): boolean {
    const land = this.lands[index];
    if (!land || land.owner === -1) return false;
    if (land.level! >= land.maxLevel) return false;
    land.level!++;
    return true;
  }

  /** 降级地块 */
  downgradeLand(index: number): boolean {
    const land = this.lands[index];
    if (!land || land.owner === -1) return false;
    if (land.level! <= 0) return false;
    land.level!--;
    return true;
  }

  /** 查封地块 */
  sealLand(index: number, expiredDate: number): boolean {
    const land = this.lands[index];
    if (!land) return false;
    land.tmpState = "sealed";
    land.expiredDate = expiredDate;
    return true;
  }

  /** 价格上涨标记 */
  markPriceUp(index: number, expiredDate: number): boolean {
    const land = this.lands[index];
    if (!land) return false;
    land.tmpState = "price_up";
    land.expiredDate = expiredDate;
    return true;
  }

  /** 清除地块所有权（破产变卖用） */
  clearLand(index: number): boolean {
    const land = this.lands[index];
    if (!land) return false;
    land.owner = -1;
    land.level = 0;
    land.tmpState = "none";
    land.expiredDate = 0;
    land.isChainStore = false;
    return true;
  }

  /** 清除临时状态 */
  clearTmpState(index: number): void {
    const land = this.lands[index];
    if (land) {
      land.tmpState = "none";
      land.expiredDate = 0;
    }
  }

  /** 检查临时状态是否过期 */
  tickTmpStates(currentDate: number): void {
    for (const land of this.lands) {
      if (land.tmpState !== "none" && land.expiredDate && land.expiredDate <= currentDate) {
        land.tmpState = "none";
        land.expiredDate = 0;
      }
    }
  }

  /** 计算过路费 */
  getToll(index: number, diceSum: number = 0, isChainStore: boolean = false): number {
    const land = this.lands[index];
    if (!land || land.owner === -1) return 0;
    if (land.tmpState === "sealed") return 0;

    let toll = land.tolls[land.level!] || 0;

    // 连锁店倍率（从 land 自身读取）
    if (land.isChainStore || isChainStore) {
      toll *= 2;
    }

    // 价格上涨
    if (land.tmpState === "price_up") {
      toll *= 2;
    }

    // 计算该玩家拥有的相邻连锁店数量加成
    if (land.isChainStore) {
      const owner = land.owner ?? -1;
      if (owner >= 0) {
        // 计算同主人的连锁店总数，每块额外+10%
        let chainCount = 0;
        for (const l of this.lands) {
          if (l.isChainStore && l.owner === owner) chainCount++;
        }
        if (chainCount > 1) {
          toll *= (1 + (chainCount - 1) * 0.1);
        }
      }
    }

    return Math.floor(toll);
  }

  /** 获取地块价值（用于计算总资产） */
  getLandValue(index: number): number {
    const land = this.lands[index];
    if (!land) return 0;
    let value = land.landPrice;
    for (let i = 0; i < (land.level || 0); i++) {
      value += land.buildPrice;
    }
    return value;
  }

  /** 获取玩家所有地块索引 */
  getPlayerLands(playerId: number): number[] {
    const result: number[] = [];
    this.lands.forEach((land, idx) => {
      if (land.owner === playerId) result.push(idx);
    });
    return result;
  }

  /** 获取玩家地产总价值 */
  getPlayerLandValue(playerId: number): number {
    return this.getPlayerLands(playerId)
      .reduce((sum, idx) => sum + this.getLandValue(idx), 0);
  }

  /** 没收玩家所有地块（破产时） */
  confiscatePlayerLands(playerId: number): void {
    for (const land of this.lands) {
      if (land.owner === playerId) {
        land.owner = -1;
        land.level = 0;
        land.tmpState = "none";
        land.expiredDate = 0;
      }
    }
  }

  /** 获取地块数量 */
  get landCount(): number {
    return this.lands.length;
  }

  /** 获取商业地块数量 */
  get commercialCount(): number {
    return this.commercials.length;
  }
}
