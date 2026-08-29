/**
 * Monopoly Game — Type Definitions
 * 完全独立的大富翁游戏类型系统
 */

// ===== 基础类型 =====

export type TrafficMethod = 0 | 1 | 2; // 0:步行 1:机车 2:汽车
export type PlayerStatus = 'active' | 'bankrupted' | 'offline';
export type GamePhase = 'idle' | 'rolling' | 'moving' | 'arrived' | 'card' | 'tool' | 'shop' | 'auction' | 'fortune' | 'bank' | 'magic' | 'branch' | 'ended';

export interface Vec2 { x: number; y: number; }

// ===== 地图类型 =====

export type TileType = 'empty' | 'land' | 'facility' | 'commercial' | 'landmark' | 'start';

export type FacilityType =
  | 'bank' | 'hospital' | 'prison' | 'shop'
  | 'park' | 'magic_house' | 'hotel' | 'gas_station'
  | 'news' | 'fortune' | 'auction_house' | 'airport';

export interface MapNode {
  id: number;
  x: number;
  y: number;
  adjacent: number[];
  tileType: TileType;
  tileIndex: number;
}

export interface LandTile {
  id: number;
  name: string;
  landPrice: number;
  buildPrice: number;
  tolls: number[];
  maxLevel: number;
  isChainStore: boolean;
  // 运行时状态
  owner?: number; // player index, -1 = 无主
  level?: number;
  tmpState?: 'none' | 'sealed' | 'price_up';
  expiredDate?: number;
}

export interface FacilityTile {
  id: number;
  name: string;
  type: FacilityType;
}

export interface CommercialTile {
  id: number;
  name: string;
  type: 'insurance' | 'construction';
  tollFee: number;
  owner?: number;
  level?: number;
}

export interface Landmark {
  id: number;
  name: string;
  x: number;
  y: number;
}

export interface GameBoardMap {
  meta: {
    id: string;
    name: string;
    author: string;
    version: string;
    description: string;
    backgroundTheme: string;
  };
  nodes: MapNode[];
  lands: LandTile[];
  facilities: FacilityTile[];
  commercials: CommercialTile[];
  landmarks: Landmark[];
  startNodeId: number;
  prisonNodeId: number;
  hospitalNodeId: number;
}

// ===== 玩家类型 =====

export interface PlayerState {
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

  // 状态天数
  daysInHotel: number;
  daysInPrison: number;
  daysInHospital: number;
  daysSleeping: number;
  daysSleepWalking: number;
  daysStopping: number;
  daysTortoiseWalking: number;
  daysRejectedByBank: number;
  daysBankNoLoans: number;
  alliedDays: number;
  alliedPlayer: number;
  daysAssurance: number;
  godInfo: number; // 0:无 1:小财 2:大财 5:小穷 6:大穷

  // 仇恨值
  hostility: number[];

  // 持有物
  properties: number[]; // land tile indices
  cards: number[];      // card indices
  tools: { id: number; amount: number }[];

  // 骰子预言
  diceProphecy: number | null;
}

// ===== 卡牌类型 =====

export type CardTargetType =
  | 'self' | 'other_player' | 'all_players'
  | 'property' | 'map_item' | 'none';

export interface CardDef {
  id: number;
  name: string;
  description: string;
  price: number;
  targetType: CardTargetType;
  effect: string; // 效果标识符，由 CardSystem 解析
}

// ===== 道具类型 =====

export interface ToolDef {
  id: number;
  name: string;
  description: string;
  maxAmount: number;
  price: number;
  effect: string; // 效果标识符
}

// ===== 命运事件类型 =====

export interface FortuneEvent {
  id: number;
  type: 'fortune' | 'news';
  title: string;
  description: string;
  effect: string;
  condition?: string; // 条件检查标识符
  hasChoice?: boolean;
}

// ===== 股票类型 =====

export interface StockDef {
  id: number;
  name: string;
  code: string;
  initPrice: number;
  volatility: number; // 波动率
  maxShares: number;
}

export interface PlayerStock {
  stockId: number;
  amount: number;
  avgCost: number;
}

// ===== 角色类型 =====

export interface CharacterDef {
  id: number;
  name: string;
  color: string;
  initCashRatio: number;
  special: string; // 特殊属性标识符
  specialDesc?: string; // 特殊属性描述
  trafficPreference: TrafficMethod;
}

// ===== 游戏配置 =====

export interface GameConfig {
  initialFunds: number[];
  gameDays: number[];
  winningConditions: number[]; // 倍数
  mapId: string;
  numPlayers: number;
  numAI: number;
}

// ===== 游戏事件 =====

export interface GameEvent {
  type: string;
  data?: any;
}

export type GameEventListener = (event: GameEvent) => void;

// ===== HUD 状态 =====

export interface HUDState {
  phase: GamePhase;
  currentPlayer: number;
  players: PlayerState[];
  diceValues: number[];
  message: string;
  log: string[];
  logColors: string[]; // G33: 日志颜色
  priceIndex: number;
  round: number;
  totalRounds: number;
  winningMultiplier: number; // G23: 胜利条件倍率
}
