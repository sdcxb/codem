/**
 * BankruptcySystem — 破产清算系统
 * 按顺序变卖资产：地产→股票→卡牌→道具→存款
 * 变卖所得直接加入现金，然后扣除债务
 */

import type { GameEvent } from "../types";
import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";

export interface BankruptcyResult {
  liquidated: boolean;
  amountRaised: number;
  message: string;
  events?: GameEvent[];
}

export class BankruptcySystem {
  /** 检查并执行破产清算 */
  checkBankruptcy(engine: GameEngine, player: Player, debtAmount: number): BankruptcyResult {
    // 如果现金足够，不需要清算
    if (player.cash >= debtAmount) {
      return { liquidated: false, amountRaised: 0, message: "无需清算" };
    }

    let raised = 0;
    const messages: string[] = [];
    const events: GameEvent[] = [];
    const property = engine.getProperty();

    // 1. 变卖地产 — 变卖所得直接加入现金
    for (const landIdx of [...player.properties]) {
      if (player.cash + raised >= debtAmount) break;
      const land = property.getLand(landIdx);
      if (land) {
        const sellPrice = Math.floor(land.landPrice + land.buildPrice * (land.level || 0) * 0.5);
        raised += sellPrice;
        property.clearLand(landIdx);
        messages.push(`变卖 ${land.name} 获得 ${sellPrice}`);
        events.push({ type: "land_liquidated", data: { landIndex: landIdx, price: sellPrice } });
      }
    }
    player.properties = player.properties.filter(idx => {
      const land = property.getLand(idx);
      return land && land.owner === player.id;
    });

    // 将变卖所得加入现金
    player.cash += raised;

    if (player.cash >= debtAmount) {
      player.cash -= debtAmount;
      return {
        liquidated: true,
        amountRaised: raised,
        message: `${player.name} 变卖地产筹得 ${raised}，清偿债务 ${debtAmount}`,
        events,
      };
    }

    // 2. 变卖股票 — 所得加入现金
    const stockValue = engine.getStockSystem()?.liquidate(player) || 0;
    if (stockValue > 0) {
      raised += stockValue;
      player.cash += stockValue;
      messages.push(`变卖股票获得 ${stockValue}`);
      events.push({ type: "stocks_liquidated", data: { amount: stockValue } });
    }

    if (player.cash >= debtAmount) {
      player.cash -= debtAmount;
      return {
        liquidated: true,
        amountRaised: raised,
        message: `${player.name} 变卖地产和股票后勉强还债`,
        events,
      };
    }

    // 3. 变卖卡牌 — 换为点券（不影响现金）
    while (player.cards.length > 0) {
      const cardId = player.cards.pop()!;
      player.points += 1000;
      messages.push("变卖卡牌获得1000点券");
    }

    // 4. 变卖道具 — 换为点券（不影响现金）
    while (player.tools.length > 0) {
      const tool = player.tools.pop()!;
      const sellPrice = 500 * tool.amount;
      player.points += sellPrice;
      messages.push(`变卖道具获得${sellPrice}点券`);
    }

    // 5. 提取存款
    if (player.moneyInBank > 0) {
      const bankAmount = player.moneyInBank;
      player.cash += bankAmount;
      player.moneyInBank = 0;
      raised += bankAmount;
      messages.push(`提取存款 ${bankAmount}`);
    }

    if (player.cash >= debtAmount) {
      player.cash -= debtAmount;
      return {
        liquidated: true,
        amountRaised: raised,
        message: `${player.name} 变卖全部资产并提取存款后勉强还债`,
        events,
      };
    }

    // 完全破产 — 清除剩余资产
    player.cash = 0;
    player.status = "bankrupted";
    return {
      liquidated: true,
      amountRaised: raised,
      message: `${player.name} 破产了！变卖资产仅得 ${raised}，不足以偿还 ${debtAmount}`,
      events: [...events, { type: "player_bankrupted", data: { playerId: player.id } }],
    };
  }
}
