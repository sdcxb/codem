/**
 * ToolSystem — 道具效果系统
 * 解析 23 种道具的 effect 字符串并执行对应逻辑
 * 道具在地图上放置或对自身/目标使用
 */

import type { ToolDef, GameEvent } from "../types";
import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";

/** 地图上放置的道具实例 */
export interface PlacedTool {
  toolId: number;
  nodeId: number;
  ownerId: number;
  // 定时炸弹专用
  timer?: number;
}

export interface ToolUseContext {
  engine: GameEngine;
  user: Player;
  targetPlayer?: Player;
  targetNodeId?: number;
  date: number;
}

export interface ToolResult {
  success: boolean;
  message: string;
  events?: GameEvent[];
}

export class ToolSystem {
  private toolDefs: ToolDef[];
  private placedTools: PlacedTool[] = [];

  constructor(toolDefs: ToolDef[]) {
    this.toolDefs = toolDefs;
  }

  /** 获取道具定义 */
  getToolDef(toolId: number): ToolDef | undefined {
    return this.toolDefs.find(t => t.id === toolId);
  }

  /** 使用道具 */
  useTool(toolId: number, ctx: ToolUseContext): ToolResult {
    const def = this.getToolDef(toolId);
    if (!def) return { success: false, message: `道具${toolId}不存在` };

    const [effectType, ...params] = def.effect.split(":");

    switch (effectType) {
      // ===== 交通升级 =====
      case "traffic":
        return this.effectTraffic(ctx, parseInt(params[0]) || 1);

      // ===== 地图放置型道具 =====
      case "roadblock":
        return this.effectRoadblock(ctx);
      case "landmine":
        return this.effectLandmine(ctx);
      case "time_bomb":
        return this.effectTimeBomb(ctx);

      // ===== 传送/移动型 =====
      case "teleport":
        return this.effectTeleport(ctx);
      case "time_machine":
        return this.effectTimeMachine(ctx);

      // ===== 建造型 =====
      case "free_build":
        return this.effectFreeBuild(ctx);
      case "auto_upgrade_all":
        return this.effectAutoUpgradeAll(ctx);

      // ===== 攻击型 =====
      case "missile":
        return this.effectMissile(ctx);
      case "steal_percent":
        return this.effectStealPercent(ctx, parseInt(params[0]) || 10);

      // ===== 状态型 =====
      case "seal":
        return this.effectSeal(ctx, parseInt(params[0]) || 3);
      case "markup":
        return this.effectMarkup(ctx, parseInt(params[0]) || 3);
      case "dice_control":
        return this.effectDiceControl(ctx);
      case "alliance":
        return this.effectAlliance(ctx, parseInt(params[0]) || 7);
      case "stop":
        return this.effectStop(ctx, parseInt(params[0]) || 2);
      case "sleep":
        return this.effectSleep(ctx, parseInt(params[0]) || 3);
      case "reverse":
        return this.effectReverse(ctx);
      case "tortoise":
        return this.effectTortoise(ctx, parseInt(params[0]) || 3);

      // ===== 免疫型 =====
      case "immunity_prison":
        return this.effectImmunityPrison(ctx);
      case "assurance":
        return this.effectAssurance(ctx, parseInt(params[0]) || 5);
      case "free_research":
        return this.effectFreeResearch(ctx);

      default:
        return { success: false, message: `未知道具效果: ${def.effect}` };
    }
  }

  // ===== 交通升级 =====

  private effectTraffic(ctx: ToolUseContext, method: number): ToolResult {
    const methodNames = ["步行", "机车", "汽车"];
    ctx.user.setTraffic(method as 0 | 1 | 2);
    return {
      success: true,
      message: `${ctx.user.name} 切换为${methodNames[method]}模式，掷${method + 1}颗骰子`,
      events: [{ type: "traffic_changed", data: { playerId: ctx.user.id, method } }],
    };
  }

  // ===== 地图放置型 =====

  private effectRoadblock(ctx: ToolUseContext): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定放置位置" };
    this.placedTools.push({
      toolId: 2,
      nodeId: ctx.targetNodeId,
      ownerId: ctx.user.id,
    });
    return { success: true, message: `路障已放置在节点${ctx.targetNodeId}` };
  }

  private effectLandmine(ctx: ToolUseContext): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定放置位置" };
    this.placedTools.push({
      toolId: 3,
      nodeId: ctx.targetNodeId,
      ownerId: ctx.user.id,
    });
    return { success: true, message: `地雷已埋设在节点${ctx.targetNodeId}` };
  }

  private effectTimeBomb(ctx: ToolUseContext): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定放置位置" };
    this.placedTools.push({
      toolId: 4,
      nodeId: ctx.targetNodeId,
      ownerId: ctx.user.id,
      timer: 3, // 3回合后爆炸
    });
    return { success: true, message: `定时炸弹已放置在节点${ctx.targetNodeId}，3回合后爆炸` };
  }

  // ===== 传送/移动 =====

  private effectTeleport(ctx: ToolUseContext): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定传送目标" };
    ctx.user.lastNodeId = ctx.user.positionNodeId;
    ctx.user.positionNodeId = ctx.targetNodeId;
    return {
      success: true,
      message: `${ctx.user.name} 传送到节点${ctx.targetNodeId}`,
      events: [{ type: "player_teleported", data: { playerId: ctx.user.id, nodeId: ctx.targetNodeId } }],
    };
  }

  private effectTimeMachine(ctx: ToolUseContext): ToolResult {
    // 回到上一回合位置
    const tmp = ctx.user.positionNodeId;
    ctx.user.positionNodeId = ctx.user.lastNodeId;
    ctx.user.lastNodeId = tmp;
    return {
      success: true,
      message: `${ctx.user.name} 使用时光机回到上一回合位置`,
      events: [{ type: "player_teleported", data: { playerId: ctx.user.id, nodeId: ctx.user.positionNodeId } }],
    };
  }

  // ===== 建造型 =====

  private effectFreeBuild(ctx: ToolUseContext): ToolResult {
    const node = ctx.engine.getMap().nodes[ctx.user.positionNodeId];
    if (!node) return { success: false, message: "当前节点无效" };
    const landIndex = ctx.engine.getMap().lands.findIndex(l => l.id === node.id);
    if (landIndex < 0) return { success: false, message: "当前地块不可建造" };

    const property = ctx.engine.getProperty();
    const land = property.getLand(landIndex);
    if (!land) return { success: false, message: "地块不存在" };

    if (land.owner === -1) {
      // 空地：免费获取
      property.buyLand(landIndex, ctx.user.id);
      ctx.user.properties.push(landIndex);
      return { success: true, message: `${ctx.user.name} 使用工程车免费获取 ${land.name}` };
    } else if (land.owner === ctx.user.id) {
      // 自己的地：免费升级
      const ok = property.upgradeLand(landIndex);
      return { success: ok, message: ok ? `工程车免费升级 ${land.name}` : `${land.name} 已满级` };
    }
    return { success: false, message: "这是别人的地" };
  }

  private effectAutoUpgradeAll(ctx: ToolUseContext): ToolResult {
    const property = ctx.engine.getProperty();
    let count = 0;
    for (const landIdx of ctx.user.properties) {
      if (property.upgradeLand(landIdx)) count++;
    }
    return {
      success: true,
      message: `机器工人自动升级了 ${count} 块地产`,
      events: [{ type: "lands_upgraded", data: { count } }],
    };
  }

  // ===== 攻击型 =====

  private effectMissile(ctx: ToolUseContext): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定轰炸目标" };
    const property = ctx.engine.getProperty();
    const map = ctx.engine.getMap();
    const node = map.nodes[ctx.targetNodeId];
    if (!node) return { success: false, message: "目标节点无效" };

    // 找到该节点上的地块并降级
    const landIndex = map.lands.findIndex(l => l.id === node.id);
    if (landIndex >= 0) {
      const land = property.getLand(landIndex);
      if (land && land.level! > 0) {
        property.downgradeLand(landIndex);
        return { success: true, message: `导弹炸毁了 ${land.name} 的一级建筑` };
      }
      return { success: false, message: `${land?.name || "地块"}没有可炸的建筑` };
    }
    return { success: false, message: "目标不是地块" };
  }

  private effectStealPercent(ctx: ToolUseContext, percent: number): ToolResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    const stealAmount = Math.floor(ctx.targetPlayer.cash * percent / 100);
    if (stealAmount <= 0) return { success: false, message: `${ctx.targetPlayer.name} 没有现金可抢` };
    ctx.targetPlayer.spendMoney(stealAmount);
    ctx.user.addMoney(stealAmount);
    return { success: true, message: `机器娃娃从 ${ctx.targetPlayer.name} 抢走 ${stealAmount} 现金 (${percent}%)` };
  }

  // ===== 状态型 =====

  private effectSeal(ctx: ToolUseContext, days: number): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定目标地块" };
    const map = ctx.engine.getMap();
    const node = map.nodes[ctx.targetNodeId];
    if (!node) return { success: false, message: "目标节点无效" };
    const landIndex = map.lands.findIndex(l => l.id === node.id);
    if (landIndex < 0) return { success: false, message: "目标不是地块" };
    ctx.engine.getProperty().sealLand(landIndex, ctx.date + days);
    return { success: true, message: `查封令生效，地块查封 ${days} 天` };
  }

  private effectMarkup(ctx: ToolUseContext, days: number): ToolResult {
    if (ctx.targetNodeId === undefined) return { success: false, message: "未指定目标地块" };
    const map = ctx.engine.getMap();
    const node = map.nodes[ctx.targetNodeId];
    if (!node) return { success: false, message: "目标节点无效" };
    const landIndex = map.lands.findIndex(l => l.id === node.id);
    if (landIndex < 0) return { success: false, message: "目标不是地块" };
    ctx.engine.getProperty().markPriceUp(landIndex, ctx.date + days);
    return { success: true, message: `涨价令生效，地块过路费翻倍 ${days} 天` };
  }

  private effectDiceControl(ctx: ToolUseContext): ToolResult {
    const value = Math.floor(Math.random() * 6) + 1;
    ctx.user.diceProphecy = value;
    return { success: true, message: `${ctx.user.name} 下次掷骰将出 ${value}` };
  }

  private effectAlliance(ctx: ToolUseContext, days: number): ToolResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.user.alliedDays = days;
    ctx.user.alliedPlayer = ctx.targetPlayer.id;
    ctx.targetPlayer.alliedDays = days;
    ctx.targetPlayer.alliedPlayer = ctx.user.id;
    return { success: true, message: `${ctx.user.name} 与 ${ctx.targetPlayer.name} 结盟 ${days} 天` };
  }

  private effectStop(ctx: ToolUseContext, days: number): ToolResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysStopping = days;
    return { success: true, message: `${ctx.targetPlayer.name} 被停留令停止 ${days} 天` };
  }

  private effectSleep(ctx: ToolUseContext, days: number): ToolResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysSleeping = days;
    return { success: true, message: `${ctx.targetPlayer.name} 被催眠器催眠 ${days} 天` };
  }

  private effectReverse(ctx: ToolUseContext): ToolResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.direction = -ctx.targetPlayer.direction;
    return { success: true, message: `${ctx.targetPlayer.name} 的移动方向被反转` };
  }

  private effectTortoise(ctx: ToolUseContext, days: number): ToolResult {
    if (!ctx.targetPlayer) return { success: false, message: "未指定目标玩家" };
    ctx.targetPlayer.daysTortoiseWalking = days;
    return { success: true, message: `${ctx.targetPlayer.name} 被乌龟令减速 ${days} 天` };
  }

  // ===== 免疫型 =====

  private effectImmunityPrison(ctx: ToolUseContext): ToolResult {
    ctx.user.daysRejectedByBank = -1; // 复用为免罪标记
    return { success: true, message: `${ctx.user.name} 获得免罪符` };
  }

  private effectAssurance(ctx: ToolUseContext, days: number): ToolResult {
    ctx.user.daysAssurance = days;
    return { success: true, message: `${ctx.user.name} 获得保险保障 ${days} 天` };
  }

  private effectFreeResearch(ctx: ToolUseContext): ToolResult {
    // 研究所免费研究：随机获得一个道具
    const randomToolId = Math.floor(Math.random() * this.toolDefs.length);
    ctx.user.addTool(randomToolId, 1);
    const def = this.getToolDef(randomToolId);
    return { success: true, message: `${ctx.user.name} 研究出了 ${def?.name || "道具"}` };
  }

  // ===== 放置道具检查 =====

  /** 检查节点上是否有路障 */
  hasRoadblock(nodeId: number): boolean {
    return this.placedTools.some(t => t.toolId === 2 && t.nodeId === nodeId);
  }

  /** 检查节点上是否有地雷 */
  hasLandmine(nodeId: number): boolean {
    return this.placedTools.some(t => t.toolId === 3 && t.nodeId === nodeId);
  }

  /** 获取节点上的定时炸弹 */
  getTimeBomb(nodeId: number): PlacedTool | undefined {
    return this.placedTools.find(t => t.toolId === 4 && t.nodeId === nodeId);
  }

  /** 移除节点上的道具 */
  removeToolAt(nodeId: number, toolId: number): void {
    const idx = this.placedTools.findIndex(t => t.nodeId === nodeId && t.toolId === toolId);
    if (idx >= 0) this.placedTools.splice(idx, 1);
  }

  /** 每回合更新定时炸弹计时器 */
  tickTimers(): GameEvent[] {
    const events: GameEvent[] = [];
    for (let i = this.placedTools.length - 1; i >= 0; i--) {
      const tool = this.placedTools[i];
      if (tool.toolId === 4 && tool.timer !== undefined) {
        tool.timer--;
        if (tool.timer <= 0) {
          // 爆炸！
          events.push({ type: "bomb_exploded", data: { nodeId: tool.nodeId } });
          this.placedTools.splice(i, 1);
        }
      }
    }
    return events;
  }

  /** 获取所有放置的道具 */
  getPlacedTools(): PlacedTool[] {
    return [...this.placedTools];
  }

  /** 获取所有道具定义 */
  getAllTools(): ToolDef[] {
    return [...this.toolDefs];
  }
}
