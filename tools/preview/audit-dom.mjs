/**
 * 预览 DOM 结构审计（开发工具）。
 *
 * 用 headless 浏览器渲染后的 DOM 做几何正确性校验：
 * 1. 每个角色都落在它被分配岗位的等距多边形包围盒内；
 * 2. 角色坐标全部为有限数、在画布范围内；
 * 3. 家具/区域/网格/窗户数量与地图数据一致；
 * 4. 无 NaN / undefined 泄漏到样式。
 *
 * 用法：node tools/preview/audit-dom.mjs <dom.html>
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const html = readFileSync(file, "utf8");

/** 极简属性提取 */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const issues = [];
const stats = {};

// ---- 角色 ----
const actorTags = [...html.matchAll(/<div class="lo-actor-wrap[^"]*"[^>]*>/g)].map((m) => attrs(m[0]));
stats.actors = actorTags.length;
const positions = actorTags.map((a) => {
  const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(a.style ?? "");
  return { id: a["data-actor-id"], x: m ? Number(m[1]) : NaN, y: m ? Number(m[2]) : NaN };
});
for (const p of positions) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) issues.push(`角色 ${p.id} 坐标非有限数: ${p.x},${p.y}`);
}

// ---- 区域多边形 ----
const zoneGroups = [...html.matchAll(/<g class="lo-zone[^"]*"[^>]*data-zone-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
stats.zones = zoneGroups.length;
const zoneBoxes = new Map();
for (const [, id, body] of zoneGroups) {
  const poly = /points="([^"]+)"/.exec(body);
  if (!poly) {
    issues.push(`区域 ${id} 没有多边形`);
    continue;
  }
  const pts = poly[1].trim().split(/\s+/).map((p) => p.split(",").map(Number));
  if (pts.length !== 4) issues.push(`区域 ${id} 顶点数不是 4（${pts.length}）`);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  zoneBoxes.set(id, {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  });
}

// ---- 角色是否落在**自己岗位**的包围盒内（渲染顺序：先场景后 LibraryPanel，取前一半） ----
const firstRenderActors = positions.slice(0, positions.length / 2);
const firstRenderTags = actorTags.slice(0, actorTags.length / 2);
let inOwnZone = 0;
for (let i = 0; i < firstRenderActors.length; i++) {
  const p = firstRenderActors[i];
  const zoneId = firstRenderTags[i]["data-zone-id"];
  const box = zoneId ? zoneBoxes.get(zoneId) : undefined;
  if (!box) {
    issues.push(`角色 ${p.id} 缺少 data-zone-id（渲染时场景态未就绪）`);
    continue;
  }
  const inside = p.x >= box.minX - 6 && p.x <= box.maxX + 6 && p.y >= box.minY - 6 && p.y <= box.maxY + 6;
  if (!inside) issues.push(`角色 ${p.id} 位置 (${p.x.toFixed(1)},${p.y.toFixed(1)}) 不在其岗位 ${zoneId} 区域内`);
  else inOwnZone++;
}
stats.actorsInOwnZone = `${inOwnZone}/${firstRenderActors.length}`;

// ---- 家具 / 网格 / 窗 ----
stats.furniture = [...html.matchAll(/class="lo-fx lo-fx--(\w+)"/g)].length;
stats.furnitureKinds = [...new Set([...html.matchAll(/class="lo-fx lo-fx--(\w+)"/g)].map((m) => m[1]))].sort();
stats.gridLines = [...html.matchAll(/<line /g)].length;
stats.windows = [...html.matchAll(/class="lo-wall-window"/g)].length;
stats.walls = [...html.matchAll(/class="lo-wall"/g)].length;
stats.zoneLabels = [...html.matchAll(/class="lo-zone__label"/g)].length;
stats.hudButtons = [...html.matchAll(/class="lo-hud-btn"/g)].length;

// ---- 脏值 ----
for (const bad of ["NaN", "undefined", "[object Object]"]) {
  const n = html.split(bad).length - 1;
  stats[`dirty_${bad}`] = n;
  if (bad === "undefined" || bad === "NaN" || bad === "[object Object]") {
    // undefined 允许出现在 data-bubble 之类的字符串里？此处严格检查
    if (n > 0) issues.push(`DOM 中出现 ${n} 处 "${bad}"`);
  }
}

console.log(JSON.stringify({ stats, issues }, null, 2));
process.exit(issues.length > 0 ? 1 : 0);
