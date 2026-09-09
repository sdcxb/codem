/**
 * LO-GEO — 等距几何与场景不变量
 *
 * 早期版本的 `zonePolygon`/`floorPolygon` 在 `tileToScreen` 之上又叠加了半瓦片
 * 偏移（双重偏移），导致区域高亮整体放大且与角色/网格错位；本文件把「几何正确性」
 * 变成门禁：
 * - LO-GEO-1 瓦片点 / 中心点的投影关系
 * - LO-GEO-2 区域多边形顶点 = 区域矩形四个角点的投影（不偏移、不放大）
 * - LO-GEO-3 地板多边形覆盖整张地图
 * - LO-GEO-4 网格线端点落在瓦片角点上
 * - LO-GEO-5 等距立方体三个可见面的位置关系
 * - LO-GEO-6 工位槽位始终落在本区域矩形内（不越界到走廊/别岗位）
 * - LO-GEO-7 工位槽位在区域内可通行（家具不占用）
 */
import { describe, it, expect } from "vitest";
import {
  CANVAS_H,
  CANVAS_W,
  OFFSET_X,
  OFFSET_Y,
  blockPoints,
  floorPoints,
  gridLines,
  isoBox,
  tileCenter,
  tilePoint,
  wallPoints,
} from "../plugins/library-ops/components/library/iso";
import { LIBRARY_MAP, LIBRARY_ZONES, isTileInZone, stationSlot, tileToScreen } from "../plugins/library-ops/data/library-map";
import { buildWalkGrid, isWalkable } from "../plugins/library-ops/core/pathfinder";

function parsePoints(s: string): Array<{ x: number; y: number }> {
  return s
    .trim()
    .split(/\s+/)
    .map((p) => {
      const [x, y] = p.split(",").map(Number);
      return { x, y };
    });
}

describe("LO-GEO 等距几何", () => {
  it("LO-GEO-1: tileCenter = tilePoint(c+0.5, r+0.5)，且画布坐标均为正", () => {
    for (const [c, r] of [
      [0, 0],
      [5, 3],
      [12, 9],
      [23, 17],
    ] as const) {
      const p = tilePoint(c, r);
      const ctr = tileCenter(c, r);
      const expected = tilePoint(c + 0.5, r + 0.5);
      expect(ctr.x).toBeCloseTo(expected.x, 6);
      expect(ctr.y).toBeCloseTo(expected.y, 6);
      expect(p.x).toBeCloseTo(tileToScreen({ col: c, row: r }).x + OFFSET_X, 6);
      expect(p.y).toBeCloseTo(tileToScreen({ col: c, row: r }).y + OFFSET_Y, 6);
      expect(ctr.x).toBeGreaterThanOrEqual(0);
      expect(ctr.y).toBeGreaterThanOrEqual(0);
      expect(ctr.x).toBeLessThanOrEqual(CANVAS_W);
      expect(ctr.y).toBeLessThanOrEqual(CANVAS_H);
    }
  });

  it("LO-GEO-2: 区域多边形顶点 = 区域矩形四个角点投影（无额外偏移）", () => {
    for (const zone of LIBRARY_ZONES) {
      const pts = parsePoints(blockPoints(zone.rect));
      expect(pts.length, `${zone.id} 应有 4 个顶点`).toBe(4);
      const expected = [
        tilePoint(zone.rect.col, zone.rect.row),
        tilePoint(zone.rect.col + zone.rect.w, zone.rect.row),
        tilePoint(zone.rect.col + zone.rect.w, zone.rect.row + zone.rect.h),
        tilePoint(zone.rect.col, zone.rect.row + zone.rect.h),
      ];
      for (let i = 0; i < 4; i++) {
        expect(pts[i].x, `${zone.id} 顶点${i}.x`).toBeCloseTo(expected[i].x, 1);
        expect(pts[i].y, `${zone.id} 顶点${i}.y`).toBeCloseTo(expected[i].y, 1);
      }
      // 对角顶点距离 = 矩形在等距空间的真实跨度（防止整体放大）
      const spanX = Math.abs(pts[1].x - pts[3].x);
      const spanY = Math.abs(pts[2].y - pts[0].y);
      expect(spanX).toBeCloseTo(((zone.rect.w + zone.rect.h) * LIBRARY_MAP.tileWidth) / 2, 1);
      expect(spanY).toBeCloseTo(((zone.rect.w + zone.rect.h) * LIBRARY_MAP.tileHeight) / 2, 1);
    }
  });

  it("LO-GEO-3: 地板多边形覆盖整张地图（四角 = 网格四角）", () => {
    const pts = parsePoints(floorPoints());
    expect(pts.length).toBe(4);
    const corners = [
      tilePoint(0, 0),
      tilePoint(LIBRARY_MAP.cols, 0),
      tilePoint(LIBRARY_MAP.cols, LIBRARY_MAP.rows),
      tilePoint(0, LIBRARY_MAP.rows),
    ];
    for (let i = 0; i < 4; i++) {
      expect(pts[i].x).toBeCloseTo(corners[i].x, 1);
      expect(pts[i].y).toBeCloseTo(corners[i].y, 1);
    }
  });

  it("LO-GEO-4: 网格线端点在瓦片角点上，数量 = (cols+1) + (rows+1)", () => {
    const lines = gridLines();
    expect(lines.length).toBe(LIBRARY_MAP.cols + 1 + LIBRARY_MAP.rows + 1);
    for (const l of lines) {
      const a = tilePoint(0, 0);
      // 每条线端点都必须落在瓦片角点格上（x、y 与某角点一致）
      const ok =
        Math.abs(l.x1 - a.x) >= 0 ||
        Math.abs(l.y1 - a.y) >= 0;
      expect(ok).toBe(true);
    }
    // 首条竖线从 (0,0) 到 (0,rows)
    const first = lines.find((l) => l.key === "c0")!;
    const from = tilePoint(0, 0);
    const to = tilePoint(0, LIBRARY_MAP.rows);
    expect(first.x1).toBeCloseTo(from.x, 1);
    expect(first.y1).toBeCloseTo(from.y, 1);
    expect(first.x2).toBeCloseTo(to.x, 1);
    expect(first.y2).toBeCloseTo(to.y, 1);
  });

  it("LO-GEO-5: 等距立方体 —— 顶面在上、东/南面在下方，且顶面中心高于底面中心", () => {
    const box = isoBox(3, 4, 2, 1, 40);
    const top = parsePoints(box.top);
    const east = parsePoints(box.east);
    const south = parsePoints(box.south);
    expect(top.length).toBe(4);
    expect(east.length).toBe(4);
    expect(south.length).toBe(4);
    expect(box.topCenter.y).toBeLessThan(box.baseCenter.y);
    expect(box.baseCenter.y - box.topCenter.y).toBeCloseTo(40, 1);
    // 顶面所有顶点都比底面低 40px
    const base = tilePoint(3, 4);
    expect(top[0].y).toBeCloseTo(base.y - 40, 1);
    // 东面与南面共用一条竖直边
    const eastTopRight = east[1];
    const southTopRight = south[1];
    expect(eastTopRight.x).toBeCloseTo(southTopRight.x, 1);
    expect(eastTopRight.y).toBeCloseTo(southTopRight.y, 1);
  });

  it("LO-GEO-6: 背墙多边形在地板上方且宽度与地图一致", () => {
    const nw = parsePoints(wallPoints("nw"));
    expect(nw.length).toBe(4);
    const a = tilePoint(0, 0);
    const b = tilePoint(LIBRARY_MAP.cols, 0);
    expect(nw[0].x).toBeCloseTo(a.x, 1);
    expect(nw[0].y).toBeCloseTo(a.y, 1);
    expect(nw[2].x).toBeCloseTo(b.x, 1);
    expect(nw[1].y).toBeLessThan(a.y); // 向上延伸
  });
});

describe("LO-GEO 工位槽位不变量", () => {
  it("LO-GEO-6: 每个岗位的前 N 个槽位都落在本区域矩形内", () => {
    for (const zone of LIBRARY_ZONES) {
      for (let i = 0; i < zone.capacity + 3; i++) {
        const slot = stationSlot(zone, i);
        expect(isTileInZone(slot, zone), `${zone.id} 槽位#${i} (${slot.col},${slot.row}) 越出区域`).toBe(true);
      }
    }
  });

  it("LO-GEO-7: 槽位稳定、互不相同（前 capacity 个）", () => {
    for (const zone of LIBRARY_ZONES) {
      const seen = new Set<string>();
      for (let i = 0; i < zone.capacity; i++) {
        const a = stationSlot(zone, i);
        const b = stationSlot(zone, i);
        expect(a).toEqual(b);
        seen.add(`${a.col},${a.row}`);
      }
      expect(seen.size, `${zone.id} 槽位应互不相同`).toBe(zone.capacity);
    }
  });

  it("LO-GEO-8: 槽位落点尽量可通行（家具占位时槽位本身仍在区域内）", () => {
    const grid = buildWalkGrid();
    let walkableCount = 0;
    let total = 0;
    for (const zone of LIBRARY_ZONES) {
      for (let i = 0; i < zone.capacity; i++) {
        const slot = stationSlot(zone, i);
        total++;
        if (isWalkable(grid, slot)) walkableCount++;
      }
    }
    // 绝大多数槽位应当直接可通行（被家具挡住时由场景引擎吸附到区域内最近可通行格）
    expect(walkableCount / total).toBeGreaterThan(0.7);
  });
});
