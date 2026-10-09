/**
 * `code-runtime-worker-thread-provider` 的**行为判据**（第 191 波补：它此前只有"源码形状"判据，
 * 真实覆盖率 ≈ 7%，低于按文件地板 14% —— 既有缺口，本轮补上）。
 *
 * ## 它是什么
 *
 * 插件体系里注册的一个"受限代码运行时"（`provides: codeRuntimeWorkerThread`）。第 103 波把它从
 * Node `worker_threads` + `new Function` 迁到 **Rust 侧 boa 沙箱**（`js_run_sandboxed`）。
 *
 * ## 这组判据钉什么
 *
 * | 编号 | 钉什么 |
 * | --- | --- |
 * | CRP-1 | 危险代码先在**预检**被拦下（`validateCode`），**根本不发 IPC** —— 早失败 + 一句人话 |
 * | CRP-2 | 没有 Tauri 运行时 ⇒ 抛"代码运行时不可用"，而不是静默返回 undefined |
 * | CRP-3 | 正常路径：调 `js_run_sandboxed`，参数里 `methods: []` / `hostCallLimit: 0`（**不给 guest 任何工具**）、`loopLimit` = 声明预算 |
 * | CRP-4 | 返回值口径：完成值是 JSON 文本 ⇒ 解开成真值；不是 JSON ⇒ 原样返回；`null` ⇒ `undefined` |
 * | CRP-5 | 失败口径：`ok:false` 时把引擎给的**结构化错误**里的 message 提出来抛（拿不到 JSON 就原样抛） |
 * | CRP-6 | dispose：`_active` 置 false 并调用 `ctx.provide` 返回的释放函数（幂等语义由插件框架负责） |
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeRuntimeWorkerThreadProvider } from "../core/provider/code-runtime-worker-thread-provider";

type Impl = { _active: boolean; run(code: string, opts?: { timeout?: number }): Promise<unknown> };

/** 造一个假 ctx：捕获 provide 的实现 + 返回一个释放函数（与 cordis 的契约同形） */
function mount() {
  let impl: Impl | null = null;
  const dispose = vi.fn();
  const ctx = {
    provide: (name: string, value: Impl) => {
      expect(name).toBe("codeRuntimeWorkerThread");
      impl = value;
      return dispose;
    },
  };
  const compositeDispose = codeRuntimeWorkerThreadProvider(ctx as never) as () => void;
  return { get impl() { return impl as Impl | null; }, dispose, compositeDispose };
}

/** 装一个假 Tauri 运行时：记录 invoke 调用并按脚本回答 */
function installTauri(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return handler(command, args);
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI__;
  vi.restoreAllMocks();
});

describe("受限代码运行时（Rust 沙箱路径）的行为判据", () => {
  it("CRP-1: 危险代码在**预检**就被拦下，一个 IPC 都不发", async () => {
    const calls = installTauri(() => ({ ok: true, value: "1" }));
    const { impl } = mount();
    // 预检表（`validate-dynamic-code.ts`）只拦"模块/逃逸类"模式；纯 while(true) 由沙箱的
    // 循环上限兜住（那是**执行期**的边界，不是预检的职责）—— 所以这里用真正在表里的形态。
    await expect(impl!.run("require('child_process').execSync('whoami')")).rejects.toThrow(/Security violation/);
    await expect(impl!.run("eval('1+1')")).rejects.toThrow(/Security violation/);
    expect(calls.length, "预检失败 ⇒ 不许把代码送到沙箱").toBe(0);
  });

  it("CRP-2: 没有 Tauri 运行时 ⇒ 如实抛「代码运行时不可用」（不静默返回 undefined）", async () => {
    const { impl } = mount();
    await expect(impl!.run("1+1")).rejects.toThrow(/代码运行时不可用/);
  });

  it("CRP-3: 正常路径的参数口径 —— 没有任何工具方法、宿回调 0 次、循环上限 = 声明预算", async () => {
    const calls = installTauri(() => ({ ok: true, value: "42" }));
    const { impl } = mount();
    await expect(impl!.run("40+2")).resolves.toBe(42);
    expect(calls.length).toBe(1);
    expect(calls[0].command).toBe("js_run_sandboxed");
    expect(calls[0].args).toMatchObject({ code: "40+2", methods: [], hostCallLimit: 0 });
    expect(Number((calls[0].args as { loopLimit?: number }).loopLimit)).toBeGreaterThan(0);
  });

  it("CRP-4: 完成值口径 —— JSON 文本解开、非 JSON 原样、null ⇒ undefined", async () => {
    const { impl } = mount();
    installTauri(() => ({ ok: true, value: '{"a":1}' }));
    await expect(impl!.run("({a:1})")).resolves.toEqual({ a: 1 });

    installTauri(() => ({ ok: true, value: "纯文本结果" }));
    await expect(impl!.run("'纯文本结果'")).resolves.toBe("纯文本结果");

    installTauri(() => ({ ok: true, value: null }));
    await expect(impl!.run("undefined")).resolves.toBeUndefined();
  });

  it("CRP-5: 失败口径 —— 把引擎给的结构化错误里的 message 提出来抛（拿不到 JSON 就原样抛）", async () => {
    const { impl } = mount();
    installTauri(() => ({ ok: false, error: JSON.stringify({ message: "循环迭代超上限" }) }));
    await expect(impl!.run("1")).rejects.toThrow(/循环迭代超上限/);

    installTauri(() => ({ ok: false, error: "沙箱没起来" }));
    await expect(impl!.run("1")).rejects.toThrow(/沙箱没起来/);

    installTauri(() => ({ ok: false }));
    await expect(impl!.run("1")).rejects.toThrow(/未知错误/);
  });

  it("CRP-6: dispose ⇒ _active 置 false 且调用释放函数（组合释放是返回值）", () => {
    const { impl, dispose, compositeDispose } = mount();
    expect(impl!._active).toBe(true);
    compositeDispose();
    expect(impl!._active, "释放后不许再自称活跃").toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
