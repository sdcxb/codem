/**
 * FacilitySystem — 设施逻辑系统
 * 管理银行、医院、监狱、商店、公园、魔法屋、酒店、加油站等设施交互
 */

import type { GameEvent } from "../types";
import type { GameEngine } from "./GameEngine";
import type { Player } from "./Player";
import type { ShopSystem } from "./ShopSystem";

export interface FacilityResult {
  message: string;
  events?: GameEvent[];
  needsUI?: "bank" | "shop" | "magic_house" | "auction" | "fortune" | "news";
}

export class FacilitySystem {
  private shopSystem: ShopSystem;
  private priceIndex: number = 1000;

  constructor(shopSystem: ShopSystem) {
    this.shopSystem = shopSystem;
  }

  updatePriceIndex(index: number): void {
    this.priceIndex = Math.max(200, index);
    this.shopSystem.updatePriceIndex(index);
  }

  /** 银行交互 */
  handleBank(player: Player, action: BankAction, amount: number = 0): FacilityResult {
    switch (action) {
      case "deposit":
        return this.bankDeposit(player, amount);
      case "withdraw":
        return this.bankWithdraw(player, amount);
      case "loan":
        return this.bankLoan(player, amount);
      case "repay":
        return this.bankRepay(player, amount);
      default:
        return { message: "未知银行操作" };
    }
  }

  private bankDeposit(player: Player, amount: number): FacilityResult {
    if (!player.spendMoney(amount)) {
      return { message: `${player.name} 现金不足，无法存 ${amount}` };
    }
    player.moneyInBank += amount;
    return { message: `${player.name} 存入银行 ${amount}` };
  }

  private bankWithdraw(player: Player, amount: number): FacilityResult {
    if (player.moneyInBank < amount) {
      return { message: `${player.name} 存款不足，无法取 ${amount}` };
    }
    player.moneyInBank -= amount;
    player.addMoney(amount);
    return { message: `${player.name} 从银行取出 ${amount}` };
  }

  private bankLoan(player: Player, amount: number): FacilityResult {
    if (player.daysRejectedByBank > 0) {
      return { message: `${player.name} 被银行拒绝，无法贷款` };
    }
    // G28: 银行拒绝贷款期检查
    if (player.daysBankNoLoans > 0) {
      return { message: `${player.name} 被银行审查中，${player.daysBankNoLoans}天内不可贷款` };
    }
    // 贷款上限 = 现金 × 2 + 已有存款
    const maxLoan = (player.cash + player.moneyInBank) * 2;
    if (player.loan + amount > maxLoan) {
      return { message: `贷款额度不足，最多可贷 ${maxLoan - player.loan}` };
    }
    player.loan += amount;
    player.addMoney(amount);
    return { message: `${player.name} 贷款 ${amount}，总贷款 ${player.loan}` };
  }

  private bankRepay(player: Player, amount: number): FacilityResult {
    if (player.loan <= 0) {
      return { message: `${player.name} 没有贷款` };
    }
    const repayAmount = Math.min(amount, player.loan, player.cash);
    if (repayAmount <= 0) {
      return { message: `${player.name} 现金不足，无法还款` };
    }
    player.spendMoney(repayAmount);
    player.loan -= repayAmount;
    return { message: `${player.name} 还款 ${repayAmount}，剩余贷款 ${player.loan}` };
  }

  /** 银行存款利息（每回合调用） */
  bankInterest(player: Player): FacilityResult {
    if (player.moneyInBank > 0) {
      const interest = Math.floor(player.moneyInBank * 0.05); // 5%利息
      player.moneyInBank += interest;
      return { message: `${player.name} 获得利息 ${interest}` };
    }
    return { message: "" };
  }

  /** 银行贷款利息（每回合调用） */
  bankLoanInterest(player: Player): FacilityResult {
    if (player.loan > 0) {
      const interest = Math.floor(player.loan * 0.1); // 10%利息
      player.loan += interest;
      return { message: `${player.name} 贷款利息增加 ${interest}` };
    }
    return { message: "" };
  }

  /** 医院交互 */
  handleHospital(player: Player): FacilityResult {
    if (player.daysInHospital > 0) {
      return {
        message: `${player.name} 正在住院，剩余 ${player.daysInHospital} 天`,
      };
    }
    // 被送进医院
    player.daysInHospital = 3;
    return {
      message: `${player.name} 被送进医院，需住院3天`,
      events: [{ type: "enter_hospital", data: { playerId: player.id } }],
    };
  }

  /** 监狱交互 */
  handlePrison(player: Player): FacilityResult {
    if (player.daysInPrison > 0) {
      return {
        message: `${player.name} 正在服刑，剩余 ${player.daysInPrison} 天`,
      };
    }
    // 检查免罪符
    if (player.daysRejectedByBank === -1) {
      player.daysRejectedByBank = 0; // 消耗免罪符
      return { message: `${player.name} 使用免罪符，免于入狱` };
    }
    player.daysInPrison = 3;
    return {
      message: `${player.name} 被关进监狱，需服刑3天`,
      events: [{ type: "enter_prison", data: { playerId: player.id } }],
    };
  }

  /** 公园交互 */
  handlePark(player: Player): FacilityResult {
    // 公园休息，回复精力/随机小奖
    const bonus = Math.floor(Math.random() * 1000) + 500;
    player.addMoney(bonus);
    return { message: `${player.name} 在公园休息，捡到 ${bonus}` };
  }

  /** 酒店摇号 */
  handleHotel(player: Player): FacilityResult {
    const multiplier = Math.floor(Math.random() * 3) + 2; // 2-4倍
    const baseCost = 500;
    const cost = baseCost * multiplier * (this.priceIndex / 1000);

    if (player.daysAssurance > 0) {
      // 有保险免赔
      return { message: `${player.name} 有保险，免于住酒店费用` };
    }

    const actualCost = Math.floor(cost);
    if (player.spendMoney(actualCost)) {
      player.daysInHotel = multiplier;
      return {
        message: `${player.name} 住酒店${multiplier}天，花费 ${actualCost}`,
        events: [{ type: "enter_hotel", data: { playerId: player.id, days: multiplier, cost: actualCost } }],
      };
    } else {
      // 住不起也要住，变负
      player.cash -= actualCost;
      player.daysInHotel = multiplier;
      return {
        message: `${player.name} 住酒店${multiplier}天，欠费 ${actualCost}`,
        events: [{ type: "enter_hotel", data: { playerId: player.id, days: multiplier, cost: actualCost } }],
      };
    }
  }

  /** 加油站 */
  handleGasStation(player: Player): FacilityResult {
    if (player.trafficMethod === 0) {
      return { message: `${player.name} 步行经过加油站，无需加油` };
    }

    const baseGasCost = player.trafficMethod === 1 ? 200 : 300; // 机车200，汽车300
    const gasCost = Math.floor(baseGasCost * (this.priceIndex / 1000));

    if (player.spendMoney(gasCost)) {
      return {
        message: `${player.name} 加油花费 ${gasCost}`,
        events: [{ type: "gas_station", data: { playerId: player.id, cost: gasCost } }],
      };
    } else {
      // 加不起油，降级为步行
      player.setTraffic(0);
      return {
        message: `${player.name} 加不起油，改为步行`,
        events: [{ type: "traffic_downgraded", data: { playerId: player.id, method: 0 } }],
      };
    }
  }

  /** 魔法屋 — 随机效果 */
  handleMagicHouse(player: Player): FacilityResult {
    const effect = Math.floor(Math.random() * 12);
    switch (effect) {
      case 0: { // 小财神
        player.godInfo = 1;
        return { message: `魔法屋: ${player.name} 获得小财神保佑` };
      }
      case 1: { // 大财神
        player.godInfo = 2;
        return { message: `魔法屋: ${player.name} 获得大财神保佑` };
      }
      case 2: { // 小穷神
        player.godInfo = 5;
        return { message: `魔法屋: ${player.name} 被小穷神附身` };
      }
      case 3: { // 大穷神
        player.godInfo = 6;
        return { message: `魔法屋: ${player.name} 被大穷神附身` };
      }
      case 4: { // 获得现金
        const amount = Math.floor(Math.random() * 5000) + 2000;
        player.addMoney(amount);
        return { message: `魔法屋: ${player.name} 获得 ${amount} 现金` };
      }
      case 5: { // 失去现金
        const amount = Math.floor(Math.random() * 3000) + 1000;
        player.spendMoney(amount);
        return { message: `魔法屋: ${player.name} 失去 ${amount} 现金` };
      }
      case 6: { // 获得道具
        const toolId = Math.floor(Math.random() * 10);
        player.addTool(toolId, 1);
        return { message: `魔法屋: ${player.name} 获得一个随机道具` };
      }
      case 7: { // 获得卡牌
        const cardId = Math.floor(Math.random() * 20);
        player.addCard(cardId);
        return { message: `魔法屋: ${player.name} 获得一张随机卡牌` };
      }
      case 8: { // 传送回起点
        player.positionNodeId = 0; // 假设起点为0
        return { message: `魔法屋: ${player.name} 被传送回起点` };
      }
      case 9: { // 停留
        player.daysStopping = 1;
        return { message: `魔法屋: ${player.name} 被停留1回合` };
      }
      case 10: { // 升级交通
        if (player.trafficMethod < 2) {
          player.setTraffic((player.trafficMethod + 1) as 0 | 1 | 2);
          return { message: `魔法屋: ${player.name} 交通升级` };
        }
        return { message: `魔法屋: ${player.name} 交通已满级` };
      }
      default: { // 获得点券
        const pts = Math.floor(Math.random() * 3000) + 1000;
        player.points += pts;
        return { message: `魔法屋: ${player.name} 获得 ${pts} 点券` };
      }
    }
  }

  /** 命运转盘 — 随机事件 */
  handleFortune(player: Player, fortuneId: number): FacilityResult {
    const events = [
      () => { const a = 20000; player.addMoney(a); return { message: `${player.name} 天降横财 ${a}` }; },
      () => { const a = 15000; player.addMoney(a); return { message: `${player.name} 中奖 ${a}` }; },
      () => { const a = 30000; player.addMoney(a); return { message: `${player.name} 遗产继承 ${a}` }; },
      () => { const a = 10000; player.addMoney(a); return { message: `${player.name} 意外之财 ${a}` }; },
      () => { const a = 8000; player.addMoney(a); return { message: `${player.name} 医疗补助 ${a}` }; },
      () => { player.godInfo = 1; return { message: `${player.name} 获得小财神保佑` }; },
      () => { player.godInfo = 2; return { message: `${player.name} 获得大财神保佑` }; },
      () => { player.points += 5000; return { message: `${player.name} 获得 5000 点券` }; },
    ];
    const idx = fortuneId % events.length;
    return events[idx]();
  }

  /** 新闻中心 — 全局事件 */
  handleNews(engine: GameEngine, newsId: number): FacilityResult {
    const players = engine.getPlayers();
    switch (newsId % 10) {
      case 0: { // 经济危机
        for (const p of players) {
          const loss = Math.floor(p.cash * 0.1);
          p.spendMoney(loss);
        }
        return { message: "新闻: 经济危机！所有玩家现金减少10%" };
      }
      case 1: { // 股市暴跌
        // 通知引擎处理股票
        return {
          message: "新闻: 股市暴跌！所有股票下跌30%",
          events: [{ type: "stock_crash", data: { percent: 30 } }],
        };
      }
      case 2: { // 股市飙升
        return {
          message: "新闻: 股市飙升！所有股票上涨50%",
          events: [{ type: "stock_boom", data: { percent: 50 } }],
        };
      }
      case 3: { // 物价飞涨
        this.priceIndex += 200;
        return {
          message: "新闻: 物价飞涨！物价指数+200",
          events: [{ type: "price_index_up", data: { amount: 200 } }],
        };
      }
      case 4: { // 税收减免
        for (const p of players) {
          p.addMoney(3000);
        }
        return { message: "新闻: 税收减免！所有玩家获得3000" };
      }
      case 5: { // 街头抢劫
        const richest = [...players].sort((a, b) => b.cash - a.cash)[0];
        if (richest) {
          const loss = Math.floor(richest.cash * 0.15);
          richest.spendMoney(loss);
          return { message: `新闻: 街头抢劫！${richest.name} 损失 ${loss}` };
        }
        return { message: "新闻: 街头抢劫（无人）" };
      }
      case 6: { // 彩票开奖
        const winner = players[Math.floor(Math.random() * players.length)];
        if (winner) {
          winner.addMoney(20000);
          return { message: `新闻: 彩票开奖！${winner.name} 获得 20000` };
        }
        return { message: "新闻: 彩票开奖（无人中奖）" };
      }
      case 7: { // 道路施工
        return {
          message: "新闻: 道路施工！随机地块查封3天",
          events: [{ type: "random_seal", data: { days: 3 } }],
        };
      }
      case 8: { // 节日庆典
        for (const p of players) {
          p.points += 5000;
        }
        return { message: "新闻: 节日庆典！所有玩家获得5000点券" };
      }
      default: { // 房价大涨
        return {
          message: "新闻: 房价大涨！所有地产过路费翻倍3天",
          events: [{ type: "all_toll_double", data: { days: 3 } }],
        };
      }
    }
  }

  /** 商店交互 — 委托给 ShopSystem */
  getShopSystem(): ShopSystem {
    return this.shopSystem;
  }
}

type BankAction = "deposit" | "withdraw" | "loan" | "repay";
