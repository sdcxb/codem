/**
 * StockSystem — 股票系统
 * 管理股票价格波动、买卖交易、分红
 */

import type { StockDef } from "../types";
import type { Player } from "./Player";

export interface StockPrice {
  id: number;
  name: string;
  code: string;
  price: number;
  prevPrice: number;
  volatility: number;
}

export interface StockTransaction {
  success: boolean;
  message: string;
}

export class StockSystem {
  private stocks: StockDef[];
  private prices: Map<number, StockPrice> = new Map();
  private playerHoldings: Map<number, Map<number, { amount: number; avgCost: number }>> = new Map();
  private priceIndex: number = 1000;

  constructor(stocks: StockDef[]) {
    this.stocks = stocks;
    for (const s of stocks) {
      this.prices.set(s.id, {
        id: s.id,
        name: s.name,
        code: s.code,
        price: s.initPrice,
        prevPrice: s.initPrice,
        volatility: s.volatility,
      });
    }
  }

  updatePriceIndex(index: number): void {
    this.priceIndex = Math.max(200, index);
  }

  /** 获取所有股票价格 */
  getAllPrices(): StockPrice[] {
    return Array.from(this.prices.values());
  }

  /** 获取单只股票价格 */
  getPrice(stockId: number): number {
    return this.prices.get(stockId)?.price || 0;
  }

  /** 获取玩家持仓 */
  getHoldings(playerId: number): { stockId: number; amount: number; avgCost: number }[] {
    const holdings = this.playerHoldings.get(playerId);
    if (!holdings) return [];
    return Array.from(holdings.entries()).map(([stockId, data]) => ({
      stockId,
      amount: data.amount,
      avgCost: data.avgCost,
    }));
  }

  /** 买入股票 */
  buy(player: Player, stockId: number, amount: number): StockTransaction {
    const stock = this.prices.get(stockId);
    if (!stock) return { success: false, message: "股票不存在" };
    if (amount <= 0) return { success: false, message: "数量必须大于0" };

    const cost = stock.price * amount;
    const fee = Math.floor(cost * 0.01); // 1% 手续费
    const total = cost + fee;

    if (!player.spendMoney(total)) {
      return { success: false, message: `现金不足，需要 ${total}（含手续费 ${fee}）` };
    }

    // 更新持仓
    if (!this.playerHoldings.has(player.id)) {
      this.playerHoldings.set(player.id, new Map());
    }
    const holdings = this.playerHoldings.get(player.id)!;
    const existing = holdings.get(stockId);
    if (existing) {
      const totalAmount = existing.amount + amount;
      const totalCost = existing.avgCost * existing.amount + cost;
      holdings.set(stockId, { amount: totalAmount, avgCost: totalCost / totalAmount });
    } else {
      holdings.set(stockId, { amount, avgCost: stock.price });
    }

    return { success: true, message: `${player.name} 买入 ${stock.name} ${amount}股，花费 ${total}` };
  }

  /** 卖出股票 */
  sell(player: Player, stockId: number, amount: number): StockTransaction {
    const stock = this.prices.get(stockId);
    if (!stock) return { success: false, message: "股票不存在" };
    if (amount <= 0) return { success: false, message: "数量必须大于0" };

    if (!this.playerHoldings.has(player.id)) {
      return { success: false, message: "你没有该股票" };
    }
    const holdings = this.playerHoldings.get(player.id)!;
    const existing = holdings.get(stockId);
    if (!existing || existing.amount < amount) {
      return { success: false, message: `持仓不足（${existing?.amount || 0}股）` };
    }

    const revenue = stock.price * amount;
    const fee = Math.floor(revenue * 0.01);
    const netRevenue = revenue - fee;

    player.addMoney(netRevenue);
    existing.amount -= amount;
    if (existing.amount <= 0) {
      holdings.delete(stockId);
    }

    return { success: true, message: `${player.name} 卖出 ${stock.name} ${amount}股，收入 ${netRevenue}（手续费 ${fee}）` };
  }

  /** 每回合更新股价 */
  updatePrices(): void {
    for (const [id, stock] of this.prices) {
      stock.prevPrice = stock.price;

      // 基础波动：±(volatility × 10)%
      const baseChange = (Math.random() - 0.45) * stock.volatility * 0.1;
      // 物价指数影响：高物价 → 股价微涨
      const indexEffect = (this.priceIndex - 1000) / 10000;
      const totalChange = baseChange + indexEffect;

      let newPrice = Math.floor(stock.price * (1 + totalChange));
      newPrice = Math.max(1, newPrice);

      stock.price = newPrice;
    }
  }

  /** 股票暴涨 */
  boom(percent: number): void {
    for (const stock of this.prices.values()) {
      stock.prevPrice = stock.price;
      stock.price = Math.floor(stock.price * (1 + percent / 100));
    }
  }

  /** 股票暴跌 */
  crash(percent: number): void {
    for (const stock of this.prices.values()) {
      stock.prevPrice = stock.price;
      stock.price = Math.max(1, Math.floor(stock.price * (1 - percent / 100)));
    }
  }

  /** 计算分红（命运事件用） */
  calculateDividends(playerId: number): number {
    const holdings = this.playerHoldings.get(playerId);
    if (!holdings) return 0;
    let total = 0;
    for (const [stockId, data] of holdings) {
      const stock = this.prices.get(stockId);
      if (stock) {
        total += Math.floor(data.amount * stock.price * 0.1); // 10%分红
      }
    }
    return total;
  }

  /** 计算玩家股票总市值 */
  getPortfolioValue(playerId: number): number {
    const holdings = this.playerHoldings.get(playerId);
    if (!holdings) return 0;
    let total = 0;
    for (const [stockId, data] of holdings) {
      const stock = this.prices.get(stockId);
      if (stock) total += data.amount * stock.price;
    }
    return total;
  }

  /** 清算玩家所有股票（破产时用） */
  liquidate(player: Player): number {
    const holdings = this.playerHoldings.get(player.id);
    if (!holdings) return 0;
    let total = 0;
    for (const [stockId, data] of holdings) {
      const stock = this.prices.get(stockId);
      if (stock) {
        const revenue = stock.price * data.amount;
        const fee = Math.floor(revenue * 0.01);
        total += revenue - fee;
      }
    }
    holdings.clear();
    return total;
  }
}
