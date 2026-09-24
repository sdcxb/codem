/**
 * 覆盖率**棘轮**（ratchet）的度量工具（第 72 轮审计 A 项）
 *
 * ## 为什么需要它
 *
 * `vitest.config.ts` 里原来那组阈值（lines/functions 50、branches 40、perFile）
 * **从来没有生效过**：provider `@vitest/coverage-v8` 压根没装，`npm run test:coverage`
 * 直接 `MISSING DEPENDENCY` 退出。也就是说"功能轴是否探到原子函数"这一条**一直没有度量**。
 *
 * 装好 provider 之后，阈值不能拍脑袋写：一上来就写高值会红一片、逼着人把阈值改回 0
 * （那还不如没有）。所以这里做**先量后定**：
 *
 *   1. 跑一次真覆盖（`npx vitest run --coverage`）→ `coverage/coverage-summary.json`；
 *   2. `node tools/audit/coverage-baseline.mjs` 读它，算出**全局**与**按目录**的实测值；
 *   3. 把实测值减 1 个百分点写进 `vitest.config.ts` 的 thresholds（见 `--ratchet` 输出）；
 *   4. `node tools/audit/coverage-baseline.mjs --check` 复核"配置里的数字 vs 实测值"，
 *      确认阈值既没写虚高（一跑就红）也没写虚低（形同没有）。
 *
 * ## 口径
 *
 * 数字来自 `coverage/coverage-summary.json`（`json-summary` reporter）：
 * 逐文件的 statements / branches / functions / lines 四个计数，按 glob 聚合。
 *
 * ⚠️ **不要用 `lcov.info` 顶替**：lcov 里**没有语句计数**。第一版就是拿"行覆盖率"
 * 当语句覆盖率填的阈值，第一次真跑就红（实测语句 51.27% 而 行 53.66% —— v8 的语句 ≠ 行）。
 *
 * 用法：
 *   node tools/audit/coverage-baseline.mjs            # 打印实测值
 *   node tools/audit/coverage-baseline.mjs --ratchet  # 打印可直接粘贴的 thresholds
 *   node tools/audit/coverage-baseline.mjs --check    # 与 vitest.config.ts 里的数字对账
 *   node tools/audit/coverage-baseline.mjs --md       # 写 tools/audit/coverage-baseline.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SUMMARY = path.join(ROOT, "coverage", "coverage-summary.json");
const CONFIG = path.join(ROOT, "vitest.config.ts");
const DOC = path.join(__dirname, "coverage-baseline.md");

/** 要单独盯住的区域（判据按 glob 聚合，与 vitest 的 per-glob 阈值口径一致） */
const AREAS = [
  // `include` 只收 `src/core/**` + `src/store/**`，所以"(all)"就等于"核心" —— 不重复设一条
  { key: "", label: "全部（include 范围）", match: () => true },
  { key: "src/core/storage/**", label: "存储（域镜像/引擎通路）", match: (f) => f.startsWith("src/core/storage/") },
  { key: "src/core/llm/**", label: "LLM（工具/循环/溢出）", match: (f) => f.startsWith("src/core/llm/") },
  { key: "src/core/session/**", label: "会话（编排/委派）", match: (f) => f.startsWith("src/core/session/") },
  { key: "src/core/diagnostics/**", label: "诊断（崩溃取证）", match: (f) => f.startsWith("src/core/diagnostics/") },
];

function readSummary() {
  if (!fs.existsSync(SUMMARY)) {
    throw new Error(
      `找不到 ${path.relative(ROOT, SUMMARY)} —— 先跑一次 npx vitest run --coverage（reporter 需含 json-summary）`,
    );
  }
  const json = JSON.parse(fs.readFileSync(SUMMARY, "utf8"));
  const files = [];
  for (const [abs, v] of Object.entries(json)) {
    if (abs === "total") continue;
    const file = path.relative(ROOT, abs).replace(/\\/g, "/");
    files.push({
      file,
      statements: { hit: v.statements.covered, total: v.statements.total },
      branches: { hit: v.branches.covered, total: v.branches.total },
      functions: { hit: v.functions.covered, total: v.functions.total },
      lines: { hit: v.lines.covered, total: v.lines.total },
    });
  }
  return files;
}

const pct = (hit, total) => (total === 0 ? 100 : +((hit / total) * 100).toFixed(2));

export function measure() {
  const files = readSummary();
  const out = new Map();
  for (const area of AREAS) {
    const hit = {
      statements: { hit: 0, total: 0 },
      branches: { hit: 0, total: 0 },
      functions: { hit: 0, total: 0 },
      lines: { hit: 0, total: 0 },
    };
    let count = 0;
    for (const f of files) {
      if (!area.match(f.file)) continue;
      count++;
      for (const k of Object.keys(hit)) {
        hit[k].hit += f[k].hit;
        hit[k].total += f[k].total;
      }
    }
    out.set(area.key || "(all)", {
      label: area.label,
      files: count,
      lines: pct(hit.lines.hit, hit.lines.total),
      branches: pct(hit.branches.hit, hit.branches.total),
      functions: pct(hit.functions.hit, hit.functions.total),
      statements: pct(hit.statements.hit, hit.statements.total),
    });
  }
  return out;
}

/** 实测值 → 阈值：向下取整再留 1 个百分点余量（"掉下去就红"，但不因噪声乱红） */
const ratchet = (measured) => Math.max(0, Math.floor(measured) - 1);

/** 从 vitest.config.ts 里读出当前 thresholds 里写的数字（对账用） */
export function configured() {
  const src = fs.readFileSync(CONFIG, "utf8");
  const block = /thresholds:\s*\{([\s\S]*?)\n {6}\}/.exec(src);
  if (!block) throw new Error("无法从 vitest.config.ts 解析 thresholds");
  const out = {};
  for (const m of block[1].matchAll(/(?:"([^"]+)"|([A-Za-z]+)):\s*(?:\{\s*([^}]*)\}|(\d+))/g)) {
    const key = m[1] ?? m[2];
    if (m[4] !== undefined) out[key] = Number(m[4]);
    else {
      const inner = {};
      for (const p of m[3].matchAll(/([A-Za-z]+):\s*(\d+)/g)) inner[p[1]] = Number(p[2]);
      out[key] = inner;
    }
  }
  return out;
}

const args = process.argv.slice(2);
const measured = measure();

if (args.includes("--md")) {
  const lines = [
    "# 覆盖率基线（棘轮的真源）",
    "",
    "> 由 `node tools/audit/coverage-baseline.mjs --md` 生成；数字来自**真实一次**",
    "> `npx vitest run --coverage` 的 `coverage/coverage-summary.json`（`json-summary` reporter）。**不要手工编辑**。",
    "",
    "`vitest.config.ts` 的 thresholds 就是按这张表减 1 个百分点写下的：",
    "掉下去会红，噪声不会让它乱红。",
    "",
    "| 区域 | 文件 | 语句 | 分支 | 函数 | 行 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [key, v] of measured) {
    lines.push(`| \`${key}\` ${v.label} | ${v.files} | ${v.statements}% | ${v.branches}% | ${v.functions}% | ${v.lines}% |`);
  }
  lines.push(
    "",
    "## 这张表**不**说明什么（避免把它当成「覆盖良好」的证明）",
    "",
    "- 聚合阈值**挡不住**「某个文件掉到 0、总量被别处补回来」。按文件的 floors 是很自然的下一步；",
    "  现在只按目录（上面那几个 glob）设了地板，因为再细的数字需要一次专门的测量。",
    "- 未覆盖的大块（`core/cicd` / `core/config` / `core/provider` / `core/phone-link` 等）",
    "  是**已知**的：它们要么依赖真机外部进程、要么只有 UI 接线 —— 数字低本身不是缺陷，",
    "  但「低且没人知道为什么低」是缺陷，所以这张表把它们逐区列出来。",
  );
  fs.writeFileSync(DOC, lines.join("\n") + "\n", "utf8");
  console.log(`写入 ${path.relative(ROOT, DOC)}`);
  process.exit(0);
}

if (args.includes("--ratchet")) {
  const all = measured.get("(all)");
  console.log("    thresholds: {");
  console.log(`      lines: ${ratchet(all.lines)},`);
  console.log(`      functions: ${ratchet(all.functions)},`);
  console.log(`      branches: ${ratchet(all.branches)},`);
  console.log(`      statements: ${ratchet(all.statements)},`);
  for (const [key, v] of measured) {
    if (key === "(all)") continue;
    console.log(`      "${key}": { lines: ${ratchet(v.lines)}, functions: ${ratchet(v.functions)}, branches: ${ratchet(v.branches)}, statements: ${ratchet(v.statements)} },`);
  }
  console.log("    },");
  process.exit(0);
}

if (args.includes("--check")) {
  const cfg = configured();
  const problems = [];
  const all = measured.get("(all)");
  for (const [metric, value] of [
    ["lines", all.lines],
    ["functions", all.functions],
    ["branches", all.branches],
    ["statements", all.statements],
  ]) {
    const want = ratchet(value);
    const got = cfg[metric];
    if (typeof got !== "number") problems.push(`全局 ${metric} 没写（实测 ${value}% ⇒ 应写 ${want}）`);
    else if (got > value) problems.push(`全局 ${metric} = ${got} 高于实测 ${value}% ⇒ 一跑就红`);
    else if (got < want - 2) problems.push(`全局 ${metric} = ${got} 比实测 ${value}% 低太多（应 ≥ ${want}）⇒ 形同没有`);
  }
  for (const [key, v] of measured) {
    if (key === "(all)") continue;
    const got = cfg[key];
    if (!got) {
      problems.push(`${key} 没设 per-glob 阈值（实测 lines ${v.lines}% / branches ${v.branches}%）`);
      continue;
    }
    /*
     * 四个指标都要对账，**一个都不能省**：第一版只对了 lines，于是"语句覆盖率被写成
     * 行覆盖率的数"这件事在对账里看不出来，直到真跑一次才红。
     */
    for (const metric of ["lines", "functions", "branches", "statements"]) {
      if (typeof got[metric] !== "number") problems.push(`${key} 的 ${metric} 没写（实测 ${v[metric]}%）`);
      else if (got[metric] > v[metric]) problems.push(`${key} 的 ${metric}=${got[metric]} 高于实测 ${v[metric]}% ⇒ 一跑就红`);
    }
  }
  console.log("\n阈值对账（配置 vs 实测）：");
  console.log(`  全局：配置 lines=${cfg.lines} functions=${cfg.functions} branches=${cfg.branches} statements=${cfg.statements}`);
  console.log(`  实测：lines=${all.lines} functions=${all.functions} branches=${all.branches} statements=${all.statements}`);
  for (const [key, v] of measured) {
    if (key === "(all)") continue;
    const got = cfg[key];
    console.log(`  ${key}: 配置 lines=${got?.lines ?? "—"} | 实测 lines=${v.lines} branches=${v.branches} functions=${v.functions}`);
  }
  if (problems.length) {
    console.log("\n❌ 阈值与实测不符：");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('\n✅ 阈值都在「实测之下、棘轮之内」');
  process.exit(0);
}

console.log("\n覆盖率实测（来自 coverage/coverage-summary.json）：");
for (const [key, v] of measured) {
  console.log(
    `  ${key.padEnd(28)} 文件 ${String(v.files).padStart(4)}  行 ${String(v.lines).padStart(6)}%  分支 ${String(v.branches).padStart(6)}%  函数 ${String(v.functions).padStart(6)}%`,
  );
}
console.log("\n按实测应写入的 thresholds（node tools/audit/coverage-baseline.mjs --ratchet）：");
