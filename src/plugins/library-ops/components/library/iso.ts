/**
 * 等距几何工具 —— 场景渲染的唯一坐标来源。
 *
 * ## 两套坐标约定（之前混用导致区域高亮/地板/网格错位，此处固化）
 * - `tilePoint(c, r)`  ：瓦片空间点 (c, r) 的屏幕坐标 —— 即瓦片 (c,r) 的**北顶点**。
 *   区域矩形、地板外框、网格线一律用「块角点」表达。
 * - `tileCenter(c, r)` ：瓦片 (c,r) 的**菱形中心** —— 角色、家具、标签、入口用它。
 *
 * 关系：`tileCenter(c,r) === tilePoint(c + 0.5, r + 0.5)`。
 *
 * 投影公式（与 ClawLibrary / 大富翁 BoardScene 同族）：
 *   x = (c - r) * tileWidth / 2
 *   y = (c + r) * tileHeight / 2
 *
 * 画布原点：把 `mapBounds()` 的左上角平移到 (0,0)，因此所有返回值均 ≥ 0。
 */

import type { LibraryDecor, ScreenPoint } from "../../types";
import { LIBRARY_MAP, mapBounds } from "../../data/library-map";

export const TILE_W = LIBRARY_MAP.tileWidth;
export const TILE_H = LIBRARY_MAP.tileHeight;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

const BOUNDS = mapBounds();
export const OFFSET_X = -BOUNDS.minX;
export const OFFSET_Y = -BOUNDS.minY;
export const CANVAS_W = Math.ceil(BOUNDS.width);
export const CANVAS_H = Math.ceil(BOUNDS.height);

/** 瓦片空间点 → 画布坐标 */
export function tilePoint(col: number, row: number): ScreenPoint {
  return {
    x: ((col - row) * TILE_W) / 2 + OFFSET_X,
    y: ((col + row) * TILE_H) / 2 + OFFSET_Y,
  };
}

/** 瓦片中心 → 画布坐标（角色 / 家具 / 标签锚点） */
export function tileCenter(col: number, row: number): ScreenPoint {
  return tilePoint(col + 0.5, row + 0.5);
}

/** 矩形块（瓦片空间）→ 等距多边形顶点串（顺序：北 → 东 → 南 → 西） */
export function blockPoints(rect: { col: number; row: number; w: number; h: number }): string {
  return [
    tilePoint(rect.col, rect.row),
    tilePoint(rect.col + rect.w, rect.row),
    tilePoint(rect.col + rect.w, rect.row + rect.h),
    tilePoint(rect.col, rect.row + rect.h),
  ]
    .map((p) => `${round(p.x)},${round(p.y)}`)
    .join(" ");
}

/** 整块地板多边形 */
export function floorPoints(): string {
  return blockPoints({ col: 0, row: 0, w: LIBRARY_MAP.cols, h: LIBRARY_MAP.rows });
}

/** 网格线（两组平行线，精确对齐瓦片角点） */
export function gridLines(): Array<{ x1: number; y1: number; x2: number; y2: number; key: string }> {
  const out: Array<{ x1: number; y1: number; x2: number; y2: number; key: string }> = [];
  for (let c = 0; c <= LIBRARY_MAP.cols; c++) {
    const a = tilePoint(c, 0);
    const b = tilePoint(c, LIBRARY_MAP.rows);
    out.push({ x1: round(a.x), y1: round(a.y), x2: round(b.x), y2: round(b.y), key: `c${c}` });
  }
  for (let r = 0; r <= LIBRARY_MAP.rows; r++) {
    const a = tilePoint(0, r);
    const b = tilePoint(LIBRARY_MAP.cols, r);
    out.push({ x1: round(a.x), y1: round(a.y), x2: round(b.x), y2: round(b.y), key: `r${r}` });
  }
  return out;
}

/** 背墙高度（像素） */
export const WALL_H = 104;

/** 背墙多边形（北侧两条边），`nw` = 西段（沿 col 轴），`ne` = 北段（沿 row 轴） */
export function wallPoints(side: "nw" | "ne"): string {
  if (side === "nw") {
    const a = tilePoint(0, 0);
    const b = tilePoint(LIBRARY_MAP.cols, 0);
    return `${round(a.x)},${round(a.y)} ${round(a.x)},${round(a.y - WALL_H)} ${round(b.x)},${round(b.y - WALL_H)} ${round(b.x)},${round(b.y)}`;
  }
  const b = tilePoint(LIBRARY_MAP.cols, 0);
  const c = tilePoint(LIBRARY_MAP.cols, LIBRARY_MAP.rows);
  return `${round(b.x)},${round(b.y)} ${round(b.x)},${round(b.y - WALL_H)} ${round(c.x)},${round(c.y - WALL_H)} ${round(c.x)},${round(c.y)}`;
}

/** 墙上的窗（等距平行四边形），沿墙按 t∈[0,1] 定位 */
export function wallWindow(side: "nw" | "ne", t: number, span = 0.16, height = 46, sill = 30): string {
  const along = side === "nw" ? { a: tilePoint(0, 0), b: tilePoint(LIBRARY_MAP.cols, 0) } : { a: tilePoint(LIBRARY_MAP.cols, 0), b: tilePoint(LIBRARY_MAP.cols, LIBRARY_MAP.rows) };
  const p0 = lerp(along.a, along.b, t);
  const p1 = lerp(along.a, along.b, Math.min(1, t + span));
  const top = -sill - height;
  return [
    `${round(p0.x)},${round(p0.y + top)}`,
    `${round(p1.x)},${round(p1.y + top)}`,
    `${round(p1.x)},${round(p1.y - sill)}`,
    `${round(p0.x)},${round(p0.y - sill)}`,
  ].join(" ");
}

function lerp(a: ScreenPoint, b: ScreenPoint, t: number): ScreenPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ========== 等距立方体（家具通用） ==========

export interface IsoBox {
  /** 顶面多边形 */
  top: string;
  /** 东侧面（+col 方向） */
  east: string;
  /** 南侧面（+row 方向） */
  south: string;
  /** 顶面中心（放装饰用） */
  topCenter: ScreenPoint;
  /** 底座中心（放阴影用） */
  baseCenter: ScreenPoint;
}

/**
 * 生成等距立方体的三个可见面。
 * @param col,row 瓦片空间起始角
 * @param w,d     占地在 col / row 方向的瓦片数
 * @param h       高度（像素）
 */
export function isoBox(col: number, row: number, w: number, d: number, h: number): IsoBox {
  const nw = tilePoint(col, row);
  const ne = tilePoint(col + w, row);
  const se = tilePoint(col + w, row + d);
  const sw = tilePoint(col, row + d);

  const up = (p: ScreenPoint): ScreenPoint => ({ x: p.x, y: p.y - h });

  const top = [up(nw), up(ne), up(se), up(sw)].map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
  const east = [ne, se, up(se), up(ne)].map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
  const south = [sw, se, up(se), up(sw)].map((p) => `${round(p.x)},${round(p.y)}`).join(" ");

  return {
    top,
    east,
    south,
    topCenter: { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 - h },
    baseCenter: { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 },
  };
}

/** 家具默认尺寸（瓦片数 / 像素高度） */
export const FURNITURE_SIZE: Record<LibraryDecor["kind"], { w: number; d: number; h: number; token: string }> = {
  bookshelf: { w: 2, d: 1, h: 58, token: "--text-secondary" },
  table: { w: 2, d: 1, h: 26, token: "--warning" },
  terminal: { w: 1, d: 1, h: 24, token: "--info" },
  counter: { w: 4, d: 1, h: 36, token: "--accent" },
  plant: { w: 1, d: 1, h: 12, token: "--success" },
  lamp: { w: 1, d: 1, h: 6, token: "--warning" },
  carpet: { w: 3, d: 3, h: 0, token: "--info" },
  stairs: { w: 2, d: 1, h: 16, token: "--text-muted" },
};

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
