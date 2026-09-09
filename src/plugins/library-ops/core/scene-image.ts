/**
 * 场景图片（自定义 / 内置预设）—— 纯逻辑层。
 *
 * 职责：把「用户丢进来的一张图」变成可信、可渲染、可持久化的场景资源。
 * 这里**不碰 DOM / IndexedDB / store**，全部是纯函数（IO 通过可注入的 deps），
 * 便于在 happy-dom 之外单测。
 *
 * 坐标约定：自定义图片铺满 1920×1072 的显示画布（`object-fit: fill`），
 * 因此角色站位、岗位标签、点击热区与内置场景完全一致。
 */

import { DEFAULT_SCENE_ADJUST, type SceneImageAdjust } from "../types";

export { DEFAULT_SCENE_ADJUST };
export type { SceneImageAdjust };

/** 单张场景图最大字节数（IndexedDB 存 Blob，32MB 足够放下 4K PNG） */
export const SCENE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** 最小尺寸（再小就没法铺满画布了） */
export const SCENE_IMAGE_MIN_WIDTH = 640;
export const SCENE_IMAGE_MIN_HEIGHT = 360;

/** `<input type="file">` 的 accept 属性 */
export const SCENE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp";

/** 允许的 MIME 类型（浏览器偶尔给空 type，此时按扩展名兜底） */
export const SCENE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/bmp",
  "image/x-ms-bmp",
];

const EXT_TYPES = ["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp"];

/** 目标比例（显示画布 1920×1072 ≈ 16:9） */
export const SCENE_TARGET_RATIO = 1920 / 1072;

/** 比例偏差超过这个比例就提醒用户（会被拉伸） */
export const SCENE_ASPECT_TOLERANCE = 0.08;

/** 场景图片元信息（上传后展示） */
export interface SceneImageInfo {
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
}

export const SCENE_ADJUST_LIMITS = {
  scale: { min: 0.5, max: 2, step: 0.01 },
  offset: { min: -600, max: 600, step: 1 },
} as const;

/** 文件级校验（不读内容）：返回错误文案，`null` = 通过 */
export function validateSceneImageFile(file: { name?: string; type?: string; size?: number } | null | undefined): string | null {
  if (!file) return "没有选中文件";
  const name = String(file.name ?? "");
  const type = String(file.type ?? "").toLowerCase();
  const size = Number(file.size ?? 0);

  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const typeOk = type ? SCENE_IMAGE_TYPES.includes(type) : EXT_TYPES.includes(ext);
  if (!typeOk) {
    return `不支持的图片格式「${type || ext || "未知"}」——请用 PNG / JPG / WebP / AVIF。`;
  }
  if (!Number.isFinite(size) || size <= 0) return "这个文件是空的，换一张试试。";
  if (size > SCENE_IMAGE_MAX_BYTES) {
    return `图片太大（${formatBytes(size)}），请压缩到 ${formatBytes(SCENE_IMAGE_MAX_BYTES)} 以内。`;
  }
  return null;
}

/** 尺寸级校验（解码后才知道）：返回错误文案，`null` = 通过 */
export function validateSceneImageDimensions(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "无法识别图片尺寸（文件可能已损坏）。";
  }
  if (width < SCENE_IMAGE_MIN_WIDTH || height < SCENE_IMAGE_MIN_HEIGHT) {
    return `图片太小（${width}×${height}），至少需要 ${SCENE_IMAGE_MIN_WIDTH}×${SCENE_IMAGE_MIN_HEIGHT}。`;
  }
  return null;
}

/** 比例提醒（不阻止上传，只是告诉用户会被拉伸） */
export function sceneImageAspectWarning(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  if (ratio < 1) return "这是一张竖图，横版场景会被强烈拉伸 —— 建议重新生成 16:9 横版。";
  const drift = Math.abs(ratio - SCENE_TARGET_RATIO) / SCENE_TARGET_RATIO;
  if (drift <= SCENE_ASPECT_TOLERANCE) return null;
  return `比例 ${ratio.toFixed(2)}:1 与场景画布 ${SCENE_TARGET_RATIO.toFixed(2)}:1 相差 ${(drift * 100).toFixed(0)}%，画面会被拉伸 —— 建议用 16:9（如 2752×1536）。`;
}

/** 收敛微调参数（防御非法持久化值 / 越界输入） */
export function clampSceneAdjust(input: Partial<SceneImageAdjust> | null | undefined): SceneImageAdjust {
  const scale = Number(input?.scale);
  const x = Number(input?.x);
  const y = Number(input?.y);
  const { scale: s, offset: o } = SCENE_ADJUST_LIMITS;
  return {
    scale: clamp(Number.isFinite(scale) ? scale : DEFAULT_SCENE_ADJUST.scale, s.min, s.max),
    x: clamp(Number.isFinite(x) ? x : 0, o.min, o.max),
    y: clamp(Number.isFinite(y) ? y : 0, o.min, o.max),
  };
}

export function isIdentityAdjust(a: SceneImageAdjust): boolean {
  return a.scale === 1 && a.x === 0 && a.y === 0;
}

/** 图片图层的 CSS transform（画布坐标，origin 居中） */
export function sceneAdjustTransform(a: SceneImageAdjust): string {
  return `translate(${round(a.x)}px, ${round(a.y)}px) scale(${round(a.scale, 3)})`;
}

/** 人类可读字节数 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/** 人类可读尺寸 */
export function formatDimensions(width: number, height: number): string {
  return `${Math.round(width)}×${Math.round(height)}`;
}

/** 单行摘要（成功提示 / 卡片副标题） */
export function describeSceneImage(info: { name: string; width: number; height: number; size: number }): string {
  return `${info.name} · ${formatDimensions(info.width, info.height)} · ${formatBytes(info.size)}`;
}

/** 可注入的 IO 依赖（测试用；缺省走浏览器全局） */
export interface SceneImageIoDeps {
  createImageBitmap?: ((blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>) | null;
  createObjectURL?: ((blob: Blob) => string) | null;
  revokeObjectURL?: ((url: string) => void) | null;
  ImageCtor?: (new () => HTMLImageElement) | null;
}

/**
 * 解码图片拿宽高。优先 `createImageBitmap`（快、不占 DOM），
 * 回退 `<img>` + objectURL（老 WebView）。
 */
export async function readImageDimensions(
  blob: Blob,
  deps: SceneImageIoDeps = {},
): Promise<{ width: number; height: number }> {
  const createBitmap =
    deps.createImageBitmap !== undefined ? deps.createImageBitmap : typeof createImageBitmap === "function" ? createImageBitmap : null;
  if (createBitmap) {
    try {
      const bmp = await createBitmap(blob);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      if (size.width > 0 && size.height > 0) return size;
    } catch {
      /* 落到 <img> 分支 */
    }
  }

  const createUrl = deps.createObjectURL !== undefined ? deps.createObjectURL : globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const revokeUrl = deps.revokeObjectURL !== undefined ? deps.revokeObjectURL : globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
  const ImageCtor = deps.ImageCtor !== undefined ? deps.ImageCtor : typeof Image === "function" ? Image : null;
  if (!createUrl || !ImageCtor) throw new Error("当前环境无法读取图片尺寸");

  const url = createUrl(blob);
  try {
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new ImageCtor();
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(new Error("图片解码失败（文件可能已损坏）"));
      img.src = url;
    });
    if (!size.width || !size.height) throw new Error("无法读取图片尺寸");
    return size;
  } finally {
    revokeUrl?.(url);
  }
}

/** 创建可渲染的 URL（objectURL 优先，回退 dataURL），返回值带 revoke */
export async function createSceneImageUrl(
  blob: Blob,
  deps: SceneImageIoDeps = {},
): Promise<{ url: string; revoke: () => void }> {
  const createUrl = deps.createObjectURL !== undefined ? deps.createObjectURL : globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const revokeUrl = deps.revokeObjectURL !== undefined ? deps.revokeObjectURL : globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
  if (createUrl) {
    const url = createUrl(blob);
    return { url, revoke: () => revokeUrl?.(url) };
  }
  const url = await blobToDataUrl(blob);
  return { url, revoke: () => undefined };
}

/** Blob → dataURL（objectURL 不可用时的兜底，例如无 URL API 的测试环境） */
export function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === "function") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("读取图片数据失败"));
      reader.readAsDataURL(blob);
    });
  }
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buf) => `data:${blob.type || "image/png"};base64,${base64Of(new Uint8Array(buf))}`);
  }
  return Promise.reject(new Error("当前环境无法读取图片数据"));
}

/** 房间矩形 → 缩略图上的百分比矩形（设置面板的对位预览用） */
export function rectToPercent(
  bounds: readonly [number, number, number, number],
  canvasWidth: number,
  canvasHeight: number,
): { left: string; top: string; width: string; height: string } {
  const [x, y, w, h] = bounds;
  const pct = (v: number, total: number) => `${((v / total) * 100).toFixed(3)}%`;
  return { left: pct(x, canvasWidth), top: pct(y, canvasHeight), width: pct(w, canvasWidth), height: pct(h, canvasHeight) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** Uint8Array → base64（不依赖 btoa 的编码细节） */
function base64Of(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : chars[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : chars[b2 & 0x3f];
  }
  return out;
}
