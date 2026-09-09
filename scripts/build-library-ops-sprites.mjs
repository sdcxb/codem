/**
 * 角色精灵表接入脚本 —— 把绘图模型产出的角色图变成插件可直接使用的精灵表。
 *
 * 输入可以是两种：
 * A. **一张网格精灵表**（推荐）：例如 6 列 × 6 行、每格 128×128、纯色背景
 * B. **一组单帧图**（同一动作的若干帧，文件名排序）
 *
 * 处理流程：
 *   去背景（色键）→ 切格 → 每帧裁剪到内容 → 统一基线/水平居中摆进 128×128 → WebP → 清单
 *
 * 用法：
 *   node scripts/build-library-ops-sprites.mjs \
 *     --in  <输入文件或目录> \
 *     --action walk \
 *     --variant capy \
 *     --bg "#ff00ff"            # 背景色；也可 --bg auto 自动取四角众数
 *     [--grid 6x6]              # 精灵表列×行；单帧目录模式忽略
 *     [--frame 128x128]         # 目标帧尺寸，默认 128x128
 *     [--fps 6]
 *     [--tolerance 40]
 *     [--out public/library-ops/claw-library/actors]
 *
 * 产物：
 *   <out>/<variant>/<action>.webp          （帧尺寸 frame，行主序）
 *   <out>/<variant>/manifest.json          （帧宽高 / 帧数 / 列 / 行 / fps）
 *
 * 接入后若要在 UI 里生效，请把该动作登记到
 * `src/plugins/library-ops/data/pixel-art.ts` 的 `SPRITE_SHEETS`（脚本会打印提示）。
 */
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { alphaBBox, fitToFrame, keyOutBackground, parseColor, sliceGrid } from "./lib/library-ops-asset-utils.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const IN = arg("in");
const ACTION = arg("action", "idle");
const VARIANT = arg("variant", "custom");
const BG = arg("bg", "auto");
const GRID = arg("grid", "auto");
const FRAME = arg("frame", "128x128");
const FPS = Number(arg("fps", "6"));
const TOLERANCE = Number(arg("tolerance", "40"));
const OUT = arg("out", join(ROOT, "public", "library-ops", "claw-library", "actors"));

if (!IN) {
  console.error("用法: node scripts/build-library-ops-sprites.mjs --in <文件或目录> --action walk --variant capy [--bg #ff00ff] [--grid 6x6]");
  process.exit(1);
}

const [fw, fh] = FRAME.split("x").map(Number);

/** 取四角众数作为背景色 */
async function detectBackground(data, width, height, channels) {
  const samples = [];
  const push = (x, y) => {
    const i = (y * width + x) * channels;
    samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  };
  const pad = 2;
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 32))) {
    push(x, pad);
    push(x, height - 1 - pad);
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 32))) {
    push(pad, y);
    push(width - 1 - pad, y);
  }
  const bucket = new Map();
  for (const s of samples) {
    const k = `${s.r >> 4},${s.g >> 4},${s.b >> 4}`;
    const cur = bucket.get(k) ?? { ...s, n: 0 };
    cur.n++;
    bucket.set(k, cur);
  }
  return [...bucket.values()].sort((a, b) => b.n - a.n)[0];
}

/** 一帧：按 alpha 包围盒裁剪内容 → 摆进目标帧（统一基线 + 水平居中） */
async function normalizeFrame(input, left, top, width, height) {
  const cell = await sharp(input)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bbox = alphaBBox(cell.data, cell.info.width, cell.info.height, cell.info.channels, 8);

  const empty = () =>
    sharp({ create: { width: fw, height: fh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();

  if (bbox.empty) return empty();

  const fit = fitToFrame(
    { width: bbox.width, height: bbox.height },
    { width: fw, height: fh },
    { baselineRatio: 0.94 },
  );
  const content = await sharp(input)
    .extract({ left: left + bbox.left, top: top + bbox.top, width: bbox.width, height: bbox.height })
    .resize(fit.width, fit.height, { fit: "fill" })
    .png()
    .toBuffer();

  return sharp({ create: { width: fw, height: fh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: content, left: fit.left, top: fit.top }])
    .png()
    .toBuffer();
}

async function main() {
  const inStat = await stat(IN);
  const outDir = join(OUT, VARIANT);
  await mkdir(outDir, { recursive: true });

  let frames = [];

  if (inStat.isDirectory()) {
    // 单帧目录模式
    const files = (await readdir(IN))
      .filter((f) => [".png", ".webp", ".jpg", ".jpeg"].includes(extname(f).toLowerCase()))
      .sort();
    if (files.length === 0) throw new Error(`目录内没有图片: ${IN}`);
    console.log(`单帧模式：${files.length} 张`);
    for (const f of files) {
      let img = sharp(join(IN, f));
      const meta = await img.metadata();
      let buf = await img.png().toBuffer();
      if (BG !== "none") {
        const raw = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const bg = BG === "auto" ? await detectBackground(raw.data, raw.info.width, raw.info.height, raw.info.channels) : parseColor(BG);
        const keyed = keyOutBackground(raw.data, bg, TOLERANCE, raw.info.channels);
        buf = await sharp(keyed, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } }).png().toBuffer();
      }
      frames.push(await normalizeFrame(buf, 0, 0, meta.width, meta.height));
    }
  } else {
    // 精灵表模式
    const meta = await sharp(IN).metadata();
    let buf = await sharp(IN).png().toBuffer();
    if (BG !== "none") {
      const raw = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const bg = BG === "auto" ? await detectBackground(raw.data, raw.info.width, raw.info.height, raw.info.channels) : parseColor(BG);
      const keyed = keyOutBackground(raw.data, bg, TOLERANCE, raw.info.channels);
      buf = await sharp(keyed, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } }).png().toBuffer();
    }
    let cols;
    let rows;
    if (GRID === "auto") {
      // 按帧尺寸推断网格（要求整除）
      cols = Math.max(1, Math.round(meta.width / fw));
      rows = Math.max(1, Math.round(meta.height / fh));
      if (cols * fw !== meta.width || rows * fh !== meta.height) {
        console.warn(`⚠ 图像 ${meta.width}x${meta.height} 不是 ${fw}x${fh} 的整数倍；将按推断网格 ${cols}x${rows} 切分（可能切到边缘）。建议用 --grid 显式指定。`);
      }
    } else {
      [cols, rows] = GRID.split("x").map(Number);
    }
    console.log(`精灵表模式：${meta.width}x${meta.height} → ${cols}×${rows} 格，每格 ${fw}×${fh}`);
    const cells = sliceGrid(meta.width, meta.height, cols, rows);
    for (const cell of cells) {
      frames.push(await normalizeFrame(buf, cell.left, cell.top, cell.width, cell.height));
    }
  }

  // 逐帧横向拼接成精灵表（保持行主序，列数 = 帧数，行数 = 1）
  const sheetWidth = frames.length * fw;
  const sheet = sharp({
    create: { width: sheetWidth, height: fh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  });
  const composites = frames.map((buf, i) => ({ input: buf, left: i * fw, top: 0 }));
  const outFile = join(outDir, `${ACTION}.webp`);
  await sheet.composite(composites).webp({ quality: 92, effort: 6 }).toFile(outFile);

  // 更新清单
  const manifestPath = join(outDir, "manifest.json");
  let manifest = { variant: VARIANT, frameCanvas: { width: fw, height: fh }, actions: [] };
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      /* 损坏则重建 */
    }
  }
  manifest.variant = VARIANT;
  manifest.frameCanvas = { width: fw, height: fh };
  manifest.actions = (manifest.actions ?? []).filter((a) => a.id !== ACTION);
  manifest.actions.push({
    id: ACTION,
    spritesheet: `${VARIANT}/${ACTION}.webp`,
    fps: FPS,
    sheet: { frameWidth: fw, frameHeight: fh, frameCount: frames.length, columns: frames.length, rows: 1 },
    generated: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`\n✓ ${outFile}（${frames.length} 帧，${fw}×${fh}，${FPS}fps）`);
  console.log(`✓ ${manifestPath}`);
  console.log(`
下一步：把动作登记到 src/plugins/library-ops/data/pixel-art.ts 的 SPRITE_SHEETS.${VARIANT}：
  ${ACTION}: { path: "actors/${VARIANT}/${ACTION}.webp", frameWidth: ${fw}, frameHeight: ${fh}, frameCount: ${frames.length}, columns: ${frames.length}, rows: 1, fps: ${FPS} },`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
