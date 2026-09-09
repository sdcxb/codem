/**
 * 场景图接入脚本 —— 把绘图模型产出的图书馆场景图变成插件可直接使用的地板层 + 家具层 + 可行走掩码。
 *
 * 用法：
 *   node scripts/build-library-ops-scene.mjs \
 *     --floor  <生成的地板图>            # 必填：房间/地面/墙体（不含角色）
 *     [--objects <生成的家具图>]         # 选填：透明底家具层（叠在地板上）
 *     [--mask <手绘掩码>]                # 选填：红色=可走、白/灰=障碍；不填则按布局自动生成
 *     [--out public/library-ops/claw-library]
 *     [--check]                          # 只做校验，不写文件
 *
 * 处理：
 *   1. 尺寸归一：等比 cover 到 2752×1536（与上游一致；显示时按 1920×1072 缩放）
 *   2. 转 WebP
 *   3. 掩码：手绘则归一化；否则用 layout-guide 的房间矩形 + 路网自动生成
 *   4. 校验：可走比例、连通性、工作锚点/路网节点是否落在可走区域
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { analyzeMaskGrid, isWalkablePixel, rasterizeWalkable } from "./lib/library-ops-asset-utils.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const W = 2752;
const H = 1536;
/** 逻辑坐标（1920×1072）→ 贴图坐标的缩放 */
const SX = W / 1920;
const SY = H / 1072;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CHECK_ONLY = process.argv.includes("--check");

const FLOOR = arg("floor");
const OBJECTS = arg("objects");
const MASK = arg("mask");
const OUT = arg("out", join(ROOT, "public", "library-ops", "claw-library"));

if (!FLOOR && !CHECK_ONLY) {
  console.error("用法: node scripts/build-library-ops-scene.mjs --floor <地板图> [--objects <家具图>] [--mask <掩码图>] [--out <目录>]");
  process.exit(1);
}

/** 与 pixel-art.ts 一致的布局（逻辑坐标）；work 为**上游原始值**，使用时按 28px 边距夹进房间 */
const ROOMS = [
  { id: "gateway", bounds: [700, 320, 470, 300], work: [968, 602] },
  { id: "memory", bounds: [50, 95, 500, 430], work: [362, 344] },
  { id: "skills", bounds: [620, 50, 330, 250], work: [752, 247] },
  { id: "mcp", bounds: [960, 54, 210, 168], work: [902, 240] },
  { id: "document", bounds: [430, 650, 370, 250], work: [682, 822] },
  { id: "images", bounds: [1280, 50, 280, 170], work: [1420, 225] },
  { id: "log", bounds: [1360, 325, 150, 130], work: [1403, 516] },
  { id: "agent", bounds: [930, 650, 300, 210], work: [1057, 858] },
  { id: "break_room", bounds: [1320, 740, 480, 220], work: [1560, 875] },
  { id: "alarm", bounds: [1550, 50, 250, 170], work: [1615, 208] },
  { id: "schedule", bounds: [1625, 325, 240, 130], work: [1622, 488] },
];

/** 镜像 src/plugins/library-ops/data/pixel-art.ts 的 workAnchor()：把锚点夹进房间矩形 */
function clampedWork(room) {
  const [bx, by, bw, bh] = room.bounds;
  const m = 28;
  return {
    x: Math.min(Math.max(room.work[0], bx + m), bx + bw - m),
    y: Math.min(Math.max(room.work[1], by + m), by + bh - m),
  };
}
const NODES = [
  [620, 860], [300, 320], [1040, 610], [1435, 155], [1435, 430], [1555, 430],
  [756, 242], [860, 610], [1080, 820], [1560, 875], [1735, 430], [1690, 155],
  [470, 375], [780, 375], [1080, 375], [1450, 375], [620, 700], [830, 620], [1080, 700], [1500, 760],
];
const EDGES = [
  [0, 12], [1, 12], [2, 13], [3, 11], [11, 5], [4, 15], [5, 15], [12, 13], [13, 14], [14, 15],
  [12, 16], [16, 6], [13, 17], [17, 7], [7, 18], [18, 8], [18, 19], [19, 9], [19, 10],
];

async function normalize(input, outFile, quality = 88) {
  const meta = await sharp(input).metadata();
  if (meta.width !== W || meta.height !== H) {
    console.warn(`⚠ 输入 ${meta.width}x${meta.height} ≠ ${W}x${H}，将等比 cover 缩放（构图会有裁切，建议直接按 ${W}x${H} 生成）`);
  }
  await sharp(input)
    .resize(W, H, { fit: "cover", position: "center" })
    .webp({ quality, effort: 6 })
    .toFile(outFile);
}

async function buildOrCheckMask(maskPath, write) {
  let data;
  let info;
  if (maskPath) {
    const raw = await sharp(maskPath).resize(W, H, { fit: "cover" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    data = raw.data;
    info = raw.info;
    console.log(`掩码：使用手绘掩码 ${maskPath}`);
  } else {
    // 自动生成：房间矩形 + 路网粗线（逻辑坐标 → 贴图坐标）
    const rects = ROOMS.map((r) => [r.bounds[0] * SX, r.bounds[1] * SY, r.bounds[2] * SX, r.bounds[3] * SY]);
    const segs = EDGES.map(([a, b]) => [NODES[a][0] * SX, NODES[a][1] * SY, NODES[b][0] * SX, NODES[b][1] * SY]);
    const cols = 344; // 8px 一格
    const rows = 192;
    const grid = rasterizeWalkable(cols, rows, W / cols, H / rows, rects, segs, 3);
    const buf = Buffer.alloc(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
      const on = grid[i];
      buf[i * 4] = on ? 0xee : 0xff;
      buf[i * 4 + 1] = on ? 0x11 : 0xff;
      buf[i * 4 + 2] = on ? 0x11 : 0xff;
      buf[i * 4 + 3] = 255;
    }
    const png = await sharp(buf, { raw: { width: cols, height: rows, channels: 4 } })
      .resize(W, H, { kernel: "nearest" })
      .png()
      .toBuffer();
    data = (await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    info = { width: W, height: H, channels: 4 };
    console.log("掩码：未提供手绘掩码 → 按布局（房间矩形 + 路网）自动生成");
  }

  // 降采样成网格做统计（8px 一格）
  const cols = Math.floor(W / 8);
  const rows = Math.floor(H / 8);
  const grid = new Array(cols * rows).fill(false);
  const cellW = W / cols;
  const cellH = H / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(info.width - 1, Math.floor((c + 0.5) * cellW));
      const y = Math.min(info.height - 1, Math.floor((r + 0.5) * cellH));
      const i = (y * info.width + x) * info.channels;
      grid[r * cols + c] = isWalkablePixel(data[i], data[i + 1], data[i + 2], data[i + 3]);
    }
  }
  const stats = analyzeMaskGrid(grid, cols, rows);

  // 关键点位是否可走
  const at = (lx, ly) => {
    const c = Math.floor((lx * SX) / cellW);
    const r = Math.floor((ly * SY) / cellH);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
    return grid[r * cols + c];
  };
  const badWork = ROOMS.filter((r) => {
    const w = clampedWork(r);
    return !at(w.x, w.y);
  }).map((r) => r.id);
  const badNodes = NODES.map((n, i) => ({ i, ok: at(n[0], n[1]) })).filter((n) => !n.ok).map((n) => `#${n.i}`);

  console.log("\n掩码校验：");
  console.log(`  可走比例   ${(stats.walkableRatio * 100).toFixed(1)}%  （建议 25%–60%）`);
  console.log(`  连通块     ${stats.components}（建议 1；>1 说明区域被隔断）`);
  console.log(`  最大连通块 ${(stats.largestComponentRatio * 100).toFixed(1)}%`);
  if (badWork.length) console.warn(`  ⚠ 工作锚点不可走：${badWork.join(", ")}`);
  if (badNodes.length) console.warn(`  ⚠ 路网节点不可走：${badNodes.join(", ")}`);
  if (stats.components > 1) console.warn("  ⚠ 可走区域不连通：角色会在隔断处卡住（请把走廊也涂成红色）");
  if (stats.walkableRatio < 0.15) console.warn("  ⚠ 可走比例过低：角色几乎无处可走");
  if (stats.walkableRatio > 0.75) console.warn("  ⚠ 可走比例过高：墙体/家具没有挡住角色");

  if (write) {
    const outMask = join(OUT, "walkable-mask.webp");
    if (maskPath) {
      await normalize(maskPath, outMask, 80);
    } else {
      const buf = Buffer.alloc(cols * rows * 4);
      for (let i = 0; i < cols * rows; i++) {
        buf[i * 4] = grid[i] ? 0xee : 0xff;
        buf[i * 4 + 1] = grid[i] ? 0x11 : 0xff;
        buf[i * 4 + 2] = grid[i] ? 0x11 : 0xff;
        buf[i * 4 + 3] = 255;
      }
      const png = await sharp(buf, { raw: { width: cols, height: rows, channels: 4 } })
        .resize(W, H, { kernel: "nearest" })
        .png()
        .toBuffer();
      await sharp(png).webp({ quality: 80, effort: 6 }).toFile(outMask);
    }
    console.log(`  ✓ 写入 ${outMask}`);
  }
  return { stats, badWork, badNodes };
}

async function main() {
  if (!CHECK_ONLY) await mkdir(OUT, { recursive: true });

  if (FLOOR) {
    const out = join(OUT, "scene-floor.webp");
    if (CHECK_ONLY) {
      const meta = await sharp(FLOOR).metadata();
      console.log(`地板：${FLOOR} ${meta.width}x${meta.height}${meta.width === W && meta.height === H ? " ✓ 尺寸正确" : ` ⚠ 期望 ${W}x${H}`}`);
    } else {
      await normalize(FLOOR, out, 86);
      console.log(`✓ ${out}`);
    }
  }
  if (OBJECTS) {
    const out = join(OUT, "scene-objects.webp");
    if (!CHECK_ONLY) {
      await normalize(OBJECTS, out, 86);
      console.log(`✓ ${out}`);
    }
  }
  await buildOrCheckMask(MASK, !CHECK_ONLY);

  if (!CHECK_ONLY) {
    // 写一份来源说明占位（如果原来是第三方资源，提醒用户替换声明）
    const marker = join(OUT, "GENERATED-BY.md");
    if (!existsSync(marker)) {
      await writeFile(
        marker,
        `# 本目录场景资源由自有/生成素材替换\n\n` +
          `由 \`scripts/build-library-ops-scene.mjs\` 写入（${new Date().toISOString()}）。\n\n` +
          `> 若已全部替换为自有素材，可把 \`SOURCE.md\` 里的第三方来源说明改为自有说明，\n` +
          `> 并同步更新根目录 \`THIRD_PARTY_NOTICES.md\` 与 \`docs/ASSET-LICENSES.md\`。\n`,
        "utf8",
      );
    }
    console.log(`\n下一步：重启开发服务器或重新构建，插件会自动加载新场景（无需改代码）。`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
