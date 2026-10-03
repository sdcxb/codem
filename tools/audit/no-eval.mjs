/**
 * 门禁：`src/` 里**不许再出现 `new Function` / `eval`**（第 103 波起逐步收口）。
 *
 * ## 为什么要有这条门禁
 *
 * 装好的应用里 CSP **没有 `unsafe-eval`**（`tauri.conf.json`，且
 * `phase-b-f-regression.test.ts` 专门断言它含的是 `wasm-unsafe-eval`）。
 * 于是任何走 `new Function` / `eval` 的功能在真机上**直接不可用** ——
 * 实测过两条：`run_code`（第 99 波）与 `workflow`（第 101 波），
 * 报错都是 `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`。
 *
 * 这类缺陷**在测试里看不出来**（vitest 跑在 Node 里，没有 CSP），
 * 所以必须有一条**独立于运行环境**的门禁：直接扫源码。
 *
 * ## 允许清单（逐步清空）
 *
 * 迁移期间允许列在这里，每条都要写"为什么还不能删"。
 * **迁移完成的定义 = 这个清单为空**（那时本门禁就是绝对禁止）。
 *
 * 用法：`node tools/audit/no-eval.mjs`（`npm run audit:no-eval`）
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC = join(ROOT, "src");

/**
 * 已知还在用 eval 系的地方（迁移进度表）。
 *
 * ⚠️ 每迁完一处就删掉一行；**这个对象空掉 = 目标达成**。
 */
const ALLOWLIST = {
  // ✅ 已迁完：`src/core/llm/tools/run-code.ts`（`run_code` + `workflow` 都走它）——
  //    现在跑在 `src/core/js/js-vm.ts` 的 QuickJS/WASM 里，判据 `src/test/js-vm-no-eval.test.ts`
  //    （JSVM-2 把全局 Function/eval 换成会抛的桩后仍要能跑；JSVM-10 钉工具层）。

  // ✅ 已迁完：`src/core/hooks/hook-manager.ts`（两处函数型钩子）——
  //    改为 `js-vm.ts` 的**同步路径**（`runInJsVmSync`）：`ctx` 以 JSON 注入、guest 看不到应用全局、
  //    并且补上了原来没有的**超时**（旧实现里钩子写 `while(true){}` 会把应用卡死）。

  "src/core/provider/dynamic-runner-provider.ts":
    "待迁移：两处 `new Function('ctx', …)` 编译 Cordis 动态插件 —— 它把**活的 Cordis ctx** 交给插件代码，" +
    "迁移要先把插件能用到的 ctx 面收敛成可序列化桥（宿主函数 + 服务代理），是最深的一处",
  // ✅ 已删：`src/core/provider/code-runtime-worker-thread-provider.ts`（Node 专用死代码：
  //    `worker_threads` 在 Tauri WebView 里不存在，没有任何产品代码引用它）。
  //    它的预检 `validateCode` 留在 `src/core/provider/validate-dynamic-code.ts`。
};

/** 扫描目标：只扫产品源码，不扫测试（测试跑在 Node 里，不受 CSP 约束） */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

/** 命中模式（`new Function(` / `Function(` 直接构造 / `eval(` / `window.eval`） */
const PATTERNS = [
  { re: /\bnew\s+Function\s*\(/g, label: "new Function(" },
  { re: /\beval\s*\(/g, label: "eval(" },
  { re: /\bwindow\s*\.\s*eval\s*\(/g, label: "window.eval(" },
  { re: /\bglobalThis\s*\.\s*eval\s*\(/g, label: "globalThis.eval(" },
];

/** 注释里提到这些词不算（这一波里到处都是"我们不再用 new Function"的注释） */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  // 测试文件不受 CSP 影响，本门禁不管它们
  if (/\.test\.(ts|tsx)$/.test(rel)) continue;
  const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    const matches = code.match(re);
    if (matches) hits.push({ rel, label, count: matches.length });
  }
}

const allowed = hits.filter((h) => ALLOWLIST[h.rel]);
const violations = hits.filter((h) => !ALLOWLIST[h.rel]);

console.log(`扫描 ${SRC}：命中 ${hits.length} 处（允许 ${allowed.length} 处）`);
for (const h of allowed) console.log(`  ⏳ 允许（待迁移）${h.rel}：${h.label}×${h.count} —— ${ALLOWLIST[h.rel]}`);

if (violations.length > 0) {
  console.log("\n❌ 这些地方的 `new Function` / `eval` **在装好的应用里跑不起来**（CSP 没有 unsafe-eval）：");
  for (const h of violations) console.log(`  ${h.rel}: ${h.label}×${h.count}`);
  console.log(
    "\n   要么迁到 `src/core/js/js-vm.ts`（QuickJS/WASM，不需要 eval），" +
      "要么在 ALLOWLIST 里写明理由（迁移期只允许「待迁移」这一种理由）。",
  );
  process.exit(1);
}

console.log(
  Object.keys(ALLOWLIST).length === 0
    ? "\n✅ 没有任何 `new Function` / `eval`（目标达成：这一族功能不再依赖 eval）"
    : `\n✅ 除允许清单外没有新增（还剩 ${Object.keys(ALLOWLIST).length} 个文件待迁移）`,
);
