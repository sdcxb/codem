/**
 * PluginManagerService 稳健性回归测试
 *
 * 覆盖插件市场/插件管理"安装→启用/禁用"链路的服务端缺陷修复：
 * R-1 级联启用全成功：success:true + enabledList 含目标与依赖
 * R-2 部分插件启用失败：必须 success:false + error（此前误报成功 → UI 假"已启用"）
 * R-3 error 状态持久化到禁用列表（重启后不出现"无 fiber 的假启用"）
 * R-4 error 后可重试成功（UI error 态恢复路径的服务端基础）
 * R-5 enable 已启用拒绝 / loading 连点保护存在
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginDependencyGraph } from "../core/plugin-loader/dependency-graph";
import {
  PluginManagerService,
  initPluginManager,
  resetPluginManagerSingletonForTest,
} from "../core/plugin-loader/plugin-manager-service";

// —— node 环境补齐 service 依赖的 localStorage/window ——
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};
(globalThis as any).window = { dispatchEvent: () => {} };

function makeCtx() {
  return {
    plugin: vi.fn(() => ({ dispose: vi.fn(async () => {}) })),
  };
}

/** 构造图：@codem/a provides x；@codem/b inject x（依赖 a） */
function makeGraph() {
  const graph = new PluginDependencyGraph();
  graph.register({ name: "@codem/a", provides: ["x"], inject: [], core: true });
  graph.register({ name: "@codem/b", provides: [], inject: ["x"] });
  return graph;
}

function makeManager(ctx: any, graph: PluginDependencyGraph) {
  const mgr = new PluginManagerService(ctx, graph);
  mgr.registerPluginLoader("@codem/a", () => () => {});
  mgr.registerPluginLoader("@codem/b", () => () => {});
  return mgr;
}

describe("PluginManagerService 稳健性", () => {
  // 每个用例独立（localStorage 残留会经 initialize 污染后续用例）
  beforeEach(() => store.clear());

  it("R-1: 级联启用全成功 → success + enabledList 含依赖与目标", async () => {
    const mgr = makeManager(makeCtx(), makeGraph());
    const res = await mgr.enable("@codem/b");
    expect(res.success).toBe(true);
    expect(res.enabledList).toContain("@codem/a");
    expect(res.enabledList).toContain("@codem/b");
    expect(mgr.getPluginState("@codem/b")?.status).toBe("enabled");
  });

  it("R-2: 目标插件启用失败 → success:false + error（不再误报成功）", async () => {
    const ctx = makeCtx();
    const mgr = makeManager(ctx, makeGraph());
    // 让 @codem/b 的 loader 抛错（apply 阶段失败）
    mgr.registerPluginLoader("@codem/b", () => {
      throw new Error("boom: loader failed");
    });
    const res = await mgr.enable("@codem/b");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Failed to enable");
    expect(res.error).toContain("@codem/b");
    // 依赖 @codem/a 已启用成功，但目标失败 → 状态 error
    expect(mgr.getPluginState("@codem/b")?.status).toBe("error");
  });

  it("R-3: error 状态持久化到禁用列表（重启不再假启用）", async () => {
    store.clear();
    const ctx = makeCtx();
    const mgr = makeManager(ctx, makeGraph());
    mgr.registerPluginLoader("@codem/b", () => {
      throw new Error("boom");
    });
    await mgr.enable("@codem/b"); // 失败 → error
    const saved = JSON.parse(store.get("codem:disabled-plugins") || "[]");
    expect(saved).toContain("@codem/b"); // error 计入禁用/未启用列表
  });

  it("R-4: error 后可重试成功（loader 修复后 enable 恢复 enabled）", async () => {
    const ctx = makeCtx();
    const mgr = makeManager(ctx, makeGraph());
    mgr.registerPluginLoader("@codem/b", () => {
      throw new Error("boom");
    });
    const fail = await mgr.enable("@codem/b");
    expect(fail.success).toBe(false);
    // 修复 loader 后重试
    mgr.registerPluginLoader("@codem/b", () => () => {});
    const retry = await mgr.enable("@codem/b");
    expect(retry.success).toBe(true);
    expect(mgr.getPluginState("@codem/b")?.status).toBe("enabled");
  });

  it("R-5: 已启用拒绝重复启用（幂等保护）", async () => {
    const mgr = makeManager(makeCtx(), makeGraph());
    await mgr.enable("@codem/b");
    const again = await mgr.enable("@codem/b");
    expect(again.success).toBe(false);
    expect(again.error).toContain("already enabled");
  });

  it("R-6: initPluginManager ctx-ready 幂等——二次调用返回同一实例（fiber 追踪不丢）", async () => {
    resetPluginManagerSingletonForTest();
    const ctx = makeCtx();
    const first = await initPluginManager(ctx as any, makeGraph());
    const second = await initPluginManager(ctx as any, makeGraph());
    expect(second).toBe(first); // 弹窗重开不再重建 manager
  });

  it("R-7: ctx 未就绪返回临时实例（不缓存），ctx 就绪后建立并复用 ctx-ready 单例", async () => {
    resetPluginManagerSingletonForTest();
    const temp = await initPluginManager(null as any, makeGraph());
    expect(temp).toBeTruthy();
    const ctx = makeCtx();
    const real = await initPluginManager(ctx as any, makeGraph());
    expect(real).not.toBe(temp); // 临时实例被真实单例替换
    const again = await initPluginManager(ctx as any, makeGraph());
    expect(again).toBe(real);    // 之后恒为同一 ctx-ready 单例
  });

  it("R-8: 卸载通过 ctx-ready 单例真实 dispose（disable 不失效）", async () => {
    resetPluginManagerSingletonForTest();
    const dispose = vi.fn(async () => {});
    const ctx = { plugin: vi.fn(() => ({ dispose })) };
    const mgr = await initPluginManager(ctx as any, makeGraph());
    // 注册真实 loader（无 loader 路径只改状态不建 fiber，测不到 dispose）
    mgr.registerPluginLoader("@codem/a", () => () => {});
    mgr.registerPluginLoader("@codem/b", () => () => {});
    // initialize 默认全 enabled（无 fiber）→ 先禁用再启用以真实走 ctx.plugin 建 fiber
    await mgr.disable("@codem/b");
    const res = await mgr.enable("@codem/b");
    expect(res.success).toBe(true);
    // 模拟弹窗重开：initPluginManager 幂等返回同一实例 → disable 能拿到 fiber 并 dispose
    const same = await initPluginManager(ctx as any, makeGraph());
    expect(same).toBe(mgr);
    const dis = await same.disable("@codem/b");
    expect(dis.success).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("R-9: 禁用真正卸载 YAML 装配的 ctx 插件，重新启用真正加载（对标 dsh 卸载语义）", { timeout: 60000 }, async () => {
    resetPluginManagerSingletonForTest();
    store.clear();
    const { registerBuiltinPlugins } = await import("../core/plugin-loader/builtin-registry");
    const { loadFromEntries, getActiveFiber } = await import("../core/plugin-loader/yaml-loader");
    const { Context } = await import("../core/cordis/src/index.ts");
    registerBuiltinPlugins();

    // 真实装配一个无依赖插件（@codem/session → sessionProvider）
    const ctx = new Context();
    const res = loadFromEntries(ctx as any, [{ id: "session", name: "@codem/session" }]);
    expect(res.loaded).toContain("session");
    const assembledFiber = getActiveFiber("@codem/session");
    expect(assembledFiber).toBeTruthy();
    // ctx.plugin 返回 PromiseLike fiber——await 完成激活（否则 PENDING，服务未注册）
    await Promise.race([assembledFiber, new Promise((r) => setTimeout(r, 2000))]);
    expect(ctx.get("session", false)).toBeTruthy();

    // 真实依赖图 + ctx-ready manager
    const graph = new PluginDependencyGraph();
    graph.register({ name: "@codem/session", provides: ["session"], inject: [] });
    const mgr = await initPluginManager(ctx as any, graph);
    expect(mgr.getPluginState("@codem/session")?.status).toBe("enabled");

    // 禁用 → 真卸载：装配 fiber 被 dispose，session 服务从 ctx 移除
    const dis = await mgr.disable("@codem/session");
    expect(dis.success).toBe(true);
    expect(getActiveFiber("@codem/session")).toBeUndefined();
    expect(ctx.get("session", false)).toBeUndefined();
    expect(mgr.getPluginState("@codem/session")?.status).toBe("disabled");

    // 重新启用 → 真加载：session 服务重新注册
    const en = await mgr.enable("@codem/session");
    expect(en.success).toBe(true);
    expect(ctx.get("session", false)).toBeTruthy();
    expect(mgr.getPluginState("@codem/session")?.status).toBe("enabled");
  });
});

