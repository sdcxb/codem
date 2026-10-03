/**
 * 第 104 波：**动态插件的沙箱会话**判据（PLUGIN-1..5）。
 *
 * ## 这一层为什么这么测
 *
 * 执行在 Rust（`js_sandbox_session.rs`，判据在 `cargo test` 里），前端这层负责**接线**：
 *  · `define` → 开一个会话（并先跑 `validateCode` 预检）；
 *  · `run` → 在会话里调插件实例；
 *  · `ctx.provide('svc', { hello: () => … })` → 建**服务代理**，`svc.hello()` 走
 *    `js_sandbox_call_function` **回调 guest 里的函数**（这是"服务"能用的关键，也是最深的一处）；
 *  · `retract` → 关会话。
 *
 * 所以这里用**假的 Tauri**（记录 invoke 调用 + 抓住事件监听器）来钉接线，
 * 而不是真跑引擎 —— 引擎语义由 Rust 判据钉，端到端由真机探针钉。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dynamicRunnerProvider } from "../core/provider/dynamic-runner-provider";
import { __resetJsRemoteRuntimeForTests } from "../core/js/js-remote-runtime";

interface InvokeCall {
  command: string;
  args?: Record<string, unknown>;
}

let calls: InvokeCall[] = [];
let eventHandlers: Record<string, (event: { payload: unknown }) => void> = {};

/** 一个够用的假 Tauri：invoke 按命令返回脚本化的结果；event.listen 把处理器交出来 */
function installFakeTauri(script: Record<string, (args: any) => unknown> = {}) {
  calls = [];
  eventHandlers = {};
  (globalThis as any).__TAURI__ = {
    core: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const handler = script[command];
        if (handler) return handler(args);
        if (command === "jsvm_host_reply") return null;
        throw new Error(`假 Tauri 没有脚本化命令 ${command}`);
      },
    },
    event: {
      listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
        eventHandlers[name] = handler;
        return () => {
          delete eventHandlers[name];
        };
      },
    },
  };
}

function makeCtx() {
  const services = new Map<string, unknown>();
  const ctx: any = {
    provide: (name: string, impl: unknown) => {
      services.set(name, impl);
      return () => services.delete(name);
    },
    get: (name: string) => services.get(name),
    reflect: { store: {} },
  };
  return ctx;
}

/** 让会话里的求值返回脚本化的值（按表达式内容判断，避免"表达式一字不差"的脆弱判据） */
function evalScript(map: Array<[RegExp, unknown]>) {
  return (args: any) => {
    const expression = String(args?.expression ?? "");
    for (const [re, value] of map) if (re.test(expression)) return JSON.stringify(value);
    return JSON.stringify(null);
  };
}

beforeEach(() => {
  __resetJsRemoteRuntimeForTests();
});

afterEach(() => {
  __resetJsRemoteRuntimeForTests();
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("第 104 波：动态插件走沙箱会话（不依赖 eval）", () => {
  it("PLUGIN-1: define 开一个会话；危险代码在**开会话之前**就被预检拦住", async () => {
    installFakeTauri({ js_sandbox_open: () => 7 });
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;

    const ok = await runner.define("my-plugin", `module.exports = (ctx) => { ctx.provide("svc", { hello: () => "world" }) }`);
    expect(ok.success, JSON.stringify(ok)).toBe(true);
    expect(calls.filter((c) => c.command === "js_sandbox_open")).toHaveLength(1);

    // 危险代码：不许开会话（预检早失败，且给出原因）
    const before = calls.length;
    const bad = await runner.define("evil", `require('child_process').exec('calc')`);
    expect(bad.success).toBe(false);
    expect(String(bad.error)).toMatch(/child_process|not allowed|dangerous/i);
    expect(calls.length, "被拦下的代码不该开沙箱会话").toBe(before);
  });

  it("PLUGIN-2: run 在会话里调插件实例，返回 guest 的值", async () => {
    installFakeTauri({
      js_sandbox_open: () => 7,
      js_sandbox_eval: evalScript([
        [/typeof module\.exports === "function"/, "ok"],
        [/typeof \(globalThis\.__plugin && globalThis\.__plugin\.run\) === "function"/, true],
        [/__plugin\.run\(/, 42],
        [/globalThis\.__plugin$/, { ok: true }],
      ]),
    });
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;

    await runner.define("p", `module.exports = (ctx) => ({ run: (args) => 6 * 7 })`);
    const out = await runner.run("p", { n: 1 });
    expect(out, JSON.stringify(out)).toEqual({ success: true, result: 42 });
    // 三次求值都在**同一个会话**里
    const evals = calls.filter((c) => c.command === "js_sandbox_eval");
    expect(evals.length).toBeGreaterThanOrEqual(3);
    for (const call of evals) expect(call.args?.sessionId).toBe(7);
  });

  it("PLUGIN-3: ctx.provide 交出的服务，宿主调用会**回调 guest 里的函数**", async () => {
    installFakeTauri({
      js_sandbox_open: () => 11,
      js_sandbox_call_function: () => JSON.stringify("hello world"),
    });
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;
    await runner.define("greeter", `module.exports = (ctx) => { ctx.provide("greeter", { hello: (n) => "hello " + n }) }`);

    // 模拟 Rust 侧把 `ctx.provide` 送到前端（事件里带 session_id）
    const handler = eventHandlers["jsvm://host-call"];
    expect(handler, "应当注册了宿主调用监听器").toBeTruthy();
    await handler({
      payload: {
        id: 1,
        name: "__provide",
        args: JSON.stringify({ name: "greeter", functions: { hello: 9 }, data: { version: 3 } }),
        session_id: 11,
      },
    });
    // 前端应当回复了这次宿主调用
    const reply = calls.find((c) => c.command === "jsvm_host_reply");
    expect(reply, "必须回复 Rust（否则那边会阻塞到超时）").toBeTruthy();

    // 宿主侧拿到的服务：数据照搬，函数是回调 guest 的代理
    const service = ctx.get("greeter") as any;
    expect(service.version).toBe(3);
    const value = await service.hello("world");
    expect(value).toBe("hello world");
    const callback = calls.find((c) => c.command === "js_sandbox_call_function");
    expect(callback?.args).toMatchObject({ sessionId: 11, handle: 9, argsJson: JSON.stringify(["world"]) });

    // inspect 里能看到这个服务（对"插件提供了什么"可观测）
    expect(runner.inspect().services).toContain("greeter");
    expect(runner.inspect().plugins.map((p: any) => p.name)).toContain("greeter");
  });

  it("PLUGIN-4: retract 关掉会话并从列表里消失", async () => {
    installFakeTauri({
      js_sandbox_open: () => 5,
      js_sandbox_eval: () => JSON.stringify(null),
      js_sandbox_close: () => true,
    });
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;
    await runner.define("temp", `module.exports = () => {}`);
    expect(runner.list()).toEqual(["temp"]);

    const out = await runner.retract("temp");
    expect(out.success).toBe(true);
    expect(runner.list()).toEqual([]);
    expect(calls.some((c) => c.command === "js_sandbox_close" && c.args?.sessionId === 5)).toBe(true);

    const missing = await runner.retract("temp");
    expect(missing.success).toBe(false);
  });

  it("PLUGIN-5: 全局 Function/eval 被桩掉时 define/run 仍然工作（证明没有本地 eval 兜底）", async () => {
    installFakeTauri({
      js_sandbox_open: () => 3,
      js_sandbox_eval: evalScript([
        [/typeof module\.exports === "function"/, "ok"],
        [/__plugin\.run\) === "function"/, true],
        [/__plugin\.run\(/, "from-guest"],
      ]),
    });
    const originalFunction = globalThis.Function;
    const originalEval = globalThis.eval;
    // @ts-expect-error 故意替换
    globalThis.Function = () => {
      throw new Error("CSP: 'unsafe-eval' is not allowed");
    };
    // @ts-expect-error 故意替换
    globalThis.eval = () => {
      throw new Error("CSP: 'unsafe-eval' is not allowed");
    };
    try {
      const ctx = makeCtx();
      dynamicRunnerProvider(ctx);
      const runner = ctx.get("dynamicCordisRunner") as any;
      const defined = await runner.define("p", `module.exports = (ctx) => ({ run: () => "from-guest" })`);
      expect(defined.success, JSON.stringify(defined)).toBe(true);
      const out = await runner.run("p");
      expect(out).toEqual({ success: true, result: "from-guest" });
    } finally {
      globalThis.Function = originalFunction;
      globalThis.eval = originalEval;
    }
  });
});
