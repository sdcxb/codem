/**
 * 动态代码的**正则预检**（从已删除的 `code-runtime-worker-thread-provider.ts` 抽出来）。
 *
 * ## 它是什么，不是什么
 *
 * 这是一层**便宜的预检**：在把用户/模型给的代码送进 JS 引擎之前，先按模式拦掉明显危险的东西
 * （`require('child_process')`、`process.exit`、`eval(` ……）。
 *
 * ⚠️ **它不是安全边界**：正则挡不住编码/拼接/别名（`globalThis["ev"+"al"]`）。
 * 真正的边界是**执行环境** —— `src/core/js/js-vm.ts` 的 QuickJS/WASM：
 * 那里 `require` / `process` / `window` 根本不存在（判据 `js-vm-no-eval.test.ts` 的 JSVM-3）。
 * 所以这层预检的价值是"**早失败 + 给一句人话**"，不是"拦住攻击"。
 *
 * ## 为什么单独一个文件
 *
 * 原来它住在 `code-runtime-worker-thread-provider.ts` 里，而那个 provider 是
 * **Node 专用的死代码**（`worker_threads` 在 Tauri WebView 里根本不存在，没有任何产品代码引用它），
 * 却把 `new Function(...)` 藏在 worker 脚本文本里。第 103 波把它删了，预检留下继续给
 * `dynamic-runner-provider` 用。
 */

/** 危险模式表（`code` 进引擎前先过一遍） */
const DANGEROUS_CODE_PATTERNS: Array<{ pattern: RegExp; msg: string }> = [
  { pattern: /require\s*\(\s*['"]child_process['"]\)/, msg: "child_process not allowed" },
  { pattern: /require\s*\(\s*['"]fs['"]\)/, msg: "fs not allowed — use ctx.fs" },
  { pattern: /require\s*\(\s*['"]net['"]\)/, msg: "net not allowed" },
  { pattern: /require\s*\(\s*['"]http['"]\)/, msg: "http not allowed — use ctx.webFetch" },
  { pattern: /require\s*\(\s*['"]https['"]\)/, msg: "https not allowed — use ctx.webFetch" },
  { pattern: /require\s*\(\s*['"]dns['"]\)/, msg: "dns not allowed" },
  { pattern: /require\s*\(\s*['"]os['"]\)/, msg: "os not allowed" },
  { pattern: /require\s*\(\s*['"]cluster['"]\)/, msg: "cluster not allowed" },
  { pattern: /process\s*\.\s*exit/, msg: "process.exit not allowed" },
  { pattern: /(^|[^.\w])eval\s*\(/, msg: "eval() not allowed" },
];

/** 过一遍危险模式；返回第一条命中的原因（没有命中就是 ok） */
export function validateCode(code: string): { ok: boolean; error?: string } {
  for (const { pattern, msg } of DANGEROUS_CODE_PATTERNS) {
    if (pattern.test(code)) return { ok: false, error: `Security violation: ${msg}` };
  }
  return { ok: true };
}
