/**
 * 像素美术资源清单（数据层）—— 把 `public/library-ops/**` 里的第三方资源
 * 变成可被渲染器消费的强类型描述。
 *
 * ⚠️ 许可：这些美术资源**仅限非商业用途**（CC BY-NC-SA 4.0 / Star-Office-UI 非商业）。
 * 出处、改动与义务见 `public/library-ops/<来源>/SOURCE.md` 与 `docs/ASSET-LICENSES.md`。
 * 商用必须替换本清单指向的资源（可改用 `sceneStyle: "iso"` 的自绘等距场景）。
 *
 * 坐标系统：
 * - 场景逻辑坐标 = 1920×1080（上游 `map.logic.json` 的 `baseResolution`）
 * - 场景贴图原生尺寸 = 2752×1536，按 `displaySize` 1920×1072 显示
 * - 角色帧 = 128×128，显示尺寸 118×118，脚底锚点
 */

import type { LibraryZone, SceneImageId, SceneStyle } from "../types";
import { applyNodeOverride, applyRoomOverride } from "./layout-override";

export type { SceneImageId, SceneStyle };

/** 资源根路径（public/ 下的目录，Vite 原样拷贝到 dist） */
export const ASSET_BASE = "/library-ops";

// ========== ClawLibrary 图书馆场景 ==========

export const CLAW_SCENE = {
  id: "claw-library",
  /** 逻辑分辨率（与上游 map.logic.json 一致） */
  logicWidth: 1920,
  logicHeight: 1080,
  /** 显示尺寸（上游 scene-art.manifest 的 displaySize） */
  displayWidth: 1920,
  displayHeight: 1072,
  /** 贴图原生尺寸 */
  nativeWidth: 2752,
  nativeHeight: 1536,
  floor: `${ASSET_BASE}/claw-library/scene-floor.webp`,
  objects: `${ASSET_BASE}/claw-library/scene-objects.webp`,
  walkableMask: `${ASSET_BASE}/claw-library/walkable-mask.webp`,
  /** 出处与许可（在 UI 的「资源许可」卡里展示） */
  credit: {
    project: "龙虾图书馆 / ClawLibrary",
    author: "shengyu-meng",
    repo: "https://github.com/shengyu-meng/ClawLibrary",
    license: "CC BY-NC-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    commercial: false,
    changes: "PNG → WebP 重压缩（像素尺寸不变）",
  },
} as const;

// ========== Star-Office-UI 办公室场景 ==========

export const STAR_SCENE = {
  id: "star-office",
  logicWidth: 1280,
  logicHeight: 720,
  displayWidth: 1280,
  displayHeight: 720,
  bg: `${ASSET_BASE}/star-office/office-bg-hd.webp`,
  bgLow: `${ASSET_BASE}/star-office/office-bg.webp`,
  cats: `${ASSET_BASE}/star-office/cats.webp`,
  starIdle: `${ASSET_BASE}/star-office/star-idle.webp`,
  starWorking: `${ASSET_BASE}/star-office/star-working.webp`,
  serverroom: `${ASSET_BASE}/star-office/serverroom.webp`,
  posters: `${ASSET_BASE}/star-office/posters.webp`,
  plants: `${ASSET_BASE}/star-office/plants.webp`,
  flowers: `${ASSET_BASE}/star-office/flowers.webp`,
  coffeeMachine: `${ASSET_BASE}/star-office/coffee-machine.webp`,
  desk: `${ASSET_BASE}/star-office/desk.webp`,
  sofa: `${ASSET_BASE}/star-office/sofa-idle.webp`,
  errorBug: `${ASSET_BASE}/star-office/error-bug.webp`,
  syncAnimation: `${ASSET_BASE}/star-office/sync-animation.webp`,
  credit: {
    project: "Star Office UI",
    author: "Ring Hyacinth & Simon Lee",
    repo: "https://github.com/ringhyacinth/Star-Office-UI",
    license: "仅限非商业（Non-commercial only）",
    licenseUrl: "https://github.com/ringhyacinth/Star-Office-UI/blob/main/LICENSE",
    commercial: false,
    changes: "WebP 重压缩",
  },
} as const;

/** 场景风格（定义在 types.ts，此处再导出便于渲染层就近引用） */
// 见 ../types.ts 的 SceneStyle

// ========== ClawLibrary 房间（逻辑坐标，1920×1080）==========

export interface PixelRoom {
  id: string;
  label: string;
  labelEn: string;
  /** [x, y, w, h] */
  bounds: [number, number, number, number];
  /** 房间标签锚点 */
  labelAnchor: { x: number; y: number };
  /** 工作位锚点 + 半径（角色在此工作） */
  work: { x: number; y: number; radius: number };
  /** 许可色令牌（房间高亮用） */
  token: string;
}

/**
 * 上游 12 个资源分区 → 本插件的 10 个职能岗位映射。
 * 一个岗位可能对应多个房间（如 front-desk 用 gateway 房间），
 * 也可能一个房间承载多个岗位（gateway / task_queues 同房间不同锚点）。
 */
export const ZONE_TO_ROOM: Record<string, string> = {
  "front-desk": "gateway", // 中心大厅 —— 队长 / 调度
  "reading-hall": "memory", // 左侧大房间 —— 阅览
  "catalog-room": "skills", // 顶部中 —— 技能锻炉 / 编目
  "code-forge": "mcp", // 顶部 —— 代码实验室
  "writing-studio": "document", // 左下 —— 文档归档
  archive: "images", // 右上 —— 图像工坊 / 档案
  "server-room": "log", // 右侧 —— 日志台 / 机房
  "meeting-room": "agent", // 下中 —— 运行监控 / 协作
  checkout: "task_queues", // 中心 —— 队列中枢 / 交付
  "quiet-corner": "break_room", // 右下 —— 休息室
};

export const PIXEL_ROOMS: PixelRoom[] = [
  {
    id: "gateway",
    label: "前台 · 调度台",
    labelEn: "Front Desk",
    bounds: [700, 320, 470, 300],
    labelAnchor: { x: 845, y: 400 },
    work: { x: 968, y: 602, radius: 24 },
    token: "--accent",
  },
  {
    id: "memory",
    label: "阅览大厅",
    labelEn: "Reading Hall",
    bounds: [50, 95, 500, 430],
    labelAnchor: { x: 366, y: 148 },
    work: { x: 362, y: 344, radius: 28 },
    token: "--info",
  },
  {
    id: "skills",
    label: "编目室",
    labelEn: "Catalog Room",
    bounds: [620, 50, 330, 250],
    labelAnchor: { x: 750, y: 52 },
    work: { x: 752, y: 247, radius: 24 },
    token: "--success",
  },
  {
    id: "mcp",
    label: "代码工坊",
    labelEn: "Code Forge",
    bounds: [960, 54, 210, 168],
    labelAnchor: { x: 1074, y: 58 },
    work: { x: 902, y: 240, radius: 22 },
    token: "--accent-hover",
  },
  {
    id: "document",
    label: "写作工坊",
    labelEn: "Writing Studio",
    bounds: [430, 650, 370, 250],
    labelAnchor: { x: 666, y: 664 },
    work: { x: 682, y: 822, radius: 28 },
    token: "--warning",
  },
  {
    id: "images",
    label: "档案室",
    labelEn: "Archive",
    bounds: [1280, 50, 280, 170],
    labelAnchor: { x: 1414, y: 57 },
    work: { x: 1420, y: 225, radius: 24 },
    token: "--accent-muted",
  },
  {
    id: "log",
    label: "机房 · 后台",
    labelEn: "Server Room",
    bounds: [1360, 325, 150, 130],
    labelAnchor: { x: 1440, y: 362 },
    work: { x: 1403, y: 516, radius: 22 },
    token: "--security-full",
  },
  {
    id: "agent",
    label: "会议厅",
    labelEn: "Meeting Room",
    bounds: [930, 650, 300, 210],
    labelAnchor: { x: 1086, y: 691 },
    work: { x: 1057, y: 858, radius: 24 },
    token: "--security-auto",
  },
  {
    id: "task_queues",
    label: "借还台 · 交付",
    labelEn: "Checkout",
    bounds: [700, 320, 470, 300],
    labelAnchor: { x: 845, y: 434 },
    work: { x: 968, y: 602, radius: 22 },
    token: "--security-ask",
  },
  {
    id: "break_room",
    label: "静思角",
    labelEn: "Quiet Corner",
    bounds: [1320, 740, 480, 220],
    labelAnchor: { x: 1500, y: 675 },
    work: { x: 1560, y: 875, radius: 28 },
    token: "--text-muted",
  },
  {
    id: "alarm",
    label: "报警台",
    labelEn: "Alert Deck",
    bounds: [1550, 50, 250, 170],
    labelAnchor: { x: 1607, y: 62 },
    work: { x: 1615, y: 208, radius: 22 },
    token: "--error",
  },
  {
    id: "schedule",
    label: "调度台",
    labelEn: "Scheduler",
    bounds: [1625, 325, 240, 130],
    labelAnchor: { x: 1715, y: 354 },
    work: { x: 1622, y: 488, radius: 22 },
    token: "--warning",
  },
];

/** 按 id 取房间（**已应用对位覆盖**） */
export function getPixelRoom(id: string): PixelRoom | undefined {
  return pixelRooms().find((r) => r.id === id);
}

/**
 * 全部房间（**已应用对位覆盖**）。
 * 用户在对位模式里拖动过的房间，bounds / labelAnchor / work 都以覆盖层为准。
 */
export function pixelRooms(): PixelRoom[] {
  return applyRoomOverride(PIXEL_ROOMS);
}

/** 全部路网节点（**已应用对位覆盖**） */
export function walkNodes(): WalkNode[] {
  return applyNodeOverride(WALK_NODES);
}

/** 路网边（只引用节点 id，节点移动后自动跟随） */
export function walkEdges(): Array<[string, string]> {
  return WALK_EDGES;
}

/**
 * 房间内的工作锚点（**已裁剪进房间矩形**）。
 *
 * 上游 `map.logic.json` 里 mcp / images / log / schedule 四个房间的 workZone 锚点
 * 落在房间矩形之外（数据不一致），直接使用会让角色站到走廊或隔壁房间；
 * 这里按 28px 边距把锚点夹回矩形内。
 */
export function workAnchor(room: PixelRoom): { x: number; y: number; radius: number } {
  const [bx, by, bw, bh] = room.bounds;
  const margin = 28;
  const x = Math.min(Math.max(room.work.x, bx + margin), bx + bw - margin);
  const y = Math.min(Math.max(room.work.y, by + margin), by + bh - margin);
  return { x, y, radius: room.work.radius };
}

/** 岗位 id → 房间锚点（逻辑坐标，已裁剪） */
export function roomAnchorOfZone(zoneId: string): { x: number; y: number; radius: number } {
  const room = getPixelRoom(roomOfZone(zoneId));
  return room ? workAnchor(room) : { x: 960, y: 540, radius: 24 };
}

/** 岗位 id → 房间（未知回退 gateway） */
export function roomOfZone(zoneId: string): string {
  return ZONE_TO_ROOM[zoneId] ?? "gateway";
}

// ========== 行走图（逻辑坐标）==========

export interface WalkNode {
  id: string;
  x: number;
  y: number;
  roomId: string;
}

/** 上游 walkGraph：20 个节点 / 19 条边（原样取自 map.logic.json） */
export const WALK_NODES: WalkNode[] = [
  { id: "DO1", x: 620, y: 860, roomId: "document" },
  { id: "ME1", x: 300, y: 320, roomId: "memory" },
  { id: "MC1", x: 1040, y: 610, roomId: "mcp" },
  { id: "IM1", x: 1435, y: 155, roomId: "images" },
  { id: "LG1", x: 1435, y: 430, roomId: "log" },
  { id: "SC1", x: 1555, y: 430, roomId: "schedule" },
  { id: "SK1", x: 756, y: 242, roomId: "skills" },
  { id: "GW1", x: 860, y: 610, roomId: "gateway" },
  { id: "AG1", x: 1080, y: 820, roomId: "agent" },
  { id: "BR1", x: 1560, y: 875, roomId: "break_room" },
  { id: "TQ1", x: 1735, y: 430, roomId: "task_queues" },
  { id: "AL1", x: 1690, y: 155, roomId: "alarm" },
  { id: "H1", x: 470, y: 375, roomId: "memory" },
  { id: "H2", x: 780, y: 375, roomId: "skills" },
  { id: "H3", x: 1080, y: 375, roomId: "mcp" },
  { id: "H4", x: 1450, y: 375, roomId: "log" },
  { id: "V1", x: 620, y: 700, roomId: "document" },
  { id: "V2", x: 830, y: 620, roomId: "gateway" },
  { id: "V3", x: 1080, y: 700, roomId: "agent" },
  { id: "V4", x: 1500, y: 760, roomId: "break_room" },
];

export const WALK_EDGES: Array<[string, string]> = [
  ["DO1", "H1"],
  ["ME1", "H1"],
  ["MC1", "H2"],
  ["IM1", "AL1"],
  ["AL1", "SC1"],
  ["LG1", "H4"],
  ["SC1", "H4"],
  ["H1", "H2"],
  ["H2", "H3"],
  ["H3", "H4"],
  ["H1", "V1"],
  ["V1", "SK1"],
  ["H2", "V2"],
  ["V2", "GW1"],
  ["GW1", "V3"],
  ["V3", "AG1"],
  ["V3", "V4"],
  ["V4", "BR1"],
  ["V4", "TQ1"],
];

// ========== 角色精灵（ClawLibrary）==========

export type SpriteAction =
  | "work"
  | "read"
  | "idea"
  | "repair"
  | "error"
  | "sleep"
  | "coffee"
  | "rest"
  | "walk"
  | "stand_front"
  | "stand_back"
  | "lie_flat"
  | "lie_side"
  | "front"
  | "game";

export interface SpriteSheet {
  /** 相对 ASSET_BASE 的路径 */
  path: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  columns: number;
  rows: number;
  fps: number;
}

/** 角色显示尺寸（上游 scene-art.manifest actor.displaySize） */
export const ACTOR_DISPLAY = { width: 118, height: 118, anchorOffsetY: -8, shadowOffsetY: 24 } as const;

/** 两个角色变体 */
export type SpriteVariant = "capy" | "cat";

export const SPRITE_VARIANTS: SpriteVariant[] = ["capy", "cat"];

/**
 * 逐动作精灵表元数据（帧尺寸 128×128，6 fps）。
 * 由上游 `manifest.json` 提取（capy 无 `game/lie_side/front`，cat 无 `read/rest/lie_flat`）。
 */
export const SPRITE_SHEETS: Record<SpriteVariant, Partial<Record<SpriteAction, SpriteSheet>>> = {
  capy: {
    work: { path: "actors/capy/work.webp", frameWidth: 128, frameHeight: 128, frameCount: 31, columns: 6, rows: 6, fps: 6 },
    read: { path: "actors/capy/read.webp", frameWidth: 128, frameHeight: 128, frameCount: 35, columns: 6, rows: 6, fps: 6 },
    idea: { path: "actors/capy/idea.webp", frameWidth: 128, frameHeight: 128, frameCount: 35, columns: 6, rows: 6, fps: 6 },
    repair: { path: "actors/capy/repair.webp", frameWidth: 128, frameHeight: 128, frameCount: 23, columns: 5, rows: 5, fps: 6 },
    error: { path: "actors/capy/error.webp", frameWidth: 128, frameHeight: 128, frameCount: 35, columns: 6, rows: 6, fps: 6 },
    sleep: { path: "actors/capy/sleep.webp", frameWidth: 128, frameHeight: 128, frameCount: 33, columns: 6, rows: 6, fps: 6 },
    coffee: { path: "actors/capy/coffee.webp", frameWidth: 128, frameHeight: 128, frameCount: 36, columns: 6, rows: 6, fps: 6 },
    rest: { path: "actors/capy/rest.webp", frameWidth: 128, frameHeight: 128, frameCount: 37, columns: 7, rows: 6, fps: 6 },
    walk: { path: "actors/capy/walk.webp", frameWidth: 128, frameHeight: 128, frameCount: 43, columns: 7, rows: 7, fps: 6 },
    stand_front: { path: "actors/capy/stand_front.webp", frameWidth: 128, frameHeight: 128, frameCount: 37, columns: 7, rows: 6, fps: 6 },
    stand_back: { path: "actors/capy/stand_back.webp", frameWidth: 128, frameHeight: 128, frameCount: 37, columns: 7, rows: 6, fps: 6 },
    lie_flat: { path: "actors/capy/lie_flat.webp", frameWidth: 128, frameHeight: 128, frameCount: 28, columns: 6, rows: 5, fps: 6 },
  },
  cat: {
    work: { path: "actors/cat/work.webp", frameWidth: 128, frameHeight: 128, frameCount: 24, columns: 5, rows: 5, fps: 6 },
    idea: { path: "actors/cat/idea.webp", frameWidth: 128, frameHeight: 128, frameCount: 28, columns: 6, rows: 5, fps: 6 },
    repair: { path: "actors/cat/repair.webp", frameWidth: 128, frameHeight: 128, frameCount: 21, columns: 5, rows: 5, fps: 6 },
    error: { path: "actors/cat/error.webp", frameWidth: 128, frameHeight: 128, frameCount: 20, columns: 5, rows: 4, fps: 6 },
    sleep: { path: "actors/cat/sleep.webp", frameWidth: 128, frameHeight: 128, frameCount: 23, columns: 5, rows: 5, fps: 6 },
    coffee: { path: "actors/cat/coffee.webp", frameWidth: 128, frameHeight: 128, frameCount: 21, columns: 5, rows: 5, fps: 6 },
    walk: { path: "actors/cat/walk.webp", frameWidth: 128, frameHeight: 128, frameCount: 13, columns: 4, rows: 4, fps: 6 },
    stand_front: { path: "actors/cat/stand_front.webp", frameWidth: 128, frameHeight: 128, frameCount: 36, columns: 6, rows: 6, fps: 6 },
    stand_back: { path: "actors/cat/stand_back.webp", frameWidth: 128, frameHeight: 128, frameCount: 31, columns: 6, rows: 6, fps: 6 },
    lie_side: { path: "actors/cat/lie_side.webp", frameWidth: 128, frameHeight: 128, frameCount: 20, columns: 5, rows: 4, fps: 6 },
    front: { path: "actors/cat/front.webp", frameWidth: 128, frameHeight: 128, frameCount: 30, columns: 6, rows: 5, fps: 6 },
    game: { path: "actors/cat/game.webp", frameWidth: 128, frameHeight: 128, frameCount: 26, columns: 6, rows: 5, fps: 6 },
  },
};

/** 取精灵表（缺失动作时回退链） */
export function resolveSprite(variant: SpriteVariant, action: SpriteAction): { variant: SpriteVariant; action: SpriteAction; sheet: SpriteSheet } {
  const sheets = SPRITE_SHEETS[variant];
  const fallback: SpriteAction[] = [action, "stand_front", "front", "work", "idea"];
  for (const a of fallback) {
    const s = sheets[a];
    if (s) return { variant, action: a, sheet: s };
  }
  // 理论不可达：capy 至少有 work
  return { variant: "capy", action: "work", sheet: SPRITE_SHEETS.capy.work! };
}

/** 资源 URL */
export function spriteUrl(variant: SpriteVariant, action: SpriteAction): string {
  return `${ASSET_BASE}/claw-library/${resolveSprite(variant, action).sheet.path}`;
}

// ========== 活动 → 精灵动作 ==========

/**
 * 11 种工作状态 → 像素精灵动作。
 * 参考上游 `LobsterStateId`（idle/writing/cataloging/documenting/syncing/
 * monitoring/researching/executing/error/resting）与 ClawLibrary 的动作表。
 */
export const ACTIVITY_TO_SPRITE: Record<string, SpriteAction> = {
  idle: "stand_front",
  walking: "walk",
  thinking: "idea",
  reading: "read",
  writing: "work",
  working: "work",
  searching: "read",
  blocked: "rest",
  done: "coffee",
  error: "error",
  sleeping: "sleep",
};

// ========== 场景图片预设 ==========

/**
 * 一张场景预设 = 若干图层（按顺序叠加）。
 * - `claw`：上游地板 + 家具两层（像素画，最近邻缩放）
 * - `ai-library-01`：本项目内置的一整张 AI 生成场景图（按 docs/art-prompts/01-图书馆场景.md 生成）
 *
 * 所有预设都必须是 2752×1536（或至少 16:9），这样角色坐标与岗位标签无需改动即可对齐。
 * 用户自己上传的图片走 `sceneImageId: "custom"`，不进这张表。
 */
export interface ScenePreset {
  id: SceneImageId;
  label: string;
  labelEn: string;
  /** 图层 URL（顺序叠加） */
  layers: string[];
  /** 设置面板缩略图 */
  thumb: string;
  /** 像素画渲染（image-rendering: pixelated） */
  pixelated: boolean;
  /** 出处与许可一句话（设置面板展示） */
  credit: string;
  /** 是否可商用 */
  commercial: boolean;
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: "claw",
    label: "龙虾图书馆（内置像素画）",
    labelEn: "ClawLibrary (built-in)",
    layers: [CLAW_SCENE.floor, CLAW_SCENE.objects],
    thumb: CLAW_SCENE.floor,
    pixelated: true,
    credit: "ClawLibrary / shengyu-meng · CC BY-NC-SA 4.0（仅限非商业）",
    commercial: false,
  },
  {
    id: "ai-library-01",
    label: "AI 图书馆 01（内置场景图）",
    labelEn: "AI Library 01 (built-in)",
    layers: [`${ASSET_BASE}/scenes/ai-library-01.webp`],
    thumb: `${ASSET_BASE}/scenes/ai-library-01-thumb.webp`,
    pixelated: false,
    credit: "本项目内置 · AI 生成 / 自有素材（可商用）",
    commercial: true,
  },
];

/** 按 id 取预设（未知 id 返回 undefined） */
export function getScenePreset(id: string): ScenePreset | undefined {
  return SCENE_PRESETS.find((p) => p.id === id);
}

/** 默认预设（设置里选了 custom 但还没有图片时用它兜底） */
export const FALLBACK_SCENE_PRESET_ID: SceneImageId = "ai-library-01";

// ========== 场景风格 ==========

export const SCENE_CREDITS = [CLAW_SCENE.credit, STAR_SCENE.credit];

/** 角色变体 → 中文说明（设置页/图例用） */
export const VARIANT_LABELS: Record<SpriteVariant, string> = {
  capy: "Capy-Claw（水豚爪）",
  cat: "Cat-Claw（猫咪爪）",
};

/** 岗位 → 默认角色变体（让不同岗位尽量用不同角色） */
export const ZONE_VARIANT: Record<string, SpriteVariant> = {
  "front-desk": "cat",
  "reading-hall": "capy",
  "catalog-room": "cat",
  "code-forge": "capy",
  "writing-studio": "cat",
  archive: "capy",
  "server-room": "cat",
  "meeting-room": "capy",
  checkout: "cat",
  "quiet-corner": "capy",
};

/** 角色变体分配（按 actor id 稳定散列，同岗位多人时错开） */
export function pickVariant(actorId: string, zoneId: string): SpriteVariant {
  const base = ZONE_VARIANT[zoneId] ?? "capy";
  let h = 0;
  for (let i = 0; i < actorId.length; i++) h = (h * 31 + actorId.charCodeAt(i)) >>> 0;
  // 70% 用岗位默认变体，30% 用另一个，保证同岗位多角色也有区分
  return h % 10 < 7 ? base : base === "capy" ? "cat" : "capy";
}

/** 本插件的岗位定义（用于像素场景的图例与配色） */
export function zoneTokenOf(zone: LibraryZone): string {
  return zone.token;
}
