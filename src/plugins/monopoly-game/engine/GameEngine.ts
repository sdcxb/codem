/**
 * GameEngine — 大富翁游戏核心引擎
 * 管理游戏状态、回合流程、玩家移动、事件触发
 */

import type {
  GameBoardMap,
  GameConfig,
  GameEvent,
  GameEventListener,
  GamePhase,
  HUDState,
  PlayerState,
  StockDef,
  CardDef,
  ToolDef,
  LandTile,
} from "../types";
import { Player } from "./Player";
import { Property } from "./Property";
import { Dice } from "./Dice";
import { CardSystem } from "./CardSystem";
import { ToolSystem } from "./ToolSystem";
import { ShopSystem } from "./ShopSystem";
import { AuctionSystem } from "./AuctionSystem";
import { FacilitySystem } from "./FacilitySystem";
import { FortuneSystem } from "./FortuneSystem";
import { StockSystem } from "./StockSystem";
import { BankruptcySystem } from "./BankruptcySystem";
import { AIPlayer } from "./AIPlayer";
import { SaveLoadSystem, type SaveData } from "./SaveLoadSystem";
import cardData from "../data/cards.json";
import toolData from "../data/tools.json";
import charactersData from "../data/characters.json";

export class GameEngine {
  private map: GameBoardMap;
  private config: GameConfig;
  private players: Player[];
  private property: Property;
  private stocks: StockDef[];
  private stockPrices: Map<number, number> = new Map();
  private playerStocks: Map<number, { stockId: number; amount: number; avgCost: number }[]> = new Map();
  private dice: Dice;
  private cardSystem: CardSystem;
  private toolSystem: ToolSystem;
  private shopSystem: ShopSystem;
  private auctionSystem: AuctionSystem;
  private facilitySystem: FacilitySystem;
  private fortuneSystem: FortuneSystem;
  private stockSystem: StockSystem;
  private bankruptcySystem: BankruptcySystem;
  private aiPlayer: AIPlayer;

  private currentPlayerIdx = 0;
  private round = 1;
  private totalRounds: number;
  private date = 1;
  private priceIndex = 1000;
  private initCash: number = 15000;
  private winningMultiplier: number = -1; // G23: -1 = 破产模式(最后存活者胜), 0 = 不启用, >0 = wealth >= initCash × multiplier 即胜利

  private phase: GamePhase = "idle";
  private diceValues: number[] = [];
  private message = "";
  private log: string[] = [];
  private logColors: string[] = []; // G33: 每条日志的颜色标识
  private listeners: GameEventListener[] = [];
  private humanCharId: number = 0;
  private pendingMoveSteps = 0;

  constructor(map: GameBoardMap, config: GameConfig, stocks: StockDef[] = [], humanCharId: number = 0) {
    this.map = map;
    this.config = config;
    this.stocks = stocks;
    this.totalRounds = config.gameDays[0] || 30;
    this.initCash = config.initialFunds[0] || 15000;
    // G23: 胜利条件 — 默认不启用(0)，需外部设置
    this.winningMultiplier = 0;
    this.dice = new Dice();
    this.humanCharId = humanCharId;

    // 初始化地产
    this.property = new Property(map.lands, map.commercials);

    // 初始化子系统
    this.cardSystem = new CardSystem(cardData as CardDef[]);
    this.toolSystem = new ToolSystem(toolData as ToolDef[]);
    this.shopSystem = new ShopSystem(cardData as CardDef[], toolData as ToolDef[]);
    this.auctionSystem = new AuctionSystem();
    this.facilitySystem = new FacilitySystem(this.shopSystem);
    this.fortuneSystem = new FortuneSystem();
    this.stockSystem = new StockSystem(stocks);
    this.bankruptcySystem = new BankruptcySystem();
    this.aiPlayer = new AIPlayer();

    // 初始化股票价格
    for (const stock of stocks) {
      this.stockPrices.set(stock.id, stock.initPrice);
    }

    // G3: 创建玩家 — 应用角色差异化
    const initCash = config.initialFunds[0] || 15000;
    const colors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c"];
    const charNames = ["玩家1", "玩家2", "玩家3", "玩家4", "玩家5", "玩家6"];
    const characters = charactersData as any[];
    this.players = [];
    const numHuman = config.numPlayers - config.numAI;
    for (let i = 0; i < config.numPlayers; i++) {
      const isAI = i >= numHuman;
      // 人类玩家用选中的角色，AI 随机选角色
      const charId = isAI ? Math.floor(Math.random() * characters.length) : humanCharId;
      const charDef = characters[charId] || characters[0];
      const playerCash = Math.floor(initCash * (charDef.initCashRatio || 1.0));
      const player = new Player(
        i,
        isAI ? `${charDef.name}AI` : `${charDef.name}`,
        charDef.color || colors[i] || "#888",
        charId,
        map.startNodeId,
        playerCash,
        isAI,
      );
      // 存储角色特殊属性供引擎使用
      (player as any).characterSpecial = charDef.special || "";
      this.players.push(player);
    }
  }

  // ===== 事件系统 =====

  on(listener: GameEventListener): void {
    this.listeners.push(listener);
  }

  off(listener: GameEventListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  private emit(event: GameEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private setMessage(msg: string, color: string = ""): void {
    this.message = msg;
    this.log.push(`[Round ${this.round}] ${msg}`);
    this.logColors.push(color);
    if (this.log.length > 200) {
      this.log.shift();
      this.logColors.shift();
    }
  }

  // G33: 获取日志颜色数组
  getLogColors(): string[] {
    return [...this.logColors];
  }

  // ===== 游戏流程 =====

  start(): void {
    this.phase = "rolling";
    this.currentPlayerIdx = 0;
    this.round = 1;
    this.setMessage(`游戏开始！总回合数: ${this.totalRounds}`);
    this.emit({ type: "game_start", data: this.getHUDState() });
  }

  /** 当前玩家掷骰子 */
  rollDice(): number[] {
    if (this.phase !== "rolling") return [];
    const player = this.getCurrentPlayer();

    // 先检查是否因状态无法行动（住院、监狱、酒店、沉睡等）
    if (player.daysInHospital > 0) {
      this.setMessage(`${player.name} 住院中，剩余 ${player.daysInHospital} 天`);
      player.tickStatus();
      this.endTurn();
      return [];
    }
    if (player.daysInPrison > 0) {
      this.setMessage(`${player.name} 服刑中，剩余 ${player.daysInPrison} 天`);
      player.tickStatus();
      this.endTurn();
      return [];
    }
    if (player.daysInHotel > 0) {
      this.setMessage(`${player.name} 住宿中，剩余 ${player.daysInHotel} 天`);
      player.tickStatus();
      this.endTurn();
      return [];
    }
    if (player.daysSleeping > 0) {
      this.setMessage(`${player.name} 沉睡中，跳过回合`);
      player.tickStatus();
      this.endTurn();
      return [];
    }
    if (player.daysStopping > 0) {
      this.setMessage(`${player.name} 被停留，跳过回合`);
      player.tickStatus();
      this.endTurn();
      return [];
    }

    // 正常行动 — 更新状态天数
    player.tickStatus();

    this.diceValues = player.rollDices();
    this.phase = "moving";
    this.setMessage(`${player.name} 掷出 ${this.diceValues.join(" + ")} = ${Dice.sum(this.diceValues)}`);
    this.emit({ type: "dice_rolled", data: { values: this.diceValues, sum: Dice.sum(this.diceValues) } });

    // 计算移动步数
    this.pendingMoveSteps = player.getMoveSteps(Dice.sum(this.diceValues));

    // 检查特殊状态
    if (player.daysSleepWalking > 0) {
      this.setMessage(`${player.name} 梦游中，随机移动！`);
      // 梦游：随机方向随机步数
      this.pendingMoveSteps = Math.floor(Math.random() * 6) + 1;
    }

    // 交通事故检查（开车/机车时）
    this.checkTrafficAccident(player);

    return this.diceValues;
  }

  /** 移动玩家一步 */
  moveStep(): boolean {
    if (this.phase !== "moving" || this.pendingMoveSteps <= 0) return false;
    const player = this.getCurrentPlayer();
    const node = this.map.nodes[player.positionNodeId];
    if (!node || node.adjacent.length === 0) return false;

    // G2: 分岔路口检测 — 排除来路后仍有 >1 个选择时，需要玩家选方向
    const availableNext = node.adjacent.filter(id => id !== player.lastNodeId);
    if (availableNext.length > 1 && player.daysSleepWalking === 0) {
      // 进入分岔选择阶段，等待玩家/AI 选方向
      this.phase = "branch";
      const choices = availableNext.map(id => {
        const targetNode = this.map.nodes[id];
        return { nodeId: id, name: this.getNodeName(id), x: targetNode?.x || 0, y: targetNode?.y || 0 };
      });
      this.setMessage(`${player.name} 到达路口，请选择方向`);
      this.emit({ type: "prompt_branch", data: { playerId: player.id, currentNodeId: node.id, choices, remainingSteps: this.pendingMoveSteps } });

      // AI 自动选择
      if (player.isAI) {
        const aiChoice = this.aiPlayer.chooseBranch(choices, player, this);
        this.chooseBranch(aiChoice);
      }
      return false; // 暂停移动，等待选择
    }

    // 选择下一个节点（排除来路优先；只有来路时走来路 = 掉头）
    let nextNodeId: number;
    if (availableNext.length === 1) {
      nextNodeId = availableNext[0];
    } else if (availableNext.length === 0) {
      // 死胡同，掉头
      nextNodeId = node.adjacent[0];
    } else {
      // 梦游状态随机选
      nextNodeId = availableNext[Math.floor(Math.random() * availableNext.length)];
    }

    player.lastNodeId = player.positionNodeId;
    player.positionNodeId = nextNodeId;
    this.pendingMoveSteps--;

    this.emit({ type: "player_moved", data: { playerId: player.id, nodeId: nextNodeId } });

    // ===== 经过型触发（仅在移动中，非到达时） =====
    if (this.pendingMoveSteps > 0) {
      this.handlePassThrough(player, nextNodeId);
    }

    // 检查路障 — 停止移动
    if (this.toolSystem.hasRoadblock(nextNodeId)) {
      this.toolSystem.removeToolAt(nextNodeId, 2);
      this.pendingMoveSteps = 0;
      this.setMessage(`${player.name} 踩到路障，停止移动！`);
      this.emit({ type: "hit_roadblock", data: { playerId: player.id, nodeId: nextNodeId } });
    }

    // 检查地雷 — 受伤送医院
    if (this.toolSystem.hasLandmine(nextNodeId)) {
      this.toolSystem.removeToolAt(nextNodeId, 3);
      player.daysInHospital = 3;
      this.pendingMoveSteps = 0;
      this.setMessage(`${player.name} 踩到地雷，受伤住院3天！`);
      this.emit({ type: "hit_landmine", data: { playerId: player.id, nodeId: nextNodeId } });
    }

    if (this.pendingMoveSteps <= 0) {
      this.phase = "arrived";
      this.handleArrival(player);
    }

    return true;
  }

  /** G2: 玩家选择分岔方向后继续移动 */
  chooseBranch(nodeId: number): void {
    if (this.phase !== "branch") return;
    const player = this.getCurrentPlayer();
    player.lastNodeId = player.positionNodeId;
    player.positionNodeId = nodeId;
    this.pendingMoveSteps--;
    this.phase = "moving";

    this.emit({ type: "player_moved", data: { playerId: player.id, nodeId } });

    // 经过型触发
    if (this.pendingMoveSteps > 0) {
      this.handlePassThrough(player, nodeId);
    }

    // 路障/地雷检查
    if (this.toolSystem.hasRoadblock(nodeId)) {
      this.toolSystem.removeToolAt(nodeId, 2);
      this.pendingMoveSteps = 0;
      this.setMessage(`${player.name} 踩到路障，停止移动！`);
      this.emit({ type: "hit_roadblock", data: { playerId: player.id, nodeId } });
    }
    if (this.toolSystem.hasLandmine(nodeId)) {
      this.toolSystem.removeToolAt(nodeId, 3);
      player.daysInHospital = 3;
      this.pendingMoveSteps = 0;
      this.setMessage(`${player.name} 踩到地雷，受伤住院3天！`);
      this.emit({ type: "hit_landmine", data: { playerId: player.id, nodeId } });
    }

    if (this.pendingMoveSteps <= 0) {
      this.phase = "arrived";
      this.handleArrival(player);
    }
  }

  /** 经过型触发（加油站、酒店等） */
  private handlePassThrough(player: Player, nodeId: number): void {
    const node = this.map.nodes[nodeId];
    if (!node) return;

    // 经过加油站 — 开车/机车需付加油费
    if (node.tileType === "facility") {
      const facility = this.map.facilities.find(f => f.id === nodeId);
      if (facility) {
        switch (facility.type) {
          case "gas_station": {
            if (player.trafficMethod > 0) {
              const result = this.facilitySystem.handleGasStation(player);
              this.setMessage(result.message);
              if (result.events) for (const ev of result.events) this.emit(ev);
            }
            break;
          }
          case "hotel": {
            // 经过酒店也要摇号付款
            const result = this.facilitySystem.handleHotel(player);
            this.setMessage(result.message);
            if (result.events) for (const ev of result.events) this.emit(ev);
            break;
          }
        }
      }
    }

    // 经过起点 — 发薪水
    if (nodeId === this.map.startNodeId) {
      const salary = 2000;
      player.addMoney(salary);
      this.setMessage(`${player.name} 经过起点，获得薪水 ${salary}`);
      this.emit({ type: "pass_start", data: { playerId: player.id, amount: salary } });
    }
  }

  /** 一步走完到达目的地 */
  private handleArrival(player: Player): void {
    const node = this.map.nodes[player.positionNodeId];
    if (!node) return;

    this.setMessage(`${player.name} 到达 ${this.getNodeName(node.id)}`);
    this.emit({ type: "player_arrived", data: { playerId: player.id, nodeId: node.id } });

    // 根据地块类型处理
    switch (node.tileType) {
      case "start":
        this.handleStartTile(player);
        break;
      case "land":
        this.handleLandTile(player, node.id);
        break;
      case "facility":
        this.handleFacilityTile(player, node.id);
        break;
      case "commercial":
        this.handleCommercialTile(player, node.id);
        break;
      case "landmark":
        this.handleLandmark(player, node.id);
        break;
      default:
        this.endTurn();
        break;
    }
  }

  private getNodeName(nodeId: number): string {
    const land = this.map.lands.find(l => l.id === nodeId);
    if (land) return land.name;
    const facility = this.map.facilities.find(f => f.id === nodeId);
    if (facility) return facility.name;
    const commercial = this.map.commercials.find(c => c.id === nodeId);
    if (commercial) return commercial.name;
    const landmark = this.map.landmarks.find(lm => lm.id === nodeId);
    if (landmark) return landmark.name;
    if (nodeId === this.map.startNodeId) return "起点";
    return `地块${nodeId}`;
  }

  private handleStartTile(player: Player): void {
    // 经过起点发薪水
    const salary = 2000;
    player.addMoney(salary);
    this.setMessage(`${player.name} 经过起点，获得薪水 ${salary}`);
    this.emit({ type: "pass_start", data: { playerId: player.id, amount: salary } });
    this.endTurn();
  }

  private handleLandTile(player: Player, landId: number): void {
    const landIndex = this.map.lands.findIndex(l => l.id === landId);
    if (landIndex === -1) { this.endTurn(); return; }
    const land = this.property.getLand(landIndex);
    if (!land) { this.endTurn(); return; }

    if (land.owner === -1) {
      // 无主地块：可以购买
      this.phase = "idle";
      this.setMessage(`${player.name} 到达空地 ${land.name}，价值 ${land.landPrice}`);
      this.emit({ type: "prompt_buy_land", data: { landIndex, landPrice: land.landPrice } });
    } else if (land.owner === player.id) {
      // 自己的地：可以升级
      this.phase = "idle";
      this.setMessage(`${player.name} 到达自己的 ${land.name}，可以升级`);
      this.emit({ type: "prompt_upgrade_land", data: { landIndex, level: land.level, maxLevel: land.maxLevel } });
    } else {
      // 别人的地：交过路费
      const ownerIdx = land.owner ?? 0;
      const owner = this.players[ownerIdx];
      let toll = this.property.getToll(landIndex, Dice.sum(this.diceValues), true);
      // G8: 物价指数联动地产过路费
      toll = Math.floor(toll * (this.priceIndex / 1000));
      // 神仙效果：穷神增加支出，财神减少支出
      toll = Math.floor(toll * this.getGodExpenseMultiplier(player));
      // 同盟免过路费
      if (player.alliedDays > 0 && player.alliedPlayer === ownerIdx) {
        toll = 0;
        this.setMessage(`${player.name} 与 ${owner.name} 是同盟，免过路费`, "blue");
      }
      // 收款方神仙效果
      const godMul = this.getGodMultiplier(owner);
      const actualToll = Math.floor(toll * godMul);
      if (actualToll > 0) {
        if (player.spendMoney(actualToll)) {
          owner.addMoney(actualToll);
          this.setMessage(`${player.name} 向 ${owner.name} 支付过路费 ${actualToll}`, "red");
          this.emit({ type: "pay_toll", data: { from: player.id, to: owner.id, amount: actualToll } });
        } else {
          // 破产清算
          const bankResult = this.bankruptcySystem.checkBankruptcy(this, player, actualToll);
          this.setMessage(bankResult.message, "red");
          if (bankResult.events) for (const ev of bankResult.events) this.emit(ev);
          if (player.status === "bankrupted") {
            this.emit({ type: "player_bankrupted", data: { playerId: player.id } });
          } else {
            owner.addMoney(actualToll);
            this.emit({ type: "pay_toll", data: { from: player.id, to: owner.id, amount: actualToll } });
          }
        }
      }
      this.endTurn();
    }
  }

  private handleFacilityTile(player: Player, nodeId: number): void {
    const facility = this.map.facilities.find(f => f.id === nodeId);
    if (!facility) { this.endTurn(); return; }

    switch (facility.type) {
      case "bank":
        this.phase = "bank";
        this.setMessage(`${player.name} 到达银行`);
        this.emit({ type: "enter_bank", data: { playerId: player.id } });
        break;
      case "shop":
        this.phase = "shop";
        this.setMessage(`${player.name} 到达商店`);
        this.emit({ type: "enter_shop", data: { playerId: player.id } });
        break;
      case "hospital": {
        const result = this.facilitySystem.handleHospital(player);
        this.setMessage(result.message);
        if (result.events) for (const ev of result.events) this.emit(ev);
        this.endTurn();
        break;
      }
      case "prison": {
        const result = this.facilitySystem.handlePrison(player);
        this.setMessage(result.message);
        if (result.events) for (const ev of result.events) this.emit(ev);
        this.endTurn();
        break;
      }
      case "park": {
        const result = this.facilitySystem.handlePark(player);
        this.setMessage(result.message);
        this.emit({ type: "enter_park", data: { playerId: player.id } });
        this.endTurn();
        break;
      }
      case "magic_house": {
        const result = this.facilitySystem.handleMagicHouse(player);
        this.setMessage(result.message);
        this.emit({ type: "enter_magic_house", data: { playerId: player.id } });
        this.endTurn();
        break;
      }
      case "hotel": {
        // 到达酒店也要摇号
        const result = this.facilitySystem.handleHotel(player);
        this.setMessage(result.message);
        if (result.events) for (const ev of result.events) this.emit(ev);
        this.endTurn();
        break;
      }
      case "gas_station": {
        const result = this.facilitySystem.handleGasStation(player);
        this.setMessage(result.message);
        if (result.events) for (const ev of result.events) this.emit(ev);
        this.endTurn();
        break;
      }
      case "news": {
        const newsId = this.fortuneSystem.randomNewsId();
        const result = this.fortuneSystem.triggerNews(this, newsId);
        this.setMessage(result.message);
        if (result.events) for (const ev of result.events) this.emit(ev);
        this.emit({ type: "trigger_news", data: { playerId: player.id, newsId } });
        // G5: 到达新闻格有 40% 概率获得随机卡牌
        this.maybeGrantCard(player, 0.4);
        this.endTurn();
        break;
      }
      case "fortune": {
        const fortuneId = this.fortuneSystem.randomFortuneId();
        const result = this.fortuneSystem.triggerFortune(this, player, fortuneId);
        this.setMessage(result.message);
        if (result.events) for (const ev of result.events) this.emit(ev);
        this.emit({ type: "trigger_fortune", data: { playerId: player.id, fortuneId } });
        // G5: 到达命运格有 60% 概率获得随机卡牌
        this.maybeGrantCard(player, 0.6);
        this.endTurn();
        break;
      }
      case "auction_house":
        this.phase = "auction";
        this.setMessage(`${player.name} 进入拍卖行`);
        this.emit({ type: "enter_auction", data: { playerId: player.id } });
        break;
      case "airport": {
        // G24: 机场 — 付费传送至任意位置
        const airportFee = Math.floor(3000 * (this.priceIndex / 1000));
        if (player.cash < airportFee) {
          this.setMessage(`${player.name} 现金不足 ${airportFee}，无法使用机场`);
          this.endTurn();
        } else {
          this.phase = "idle";
          this.setMessage(`${player.name} 到达机场，付费 ${airportFee} 可传送至任意位置`);
          this.emit({ type: "prompt_airport", data: { playerId: player.id, fee: airportFee } });
        }
        break;
      }
      default:
        this.endTurn();
        break;
    }
  }

  // G24: 机场传送
  airportTeleport(targetNodeId: number, fee: number): boolean {
    const player = this.getCurrentPlayer();
    if (!player.spendMoney(fee)) {
      this.setMessage(`${player.name} 现金不足，无法传送`);
      return false;
    }
    player.lastNodeId = player.positionNodeId;
    player.positionNodeId = targetNodeId;
    this.setMessage(`${player.name} 付费 ${fee} 传送至 ${this.getNodeName(targetNodeId)}`, "blue");
    this.emit({ type: "player_teleported", data: { playerId: player.id, nodeId: targetNodeId } });
    // 传送后处理到达
    this.phase = "arrived";
    this.handleArrival(player);
    return true;
  }

  private handleCommercialTile(player: Player, nodeId: number): void {
    const commercial = this.map.commercials.find(c => c.id === nodeId);
    if (!commercial) { this.endTurn(); return; }
    // G25: 商业地块 — 保险/建筑公司
    if (commercial.type === "insurance") {
      // 保险地块：可购买保险
      this.phase = "idle";
      this.setMessage(`${player.name} 到达 ${commercial.name}，可购买保险`);
      this.emit({ type: "prompt_buy_insurance", data: { playerId: player.id, price: commercial.tollFee } });
    } else if (commercial.type === "construction") {
      // 建筑公司：无主可购买，有主则交费
      if (commercial.owner === -1 || commercial.owner === undefined) {
        this.phase = "idle";
        this.setMessage(`${player.name} 到达 ${commercial.name}，可购买`);
        this.emit({ type: "prompt_buy_commercial", data: { playerId: player.id, price: commercial.tollFee } });
      } else if (commercial.owner !== player.id) {
        // 交费
        const fee = Math.floor(commercial.tollFee * (this.priceIndex / 1000));
        if (player.spendMoney(fee)) {
          this.players[commercial.owner]?.addMoney(fee);
          this.setMessage(`${player.name} 向 ${this.players[commercial.owner]?.name} 支付商业过路费 ${fee}`, "red");
          this.emit({ type: "pay_toll", data: { from: player.id, to: commercial.owner, amount: fee } });
        }
        this.endTurn();
      } else {
        this.setMessage(`${player.name} 到达自己的 ${commercial.name}`);
        this.endTurn();
      }
    } else {
      this.setMessage(`${player.name} 到达 ${commercial.name}`);
      this.emit({ type: "enter_commercial", data: { playerId: player.id, type: commercial.type } });
      this.endTurn();
    }
  }

  // G25: 购买商业地块
  buyCommercial(nodeId: number): boolean {
    const player = this.getCurrentPlayer();
    const commercial = this.map.commercials.find(c => c.id === nodeId);
    if (!commercial || (commercial.owner !== -1 && commercial.owner !== undefined)) return false;
    if (!player.spendMoney(commercial.tollFee)) {
      this.setMessage(`${player.name} 现金不足，无法购买 ${commercial.name}`);
      return false;
    }
    commercial.owner = player.id;
    commercial.level = 1;
    this.setMessage(`${player.name} 购买 ${commercial.name}，花费 ${commercial.tollFee}`, "green");
    this.emit({ type: "commercial_bought", data: { playerId: player.id, nodeId } });
    this.endTurn();
    return true;
  }

  // G25: 购买保险
  buyInsurance(nodeId: number): boolean {
    const player = this.getCurrentPlayer();
    const commercial = this.map.commercials.find(c => c.id === nodeId);
    if (!commercial) return false;
    if (!player.spendMoney(commercial.tollFee)) {
      this.setMessage(`${player.name} 现金不足，无法购买保险`);
      return false;
    }
    player.daysAssurance = 5;
    this.setMessage(`${player.name} 购买保险，5天内免受事故损失`, "green");
    this.emit({ type: "insurance_bought", data: { playerId: player.id } });
    this.endTurn();
    return true;
  }

  // G26: 主动出售地产
  sellLand(landIndex: number): boolean {
    const player = this.getCurrentPlayer();
    const land = this.property.getLand(landIndex);
    if (!land || land.owner !== player.id) return false;
    const sellPrice = Math.floor(land.landPrice + land.buildPrice * (land.level || 0) * 0.5);
    this.property.clearLand(landIndex);
    player.properties = player.properties.filter(p => p !== landIndex);
    player.addMoney(sellPrice);
    this.setMessage(`${player.name} 出售 ${land.name}，获得 ${sellPrice}`, "green");
    this.emit({ type: "land_sold", data: { playerId: player.id, landIndex, price: sellPrice } });
    this.endTurn();
    return true;
  }

  // G34: 投降
  surrender(): void {
    const player = this.getCurrentPlayer();
    // 没收所有地产
    this.property.confiscatePlayerLands(player.id);
    player.properties = [];
    player.status = "bankrupted";
    this.setMessage(`${player.name} 投降认输！`, "red");
    this.emit({ type: "player_bankrupted", data: { playerId: player.id } });
    this.endTurn();
  }

  // G23: 设置胜利条件倍率
  setWinningMultiplier(multiplier: number): void {
    this.winningMultiplier = multiplier;
  }

  // G20: 设置游戏总天数
  setTotalRounds(rounds: number): void {
    this.totalRounds = rounds;
  }

  // G22: 设置初始资金
  setInitCash(cash: number): void {
    this.initCash = cash;
  }

  // G23: 获取胜利条件倍率
  getWinningMultiplier(): number {
    return this.winningMultiplier;
  }

  // G23: 获取初始资金
  getInitCash(): number {
    return this.initCash;
  }

  private handleLandmark(player: Player, nodeId: number): void {
    const landmark = this.map.landmarks.find(lm => lm.id === nodeId);
    if (!landmark) { this.endTurn(); return; }
    this.setMessage(`${player.name} 经过 ${landmark.name}`);
    this.emit({ type: "pass_landmark", data: { playerId: player.id, landmarkId: nodeId } });
    this.endTurn();
  }

  // G5: 概率给予玩家随机卡牌
  private maybeGrantCard(player: Player, probability: number): void {
    if (Math.random() > probability) return;
    if (player.cards.length >= 4) {
      this.setMessage(`${player.name} 手牌已满，无法获得新卡牌`);
      return;
    }
    // 随机选一张卡牌
    const allCards = cardData as CardDef[];
    if (allCards.length === 0) return;
    const cardId = Math.floor(Math.random() * allCards.length);
    const card = allCards[cardId];
    if (player.addCard(cardId)) {
      this.setMessage(`${player.name} 获得卡牌: ${card.name}`);
      this.emit({ type: "card_acquired", data: { playerId: player.id, cardId, cardName: card.name } });
    }
  }

  // ===== 玩家操作 =====

  buyLand(landIndex: number): boolean {
    const player = this.getCurrentPlayer();
    const land = this.property.getLand(landIndex);
    if (!land || land.owner !== -1) return false;
    if (!player.spendMoney(land.landPrice)) {
      this.setMessage(`${player.name} 现金不足，无法购买 ${land.name}`);
      return false;
    }
    this.property.buyLand(landIndex, player.id);
    player.properties.push(landIndex);
    this.setMessage(`${player.name} 购买 ${land.name}，花费 ${land.landPrice}`, "green");
    this.emit({ type: "land_bought", data: { playerId: player.id, landIndex } });
    this.endTurn();
    return true;
  }

  upgradeLand(landIndex: number): boolean {
    const player = this.getCurrentPlayer();
    const land = this.property.getLand(landIndex);
    if (!land || land.owner !== player.id) return false;
    if (land.level! >= land.maxLevel) return false;
    if (!player.spendMoney(land.buildPrice)) {
      this.setMessage(`${player.name} 现金不足，无法升级`);
      return false;
    }
    this.property.upgradeLand(landIndex);
    this.setMessage(`${player.name} 升级 ${land.name} 至 ${land.level! + 1} 级`, "green");
    this.emit({ type: "land_upgraded", data: { playerId: player.id, landIndex, level: land.level } });
    this.endTurn();
    return true;
  }

  skipAction(): void {
    this.setMessage(`${this.getCurrentPlayer().name} 跳过`);
    this.endTurn();
  }

  // ===== 回合管理 =====

  endTurn(): void {
    this.phase = "rolling";
    this.date++;

    // G23: 检查胜利条件
    // -1 = 破产模式：只剩一名玩家未破产即胜
    if (this.winningMultiplier === -1) {
      const active = this.players.filter(p => p.status !== "bankrupted");
      if (active.length <= 1) {
        this.setMessage(`${active[0]?.name || "无人"} 是最后的赢家！所有对手已破产！`, "gold");
        this.endGame();
        return;
      }
    }
    // >0 = wealth >= initCash × multiplier 即胜利
    if (this.winningMultiplier > 0) {
      for (const p of this.players) {
        if (p.status !== "bankrupted") {
          const wealth = p.getWealth(
            this.property.getAllLands().map((_, i) => this.property.getLandValue(i)),
            this.getPlayerStockValue(p.id)
          );
          if (wealth >= this.initCash * this.winningMultiplier) {
            this.setMessage(`${p.name} 达到胜利条件（${this.winningMultiplier}x 初始资金），游戏结束！`, "gold");
            this.endGame();
            return;
          }
        }
      }
    }

    // 检查游戏是否结束
    if (this.date > this.totalRounds) {
      this.endGame();
      return;
    }

    // 切换到下一个玩家
    do {
      this.currentPlayerIdx = (this.currentPlayerIdx + 1) % this.players.length;
      if (this.currentPlayerIdx === 0) {
        this.round++;
        this.setMessage(`第 ${this.round} 回合开始`);
        this.updatePriceIndex();
        this.property.tickTmpStates(this.date);
        // 子系统回合更新
        this.shopSystem.restock();
        this.facilitySystem.updatePriceIndex(this.priceIndex);
        // 银行利息
        for (const p of this.players) {
          if (p.status !== "bankrupted") {
            const interest = this.facilitySystem.bankInterest(p);
            if (interest.message) this.setMessage(interest.message, "green");
            const loanInterest = this.facilitySystem.bankLoanInterest(p);
            if (loanInterest.message) this.setMessage(loanInterest.message, "red");
            // G28: 银行随机审查 — 5% 概率对高负债玩家拒绝服务
            if (p.loan > 0 && Math.random() < 0.05) {
              p.daysBankNoLoans = 3;
              this.setMessage(`${p.name} 被银行审查，3天内不可贷款`, "red");
            }
            // G27: 股票分红 — 每回合自动发放
            const dividend = this.stockSystem.calculateDividends(p.id);
            if (dividend > 0) {
              p.addMoney(dividend);
              this.setMessage(`${p.name} 获得股票分红 ${dividend}`, "green");
            }
          }
        }
        // 定时炸弹计时与爆炸处理
        const bombEvents = this.toolSystem.tickTimers();
        for (const ev of bombEvents) {
          if (ev.type === "bomb_exploded" && ev.data) {
            const nodeId = ev.data.nodeId as number;
            // 爆炸效果1: 炸毁该节点上的地产（降级）
            const map = this.map;
            const node = map.nodes[nodeId];
            if (node) {
              const landIndex = map.lands.findIndex(l => l.id === node.id);
              if (landIndex >= 0) {
                const land = this.property.getLand(landIndex);
                if (land && land.level! > 0) {
                  this.property.downgradeLand(landIndex);
                  this.setMessage(`炸弹爆炸！${land.name} 被炸毁一级`);
                }
              }
            }
            // 爆炸效果2: 该节点上的玩家受到伤害（住院3天）
            for (const p of this.players) {
              if (p.status !== "bankrupted" && p.positionNodeId === nodeId) {
                p.daysInHospital = 3;
                this.setMessage(`炸弹爆炸！${p.name} 被炸伤，住院3天`);
                this.emit({ type: "enter_hospital", data: { playerId: p.id } });
              }
            }
          }
          this.emit(ev);
        }
        // G17: 每3回合触发一次定时随机事件
        if (this.round % 3 === 0) {
          this.triggerRandomGlobalEvent();
        }
      }
    } while (this.players[this.currentPlayerIdx].status === "bankrupted");

    // 检查是否所有玩家都破产了
    const activePlayers = this.players.filter(p => p.status !== "bankrupted");
    if (activePlayers.length === 0) {
      this.endGame();
      return;
    }

    const player = this.getCurrentPlayer();
    this.setMessage(`${player.name} 的回合`);
    this.emit({ type: "turn_start", data: this.getHUDState() });
  }

  private endGame(): void {
    this.phase = "ended";
    // 计算最终财富
    const rankings = this.players
      .filter(p => p.status !== "bankrupted")
      .map(p => ({
        playerId: p.id,
        name: p.name,
        wealth: p.getWealth(
          this.property.getAllLands().map((_, i) => this.property.getLandValue(i)),
          this.getPlayerStockValue(p.id)
        ),
      }))
      .sort((a, b) => b.wealth - a.wealth);

    this.setMessage(`游戏结束！冠军是 ${rankings[0]?.name || "无人"}`);
    this.emit({ type: "game_end", data: { rankings } });
  }

  // ===== 股票系统 =====

  private updatePriceIndex(): void {
    // 物价指数 = 基于玩家平均财富 / 初始资金，只升不降
    const avgWealth = this.players.reduce((sum, p) => sum + p.cash + p.moneyInBank + this.getPlayerStockValue(p.id), 0) / this.players.length;
    const initCash = this.config.initialFunds[0] || 15000;
    const newIndex = Math.max(this.priceIndex, Math.floor((avgWealth / initCash) * 1000));
    // 小幅波动
    const fluctuation = Math.floor(Math.random() * 100) - 30;
    this.priceIndex = Math.max(200, Math.min(5000, newIndex + fluctuation));
    this.setMessage(`物价指数更新: ${this.priceIndex}`);

    // 更新子系统物价指数
    this.stockSystem.updatePriceIndex(this.priceIndex);
    this.facilitySystem.updatePriceIndex(this.priceIndex);

    // 更新股票价格
    this.stockSystem.updatePrices();
    this.emit({ type: "price_index_updated", data: { priceIndex: this.priceIndex } });
  }

  /** G17: 定时随机全局事件 */
  private triggerRandomGlobalEvent(): void {
    const events = [
      () => {
        // 突发福利：所有活跃玩家获得5000
        for (const p of this.players) {
          if (p.status !== "bankrupted") p.addMoney(5000);
        }
        this.setMessage("★ 突发事件：节日福利！所有玩家获得 5000");
        this.emit({ type: "trigger_news", data: { newsId: 4 } });
      },
      () => {
        // 地震：随机一块地产降级
        const lands = this.property.getAllLands().filter(l => (l.owner ?? -1) >= 0 && (l.level ?? 0) > 0);
        if (lands.length > 0) {
          const target = lands[Math.floor(Math.random() * lands.length)];
          const idx = this.property.getAllLands().indexOf(target);
          this.property.downgradeLand(idx);
          this.setMessage(`★ 突发事件：地震！${target.name} 建筑受损降级`);
        }
        this.emit({ type: "random_seal", data: { days: 1 } });
      },
      () => {
        // 股市大涨
        this.stockSystem.boom(20);
        this.setMessage("★ 突发事件：利好消息！股市全线上涨20%");
        this.emit({ type: "stock_boom", data: { percent: 20 } });
      },
      () => {
        // 股市大跌
        this.stockSystem.crash(15);
        this.setMessage("★ 突发事件：利空消息！股市下跌15%");
        this.emit({ type: "stock_crash", data: { percent: 15 } });
      },
      () => {
        // 幸运抽奖：随机一名玩家获得10000
        const active = this.players.filter(p => p.status !== "bankrupted");
        if (active.length > 0) {
          const winner = active[Math.floor(Math.random() * active.length)];
          winner.addMoney(10000);
          this.setMessage(`★ 突发事件：幸运抽奖！${winner.name} 获得 10000`);
        }
      },
      () => {
        // 物价飙升
        this.priceIndex = Math.min(5000, this.priceIndex + 300);
        this.facilitySystem.updatePriceIndex(this.priceIndex);
        this.stockSystem.updatePriceIndex(this.priceIndex);
        this.setMessage(`★ 突发事件：通货膨胀！物价指数+300（当前 ${this.priceIndex}）`);
        this.emit({ type: "price_index_up", data: { amount: 300 } });
      },
    ];
    const handler = events[Math.floor(Math.random() * events.length)];
    handler();
    this.emit({ type: "global_event", data: { round: this.round } });
  }

  getStockPrice(stockId: number): number {
    return this.stockSystem.getPrice(stockId);
  }

  buyStock(stockId: number, amount: number): boolean {
    const player = this.getCurrentPlayer();
    const result = this.stockSystem.buy(player, stockId, amount);
    this.setMessage(result.message);
    if (result.success) {
      this.emit({ type: "stock_bought", data: { playerId: player.id, stockId, amount } });
    }
    return result.success;
  }

  sellStock(stockId: number, amount: number): boolean {
    const player = this.getCurrentPlayer();
    const result = this.stockSystem.sell(player, stockId, amount);
    this.setMessage(result.message);
    if (result.success) {
      this.emit({ type: "stock_sold", data: { playerId: player.id, stockId, amount } });
    }
    return result.success;
  }

  private getPlayerStockValue(playerId: number): number {
    return this.stockSystem.getPortfolioValue(playerId);
  }

  // ===== 获取器 =====

  getCurrentPlayer(): Player {
    return this.players[this.currentPlayerIdx];
  }

  getPlayers(): Player[] {
    return this.players;
  }

  getPlayerStates(): PlayerState[] {
    return this.players.map(p => p.toState());
  }

  getMap(): GameBoardMap {
    return this.map;
  }

  getProperty(): Property {
    return this.property;
  }

  getPriceIndex(): number {
    return this.priceIndex;
  }

  getRound(): number {
    return this.round;
  }

  getTotalRounds(): number {
    return this.totalRounds;
  }

  getDate(): number {
    return this.date;
  }

  getPhase(): GamePhase {
    return this.phase;
  }

  getDiceValues(): number[] {
    return this.diceValues;
  }

  getMessage(): string {
    return this.message;
  }

  getLog(): string[] {
    return [...this.log];
  }

  getHUDState(): HUDState {
    return {
      phase: this.phase,
      currentPlayer: this.currentPlayerIdx,
      players: this.getPlayerStates(),
      diceValues: this.diceValues,
      message: this.message,
      log: [...this.log],
      logColors: [...this.logColors],
      priceIndex: this.priceIndex,
      round: this.round,
      totalRounds: this.totalRounds,
      winningMultiplier: this.winningMultiplier,
    };
  }

  getStockPrices(): { id: number; price: number }[] {
    return this.stockSystem.getAllPrices().map(s => ({ id: s.id, price: s.price }));
  }

  getPlayerStocks(playerId: number): { stockId: number; amount: number; avgCost: number }[] {
    return this.stockSystem.getHoldings(playerId);
  }

  getStockSystem(): StockSystem {
    return this.stockSystem;
  }

  getBankruptcySystem(): BankruptcySystem {
    return this.bankruptcySystem;
  }

  // ===== 子系统暴露 =====

  getCardSystem(): CardSystem {
    return this.cardSystem;
  }

  getToolSystem(): ToolSystem {
    return this.toolSystem;
  }

  getShopSystem(): ShopSystem {
    return this.shopSystem;
  }

  getAuctionSystem(): AuctionSystem {
    return this.auctionSystem;
  }

  getFacilitySystem(): FacilitySystem {
    return this.facilitySystem;
  }

  getFortuneSystem(): FortuneSystem {
    return this.fortuneSystem;
  }

  // ===== 神仙效果 =====

  /** 计算神仙对收支的影响倍率 */
  getGodMultiplier(player: Player): number {
    switch (player.godInfo) {
      case 1: return 1.5;  // 小财神：收入+50%
      case 2: return 2.0;  // 大财神：收入×2
      case 5: return 0.5;  // 小穷神：收入-50%
      case 6: return 0.0;  // 大穷神：收入归零
      default: return 1.0;
    }
  }

  /** 计算神仙对支出的影响倍率 */
  getGodExpenseMultiplier(player: Player): number {
    switch (player.godInfo) {
      case 1: return 0.8;  // 小财神：支出-20%
      case 2: return 0.5;  // 大财神：支出-50%
      case 5: return 1.5;  // 小穷神：支出+50%
      case 6: return 2.0;  // 大穷神：支出×2
      default: return 1.0;
    }
  }

  // ===== 交通事故系统 =====

  /** 检查交通事故（开车时有概率触发） */
  checkTrafficAccident(player: Player): void {
    if (player.trafficMethod === 0) return; // 步行不会出事故
    if (player.daysAssurance > 0) return; // 有保险免赔

    const roll = Math.random();
    if (player.trafficMethod === 1) {
      // 机车：5%概率
      if (roll < 0.05) {
        player.daysInHospital = 3;
        player.setTraffic(0); // 机车损坏
        this.setMessage(`${player.name} 机车事故，受伤住院3天`);
        this.emit({ type: "traffic_accident", data: { playerId: player.id, type: "motorcycle" } });
      }
    } else if (player.trafficMethod === 2) {
      // 汽车：3%闯红灯 + 3%超速
      if (roll < 0.03) {
        const fine = Math.floor(3000 * (this.priceIndex / 1000));
        player.spendMoney(fine);
        this.setMessage(`${player.name} 闯红灯，罚款 ${fine}`);
        this.emit({ type: "traffic_fine", data: { playerId: player.id, type: "red_light", fine } });
      } else if (roll < 0.06) {
        const fine = Math.floor(5000 * (this.priceIndex / 1000));
        player.spendMoney(fine);
        this.setMessage(`${player.name} 超速行驶，罚款 ${fine}`);
        this.emit({ type: "traffic_fine", data: { playerId: player.id, type: "speeding", fine } });
      }
    }
  }

  // ===== 卡牌使用 =====

  useCard(cardId: number, targetPlayerId?: number, targetLandIndex?: number): { success: boolean; message: string } {
    const user = this.getCurrentPlayer();
    const targetPlayer = targetPlayerId !== undefined ? this.players[targetPlayerId] : undefined;
    const result = this.cardSystem.useCard(cardId, {
      engine: this,
      user,
      targetPlayer,
      targetLandIndex,
      date: this.date,
    });
    if (result.success) {
      user.removeCard(cardId);
      this.setMessage(result.message);
      // G16: 发出卡牌使用事件（用于翻牌动画）
      const cardDef = (cardData as any[]).find(c => c.id === cardId);
      this.emit({ type: "card_used", data: { playerId: user.id, cardId, cardName: cardDef?.name || "" } });
      if (result.events) {
        for (const ev of result.events) this.emit(ev);
      }
    } else {
      this.setMessage(result.message);
    }
    return result;
  }

  // ===== 道具使用 =====

  useToolItem(toolId: number, targetPlayerId?: number, targetNodeId?: number): { success: boolean; message: string } {
    const user = this.getCurrentPlayer();
    const targetPlayer = targetPlayerId !== undefined ? this.players[targetPlayerId] : undefined;
    const result = this.toolSystem.useTool(toolId, {
      engine: this,
      user,
      targetPlayer,
      targetNodeId,
      date: this.date,
    });
    if (result.success) {
      user.useTool(toolId);
      this.setMessage(result.message);
      if (result.events) {
        for (const ev of result.events) this.emit(ev);
      }
    } else {
      this.setMessage(result.message);
    }
    return result;
  }

  // ===== 商店操作 =====

  shopBuyCard(cardId: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.shopSystem.buyCard(cardId, player);
    this.setMessage(result.message);
    return { success: result.success, message: result.message };
  }

  shopBuyTool(toolId: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.shopSystem.buyTool(toolId, player);
    this.setMessage(result.message);
    return { success: result.success, message: result.message };
  }

  shopSellCard(cardId: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.shopSystem.sellCard(cardId, player);
    this.setMessage(result.message);
    return { success: result.success, message: result.message };
  }

  shopSellTool(toolId: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.shopSystem.sellTool(toolId, player);
    this.setMessage(result.message);
    return { success: result.success, message: result.message };
  }

  // ===== 银行操作 =====

  bankDeposit(amount: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.facilitySystem.handleBank(player, "deposit", amount);
    this.setMessage(result.message);
    return { success: true, message: result.message };
  }

  bankWithdraw(amount: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.facilitySystem.handleBank(player, "withdraw", amount);
    this.setMessage(result.message);
    return { success: true, message: result.message };
  }

  bankLoan(amount: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.facilitySystem.handleBank(player, "loan", amount);
    this.setMessage(result.message);
    return { success: true, message: result.message };
  }

  bankRepay(amount: number): { success: boolean; message: string } {
    const player = this.getCurrentPlayer();
    const result = this.facilitySystem.handleBank(player, "repay", amount);
    this.setMessage(result.message);
    return { success: true, message: result.message };
  }

  // ===== 拍卖操作 =====

  startAuction(landIndex: number, participants: number[]): boolean {
    const state = this.auctionSystem.startAuction(this, landIndex, participants);
    if (state) {
      this.phase = "auction";
      this.setMessage(`拍卖开始: ${state.landName}，起拍价 ${state.basePrice}`);
      this.emit({ type: "auction_started", data: state });
      return true;
    }
    return false;
  }

  auctionBid(playerId: number, amount: number): { success: boolean; message: string } {
    const result = this.auctionSystem.bid(this, playerId, amount);
    this.setMessage(result.message);
    return result;
  }

  auctionPass(playerId: number): void {
    const result = this.auctionSystem.pass(playerId);
    this.setMessage(result.message);
  }

  auctionAdvance(): void {
    const { finished, event } = this.auctionSystem.advanceRound(this);
    if (finished) {
      this.phase = "rolling";
      if (event) {
        this.emit(event);
        if (event.data?.winnerName) {
          this.setMessage(`拍卖结束: ${event.data.landName} 以 ${event.data.price} 成交，赢家: ${event.data.winnerName}`);
        } else {
          this.setMessage(`拍卖结束: ${event.data?.landName || "地块"} 流拍`);
        }
      }
    }
  }

  // ===== 存档/读档 =====

  /** 序列化当前游戏状态为存档数据 */
  serialize(saveName: string): SaveData {
    // 地产运行时状态
    const lands: LandTile[] = this.property.getAllLands().map(l => ({
      ...l,
      owner: l.owner ?? -1,
      level: l.level ?? 0,
      tmpState: l.tmpState ?? "none",
      expiredDate: l.expiredDate ?? 0,
    }));

    // 股票价格
    const stockPrices = this.stockSystem.getAllPrices().map(s => ({
      id: s.id,
      price: s.price,
      prevPrice: s.prevPrice,
    }));

    // 玩家股票持仓
    const playerStocks = this.players.map(p => ({
      playerId: p.id,
      holdings: this.stockSystem.getHoldings(p.id),
    }));

    // 地图上放置的道具
    const placedTools = this.toolSystem.getPlacedTools().map(t => ({
      toolId: t.toolId,
      nodeId: t.nodeId,
      ownerId: t.ownerId,
      timer: t.timer,
    }));

    return {
      version: SaveLoadSystem.getVersion(),
      timestamp: Date.now(),
      saveName,
      mapId: this.map.meta.id,
      round: this.round,
      totalRounds: this.totalRounds,
      date: this.date,
      priceIndex: this.priceIndex,
      phase: this.phase,
      currentPlayerIdx: this.currentPlayerIdx,
      humanCharId: this.humanCharId,
      pendingMoveSteps: this.pendingMoveSteps,
      diceValues: [...this.diceValues],
      message: this.message,
      log: [...this.log],
      logColors: [...this.logColors],
      winningMultiplier: this.winningMultiplier,
      players: this.players.map(p => p.toState()),
      lands,
      stockPrices,
      playerStocks,
      placedTools,
    };
  }

  /** 从存档数据恢复游戏状态 */
  deserialize(data: SaveData, map: GameBoardMap, config: GameConfig, stocks: StockDef[]): void {
    // 恢复基础状态
    this.map = map;
    this.config = config;
    this.stocks = stocks;
    this.round = data.round;
    this.totalRounds = data.totalRounds;
    this.date = data.date;
    this.priceIndex = data.priceIndex;
    this.phase = data.phase as GamePhase;
    this.currentPlayerIdx = data.currentPlayerIdx;
    this.humanCharId = data.humanCharId;
    this.pendingMoveSteps = data.pendingMoveSteps;
    this.diceValues = [...data.diceValues];
    this.message = data.message;
    this.log = [...data.log];
    this.logColors = data.logColors ? [...data.logColors] : [];
    this.winningMultiplier = data.winningMultiplier || 0;

    // 恢复玩家
    this.players = data.players.map(ps => {
      const p = new Player(
        ps.id, ps.name, ps.color, ps.characterId,
        ps.positionNodeId, ps.cash, ps.isAI,
      );
      // 恢复所有运行时字段
      p.moneyInBank = ps.moneyInBank;
      p.loan = ps.loan;
      p.specialFinance = ps.specialFinance;
      p.points = ps.points;
      p.lastNodeId = ps.lastNodeId;
      p.direction = ps.direction;
      p.trafficMethod = ps.trafficMethod;
      p.numDices = ps.numDices;
      p.status = ps.status;
      p.daysInHotel = ps.daysInHotel;
      p.daysInPrison = ps.daysInPrison;
      p.daysInHospital = ps.daysInHospital;
      p.daysSleeping = ps.daysSleeping;
      p.daysSleepWalking = ps.daysSleepWalking;
      p.daysStopping = ps.daysStopping;
      p.daysTortoiseWalking = ps.daysTortoiseWalking;
      p.daysRejectedByBank = ps.daysRejectedByBank;
      p.daysBankNoLoans = ps.daysBankNoLoans;
      p.alliedDays = ps.alliedDays;
      p.alliedPlayer = ps.alliedPlayer;
      p.daysAssurance = ps.daysAssurance;
      p.godInfo = ps.godInfo;
      p.hostility = [...ps.hostility];
      p.properties = [...ps.properties];
      p.cards = [...ps.cards];
      p.tools = ps.tools.map(t => ({ ...t }));
      p.diceProphecy = ps.diceProphecy;
      return p;
    });

    // 恢复地产运行时状态
    // Property 构造时会重置所有 owner/level，需要手动覆盖
    for (let i = 0; i < data.lands.length && i < this.property.landCount; i++) {
      const saved = data.lands[i];
      const land = this.property.getLand(i);
      if (land && saved) {
        land.owner = saved.owner;
        land.level = saved.level;
        land.tmpState = saved.tmpState;
        land.expiredDate = saved.expiredDate;
        land.isChainStore = saved.isChainStore;
      }
    }

    // 恢复股票系统 — 重建子系统
    this.stockSystem = new StockSystem(stocks);
    this.stockSystem.updatePriceIndex(this.priceIndex);
    // 恢复股票价格
    for (const sp of data.stockPrices) {
      // StockSystem 的 prices 是 private Map，需要通过内部方法
      // 这里通过重新构建来恢复价格
      (this.stockSystem as any).prices.set(sp.id, {
        id: sp.id,
        name: (this.stockSystem as any).prices.get(sp.id)?.name || `Stock${sp.id}`,
        code: (this.stockSystem as any).prices.get(sp.id)?.code || `S${sp.id}`,
        price: sp.price,
        prevPrice: sp.prevPrice,
        volatility: (this.stockSystem as any).prices.get(sp.id)?.volatility || 0.3,
      });
    }
    // 恢复玩家持仓
    for (const ps of data.playerStocks) {
      for (const h of ps.holdings) {
        const player = this.players.find(p => p.id === ps.playerId);
        if (player) {
          // 通过 buy 方法恢复持仓需要绕过现金检查，直接操作内部 map
          const holdingsMap = (this.stockSystem as any).playerHoldings;
          if (!holdingsMap.has(ps.playerId)) {
            holdingsMap.set(ps.playerId, new Map());
          }
          holdingsMap.get(ps.playerId).set(h.stockId, {
            amount: h.amount,
            avgCost: h.avgCost,
          });
        }
      }
    }

    // 恢复放置的道具
    (this.toolSystem as any).placedTools = data.placedTools.map(t => ({
      toolId: t.toolId,
      nodeId: t.nodeId,
      ownerId: t.ownerId,
      timer: t.timer,
    }));

    // 恢复物价指数到子系统
    this.facilitySystem.updatePriceIndex(this.priceIndex);
    this.shopSystem.updatePriceIndex(this.priceIndex);

    // 通知 UI 刷新
    this.setMessage(`读档成功: ${data.saveName}（第${data.round}回合）`);
    this.emit({ type: "game_loaded" as any, data: this.getHUDState() });
  }

  /** 保存到 localStorage 指定槽位 */
  saveToSlot(slot: number, saveName: string): boolean {
    const data = this.serialize(saveName);
    return SaveLoadSystem.save(slot, data);
  }

  /** 从 localStorage 槽位加载存档 */
  loadFromSlot(slot: number, map: GameBoardMap, config: GameConfig, stocks: StockDef[]): boolean {
    const data = SaveLoadSystem.load(slot);
    if (!data) return false;
    this.deserialize(data, map, config, stocks);
    return true;
  }
}
