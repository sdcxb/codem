/**
 * TDZ-1：**不许动态导入 `core/llm` 的 barrel**（生产构建会白屏）。
 *
 * ## 现场（1.18.14 之后、2026-11-18 实测）
 *
 * 打包后的 `main-*.js` 启动即抛
 * `Uncaught ReferenceError: Cannot access 'v0' before initialization`，窗口全白。
 * `v0` 是 `AgenticLoop` 类。
 *
 * 机制：只要有**动态** `import("…/core/llm")`，Rollup 就必须为那个模块生成一个**急切求值**的
 * 命名空间对象：`Object.freeze({__proto__:null, AgenticLoop: v0, LLMEngine: mM, …})`。
 * 而 barrel 在一条环上：
 * `index → agentic-loop → tools → tools/read-attachment → store → core/store → index`。
 * 求值从环的另一侧进入时，对象字面量先读 `AgenticLoop`，那个 class 还在 TDZ ⇒ 崩。
 * dev 下不可见（ESM 逐模块、绑定后置初始化），所以这条只能在打包产物上暴露 —— 也正因如此必须有静态判据。
 *
 * ## 口径
 *
 * 动态取引擎请用 `core/llm/engine-access`（只再导出**函数声明**，字面量里没有 class 绑定）。
 * 本判据扫全仓（`src/` + `packages/`，排除测试）：任何动态 import 解析到
 * `src/core/llm/index.ts` 都报红，并给出改成 `engine-access` 的具体路径。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..");
const BARREL = "src/core/llm/index.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const toPosix = (p: string) => p.split(sep).join("/");

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = posix.dirname(toPosix(relative(ROOT, fromFile)));
  const target = posix.normalize(posix.join(base, spec));
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`]) {
    try {
      if (statSync(join(ROOT, candidate)).isFile()) return candidate;
    } catch {
      /* 不存在就继续试下一个后缀 */
    }
  }
  return null;
}

describe("TDZ-1：core/llm barrel 不许被动态导入", () => {
  it("全仓（src + packages，排除测试）零处动态导入 barrel", () => {
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "packages"))];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\(\s*(["'])([^"']+)\1\s*\)/g)) {
        const resolved = resolveSpecifier(file, match[2]);
        if (resolved === BARREL) {
          offenders.push(`${toPosix(relative(ROOT, file))} → import("${match[2]}")；请改成 import("…/llm/engine-access")`);
        }
      }
    }
    expect(offenders, `这些地方动态导入了 barrel（打包后会让应用白屏）：\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("门面存在、且只再导出函数（不 `export *`，否则又把 class 绑进字面量）", () => {
    const facade = readFileSync(join(ROOT, "src/core/llm/engine-access.ts"), "utf8");
    expect(facade).toContain('from "./index"');
    expect(facade, "门面里不许出现 export *（会把全部绑定塞进急切求值的命名空间对象）").not.toMatch(/^\s*export\s+\*\s+from/m);
    expect(facade).toMatch(/export\s*\{[^}]*getLLMEngine[^}]*\}/);
  });
});
