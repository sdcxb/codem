/**
 * **测试替身：脚本执行前端**（第 103 波）。
 *
 * ## 它替的是谁
 *
 * 生产里 `run_code` / `workflow` 的脚本在 **Rust 侧 boa 引擎**里跑（`js_run_sandboxed`），
 * 宿主调用经事件回到 TS 的 sdk 实现。vitest 里没有 Tauri 运行时，所以那些
 * **闸门类判据**（危险命令拒绝 / 受保护路径 / 覆盖确认）需要一个替身来"把 guest 代码跑起来、
 * 把 sdk 方法调起来"。
 *
 * ## 为什么替身可以用 `new Function`
 *
 * 测试跑在 Node 里，**没有应用的 CSP**；而生产路径恰恰不能依赖 `new Function`
 * （CSP 不含 `unsafe-eval`，真机上直接抛违规）—— 这正是第 103 波要解决的问题。
 * 门禁 `npm run audit:no-eval` 只扫 `src/**` 的**非测试**文件，所以这里不违规，
 * 而且把一个"测试里能用、生产里不能用"的东西显式放在测试里，本身就是这条边界的记录。
 *
 * ## 三层分工（别把判据放错层）
 *
 * | 层 | 钉什么 |
 * |---|---|
 * | vitest（本替身） | **闸门在生产路径上生效**：sdk 方法被调用时，危险命令/受保护路径/覆盖确认都生效 |
 * | Rust `js_sandbox_tests` | **引擎语义**：多次宿主调用、错误传递、预算中断、隔离 |
 * | 真机探针 | **端到端**：脚本在装好的应用里真的跑起来 |
 */
import { __setScriptRunnerForTests, type ScriptRunner } from "../../core/llm/tools/run-code";

/** 用 Node 的 `new Function` 忠实执行 guest 代码，`sdk` 用**真实的**那一份 */
export const scriptRunnerDouble: ScriptRunner = async ({ code, sdk }) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const render = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
  const consoleProxy = {
    log: (...args: unknown[]) => void stdout.push(render(args)),
    info: (...args: unknown[]) => void stdout.push(render(args)),
    warn: (...args: unknown[]) => void stderr.push(render(args)),
    error: (...args: unknown[]) => void stderr.push(render(args)),
  };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("sdk", "console", `return (async () => { ${code} })();`);
    const value = await fn(sdk, consoleProxy);
    return {
      ok: true,
      value: JSON.stringify(value ?? null),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  }
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 在 `beforeEach` 里装、`afterEach` 里卸 */
export function installScriptRunnerDouble(): void {
  __setScriptRunnerForTests(scriptRunnerDouble);
}

export function uninstallScriptRunnerDouble(): void {
  __setScriptRunnerForTests(null);
}
