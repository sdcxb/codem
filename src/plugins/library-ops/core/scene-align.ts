/**
 * 场景自动对位 —— 让「上传的场景图」自动对齐到内置布局，省掉手工拖拽。
 *
 * 思路（纯像素统计，不依赖模型）：
 * 1. 把上传图缩到小网格（默认 96×54），取亮度；
 * 2. **地面掩码**：地面 = 亮度较高且局部方差低（平滑）的区域；墙线/家具边缘会被排除；
 * 3. **目标掩码**：把内置 12 个房间矩形栅格化到同一网格（房间 = 应有地面的地方）；
 * 4. 在 缩放 × 平移 的粗到细搜索里，找让两个掩码 **IoU 最大** 的变换；
 * 5. 输出 `{ scale, x, y }`（画布显示坐标，直接可写进 `sceneImageAdjust`）与置信度。
 *
 * 设计取舍：
 * - 只做**全局相似变换**（等比缩放 + 平移）：用户生成的图通常整体布局接近、只是
 *   留白/取景不同；逐房间对位仍需人工（对位编辑器）。
 * - 全部是纯函数，图像解码单独放在 `decodeImageToLuma()` 里（可注入，便于单测）。
 */

import type { PixelRoom } from "../data/pixel-art";
import { clampSceneAdjust, type SceneImageAdjust } from "./scene-image";

/** 网格尺寸（越小越快；96×54 对 16:9 足够） */
export const ALIGN_GRID_W = 96;
export const ALIGN_GRID_H = 54;

/** 搜索范围 */
export const ALIGN_SEARCH = {
  /** 缩放范围（相对铺满画布） */
  scaleMin: 0.86,
  scaleMax: 1.14,
  /** 平移范围（画布宽/高的比例） */
  offsetRatio: 0.09,
  /** 粗搜索步数（scale × offset 各多少档） */
  coarseScaleSteps: 7,
  coarseOffsetSteps: 9,
  /** 精搜索在最优解附近的步长 */
  refineScaleStep: 0.01,
  refineOffsetRatio: 0.01,
} as const;

/** 低于这个 IoU 就认为「没对齐」，不自动应用 */
export const ALIGN_MIN_SCORE = 0.42;

export interface AlignResult extends SceneImageAdjust {
  /** 0..1，重叠度（IoU） */
  score: number;
}

/** 灰度图（0..255），行优先 */
export interface LumaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** 把 RGBA 像素缩到网格并转灰度（box 采样，抗锯齿） */
export function rgbaToLuma(
  rgba: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  dstW = ALIGN_GRID_W,
  dstH = ALIGN_GRID_H,
): LumaImage {
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor((y * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor((x * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcW + sx) * 4;
          // 亮度（Rec.601）
          sum += (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
          n++;
        }
      }
      out[y * dstW + x] = n > 0 ? Math.round(sum / n) : 0;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/**
 * 地面掩码：亮度高于整体均值、且局部方差低（平滑，不是线条/家具边缘）。
 * 返回 0/1 掩码。
 */
export function floorMask(luma: LumaImage, opts: { brightRatio?: number; maxVariance?: number } = {}): Uint8Array {
  const { width: w, height: h, data } = luma;
  const brightRatio = opts.brightRatio ?? 0.92;
  const maxVariance = opts.maxVariance ?? 260;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  const threshold = mean * brightRatio;

  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i] < threshold) continue;
      // 3×3 局部方差
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          const v = data[yy * w + xx];
          s += v;
          s2 += v * v;
          n++;
        }
      }
      const variance = s2 / n - (s / n) ** 2;
      if (variance <= maxVariance) mask[i] = 1;
    }
  }
  return mask;
}

/** 把内置房间矩形栅格化成目标掩码（房间 = 应有地面的区域） */
export function roomsMask(
  rooms: PixelRoom[],
  canvasW: number,
  canvasH: number,
  dstW = ALIGN_GRID_W,
  dstH = ALIGN_GRID_H,
  inset = 0.12,
): Uint8Array {
  const mask = new Uint8Array(dstW * dstH);
  for (const room of rooms) {
    const [bx, by, bw, bh] = room.bounds;
    const x0 = Math.round(((bx + bw * inset) / canvasW) * dstW);
    const y0 = Math.round(((by + bh * inset) / canvasH) * dstH);
    const x1 = Math.round(((bx + bw * (1 - inset)) / canvasW) * dstW);
    const y1 = Math.round(((by + bh * (1 - inset)) / canvasH) * dstH);
    for (let y = Math.max(0, y0); y < Math.min(dstH, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(dstW, x1); x++) mask[y * dstW + x] = 1;
    }
  }
  return mask;
}

/** 掩码的覆盖率（0..1） */
export function maskCoverage(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return mask.length > 0 ? n / mask.length : 0;
}

/**
 * 在给定变换下计算 IoU。
 *
 * 变换与 CSS 一致（`transform-origin: 50% 50%`）：
 *   画布点 p 上显示的是源图点 `q = C + (p - t - C) / scale`（C = 网格中心）。
 * 也就是说 `t`（网格格数）就是 CSS 里的 `translate` 偏移。
 */
export function maskIoUAt(
  src: Uint8Array,
  dst: Uint8Array,
  w: number,
  h: number,
  scale: number,
  dx: number,
  dy: number,
): number {
  const cx = w / 2;
  const cy = h / 2;
  let inter = 0;
  let union = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = y * w + x;
      const sx = Math.round(cx + (x - dx - cx) / scale);
      const sy = Math.round(cy + (y - dy - cy) / scale);
      const inSrc = sx >= 0 && sx < w && sy >= 0 && sy < h;
      const s = inSrc ? src[sy * w + sx] : 0;
      const d = dst[di];
      if (s && d) inter++;
      if (s || d) union++;
    }
  }
  return union > 0 ? inter / union : 0;
}

/**
 * 搜索最佳「缩放 + 平移」。
 * @param srcMask 上传图的地面掩码
 * @param dstMask 内置房间掩码
 * @param gridW/gridH 网格尺寸
 */
export function searchAlignment(
  srcMask: Uint8Array,
  dstMask: Uint8Array,
  gridW = ALIGN_GRID_W,
  gridH = ALIGN_GRID_H,
): { scale: number; dx: number; dy: number; score: number } {
  const { scaleMin, scaleMax, offsetRatio, coarseScaleSteps, coarseOffsetSteps } = ALIGN_SEARCH;
  const maxDx = Math.round(gridW * offsetRatio);
  const maxDy = Math.round(gridH * offsetRatio);

  let best = { scale: 1, dx: 0, dy: 0, score: -1 };
  const evalAt = (scale: number, dx: number, dy: number) => {
    const score = maskIoUAt(srcMask, dstMask, gridW, gridH, scale, dx, dy);
    if (score > best.score) best = { scale, dx, dy, score };
  };

  // 粗搜索
  for (let si = 0; si < coarseScaleSteps; si++) {
    const scale = scaleMin + ((scaleMax - scaleMin) * si) / (coarseScaleSteps - 1);
    for (let yi = 0; yi < coarseOffsetSteps; yi++) {
      const dy = Math.round(-maxDy + (2 * maxDy * yi) / (coarseOffsetSteps - 1));
      for (let xi = 0; xi < coarseOffsetSteps; xi++) {
        const dx = Math.round(-maxDx + (2 * maxDx * xi) / (coarseOffsetSteps - 1));
        evalAt(scale, dx, dy);
      }
    }
  }

  // 精搜索（在最优解附近 ±1 步）
  const coarse = { ...best };
  for (let ds = -1; ds <= 1; ds++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (ds === 0 && dy === 0 && dx === 0) continue;
        evalAt(
          coarse.scale + ds * ALIGN_SEARCH.refineScaleStep,
          coarse.dx + dx * Math.max(1, Math.round(gridW * ALIGN_SEARCH.refineOffsetRatio)),
          coarse.dy + dy * Math.max(1, Math.round(gridH * ALIGN_SEARCH.refineOffsetRatio)),
        );
      }
    }
  }
  return best;
}

/**
 * 端到端：从灰度图 + 房间表算出可直接应用的 `sceneImageAdjust`。
 * @param luma 上传图的灰度网格
 * @param rooms 内置房间（逻辑坐标）
 * @param canvasW/canvasH 画布显示尺寸（1920×1072）
 */
export function autoAlignFromLuma(
  luma: LumaImage,
  rooms: PixelRoom[],
  canvasW: number,
  canvasH: number,
): AlignResult {
  const src = floorMask(luma);
  const dst = roomsMask(rooms, canvasW, canvasH, luma.width, luma.height);
  const best = searchAlignment(src, dst, luma.width, luma.height);

  // 网格偏移 → 画布像素偏移（注意变换方向：src = (canvas - offset)/scale）
  const pxPerCellX = canvasW / luma.width;
  const pxPerCellY = canvasH / luma.height;
  const adjust = clampSceneAdjust({
    scale: Number(best.scale.toFixed(3)),
    x: Math.round(best.dx * pxPerCellX),
    y: Math.round(best.dy * pxPerCellY),
  });
  return { ...adjust, score: Number(best.score.toFixed(3)) };
}

/** 图像解码依赖（测试注入） */
export interface AlignIoDeps {
  createImageBitmap?: ((blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>) | null;
  createCanvas?: (() => HTMLCanvasElement) | null;
}

/**
 * 把图片解码成灰度网格。
 * 浏览器里走 `createImageBitmap` + `<canvas>`；不可用时抛错（调用方降级为手工对位）。
 */
export async function decodeImageToLuma(
  blob: Blob,
  dstW = ALIGN_GRID_W,
  dstH = ALIGN_GRID_H,
  deps: AlignIoDeps = {},
): Promise<LumaImage> {
  const createBitmap =
    deps.createImageBitmap !== undefined
      ? deps.createImageBitmap
      : typeof createImageBitmap === "function"
        ? createImageBitmap
        : null;
  const createCanvas =
    deps.createCanvas !== undefined
      ? deps.createCanvas
      : typeof document !== "undefined"
        ? () => document.createElement("canvas")
        : null;
  if (!createBitmap || !createCanvas) throw new Error("当前环境无法解析图片像素（缺少 canvas/ImageBitmap）");

  const bmp = await createBitmap(blob);
  try {
    const canvas = createCanvas();
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 2D 画布上下文");
    ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0, dstW, dstH);
    const img = ctx.getImageData(0, 0, dstW, dstH);
    return rgbaToLuma(img.data, dstW, dstH, dstW, dstH);
  } finally {
    bmp.close?.();
  }
}
