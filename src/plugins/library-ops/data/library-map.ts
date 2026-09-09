/**
 * 图书馆平面图 —— 等距（isometric）瓦片地图。
 *
 * 设计来源：ClawLibrary 的「一间图书馆 + 角色在各自岗位工作」视觉母题，
 * 但本图是**多岗位团队版**：10 个功能区，每个功能区对应 Codem 中一类
 * 智能体职责（队长 / 研究 / 编目 / 编码 / 写作 / 归档 / 运维 / 协作 /
 * 交付 / 待命），运行时按角色标签把团队角色与子智能体派到对应岗位。
 *
 * 坐标系统：瓦片空间 (col, row) → 等距屏幕空间
 *   x = (col - row) * tileWidth / 2
 *   y = (col + row) * tileHeight / 2
 * 与 ClawLibrary / 大富翁 BoardScene 的 2.5D 等距表达一致。
 *
 * 颜色：区域主色只写**语义令牌名**（如 `--accent`），渲染时拼成
 * `var(--token)`。全文件不含任何硬编码色值（皮肤兼容契约 SC-2）。
 */

import type { LibraryDecor, LibraryMap, LibraryZone, ScreenPoint, TileCoord } from "../types";

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;

/** 网格规模 */
export const GRID_COLS = 24;
export const GRID_ROWS = 18;

/** 入口瓦片（新角色入场点） */
export const ENTRANCE: TileCoord = { col: 12, row: 17 };

// ========== 区域定义 ==========

export const LIBRARY_ZONES: LibraryZone[] = [
  {
    id: "front-desk",
    name: "前台 · 调度台",
    nameEn: "Front Desk",
    duty: "接单、拆解、派发与汇总——队长与主会话在此坐镇",
    icon: "🛎️",
    rect: { col: 9, row: 0, w: 6, h: 3 },
    station: { col: 11, row: 1 },
    capacity: 2,
    token: "--accent",
    keywords: ["队长", "captain", "leader", "主控", "orchestr", "调度", "lead", "chief"],
    activity: "thinking",
  },
  {
    id: "reading-hall",
    name: "阅览大厅",
    nameEn: "Reading Hall",
    duty: "通读源码与资料——研究、调研、分析类角色在此查阅",
    icon: "📖",
    rect: { col: 1, row: 3, w: 8, h: 6 },
    station: { col: 4, row: 5 },
    capacity: 4,
    token: "--info",
    keywords: ["研究", "调研", "分析", "探索", "research", "explore", "analys", "read", "review", "评审", "侦查"],
    activity: "reading",
  },
  {
    id: "catalog-room",
    name: "编目室",
    nameEn: "Catalog Room",
    duty: "建立索引与检索——检索、整理、知识入库类角色在此工作",
    icon: "🗂️",
    rect: { col: 1, row: 10, w: 6, h: 5 },
    station: { col: 3, row: 12 },
    capacity: 3,
    token: "--success",
    keywords: ["索引", "编目", "检索", "搜索", "catalog", "index", "search", "grep", "整理", "知识库"],
    activity: "searching",
  },
  {
    id: "code-forge",
    name: "代码工坊",
    nameEn: "Code Forge",
    duty: "敲代码与跑构建——实现、修复、测试类角色在此动手",
    icon: "🛠️",
    rect: { col: 9, row: 4, w: 7, h: 5 },
    station: { col: 12, row: 6 },
    capacity: 4,
    token: "--accent-hover",
    keywords: ["代码", "实现", "编码", "开发", "前端", "后端", "修复", "重构", "code", "dev", "build", "fix", "impl", "engineer", "test", "测试"],
    activity: "working",
  },
  {
    id: "writing-studio",
    name: "写作工坊",
    nameEn: "Writing Studio",
    duty: "撰写文档与产出——文案、文档、PPT、报告类角色在此落笔",
    icon: "✍️",
    rect: { col: 16, row: 3, w: 7, h: 6 },
    station: { col: 19, row: 5 },
    capacity: 3,
    token: "--warning",
    keywords: ["写作", "文档", "文案", "报告", "ppt", "write", "doc", "content", "author", "说明", "翻译"],
    activity: "writing",
  },
  {
    id: "archive",
    name: "档案室",
    nameEn: "Archive",
    duty: "沉淀记忆与快照——记忆、归档、知识管理类角色在此存档",
    icon: "🗄️",
    rect: { col: 16, row: 10, w: 7, h: 5 },
    station: { col: 19, row: 12 },
    capacity: 3,
    token: "--accent-muted",
    keywords: ["记忆", "归档", "存档", "快照", "memory", "archive", "snapshot", "历史", "备份"],
    activity: "working",
  },
  {
    id: "server-room",
    name: "机房 · 后台",
    nameEn: "Server Room",
    duty: "跑任务与守服务——运维、后台任务、自动化在此运转",
    icon: "🖥️",
    rect: { col: 9, row: 10, w: 7, h: 5 },
    station: { col: 12, row: 12 },
    capacity: 3,
    token: "--security-full",
    keywords: ["运维", "部署", "后台", "任务", "自动化", "ops", "infra", "deploy", "job", "cron", "监控", "terminal", "bash"],
    activity: "working",
  },
  {
    id: "meeting-room",
    name: "会议厅",
    nameEn: "Meeting Room",
    duty: "对齐与协商——团队沟通、消息投递、跨角色协作在此发生",
    icon: "💬",
    rect: { col: 1, row: 0, w: 7, h: 3 },
    station: { col: 3, row: 1 },
    capacity: 3,
    token: "--security-auto",
    keywords: ["协作", "沟通", "会议", "team", "meeting", "coordina", "协作", "协商", "mailbox", "对齐"],
    activity: "thinking",
  },
  {
    id: "checkout",
    name: "借还台 · 交付",
    nameEn: "Checkout",
    duty: "交付产出——文件产出、成果汇总、交付验收在此完成",
    icon: "📤",
    rect: { col: 16, row: 0, w: 7, h: 3 },
    station: { col: 19, row: 1 },
    capacity: 2,
    token: "--security-ask",
    keywords: ["交付", "产出", "输出", "汇总", "deliver", "output", "summar", "验收", "提交"],
    activity: "done",
  },
  {
    id: "quiet-corner",
    name: "静思角",
    nameEn: "Quiet Corner",
    duty: "待命与休整——空闲、离线、已归档的角色在此歇脚",
    icon: "☕",
    rect: { col: 1, row: 15, w: 7, h: 3 },
    station: { col: 4, row: 16 },
    capacity: 5,
    token: "--text-muted",
    keywords: ["空闲", "待命", "idle", "rest", "休整", "离线"],
    activity: "idle",
  },
];

/** 兜底岗位（无法判定职责时） */
export const DEFAULT_ZONE_ID = "reading-hall";

// ========== 装饰（纯视觉） ==========

export const LIBRARY_DECOR: LibraryDecor[] = [
  // 阅览大厅：长桌 + 台灯 + 地毯
  { kind: "carpet", tile: { col: 3, row: 4 }, span: 4, token: "--info" },
  { kind: "table", tile: { col: 3, row: 4 } },
  { kind: "table", tile: { col: 6, row: 6 } },
  { kind: "lamp", tile: { col: 2, row: 6 } },
  { kind: "lamp", tile: { col: 7, row: 4 } },
  { kind: "bookshelf", tile: { col: 1, row: 3 }, span: 2 },
  { kind: "bookshelf", tile: { col: 1, row: 5 }, span: 2 },
  { kind: "plant", tile: { col: 8, row: 8 } },
  // 编目室
  { kind: "bookshelf", tile: { col: 1, row: 10 }, span: 2 },
  { kind: "bookshelf", tile: { col: 5, row: 10 }, span: 2 },
  { kind: "table", tile: { col: 3, row: 13 } },
  { kind: "terminal", tile: { col: 5, row: 13 } },
  // 代码工坊
  { kind: "terminal", tile: { col: 10, row: 5 } },
  { kind: "terminal", tile: { col: 14, row: 5 } },
  { kind: "terminal", tile: { col: 10, row: 8 } },
  { kind: "terminal", tile: { col: 14, row: 8 } },
  { kind: "table", tile: { col: 12, row: 7 } },
  { kind: "plant", tile: { col: 9, row: 8 } },
  // 写作工坊
  { kind: "table", tile: { col: 18, row: 4 } },
  { kind: "table", tile: { col: 20, row: 7 } },
  { kind: "lamp", tile: { col: 22, row: 4 } },
  { kind: "bookshelf", tile: { col: 16, row: 8 }, span: 2 },
  // 档案室
  { kind: "bookshelf", tile: { col: 16, row: 10 }, span: 3 },
  { kind: "bookshelf", tile: { col: 21, row: 10 }, span: 2 },
  { kind: "table", tile: { col: 19, row: 14 } },
  // 机房
  { kind: "terminal", tile: { col: 10, row: 11 } },
  { kind: "terminal", tile: { col: 14, row: 11 } },
  { kind: "terminal", tile: { col: 10, row: 14 } },
  { kind: "terminal", tile: { col: 14, row: 14 } },
  // 会议厅
  { kind: "carpet", tile: { col: 2, row: 0 }, span: 5, token: "--security-auto" },
  { kind: "table", tile: { col: 4, row: 1 } },
  { kind: "plant", tile: { col: 7, row: 2 } },
  // 前台
  { kind: "counter", tile: { col: 10, row: 1 }, span: 4, token: "--accent" },
  { kind: "plant", tile: { col: 14, row: 2 } },
  // 借还台
  { kind: "counter", tile: { col: 17, row: 1 }, span: 4, token: "--security-ask" },
  { kind: "bookshelf", tile: { col: 16, row: 2 }, span: 2 },
  // 静思角
  { kind: "plant", tile: { col: 2, row: 16 } },
  { kind: "plant", tile: { col: 6, row: 16 } },
  { kind: "table", tile: { col: 4, row: 15 } },
  // 入口
  { kind: "stairs", tile: { col: 12, row: 17 }, span: 2, token: "--border-primary" },
  { kind: "plant", tile: { col: 10, row: 17 } },
  { kind: "plant", tile: { col: 14, row: 17 } },
];

// ========== 地图对象 ==========

export const LIBRARY_MAP: LibraryMap = {
  tileWidth: TILE_WIDTH,
  tileHeight: TILE_HEIGHT,
  cols: GRID_COLS,
  rows: GRID_ROWS,
  entrance: ENTRANCE,
  zones: LIBRARY_ZONES,
  decor: LIBRARY_DECOR,
};

// ========== 投影 / 查询工具 ==========

/** 瓦片 → 等距屏幕坐标（未加平移） */
export function tileToScreen(tile: TileCoord, map: LibraryMap = LIBRARY_MAP): ScreenPoint {
  return {
    x: ((tile.col - tile.row) * map.tileWidth) / 2,
    y: ((tile.col + tile.row) * map.tileHeight) / 2,
  };
}

/** 等距屏幕坐标 → 瓦片（向下取整） */
export function screenToTile(point: ScreenPoint, map: LibraryMap = LIBRARY_MAP): TileCoord {
  const a = point.x / (map.tileWidth / 2);
  const b = point.y / (map.tileHeight / 2);
  return { col: Math.round((b + a) / 2), row: Math.round((b - a) / 2) };
}

/** 整张地图的等距包围盒（含装饰 span 外扩） */
export function mapBounds(map: LibraryMap = LIBRARY_MAP): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  const corners: TileCoord[] = [
    { col: 0, row: 0 },
    { col: map.cols, row: 0 },
    { col: 0, row: map.rows },
    { col: map.cols, row: map.rows },
  ].map((c) => c);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const p = tileToScreen(c, map);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  // 顶部/底部各留半个瓦片高度（菱形顶点）
  return {
    minX,
    minY: minY - map.tileHeight,
    maxX,
    maxY: maxY + map.tileHeight,
    width: maxX - minX + map.tileWidth,
    height: maxY - minY + map.tileHeight * 2,
  };
}

/** 按 id 查区域 */
export function getZone(id: string, map: LibraryMap = LIBRARY_MAP): LibraryZone | undefined {
  return map.zones.find((z) => z.id === id);
}

/** 瓦片是否落在区域矩形内 */
export function isTileInZone(tile: TileCoord, zone: LibraryZone): boolean {
  return (
    tile.col >= zone.rect.col &&
    tile.col < zone.rect.col + zone.rect.w &&
    tile.row >= zone.rect.row &&
    tile.row < zone.rect.row + zone.rect.h
  );
}

/** 查询瓦片所属区域（无则 undefined） */
export function zoneAt(tile: TileCoord, map: LibraryMap = LIBRARY_MAP): LibraryZone | undefined {
  return map.zones.find((z) => isTileInZone(tile, z));
}

/**
 * 区域内的第 n 个工位瓦片。
 *
 * 工位以 `station` 为中心按「环形扩张」排列，**只取落在本区域矩形内的瓦片**，
 * 保证同一岗位的多个角色不会叠格、也不会站到走廊或别的岗位上；超出容量的
 * 角色继续向外扩张（不会失败）。返回顺序稳定：先按曼哈顿距离，再按 col/row。
 */
export function stationSlot(zone: LibraryZone, index: number): TileCoord {
  if (index <= 0) return { ...zone.station };
  const radius = Math.ceil(Math.sqrt(index + 1)) + 2;
  const ring: TileCoord[] = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dc === 0 && dr === 0) continue;
      const t = { col: zone.station.col + dc, row: zone.station.row + dr };
      if (!isTileInZone(t, zone)) continue;
      ring.push(t);
    }
  }
  if (ring.length === 0) return { ...zone.station };
  ring.sort((a, b) => {
    const da = Math.abs(a.col - zone.station.col) + Math.abs(a.row - zone.station.row);
    const db = Math.abs(b.col - zone.station.col) + Math.abs(b.row - zone.station.row);
    if (da !== db) return da - db;
    if (a.col !== b.col) return a.col - b.col;
    return a.row - b.row;
  });
  const pick = ring[(index - 1) % ring.length];
  return { col: pick.col, row: pick.row };
}

/** 角色标签 → 岗位 id（关键词命中，最长关键词优先） */
export function resolveZoneId(roleLabel: string, map: LibraryMap = LIBRARY_MAP): string {
  const hay = (roleLabel || "").toLowerCase();
  if (!hay.trim()) return DEFAULT_ZONE_ID;
  let best: { id: string; len: number } | null = null;
  for (const zone of map.zones) {
    for (const kw of zone.keywords) {
      if (hay.includes(kw.toLowerCase())) {
        if (!best || kw.length > best.len) best = { id: zone.id, len: kw.length };
      }
    }
  }
  return best?.id ?? DEFAULT_ZONE_ID;
}

/**
 * 等距曼哈顿寻路：先横后纵的 L 形折线（图书馆是开放平面，无需 A*）。
 * 返回**不含起点**的路径点序列。
 */
export function planPath(from: TileCoord, to: TileCoord): TileCoord[] {
  const path: TileCoord[] = [];
  let col = from.col;
  let row = from.row;
  while (col !== to.col) {
    col += Math.sign(to.col - col);
    path.push({ col, row });
  }
  while (row !== to.row) {
    row += Math.sign(to.row - row);
    path.push({ col, row });
  }
  return path;
}
