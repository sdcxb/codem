/**
 * PetTypes — 宠物系统的核心类型定义。
 *
 * 基于 Petdex 的 pet.json 格式，适配 Codem 的 Agent 事件模型。
 *
 * 宠物包格式：
 * - pet.json: 元数据 + 动画配置
 * - spritesheet.png: 精灵图（所有动画帧拼接成一张大图）
 *
 * IP 声明：本文件基于开源项目 Petdex (MIT License) 的宠物包格式改造实现。
 * @see THIRD_PARTY_NOTICES.md — Petdex (MIT License) 集成声明
 */

// ========== 宠物动画状态 ==========

/**
 * 宠物动画状态，映射到 Codem Agent 的生命周期事件。
 *
 * 映射关系：
 * - idle:     Agent 空闲（llm_status === "idle"）
 * - thinking: Agent 正在连接或流式输出文本/推理（llm_status === "connecting" | "streaming"）
 * - working:  Agent 正在执行工具（llm_status === "executing_tools"）
 * - happy:    Agent 成功完成（end 事件，无错误）
 * - sad:      Agent 出错（error 事件或 tool_error）
 * - sleeping: 长时间无活动（> 60s 空闲后自动进入）
 */
export type PetState = "idle" | "thinking" | "working" | "happy" | "sad" | "sleeping";

/** 所有支持的宠物状态列表（用于迭代） */
export const ALL_PET_STATES: PetState[] = [
  "idle",
  "thinking",
  "working",
  "happy",
  "sad",
  "sleeping",
];

// ========== 宠物动画帧配置 ==========

/**
 * 单个动画状态的配置。
 * 描述精灵图中该状态对应的帧区域。
 */
export interface PetAnimationFrame {
  /** 状态名称 */
  state: PetState;
  /** 精灵图中该状态动画的起始 X 坐标（像素） */
  x: number;
  /** 精灵图中该状态动画的起始 Y 坐标（像素） */
  y: number;
  /** 每帧宽度（像素） */
  frameWidth: number;
  /** 每帧高度（像素） */
  frameHeight: number;
  /** 该状态的帧数 */
  frames: number;
  /** 帧间隔（毫秒） */
  frameInterval: number;
  /** 是否循环播放（false = 播放一次后停在最后一帧） */
  loop: boolean;
}

// ========== 宠物元数据 ==========

/**
 * 宠物的完整定义，对应 pet.json 文件。
 */
export interface PetDefinition {
  /** 宠物唯一标识（slug） */
  slug: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 作者 */
  author?: string;
  /** 版本 */
  version?: string;
  /** 精灵图文件名（相对于宠物目录） */
  spritesheet: string;
  /** 精灵图总宽度（像素） */
  sheetWidth: number;
  /** 精灵图总高度（像素） */
  sheetHeight: number;
  /** 默认缩放比例（1.0 = 原始尺寸） */
  scale?: number;
  /** 动画配置列表 */
  animations: PetAnimationFrame[];
  /** 默认状态 */
  defaultState?: PetState;
  /** 标签（用于市场搜索/分类） */
  tags?: string[];
  /** 预览图 URL（市场展示用） */
  previewUrl?: string;
}

// ========== 市场宠物条目 ==========

/**
 * 市场中的宠物条目，从 Petdex Manifest API 获取。
 */
export interface MarketPet {
  /** 唯一 ID */
  id: string;
  /** 宠物 slug */
  slug: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 版本 */
  version?: string;
  /** 标签 */
  tags?: string[];
  /** 预览图 URL */
  previewUrl?: string;
  /** pet.json 下载 URL */
  metadataUrl: string;
  /** 精灵图下载 URL */
  spritesheetUrl: string;
  /** 下载次数 */
  downloads?: number;
  /** 最后更新时间 */
  lastUpdated?: string;
  /** 是否已安装 */
  installed?: boolean;
}

// ========== 宠物安装信息 ==========

/**
 * 已安装宠物的运行时信息。
 */
export interface InstalledPet {
  /** 宠物 slug */
  slug: string;
  /** 安装路径（~/.codem/pets/<slug>/） */
  path: string;
  /** 宠物定义 */
  definition: PetDefinition;
  /** 安装时间 */
  installedAt: number;
}

// ========== 宠物设置 ==========

/**
 * 宠物全局设置，持久化到 SQLite settings 表。
 */
export interface PetSettings {
  /** 是否启用宠物 */
  enabled: boolean;
  /** 当前激活的宠物 slug */
  activePetSlug: string | null;
  /** 宠物显示位置 X（相对于窗口右下角的偏移，像素） */
  positionX: number;
  /** 宠物显示位置 Y（相对于窗口右下角的偏移，像素） */
  positionY: number;
  /** 宠物缩放比例 */
  scale: number;
  /** 宠物透明度 (0-1) */
  opacity: number;
  /** 是否可拖拽 */
  draggable: boolean;
  /** 空闲多久后进入 sleeping 状态（毫秒，0 = 不启用） */
  idleTimeout: number;
}

/** 默认宠物设置 */
export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  activePetSlug: null,
  positionX: 24,
  positionY: 8,
  scale: 0.4,
  opacity: 1.0,
  draggable: true,
  idleTimeout: 60000,
};
