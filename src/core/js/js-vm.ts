/**
 * **不经 eval 的 JS 运行时**：QuickJS 编译成 WebAssembly，跑在应用自己的 JS 上下文里。
 *
 * ## 为什么需要它（不是"更安全的写法"，而是"唯一能跑的写法"）
 *
 * 装好的应用里 CSP **没有 `unsafe-eval`**（`tauri.conf.json`；`phase-b-f-regression.test.ts`
 * 专门断言它含的是 `wasm-unsafe-eval`）。于是所有 `new Function` / `eval` 在真机上**直接抛 CSP 违规**：
 * 实测 `run_code`（第 99 波）与 `workflow`（第 101 波）都是
 * `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`。
 * 而 `wasm-unsafe-eval` **是**允许的 —— 所以"把 JS 引擎编成 WASM 在页面里跑"这条路走得通：
 * 不需要放开 CSP，也不需要另起进程。
 *
 * ## 这个封装踩过的坑（都写在对应位置，别再踩）
 *
 * 1. **`vm.destroy` 在 0.32 里不存在** —— 每个 handle 都要自己 `.dispose()`；
 *    漏一个，`runtime.dispose()` 就会触发 QuickJS 的
 *    `Assertion failed: list_empty(&rt->gc_obj_list)`（这是它在告诉你"你泄漏了"）。
 * 2. **asyncify 模块里的 `evalCode` 不能直接用** —— 会抛
 *    `Function unexpectedly returned a Promise`；必须用 **`evalCodeAsync`**。
 * 3. **guest 的 Promise 不会自己结算** —— 必须宿主轮询 `rt.executePendingJobs()`
 *    （实测 P1/P2 都会 8 秒超时，P5 加了泵就立刻拿到值）。
 * 4. **asyncified 宿主函数是"guest 侧同步"的** —— 里面必须返回 **handle**（不是普通对象），
 *    普通对象会走错误路径并留下 `QuickJSUseAfterFree`。
 * 5. **超时要能真正打断** —— 用 `rt.setInterruptHandler`，否则 `while(true){}` 会把 WebView 卡死
 *    （只 `Promise.race` 是放弃等待，不是停下它）。
 * 6. **模块可以复用，但被打断过的模块要丢弃** —— 复用一个模块快得多（不用每次实例化 WASM），
 *    但 `while(true){}` 被中断后模块状态不干净（实测进程退出时会 abort），所以那条路要换新模块。
 *
 * ## 顺带得到的东西：真正的隔离
 *
 * guest 里**没有** `window` / `document` / `process` / `require` / `fetch`（实测 `typeof` 全是 `undefined`）
 * —— 这比 `new Function`（与外层同一份全局对象）强得多：模型写的脚本再也摸不到应用内部。
 * 它能用的只有宿主**显式注入**的那些函数。
 */
import { newQuickJSWASMModule } from "quickjs-emscripten";

/** 宿主函数：收**一个** JSON 参数（参数数组），返回可 JSON 化的值；抛错会被带回 guest */
export type JsVmHostFunction = (args: unknown[]) => unknown | Promise<unknown>;

export interface JsVmOptions {
  /** 用户/模型提供的代码（会被包进 async IIFE；`run_code` 与 `workflow` 共用） */
  code: string;
  /** 暴露给 guest 的宿主函数（guest 侧通过 `__hostCall(name, argsJson)` 调用） */
  hostFunctions?: Record<string, JsVmHostFunction>;
  /** 预置代码：把 `__hostCall` 包成 `sdk` / `ctx` 之类的形状（各调用方自己写） */
  prelude?: string;
  /** 超时（默认 30s）。到点用 `setInterruptHandler` **真正打断**执行 */
  timeoutMs?: number;
  /** guest 的内存上限（默认 64MB） */
  memoryLimitBytes?: number;
  /**
   * 一次执行里允许的宿主调用次数上限（默认 **1** —— 见文件头「已知限制」）。
   *
   * 为什么要有这个闸门：asyncify 引擎在第 2 次挂起就会出现 WASM 级损坏，而且损坏是
   * **进程级**的（之后所有执行都失败）。所以必须在 **guest 侧、挂起之前**就拒绝第 2 次调用：
   * 拒绝发生在纯 JS 里（一个被拒绝的 Promise），不会碰 asyncify。
   * Rust 侧引擎（boa）落地后这个上限会取消（那时宿主调用是阻塞的，没有挂起）。
   */
  maxHostCalls?: number;
}

export interface JsVmError {
  name?: string;
  message: string;
  stack?: string;
}

export interface JsVmOutcome {
  /** 没抛错、没超时 */
  ok: boolean;
  /** 代码的返回值（完成值）*/
  value?: unknown;
  error?: JsVmError;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

/** 模块复用（实例化 WASM 不便宜）；出 WASM 级错误就丢弃，下次新建 */
let cachedSyncModule: Promise<unknown> | null = null;
let syncModuleDirty = false;

async function takeSyncModule() {
  if (syncModuleDirty || !cachedSyncModule) {
    cachedSyncModule = newQuickJSWASMModule();
    syncModuleDirty = false;
  }
  return cachedSyncModule;
}

/** 测试用：把缓存的模块丢掉（也会让下一次调用重新实例化） */
export function __resetJsVmModuleCache() {
  cachedSyncModule = null;
  syncModuleDirty = false;
}

/**
 * ## 第 103 波：这个模块现在只服务**同步路径**（hooks）
 *
 * 异步路径（`runInJsVm`）已经**删除** —— 它曾经用来跑 `run_code` / `workflow`，
 * 但那个形状有个硬限制：asyncify 引擎一次执行只能挂起一次
 * （实测 1 次宿主调用 5/5 成功、2 次 0/5、3+ 次 0/5，而且损坏留在**进程**里）。
 * 现在 `run_code` / `workflow` 跑在 **Rust 侧 boa 引擎**（`src-tauri/src/js_sandbox.rs`，
 * 宿主调用阻塞、没有挂起上限），
 * 这里保留的同步路径**一次挂起都没有**（hooks 的 `ctx` 是 JSON 注入、不调宿主函数），
 * 因此不受那个限制影响，已被 `hook-function-vm.test.ts` 与 `js-vm-no-eval.test.ts`（同步用例）覆盖。
 *
 * 删掉异步路径而不是留着，是因为"留着但会崩"的东西迟早会被误用：
 * 它还会漏出未捕获的 rejection（在 WebView 里就是未捕获错误）。
 */

/** 从 guest 的错误 handle 里**读出人话**（`dump` 一个 Error 只会得到 `{}`） */
function readError(vm: any, handle: any): JsVmError {
  try {
    const messageHandle = vm.getProp(handle, "message");
    const stackHandle = vm.getProp(handle, "stack");
    const nameHandle = vm.getProp(handle, "name");
    const message = String(vm.dump(messageHandle) ?? "");
    const stack = String(vm.dump(stackHandle) ?? "");
    const name = String(vm.dump(nameHandle) ?? "");
    messageHandle.dispose();
    stackHandle.dispose();
    nameHandle.dispose();
    if (message) return { name: name || undefined, message, stack: stack || undefined };
  } catch {
    /* 不是 Error 对象，退回 dump */
  }
  try {
    const text = String(vm.dump(handle));
    // 对象 dump 出来是 "[object Object]" 之类 —— 至少给一句能看懂的
    return { message: text === "[object Object]" ? "guest 抛出的是一个普通对象（没有 message）" : text };
  } catch {
    return { message: "guest 抛出了一个无法读取的错误" };
  }
}

/**
 * 同步版本（**hooks** 用：入参出参都是纯数据，不需要 await 宿主函数）。
 *
 * 与异步版的区别：用 **非 asyncify** 模块（更快、更小），`evalCode` 直接返回完成值。
 * 宿主函数是同步的 —— 调用方必须自己保证"不要在这里面等异步"。
 */
export function runInJsVmSync(options: {
  code: string;
  hostFunctions?: Record<string, (args: unknown[]) => unknown>;
  prelude?: string;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  /** 把 guest 的完成值再处理一道（比如读 `module.exports`） */
  extract?: (vm: any, completion: any) => unknown;
}): JsVmOutcome {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 2_000;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let timedOut = false;

  // 同步路径必须**同步**拿到模块：这里用 require 风格的动态导入不可行，
  // 所以模块由调用方在初始化时预热（`await warmupJsVmSync()`），本函数只做同步执行。
  const QuickJS: any = syncModuleInstance;
  if (!QuickJS) {
    return {
      ok: false,
      error: { message: "同步 JS 运行时还没预热：调用方需要先 await warmupJsVmSync()" },
      stdout: "",
      stderr: "",
      timedOut: false,
      elapsedMs: 0,
    };
  }

  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(options.memoryLimitBytes ?? 16 * 1024 * 1024);
  rt.setInterruptHandler(() => {
    if (Date.now() - started > timeoutMs) {
      timedOut = true;
      return true;
    }
    return false;
  });
  const vm = rt.newContext();
  const disposeQuietly = (h: any) => {
    try {
      h?.dispose?.();
    } catch {
      /* ignore */
    }
  };

  try {
    const pushLog = (sink: string[]) => (handle: any) => {
      try {
        sink.push(vm.getString(handle));
      } catch {
        /* ignore */
      }
    };
    const logFn = vm.newFunction("__log", pushLog(stdout));
    const errFn = vm.newFunction("__err", pushLog(stderr));
    logFn.consume((fn: any) => vm.setProp(vm.global, "__log", fn));
    errFn.consume((fn: any) => vm.setProp(vm.global, "__err", fn));

    const hostFunctions = options.hostFunctions ?? {};
    const hostCall = vm.newFunction("__hostCall", (nameHandle: any, argsHandle: any) => {
      const name = vm.getString(nameHandle);
      const impl = hostFunctions[name];
      let args: unknown[] = [];
      try {
        args = JSON.parse(vm.getString(argsHandle) || "[]");
      } catch {
        args = [];
      }
      // 与异步版同一口径：错误当数据带回去，由 guest 侧 `__call` 抛（同步路径虽然不涉及 asyncify，
      // 但两条路的行为必须一致，否则 hooks 迁移后错误文案会长得不一样）
      try {
        if (!impl) return vm.newString(JSON.stringify({ __jsvmError: `宿主没有提供函数 ${name}` }));
        return vm.newString(JSON.stringify({ __jsvmValue: impl(args) ?? null }));
      } catch (error: any) {
        return vm.newString(JSON.stringify({ __jsvmError: String(error?.message ?? error).slice(0, 2000) }));
      }
    });
    hostCall.consume((fn: any) => vm.setProp(vm.global, "__hostCall", fn));

    const pre = vm.evalCode(`
      globalThis.console = { log: (...a) => __log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
                             error: (...a) => __err(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
      globalThis.__call = (name, args) => {
        const out = JSON.parse(__hostCall(name, JSON.stringify(args ?? [])));
        if (out && typeof out === "object" && "__jsvmError" in out) throw new Error(String(out.__jsvmError));
        return out ? out.__jsvmValue : null;
      };
      ${options.prelude ?? ""}
    `);
    if (pre.error) {
      const error = readError(vm, pre.error);
      disposeQuietly(pre.error);
      return { ok: false, error, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut: false, elapsedMs: Date.now() - started };
    }
    disposeQuietly(pre.value);

    const raw = vm.evalCode(`(() => {\n${options.code}\n})()`);
    if (raw.error) {
      const error = readError(vm, raw.error);
      disposeQuietly(raw.error);
      return { ok: false, error, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut, elapsedMs: Date.now() - started };
    }
    const completion = raw.value;
    let value: unknown;
    try {
      value = options.extract ? options.extract(vm, completion) : vm.dump(completion);
    } finally {
      disposeQuietly(completion);
    }
    return { ok: true, value, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut, elapsedMs: Date.now() - started };
  } catch (error: any) {
    return {
      ok: false,
      error: { message: String(error?.message ?? error).slice(0, 4000) },
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      timedOut,
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (timedOut) syncModuleDirty = false; // 同步路径同理：打断后模块仍可复用
    try {
      vm.dispose();
    } catch {
      syncModuleDirty = true;
    }
    try {
      rt.dispose();
    } catch {
      syncModuleDirty = true;
    }
  }
}

/** 同步运行时需要一个**同步可见**的模块实例，由这里预热 */
let syncModuleInstance: any = null;

/**
 * 预热同步运行时（`hook-manager` 在初始化时 await 一次）。
 *
 * 为什么必须预热：同步路径里拿不到 `await`（hook 函数本身是同步调用的），
 * 而 WASM 模块实例化是异步的 —— 所以模块必须在**第一次同步调用之前**就位。
 * 预热失败不抛：调用方会得到一句"还没预热"的可读错误（fail-closed，不是静默放行）。
 */
export async function warmupJsVmSync(): Promise<boolean> {
  try {
    const QuickJS: any = await takeSyncModule();
    if (syncModuleDirty || !syncModuleInstance) {
      syncModuleInstance = QuickJS;
      syncModuleDirty = false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 同步运行时是否已就绪（hook 侧据此决定 fail-closed 还是正常执行） */
export function isJsVmSyncReady(): boolean {
  return Boolean(syncModuleInstance) && !syncModuleDirty;
}
