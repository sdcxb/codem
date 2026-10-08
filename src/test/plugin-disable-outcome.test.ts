/**
 * `doDisable` 的三态报账：`everLoaded` 必须在**清理之前**取快照（第 184 波 F5）。
 *
 * ## 缺陷形态
 *
 * 改前 `everLoaded` 是在 `this.fibers.delete(name)` 与 `unregisterActiveFiber(name)`
 * **之后**计算的 ⇒ 两项都刚被删/注销 ⇒ **恒为 false** ⇒ 「真·假禁用」
 * （插件被装载过，但 `dispose()` 抛错或根本没有可卸载句柄，代码仍在跑）
 * 被报成「本次进程内从未装载…禁用已生效，**无需重启**」——**说反话**；
 * 而本该报的 warn 分支（`everLoaded && !unloaded`）成了**死代码**。
 *
 * ## 判据（走 `doDisable` 的真实路径，而不是只调纯函数 `reportDisableOutcome`）
 *
 * | # | 形态 | 期望 |
 * |---|---|---|
 * | PLUGIN-F5-1 | 装载过、但 fiber 没有 `dispose` 句柄 | **warn**：没有可卸载实例 + 要重启 |
 * | PLUGIN-F5-2 | 装载过、`dispose()` 抛错 | **warn**（同上） |
 * | PLUGIN-F5-3 | 真的卸载成功 | info(unloaded) + 零 warn |
 * | PLUGIN-F5-4 | 从未装载 | info(never-loaded)，**不许**说"仍在运行" |
 * | PLUGIN-F5-5 | `@unregister` 后的 activeFiber 形态（YAML 装配的句柄没有 dispose） | **warn** |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
(globalThis as any).window = { dispatchEvent: () => {} };

const NAME = "@codem/f5-plugin";

let logs: string[] = [];
let warns: string[] = [];

function makeGraph() {
  // 动态 import 保持在用例内（与既有 plugin 用例同一写法）
  return import("../core/plugin-loader/dependency-graph").then(({ PluginDependencyGraph }) => {
    const graph = new PluginDependencyGraph();
    graph.register({ name: NAME, provides: ["f5"], inject: [], core: false });
    return graph;
  });
}

async function build(fiberFactory: () => any) {
  const graph = await makeGraph();
  const { PluginManagerService } = await import("../core/plugin-loader/plugin-manager-service");
  const mgr = new PluginManagerService({ plugin: vi.fn(fiberFactory) } as never, graph);
  // 每次 enable 都让 ctx.plugin 返回 fiberFactory 的结果（"已装载"的形态）
  mgr.registerPluginLoader(NAME, () => () => {});
  return mgr;
}

const disableLogs = () => logs.filter((t) => /\[PluginManager\] Disabled/.test(t));
const disableWarns = () => warns.filter((t) => /\[PluginManager\] Disabled/.test(t));

beforeEach(() => {
  store.clear();
  logs = [];
  warns = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("doDisable 三态（第 184 波 F5）", () => {
  it("PLUGIN-F5-1: 装载过但没有可卸载句柄（真·假禁用）⇒ warn，说清「没有句柄 + 要重启」", async () => {
    const mgr = await build(() => ({ name: NAME })); // 有 fiber，但**没有** dispose
    await mgr.enable(NAME);

    const res = await mgr.disable(NAME);

    expect(res.success).toBe(true);
    const w = disableWarns();
    expect(
      w.length,
      "改前 everLoaded 恒为 false ⇒ 这条 warn 是死代码；真·假禁用被报成「无需重启」（说反话）",
    ).toBe(1);
    expect(w[0]).toMatch(/没有找到可卸载的实例/);
    expect(w[0]).toMatch(/没有可用的卸载句柄/);
    expect(w[0]).toMatch(/重启/);
    expect(disableLogs().join("\n"), "不许同时打印「无需重启」").not.toContain("无需重启");
  });

  it("PLUGIN-F5-2: dispose() 抛错 ⇒ 同样要 warn（不许说反话）", async () => {
    const mgr = await build(() => ({
      name: NAME,
      dispose: async () => { throw new Error("dispose 炸了"); },
    }));
    await mgr.enable(NAME);

    const res = await mgr.disable(NAME);

    expect(res.success).toBe(true);
    expect(disableWarns().length, "没卸载成功就必须报出来").toBe(1);
    expect(disableWarns()[0]).toMatch(/继续运行到重启为止/);
  });

  it("PLUGIN-F5-3: 真的卸载成功 ⇒ info(unloaded)，零 warn", async () => {
    const dispose = vi.fn(async () => {});
    const mgr = await build(() => ({ name: NAME, dispose }));
    await mgr.enable(NAME);

    await mgr.disable(NAME);

    expect(dispose, "必须真的 dispose").toHaveBeenCalledTimes(1);
    expect(disableWarns()).toEqual([]);
    expect(disableLogs().filter((t) => /Disabled \(unloaded\)/.test(t)).length).toBe(1);
  });

  it("PLUGIN-F5-4: 从未装载 ⇒ never-loaded（第三态仍可达，不许说「仍在运行」）", async () => {
    const mgr = await build(() => { throw new Error("不该被调用"); });

    await mgr.disable(NAME);

    expect(disableWarns()).toEqual([]);
    const info = disableLogs();
    expect(info.length).toBe(1);
    expect(info[0]).toMatch(/never-loaded/);
    expect(info[0]).toMatch(/从未装载/);
    expect(info[0]).not.toMatch(/仍在本次进程内运行/);
  });

  it("PLUGIN-F5-5: YAML 装配登记的 activeFiber（句柄无 dispose）⇒ warn（真·假禁用第二形态）", async () => {
    const { __registerActiveFiberForTest, unregisterActiveFiber } = await import(
      "../core/plugin-loader/yaml-loader"
    );
    const mgr = await build(() => { throw new Error("不该被调用"); });
    // 模拟 loadFromEntries 装配留下的句柄：没有 dispose ⇒ 卸载落空，但**确实装载过**
    __registerActiveFiberForTest(NAME, { name: NAME });

    const res = await mgr.disable(NAME);

    expect(res.success).toBe(true);
    expect(
      disableWarns().length,
      "装配过就是装载过：不能说成「从未装载、无需重启」",
    ).toBe(1);
    expect(unregisterActiveFiber).toBeTruthy();
  });
});
