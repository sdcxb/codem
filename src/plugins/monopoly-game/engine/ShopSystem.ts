/**
 * ShopSystem — 商店系统
 * 管理道具/卡牌的买卖，受物价指数影响
 */

import type { CardDef, ToolDef } from "../types";
import type { Player } from "./Player";

export interface ShopItem {
  type: "card" | "tool";
  id: number;
  name: string;
  description: string;
  basePrice: number;
  stock: number;
}

export interface ShopTransactionResult {
  success: boolean;
  message: string;
  actualPrice: number;
}

export class ShopSystem {
  private cards: CardDef[];
  private tools: ToolDef[];
  private cardStock: Map<number, number> = new Map();
  private toolStock: Map<number, number> = new Map();
  private priceIndex: number = 1000;

  constructor(cards: CardDef[], tools: ToolDef[]) {
    this.cards = cards;
    this.tools = tools;

    // 初始化库存
    for (const card of cards) {
      this.cardStock.set(card.id, 5); // 每种卡牌初始5张
    }
    for (const tool of tools) {
      this.toolStock.set(tool.id, 5); // 每种道具初始5个
    }
  }

  /** 更新物价指数 */
  updatePriceIndex(index: number): void {
    this.priceIndex = Math.max(200, index);
  }

  /** 获取实际购买价格（受物价指数影响） */
  getBuyPrice(basePrice: number): number {
    return Math.floor(basePrice * (this.priceIndex / 1000));
  }

  /** 获取实际出售价格（原价的50%） */
  getSellPrice(basePrice: number): number {
    return Math.floor(this.getBuyPrice(basePrice) * 0.5);
  }

  /** 获取商店可购买的商品列表 */
  getShopItems(): ShopItem[] {
    const items: ShopItem[] = [];

    for (const card of this.cards) {
      if (card.price > 0) {
        items.push({
          type: "card",
          id: card.id,
          name: card.name,
          description: card.description,
          basePrice: card.price,
          stock: this.cardStock.get(card.id) || 0,
        });
      }
    }

    for (const tool of this.tools) {
      items.push({
        type: "tool",
        id: tool.id,
        name: tool.name,
        description: tool.description,
        basePrice: tool.price,
        stock: this.toolStock.get(tool.id) || 0,
      });
    }

    return items;
  }

  /** 购买卡牌 */
  buyCard(cardId: number, player: Player): ShopTransactionResult {
    const card = this.cards.find(c => c.id === cardId);
    if (!card) return { success: false, message: "卡牌不存在", actualPrice: 0 };

    const stock = this.cardStock.get(cardId) || 0;
    if (stock <= 0) return { success: false, message: `${card.name} 库存不足`, actualPrice: 0 };

    const price = this.getBuyPrice(card.price);
    if (!player.spendMoney(price)) {
      return { success: false, message: `现金不足，需要 ${price}`, actualPrice: price };
    }

    if (!player.addCard(cardId)) {
      player.addMoney(price); // 退款
      return { success: false, message: "卡牌已满（上限4张）", actualPrice: price };
    }

    this.cardStock.set(cardId, stock - 1);
    return { success: true, message: `${player.name} 购买 ${card.name}，花费 ${price}`, actualPrice: price };
  }

  /** 购买道具 */
  buyTool(toolId: number, player: Player): ShopTransactionResult {
    const tool = this.tools.find(t => t.id === toolId);
    if (!tool) return { success: false, message: "道具不存在", actualPrice: 0 };

    const stock = this.toolStock.get(toolId) || 0;
    if (stock <= 0) return { success: false, message: `${tool.name} 库存不足`, actualPrice: 0 };

    const price = this.getBuyPrice(tool.price);
    if (!player.spendMoney(price)) {
      return { success: false, message: `现金不足，需要 ${price}`, actualPrice: price };
    }

    if (!player.addTool(toolId, 1, tool.maxAmount)) {
      player.addMoney(price); // 退款
      return { success: false, message: `${tool.name} 已达上限`, actualPrice: price };
    }

    this.toolStock.set(toolId, stock - 1);
    return { success: true, message: `${player.name} 购买 ${tool.name}，花费 ${price}`, actualPrice: price };
  }

  /** 出售卡牌换点券 */
  sellCard(cardId: number, player: Player): ShopTransactionResult {
    const card = this.cards.find(c => c.id === cardId);
    if (!card) return { success: false, message: "卡牌不存在", actualPrice: 0 };

    if (!player.removeCard(cardId)) {
      return { success: false, message: `你没有 ${card.name}`, actualPrice: 0 };
    }

    const sellPrice = this.getSellPrice(card.price);
    player.points += sellPrice;
    this.cardStock.set(cardId, (this.cardStock.get(cardId) || 0) + 1);
    return { success: true, message: `${player.name} 出售 ${card.name}，获得 ${sellPrice} 点券`, actualPrice: sellPrice };
  }

  /** 出售道具换点券 */
  sellTool(toolId: number, player: Player): ShopTransactionResult {
    const tool = this.tools.find(t => t.id === toolId);
    if (!tool) return { success: false, message: "道具不存在", actualPrice: 0 };

    if (!player.useTool(toolId)) {
      return { success: false, message: `你没有 ${tool.name}`, actualPrice: 0 };
    }

    const sellPrice = this.getSellPrice(tool.price);
    player.points += sellPrice;
    this.toolStock.set(toolId, (this.toolStock.get(toolId) || 0) + 1);
    return { success: true, message: `${player.name} 出售 ${tool.name}，获得 ${sellPrice} 点券`, actualPrice: sellPrice };
  }

  /** 用点券购买卡牌 */
  buyCardWithPoints(cardId: number, player: Player): ShopTransactionResult {
    const card = this.cards.find(c => c.id === cardId);
    if (!card || card.price === 0) return { success: false, message: "该卡牌无法用点券购买", actualPrice: 0 };

    const stock = this.cardStock.get(cardId) || 0;
    if (stock <= 0) return { success: false, message: `${card.name} 库存不足`, actualPrice: 0 };

    const pointCost = Math.floor(card.price / 1000) || 1;
    if (player.points < pointCost) {
      return { success: false, message: `点券不足，需要 ${pointCost}`, actualPrice: pointCost };
    }

    if (!player.addCard(cardId)) {
      return { success: false, message: "卡牌已满", actualPrice: pointCost };
    }

    player.points -= pointCost;
    this.cardStock.set(cardId, stock - 1);
    return { success: true, message: `${player.name} 用 ${pointCost} 点券购买 ${card.name}`, actualPrice: pointCost };
  }

  /** 补货（每回合执行） */
  restock(): void {
    for (const [id, stock] of this.cardStock) {
      if (stock < 5) this.cardStock.set(id, stock + 1);
    }
    for (const [id, stock] of this.toolStock) {
      if (stock < 5) this.toolStock.set(id, stock + 1);
    }
  }

  /** 获取卡牌库存 */
  getCardStock(cardId: number): number {
    return this.cardStock.get(cardId) || 0;
  }

  /** 获取道具库存 */
  getToolStock(toolId: number): number {
    return this.toolStock.get(toolId) || 0;
  }
}
