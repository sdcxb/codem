/**
 * knip 的**棘轮闸门**（第 72 轮审计 A 项）
 *
 * ## 为什么不是直接 `npx knip`
 *
 * `npm run verify` 里原来是裸 `npx knip`，而它**一直是红的**：
 * 报 32 个"未使用文件" + 348 个"未使用导出" + 222 个"未使用类型" + 13 组重复导出 + 1 个命名空间成员。
 * 其中文件那一类是第 62 轮**逐类分诊过**的误报（桶文件 / 全局类型增强 / 构建期 stub /
 * 技能运行期脚本 / Vite 入口），结论写在 `docs/DEAD-CODE-TRIAGE.md`，
 * 但**决定从来没有写进配置** —— 于是 verify 一直红，红久了就没人跑了。
 *
 * ## 现在怎么办（两件事分开）
 *
 * 1. **误报类别写进 `knip.json` 的 `ignore`**（逐条列文件，不写通配 —— 通配会把"将来新出现的
 *    死桶文件"一起放过）。所以"未使用文件"这一类的期望值就是 **0**：**再出现一个就是真发现**。
 * 2. 剩下的"未使用导出/类型/重复导出"这类**没有逐条分诊过**的，做**棘轮**：
 *    与 `tools/audit/knip-baseline.json` 里记录的数量比对，**只许降不许升**。
 *    （本轮没有逐条分诊 348+222 条 —— 那是一个独立的工作量，所以这里不假装它已经清了，
 *    而是把"涨了要说话"变成机器判据。）
 *
 * 用法：
 *   node tools/audit/knip-gate.mjs            # 对账（verify 里跑）
 *   node tools/audit/knip-gate.mjs --update   # 实测后重写基线（必须写明理由）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const BASELINE = path.join(__dirname, "knip-baseline.json");

/** 必须为 0 的类别（误报类别已经进了 knip.json 的 ignore，所以再出现就是真发现） */
const MUST_BE_ZERO = ["files", "unlisted", "binaries", "unresolved", "dependencies", "devDependencies"];
/** 棘轮类别（只许降不许升） */
const RATCHET = ["exports", "types", "duplicates", "enumMembers", "namespaceMembers"];

function measure() {
  /*
   * 直接跑本地 knip 的 bin（用 `node` 起，而不是 `npx` + `shell: true`）：
   * 后者在 Windows 上会带一条 `DEP0190` 弃用告警（参数不转义），
   * 而"工具自己输出告警"会让人分不清是门禁在说话还是它在抱怨。
   */
  const bin = path.join(ROOT, "node_modules", "knip", "bin", "knip.js");
  if (!fs.existsSync(bin)) throw new Error(`找不到 knip：${path.relative(ROOT, bin)}（先 npm install）`);
  const raw = execFileSync(process.execPath, [bin, "--reporter", "json", "--no-exit-code"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const json = JSON.parse(raw);
  const counts = {};
  const samples = {};
  for (const issue of json.issues ?? []) {
    for (const key of Object.keys(issue)) {
      const value = issue[key];
      if (!Array.isArray(value) || value.length === 0) continue;
      counts[key] = (counts[key] ?? 0) + value.length;
      if (!samples[key]) {
        const first = value[0];
        samples[key] = Array.isArray(first)
          ? `${issue.file}: ${first.map((x) => x.name ?? "?").join(" / ")}`
          : `${issue.file}: ${first.name ?? "?"}`;
      }
    }
  }
  return { counts, samples };
}

const args = process.argv.slice(2);
const { counts, samples } = measure();

if (args.includes("--update")) {
  const before = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : null;
  const out = {
    note: "knip 棘轮的基线：数字只许降不许升。改这个文件必须在提交信息里写明理由。",
    recordedAt: new Date().toISOString().slice(0, 10),
    command: "npx knip --reporter json --no-exit-code",
    previous: before?.counts ?? null,
    mustBeZero: MUST_BE_ZERO,
    ratchet: RATCHET,
    counts,
  };
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`已写入 ${path.relative(ROOT, BASELINE)}：${JSON.stringify(counts)}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const problems = [];

for (const key of MUST_BE_ZERO) {
  const got = counts[key] ?? 0;
  if (got > 0) problems.push(`${key} 必须为 0，实测 ${got}（样例：${samples[key] ?? "—"}）`);
}

for (const key of RATCHET) {
  const got = counts[key] ?? 0;
  const allowed = baseline.counts[key] ?? 0;
  if (got > allowed) {
    problems.push(`${key} 涨了：${allowed} → ${got}（样例：${samples[key] ?? "—"}）`);
  } else if (got < allowed) {
    console.log(`  ↓ ${key} 降了：${allowed} → ${got} —— 请跑 --update 把基线收紧（棘轮不会自己收紧）`);
  }
}

/*
 * KNIP-ENTRY-BARREL（第 112 轮）：**knip 的 entry 门面 ↔ 可达性白名单，两侧必须严格相等**。
 *
 * 起因是一次实验（结果写进了 `knip.json` 的注释）：21 个模块门面 barrel 原来在 knip 的 `ignore` 里，
 * 而 `ignore` 是最钝的刀 —— 文件整个从 knip 眼里消失，连它的 `import` 都不算数，
 * 于是被它 re-export 的 45 个符号全被报成"没人用"。改成 `entry` 后**实测 −24 条、新增 0 条**。
 *
 * 但 `entry` 会把另一件事藏起来：这 21 个 barrel **目前没有任何人 import**
 * （实验 A 只从 ignore 拿掉：**20 个立刻变成"未使用文件"**）。
 * 这件事**不该由 knip 记账**，该由可达性门禁记账 —— 它们本来就在
 * `reachability-allowlist.json` 里逐条登记着"为什么不可达"。
 * 所以这里把两侧钉成一条判据：**谁知道它们不可达，谁就必须写在两处**，缺一边就红。
 *
 * （特例已消除：`src/plugins/monopoly-game/index.ts` 同时被 `src/plugins/monopoly-game/**` 通配 ignore 覆盖
 *  —— 那是整目录搬进来的独立插件，这一条 entry 因此是空操作；保留它是为了让两侧集合**严格相等**，
 *  门禁里不留任何例外分支。空操作本身无害，已实测 counts 不变。）
 */
const cfgPath = path.join(ROOT, "knip.json");
const knipCfg = ts.parseConfigFileTextToJson(cfgPath, fs.readFileSync(cfgPath, "utf8"));
if (knipCfg.error) problems.push(`knip.json 解析失败：${JSON.stringify(knipCfg.error)}`);
const entryBarrels = (knipCfg.config?.entry ?? []).filter((e) => e.endsWith("/index.ts"));
const allowKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, "reachability-allowlist.json"), "utf8")).entries ?? {});
const allowBarrels = allowKeys.filter((k) => k.endsWith("/index.ts"));
const onlyEntry = entryBarrels.filter((f) => !allowBarrels.includes(f));
const onlyAllow = allowBarrels.filter((f) => !entryBarrels.includes(f));
if (onlyEntry.length) problems.push(`knip entry 里的模块门面没在可达性白名单里登记（谁替它记账？）：${onlyEntry.join(", ")}`);
if (onlyAllow.length) problems.push(`可达性白名单里的门面没登记成 knip entry（knip 会把它整个藏起来）：${onlyAllow.join(", ")}`);

console.log("\nknip 棘轮对账：");
console.log(`  必须为 0：${MUST_BE_ZERO.map((k) => `${k}=${counts[k] ?? 0}`).join("  ")}`);
console.log(`  棘轮：${RATCHET.map((k) => `${k}=${counts[k] ?? 0}/${baseline.counts[k] ?? 0}`).join("  ")}`);
console.log(`  门面交叉对账：knip entry=${entryBarrels.length} / 可达性白名单=${allowBarrels.length}（两侧必须相等）`);

if (problems.length) {
  console.log("\n❌ knip 发现增长 / 出现了本应为 0 的类别：");
  for (const p of problems) console.log(`  - ${p}`);
  console.log("\n（若确属误报，请按 `docs/DEAD-CODE-TRIAGE.md` 的方法逐条取证后写进 knip.json 的 ignore，再 --update 收紧基线）");
  process.exit(1);
}
console.log("\n✅ 没有增长");
