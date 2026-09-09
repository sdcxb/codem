/**
 * 美术资源接入工具 —— 纯函数集合（无 IO，可单测）。
 *
 * 供 `build-library-ops-sprites.mjs` / `build-library-ops-scene.mjs` 使用：
 * - 颜色解析与色键去背景
 * - 精灵表切格
 * - 帧内容对齐（统一基线，避免逐帧抖动）
 * - 可行走掩码连通性检查
 */

/** 解析 `#rgb` / `#rrggbb` / `rgb(r,g,b)` / `magenta` 等常见写法 */
export function parseColor(input) {
  const s = String(input ?? "").trim().toLowerCase();
  const named = {
    white: [255, 255, 255],
    black: [0, 0, 0],
    magenta: [255, 0, 255],
    fuchsia: [255, 0, 255],
    green: [0, 255, 0],
    lime: [0, 255, 0],
    cyan: [0, 255, 255],
    blue: [0, 0, 255],
    red: [255, 0, 0],
  };
  if (named[s]) return { r: named[s][0], g: named[s][1], b: named[s][2] };
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
      };
    }
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  throw new Error(`无法解析颜色: ${input}`);
}

/** 颜色距离（0–441） */
export function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * 色键去背景：与 bg 距离 <= tolerance 的像素置为透明。
 * @returns 新的 RGBA Buffer
 */
export function keyOutBackground(rgba, bg, tolerance = 40, channels = 4) {
  const out = Buffer.from(rgba);
  const step = channels;
  for (let i = 0; i < out.length; i += step) {
    const px = { r: out[i], g: out[i + 1], b: out[i + 2] };
    if (colorDistance(px, bg) <= tolerance) {
      out[i + 3] = 0;
    }
  }
  return out;
}

/**
 * 计算 alpha 通道的内容包围盒（不依赖 sharp 的 trim —— 后者在色键透明图上会给出
 * 异常结果，导致帧错位/丢帧）。
 * @param rgba  RGBA Buffer
 * @param width,height,channels 图像元数据
 * @param alphaThreshold 视为「有内容」的 alpha 下限
 * @returns { left, top, width, height, empty }
 */
export function alphaBBox(rgba, width, height, channels = 4, alphaThreshold = 8) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * channels;
    for (let x = 0; x < width; x++) {
      const a = channels === 4 ? rgba[rowOffset + x * channels + 3] : 255;
      if (a <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { left: 0, top: 0, width: 0, height: 0, empty: true };
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false };
}

/**
 * 精灵表切格。列/行必须能整除图像尺寸（否则会留下余数，返回的格子里会包含边缘）。
 * @returns Array<{ left, top, width, height, index, col, row }>
 */
export function sliceGrid(width, height, cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error(`列/行数必须为正整数: ${cols}x${rows}`);
  }
  const fw = Math.floor(width / cols);
  const fh = Math.floor(height / rows);
  if (fw === 0 || fh === 0) throw new Error(`切格后尺寸为 0：${width}x${height} / ${cols}x${rows}`);
  const cells = [];
  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({ left: col * fw, top: row * fh, width: fw, height: fh, index, col, row });
      index++;
    }
  }
  return cells;
}

/**
 * 计算把一块内容（bbox）放到目标帧里的位置：水平居中、脚底对齐基线。
 *
 * 目的：逐帧独立生成/切出来的角色，若直接铺进固定格子里，会因每帧内容高度不同而抖动。
 * 统一按「脚底对齐」摆放后，动画才稳定。
 *
 * @param bbox   内容包围盒 {width, height}
 * @param frame  目标帧 {width, height}
 * @param opts.baselineRatio 脚底基线在帧内的位置（0=顶部，1=底部），默认 0.92
 * @param opts.centerRatio   水平中心位置，默认 0.5
 */
export function fitToFrame(bbox, frame, opts = {}) {
  const baselineRatio = opts.baselineRatio ?? 0.92;
  const centerRatio = opts.centerRatio ?? 0.5;
  const scale = Math.min(1, frame.width / bbox.width, frame.height / bbox.height);
  const w = Math.max(1, Math.round(bbox.width * scale));
  const h = Math.max(1, Math.round(bbox.height * scale));
  const left = Math.round(frame.width * centerRatio - w / 2);
  const top = Math.round(frame.height * baselineRatio - h);
  return {
    left: Math.max(0, Math.min(frame.width - w, left)),
    top: Math.max(0, Math.min(frame.height - h, top)),
    width: w,
    height: h,
    scale,
  };
}

/**
 * 判断像素是否「可通行」（掩码约定：偏红 = 可走，白/灰 = 障碍）。
 * 与上游 ClawLibrary `isWalkableByMask` 的口径一致（r 高、g/b 低）。
 */
export function isWalkablePixel(r, g, b, a = 255) {
  if (a < 40) return false;
  return r > 180 && g < 120 && b < 120;
}

/**
 * 在布尔网格上做 4 邻域连通性检查。
 * @param grid  行主序的 boolean[]
 * @returns { total, walkable, connected, components }
 */
export function analyzeMaskGrid(grid, cols, rows) {
  const total = cols * rows;
  const walkable = grid.filter(Boolean).length;
  const seen = new Uint8Array(total);
  let components = 0;
  let largest = 0;
  const idx = (c, r) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const start = idx(c, r);
      if (!grid[start] || seen[start]) continue;
      components++;
      let size = 0;
      const queue = [start];
      seen[start] = 1;
      while (queue.length) {
        const cur = queue.shift();
        size++;
        const cc = cur % cols;
        const rr = (cur - cc) / cols;
        const neighbours = [
          [cc + 1, rr],
          [cc - 1, rr],
          [cc, rr + 1],
          [cc, rr - 1],
        ];
        for (const [nc, nr] of neighbours) {
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          const ni = idx(nc, nr);
          if (!grid[ni] || seen[ni]) continue;
          seen[ni] = 1;
          queue.push(ni);
        }
      }
      largest = Math.max(largest, size);
    }
  }
  return {
    total,
    walkable,
    walkableRatio: total > 0 ? walkable / total : 0,
    components,
    largestComponentRatio: walkable > 0 ? largest / walkable : 0,
    connected: components <= 1,
  };
}

/** 把一组矩形 + 线段栅格化成可行走掩码网格（供自动生成掩码用） */
export function rasterizeWalkable(cols, rows, scaleX, scaleY, rects, segments, thickness = 2) {
  const grid = new Array(cols * rows).fill(false);
  const setRect = (x, y, w, h) => {
    const c0 = Math.max(0, Math.floor(x / scaleX));
    const c1 = Math.min(cols - 1, Math.ceil((x + w) / scaleX));
    const r0 = Math.max(0, Math.floor(y / scaleY));
    const r1 = Math.min(rows - 1, Math.ceil((y + h) / scaleY));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * cols + c] = true;
  };
  for (const [x, y, w, h] of rects) setRect(x, y, w, h);
  for (const [x1, y1, x2, y2] of segments) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len / Math.min(scaleX, scaleY)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      setRect(px - thickness * scaleX, py - thickness * scaleY, thickness * scaleX * 2, thickness * scaleY * 2);
    }
  }
  return grid;
}
