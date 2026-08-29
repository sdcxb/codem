/**
 * FortuneSystem — 命运/新闻事件系统
 * 30 种命运事件 + 10 种新闻事件的完整实现
 */

import type { GameEvent } from "../types";
import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";

export interface FortuneDef {
  id: number;
  name: string;
  description: string;
  category: "cash" | "property" | "bank" | "card" | "move" | "traffic" | "prison" | "stock";
}

export const FORTUNE_DEFS: FortuneDef[] = [
  { id: 0, name: "天降横财", description: "获得20000现金", category: "cash" },
  { id: 1, name: "中奖", description: "获得15000现金", category: "cash" },
  { id: 2, name: "遗产继承", description: "获得30000现金", category: "cash" },
  { id: 3, name: "意外之财", description: "获得10000现金", category: "cash" },
  { id: 4, name: "医疗补助", description: "获得8000现金", category: "cash" },
  { id: 5, name: "小财神", description: "获得小财神保佑3天", category: "card" },
  { id: 6, name: "大财神", description: "获得大财神保佑5天", category: "card" },
  { id: 7, name: "点券奖励", description: "获得5000点券", category: "cash" },
  { id: 8, name: "股票分红", description: "所有持股获得分红", category: "stock" },
  { id: 9, name: "免费道具", description: "获得一个随机道具", category: "card" },
  { id: 10, name: "免费卡牌", description: "获得一张随机卡牌", category: "card" },
  { id: 11, name: "破产危机", description: "失去15000现金", category: "cash" },
  { id: 12, name: "意外支出", description: "失去8000现金", category: "cash" },
  { id: 13, name: "税务稽查", description: "失去所有现金的20%", category: "cash" },
  { id: 14, name: "小穷神", description: "被小穷神附身3天", category: "card" },
  { id: 15, name: "大穷神", description: "被大穷神附身5天", category: "card" },
  { id: 16, name: "交通违章", description: "罚款5000", category: "traffic" },
  { id: 17, name: "交通事故", description: "送进医院3天", category: "prison" },
  { id: 18, name: "误入歧途", description: "被关进监狱3天", category: "prison" },
  { id: 19, name: "传送回起点", description: "回到起点", category: "move" },
  { id: 20, name: "前进3步", description: "前进3格", category: "move" },
  { id: 21, name: "后退3步", description: "后退3格", category: "move" },
  { id: 22, name: "免费升级", description: "随机一块地产升级", category: "property" },
  { id: 23, name: "地产查封", description: "随机一块地产被查封3天", category: "property" },
  { id: 24, name: "银行加息", description: "贷款利息翻倍", category: "bank" },
  { id: 25, name: "存款翻倍", description: "银行存款翻倍", category: "bank" },
  { id: 26, name: "股票暴涨", description: "所有股票上涨50%", category: "stock" },
  { id: 27, name: "股票暴跌", description: "所有股票下跌30%", category: "stock" },
  { id: 28, name: "物价飞涨", description: "物价指数上升200", category: "cash" },
  { id: 29, name: "节日庆典", description: "所有玩家获得5000点券", category: "cash" },
];

export const NEWS_DEFS: FortuneDef[] = [
  { id: 0, name: "经济危机", description: "所有玩家现金减少10%", category: "cash" },
  { id: 1, name: "股市暴跌", description: "所有股票下跌30%", category: "stock" },
  { id: 2, name: "股市飙升", description: "所有股票上涨50%", category: "stock" },
  { id: 3, name: "物价飞涨", description: "物价指数+200", category: "cash" },
  { id: 4, name: "税收减免", description: "所有玩家获得3000", category: "cash" },
  { id: 5, name: "街头抢劫", description: "最富玩家损失15%", category: "cash" },
  { id: 6, name: "彩票开奖", description: "随机玩家获得20000", category: "cash" },
  { id: 7, name: "道路施工", description: "随机地块查封3天", category: "property" },
  { id: 8, name: "节日庆典", description: "所有玩家获得5000点券", category: "cash" },
  { id: 9, name: "房价大涨", description: "所有地产过路费翻倍3天", category: "property" },
];

export class FortuneSystem {
  /** 随机命运事件 ID */
  randomFortuneId(): number {
    return Math.floor(Math.random() * FORTUNE_DEFS.length);
  }

  /** 随机新闻事件 ID */
  randomNewsId(): number {
    return Math.floor(Math.random() * NEWS_DEFS.length);
  }

  /** 触发命运事件 */
  triggerFortune(engine: GameEngine, player: Player, fortuneId: number): { message: string; events?: GameEvent[] } {
    const def = FORTUNE_DEFS[fortuneId];
    if (!def) return { message: "未知命运事件" };

    switch (fortuneId) {
      case 0: { player.addMoney(20000); return { message: `${player.name} 天降横财 20000` }; }
      case 1: { player.addMoney(15000); return { message: `${player.name} 中奖 15000` }; }
      case 2: { player.addMoney(30000); return { message: `${player.name} 遗产继承 30000` }; }
      case 3: { player.addMoney(10000); return { message: `${player.name} 意外之财 10000` }; }
      case 4: { player.addMoney(8000); return { message: `${player.name} 医疗补助 8000` }; }
      case 5: { player.godInfo = 1; return { message: `${player.name} 获得小财神保佑` }; }
      case 6: { player.godInfo = 2; return { message: `${player.name} 获得大财神保佑` }; }
      case 7: { player.points += 5000; return { message: `${player.name} 获得 5000 点券` }; }
      case 8: {
        // 股票分红
        const stocks = engine.getPlayerStocks(player.id);
        let total = 0;
        for (const s of stocks) {
          const dividend = Math.floor(s.amount * engine.getStockPrice(s.stockId) * 0.1);
          total += dividend;
        }
        if (total > 0) player.addMoney(total);
        return { message: `${player.name} 股票分红 ${total}` };
      }
      case 9: {
        const toolId = Math.floor(Math.random() * 10);
        player.addTool(toolId, 1);
        return { message: `${player.name} 获得一个随机道具` };
      }
      case 10: {
        const cardId = Math.floor(Math.random() * 20);
        player.addCard(cardId);
        return { message: `${player.name} 获得一张随机卡牌` };
      }
      case 11: { player.spendMoney(15000); return { message: `${player.name} 破产危机，失去 15000` }; }
      case 12: { player.spendMoney(8000); return { message: `${player.name} 意外支出 8000` }; }
      case 13: {
        const loss = Math.floor(player.cash * 0.2);
        player.spendMoney(loss);
        return { message: `${player.name} 税务稽查，损失 ${loss}` };
      }
      case 14: { player.godInfo = 5; return { message: `${player.name} 被小穷神附身` }; }
      case 15: { player.godInfo = 6; return { message: `${player.name} 被大穷神附身` }; }
      case 16: { player.spendMoney(5000); return { message: `${player.name} 交通违章罚款 5000` }; }
      case 17: { player.daysInHospital = 3; return { message: `${player.name} 交通事故，住院3天` }; }
      case 18: { player.daysInPrison = 3; return { message: `${player.name} 误入歧途，入狱3天` }; }
      case 19: { player.lastNodeId = player.positionNodeId; player.positionNodeId = engine.getMap().startNodeId; return { message: `${player.name} 被传送回起点` }; }
      case 20: {
        // 前进3步 — 直接移动3步
        const map = engine.getMap();
        for (let step = 0; step < 3; step++) {
          const node = map.nodes[player.positionNodeId];
          if (!node || node.adjacent.length === 0) break;
          const availableNext = node.adjacent.filter(id => id !== player.lastNodeId);
          const nextId = availableNext.length > 0 ? availableNext[0] : node.adjacent[0];
          player.lastNodeId = player.positionNodeId;
          player.positionNodeId = nextId;
        }
        return { message: `${player.name} 前进了3步`, events: [{ type: "player_teleported", data: { playerId: player.id, nodeId: player.positionNodeId } }] };
      }
      case 21: {
        // 后退3步 — 反方向移动3步
        const map = engine.getMap();
        for (let step = 0; step < 3; step++) {
          const node = map.nodes[player.positionNodeId];
          if (!node || node.adjacent.length === 0) break;
          // 后退 = 走 lastNodeId 方向
          const nextId = player.lastNodeId;
          const node2 = map.nodes[nextId];
          if (!node2) break;
          const tmp = player.positionNodeId;
          player.positionNodeId = nextId;
          player.lastNodeId = tmp;
        }
        return { message: `${player.name} 后退了3步`, events: [{ type: "player_teleported", data: { playerId: player.id, nodeId: player.positionNodeId } }] };
      }
      case 22: {
        // 随机升级一块自己的地产
        if (player.properties.length > 0) {
          const idx = player.properties[Math.floor(Math.random() * player.properties.length)];
          engine.getProperty().upgradeLand(idx);
          return { message: `${player.name} 免费升级一块地产` };
        }
        return { message: `${player.name} 没有可升级的地产` };
      }
      case 23: {
        // 随机查封一块地产
        const lands = engine.getMap().lands;
        if (lands.length > 0) {
          const idx = Math.floor(Math.random() * lands.length);
          engine.getProperty().sealLand(idx, engine.getDate() + 3);
          return { message: `地块 ${lands[idx].name} 被查封3天` };
        }
        return { message: "没有可查封的地块" };
      }
      case 24: {
        player.loan *= 2;
        return { message: `${player.name} 银行加息，贷款翻倍至 ${player.loan}` };
      }
      case 25: {
        player.moneyInBank *= 2;
        return { message: `${player.name} 存款翻倍至 ${player.moneyInBank}` };
      }
      case 26: {
        return {
          message: "股票暴涨！所有股票上涨50%",
          events: [{ type: "stock_boom", data: { percent: 50 } }],
        };
      }
      case 27: {
        return {
          message: "股票暴跌！所有股票下跌30%",
          events: [{ type: "stock_crash", data: { percent: 30 } }],
        };
      }
      case 28: {
        return {
          message: "物价飞涨！物价指数+200",
          events: [{ type: "price_index_up", data: { amount: 200 } }],
        };
      }
      case 29: {
        for (const p of engine.getPlayers()) p.points += 5000;
        return { message: "节日庆典！所有玩家获得5000点券" };
      }
      default:
        return { message: "未知命运事件" };
    }
  }

  /** 触发新闻事件（全局） */
  triggerNews(engine: GameEngine, newsId: number): { message: string; events?: GameEvent[] } {
    const players = engine.getPlayers();
    switch (newsId % 10) {
      case 0: {
        for (const p of players) {
          const loss = Math.floor(p.cash * 0.1);
          p.spendMoney(loss);
        }
        return { message: "新闻: 经济危机！所有玩家现金减少10%" };
      }
      case 1: {
        return {
          message: "新闻: 股市暴跌！所有股票下跌30%",
          events: [{ type: "stock_crash", data: { percent: 30 } }],
        };
      }
      case 2: {
        return {
          message: "新闻: 股市飙升！所有股票上涨50%",
          events: [{ type: "stock_boom", data: { percent: 50 } }],
        };
      }
      case 3: {
        return {
          message: "新闻: 物价飞涨！物价指数+200",
          events: [{ type: "price_index_up", data: { amount: 200 } }],
        };
      }
      case 4: {
        for (const p of players) p.addMoney(3000);
        return { message: "新闻: 税收减免！所有玩家获得3000" };
      }
      case 5: {
        const richest = [...players].sort((a, b) => b.cash - a.cash)[0];
        if (richest) {
          const loss = Math.floor(richest.cash * 0.15);
          richest.spendMoney(loss);
          return { message: `新闻: 街头抢劫！${richest.name} 损失 ${loss}` };
        }
        return { message: "新闻: 街头抢劫（无人）" };
      }
      case 6: {
        const winner = players[Math.floor(Math.random() * players.length)];
        if (winner) {
          winner.addMoney(20000);
          return { message: `新闻: 彩票开奖！${winner.name} 获得 20000` };
        }
        return { message: "新闻: 彩票开奖（无人中奖）" };
      }
      case 7: {
        const lands = engine.getMap().lands;
        if (lands.length > 0) {
          const idx = Math.floor(Math.random() * lands.length);
          engine.getProperty().sealLand(idx, engine.getDate() + 3);
          return { message: `新闻: 道路施工！${lands[idx].name} 查封3天` };
        }
        return { message: "新闻: 道路施工（无地块）" };
      }
      case 8: {
        for (const p of players) p.points += 5000;
        return { message: "新闻: 节日庆典！所有玩家获得5000点券" };
      }
      default: {
        return {
          message: "新闻: 房价大涨！所有地产过路费翻倍3天",
          events: [{ type: "all_toll_double", data: { days: 3 } }],
        };
      }
    }
  }

  /** 获取命运事件定义 */
  getFortuneDef(id: number): FortuneDef | undefined {
    return FORTUNE_DEFS[id];
  }

  /** 获取新闻事件定义 */
  getNewsDef(id: number): FortuneDef | undefined {
    return NEWS_DEFS[id];
  }

  /** 获取所有命运事件 */
  getAllFortunes(): FortuneDef[] {
    return [...FORTUNE_DEFS];
  }

  /** 获取所有新闻事件 */
  getAllNews(): FortuneDef[] {
    return [...NEWS_DEFS];
  }
}
