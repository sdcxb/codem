/**
 * Player — 玩家实体
 * 移植自大富翁4 player_info 结构，包含完整状态字段
 */

import type { PlayerState, PlayerStatus, TrafficMethod } from "../types";
import { Dice } from "./Dice";

export class Player implements PlayerState {
  id: number;
  name: string;
  color: string;
  characterId: number;
  cash: number;
  moneyInBank: number;
  loan: number;
  specialFinance: number;
  points: number;
  positionNodeId: number;
  lastNodeId: number;
  direction: number;
  trafficMethod: TrafficMethod;
  numDices: number;
  isAI: boolean;
  status: PlayerStatus;

  daysInHotel = 0;
  daysInPrison = 0;
  daysInHospital = 0;
  daysSleeping = 0;
  daysSleepWalking = 0;
  daysStopping = 0;
  daysTortoiseWalking = 0;
  daysRejectedByBank = 0;
  daysBankNoLoans = 0;
  alliedDays = 0;
  alliedPlayer = 0;
  daysAssurance = 0;
  godInfo = 0;

  hostility: number[] = [0, 0, 0, 0, 0, 0];

  properties: number[] = [];
  cards: number[] = [];
  tools: { id: number; amount: number }[] = [];

  diceProphecy: number | null = null;

  constructor(
    id: number,
    name: string,
    color: string,
    characterId: number,
    startNodeId: number,
    initCash: number,
    isAI: boolean,
  ) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.characterId = characterId;
    this.cash = initCash;
    this.moneyInBank = 0;
    this.loan = 0;
    this.specialFinance = 0;
    this.points = 0;
    this.positionNodeId = startNodeId;
    this.lastNodeId = startNodeId;
    this.direction = 1;
    this.trafficMethod = 0;
    this.numDices = 1;
    this.isAI = isAI;
    this.status = "active";
  }

  /** 设置交通方式 */
  setTraffic(method: TrafficMethod): void {
    this.trafficMethod = method;
    this.numDices = method + 1;
  }

  /** 掷骰子 */
  rollDices(): number[] {
    return Dice.rollMultiple(this.numDices, this.diceProphecy);
  }

  /** 获取总财富 */
  getWealth(landValues: number[], stockValues: number): number {
    let total = this.cash + this.moneyInBank - this.loan + stockValues;
    for (const idx of this.properties) {
      total += landValues[idx] || 0;
    }
    return Math.floor(total);
  }

  /** 是否可以行动 */
  canAct(): boolean {
    return this.status === "active"
      && this.daysSleeping === 0
      && this.daysSleepWalking === 0
      && this.daysStopping === 0
      && this.daysTortoiseWalking === 0;
  }

  /** 回合开始时更新状态天数 */
  tickStatus(): void {
    if (this.daysInHotel > 0) this.daysInHotel--;
    if (this.daysInPrison > 0) this.daysInPrison--;
    if (this.daysInHospital > 0) this.daysInHospital--;
    if (this.daysSleeping > 0) this.daysSleeping--;
    if (this.daysSleepWalking > 0) this.daysSleepWalking--;
    if (this.daysStopping > 0) this.daysStopping--;
    if (this.daysTortoiseWalking > 0) this.daysTortoiseWalking--;
    if (this.daysRejectedByBank > 0) this.daysRejectedByBank--;
    if (this.daysBankNoLoans > 0) this.daysBankNoLoans--;
    if (this.alliedDays > 0) this.alliedDays--;
    if (this.daysAssurance > 0) this.daysAssurance--;
  }

  /** 获取移动步数（乌龟卡减半） */
  getMoveSteps(diceSum: number): number {
    if (this.daysTortoiseWalking > 0) {
      return Math.ceil(diceSum / 2);
    }
    return diceSum;
  }

  /** 添加金钱 */
  addMoney(amount: number): void {
    this.cash += amount;
  }

  /** 扣除金钱，返回是否成功 */
  spendMoney(amount: number): boolean {
    if (this.cash >= amount) {
      this.cash -= amount;
      return true;
    }
    return false;
  }

  /** 添加卡牌（上限4张） */
  addCard(cardId: number): boolean {
    if (this.cards.length >= 4) return false;
    this.cards.push(cardId);
    return true;
  }

  /** 移除卡牌 */
  removeCard(cardId: number): boolean {
    const idx = this.cards.indexOf(cardId);
    if (idx === -1) return false;
    this.cards.splice(idx, 1);
    return true;
  }

  /** 添加道具 */
  addTool(toolId: number, amount: number = 1, maxAmount: number = 9): boolean {
    const existing = this.tools.find(t => t.id === toolId);
    if (existing) {
      if (existing.amount + amount > maxAmount) return false;
      existing.amount += amount;
    } else {
      this.tools.push({ id: toolId, amount });
    }
    return true;
  }

  /** 使用道具（消耗1个） */
  useTool(toolId: number): boolean {
    const existing = this.tools.find(t => t.id === toolId);
    if (!existing || existing.amount <= 0) return false;
    existing.amount--;
    if (existing.amount <= 0) {
      this.tools = this.tools.filter(t => t.id !== toolId);
    }
    return true;
  }

  /** 获取道具数量 */
  getToolAmount(toolId: number): number {
    return this.tools.find(t => t.id === toolId)?.amount || 0;
  }

  /** 检查是否破产 */
  isBankrupt(): boolean {
    return this.cash < 0 && this.moneyInBank <= 0;
  }

  /** 序列化为纯数据 */
  toState(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      characterId: this.characterId,
      cash: this.cash,
      moneyInBank: this.moneyInBank,
      loan: this.loan,
      specialFinance: this.specialFinance,
      points: this.points,
      positionNodeId: this.positionNodeId,
      lastNodeId: this.lastNodeId,
      direction: this.direction,
      trafficMethod: this.trafficMethod,
      numDices: this.numDices,
      isAI: this.isAI,
      status: this.status,
      daysInHotel: this.daysInHotel,
      daysInPrison: this.daysInPrison,
      daysInHospital: this.daysInHospital,
      daysSleeping: this.daysSleeping,
      daysSleepWalking: this.daysSleepWalking,
      daysStopping: this.daysStopping,
      daysTortoiseWalking: this.daysTortoiseWalking,
      daysRejectedByBank: this.daysRejectedByBank,
      daysBankNoLoans: this.daysBankNoLoans,
      alliedDays: this.alliedDays,
      alliedPlayer: this.alliedPlayer,
      daysAssurance: this.daysAssurance,
      godInfo: this.godInfo,
      hostility: [...this.hostility],
      properties: [...this.properties],
      cards: [...this.cards],
      tools: this.tools.map(t => ({ ...t })),
      diceProphecy: this.diceProphecy,
    };
  }
}

