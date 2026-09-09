/**
 * 图书馆寻路 —— 网格 BFS（对标 ClawLibrary `core/pathfinder.ts` 的
 * walkGraph + BFS 路由，但用等距瓦片网格替代多边形/手工图，更适合开放平面）。
 *
 * 可通行规则：
 * - 网格内所有瓦片默认可通行；
 * - 阻挡类装饰（书架 / 长桌 / 终端 / 柜台 / 绿植）占据的瓦片不可通行；
 * - 装饰「地毯 / 台灯 / 楼梯」不阻挡。
 *
 * 纯函数、无副作用，可在 happy-dom / node 下直接单测。
 */

import type { LibraryDecor, LibraryMap, TileCoord } from "../types";
import { LIBRARY_MAP } from "../data/library-map";

/** 阻挡通行的装饰类型 */
export const BLOCKING_DECOR: ReadonlySet<LibraryDecor["kind"]> = new Set([
  "bookshelf",
  "table",
  "terminal",
  "counter",
  "plant",
]);

export type WalkGrid = {
  cols: number;
  rows: number;
  /** 行主序：true = 可通行 */
  cells: boolean[];
};

function index(grid: WalkGrid, tile: TileCoord): number {
  return tile.row * grid.cols + tile.col;
}

function inBounds(grid: WalkGrid, tile: TileCoord): boolean {
  return tile.col >= 0 && tile.col < grid.cols && tile.row >= 0 && tile.row < grid.rows;
}

/** 瓦片是否可通行（越界视为不可通行） */
export function isWalkable(grid: WalkGrid, tile: TileCoord): boolean {
  if (!inBounds(grid, tile)) return false;
  return grid.cells[index(grid, tile)] === true;
}

/** 由地图构建可通行网格 */
export function buildWalkGrid(map: LibraryMap = LIBRARY_MAP): WalkGrid {
  const cols = map.cols;
  const rows = map.rows;
  const cells = new Array<boolean>(cols * rows).fill(true);

  const grid: WalkGrid = { cols, rows, cells };

  for (const decor of map.decor) {
    if (!BLOCKING_DECOR.has(decor.kind)) continue;
    const span = Math.max(1, decor.span ?? 1);
    for (let i = 0; i < span; i++) {
      const tile = { col: decor.tile.col + i, row: decor.tile.row };
      if (inBounds(grid, tile)) cells[index(grid, tile)] = false;
    }
  }
  return grid;
}

/** 最近可通行瓦片（半径内环形搜索；找不到时返回起点） */
export function nearestWalkable(tile: TileCoord, grid: WalkGrid, maxRadius = 6): TileCoord {
  if (isWalkable(grid, tile)) return { ...tile };
  for (let r = 1; r <= maxRadius; r++) {
    const candidates: TileCoord[] = [];
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.abs(dc) + Math.abs(dr) > r) continue;
        candidates.push({ col: tile.col + dc, row: tile.row + dr });
      }
    }
    candidates.sort((a, b) => {
      const da = Math.abs(a.col - tile.col) + Math.abs(a.row - tile.row);
      const db = Math.abs(b.col - tile.col) + Math.abs(b.row - tile.row);
      if (da !== db) return da - db;
      if (a.col !== b.col) return a.col - b.col;
      return a.row - b.row;
    });
    const hit = candidates.find((c) => isWalkable(grid, c));
    if (hit) return hit;
  }
  return { ...tile };
}

/** 四邻域（等距地图上「上下左右」对应屏幕上的四个对角方向） */
const NEIGHBORS: ReadonlyArray<TileCoord> = [
  { col: 1, row: 0 },
  { col: -1, row: 0 },
  { col: 0, row: 1 },
  { col: 0, row: -1 },
];

/**
 * 网格 BFS 寻路。返回**不含起点**的路径瓦片序列；不可达时返回空数组。
 * 使用 BFS 保证最短步数；同层按固定邻居顺序展开，结果确定性可测。
 */
export function findPath(from: TileCoord, to: TileCoord, grid: WalkGrid): TileCoord[] {
  const start = nearestWalkable(from, grid);
  const goal = nearestWalkable(to, grid);
  if (start.col === goal.col && start.row === goal.row) return [];
  if (!isWalkable(grid, start) || !isWalkable(grid, goal)) return [];

  const total = grid.cols * grid.rows;
  const visited = new Uint8Array(total);
  const parent = new Int32Array(total).fill(-1);
  const queue: number[] = [index(grid, start)];
  visited[queue[0]] = 1;
  const goalIdx = index(grid, goal);

  let head = 0;
  let found = false;
  while (head < queue.length) {
    const current = queue[head++];
    if (current === goalIdx) {
      found = true;
      break;
    }
    const col = current % grid.cols;
    const row = (current - col) / grid.cols;
    for (const d of NEIGHBORS) {
      const nc = col + d.col;
      const nr = row + d.row;
      if (nc < 0 || nc >= grid.cols || nr < 0 || nr >= grid.rows) continue;
      const ni = nr * grid.cols + nc;
      if (visited[ni]) continue;
      if (!grid.cells[ni]) continue;
      visited[ni] = 1;
      parent[ni] = current;
      queue.push(ni);
    }
  }

  if (!found) return [];

  const path: TileCoord[] = [];
  let cursor = goalIdx;
  while (cursor !== -1 && cursor !== index(grid, start)) {
    const col = cursor % grid.cols;
    const row = (cursor - col) / grid.cols;
    path.push({ col, row });
    cursor = parent[cursor];
  }
  path.reverse();
  return path;
}

/**
 * 等距投影：瓦片（可含小数，用于行走插值）→ 屏幕像素。
 * 原点为网格 (0,0) 瓦片的菱形中心；渲染层用 CSS translate 统一居中。
 */
export function tileToPixel(col: number, row: number, map: LibraryMap = LIBRARY_MAP): { x: number; y: number } {
  return {
    x: ((col - row) * map.tileWidth) / 2,
    y: ((col + row) * map.tileHeight) / 2,
  };
}

/** 瓦片坐标版本（取菱形中心） */
export function tileCenter(tile: TileCoord, map: LibraryMap = LIBRARY_MAP): { x: number; y: number } {
  return tileToPixel(tile.col, tile.row, map);
}

/** 瓦片渲染深度（等距画家算法：col+row 越大越靠前） */
export function tileDepth(tile: TileCoord): number {
  return tile.col + tile.row;
}
