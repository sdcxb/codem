/**
 * CardSystem — 卡牌效果系统
 * 解析 30 种卡牌的 effect 字符串并执行对应逻辑
 * 卡牌效果通过 GameEngine 操作玩家状态和地图
 */

import type { CardDef, GameEvent } from "../types";
import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";

export interface CardUseContext {
  engine: GameEngine;
  user: Player;
  targetPlayer?: Player;
  targetLandIndex?: number;
  date: number;
}

export interface CardResult {
  success: boolean;
  message: string;
  events?: GameEvent[];
}

export class CardSystem {
  private cardDefs: CardDef[];

  constructor(cardDefs: CardDef[]) {
    this.cardDefs = cardDefs;
  }

  /** 获取卡牌定义 */
  getCardDef(cardId: number): CardDef | undefined {
    return this.cardDefs.find(c => c.id === cardId);
  }

  /** 使用卡牌 */
  useCard(cardId: number, ctx: CardUseContext): CardResult {
    const def = this.getCardDef(cardId);
    if (!def) return { success: false, message: `卡牌${cardId}不存在` };

    // 解析效果标识符和参数
    const [effectType, ...params] = def.effect.split(":");

    switch (effectType) {
      // ===== 自身增益 =====
      case "grant_points":
        return this.effectGrantPoints(ctx, parseInt(params[0]) || 0);
      case "grant_cash":
        return this.effectGrantCash(ctx, parseInt(params[0]) || 0);
      case "assurance":
        return this.effectAssurance(ctx, parseInt(params[0]) || 5);
      case "immunity_prison":
        return this.effectImmunityPrison(ctx);
      case "reroll":
        return this.effectReroll(ctx);
      case "dice_prophecy":
        return this.effectDiceProphecy(ctx);
      case "god":
        return this.effectGod(ctx, parseInt(params[0]) || 1);

      // ===== 对手干扰 =====
      case "send_to_start":
        return this.effectSendToStart(ctx);
      case "swap_position":
        return this.effectSwapPosition(ctx);
      case "steal_item":
        return this.effectStealItem(ctx);
      case "tortoise":
        return this.effectTortoise(ctx, parseInt(params[0]) || 3);
      case "sleepwalk":
        return this.effectSleepwalk(ctx, parseInt(params[0]) || 3);
      case "stop":
        return this.effectStop(ctx, parseInt(params[0]) || 1);
      case "sleep":
        return this.effectSleep(ctx, parseInt(params[0]) || 3);
      case "reverse_direction":
        return this.effectReverseDirection(ctx);
      case "alliance":
        return this.effectAlliance(ctx, parseInt(params[0]) || 5);
      case "break_alliance":
        return this.effectBreakAlliance(ctx);

      // ===== 地产操作 =====
      case "seal_land":
        return this.effectSealLand(ctx, parseInt(params[0]) || 3);
      case "price_up":
        return this.effectPriceUp(ctx, parseInt(params[0]) || 3);
      case "downgrade_land":
        return this.effectDowngradeLand(ctx);
      case "transfer_land":
        return this.effectTransferLand(ctx);
      case "free_land":
        return this.effectFreeLand(ctx);
      case "free_upgrade":
        return this.effectFreeUpgrade(ctx);
      case "force_auction":
        return this.effectForceAuction(ctx);
      case "reset_land":
        return this.effectResetLand(ctx);

      default:
        return { success: false, message: `未知卡牌效果: ${def.effect}` };
    }
  }

  // ===== 自身增益效果 =====

  private effectGrantPoints(ctx: CardUseContext, amount: number): CardResult {
    ctx.user.points += amount;
    return { success: true, message: `${ctx.user.name} 获得 ${amount} 点券` };
  }

  private effectGrantCash(ctx: CardUseContext, amount: number): CardResult {
    ctx.user.addMoney(amount);
    return { success: true, message: `${ctx.user.name} 获得 ${amount} 现金` };
  }

  private effectAssurance(ctx: CardUseContext, days: number): CardResult {
    ctx.user.daysAssurance = days;
    return { success: true, message: `${ctx.user.name} 获得保险保障 ${days} 天` };
  }

  private effectImmunityPrison(ctx: CardUseContext): CardResult {
    // 标记免罪 — 用 daysRejectedByBank 作为免罪标记（复用字段）
    ctx.user.daysRejectedByBank = -1; // -1 表示有免罪标记
    return { success: true, message: `${ctx.user.name} 获得免罪符` };
  }

  private effectReroll(ctx: CardUseContext): CardResult {
    // 重新掷骰 — 设置引擎状态允许重掷
    return {
      success: true,
      message: `${ctx.user.name} 可以重新掷骰`,
      events: [{ type: "allow_reroll", data: { playerId: ctx.user.id } }],
    };
  }

  private effectDiceProphecy(ctx: CardUseContext): CardResult {
    // 随机指定 1-6
    const value = Math.floor(Math.random() * 6) + 1;
    ctx.user.diceProphecy = value;
    return { success: true, message: `${ctx.user.name} 下次掷骰将出 ${value}` };
  }

  private effectGod(ctx: CardUseContext, godType: number): CardResult {
    if (!ctx.targetPlayer) {
      // 自用：财神
      ctx.user.godInfo = godType;
      return { success: true, message: `${ctx.user.name} 获得神仙保佑 (类型${godType})` };
    } else {
      // 对敌：穷神
      ctx.targetPlayer.godInfo = godType;
      return { success: true, message: `${ctx.targetPlayer.name} 被穷神附身 (类型${godType})` };
    }
  }

  // ===== 对手干扰效果 =====

  private effectSendToStart(ctx: CardUseContext): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    const startNode = ctx.engine.getMap().startNodeId;
    ctx.targetPlayer.positionNodeId = startNode;
    return { success: true, message: `${ctx.targetPlayer.name} 被送回起点` };
  }

  private effectSwapPosition(ctx: CardUseContext): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    const tmp = ctx.user.positionNodeId;
    ctx.user.positionNodeId = ctx.targetPlayer.positionNodeId;
    ctx.targetPlayer.positionNodeId = tmp;
    return { success: true, message: `${ctx.user.name} 与 ${ctx.targetPlayer.name} 交换了位置` };
  }

  private effectStealItem(ctx: CardUseContext): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    // 优先偷卡牌
    if (ctx.targetPlayer.cards.length > 0) {
      const idx = Math.floor(Math.random() * ctx.targetPlayer.cards.length);
      const cardId = ctx.targetPlayer.cards.splice(idx, 1)[0];
      ctx.user.addCard(cardId);
      return { success: true, message: `${ctx.user.name} 从 ${ctx.targetPlayer.name} 偷走一张卡牌` };
    }
    // 其次偷道具
    if (ctx.targetPlayer.tools.length > 0) {
      const toolEntry = ctx.targetPlayer.tools[0];
      ctx.targetPlayer.useTool(toolEntry.id);
      ctx.user.addTool(toolEntry.id, 1);
      return { success: true, message: `${ctx.user.name} 从 ${ctx.targetPlayer.name} 偷走一个${toolEntry.id === 0 ? '机车卡' : '道具'}` };
    }
    return { success: false, message: `${ctx.targetPlayer.name} 没有可偷的卡牌或道具` };
  }

  private effectTortoise(ctx: CardUseContext, days: number): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysTortoiseWalking = days;
    return { success: true, message: `${ctx.targetPlayer.name} 被乌龟附身 ${days} 天，移动步数减半` };
  }

  private effectSleepwalk(ctx: CardUseContext, days: number): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysSleepWalking = days;
    return { success: true, message: `${ctx.targetPlayer.name} 开始梦游 ${days} 天` };
  }

  private effectStop(ctx: CardUseContext, days: number): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysStopping = days;
    return { success: true, message: `${ctx.targetPlayer.name} 被强制停留 ${days} 天` };
  }

  private effectSleep(ctx: CardUseContext, days: number): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysSleeping = days;
    return { success: true, message: `${ctx.targetPlayer.name} 被催眠 ${days} 天` };
  }

  private effectReverseDirection(ctx: CardUseContext): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.direction = -ctx.targetPlayer.direction;
    return { success: true, message: `${ctx.targetPlayer.name} 的移动方向被反转` };
  }

  private effectAlliance(ctx: CardUseContext, days: number): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.user.alliedDays = days;
    ctx.user.alliedPlayer = ctx.targetPlayer.id;
    ctx.targetPlayer.alliedDays = days;
    ctx.targetPlayer.alliedPlayer = ctx.user.id;
    return { success: true, message: `${ctx.user.name} 与 ${ctx.targetPlayer.name} 结盟 ${days} 天` };
  }

  private effectBreakAlliance(ctx: CardUseContext): CardResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.user.alliedDays = 0;
    ctx.user.alliedPlayer = 0;
    ctx.targetPlayer.alliedDays = 0;
    ctx.targetPlayer.alliedPlayer = 0;
    return { success: true, message: `${ctx.user.name} 与 ${ctx.targetPlayer.name} 的同盟解除` };
  }

  // ===== 地产操作效果 =====

  private effectSealLand(ctx: CardUseContext, days: number): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    const property = ctx.engine.getProperty();
    property.sealLand(ctx.targetLandIndex, ctx.date + days);
    return { success: true, message: `地块被查封 ${days} 天` };
  }

  private effectPriceUp(ctx: CardUseContext, days: number): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    const property = ctx.engine.getProperty();
    property.markPriceUp(ctx.targetLandIndex, ctx.date + days);
    return { success: true, message: `地块过路费翻倍 ${days} 天` };
  }

  private effectDowngradeLand(ctx: CardUseContext): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    const property = ctx.engine.getProperty();
    const ok = property.downgradeLand(ctx.targetLandIndex);
    return {
      success: ok,
      message: ok ? "地块降级成功" : "地块无法降级",
    };
  }

  private effectTransferLand(ctx: CardUseContext): CardResult {
    if (ctx.targetLandIndex === undefined || !ctx.targetPlayer) return { success: false, message: "未指定目标" };
    const property = ctx.engine.getProperty();
    const land = property.getLand(ctx.targetLandIndex);
    if (!land) return { success: false, message: "地块不存在" };
    const oldOwner = land.owner ?? -1;
    if (oldOwner >= 0) {
      const oldPlayer = ctx.engine.getPlayers()[oldOwner];
      if (oldPlayer) {
        oldPlayer.properties = oldPlayer.properties.filter(p => p !== ctx.targetLandIndex);
      }
    }
    property.buyLand(ctx.targetLandIndex, ctx.targetPlayer.id);
    ctx.targetPlayer.properties.push(ctx.targetLandIndex);
    return { success: true, message: `地块已转移给 ${ctx.targetPlayer.name}` };
  }

  private effectFreeLand(ctx: CardUseContext): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    const property = ctx.engine.getProperty();
    const land = property.getLand(ctx.targetLandIndex);
    if (!land || land.owner !== -1) return { success: false, message: "地块不可用" };
    property.buyLand(ctx.targetLandIndex, ctx.user.id);
    ctx.user.properties.push(ctx.targetLandIndex);
    return { success: true, message: `${ctx.user.name} 免费获得 ${land.name}` };
  }

  private effectFreeUpgrade(ctx: CardUseContext): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    const property = ctx.engine.getProperty();
    const ok = property.upgradeLand(ctx.targetLandIndex);
    return { success: ok, message: ok ? "免费升级成功" : "地块无法升级" };
  }

  private effectForceAuction(ctx: CardUseContext): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    return {
      success: true,
      message: "强制拍卖触发",
      events: [{ type: "force_auction", data: { landIndex: ctx.targetLandIndex } }],
    };
  }

  private effectResetLand(ctx: CardUseContext): CardResult {
    if (ctx.targetLandIndex === undefined) return { success: false, message: "未指定目标地块" };
    const property = ctx.engine.getProperty();
    const land = property.getLand(ctx.targetLandIndex);
    if (!land) return { success: false, message: "地块不存在" };
    while (land.level! > 0) {
      property.downgradeLand(ctx.targetLandIndex);
    }
    return { success: true, message: "地块等级归零" };
  }

  /** 获取所有卡牌定义 */
  getAllCards(): CardDef[] {
    return [...this.cardDefs];
  }

  /** 随机抽一张卡牌ID */
  randomCardId(): number {
    return this.cardDefs[Math.floor(Math.random() * this.cardDefs.length)].id;
  }
}
