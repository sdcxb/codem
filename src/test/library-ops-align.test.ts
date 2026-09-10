/**
 * LO-ALIGN — 场景自动对位（纯像素统计，不用模型）
 *
 * 覆盖：
 * - LO-ALIGN-1 RGBA → 灰度网格（box 采样，抗锯齿）
 * - LO-ALIGN-2 地面掩码：亮且平滑的算地面，暗/高对比边缘不算
 * - LO-ALIGN-3 房间掩码：与内置房间矩形位置一致
 * - LO-ALIGN-4 搜索：能从「已知的缩放 + 平移」把图拟合回去（容差内）
 * - LO-ALIGN-5 端到端：偏移/缩放后的合成图 → adjust 落在正确区间；完全不匹配时置信度低
 * - LO-ALIGN-6 输出经过 clampSceneAdjust 收敛（不会越界）
 * - LO-ALIGN-7 解码：无 canvas/ImageBitmap 时明确报错（调用方降级手工对位）
 */
import { describe, it, expect, vi } from "vitest";
import {
  ALIGN_GRID_H,
  ALIGN_GRID_W,
  ALIGN_MIN_SCORE,
  autoAlignFromLuma,
  decodeImageToLuma,
  floorMask,
  maskIoUAt,
  maskCoverage,
  rgbaToLuma,
  roomsMask,
  searchAlignment,
  type LumaImage,
} from "../plugins/library-ops/core/scene-align";
import { CLAW_SCENE, PIXEL_ROOMS } from "../plugins/library-ops/data/pixel-art";

const CANVAS_W = CLAW_SCENE.displayWidth;
const CANVAS_H = CLAW_SCENE.displayHeight;

/**
 * 造一张「被平移/缩放过的房间图」：把它按 (shiftX, shiftY, scale) 显示在画布上时
 * 正好与内置房间重合（与 iouAt 的 CSS 变换约定一致，origin 居中）。
 */
function syntheticLuma(shiftX = 0, shiftY = 0, scale = 1, w = ALIGN_GRID_W, h = ALIGN_GRID_H): LumaImage {
  const rooms = roomsMask(PIXEL_ROOMS, CANVAS_W, CANVAS_H, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const data = new Uint8Array(w * h).fill(40);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 源图点 (x,y) 显示到画布点：p = C + (q - C) * scale + t
      const px = Math.round(cx + (x - cx) * scale + shiftX);
      const py = Math.round(cy + (y - cy) * scale + shiftY);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      if (rooms[py * w + px]) data[y * w + x] = 210;
    }
  }
  return { width: w, height: h, data };
}

describe("LO-ALIGN 场景自动对位", () => {
  it("LO-ALIGN-1: RGBA → 灰度网格", () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, // 红 → 76
      0, 255, 0, 255, // 绿 → 149
      0, 0, 255, 255, // 蓝 → 29
      255, 255, 255, 255, // 白 → 255
    ]);
    const luma = rgbaToLuma(rgba, 2, 2, 2, 2);
    expect(luma.width).toBe(2);
    expect(luma.height).toBe(2);
    expect(luma.data[0]).toBe(76);
    expect(luma.data[1]).toBe(150);
    expect(luma.data[2]).toBe(29);
    expect(luma.data[3]).toBe(255);
  });

  it("LO-ALIGN-2: 地面掩码只保留亮且平滑的区域", () => {
    const w = 12;
    const h = 12;
    const data = new Uint8Array(w * h).fill(60); // 暗底
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) data[y * w + x] = 200; // 亮块 8×8
    data[6 * w + 6] = 10; // 亮块里插一根高对比线
    const mask = floorMask({ width: w, height: h, data });
    expect(mask[3 * w + 4]).toBe(1); // 亮且平滑（邻域全在亮块内）
    expect(mask[0]).toBe(0); // 暗
    expect(mask[2 * w + 2]).toBe(0); // 亮块边界：邻域含暗像素 → 排除
    expect(mask[6 * w + 6]).toBe(0); // 高对比线
  });

  it("LO-ALIGN-3: 房间掩码覆盖 12 个房间且位置一致", () => {
    const mask = roomsMask(PIXEL_ROOMS, CANVAS_W, CANVAS_H, ALIGN_GRID_W, ALIGN_GRID_H);
    const coverage = maskCoverage(mask);
    expect(coverage).toBeGreaterThan(0.2);
    expect(coverage).toBeLessThan(0.95);
    // 每个房间中心都应落在掩码内
    for (const room of PIXEL_ROOMS) {
      const [bx, by, bw, bh] = room.bounds;
      const cx = Math.round(((bx + bw / 2) / CANVAS_W) * ALIGN_GRID_W);
      const cy = Math.round(((by + bh / 2) / CANVAS_H) * ALIGN_GRID_H);
      expect(mask[cy * ALIGN_GRID_W + cx], `${room.id} 中心应在掩码内`).toBe(1);
    }
  });

  it("LO-ALIGN-4: 搜索能把已知的缩放/平移拟合回来", () => {
    const base = roomsMask(PIXEL_ROOMS, CANVAS_W, CANVAS_H);
    // 已知变换：图放大 1.06 倍，向右下各偏 2 格
    const moved = syntheticLuma(2, -2, 1.06);
    // 先验证「真实变换」下的重叠度确实很高（排除构造错误）
    // 真实流程是先把图变成「地面掩码」再打分（autoAlignFromLuma 内部就这么做）
    const movedMask = floorMask(moved);
    const atTrue = maskIoUAt(movedMask, base, ALIGN_GRID_W, ALIGN_GRID_H, 1.06, 2, -2);
    expect(atTrue, "构造的合成图在真实变换下应高度重合").toBeGreaterThan(0.55);
    const best = searchAlignment(movedMask, base);
    console.log("DBG best", JSON.stringify(best));
    expect(best.score).toBeGreaterThan(0.5);
    expect(best.score).toBeGreaterThanOrEqual(atTrue - 0.02); // 搜到的就是峰附近
    expect(Math.abs(best.scale - 1.06)).toBeLessThan(0.05);
    expect(Math.abs(best.dx - 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(best.dy + 2)).toBeLessThanOrEqual(2);
  });

  it("LO-ALIGN-5: 端到端输出可用的 adjust；完全不匹配时置信度低", () => {
    const aligned = autoAlignFromLuma(syntheticLuma(0, 0, 1), PIXEL_ROOMS, CANVAS_W, CANVAS_H);
    expect(aligned.score).toBeGreaterThan(ALIGN_MIN_SCORE);
    expect(aligned.scale).toBeCloseTo(1, 1);
    expect(Math.abs(aligned.x)).toBeLessThan(CANVAS_W * 0.12);
    expect(Math.abs(aligned.y)).toBeLessThan(CANVAS_H * 0.12);

    // 噪声图（没有房间结构）→ 置信度低，不会被自动应用
    const noise = new Uint8Array(ALIGN_GRID_W * ALIGN_GRID_H);
    for (let i = 0; i < noise.length; i++) noise[i] = i % 3 === 0 ? 220 : 40;
    const poor = autoAlignFromLuma({ width: ALIGN_GRID_W, height: ALIGN_GRID_H, data: noise }, PIXEL_ROOMS, CANVAS_W, CANVAS_H);
    expect(poor.score).toBeLessThan(ALIGN_MIN_SCORE);
  });

  it("LO-ALIGN-6: 输出始终落在 clampSceneAdjust 允许区间", () => {
    const wild = autoAlignFromLuma(syntheticLuma(40, 30, 1.13), PIXEL_ROOMS, CANVAS_W, CANVAS_H);
    expect(wild.scale).toBeGreaterThanOrEqual(0.5);
    expect(wild.scale).toBeLessThanOrEqual(2);
    expect(Math.abs(wild.x)).toBeLessThanOrEqual(600);
    expect(Math.abs(wild.y)).toBeLessThanOrEqual(600);
  });

  it("LO-ALIGN-7: 缺少 canvas/ImageBitmap 时明确报错", async () => {
    await expect(
      decodeImageToLuma(new Blob([new Uint8Array([1])]), 8, 8, { createImageBitmap: null, createCanvas: null }),
    ).rejects.toThrow(/无法解析图片像素/);

    // 有依赖时走通（用假 bitmap + 假 canvas）
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(4 * 4 * 4).fill(200) }),
    };
    const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
    const luma = await decodeImageToLuma(new Blob([new Uint8Array([1])]), 4, 4, {
      createImageBitmap: async () => ({ width: 100, height: 100, close: () => undefined }),
      createCanvas: () => fakeCanvas as unknown as HTMLCanvasElement,
    });
    expect(luma.width).toBe(4);
    expect(luma.data[0]).toBe(200);
    expect(fakeCtx.drawImage).toHaveBeenCalled();
  });
});
