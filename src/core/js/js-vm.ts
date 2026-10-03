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
import { newQuickJSAsyncWASMModule, newQuickJSWASMModule } from "quickjs-emscripten";

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

/** 缓存一个模块（实例化 WASM 不便宜）；**一出 WASM 级错误就丢弃**，下次新建 */
let cachedAsyncModule: Promise<unknown> | null = null;
let cachedSyncModule: Promise<unknown> | null = null;
let asyncModuleDirty = false;
let syncModuleDirty = false;

async function takeAsyncModule() {
  if (asyncModuleDirty || !cachedAsyncModule) {
    cachedAsyncModule = newQuickJSAsyncWASMModule();
    asyncModuleDirty = false;
  }
  return cachedAsyncModule;
}

async function takeSyncModule() {
  if (syncModuleDirty || !cachedSyncModule) {
    cachedSyncModule = newQuickJSWASMModule();
    syncModuleDirty = false;
  }
  return cachedSyncModule;
}

/** 测试用：把缓存的模块丢掉（也会让下一次调用重新实例化） */
export function __resetJsVmModuleCache() {
  cachedAsyncModule = null;
  cachedSyncModule = null;
  asyncModuleDirty = false;
  syncModuleDirty = false;
}

/** WASM 级错误（模块坏了，不是"这次调用失败"）—— 遇到就丢弃缓存模块 */
const WASM_LEVEL_ERROR_RE = /memory access out of bounds|null function|Assertion failed|Aborted\(|unreachable/i;

/**
 * 把 WASM 级错误翻译成**用户/模型能看懂并据此行动**的一句话。
 *
 * 不翻译的话，模型看到的是 `memory access out of bounds` —— 它既不知道这是引擎问题，
 * 也不知道该怎么办（本仓的纪律：错误要么可行动，要么明确说"这是我的内部问题，别重试"）。
 */
function describeRuntimeError(rawMessage: string): { message: string; wasmLevel: boolean } {
  if (!WASM_LEVEL_ERROR_RE.test(rawMessage)) return { message: rawMessage, wasmLevel: false };
  return {
    wasmLevel: true,
    message:
      `JS 运行时内部错误（不是你的代码写法问题）：${rawMessage.slice(0, 160)}。` +
      `已知限制：这个引擎一次执行里**超过 2 次工具调用**会触发它 —— ` +
      `请把脚本拆成多次调用，或改用 bash / 其它工具直接完成这一步。`,
  };
}

/**
 * ## ⚠️ 已知限制（第 103 波实测，**待 Rust 运行时替代**）
 *
 * 这个引擎（quickjs-emscripten 的 **asyncify** 构建）在"宿主函数"这件事上**不可靠**：
 * 一次执行里的第 3 次宿主调用起就崩，而且损坏会**跨执行、跨模块**地留在进程里。
 *
 * 实测（`npx tsx .preview-shot/_probe-jsvm-call-count.mjs`，每格 10 次**独立进程**）：
 *
 * | 一次执行里的宿主调用数 | 成功 |
 * |---|---|
 * | 1 | **10/10** |
 * | 2（含"中途失败并 catch"） | **10/10** |
 * | 3 | **0/10**（`memory access out of bounds`） |
 * | 4 | **0/10** |
 *
 * 更麻烦的是同进程多次执行：同一进程里第二次跑"2 次宿主调用"的脚本也会 abort
 * （`Assertion failed: p->ref_count == 0 … free_zero_refcount`）——
 * 也就是说这不是"换个新模块就好"的问题，而是 asyncify 的挂起状态在**进程级**没被清干净。
 *
 * ### 影响与对策
 *
 * · `run_code` / `workflow` 的常见用法就是**连续调用多个工具** ⇒ **不能只靠这个引擎**；
 * · 下一步：异步路径搬到 **Rust 侧引擎（`boa_engine`）** —— 那里宿主调用是**阻塞**的
 *   （Rust 可以等 Tauri IPC 的回复），没有 asyncify 挂起，因此没有这个上限；
 * · **同步路径不受影响**：它一次挂起都没有（hooks 的 `ctx` 是 JSON 注入、不调宿主函数），
 *   已经在 `hook-function-vm.test.ts` 与 `js-vm-no-eval.test.ts`（JSVM-8/9）里稳定跑通。
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
 * 跑一段 guest 代码（异步路径：`run_code` / `workflow`）。
 *
 * 语义与旧的 `new Function` 版本保持一致：
 *  · 代码包在 async IIFE 里，可以用 `await`；
 *  · `console.log/error/warn/info` 被捕获成 stdout/stderr；
 *  · 完成值作为 `value` 返回（旧版本渲染成 `[Result]: …`）；
 *  · 超时抛 `执行超时`。
 */
export async function runInJsVm(options: JsVmOptions): Promise<JsVmOutcome> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let timedOut = false;

  const QuickJS: any = await takeAsyncModule();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(options.memoryLimitBytes ?? 64 * 1024 * 1024);
  rt.setInterruptHandler(() => {
    if (Date.now() - started > timeoutMs) {
      timedOut = true;
      return true;
    }
    return false;
  });
  const vm = rt.newContext();

  const disposeQuietly = (handle: any) => {
    try {
      handle?.dispose?.();
    } catch {
      /* 已经释放过就算了 */
    }
  };

  try {
    // ---- console 捕获（同步宿主函数：挂起期间被回调也不能再挂起，所以只 push 字符串） ----
    const pushLog = (sink: string[]) => (handle: any) => {
      try {
        const text = vm.getString(handle);
        sink.push(text);
      } catch (error: any) {
        sink.push(`[console 取值失败] ${error?.message ?? error}`);
      }
    };
    const logFn = vm.newFunction("__log", pushLog(stdout));
    const errFn = vm.newFunction("__err", pushLog(stderr));
    logFn.consume((fn: any) => vm.setProp(vm.global, "__log", fn));
    errFn.consume((fn: any) => vm.setProp(vm.global, "__err", fn));

    // ---- 宿主函数：一个统一入口 `__hostCall(name, argsJson)`（少建 handle，少踩泄漏） ----
    const hostFunctions = options.hostFunctions ?? {};
    /** 这次执行里宿主调用了几次 —— 用来在超时/崩溃时给出**可行动**的解释（见文件头「已知限制」） */
    let hostCallCount = 0;
    const hostCall = vm.newAsyncifiedFunction("__hostCall", async (nameHandle: any, argsHandle: any) => {
      hostCallCount++;
      const name = vm.getString(nameHandle);
      const argsJson = vm.getString(argsHandle);
      const impl = hostFunctions[name];
      let args: unknown[] = [];
      try {
        args = JSON.parse(argsJson || "[]");
      } catch {
        args = [];
      }
      /**
       * ⚠️ **宿主函数绝不向 guest 抛错**，而是把错误当数据带回去，由 guest 侧的 `__call` 抛出来。
       *
       * 为什么：在 asyncify 的挂起回调里 `throw` 会让库去 marshal 一个错误 handle，
       * 而那时 WASM 模块仍处于挂起态 —— 实测直接 `memory access out of bounds`（整个模块崩掉，
       * 不是"这次调用失败"）。改成数据传递后，错误语义（`try { await sdk.x() } catch`）**完全不变**，
       * 但不会把模块弄崩。
       */
      try {
        if (!impl) return vm.newString(JSON.stringify({ __jsvmError: `宿主没有提供函数 ${name}` }));
        const result = await impl(args);
        return vm.newString(JSON.stringify({ __jsvmValue: result === undefined ? null : result }));
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 2000);
        return vm.newString(JSON.stringify({ __jsvmError: message }));
      }
    });
    hostCall.consume((fn: any) => vm.setProp(vm.global, "__hostCall", fn));

    // ---- 预置：console 外壳 + 调用方给的 prelude ----
    const consolePrelude = `
      globalThis.console = {
        log: (...a) => __log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
        info: (...a) => __log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
        warn: (...a) => __err(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
        error: (...a) => __err(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
      };
      // 宿主函数的统一调用口。
      //
      // ⚠️ 两道保护，都写在**挂起之前**：
      //  ① 次数上限（默认 1 次）：asyncify 引擎第 2 次挂起就会把模块搞坏、而且坏在进程级，
      //     所以第 2 次调用必须在 guest 侧就被拒（纯 JS 的 Promise.reject，不碰 asyncify）；
      //  ② 错误走 reject 而不是同步抛：同步抛发生在"挂起恢复帧"里，实测会 memory access out of bounds。
      globalThis.__jsvmHostCalls = 0;
      globalThis.__sdk = (name, args) => {
        globalThis.__jsvmHostCalls += 1;
        if (globalThis.__jsvmHostCalls > ${options.maxHostCalls ?? 1}) {
          return Promise.reject(
            new Error(
              "当前 JS 运行时的已知限制：一次执行里最多调用 " + ${options.maxHostCalls ?? 1} + " 次工具" +
              "（引擎的挂起机制在第 2 次就会损坏运行时）。请把脚本拆成多次 run_code 调用，" +
              "或者直接用 bash / read / write 等工具完成这一步。",
            ),
          );
        }
        const out = JSON.parse(__hostCall(name, JSON.stringify(args ?? [])));
        if (out && typeof out === "object" && "__jsvmError" in out) {
          return Promise.reject(new Error(String(out.__jsvmError)));
        }
        return Promise.resolve(out ? out.__jsvmValue : null);
      };
      // 兼容口：同步取值（**只在确定不会失败、或调用方自己保证不抛**时用）。
      globalThis.__call = (name, args) => {
        const out = JSON.parse(__hostCall(name, JSON.stringify(args ?? [])));
        if (out && typeof out === "object" && "__jsvmError" in out) throw new Error(String(out.__jsvmError));
        return out ? out.__jsvmValue : null;
      };
    `;
    const pre = vm.evalCode(`${consolePrelude}\n${options.prelude ?? ""}`);
    if (pre.error) {
      const error = readError(vm, pre.error);
      disposeQuietly(pre.error);
      return { ok: false, error, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut: false, elapsedMs: Date.now() - started };
    }
    disposeQuietly(pre.value);

    // ---- 执行 ----
    /**
     * ⚠️ **包一层 try/catch，但不要再套一层 async IIFE**。
     *
     * 演进过程（每一步都有实测）：
     *  1. 直接 `(async () => { CODE })()` —— 用户代码抛错时走"被拒绝的 Promise"路径，
     *     而 `resolvePromise` 的**拒绝路径**每跑一次漏一个 handle（泄漏探针 (d) 场景 8/8 abort）；
     *  2. 外面再套一层 `(async () => { try { return {ok:true, value: await (async () => { CODE })()} } catch … })()`
     *     —— 泄漏没了，但**多了一层 async 帧 + 对内部 promise 的 await**，
     *     结果 guest 一旦观察到宿主报的错就 `memory access out of bounds`
     *     （`Assertion failed: p->ref_count … gc_decref_child` / `free_zero_refcount`）；
     *  3. 现在：**单层 async 帧 + try/catch**，用户代码的 `return` 直接就是函数的返回值。
     *     成功时完成值就是用户返回的东西；失败时回来的是 `{ __jsvmGuestError: {...} }` 信封
     *     （宿主侧识别并转成 `ok:false`）。这既没有拒绝路径，也没有嵌套帧。
     */
    const raw = await vm.evalCodeAsync(
      `(async () => {
        try {
          ${options.code}
        } catch (e) {
          return { __jsvmGuestError: { message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack) : undefined, name: e && e.name ? String(e.name) : undefined } };
        }
      })()`,
    );
    /**
     * ⚠️ **不要靠 `unwrapResult` 抛错来判失败** —— 它抛的时候那个错误 handle 就漏了，
     * QuickJS 会在 `rt.dispose()` 时用 `Assertion failed: list_empty(&rt->gc_obj_list)` 告诉你
     * （实测：guest 每次抛错漏一个，泄漏计数与抛错次数一模一样）。这里显式取 `raw.error` 并释放。
     */
    if (raw.error) {
      const error = readError(vm, raw.error);
      disposeQuietly(raw.error);
      if (raw.value) disposeQuietly(raw.value);
      return {
        ok: false,
        error,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
        timedOut,
        elapsedMs: Date.now() - started,
      };
    }
    const completion: any = raw.value;

    let value: unknown;
    const isPromise = vm.getPromiseState(completion) !== "not-promise";
    if (isPromise) {
      // ⚠️ 见文件头第 3 条：宿主必须自己泵 job，否则永远不结算
      const hostPromise = vm.resolvePromise(completion);
      let settled: any = null;
      hostPromise.then((s: any) => {
        settled = s;
      });
      while (!settled && Date.now() - started <= timeoutMs) {
        rt.executePendingJobs(100);
        if (!settled) await new Promise((r) => setTimeout(r, 1));
      }
      disposeQuietly(completion);
      if (!settled) {
        /**
         * 超时有两种：**用户代码真的死循环**，和**引擎的已知限制被触发**（≥3 次宿主调用会卡住）。
         * 后者必须给可行动的解释 —— 否则模型看到 "timed out" 只会重试同一个脚本。
         */
        const limitHint =
          hostCallCount >= 2
            ? `。提示：这次执行至少调用了 ${hostCallCount} 次工具，而当前 JS 运行时的已知限制是"一次执行里最多 2 次工具调用"` +
              `（超过会卡住或崩溃）—— 请把脚本拆成多次调用，或直接用 bash / 其它工具完成这一步`
            : "";
        return {
          ok: false,
          error: {
            message: `Code execution timed out after ${timeoutMs}ms${limitHint}`,
          },
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
          timedOut: true,
          elapsedMs: Date.now() - started,
        };
      }
      if (settled.error) {
        const error = readError(vm, settled.error);
        disposeQuietly(settled.error);
        return { ok: false, error, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut, elapsedMs: Date.now() - started };
      }
      value = vm.dump(settled.value);
      disposeQuietly(settled.value);
    } else {
      value = vm.dump(completion);
      disposeQuietly(completion);
    }

    /**
     * guest 自报的错误信封（见上面包装那段）：拆出 message/stack 当失败返回。
     * 没有信封的返回值照旧当结果（用户代码 `return` 什么就是什么）。
     */
    if (value && typeof value === "object" && "__jsvmGuestError" in (value as Record<string, unknown>)) {
      const envelope = value as { __jsvmGuestError?: JsVmError };
      return {
        ok: false,
        error: envelope.__jsvmGuestError ?? { message: "guest 抛出错误但没带 message" },
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
        timedOut,
        elapsedMs: Date.now() - started,
      };
    }

    return { ok: true, value, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut, elapsedMs: Date.now() - started };
  } catch (error: any) {
    return {
      ok: false,
      error: describeRuntimeError(String(error?.message ?? error).slice(0, 4000)).wasmLevel
        ? { message: describeRuntimeError(String(error?.message ?? error)).message }
        : { message: String(error?.message ?? error).slice(0, 4000) },
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      timedOut,
      elapsedMs: Date.now() - started,
    };
  } finally {
    /**
     * ⚠️ **超时不必丢弃模块** —— 实测（`.preview-shot/_probe-jsvm-exit.mjs timeout`）：
     * 被打断之后同一个模块还能继续跑（后续异步调用与同步路径都正常，进程干净退出）。
     * 只有**释放本身失败**、或**出过 WASM 级错误**（模块状态已坏）才丢弃 —— 下次会新建一个。
     */
    try {
      vm.dispose();
    } catch {
      asyncModuleDirty = true;
    }
    try {
      rt.dispose();
    } catch {
      asyncModuleDirty = true;
    }
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
