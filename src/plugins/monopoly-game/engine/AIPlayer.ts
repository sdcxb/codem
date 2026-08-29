/**
 * AIPlayer — AI 对手策略
 * G4 重构：多层策略评估（地产价值/连锁潜力/对手威胁/资金管理/股票趋势）
 * G2: 分岔路口选择
 */

import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";
import cardsData from "../data/cards.json";
import toolsData from "../data/tools.json";

export interface AIDecision {
  action: "roll" | "buy_land" | "upgrade" | "skip" | "use_card" | "use_tool" | "shop_buy" | "end_turn" | "bank_deposit" | "bank_withdraw" | "bank_loan" | "bank_repay" | "stock_buy" | "stock_sell" | "auction_bid" | "auction_pass";
  params?: { cardId?: number; toolId?: number; targetId?: number; amount?: number; landIndex?: number; stockId?: number };
}

export interface BranchChoice {
  nodeId: number;
  name: string;
  x: number;
  y: number;
}

export class AIPlayer {
  private difficulty: "easy" | "normal" | "hard" = "normal";

  setDifficulty(d: "easy" | "normal" | "hard"): void {
    this.difficulty = d;
  }

  /** G2: AI 选择分岔方向 — 评估每个方向的价值 */
  chooseBranch(choices: BranchChoice[], player: Player, engine: GameEngine): number {
    // 评估每个方向的"价值"
    let bestScore = -Infinity;
    let bestNodeId = choices[0].nodeId;

    for (const choice of choices) {
      let score = 0;
      const node = engine.getMap().nodes[choice.nodeId];
      if (!node) continue;

      // 因素1: 前方是否有空地可买（正分）
      const land = engine.getMap().lands.find(l => l.id === choice.nodeId);
      if (land && (land.owner === undefined || land.owner < 0) && player.cash > land.landPrice * 1.5) {
        score += land.landPrice * 0.01; // 地价越高越想买
      }

      // 因素2: 前方是否是自己的地（可升级，正分）
      if (land && land.owner === player.id && (land.level || 0) < (land.maxLevel || 3) && player.cash > land.buildPrice * 1.5) {
        score += 200;
      }

      // 因素3: 前方是否是他人高等级地（负分，避免过路费）
      if (land && land.owner !== undefined && land.owner >= 0 && land.owner !== player.id) {
        const tolls = land.tolls || [];
        const toll = tolls[(land.level || 1) - 1] || tolls[0] || 0;
        score -= toll * 0.5;
      }

      // 因素4: 前方是设施（正分小，看类型）
      if (node.tileType === "facility") {
        const facility = engine.getMap().facilities.find(f => f.id === choice.nodeId);
        if (facility) {
          if (facility.type === "shop") score += 100;
          else if (facility.type === "bank") score += player.cash > 10000 ? 80 : 20;
          else if (facility.type === "fortune" || facility.type === "news") score += 60;
          else if (facility.type === "auction_house") score += 50;
          else if (facility.type === "magic_house") score += 40;
        }
      }

      // 因素5: 前方是起点（正分，可领工资）
      if (choice.nodeId === engine.getMap().startNodeId) {
        score += 300;
      }

      // 因素6: 前方是否有路障/地雷（大幅负分）
      if (engine.getToolSystem().hasRoadblock(choice.nodeId)) score -= 500;
      if (engine.getToolSystem().hasLandmine(choice.nodeId)) score -= 800;

      // 随机扰动（按难度调整）
      const randomness = this.difficulty === "easy" ? 200 : this.difficulty === "normal" ? 80 : 20;
      score += Math.random() * randomness;

      if (score > bestScore) {
        bestScore = score;
        bestNodeId = choice.nodeId;
      }
    }

    return bestNodeId;
  }

  /** AI 回合决策 */
  takeTurn(engine: GameEngine, player: Player): AIDecision {
    const phase = engine.getPhase();

    switch (phase) {
      case "rolling":
        return { action: "roll" };

      case "idle": {
        // 到达地块后决策
        const node = engine.getMap().nodes[player.positionNodeId];
        if (!node) return { action: "end_turn" };

        if (node.tileType === "land") {
          const landIndex = engine.getMap().lands.findIndex(l => l.id === node.id);
          if (landIndex < 0) return { action: "end_turn" };
          const land = engine.getProperty().getLand(landIndex);
          if (!land) return { action: "end_turn" };

          if (land.owner === -1) {
            // G4: 评估地块价值再决定是否购买
            const landValue = this.evaluateLandValue(land, landIndex, engine, player);
            const buyThreshold = this.difficulty === "easy" ? 1.5 : this.difficulty === "normal" ? 1.2 : 1.0;
            if (player.cash > land.landPrice * buyThreshold && landValue > 0) {
              return { action: "buy_land", params: { landIndex } };
            }
            return { action: "skip" };
          } else if (land.owner === player.id) {
            // G4: 自己的地 — 评估升级 ROI
            const upgradeThreshold = this.difficulty === "easy" ? 2.5 : this.difficulty === "normal" ? 2.0 : 1.5;
            if (player.cash > land.buildPrice * upgradeThreshold && (land.level || 0) < (land.maxLevel || 3)) {
              return { action: "upgrade", params: { landIndex } };
            }
            return { action: "skip" };
          } else {
            // 别人的地：有卡就用
            if (player.cards.length > 0) {
              const useChance = this.difficulty === "easy" ? 0.15 : this.difficulty === "normal" ? 0.25 : 0.4;
              if (Math.random() < useChance) {
                // G4: 选择最有利的卡牌
                const bestCard = this.selectBestCard(player, land.owner ?? 0, engine);
                if (bestCard !== undefined) {
                  const card = (cardsData as any[])[bestCard];
                  if (card?.targetType === "other_player") {
                    return { action: "use_card", params: { cardId: bestCard, targetId: land.owner } };
                  }
                  return { action: "use_card", params: { cardId: bestCard } };
                }
              }
            }
            return { action: "end_turn" };
          }
        }

        // 设施
        if (node.tileType === "facility") {
          const facility = engine.getMap().facilities.find(f => f.id === node.id);
          if (facility) {
            if (facility.type === "shop") {
              // G4: 商店 — 评估是否需要道具
              if (player.cash > 5000 && player.tools.length < 3) {
                // 选择对当前局势最有用的道具
                const toolId = this.selectBestTool(engine, player);
                if (toolId >= 0) {
                  return { action: "shop_buy", params: { toolId } };
                }
              }
            }
            if (facility.type === "bank") {
              // G12: 银行 — 智能存取款+贷款
              if (player.cash > 20000 && player.moneyInBank < player.cash) {
                const depositAmount = Math.floor((player.cash - 15000) * 0.7);
                if (depositAmount > 0) {
                  return { action: "bank_deposit", params: { amount: depositAmount } };
                }
              } else if (player.cash < 3000) {
                if (player.moneyInBank > 5000) {
                  return { action: "bank_withdraw", params: { amount: 5000 } };
                } else if (player.loan === 0 && player.daysBankNoLoans === 0) {
                  // G28: 检查银行拒绝期
                  return { action: "bank_loan", params: { amount: 10000 } };
                }
              }
            }
            // G24: 机场 — AI 不使用机场传送
            // G25: 商业地块 — AI 不主动购买保险/商业地块
          }
        }

        // G25: 商业地块
        if (node.tileType === "commercial") {
          // AI 不主动购买商业地块，跳过
          return { action: "end_turn" };
        }

        return { action: "end_turn" };
      }

      case "auction": {
        // G4: AI 拍卖决策
        const auction = engine.getAuctionSystem();
        const state = auction.getState();
        if (!state) return { action: "end_turn" };

        const land = engine.getProperty().getLand(state.landIndex);
        if (!land) return { action: "auction_pass" };

        // 评估地块价值
        const landValue = this.evaluateLandValue(land, state.landIndex, engine, player);
        const maxBid = Math.floor(land.landPrice * (this.difficulty === "easy" ? 0.8 : this.difficulty === "normal" ? 1.0 : 1.2));

        if (player.cash > maxBid && landValue > 0) {
          const bidAmount = Math.min(state.currentBid + Math.floor(land.landPrice * 0.1), maxBid);
          if (bidAmount > state.currentBid) {
            return { action: "auction_bid", params: { amount: bidAmount } };
          }
        }
        return { action: "auction_pass" };
      }

      case "bank":
        // G12: AI 银行决策 — 闲钱存款或现金不足时取款/贷款
        if (player.cash > 20000 && player.moneyInBank < player.cash) {
          const depositAmount = Math.floor((player.cash - 15000) * 0.7);
          if (depositAmount > 0) return { action: "bank_deposit", params: { amount: depositAmount } };
        } else if (player.cash < 3000) {
          if (player.moneyInBank > 5000) {
            return { action: "bank_withdraw", params: { amount: 5000 } };
          } else if (player.loan === 0 && player.daysBankNoLoans === 0) {
            // G28: 检查银行拒绝期
            return { action: "bank_loan", params: { amount: 10000 } };
          }
        }
        // G12: 有闲钱时考虑买股票
        if (player.cash > 30000) {
          const stockDecision = this.decideStockAction(engine, player);
          if (stockDecision) return stockDecision;
        }
        return { action: "end_turn" };

      case "shop":
        // G12: AI 商店 — 评估是否需要道具
        if (player.cash > 5000 && player.tools.length < 5) {
          const toolId = this.selectBestTool(engine, player);
          if (toolId >= 0) {
            return { action: "shop_buy", params: { toolId } };
          }
        }
        return { action: "end_turn" };

      case "magic":
      case "fortune":
        return { action: "end_turn" };

      default:
        return { action: "end_turn" };
    }
  }

  /** G4: 评估地产价值（0-1000分） */
  private evaluateLandValue(land: any, landIndex: number, engine: GameEngine, player: Player): number {
    let score = 0;

    // 基础价值 = 地价（越贵越好）
    score += land.landPrice * 0.01;

    // 连锁店加分
    if (land.isChainStore) score += 200;

    // 相邻自己的地加分（连锁潜力）
    const node = engine.getMap().nodes.find(n => n.id === land.id);
    if (node) {
      for (const adjId of node.adjacent) {
        const adjLand = engine.getMap().lands.find(l => l.id === adjId);
        if (adjLand && adjLand.owner === player.id) {
          score += 150; // 相邻自己的地
        }
      }
    }

    // 过路费收益评估
    const tolls = land.tolls || [];
    const maxToll = Math.max(...tolls, 0);
    score += maxToll * 0.3;

    // 资金充裕度调整
    if (player.cash < land.landPrice * 1.5) {
      score *= 0.3; // 买不起，价值降低
    }

    return Math.floor(score);
  }

  /** G4: 选择最有利的卡牌 */
  private selectBestCard(player: Player, _targetId: number, _engine: GameEngine): number | undefined {
    if (player.cards.length === 0) return undefined;
    // 简单策略：优先使用攻击类卡牌对最富有对手
    // 目前直接取第一张（后续可扩展）
    const card = player.cards[0];
    return card !== undefined ? card : undefined;
  }

  /** G4: 选择对当前局势最有用的道具 */
  private selectBestTool(_engine: GameEngine, _player: Player): number {
    // 优先路障 → 地雷 → 其他
    const priority = [2, 3, 0, 1, 4]; // toolIds
    for (const id of priority) {
      const tool = (toolsData as any[]).find(t => t.id === id);
      if (tool && _engine.getShopSystem().getToolStock(id) > 0) {
        return id;
      }
    }
    return Math.floor(Math.random() * 5);
  }

  /** G12: AI 股票决策 — 低买高卖 */
  private decideStockAction(engine: GameEngine, player: Player): AIDecision | null {
    const stockSystem = engine.getStockSystem();
    const prices = stockSystem.getAllPrices();
    if (prices.length === 0) return null;

    // 检查现有持仓：如果盈利超过20%就卖出
    const holdings = stockSystem.getHoldings(player.id);
    for (const h of holdings) {
      const stock = prices.find(p => p.id === h.stockId);
      if (stock && stock.price > h.avgCost * 1.2) {
        return { action: "stock_sell", params: { stockId: h.stockId, amount: h.amount } };
      }
    }

    // 没有持仓或持仓未达卖出条件：寻找价格下跌的股票买入（低买）
    const stockChance = this.difficulty === "easy" ? 0.2 : this.difficulty === "normal" ? 0.35 : 0.5;
    if (Math.random() < stockChance) {
      // 找价格低于上一回合的股票（跌了就买）
      const dipStock = prices.find(s => s.price < s.prevPrice && s.price > 5);
      if (dipStock) {
        const buyAmount = Math.min(Math.floor(player.cash * 0.2 / dipStock.price), 100);
        if (buyAmount > 0) {
          return { action: "stock_buy", params: { stockId: dipStock.id, amount: buyAmount } };
        }
      }
      // 没有跌的股票，随机买一只波动率高的
      const volatile = [...prices].sort((a, b) => b.volatility - a.volatility)[0];
      if (volatile) {
        const buyAmount = Math.min(Math.floor(player.cash * 0.15 / volatile.price), 50);
        if (buyAmount > 0) {
          return { action: "stock_buy", params: { stockId: volatile.id, amount: buyAmount } };
        }
      }
    }
    return null;
  }

  /** 执行 AI 决策 */
  executeDecision(engine: GameEngine, player: Player, decision: AIDecision): void {
    switch (decision.action) {
      case "roll":
        engine.rollDice();
        break;
      case "buy_land":
        if (decision.params?.landIndex !== undefined) {
          engine.buyLand(decision.params.landIndex);
        }
        break;
      case "upgrade":
        if (decision.params?.landIndex !== undefined) {
          engine.upgradeLand(decision.params.landIndex);
        }
        break;
      case "skip":
        engine.skipAction();
        break;
      case "use_card":
        if (decision.params?.cardId !== undefined) {
          engine.useCard(decision.params.cardId, decision.params.targetId);
        }
        break;
      case "use_tool":
        if (decision.params?.toolId !== undefined) {
          engine.useToolItem(decision.params.toolId, decision.params.targetId);
        }
        break;
      case "shop_buy":
        if (decision.params?.toolId !== undefined) {
          engine.shopBuyTool(decision.params.toolId);
        }
        break;
      case "bank_deposit":
        if (decision.params?.amount !== undefined) {
          engine.bankDeposit(decision.params.amount);
        }
        break;
      case "bank_withdraw":
        if (decision.params?.amount !== undefined) {
          engine.bankWithdraw(decision.params.amount);
        }
        break;
      case "bank_loan":
        if (decision.params?.amount !== undefined) {
          engine.bankLoan(decision.params.amount);
        }
        break;
      case "stock_buy":
        if (decision.params?.stockId !== undefined && decision.params?.amount !== undefined) {
          engine.buyStock(decision.params.stockId, decision.params.amount);
        }
        break;
      case "stock_sell":
        if (decision.params?.stockId !== undefined && decision.params?.amount !== undefined) {
          engine.sellStock(decision.params.stockId, decision.params.amount);
        }
        break;
      case "end_turn":
        engine.endTurn();
        break;
    }
  }
}
