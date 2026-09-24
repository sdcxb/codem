/**
 * 「**问不到被当成否定**」扫描（第 87 轮，承接第 86 轮修的那个洞）
 *
 * ## 要抓的形态
 *
 * 函数名像"检查"（`has*` / `is*` / `can*` / `should*` / `check*` / `verify*` / `needs*` / `allow*`），
 * 而它的 `catch` 里 `return false` / `null` / `[]` / `""` / `0` ——
 * 也就是**检查失败被汇报成"否"**。这本身不一定是 bug（要看调用方怎么用），
 * 但如果调用方把"否"当成"可以直接继续"，那就是**静默放行**：
 * 第 86 轮修的就是这种（`hasUncommittedChanges` 失败 ⇒ false ⇒ 防丢改动提醒不出现）。
 *
 * ## 判定与边界（如实写）
 *
 * - 它是**线索工具**，不是合规判定：只做"函数体内 catch 里返回了某个值"的文本/结构匹配；
 * - 会**漏报**：`catch` 在辅助函数里、返回值来自变量、或用了 `?? false` 之类的写法；
 * - 会**多报**：很多 `is*` 失败返回 false 是**正确**的（例如 `isGitRepo` 失败 ⇒ "这个目录不算 Git 仓库"，
 *   后果是"不提供某功能"，不是"放行"）。所以输出里带**调用点**，由人判。
 *
 * 用法：
 *   node tools/audit/scan-fail-open-guards.mjs                 # 列清单
 *   node tools/audit/scan-fail-open-guards.mjs --json
 *   node tools/audit/scan-fail-open-guards.mjs --check         # 闸门：与白名单逐个对齐（新增⇒失败、白名单过期⇒失败）
 *   node tools/audit/scan-fail-open-guards.mjs --root <dir>    # 扫别的树（自证用）
 *
 * ## 为什么它是闸门而不是列表
 *
 * 第 87 轮把这 14 处**逐个定性**后写进 `fail-open-guard-allowlist.json`（只许删、不许新增）。
 * 于是「又来一处 fail-open」不会静默溜过去：要么修它，要么写清为什么无害。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = path.resolve(argOf("--root") ?? process.cwd());
const ALLOWLIST = path.resolve(argOf("--allowlist") ?? path.join(HERE, "fail-open-guard-allowlist.json"));
const GUARD_NAME = /\b(has|is|can|should|check|verify|needs|allow|guard|validate)[A-Z_]/;
/** catch 里直接返回"否定值" */
const CATCH_RETURN = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]{0,400}?)\}/g;
const NEGATIVE_RETURN = /return\s+(false|null|\[\]|""|''|0)\s*;/;

function prodSources() {
  const out = [];
  const stack = ["src"];
  while (stack.length) {
    const dir = stack.pop();
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "src/test" || e.name === "node_modules") continue;
        if (rel === "src/core/skills/skill-creator/scripts") continue;
        stack.push(rel);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
  }
  return out.sort();
}

const findings = [];
for (const rel of prodSources()) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  // 逐个函数体（用 `export ... function NAME(` / `function NAME(` 定位，截到下一个同级 function）
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = fnRe.exec(code))) {
    const name = m[1];
    if (!GUARD_NAME.test(name)) continue;
    const start = m.index;
    const next = fnRe.exec(code);
    const bodyEnd = next ? next.index : code.length;
    fnRe.lastIndex = next ? next.index : code.length; // 依次推进
    const body = code.slice(start, bodyEnd);
    const line = code.slice(0, start).split(/\r?\n/).length;
    for (const c of body.matchAll(CATCH_RETURN)) {
      const hit = NEGATIVE_RETURN.exec(c[1]);
      if (!hit) continue;
      findings.push({ rel, line, name, returns: hit[1], snippet: c[0].replace(/\s+/g, " ").slice(0, 90) });
      break;
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 1));
} else if (process.argv.includes("--check")) {
  const allow = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8"));
  const allowed = new Set(allow.allowed.map((a) => a.site));
  const seen = new Set();
  const unexpected = [];
  for (const f of findings) {
    const site = `${f.rel}::${f.name}`;
    if (allowed.has(site)) { seen.add(site); continue; }
    if (seen.has(site)) continue;
    unexpected.push(f);
  }
  const stale = allow.allowed.filter((a) => !seen.has(a.site)).map((a) => a.site);
  if (unexpected.length || stale.length) {
    for (const f of unexpected) {
      console.error(`🔴 新的「检查失败 ⇒ 返回否定值」未定性：${f.rel}:${f.line}  ${f.name}  catch → return ${f.returns}`);
    }
    for (const s of stale) console.error(`🔴 白名单过期（代码里已不存在）：${s}`);
    console.error("处置：安全开关类 ⇒ 去修（参考 docs/GAP-LIST.md C-18 沙箱开关）；确实无害 ⇒ 加进 fail-open-guard-allowlist.json 并写清理由。");
    process.exit(1);
  }
  console.log(`fail-open 闸门通过：${findings.length} 处，全部已在白名单里定性（新增 0、过期 0）`);
} else {
  console.log(`「检查失败 ⇒ 返回否定值」的函数：${findings.length} 处（**线索，不是结论**：很多 is* 返回 false 是正确的）`);
  for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.name}  catch → return ${f.returns}`);
}
