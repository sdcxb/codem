/**
 * AuctionSystem — 拍卖系统
 * 管理地产拍卖流程：起拍价、竞价、成交
 */

import type { GameEvent } from "../types";
import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";

export interface AuctionState {
  landIndex: number;
  landName: string;
  basePrice: number;
  currentBid: number;
  currentBidder: number | null; // player id
  participants: number[]; // player ids
  round: number;
  maxRounds: number;
  active: boolean;
}

export interface AuctionBidResult {
  success: boolean;
  message: string;
  newBid?: number;
}

export class AuctionSystem {
  private state: AuctionState | null = null;
  private priceIndex: number = 1000;

  /** 更新物价指数 */
  updatePriceIndex(index: number): void {
    this.priceIndex = Math.max(200, index);
  }

  /** 开始拍卖 */
  startAuction(
    engine: GameEngine,
    landIndex: number,
    participants: number[]
  ): AuctionState | null {
    const property = engine.getProperty();
    const land = property.getLand(landIndex);
    if (!land) return null;

    // 起拍价 = 地价 × 物价系数
    const basePrice = Math.floor(land.landPrice * (this.priceIndex / 1000));

    this.state = {
      landIndex,
      landName: land.name,
      basePrice,
      currentBid: basePrice,
      currentBidder: null,
      participants: [...participants],
      round: 0,
      maxRounds: 3, // 3轮竞价
      active: true,
    };

    return this.state;
  }

  /** 竞价 */
  bid(engine: GameEngine, playerId: number, amount: number): AuctionBidResult {
    if (!this.state || !this.state.active) {
      return { success: false, message: "没有进行中的拍卖" };
    }

    const player = engine.getPlayers().find(p => p.id === playerId);
    if (!player) return { success: false, message: "玩家不存在" };

    if (!this.state.participants.includes(playerId)) {
      return { success: false, message: "你不在此拍卖中" };
    }

    if (amount <= this.state.currentBid) {
      return { success: false, message: `出价必须高于当前最高价 ${this.state.currentBid}` };
    }

    if (!player.spendMoney(amount)) {
      return { success: false, message: `现金不足，需要 ${amount}` };
    }

    // 退还原上一位竞价者的钱
    if (this.state.currentBidder !== null) {
      const prevBidder = engine.getPlayers().find(p => p.id === this.state!.currentBidder);
      if (prevBidder) {
        prevBidder.addMoney(this.state!.currentBid);
      }
    }

    this.state.currentBid = amount;
    this.state.currentBidder = playerId;

    return {
      success: true,
      message: `${player.name} 出价 ${amount}`,
      newBid: amount,
    };
  }

  /** 玩家放弃竞价 */
  pass(playerId: number): AuctionBidResult {
    if (!this.state || !this.state.active) {
      return { success: false, message: "没有进行中的拍卖" };
    }

    const idx = this.state.participants.indexOf(playerId);
    if (idx < 0) return { success: false, message: "你不在此拍卖中" };

    this.state.participants.splice(idx, 1);
    const player = playerId; // 简化
    return { success: true, message: `玩家${player}放弃竞价` };
  }

  /** 推进拍卖回合 */
  advanceRound(engine: GameEngine): { finished: boolean; event?: GameEvent } {
    if (!this.state || !this.state.active) {
      return { finished: true };
    }

    this.state.round++;

    // 检查是否结束
    const remaining = this.state.participants.filter(id => {
      const p = engine.getPlayers().find(pl => pl.id === id);
      return p && p.cash > this.state!.currentBid;
    });

    if (this.state.round >= this.state.maxRounds || remaining.length <= 1 || this.state.participants.length <= 1) {
      return { finished: true, event: this.finishAuction(engine) };
    }

    return { finished: false };
  }

  /** 结束拍卖 */
  private finishAuction(engine: GameEngine): GameEvent {
    if (!this.state) return { type: "auction_error" };

    this.state.active = false;

    if (this.state.currentBidder !== null) {
      const winner = engine.getPlayers().find(p => p.id === this.state!.currentBidder);
      const property = engine.getProperty();
      const land = property.getLand(this.state.landIndex);

      if (winner && land) {
        // 如果地块原来有主人，先移除
        const oldOwner = land.owner ?? -1;
        if (oldOwner >= 0) {
          const oldPlayer = engine.getPlayers()[oldOwner];
          if (oldPlayer) {
            oldPlayer.properties = oldPlayer.properties.filter(p => p !== this.state!.landIndex);
            // 拍卖所得给原主人
            oldPlayer.addMoney(this.state.currentBid);
          }
        }

        // 转移给赢家
        property.buyLand(this.state.landIndex, winner.id);
        winner.properties.push(this.state.landIndex);

        const event: GameEvent = {
          type: "auction_finished",
          data: {
            landIndex: this.state.landIndex,
            landName: this.state.landName,
            winnerId: winner.id,
            winnerName: winner.name,
            price: this.state.currentBid,
          },
        };

        this.state = null;
        return event;
      }
    }

    // 无人竞拍
    const event: GameEvent = {
      type: "auction_finished",
      data: {
        landIndex: this.state.landIndex,
        landName: this.state.landName,
        winnerId: null,
        winnerName: null,
        price: 0,
      },
    };

    this.state = null;
    return event;
  }

  /** 获取当前拍卖状态 */
  getState(): AuctionState | null {
    return this.state;
  }

  /** 是否有进行中的拍卖 */
  isActive(): boolean {
    return this.state?.active ?? false;
  }

  /** 取消拍卖 */
  cancel(engine: GameEngine): void {
    if (!this.state) return;
    // 退钱
    if (this.state.currentBidder !== null) {
      const bidder = engine.getPlayers().find(p => p.id === this.state!.currentBidder);
      if (bidder) bidder.addMoney(this.state.currentBid);
    }
    this.state = null;
  }
}
