/**
 * dsh-compat 真实 Cordis 装配集成测试
 *
 * 用**真实 Cordis Context**（非 mock）装配真实 provider 插件 + dshCompatPlugin，
 * 验证插件架构对 dsh 兼容层的支撑（目标②的最硬证据）：
 * LC-1 7 个 dsh 别名经 ctx.provide 注册、ctx.get 可解析（插件装配拓扑生效）
 * LC-2 dshLlm 懒解析链路可用：dshLlm → ctx.get('llm')（真实 llmProvider）→ listModels
 * LC-3 dshSessions 可用：create/list/remove 驱动真实 sessionProvider（内存 map）
 * LC-4 dshEvents emit/on 走真实 Cordis 事件系统
 * LC-5 服务未就绪时懒解析报可诊断错误（不静默）
 * LC-6 卸载 dshCompatPlugin 后别名从 ctx 移除（市场"禁用"在真实 ctx 的卸载语义）
 */
import { describe, it, expect, vi } from "vitest";
import { Context } from "../core/cordis/src/index.ts";
import { llmProvider } from "../core/provider/llm-provider";
import { shellProvider } from "../core/provider/shell-provider";
import { sessionProvider } from "../core/provider/session-provider";
import { dshCompatPlugin } from "../core/dsh-compat/index";

/** 最小 llmEngine stub（经插件加载，使其 fiber 激活可见） */
function llmEngineStubPlugin() {
  return (ctx: any) => {
    ctx.provide("llmEngine", {
      providers: {
        get: () => undefined,
        getAll: () => [],
        register: () => {},
        remove: () => {},
        getConfigured: () => [],
      },
      getDefaultModel: () => "test-model",
    });
  };
}

/** 补核心服务 stub（契约已与真实源码核对一致；此处聚焦 Cordis 拓扑与懒解析） */
function coreStubsPlugin() {
  return (ctx: any) => {
    ctx.provide("fs", {
      readFile: async () => "",
      writeFile: async () => {},
      listDirectory: async () => [],
      deleteFile: async () => {},
      exists: async () => false,
    });
    ctx.provide("tools", { execute: async () => "ok", list: () => [], get: () => undefined });
    ctx.provide("settings", { getAll: () => ({}), set: () => {} });
  };
}

async function fullAssembly() {
  const ctx = new Context();
  // 依赖前置：llmProvider inject llmEngine → 先激活 stub（否则 await ctx.plugin(llmProvider) 挂起）
  await ctx.plugin(llmEngineStubPlugin());
  await ctx.plugin(coreStubsPlugin());
  // 真实 provider 插件（await 激活完成，服务注册进 active fiber）
  await ctx.plugin(llmProvider);
  await ctx.plugin(shellProvider);
  await ctx.plugin(sessionProvider);
  // 兼容层
  await ctx.plugin(dshCompatPlugin);
  return ctx;
}

describe("dsh-compat 真实 Cordis 装配", () => {
  it("LC-1: 7 个 dsh 别名经 ctx.provide 注册并可解析", async () => {
    const ctx = await fullAssembly();
    for (const name of [
      "dshLlm", "dshShell", "dshFs", "dshTools",
      "dshSessions", "dshEvents", "dshCredentials",
    ]) {
      expect(ctx.get(name), `${name} 应注册于 ctx`).toBeTruthy();
    }
  });

  it("LC-2: dshLlm 懒解析链路可用（真实 llmProvider + llmEngine stub → listModels=[]）", async () => {
    const ctx = await fullAssembly();
    const dshLlm = ctx.get("dshLlm");
    const models = await dshLlm.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBe(0); // 无注册 provider
    // dsh 协议生成方法 generate（内部转真实 llmProvider.complete）；provider 未注册 → 可诊断错误
    await expect(dshLlm.generate({ model: "x", messages: [] })).rejects.toThrow(/Provider/);
  });

  it("LC-3: dshSessions create/list/remove 驱动真实 sessionProvider", async () => {
    const ctx = await fullAssembly();
    const s = ctx.get("dshSessions");
    const created = s.create({ projectId: "p1" });
    expect(created.id).toBeTruthy();
    expect(s.list().length).toBe(1);
    s.remove(created.id);
    expect(s.list().length).toBe(0);
  });

  it("LC-4: dshEvents emit/on 走真实 Cordis 事件系统", async () => {
    const ctx = await fullAssembly();
    const ev = ctx.get("dshEvents");
    const handler = vi.fn();
    const unsub = ev.on("audit/test-event", handler);
    ev.emit("audit/test-event", 42);
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalled();
    unsub();
  });

  it("LC-5: 服务未就绪时懒解析报可诊断错误（不静默）", async () => {
    // 不装配 session 的 ctx（其余齐全）
    const ctx = new Context();
    await ctx.plugin(llmEngineStubPlugin());
    await ctx.plugin(coreStubsPlugin());
    await ctx.plugin(llmProvider);
    await ctx.plugin(dshCompatPlugin);
    const dshSessions = ctx.get("dshSessions");
    // 懒解析在方法调用时同步抛可诊断错误（服务名明确，便于排障）
    expect(() => dshSessions.list()).toThrow('[dsh-compat] service "session" not ready');
  });

  it("LC-6: 卸载 dshCompatPlugin 后别名从 ctx 移除（真实卸载语义）", async () => {
    const ctx = new Context();
    await ctx.plugin(llmEngineStubPlugin());
    await ctx.plugin(coreStubsPlugin());
    await ctx.plugin(llmProvider);
    const fiber = await ctx.plugin(dshCompatPlugin);
    expect(ctx.get("dshLlm")).toBeTruthy();
    fiber.dispose();
    expect(ctx.get("dshLlm")).toBeUndefined();
    expect(ctx.get("dshEvents")).toBeUndefined();
  });
});
