/**
 * 语法门禁（第 119 轮，audit 第 16 道）：**仓库里被跟踪的工具脚本必须语法正确**。
 *
 * ## 为什么要有这道闸
 *
 * 这不是"理论上应该检查"，而是我在第 117–118 轮**连着被同一个坑咬了四次**：
 * 生成脚本时在中文串里写了 ASCII 双引号 ⇒ **字符串被提前截断** ⇒ 脚本语法错 ⇒ **它根本没跑**，
 * 而我的流程却继续往下走（第 118 轮就这样让 CHANGELOG 说"读数已入表"、表里其实没有）。
 * 同类还有：注释里写路径带 `星号+斜杠` 提前结束块注释、`node_modules/.bin/*.cmd` 起不来却当成"跑出 0"。
 *
 * 共同点：**"脚本没跑成"和"脚本跑出 0 条"长得一样**。所以这里把"能跑"变成机器判据。
 *
 * ## 范围与口径（写清楚，免得被当成万能）
 *
 * - **只查 git 跟踪的**脚本（`tools/**`、`scripts/**`，扩展名 `.mjs/.cjs/.js`）——
 *   未跟踪的一次性脚本（`.preview-shot/**`）跟着仓库走，不该由仓库门禁负责；
 *   要连它们一起看时加 `--scratch`（**默认不扫**：那里有一千多个文件，逐个起 `node --check`
 *   会把门禁拖到几分钟 —— 第 119 轮第一版就是这么超时的，如实记着）。
 * - 只做 `node --check`（解析），**不做类型检查**（那是 `tsc` 的事）、也不执行脚本。
 *
 * 用法：
 *   node tools/audit/check-node-syntax.mjs                  # 门禁（verify/audit 里跑，只查跟踪的）
 *   node tools/audit/check-node-syntax.mjs --scratch         # 顺带扫一次性脚本（慢）
 *   node tools/audit/check-node-syntax.mjs --strict-scratch  # 顺带扫，且一次性脚本坏了也算失败
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const strictScratch = process.argv.includes("--strict-scratch");
const EXTS = [".mjs", ".cjs", ".js"];

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && EXTS.some((e) => s.endsWith(e)))
  .filter((s) => s.startsWith("tools/") || s.startsWith("scripts/"))
  .filter((s) => fs.existsSync(path.join(ROOT, s)));

/*
 * 第 127 轮补：**还包括"已写但还没提交"的 tools/scripts 脚本**。
 * 起因很直白：这一轮我在 `tools/audit/check-gaplist.mjs` 里又写了一次 ASCII 双引号（第 6 次），
 * 而它当时还没被 git 跟踪 ⇒ 门禁看不见它。**要提交的东西必须在提交前就被检查**。
 */
for (const f of execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && EXTS.some((e) => s.endsWith(e)))
  .filter((s) => s.startsWith("tools/") || s.startsWith("scripts/"))) {
  if (!tracked.includes(f)) tracked.push(f);
}

const scratchDir = path.join(ROOT, ".preview-shot");
const scratch = fs.existsSync(scratchDir)
  ? fs
      .readdirSync(scratchDir)
      .filter((f) => EXTS.some((e) => f.endsWith(e)))
      .map((f) => `.preview-shot/${f}`)
  : [];

const check = (file) => {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, file)], { encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (e) {
    const text = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n");
    const msg = text.find((l) => /SyntaxError|Error:/.test(l)) ?? text[0] ?? "（没有可读的错误信息）";
    return msg.trim().slice(0, 160);
  }
};

const failures = [];
for (const f of tracked) {
  const err = check(f);
  if (err) failures.push({ file: f, err });
}

console.log(`语法门禁（node --check）：跟踪的脚本 ${tracked.length} 个`);
if (failures.length) {
  console.log(`❌ ${failures.length} 个语法错：`);
  for (const f of failures) console.log(`   ${f.file}\n      ${f.err}`);
} else {
  console.log("✅ 全部解析通过");
}

const scratchBad = [];
const scanAll = process.argv.includes("--scratch") || strictScratch;
/*
 * 第 125 轮：**默认要查"最近改过的一次性脚本"**。
 *
 * 起因：同一个坑（中文串里写 ASCII 双引号 ⇒ 字符串截断 ⇒ 脚本没跑）我踩到第 5 次，
 * 而每次坏的**都是刚写的临时脚本** —— 第 119 轮的门禁只查 git 跟踪的 `tools/**`，正好漏在这。
 * 但"全扫 1000+ 个"又会把门禁拖到几分钟（第一版就是这么超时的）。
 * 所以按**修改时间**划范围：**最近 24 小时内动过的一次性脚本必须语法正确**（通常只有几个～几十个，秒级）。
 * 更早的按不支持（`--scratch` 全扫但只提示，`--strict-scratch` 全扫且要拦）。
 */
const FRESH_HOURS = Number((process.argv.find((a) => a.startsWith("--fresh-hours=")) ?? "--fresh-hours=24").split("=")[1]);
const cutoff = Date.now() - FRESH_HOURS * 3600 * 1000;
const fresh = scratch.filter((f) => {
  try {
    return fs.statSync(path.join(ROOT, f)).mtimeMs >= cutoff;
  } catch {
    return false;
  }
});
const freshBad = [];
for (const f of fresh) {
  const err = check(f);
  if (err) freshBad.push({ file: f, err });
}
console.log(`\n（最近 ${FRESH_HOURS} 小时动过的一次性脚本 ${fresh.length} 个：${freshBad.length === 0 ? "全部解析通过 ✅" : `${freshBad.length} 个语法错 ❌`}；一次性脚本共 ${scratch.length} 个，全扫加 --scratch，全扫且要拦加 --strict-scratch）`);
for (const f of freshBad) console.log(`   ${f.file}\n      ${f.err}`);

if (scanAll) {
  for (const f of scratch) {
    const err = check(f);
    if (err) scratchBad.push({ file: f, err });
  }
  console.log(`（全量扫：${scratch.length} 个里有 ${scratchBad.length} 个语法错）`);
  for (const f of scratchBad) console.log(`   ${f.file}\n      ${f.err}`);
}

if (failures.length || freshBad.length || (strictScratch && scratchBad.length)) {
  console.log("\n（「脚本没跑成」和「脚本跑出 0 条」长得一样 —— 所以能跑必须是判据）");
  process.exit(1);
}
console.log("✅ 语法门禁通过");
