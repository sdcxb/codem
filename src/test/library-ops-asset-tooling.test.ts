/**
 * LO-ASSET-TOOLING —— 美术资源接入工具链的纯函数
 *
 * 覆盖 `scripts/lib/library-ops-asset-utils.mjs`：
 * 颜色解析 / 色键去背景 / 精灵表切格 / 帧对齐 / 掩码判定 / 连通性分析 / 掩码栅格化。
 * 这些函数决定了「绘图模型产出的素材能否被正确切分与接入」，因此纳入门禁。
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error 开发脚本为 .mjs，无类型声明
import {
  alphaBBox,
  analyzeMaskGrid,
  colorDistance,
  fitToFrame,
  isWalkablePixel,
  keyOutBackground,
  parseColor,
  rasterizeWalkable,
  sliceGrid,
} from "../../scripts/lib/library-ops-asset-utils.mjs";

describe("LO-ASSET-TOOLING 颜色与色键", () => {
  it("LO-ASSET-1: parseColor 支持 #rgb / #rrggbb / rgb() / 具名色", () => {
    expect(parseColor("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
    expect(parseColor("#ff00ff")).toEqual({ r: 255, g: 0, b: 255 });
    expect(parseColor("rgb(12, 34, 56)")).toEqual({ r: 12, g: 34, b: 56 });
    expect(parseColor("magenta")).toEqual({ r: 255, g: 0, b: 255 });
    expect(parseColor(" white ")).toEqual({ r: 255, g: 255, b: 255 });
    expect(() => parseColor("not-a-color")).toThrow();
  });

  it("LO-ASSET-2: colorDistance 对称且在 0–441 内", () => {
    const a = { r: 10, g: 20, b: 30 };
    const b = { r: 200, g: 100, b: 50 };
    expect(colorDistance(a, b)).toBeCloseTo(colorDistance(b, a), 6);
    expect(colorDistance(a, a)).toBe(0);
    expect(colorDistance({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeLessThanOrEqual(441.7);
  });

  it("LO-ASSET-3: keyOutBackground 只把接近背景色的像素置透明，容差可调", () => {
    // 2 像素：纯品红背景 + 深棕角色
    const rgba = Buffer.from([255, 0, 255, 255, 90, 60, 40, 255]);
    const keyed = keyOutBackground(rgba, { r: 255, g: 0, b: 255 }, 40, 4);
    expect(keyed[3]).toBe(0); // 背景透明
    expect(keyed[7]).toBe(255); // 角色保留
    // 容差 0 时，略偏的背景色不会被去掉
    const near = Buffer.from([250, 6, 250, 255]);
    expect(keyOutBackground(near, { r: 255, g: 0, b: 255 }, 0, 4)[3]).toBe(255);
    expect(keyOutBackground(near, { r: 255, g: 0, b: 255 }, 40, 4)[3]).toBe(0);
  });
});

describe("LO-ASSET-TOOLING 精灵表切格", () => {
  it("LO-ASSET-4: sliceGrid 行主序、数量正确、覆盖整图", () => {
    const cells = sliceGrid(768, 768, 6, 6);
    expect(cells.length).toBe(36);
    expect(cells[0]).toMatchObject({ left: 0, top: 0, width: 128, height: 128, index: 0, col: 0, row: 0 });
    expect(cells[7]).toMatchObject({ left: 128, top: 128, index: 7, col: 1, row: 1 });
    expect(cells[35]).toMatchObject({ left: 640, top: 640, index: 35, col: 5, row: 5 });
    // 覆盖整图
    const last = cells[cells.length - 1];
    expect(last.left + last.width).toBe(768);
    expect(last.top + last.height).toBe(768);
  });

  it("LO-ASSET-5: sliceGrid 非法参数抛错（列行必须正整数、切格不能为 0）", () => {
    expect(() => sliceGrid(768, 768, 0, 6)).toThrow();
    expect(() => sliceGrid(768, 768, 6, 0)).toThrow();
    expect(() => sliceGrid(10, 10, 20, 20)).toThrow();
    expect(() => sliceGrid(768, 768, 6.5, 6)).toThrow();
  });
});

describe("LO-ASSET-TOOLING 帧对齐", () => {
  it("LO-ASSET-6: alphaBBox 精确找出内容包围盒（不依赖 sharp trim）", () => {
    // 4×3 图：只在 (1,1)-(2,2) 有不透明像素
    const w = 4;
    const h = 3;
    const buf = Buffer.alloc(w * h * 4, 0);
    const set = (x, y, a) => {
      buf[(y * w + x) * 4 + 3] = a;
    };
    set(1, 1, 255);
    set(2, 1, 255);
    set(1, 2, 255);
    set(2, 2, 255);
    const bbox = alphaBBox(buf, w, h, 4, 8);
    expect(bbox).toMatchObject({ left: 1, top: 1, width: 2, height: 2, empty: false });

    // 半透明噪声低于阈值应被忽略
    const noisy = Buffer.from(buf);
    noisy[(0 * w + 0) * 4 + 3] = 4;
    expect(alphaBBox(noisy, w, h, 4, 8)).toMatchObject({ left: 1, top: 1, width: 2, height: 2 });

    // 全透明 → empty
    const empty = alphaBBox(Buffer.alloc(w * h * 4, 0), w, h, 4, 8);
    expect(empty.empty).toBe(true);
    expect(empty.width).toBe(0);
  });

  it("LO-ASSET-7: fitToFrame 水平居中 + 脚底对齐基线，且不越界", () => {
    const fit = fitToFrame({ width: 60, height: 90 }, { width: 128, height: 128 }, { baselineRatio: 0.94 });
    expect(fit.left + fit.width / 2).toBeCloseTo(64, 0);
    expect(fit.top + fit.height).toBeCloseTo(Math.round(128 * 0.94), 0);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.top).toBeGreaterThanOrEqual(0);
    expect(fit.left + fit.width).toBeLessThanOrEqual(128);
    expect(fit.top + fit.height).toBeLessThanOrEqual(128);
  });

  it("LO-ASSET-8: 超大内容等比缩放进帧内", () => {
    const fit = fitToFrame({ width: 400, height: 200 }, { width: 128, height: 128 });
    expect(fit.scale).toBeLessThan(1);
    expect(fit.width).toBeLessThanOrEqual(128);
    expect(fit.height).toBeLessThanOrEqual(128);
  });

  it("LO-ASSET-9: 不同高度的帧脚底对齐（消除动画抖动）", () => {
    const frame = { width: 128, height: 128 };
    const a = fitToFrame({ width: 50, height: 80 }, frame);
    const b = fitToFrame({ width: 50, height: 95 }, frame);
    expect(a.top + a.height).toBe(b.top + b.height);
    expect(a.left).toBe(b.left);
  });
});

describe("LO-ASSET-TOOLING 掩码", () => {
  it("LO-ASSET-10: isWalkablePixel 与上游口径一致（偏红可走）", () => {
    expect(isWalkablePixel(238, 17, 17)).toBe(true);
    expect(isWalkablePixel(255, 102, 102)).toBe(true);
    expect(isWalkablePixel(255, 255, 255)).toBe(false); // 白 = 障碍
    expect(isWalkablePixel(128, 128, 128)).toBe(false);
    expect(isWalkablePixel(238, 17, 17, 0)).toBe(false); // 透明 = 障碍
  });

  it("LO-ASSET-11: analyzeMaskGrid 统计可走比例与连通块", () => {
    // 3×3：中间一行可走（连通）
    const grid = [
      false, false, false,
      true, true, true,
      false, false, false,
    ];
    const s = analyzeMaskGrid(grid, 3, 3);
    expect(s.walkable).toBe(3);
    expect(s.walkableRatio).toBeCloseTo(1 / 3, 6);
    expect(s.components).toBe(1);
    expect(s.connected).toBe(true);

    // 隔断：两块不连通
    const split = [
      true, false, true,
      true, false, true,
      true, false, true,
    ];
    const s2 = analyzeMaskGrid(split, 3, 3);
    expect(s2.components).toBe(2);
    expect(s2.connected).toBe(false);
    expect(s2.largestComponentRatio).toBeCloseTo(3 / 6, 6);

    // 全空
    expect(analyzeMaskGrid(new Array(9).fill(false), 3, 3).walkableRatio).toBe(0);
  });

  it("LO-ASSET-12: rasterizeWalkable 能把房间矩形与路网栅格化成连通掩码", () => {
    const cols = 40;
    const rows = 24;
    const scaleX = 1920 / cols;
    const scaleY = 1072 / rows;
    const grid = rasterizeWalkable(
      cols,
      rows,
      scaleX,
      scaleY,
      [[0, 0, 200, 150], [400, 0, 200, 150]],
      [[100, 75, 500, 75]],
      2,
    );
    const stats = analyzeMaskGrid(grid, cols, rows);
    expect(stats.walkable).toBeGreaterThan(0);
    expect(stats.connected, "两个房间应被走廊连通").toBe(true);
    // 走廊位置可走
    const c = Math.floor(250 / scaleX);
    const r = Math.floor(75 / scaleY);
    expect(grid[r * cols + c]).toBe(true);
  });
});
