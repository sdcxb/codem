/**
 * LO-SCENE-IMG — 自定义场景图片（纯逻辑 + 资源清单）
 *
 * 覆盖：
 * - LO-SCENE-IMG-1 文件级校验（格式 / 空文件 / 体积上限）
 * - LO-SCENE-IMG-2 尺寸级校验（过小 / 非法）
 * - LO-SCENE-IMG-3 比例提醒（16:9 通过；1:1 / 竖图报警）
 * - LO-SCENE-IMG-4 微调参数收敛（越界 / NaN → 合法区间）
 * - LO-SCENE-IMG-5 格式化与摘要
 * - LO-SCENE-IMG-6 解码尺寸：createImageBitmap 优先、<img> 回退、无能力时报错
 * - LO-SCENE-IMG-7 objectURL 优先、dataURL 回退
 * - LO-SCENE-IMG-8 房间矩形 → 百分比（对位预览）
 * - LO-SCENE-IMG-9 预设清单自洽（id 与类型联合一致、图层文件真实存在、尺寸 2752×1536）
 * - LO-SCENE-IMG-10 设置默认值 / 持久化收敛（非法 sceneImageId 回退）
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  DEFAULT_SCENE_ADJUST,
  SCENE_IMAGE_MAX_BYTES,
  blobToDataUrl,
  clampSceneAdjust,
  createSceneImageUrl,
  describeSceneImage,
  formatBytes,
  formatDimensions,
  isIdentityAdjust,
  readImageDimensions,
  rectToPercent,
  sceneAdjustTransform,
  sceneImageAspectWarning,
  validateSceneImageDimensions,
  validateSceneImageFile,
} from "../plugins/library-ops/core/scene-image";
import { CUSTOM_SCENE_KEY } from "../plugins/library-ops/core/scene-image-db";
import {
  CLAW_SCENE,
  FALLBACK_SCENE_PRESET_ID,
  PIXEL_ROOMS,
  SCENE_PRESETS,
  getScenePreset,
} from "../plugins/library-ops/data/pixel-art";
import { BUILTIN_SCENE_IMAGE_IDS, DEFAULT_SETTINGS, STORAGE_KEY } from "../plugins/library-ops/types";
import { loadSettings } from "../plugins/library-ops/store";

const ROOT = join(__dirname, "..", "..");
const ASSET_DIR = join(ROOT, "public", "library-ops");

function fakeFile(over: Partial<{ name: string; type: string; size: number }> = {}) {
  return { name: "场景.png", type: "image/png", size: 4_600_000, ...over };
}

describe("LO-SCENE-IMG 自定义场景图片（纯逻辑）", () => {
  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  it("LO-SCENE-IMG-1: 文件级校验（格式 / 空文件 / 体积上限）", () => {
    expect(validateSceneImageFile(fakeFile())).toBeNull();
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif", "image/bmp"]) {
      expect(validateSceneImageFile(fakeFile({ type })), type).toBeNull();
    }
    // 浏览器偶尔给空 type → 按扩展名兜底
    expect(validateSceneImageFile(fakeFile({ type: "" }))).toBeNull();
    expect(validateSceneImageFile(fakeFile({ type: "", name: "scene.PNG" }))).toBeNull();
    expect(validateSceneImageFile(fakeFile({ type: "", name: "scene.txt" }))).toContain("不支持的图片格式");
    expect(validateSceneImageFile(fakeFile({ type: "text/plain", name: "a.txt" }))).toContain("不支持的图片格式");
    expect(validateSceneImageFile(fakeFile({ size: 0 }))).toContain("空的");
    expect(validateSceneImageFile(fakeFile({ size: SCENE_IMAGE_MAX_BYTES + 1 }))).toContain("太大");
    expect(validateSceneImageFile(null)).toContain("没有选中文件");
  });

  it("LO-SCENE-IMG-2: 尺寸级校验", () => {
    expect(validateSceneImageDimensions(2752, 1536)).toBeNull();
    expect(validateSceneImageDimensions(640, 360)).toBeNull();
    expect(validateSceneImageDimensions(639, 360)).toContain("太小");
    expect(validateSceneImageDimensions(0, 0)).toContain("无法识别");
    expect(validateSceneImageDimensions(NaN, 100)).toContain("无法识别");
  });

  it("LO-SCENE-IMG-3: 比例提醒", () => {
    expect(sceneImageAspectWarning(1920, 1072)).toBeNull();
    expect(sceneImageAspectWarning(2752, 1536)).toBeNull();
    expect(sceneImageAspectWarning(1920, 1080)).toBeNull();
    const square = sceneImageAspectWarning(1000, 1000);
    expect(square).toContain("拉伸");
    expect(sceneImageAspectWarning(800, 1200)).toContain("竖图");
    expect(sceneImageAspectWarning(0, 0)).toBeNull();
  });

  it("LO-SCENE-IMG-4: 微调参数收敛", () => {
    expect(clampSceneAdjust(undefined)).toEqual(DEFAULT_SCENE_ADJUST);
    expect(clampSceneAdjust({ scale: 99, x: 9999, y: -9999 })).toEqual({ scale: 2, x: 600, y: -600 });
    expect(clampSceneAdjust({ scale: 0.1 })).toEqual({ scale: 0.5, x: 0, y: 0 });
    expect(clampSceneAdjust({ scale: NaN, x: NaN, y: NaN })).toEqual(DEFAULT_SCENE_ADJUST);
    expect(isIdentityAdjust(DEFAULT_SCENE_ADJUST)).toBe(true);
    expect(isIdentityAdjust({ scale: 1, x: 1, y: 0 })).toBe(false);
    expect(sceneAdjustTransform({ scale: 1.5, x: 12.345, y: -8 })).toBe("translate(12.35px, -8px) scale(1.5)");
  });

  it("LO-SCENE-IMG-5: 格式化与摘要", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00MB");
    expect(formatDimensions(2752, 1536)).toBe("2752×1536");
    expect(describeSceneImage({ name: "场景.png", width: 2752, height: 1536, size: 2048 })).toBe("场景.png · 2752×1536 · 2.0KB");
  });

  it("LO-SCENE-IMG-6: 解码尺寸 —— createImageBitmap 优先、<img> 回退、无能力时报错", async () => {
    const bitmap = await readImageDimensions({} as Blob, {
      createImageBitmap: async () => ({ width: 2752, height: 1536, close: () => undefined }),
    });
    expect(bitmap).toEqual({ width: 2752, height: 1536 });

    // createImageBitmap 抛错 → 回退 <img>
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 450;
      width = 800;
      height = 450;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const viaImg = await readImageDimensions({} as Blob, {
      createImageBitmap: async () => {
        throw new Error("no bitmap");
      },
      createObjectURL: () => "blob:fake",
      revokeObjectURL: () => undefined,
      ImageCtor: FakeImage as unknown as new () => HTMLImageElement,
    });
    expect(viaImg).toEqual({ width: 800, height: 450 });

    await expect(readImageDimensions({} as Blob, { createImageBitmap: null, createObjectURL: null, ImageCtor: null })).rejects.toThrow(
      /无法读取图片尺寸/,
    );
  });

  it("LO-SCENE-IMG-7: objectURL 优先，缺 URL API 时回退 dataURL", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    let revoked = "";
    const a = await createSceneImageUrl(blob, {
      createObjectURL: () => "blob:abc",
      revokeObjectURL: (u) => {
        revoked = u;
      },
    });
    expect(a.url).toBe("blob:abc");
    a.revoke();
    expect(revoked).toBe("blob:abc");

    const b = await createSceneImageUrl(blob, { createObjectURL: null });
    expect(b.url).toBe("data:image/png;base64,AQID");
    b.revoke(); // dataURL 无副作用
    expect(await blobToDataUrl(blob)).toBe("data:image/png;base64,AQID");
  });

  it("LO-SCENE-IMG-8: 房间矩形 → 百分比", () => {
    const r = rectToPercent([960, 536, 480, 268], 1920, 1072);
    expect(r).toEqual({ left: "50.000%", top: "50.000%", width: "25.000%", height: "25.000%" });
    for (const room of PIXEL_ROOMS) {
      const p = rectToPercent(room.bounds, CLAW_SCENE.displayWidth, CLAW_SCENE.displayHeight);
      expect(parseFloat(p.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(p.left) + parseFloat(p.width)).toBeLessThanOrEqual(100.001);
      expect(parseFloat(p.top) + parseFloat(p.height)).toBeLessThanOrEqual(100.001);
    }
  });

  it("LO-SCENE-IMG-9: 预设清单自洽，图层文件真实存在且为 2752×1536", async () => {
    expect(SCENE_PRESETS.length).toBeGreaterThanOrEqual(2);
    expect(SCENE_PRESETS.map((p) => p.id)).toEqual(BUILTIN_SCENE_IMAGE_IDS);
    expect(getScenePreset("claw")?.layers.length).toBe(2);
    expect(getScenePreset(FALLBACK_SCENE_PRESET_ID)).toBeTruthy();
    expect(getScenePreset("不存在")).toBeUndefined();
    expect(CUSTOM_SCENE_KEY).toBe("custom-scene");

    for (const preset of SCENE_PRESETS) {
      expect(preset.credit.length).toBeGreaterThan(4);
      expect(preset.thumb.startsWith("/library-ops/")).toBe(true);
      expect(existsSync(join(ASSET_DIR, preset.thumb.replace("/library-ops/", ""))), `${preset.id} 缩略图缺失`).toBe(true);
      for (const layer of preset.layers) {
        const rel = layer.replace("/library-ops/", "");
        expect(existsSync(join(ASSET_DIR, rel)), `${preset.id} 图层缺失：${rel}`).toBe(true);
      }
    }

    // 单图层预设（一整张场景图）必须是 2752×1536，才能与内置坐标对齐
    const single = getScenePreset(FALLBACK_SCENE_PRESET_ID)!;
    expect(single.layers.length).toBe(1);
    const meta = await sharp(join(ASSET_DIR, single.layers[0].replace("/library-ops/", ""))).metadata();
    expect(meta.width).toBe(CLAW_SCENE.nativeWidth);
    expect(meta.height).toBe(CLAW_SCENE.nativeHeight);
    const thumb = await sharp(join(ASSET_DIR, single.thumb.replace("/library-ops/", ""))).metadata();
    expect(thumb.width).toBe(480);
  });

  it("LO-SCENE-IMG-10: 设置默认值 + 持久化收敛", () => {
    expect(DEFAULT_SETTINGS.sceneImageId).toBe(FALLBACK_SCENE_PRESET_ID);
    expect(DEFAULT_SETTINGS.sceneImageAdjust).toEqual(DEFAULT_SCENE_ADJUST);
    expect(DEFAULT_SETTINGS.showAlignGuides).toBe(false);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sceneImageId: "邪恶预设", sceneImageAdjust: { scale: 77, x: "abc", y: null }, showAlignGuides: "yes" }),
    );
    const loaded = loadSettings();
    expect(loaded.sceneImageId).toBe(FALLBACK_SCENE_PRESET_ID);
    expect(loaded.sceneImageAdjust).toEqual({ scale: 2, x: 0, y: 0 });
    expect(loaded.showAlignGuides).toBe(false);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sceneImageId: "custom", sceneImageAdjust: { scale: 1.4, x: -30, y: 12 }, showAlignGuides: true }));
    const ok = loadSettings();
    expect(ok.sceneImageId).toBe("custom");
    expect(ok.sceneImageAdjust).toEqual({ scale: 1.4, x: -30, y: 12 });
    expect(ok.showAlignGuides).toBe(true);
  });
});
