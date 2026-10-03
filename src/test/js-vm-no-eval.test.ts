/**
 * 第 103 波：**不经 eval 的 JS 运行时**（QuickJS/WASM）的判据。
 *
 * ## 背景（真机实测，不是推测）
 *
 * 装好的应用里 CSP 没有 `unsafe-eval`：
 *  · `run_code` 返回 `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`（第 99 波探针）
 *  · `workflow {code:"return 1 + 1;"}` 同一条（第 101 波探针）
 * 而 `wasm-unsafe-eval` **是**允许的（`phase-b-f-regression.test.ts` 还专门断言它存在）——
 * 所以把 JS 引擎编成 WASM 在页面里跑，是"不放开 CSP 也能执行脚本"的路。
 *
 * ## 这批判据要钉住什么
 *
 * 1. **不许依赖 eval**（`JSVM-2`/`JSVM-7`：把全局 `Function`/`eval` 换成会抛的桩，仍然必须能跑）——
 *    这是**本波的核心判据**：它同时是"迁移到 VM"的证明与"再退回 new Function 就红"的变异陷阱。
 * 2. 语义与旧实现一致（console 捕获、完成值、超时、错误可读）；
 * 3. **隔离真的变强了**（guest 摸不到 `window`/`process`/`require`/`fetch`）—— 这是顺带拿到的收益；
 * 4. 不出血（连跑多次不崩：handle 泄漏会让 QuickJS 直接 abort）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runInJsVm, runInJsVmSync, warmupJsVmSync, isJsVmSyncReady, __resetJsVmModuleCache } from "../core/js/js-vm";

/** 把 `Function` / `eval` 换成"一用就抛"的桩 —— 用来证明代码路径**没有**依赖它们 */
function stubOutEval() {
  const originalFunction = globalThis.Function;
  const originalEval = globalThis.eval;
  const boom = () => {
    throw new Error("CSP: 'unsafe-eval' is not allowed —— 你还在用 eval 系");
  };
  // @ts-expect-error 故意替换
  globalThis.Function = function BlockedFunction() {
    boom();
  };
  // @ts-expect-error 故意替换
  globalThis.eval = boom;
  return () => {
    globalThis.Function = originalFunction;
    globalThis.eval = originalEval;
  };
}

describe("第 103 波：不经 eval 的 JS 运行时", () => {
  beforeEach(() => {
    __resetJsVmModuleCache();
  });

  it("JSVM-1: 基础执行 —— console 捕获 + 完成值", async () => {
    const out = await runInJsVm({
      code: `console.log("hello"); return 1 + 1;`,
    });
    expect(out.ok, out.error?.message).toBe(true);
    expect(out.stdout).toContain("hello");
    expect(out.value).toBe(2);
  });

  /**
   * **核心判据**：本波要证明的就是"执行不再经过 eval"。
   * 把全局 `Function`/`eval` 换成会抛的桩之后仍然跑通 ⇒ 说明执行走的是 WASM 里的引擎。
   * 变异：把 `runInJsVm` 改回 `new Function(...)` ⇒ 这条立刻红。
   */
  it("JSVM-2: 全局 Function/eval 被换成会抛的桩之后仍然能执行（证明不依赖 eval）", async () => {
    const restore = stubOutEval();
    try {
      const out = await runInJsVm({
        code: `const f = () => 20 + 22; return f();`,
      });
      expect(out.ok, out.error?.message).toBe(true);
      expect(out.value).toBe(42);
    } finally {
      restore();
    }
  });

  it("JSVM-3: guest 里没有 window/document/process/require/fetch（隔离比 new Function 强）", async () => {
    const out = await runInJsVm({
      code: `
        return [typeof window, typeof document, typeof process, typeof require, typeof fetch,
                typeof globalThis.__TAURI__, typeof XMLHttpRequest].join(",");
      `,
    });
    expect(out.ok, out.error?.message).toBe(true);
    expect(out.value).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined");
  });

  it("JSVM-4: 宿主函数能被调用（含 await 形式），返回值与抛错都能带回 guest", async () => {
    const calls: unknown[][] = [];
    const out = await runInJsVm({
      code: `
        const a = await sdk.echo("hi");
        return [a];
      `,
      hostFunctions: {
        echo: (args) => {
          calls.push(args);
          return { got: args[0] };
        },
      },
      prelude: `
        globalThis.sdk = { echo: (...a) => __sdk("echo", a) };
      `,
    });

    expect(out.ok, out.error?.message).toBe(true);
    expect(out.value).toEqual([{ got: "hi" }]);
    expect(calls).toEqual([["hi"]]);
  });

  it("JSVM-4b: 宿主函数抛错 → guest 能 catch 到可读原因", async () => {
    const out = await runInJsVm({
      code: `
        let caught = "none";
        try { await sdk.bad(); } catch (e) { caught = String(e && e.message ? e.message : e); }
        return caught;
      `,
      hostFunctions: {
        bad: () => {
          throw new Error("宿主拒绝了这个调用");
        },
      },
      prelude: `globalThis.sdk = { bad: (...a) => __sdk("bad", a) };`,
    });
    expect(out.ok, out.error?.message).toBe(true);
    expect(out.value).toBe("宿主拒绝了这个调用");
  });

  /**
   * **已知限制的守卫**（第 103 波实测 + 处置）：
   * asyncify 引擎从第 2 次宿主挂起起就会损坏运行时，而且损坏是**进程级**的
   * （之后所有执行都失败，换新模块也救不回来）。
   *
   * 处置：**在 guest 侧、挂起之前**拒绝超限调用（默认上限 1 次）。
   * 所以这条判据钉三件事：
   *  ① 单次调用正常；
   *  ② 第 2 次调用拿到的是**可行动的**报错（不是裸 WASM 错误、不是超时）；
   *  ③ **运行时没被弄坏** —— 紧接着再跑一个单次调用脚本仍然成功。
   *
   * Rust 侧引擎（boa）落地后，这条要改成"任意次调用都成功"（见交接单 §16）。
   */
  it("JSVM-11: 超过已知上限的调用在**挂起之前**被拒，且运行时没被弄坏", async () => {
    const sdk = {
      hostFunctions: { c: (args: unknown[]) => ({ echo: args[0] }) },
      prelude: `globalThis.sdk = { c: (...a) => __sdk("c", a) };`,
    };

    const first = await runInJsVm({ code: `const a = await sdk.c("1"); return a.echo;`, ...sdk });
    expect(first.ok, first.error?.message).toBe(true);
    expect(first.value).toBe("1");

    const second = await runInJsVm({
      code: `
        const a = await sdk.c("1");
        let msg = "none";
        try { await sdk.c("2"); } catch (e) { msg = String((e && e.message) || e); }
        return [a.echo, msg];
      `,
      ...sdk,
    });
    expect(second.ok, second.error?.message).toBe(true);
    const [echoed, message] = second.value as [string, string];
    expect(echoed).toBe("1");
    expect(message, "要说明这是运行时的已知限制").toMatch(/已知限制/);
    expect(message, "要给出下一步动作").toMatch(/拆成多次|bash/);
    expect(message, "不许把裸 WASM 错误透给模型").not.toMatch(/memory access out of bounds|Assertion failed/);

    // ③ 关键：运行时还活着（如果守卫失效，这一步会崩或超时）
    const third = await runInJsVm({ code: `const a = await sdk.c("3"); return a.echo;`, ...sdk });
    expect(third.ok, third.error?.message).toBe(true);
    expect(third.value).toBe("3");
  });

  it("JSVM-5: 死循环被**真正打断**（不是只放弃等待）", async () => {
    const started = Date.now();
    const out = await runInJsVm({ code: `while (true) {}`, timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(elapsed, `应当 1.5s 左右返回，实际 ${elapsed}ms`).toBeLessThan(6000);
  });

  it("JSVM-6: guest 抛错时能拿到可读的原因（不是 [object Object]）", async () => {
    const out = await runInJsVm({ code: `throw new Error("我把参数写错了");` });
    expect(out.ok).toBe(false);
    expect(String(out.error?.message)).toContain("我把参数写错了");
  });

  it("JSVM-7: 连跑 20 次不崩（handle 泄漏会让 QuickJS 直接 abort，不是慢慢变慢）", async () => {
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const out = await runInJsVm({
        code: `const r = await sdk.n(${i}); return r;`,
        hostFunctions: { n: (args) => Number(args[0]) * 2 },
        prelude: `globalThis.sdk = { n: (...a) => __sdk("n", a) };`,
      });
      if (out.ok && out.value === i * 2) ok++;
    }
    expect(ok).toBe(20);
  });

  it("JSVM-8: 同步路径（hooks 用）—— 纯数据进出，同样不依赖 eval", async () => {
    const warmed = await warmupJsVmSync();
    expect(warmed, "同步运行时应当能预热").toBe(true);
    expect(isJsVmSyncReady()).toBe(true);

    const restore = stubOutEval();
    try {
      const out = runInJsVmSync({
        code: `return { action: ctx.blocked ? "deny" : "allow", denyMessage: "no: " + ctx.toolName };`,
        prelude: `globalThis.ctx = { blocked: true, toolName: "bash" };`,
      });
      expect(out.ok, out.error?.message).toBe(true);
      expect(out.value).toEqual({ action: "deny", denyMessage: "no: bash" });
    } finally {
      restore();
    }
  });

  it("JSVM-9: 同步路径的死循环也会被打断", async () => {
    await warmupJsVmSync();
    const started = Date.now();
    const out = runInJsVmSync({ code: `while (true) {}`, timeoutMs: 800 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

/**
 * 工具层判据：`run_code` 是用户看到的那一面 —— 必须在 `Function` 被桩掉的条件下仍然可用。
 * 这条把"迁移"钉在**工具边界**上（而不只是内部函数）。
 */
describe("第 103 波：run_code 工具在无 eval 环境下可用", () => {
  beforeEach(() => {
    __resetJsVmModuleCache();
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("JSVM-10: `createRunCodeTool().execute` 在全局 Function 被桩掉时仍能跑出结果", async () => {
    const { createRunCodeTool } = await import("../core/llm/tools/run-code");
    const tool = createRunCodeTool();
    const restore = stubOutEval();
    try {
      const result = await tool.execute(
        { code: `console.log("从 VM 里说话"); return [1,2,3].reduce((a,b) => a+b, 0);` } as never,
        { cwd: process.cwd(), sessionId: "jsvm-criterion", securityMode: "full" } as never,
      );
      expect(result.output).toContain("从 VM 里说话");
      expect(result.output).toContain("6");
      expect(result.output, "不该再出现 CSP 违规").not.toMatch(/unsafe-eval/);
    } finally {
      restore();
    }
  });
});
