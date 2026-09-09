/**
 * 浏览器环境的最小 `process` shim —— **必须在 main.tsx 第一个导入**。
 *
 * 为什么需要：
 * Vite 的**生产构建**会用 esbuild 的 browser 平台规则把源码里的
 *   `process.env.X`  → `({}).X`
 *   `process.cwd()`  → `"/"`
 *   `process.platform` → `"browser"`
 * 替换掉，所以生产包不会碰 `process`；但 **dev server 不做这些替换**，
 * 于是任何没写 `typeof process !== "undefined"` 保护的模块（例如
 * `src/core/zvec-grep/types.ts` 顶层的 `process.env.ZVEC_GREP_RELEASE_BASE`）
 * 在浏览器里会直接 `ReferenceError: process is not defined`，
 * 整个模块图求值失败 → 应用白屏（控制台报 types.ts:30）。
 *
 * 这里补一个与**生产构建替换结果语义一致**的 shim（env 空对象、cwd 为 "/"、
 * platform 为 "browser"），让 dev 和 build 行为一致，而不是给未保护代码塞假的环境变量。
 *
 * ⚠️ 只在 **dev** 生效（`import.meta.env.DEV`）：生产构建已经把 `process.*` 静态替换掉，
 * 不需要也不应该注入一个全局 `process`（有些依赖用 `typeof process !== "undefined"`
 * 判断是否跑在 Node 里，多一个全局会改变它们的分支）。
 *
 * 注意：不要在这里读取真实环境变量 —— 浏览器里本来就没有，生产构建也是空的。
 */

import.meta.env;

type MinimalProcess = {
  env: Record<string, string | undefined>;
  argv: string[];
  versions: Record<string, string>;
  platform: string;
  cwd: () => string;
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void;
};

// 用 unknown 承载，避免与 Node 的全局 `process: Process` 类型冲突
const g = globalThis as unknown as { process?: unknown };

if (import.meta.env.DEV && typeof g.process === "undefined") {
  const shim: MinimalProcess = {
    env: {},
    argv: [],
    versions: {},
    platform: "browser",
    cwd: () => "/",
    nextTick: (fn, ...args) => {
      setTimeout(() => fn(...args), 0);
    },
  };
  g.process = shim;
}

export {};
