/**
 * dsh 插件市场目录与评估测试
 *
 * DM-1 目录三类兼容性均有覆盖、bundled 条目必有 Codem 等价锚点
 * DM-2 bundled 锚点指向真实存在的内置插件（runtimePluginList）
 * DM-3 无网络/失败时 npm 在线检索返回 []（不阻塞 UI）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DSH_MARKET_CATALOG,
  searchDshNpmPackages,
  type DshMarketEntry,
} from "../core/plugin-market/dsh-market-catalog";

const { runtimePluginList } = await import("../core/provider/plugin-registry-provider");
const { PluginDependencyGraph } = await import("../core/plugin-loader/dependency-graph");
const installedNames = new Set((runtimePluginList as any[]).map((p: any) => p.name));

describe("dsh 插件市场目录", () => {
  it("DM-1: bundled 条目必有 codemAnchor；三类状态均有覆盖", () => {
    expect(DSH_MARKET_CATALOG.length).toBeGreaterThan(15);
    const statuses = new Set(DSH_MARKET_CATALOG.map((e) => e.status));
    expect(statuses.has("bundled")).toBe(true);
    expect(statuses.has("adaptable")).toBe(true);
    expect(statuses.has("unsupported")).toBe(true);
    for (const entry of DSH_MARKET_CATALOG) {
      expect(entry.dshName.startsWith("@deepseek-ai/dsh-")).toBe(true);
      expect(entry.note.length).toBeGreaterThan(4);
      if (entry.status === "bundled") {
        expect(typeof entry.codemAnchor).toBe("string");
        expect((entry.codemAnchor as string).startsWith("@codem/")).toBe(true);
      } else {
        expect(entry.codemAnchor).toBeUndefined();
      }
    }
  });

  it("DM-2: bundled 锚点指向真实内置插件（可被插件管理启停）", () => {
    const anchors = DSH_MARKET_CATALOG
      .filter((e) => e.status === "bundled")
      .map((e: DshMarketEntry) => e.codemAnchor as string);
    expect(anchors.length).toBeGreaterThan(5);
    // 抽查核心锚点必须存在于插件管理运行时清单（否则"安装"无对象）
    const required = ["@codem/llm", "@codem/fs-local", "@codem/shell-local", "@codem/compaction"];
    for (const name of required) {
      expect(installedNames.has(name), `${name} 应存在于 runtimePluginList`).toBe(true);
    }
    // 全部 bundled 锚点都应存在（避免出现"安装→启用不存在的插件"）
    for (const anchor of anchors) {
      expect(installedNames.has(anchor), `${anchor} 应存在于 runtimePluginList`).toBe(true);
    }
  });

  it("DM-3: npm 在线检索失败/超时返回 []（不抛错）", async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error stub
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    try {
      const hits = await searchDshNpmPackages();
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
    }
  });

  it("DM-4: bundled 锚点一一对应（无重复），避免两个 dsh 包共用同一内置插件", () => {
    const anchors = DSH_MARKET_CATALOG.filter((e) => e.status === "bundled")
      .map((e) => e.codemAnchor as string);
    const unique = new Set(anchors);
    expect(unique.size).toBe(anchors.length);
  });

  it("DM-5: 真实依赖图下全部 bundled 锚安装级联可达（无缺失依赖，替代 UI 验收的自动化证据）", () => {
    // 与生产路径一致：PluginDependencyGraph + runtimePluginList 全量注册
    const graph = new PluginDependencyGraph();
    for (const meta of runtimePluginList as any[]) graph.register(meta);

    const anchors = DSH_MARKET_CATALOG.filter((e) => e.status === "bundled")
      .map((e) => e.codemAnchor as string);

    for (const anchor of anchors) {
      const meta = graph.get(anchor);
      expect(meta, `${anchor} 应在依赖图中`).toBeTruthy();
      // 从空启用集级联启用：市场"安装并启用"路径（enable → getCascadeEnable）
      const cascade = graph.getCascadeEnable(anchor, new Set<string>());
      expect(cascade.missingDependencies, `${anchor} 级联启用存在缺失依赖`).toEqual([]);
      expect(cascade.canEnable, `${anchor} 应可启用`).toBe(true);
      expect(cascade.toEnable).toContain(anchor);
    }
  });
});
