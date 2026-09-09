#!/usr/bin/env node
/**
 * build-library-ops-scene-preset.mjs
 *
 * 把「一张完整的图书馆场景图」（例如 AI 生成的 `场景.png`）规范化成插件可用的
 * 内置场景预设：
 *
 *   public/library-ops/scenes/<id>.webp        2752×1536（与上游 ClawLibrary 贴图同规格）
 *   public/library-ops/scenes/<id>-thumb.webp  480×268（设置面板画廊缩略图）
 *
 * 为什么要统一成 2752×1536：
 * 场景渲染器的逻辑坐标系是 1920×1080、显示尺寸 1920×1072，贴图按 2752×1536 铺满。
 * 只要预设也是这个尺寸/比例，角色站位、岗位标签、点击热区就与内置场景完全对齐，
 * 不需要改任何坐标数据。
 *
 * 用法：
 *   node scripts/build-library-ops-scene-preset.mjs --src .art-inbox/场景.png --id ai-library-01
 *
 * 参数：
 *   --src   源图片（png / jpg / webp 均可）
 *   --id    预设 id（文件名，建议 kebab-case）
 *   --label 中文名（仅打印，供手写进 data/pixel-art.ts）
 *   --quality WebP 质量（默认 90）
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const NATIVE_W = 2752;
const NATIVE_H = 1536;
const THUMB_W = 480;
const THUMB_H = 268;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const src = arg("src");
const id = arg("id");
const label = arg("label", id);
const quality = Number(arg("quality", "90"));

if (!src || !id) {
  console.error("用法: node scripts/build-library-ops-scene-preset.mjs --src <图片> --id <预设id> [--label <名称>]");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const srcPath = resolve(root, src);
if (!existsSync(srcPath)) {
  console.error(`✗ 源图片不存在: ${srcPath}`);
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error(`✗ 预设 id 只允许小写字母/数字/连字符: ${id}`);
  process.exit(1);
}

const outDir = resolve(root, "public/library-ops/scenes");
mkdirSync(outDir, { recursive: true });

const meta = await sharp(srcPath).metadata();
if (!meta.width || !meta.height) {
  console.error("✗ 无法读取图片尺寸");
  process.exit(1);
}

const targetRatio = NATIVE_W / NATIVE_H;
const srcRatio = meta.width / meta.height;
const drift = Math.abs(srcRatio - targetRatio) / targetRatio;

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
console.log(`源图: ${src} ${meta.width}×${meta.height} (${meta.format}, ${kb(statSync(srcPath).size)})`);
if (drift > 0.02) {
  console.log(
    `⚠ 比例 ${srcRatio.toFixed(3)} 与目标 ${targetRatio.toFixed(3)} 相差 ${(drift * 100).toFixed(1)}%，` +
      `将按「居中裁剪铺满」缩放（画面上下或左右会被裁掉一点）。`,
  );
} else {
  console.log(`比例 ${srcRatio.toFixed(3)} ≈ 目标 ${targetRatio.toFixed(3)}，直接缩放。`);
}

const pipeline = () =>
  sharp(srcPath).resize(NATIVE_W, NATIVE_H, { fit: "cover", position: "centre", kernel: "lanczos3" });

const sceneOut = resolve(outDir, `${id}.webp`);
const thumbOut = resolve(outDir, `${id}-thumb.webp`);

await pipeline().webp({ quality, effort: 6 }).toFile(sceneOut);
await sharp(srcPath)
  .resize(THUMB_W, THUMB_H, { fit: "cover", position: "centre", kernel: "lanczos3" })
  .webp({ quality: 80, effort: 5 })
  .toFile(thumbOut);

console.log(`✓ ${sceneOut.replace(root + "\\", "")}  ${NATIVE_W}×${NATIVE_H}  ${kb(statSync(sceneOut).size)}`);
console.log(`✓ ${thumbOut.replace(root + "\\", "")}  ${THUMB_W}×${THUMB_H}  ${kb(statSync(thumbOut).size)}`);
console.log("");
console.log("把下面这段加进 src/plugins/library-ops/data/pixel-art.ts 的 SCENE_PRESETS：");
console.log(`  {
    id: "${id}",
    label: "${label}",
    labelEn: "${id}",
    image: \`\${ASSET_BASE}/scenes/${id}.webp\`,
    thumb: \`\${ASSET_BASE}/scenes/${id}-thumb.webp\`,
    credit: "本项目内置（AI 生成 / 自有素材）",
    commercial: true,
  },`);
