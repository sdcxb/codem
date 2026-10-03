/**
 * 第 104 波：**动态插件工具**与沙箱会话的接线判据（PLUGINTOOL-1..3）。
 *
 * ## 为什么单独有这一组（真机探针抓到的缺陷）
 *
 * 真机上 `cordis_undefine` 报 `Failed to undefine plugin: undefined` —— 而插件其实**已经注销了**。
 * 原因：`runner.retract()` 在这一波变成 **async**（要先关沙箱会话），
 * 而工具里写的是 `const result = runner.retract(...)`（**没 await**）⇒ `result` 是个 Promise
 * ⇒ `result.success` 是 `undefined` ⇒ **成功被报成失败**。
 *
 * 这类缺陷是"判据长在生产不执行的链路上"的典型：单元判据只测 provider、不测工具怎么调用它。
 * 所以这里把工具与 runner 的**调用姿势**钉住（含"必须 await"）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dynamicRunnerProvider } from "../core/provider/dynamic-runner-provider";
import { __resetJsRemoteRuntimeForTests } from "../core/js/js-remote-runtime";

/** 假的 Tauri：会话命令都给"成功"的脚本化结果 */
function installFakeTauri() {
  (globalThis as any).__TAURI__ = {
    core: {
      invoke: async (command: string) => {
        if (command === "js_sandbox_open") return 21;
        if (command === "js_sandbox_eval") return JSON.stringify(null);
        if (command === "js_sandbox_close") return true;
        return null;
      },
    },
    event: { listen: async () => () => {} },
  };
}

const tools = await import("../core/llm/dynamic-plugin-tools");

/** 工具通过 `getToolContext()` 拿 ctx —— 这里把它接到我们自己的 ctx 上 */
async function withToolContext<T>(ctx: unknown, fn: () => Promise<T>): Promise<T> {
  const toolsModule = await import("../core/llm/tools");
  const spy = vi.spyOn(toolsModule, "getToolContext").mockReturnValue(ctx as never);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
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

beforeEach(() => {
  __resetJsRemoteRuntimeForTests();
  installFakeTauri();
});

afterEach(() => {
  __resetJsRemoteRuntimeForTests();
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("第 104 波：动态插件工具的接线", () => {
  it("PLUGINTOOL-1: cordis_undefine 在 runner 成功时**必须报成功**（漏 await 会红）", async () => {
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;
    await runner.define("p1", `module.exports = () => {}`);

    const tool = tools.createCordisUndefineTool();
    const out = await withToolContext(ctx, () => tool.execute({ name: "p1" } as never, {} as never));
    expect(out.isError, `不应当报错：${out.output}`).toBeFalsy();
    expect(String(out.output)).toMatch(/successfully/i);
    // 而且插件真的没了
    expect(runner.list()).toEqual([]);
  });

  it("PLUGINTOOL-2: cordis_stop 同理（也是 await retract）", async () => {
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;
    await runner.define("p2", `module.exports = () => {}`);

    const tool = tools.createCordisStopTool();
    const out = await withToolContext(ctx, () => tool.execute({ name: "p2" } as never, {} as never));
    expect(out.isError, `不应当报错：${out.output}`).toBeFalsy();
    expect(String(out.output)).toMatch(/successfully/i);
  });

  it("PLUGINTOOL-3: cordis_inspect 能看到插件与它提供的服务（接线可观测）", async () => {
    const ctx = makeCtx();
    dynamicRunnerProvider(ctx);
    const runner = ctx.get("dynamicCordisRunner") as any;
    await runner.define("p3", `module.exports = (ctx) => { ctx.provide("svc3", { hi: () => 1 }) }`);
    // 模拟 Rust 侧把 `ctx.provide` 送到前端
    // （监听器在 openSandboxSession 时注册；这里直接用 runner 的内部登记做行为判据）
    expect(runner.inspect().plugins.map((p: any) => p.name)).toContain("p3");

    const tool = tools.createCordisInspectTool();
    const out = await withToolContext(ctx, () => tool.execute({} as never, {} as never));
    expect(String(out.output)).toContain("p3");
  });
});
