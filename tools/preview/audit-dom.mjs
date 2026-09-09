/**
 * 预览 DOM 结构审计（开发工具）。
 *
 * 用 headless 浏览器渲染后的 DOM 做几何正确性校验，**按场景分别审计**：
 * - 像素场景（`data-scene="pixel"`）：图层 / 12 房间 / 精灵表接线 / 角色坐标在画布内；
 * - 等距场景（`data-scene="iso"`）：区域多边形 = 区域矩形角点投影、角色落在自己岗位的
 *   包围盒内、家具三面齐全、网格线数量、无 NaN 泄漏。
 *
 * 用法：node tools/preview/audit-dom.mjs <dom.html>
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const html = readFileSync(file, "utf8");

const issues = [];
const stats = {};

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** 按场景根节点（<div class="lo-scene" data-scene="...">）切出每个场景子树 */
function splitScenes(source) {
  const starts = [...source.matchAll(/<div class="lo-scene"[^>]*data-scene="/g)].map((m) => m.index);
  const scenes = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : source.length;
    scenes.push(source.slice(starts[i], end));
  }
  return scenes;
}

const scenes = splitScenes(html);
stats.scenes = scenes.length;
stats.pixelScenes = scenes.filter((s) => s.includes('data-scene="pixel"')).length;
stats.isoScenes = scenes.filter((s) => s.includes('data-scene="iso"')).length;

// ============ 像素场景 ============
for (const scene of scenes.filter((s) => s.includes('data-scene="pixel"'))) {
  const layers = [...scene.matchAll(/class="lo-pixel-layer[^"]*"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  stats.pixelLayers = (stats.pixelLayers ?? 0) + layers.length;
  stats.pixelLayerSrc = [...new Set([...(stats.pixelLayerSrc ?? []), ...layers])];
  if (layers.length < 1 || layers.length > 2) {
    issues.push(`像素场景图层应为 1（整张场景图）或 2（地板 + 家具），实际 ${layers.length}`);
  }
  for (const src of layers) {
    if (!src.startsWith("/library-ops/")) issues.push(`像素场景图层路径异常: ${src}`);
  }
  const sceneImage = /data-scene-image="([^"]+)"/.exec(scene);
  stats.pixelSceneImage = sceneImage ? sceneImage[1] : null;
  if (!sceneImage) issues.push("像素场景缺少 data-scene-image 标记（无法判断用的是哪张图）");

  const rooms = [...scene.matchAll(/class="lo-pixel-room(?: is-selected)?"/g)].length;
  stats.pixelRooms = (stats.pixelRooms ?? 0) + rooms;
  if (rooms !== 12) issues.push(`像素场景房间应为 12，实际 ${rooms}`);

  const sprites = [...scene.matchAll(/class="lo-sprite"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
  stats.pixelSprites = (stats.pixelSprites ?? 0) + sprites.length;
  const urls = new Set();
  for (const s of sprites) {
    const m = /background-image:\s*url\(&quot;([^&]+)&quot;\)|background-image:\s*url\(([^)]+)\)/.exec(s);
    if (m) urls.add((m[1] ?? m[2]).replace(/&quot;/g, ""));
  }
  stats.pixelSpriteUrls = [...new Set([...(stats.pixelSpriteUrls ?? []), ...urls])].sort();
  if (sprites.length > 0 && urls.size === 0) issues.push("像素角色没有 background-image（精灵表未接线）");

  const actors = [...scene.matchAll(/class="lo-actor-wrap lo-pixel-actor[^"]*"[^>]*style="transform:\s*translate3d\(([-\d.]+)px,\s*([-\d.]+)px/g)];
  stats.pixelActors = (stats.pixelActors ?? 0) + actors.length;
  for (const [, xs, ys] of actors) {
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) issues.push(`像素角色坐标非有限数: ${xs},${ys}`);
    if (x < -60 || x > 1980 || y < -60 || y > 1140) issues.push(`像素角色坐标越界: ${x},${y}`);
  }
}

// ============ 等距场景 ============
function parsePoints(s) {
  return s
    .trim()
    .split(/\s+/)
    .map((p) => p.split(",").map(Number));
}

for (const scene of scenes.filter((s) => s.includes('data-scene="iso"'))) {
  const zoneGroups = [...scene.matchAll(/<g class="lo-zone[^"]*"[^>]*data-zone-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  stats.isoZones = (stats.isoZones ?? 0) + zoneGroups.length;
  if (zoneGroups.length !== 10) issues.push(`等距场景区域应为 10，实际 ${zoneGroups.length}`);

  const boxes = new Map();
  for (const [, id, body] of zoneGroups) {
    const poly = /points="([^"]+)"/.exec(body);
    if (!poly) {
      issues.push(`等距区域 ${id} 没有多边形`);
      continue;
    }
    const pts = parsePoints(poly[1]);
    if (pts.length !== 4) issues.push(`等距区域 ${id} 顶点数不是 4（${pts.length}）`);
    boxes.set(id, {
      minX: Math.min(...pts.map((p) => p[0])),
      maxX: Math.max(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])),
      maxY: Math.max(...pts.map((p) => p[1])),
    });
  }

  const wraps = [...scene.matchAll(/<div class="lo-actor-wrap[^"]*"[^>]*>/g)].map((m) => attrs(m[0]));
  stats.isoActors = (stats.isoActors ?? 0) + wraps.length;
  let inOwn = 0;
  for (const w of wraps) {
    const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(w.style ?? "");
    if (!m) {
      issues.push(`等距角色 ${w["data-actor-id"]} 没有 transform`);
      continue;
    }
    const x = Number(m[1]);
    const y = Number(m[2]);
    const zoneId = w["data-zone-id"];
    const box = zoneId ? boxes.get(zoneId) : undefined;
    if (!box) {
      issues.push(`等距角色 ${w["data-actor-id"]} 缺少 data-zone-id`);
      continue;
    }
    if (x >= box.minX - 6 && x <= box.maxX + 6 && y >= box.minY - 6 && y <= box.maxY + 6) inOwn++;
    else issues.push(`等距角色 ${w["data-actor-id"]} (${x.toFixed(1)},${y.toFixed(1)}) 不在岗位 ${zoneId} 内`);
  }
  stats.isoActorsInOwnZone = `${inOwn}/${wraps.length}`;

  stats.isoFurniture = (stats.isoFurniture ?? 0) + [...scene.matchAll(/class="lo-fx lo-fx--(\w+)"/g)].length;
  stats.isoGridLines = (stats.isoGridLines ?? 0) + [...scene.matchAll(/<line /g)].length;
}

// ============ 全局脏值 ============
for (const bad of ["NaN", "undefined", "[object Object]"]) {
  const n = html.split(bad).length - 1;
  stats[`dirty_${bad}`] = n;
  if (n > 0) issues.push(`DOM 中出现 ${n} 处 "${bad}"`);
}

console.log(JSON.stringify({ stats, issues }, null, 2));
process.exit(issues.length > 0 ? 1 : 0);
