/**
 * LO-MAP / LO-PATH — 图书馆地图与寻路
 *
 * 覆盖：区域定义完整性、等距投影、瓦片↔屏幕互逆、可通行网格、
 * BFS 最短路径、工位槽位稳定性、岗位关键词路由。
 */
import { describe, it, expect } from "vitest";
import {
  LIBRARY_MAP,
  LIBRARY_ZONES,
  GRID_COLS,
  GRID_ROWS,
  TILE_WIDTH,
  TILE_HEIGHT,
  DEFAULT_ZONE_ID,
  ENTRANCE,
  getZone,
  isTileInZone,
  mapBounds,
  planPath,
  resolveZoneId,
  screenToTile,
  stationSlot,
  tileToScreen,
  zoneAt,
} from "../plugins/library-ops/data/library-map";
import { buildWalkGrid, findPath, isWalkable, nearestWalkable, tileDepth, tileToPixel } from "../plugins/library-ops/core/pathfinder";
import type { TileCoord } from "../plugins/library-ops/types";

describe("LO-MAP 地图定义", () => {
  it("LO-MAP-1: 10 个岗位、id 唯一、矩形在地图内、容量为正", () => {
    expect(LIBRARY_ZONES.length).toBe(10);
    const ids = new Set(LIBRARY_ZONES.map((z) => z.id));
    expect(ids.size).toBe(10);
    for (const z of LIBRARY_ZONES) {
      expect(z.rect.col).toBeGreaterThanOrEqual(0);
      expect(z.rect.row).toBeGreaterThanOrEqual(0);
      expect(z.rect.col + z.rect.w).toBeLessThanOrEqual(GRID_COLS);
      expect(z.rect.row + z.rect.h).toBeLessThanOrEqual(GRID_ROWS);
      expect(z.capacity).toBeGreaterThan(0);
      expect(z.token.startsWith("--")).toBe(true);
      expect(z.keywords.length).toBeGreaterThan(0);
      expect(isTileInZone(z.station, z)).toBe(true);
    }
  });

  it("LO-MAP-2: 入口在地图内，且每个岗位工位可通过 isTileInZone 反查", () => {
    expect(ENTRANCE.col).toBeGreaterThanOrEqual(0);
    expect(ENTRANCE.col).toBeLessThan(GRID_COLS);
    expect(ENTRANCE.row).toBeGreaterThanOrEqual(0);
    expect(ENTRANCE.row).toBeLessThan(GRID_ROWS);
    for (const z of LIBRARY_ZONES) {
      expect(zoneAt(z.station)?.id).toBe(z.id);
      expect(getZone(z.id)?.name).toBe(z.name);
    }
  });

  it("LO-MAP-3: 等距投影与逆投影一致（取整误差 <= 1 瓦片）", () => {
    const samples: TileCoord[] = [
      { col: 0, row: 0 },
      { col: 5, row: 3 },
      { col: 12, row: 9 },
      { col: 23, row: 17 },
    ];
    for (const t of samples) {
      const p = tileToScreen(t);
      const back = screenToTile(p);
      expect(Math.abs(back.col - t.col)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.row - t.row)).toBeLessThanOrEqual(1);
    }
  });

  it("LO-MAP-4: 投影使用标准等距公式（x=(c-r)*W/2, y=(c+r)*H/2）", () => {
    const p = tileToScreen({ col: 3, row: 1 });
    expect(p.x).toBe(((3 - 1) * TILE_WIDTH) / 2);
    expect(p.y).toBe(((3 + 1) * TILE_HEIGHT) / 2);
    expect(tileToPixel(3, 1)).toEqual(p);
    expect(tileDepth({ col: 3, row: 1 })).toBe(4);
  });

  it("LO-MAP-5: mapBounds 覆盖全图（宽高为正且大于网格跨度）", () => {
    const b = mapBounds();
    expect(b.width).toBeGreaterThan(GRID_COLS * (TILE_WIDTH / 2));
    expect(b.height).toBeGreaterThan(GRID_ROWS * (TILE_HEIGHT / 2));
    expect(b.minX).toBeLessThan(b.maxX);
    expect(b.minY).toBeLessThan(b.maxY);
  });

  it("LO-MAP-6: stationSlot 稳定且不越界（同一 index 永远同一格）", () => {
    for (const z of LIBRARY_ZONES) {
      for (let i = 0; i < 8; i++) {
        const a = stationSlot(z, i);
        const b = stationSlot(z, i);
        expect(a).toEqual(b);
        expect(a.col).toBeGreaterThanOrEqual(0);
        expect(a.col).toBeLessThan(GRID_COLS);
        expect(a.row).toBeGreaterThanOrEqual(0);
        expect(a.row).toBeLessThan(GRID_ROWS);
      }
      // index 0 必须就是工位本身
      expect(stationSlot(z, 0)).toEqual(z.station);
    }
  });

  it("LO-MAP-7: 岗位关键词路由命中正确岗位，未知标签回退默认岗位", () => {
    expect(resolveZoneId("队长 · 研究组")).toBe("front-desk"); // 队长优先（长关键词命中）
    expect(resolveZoneId("成员 · 前端实现")).toBe("code-forge");
    expect(resolveZoneId("子智能体 · explore")).toBe("reading-hall");
    expect(resolveZoneId("成员 · 检索索引")).toBe("catalog-room");
    expect(resolveZoneId("成员 · 文档写作")).toBe("writing-studio");
    expect(resolveZoneId("成员 · 记忆归档")).toBe("archive");
    expect(resolveZoneId("成员 · 运维部署")).toBe("server-room");
    expect(resolveZoneId("")).toBe(DEFAULT_ZONE_ID);
    expect(resolveZoneId("完全未知的岗位")).toBe(DEFAULT_ZONE_ID);
  });

  it("LO-MAP-8: planPath 返回不含起点的 L 形路径，长度等于曼哈顿距离", () => {
    const path = planPath({ col: 1, row: 1 }, { col: 4, row: 3 });
    expect(path.length).toBe(5);
    expect(path[path.length - 1]).toEqual({ col: 4, row: 3 });
    expect(path.some((p) => p.col === 1 && p.row === 1)).toBe(false);
    expect(planPath({ col: 2, row: 2 }, { col: 2, row: 2 })).toEqual([]);
  });
});

describe("LO-PATH 可通行网格与寻路", () => {
  it("LO-PATH-1: 阻挡装饰不可通行，空地为可通行", () => {
    const grid = buildWalkGrid();
    // 书架（1,3）应被阻挡
    expect(isWalkable(grid, { col: 1, row: 3 })).toBe(false);
    // 走道（12,9）可通行
    expect(isWalkable(grid, { col: 12, row: 9 })).toBe(true);
    // 越界不可通行
    expect(isWalkable(grid, { col: -1, row: 0 })).toBe(false);
    expect(isWalkable(grid, { col: GRID_COLS, row: 0 })).toBe(false);
  });

  it("LO-PATH-2: nearestWalkable 在被阻挡时返回邻近可通行格，否则原样返回", () => {
    const grid = buildWalkGrid();
    const blocked = nearestWalkable({ col: 1, row: 3 }, grid);
    expect(isWalkable(grid, blocked)).toBe(true);
    expect(blocked).not.toEqual({ col: 1, row: 3 });
    const free = nearestWalkable({ col: 12, row: 9 }, grid);
    expect(free).toEqual({ col: 12, row: 9 });
  });

  it("LO-PATH-3: BFS 找到入口→每个岗位工位的最短路径，且路径全部可通行", () => {
    const grid = buildWalkGrid();
    for (const zone of LIBRARY_ZONES) {
      const goal = nearestWalkable(zone.station, grid);
      const path = findPath(ENTRANCE, zone.station, grid);
      expect(path.length, `${zone.id} 应可达`).toBeGreaterThan(0);
      expect(path[path.length - 1]).toEqual(goal);
      for (const step of path) {
        expect(isWalkable(grid, step), `${zone.id} 路径经过不可通行格 ${step.col},${step.row}`).toBe(true);
      }
    }
  });

  it("LO-PATH-4: 同格寻路返回空路径；不可达返回空数组", () => {
    const grid = buildWalkGrid();
    expect(findPath({ col: 12, row: 9 }, { col: 12, row: 9 }, grid)).toEqual([]);
    // 构造一个全封闭的 1x1 网格：起点即终点外全部不可达
    const isolated = { cols: 3, rows: 3, cells: [true, false, false, false, false, false, false, false, false] };
    expect(findPath({ col: 0, row: 0 }, { col: 2, row: 2 }, isolated)).toEqual([]);
  });

  it("LO-PATH-5: 路径步数不超过曼哈顿距离 + 少量绕行（BFS 最优性）", () => {
    const grid = buildWalkGrid();
    const from = ENTRANCE;
    const to = getZone("front-desk")!.station;
    const path = findPath(from, to, grid);
    const manhattan = Math.abs(from.col - to.col) + Math.abs(from.row - to.row);
    expect(path.length).toBeGreaterThanOrEqual(manhattan - 2);
    expect(path.length).toBeLessThanOrEqual(manhattan + 6);
  });
});
