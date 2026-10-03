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
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * ⚠️ 顶层用 `import.meta.url` 算路径时**必须兜住 vitest**（第 124 波踩到）。
 *
 * 在 vitest 里 `import.meta.url` **不是 `file://` URL**（是虚拟 URL）⇒
 * `fileURLToPath` 直接抛 `ERR_INVALID_URL_SCHEME`，而这是**模块顶层**代码
 * ⇒ 整个 import 失败、vitest 报 **"no tests"**（看起来像"这个文件没有测试" ✗，
 * 实际是"导入即抛" ✗）。判据要能 import 这个模块，就必须让路径解析容错。
 */
const HERE = (() => {
  try {
    return fileURLToPath(new URL(".", import.meta.url));
  } catch {
    // 兜底：按"脚本就在 tools/audit/ 下"这个事实推（只有测试环境会走到这里）
    return join(process.cwd(), "tools", "audit");
  }
})();
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

  // ✅ 已迁完（第 104 波）：`src/core/provider/dynamic-runner-provider.ts`（动态 Cordis 插件）——
  //    改成**沙箱会话**（`src-tauri/src/js_sandbox_session.rs`）：持久环境 + 宿主回调 guest 函数，
  //    `ctx.provide('svc', { hello: () => 'world' })` 交出去的函数可以从宿主侧调用回来。
  //    原先这里是两处 `new Function('ctx', …)`，把**活的 Cordis ctx** 交给插件代码。
  // ✅ 已删：`src/core/provider/code-runtime-worker-thread-provider.ts` 里的 Node worker 形态
  //    （`worker_threads` 在 Tauri WebView 里不存在）；现在它走 Rust 沙箱（`methods: []`），
  //    预检 `validateCode` 留在 `src/core/provider/validate-dynamic-code.ts`。
};

/** 扫描目标：只扫产品源码，不扫测试（测试跑在 Node 里，不受 CSP 约束） */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

/**
 * 命中模式（第 124 波补全）。
 *
 * ⚠️ 原来只有 `new Function(`，而**调用形式 `Function("…")` 同样是 eval 等价物**
 * （CSP 里它也归 `unsafe-eval` 管）—— 文件头注释写着"`Function(` 直接构造"，
 * 但模式表里没有它：**注释与实现不一致，而门禁只会照实现办事** ✗。
 * 同类漏网还有**字符串形式的定时器**（`setTimeout("code")`）—— 在 CSP 下同样不可用。
 *
 * 误报控制：`\b` 保证 `isFunction(` / `toFunction(` 这类**前缀不是单词边界**的写法不会被误伤
 * （`s` 与 `F` 之间没有边界）；`new Function(` 用负向后行断言排除，避免与第一条重复计数。
 */
const PATTERNS = [
  { re: /\bnew\s+Function\s*\(/g, label: "new Function(" },
  { re: /(?<![\w$.])Function\s*\(/g, label: "Function( 构造（非 new）" },
  { re: /\beval\s*\(/g, label: "eval(" },
  { re: /\bwindow\s*\.\s*eval\s*\(/g, label: "window.eval(" },
  { re: /\bglobalThis\s*\.\s*eval\s*\(/g, label: "globalThis.eval(" },
  { re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g, label: "字符串形式的定时器（等同 eval）" },
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

/**
 * **纯函数：扫一段源码里有哪些 eval 等价物**（第 124 波抽出，便于判据钉住）。
 *
 * 抽出来的理由很直接：门禁"能不能抓住某种写法"是它**唯一**的职责，
 * 而这件事以前只能靠"跑一遍看有没有命中"来间接验证 ✗（仓库里没有那种写法时，
 * 门禁再松也显示"0 命中" —— 判据与实现都绿，缺口却一直在）。
 *
 * @param source 源码文本
 * @returns `[{ label, count }]`（去掉注释与字符串之后再匹配）
 */
export function findEvalUses(source) {
  const code = stripCommentsAndStrings(String(source));
  const found = [];
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    const matches = code.match(re);
    if (matches) found.push({ label, count: matches.length });
  }
  return found;
}

const hits = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  /**
   * 测试与测试替身不受 CSP 影响，本门禁不管它们。
   *
   * ⚠️ 判据要按**目录**排，不能只按文件名：第一版只跳过 `*.test.ts`，
   * 于是 `src/test/helpers/script-runner-double.ts`（一个**刻意的**测试替身，
   * 用 `new Function` 忠实执行 guest 代码）被误报成违规。
   * 生产代码不许用 eval，测试替身可以 —— 这条边界按目录划才准。
   */
  if (/(^|\/)(test|tests|__tests__)\//.test(rel)) continue;
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(rel)) continue;
  for (const { label, count } of findEvalUses(readFileSync(file, "utf8"))) {
    hits.push({ rel, label, count });
  }
}

/**
 * **只有被当作脚本执行时才跑扫描**（第 124 波补的守卫）。
 *
 * 为什么需要：门禁的"能不能抓住某种写法"要用判据钉住（`src/test/no-eval-gate-strictness.test.ts`
 * 会 `import { findEvalUses }`）。而原来的实现是**顶层直接扫描并 process.exit** ——
 * 被 import 时会把测试进程一起带走（vitest 报 "no tests"，看起来像"没有测试" ✗ 而不是"导入即退出"）。
 */
/**
 * ⚠️ 这里的判断被两件事先后咬过，两次都值得记：
 *
 * ① 第一版用字符串拼 `file://${process.argv[1]}` —— **在 Windows 上不成立**
 *    ⇒ 直接跑 `node tools/audit/no-eval.mjs` 时**什么都不输出**（门禁哑了 ✗✗）。
 *    正确做法是用 `pathToFileURL()` 规范化。
 * ② 但在 vitest 里 `process.argv[1]` **不是文件路径**（是虚拟路径）⇒ `pathToFileURL` 会抛
 *    `The URL must be of scheme file`，而没兜住的异常会让 import 失败、
 *    vitest 报 **"no tests"**（看起来像"没有测试"，其实是"导入即抛" ✗）。
 *
 * 所以：规范化 + 兜异常，缺一不可。
 */
const isDirectRun = (() => {
  try {
    return process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
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
}
