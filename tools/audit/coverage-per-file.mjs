/**
 * **按文件的覆盖率地板**（第 96 轮，GAP-LIST 的 O-6）。
 *
 * ## 为什么需要它（聚合阈值的盲区）
 *
 * 现有的棘轮是**全局 + 按目录**的（`coverage-baseline.mjs`：全局 lines 52 / storage 81 / llm 60…）。
 * 那种阈值挡不住最危险的一种退化：**某个文件掉到 0，而总量被别的文件补回来** ——
 * 数字看着没事，那个模块实际上已经没人测了。
 *
 * ## 地板怎么定（先量后定，不拍脑袋）
 *
 * 逐个 `src/**` 文件读实测值，地板取 **实测的 80%（向下取整）**，
 * 只有当文件有 ≥20 行时才建地板（太小的文件抖动太大，地板会频繁误报）。
 * 写进 `tools/audit/coverage-per-file-baseline.json`。
 *
 * ## 判据（`--check`）
 *
 * - ① 已建地板的文件：实测 **不得低于地板**（四个指标各自比）；
 * - ② 新文件（没有地板）里**行覆盖率 = 0 且 ≥50 行**的：**必须**先建地板（否则新模块可以完全没测试地进来）；
 * - ③ 地板表里已消失的文件：提示清理（重构删文件是允许的，但不能让地板表变成僵尸）。
 *
 * 用法：
 *   node tools/audit/coverage-per-file.mjs            # 打印低覆盖文件（找活干）
 *   node tools/audit/coverage-per-file.mjs --write    # 按当前实测写/收紧地板（只降不许升）
 *   node tools/audit/coverage-per-file.mjs --check    # 闸门
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SUMMARY = path.resolve(argOf("--summary") ?? path.join(ROOT, "coverage", "coverage-summary.json"));
const BASELINE = path.resolve(argOf("--baseline") ?? path.join(HERE, "coverage-per-file-baseline.json"));

const METRICS = ["lines", "statements", "functions", "branches"];
/** 建地板的最小体量（行数）；太小的文件抖动大，地板会频繁误报 */
const MIN_LINES = 20;
/** 地板 = 实测 × 该系数（向下取整） */
const FLOOR_RATIO = 0.8;
/** 新文件"完全没测"的判定：行覆盖 0 且行数 ≥ 该值 */
const UNTESTED_NEW_MIN_LINES = 50;

if (!fs.existsSync(SUMMARY)) {
  console.error(`🔴 找不到 ${SUMMARY} —— 先跑一次 npx vitest run --coverage`);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(SUMMARY, "utf8"));

/** 只关心产品源码（排除测试与 node_modules） */
const files = [];
for (const [key, value] of Object.entries(summary)) {
  if (key === "total") continue;
  const rel = path.relative(ROOT, key).replace(/\\/g, "/");
  if (!rel.startsWith("src/")) continue;
  if (rel.includes("/test/") || rel.includes("node_modules")) continue;
  if (!/\.(ts|tsx)$/.test(rel)) continue;
  files.push({ rel, m: value });
}

const floorFor = (pct) => Math.floor(pct * FLOOR_RATIO);
const buildEntry = (m) => Object.fromEntries(METRICS.map((k) => [k, floorFor(m[k]?.pct ?? 0)]));

const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : "list";
const prev = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : { floors: {} };

if (mode === "write") {
  /**
   * ⚠️ **只降不许升**：地板是"实测 × 0.8"。如果某文件这次实测反而更低，地板要跟着降（否则它会一直红）；
   * 实测更高时**不抬高**地板（那会把一次偶然的好成绩变成硬要求）。
   */
  const floors = {};
  for (const { rel, m } of files) {
    if ((m.lines?.total ?? 0) < MIN_LINES) continue;
    const candidate = buildEntry(m);
    const old = prev.floors?.[rel];
    floors[rel] = old
      ? Object.fromEntries(METRICS.map((k) => [k, Math.min(old[k] ?? 0, candidate[k])]))
      : candidate;
  }
  const doc = {
    _note:
      "按文件的覆盖率地板（第 96 轮，O-6）。规则：地板 = 实测 × 0.8 向下取整（≥20 行的文件才建）；" +
      "`--write` 时**只降不许升**（实测变高不抬高地板）。判据见 tools/audit/coverage-per-file.mjs --check 与 src/test/coverage-per-file.test.ts。",
    _ratio: FLOOR_RATIO,
    _minLines: MIN_LINES,
    _count: Object.keys(floors).length,
    floors,
  };
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 1) + "\n", "utf8");
  const lowered = Object.keys(floors).filter((k) => prev.floors?.[k] && METRICS.some((m2) => floors[k][m2] < prev.floors[k][m2]));
  console.log(`地板已写入 ${path.relative(ROOT, BASELINE)}：${doc._count} 个文件（本次下调 ${lowered.length} 个）`);
  process.exit(0);
}

if (mode === "list") {
  const rows = files
    .filter((f) => (f.m.lines?.total ?? 0) >= MIN_LINES)
    .sort((a, b) => (a.m.lines?.pct ?? 0) - (b.m.lines?.pct ?? 0));
  console.log(`行覆盖最低的 25 个文件（共 ${files.length} 个生产文件，${rows.length} 个 ≥${MIN_LINES} 行）：`);
  for (const r of rows.slice(0, 25)) {
    console.log(`  ${String(Math.round(r.m.lines?.pct ?? 0)).padStart(3)}%  行 ${String(r.m.lines?.covered).padStart(4)}/${String(r.m.lines?.total).padEnd(4)}  ${r.rel}`);
  }
  process.exit(0);
}

// ── --check ──
const floors = prev.floors ?? {};
const below = [];
for (const { rel, m } of files) {
  const floor = floors[rel];
  if (!floor) continue;
  for (const k of METRICS) {
    const actual = m[k]?.pct ?? 0;
    if (actual < floor[k]) below.push({ rel, metric: k, actual: Math.round(actual * 100) / 100, floor: floor[k] });
  }
}
const tested = new Set(files.map((f) => f.rel));
const stale = Object.keys(floors).filter((rel) => !tested.has(rel));
const untestedNew = files
  .filter((f) => !floors[f.rel] && (f.m.lines?.total ?? 0) >= UNTESTED_NEW_MIN_LINES && (f.m.lines?.pct ?? 0) === 0)
  .map((f) => f.rel);

if (below.length || untestedNew.length) {
  if (below.length) {
    console.error(`🔴 ${below.length} 处低于**按文件地板**（某个文件掉下去、总量被别处补回来，聚合阈值看不见）：`);
    for (const b of below.slice(0, 25)) console.error(`   ${b.rel}  ${b.metric}: ${b.actual}% < 地板 ${b.floor}%`);
    console.error("处置：把那个文件的测试补回到地板以上；确属重构导致（代码搬家）就跑 `--write`（只会下调，不会抬高）。");
  }
  if (untestedNew.length) {
    console.error(`🔴 ${untestedNew.length} 个新文件**一行都没被覆盖**（≥${UNTESTED_NEW_MIN_LINES} 行）：`);
    for (const f of untestedNew.slice(0, 15)) console.error(`   ${f}`);
    console.error("处置：给新模块补测试，或先把它们纳入地板表（`--write`）—— 不允许「大块新代码零测试」悄悄进来。");
  }
  process.exit(1);
}

console.log(
  `按文件地板闸门通过：${Object.keys(floors).length} 个文件都在地板之上` +
    (stale.length ? `（另有 ${stale.length} 个地板条目对应文件已不存在，建议跑 --write 清理）` : ""),
);
process.exit(0);
