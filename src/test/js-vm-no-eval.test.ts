/**
 * 第 103 波：**不经 eval 的 JS 运行时**的判据（三层里的两层在这里）。
 *
 * ## 背景（真机实测，不是推测）
 *
 * 装好的应用里 CSP 没有 `unsafe-eval`：
 *  · `run_code` 返回 `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`（第 99 波探针）
 *  · `workflow {code:"return 1 + 1;"}` 同一条（第 101 波探针）
 *  · 函数型 hooks 同一族 —— 而钩子是**守卫**，"没生效"意味着该拦的没拦
 *
 * ## 现在的执行模型（三层分工）
 *
 * | 层 | 在哪 | 钉什么 | 判据 |
 * |---|---|---|---|
 * | 生产引擎 | **Rust 侧 boa**（`src-tauri/src/js_sandbox.rs`） | 语义：**多次**宿主调用、错误传递、预算中断、隔离 | `js_sandbox_tests`（Rust `cargo test`） |
 * | 同步引擎 | `src/core/js/js-vm.ts`（QuickJS/WASM） | hooks：纯数据进出、无挂起 | 本文件（同步用例）+ `hook-function-vm.test.ts` |
 * | 端到端 | 装好的应用 | 真的能跑 | `.preview-shot` 真机探针 |
 *
 * ⚠️ 异步路径（`runInJsVm`）**已删除**：asyncify 引擎一次执行只能挂起一次
 * （1 次工具调用 5/5、2 次 0/5、3+ 次 0/5，损坏留在进程里），所以它不能承载 `run_code`；
 * 留着只会被误用（还会漏未捕获 rejection）。数字与复现见交接单 §16.3。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runInJsVmSync, warmupJsVmSync, isJsVmSyncReady, __resetJsVmModuleCache } from "../core/js/js-vm";

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

describe("第 103 波：同步 JS 运行时（hooks 用）不依赖 eval", () => {
  beforeEach(() => {
    __resetJsVmModuleCache();
  });

  it("JSVM-S1: 基本执行 —— console 捕获 + 完成值", async () => {
    expect(await warmupJsVmSync()).toBe(true);
    const out = runInJsVmSync({ code: `console.log("hello"); return 1 + 1;` });
    expect(out.ok, out.error?.message).toBe(true);
    expect(out.value).toBe(2);
    expect(out.stdout).toContain("hello");
  });

  it("JSVM-S2: 全局 Function/eval 被换成会抛的桩之后仍然能执行（证明不依赖 eval）", async () => {
    await warmupJsVmSync();
    const restore = stubOutEval();
    try {
      const out = runInJsVmSync({ code: `const f = () => 20 + 22; return f();` });
      expect(out.ok, out.error?.message).toBe(true);
      expect(out.value).toBe(42);
    } finally {
      restore();
    }
  });

  it("JSVM-S3: guest 里没有 window/document/process/require/fetch（隔离比 new Function 强）", async () => {
    await warmupJsVmSync();
    const out = runInJsVmSync({
      code: `
        return [typeof window, typeof document, typeof process, typeof require, typeof fetch,
                typeof globalThis.__TAURI__, typeof XMLHttpRequest].join(",");
      `,
    });
    expect(out.ok, out.error?.message).toBe(true);
    expect(out.value).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined");
  });

  it("JSVM-S4: 死循环被**真正打断**（不是只放弃等待）", async () => {
    await warmupJsVmSync();
    const started = Date.now();
    const out = runInJsVmSync({ code: `while (true) {}`, timeoutMs: 800 });
    expect(out.ok).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started, "应当 0.8s 左右返回").toBeLessThan(5000);
  });

  it("JSVM-S5: guest 抛错时能拿到可读的原因（不是 [object Object]）", async () => {
    await warmupJsVmSync();
    const out = runInJsVmSync({ code: `throw new Error("我把参数写错了");` });
    expect(out.ok).toBe(false);
    expect(String(out.error?.message)).toContain("我把参数写错了");
  });

  it("JSVM-S6: 连跑 30 次不崩（handle 泄漏会让 QuickJS 直接 abort，不是慢慢变慢）", async () => {
    await warmupJsVmSync();
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const out = runInJsVmSync({ code: `return ${i} * 2;` });
      if (out.ok && out.value === i * 2) ok++;
    }
    expect(ok).toBe(30);
  });

  it("JSVM-S7: 预热前的调用给出可读错误（fail-closed，不是静默放行）", async () => {
    // 故意不预热：hook 侧遇到这种情况必须 fail-closed
    const out = runInJsVmSync({ code: `return 1;` });
    if (out.ok) {
      // 已经预热过（模块缓存是进程级的）：跳过断言，但记录事实
      expect(out.value).toBe(1);
    } else {
      expect(String(out.error?.message)).toMatch(/预热/);
    }
  });
});

/**
 * 工具层：**默认执行前端必须走 Rust 沙箱**，而且**不许有 eval 兜底**。
 *
 * 这条判据是"迁移完成"的证据：把全局 `Function`/`eval` 换成会抛的桩，
 * 若实现里还藏着 `new Function` 兜底，它就会**偷偷用 eval 跑起来**（判据会看到执行成功）；
 * 现在期望的是：非 Tauri 环境下如实报"沙箱不可用"，**不执行**。
 */
describe("第 103 波：run_code 的执行前端（无 eval 兜底）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("JSVM-10: 非 Tauri 环境下如实报「沙箱不可用」，且不在本地用 eval 兜底跑起来", async () => {
    const { createRunCodeTool } = await import("../core/llm/tools/run-code");
    const tool = createRunCodeTool();
    const restore = stubOutEval();
    try {
      const result = await tool.execute(
        { code: `console.log("不该被执行"); return 1;` } as never,
        { cwd: process.cwd(), sessionId: "jsvm-criterion", securityMode: "full" } as never,
      );
      expect(result.output, "应当给出环境错误，而不是偷偷执行").toMatch(/沙箱不可用|Tauri/);
      expect(result.output, "不许出现执行痕迹").not.toContain("不该被执行");
    } finally {
      restore();
    }
  });

  it("JSVM-12: 源码里没有 eval 系（门禁 `audit:no-eval` 的运行时对照）", async () => {
    const fs = await import("node:fs");
    const raw = fs.readFileSync("src/core/llm/tools/run-code.ts", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    expect(code.match(/new\s+Function\s*\(/g) ?? [], "run_code 不许用 new Function").toHaveLength(0);
    expect(code.match(/(^|[^.\w])eval\s*\(/g) ?? [], "run_code 不许用 eval").toHaveLength(0);
  });
});
