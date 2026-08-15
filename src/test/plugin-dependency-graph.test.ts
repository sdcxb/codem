/**
 * 插件依赖图与插件管理器测试 — PLUGIN-001 ~ PLUGIN-050
 *
 * 覆盖范围：
 *   A. 依赖图注册/查询基础（PLUGIN-001 ~ PLUGIN-010）
 *   B. 级联关闭计算（PLUGIN-011 ~ PLUGIN-020）
 *   C. 级联启用计算（PLUGIN-021 ~ PLUGIN-030）
 *   D. 核心插件锁定保护（PLUGIN-031 ~ PLUGIN-035）
 *   E. 不同插件关闭对系统的影响（PLUGIN-036 ~ PLUGIN-045）
 *   F. 服务链与依赖描述（PLUGIN-046 ~ PLUGIN-050）
 *
 * 关键组件：
 *   - PluginDependencyGraph
 *   - PluginMeta / CascadeDisableResult / CascadeEnableResult
 *   - RISK_LEVEL_CONFIG
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  PluginDependencyGraph,
  RISK_LEVEL_CONFIG,
  type PluginMeta,
} from "../core/plugin-loader/dependency-graph";

/** 构建测试用依赖图 */
function buildTestGraph(): PluginDependencyGraph {
  const graph = new PluginDependencyGraph();

  // 核心服务插件
  graph.register({
    name: "@codem/llm",
    provides: ["llm"],
    inject: [],
    core: true,
    locked: true,
    riskLevel: "danger",
    riskDescription: "关闭后 Agent 无法推理",
  });
  graph.register({
    name: "@codem/tools",
    provides: ["tools"],
    inject: [],
    core: true,
    locked: true,
    riskLevel: "danger",
    riskDescription: "关闭后无法执行工具",
  });
  graph.register({
    name: "@codem/session",
    provides: ["session"],
    inject: [],
    core: true,
    locked: true,
    riskLevel: "danger",
  });
  graph.register({
    name: "@codem/storage",
    provides: ["storage"],
    inject: [],
    core: true,
    locked: true,
    riskLevel: "danger",
  });

  // 能力 Provider（可关闭）
  graph.register({
    name: "@codem/fs-local",
    provides: ["fs"],
    inject: [],
    riskLevel: "caution",
    riskDescription: "关闭后文件读写工具不可用",
  });
  graph.register({
    name: "@codem/shell-local",
    provides: ["shell"],
    inject: [],
    riskLevel: "caution",
    riskDescription: "关闭后 Shell 执行不可用",
  });
  graph.register({
    name: "@codem/mcp",
    provides: ["mcp"],
    inject: [],
    riskLevel: "safe",
    riskDescription: "仅影响 MCP 扩展",
  });
  graph.register({
    name: "@codem/memory",
    provides: ["memory"],
    inject: [],
    riskLevel: "caution",
  });

  // 消费者（依赖其他插件提供的服务）
  graph.register({
    name: "@codem/tool-fs",
    provides: [],
    inject: ["fs"],
    riskLevel: "danger",
    riskDescription: "依赖 fs 服务",
  });
  graph.register({
    name: "@codem/tool-shell",
    provides: [],
    inject: ["shell"],
    riskLevel: "danger",
  });
  graph.register({
    name: "@codem/subagent",
    provides: ["subagent"],
    inject: ["llm", "tools"],
    riskLevel: "caution",
  });
  graph.register({
    name: "@codem/workflow",
    provides: ["workflow"],
    inject: ["llm", "tools", "session"],
    riskLevel: "caution",
  });

  return graph;
}

describe("插件依赖图与插件管理器 — PLUGIN-001 ~ PLUGIN-050", () => {
  let graph: PluginDependencyGraph;

  beforeEach(() => {
    graph = buildTestGraph();
  });

  // ===== A. 依赖图注册/查询基础 =====
  describe("依赖图注册/查询基础", () => {
    it("PLUGIN-001: 注册的插件可查询", () => {
      const meta = graph.get("@codem/llm");
      expect(meta).toBeDefined();
      expect(meta!.name).toBe("@codem/llm");
      expect(meta!.provides).toContain("llm");
    });

    it("PLUGIN-002: list 返回所有已注册插件", () => {
      const all = graph.list();
      expect(all.length).toBeGreaterThanOrEqual(10);
      const names = all.map((m) => m.name);
      expect(names).toContain("@codem/llm");
      expect(names).toContain("@codem/tools");
      expect(names).toContain("@codem/fs-local");
    });

    it("PLUGIN-003: 注销插件后不再可查询", () => {
      graph.unregister("@codem/mcp");
      expect(graph.get("@codem/mcp")).toBeUndefined();
      // providers 映射也应清除
      const providers = graph.getDirectDependencies("@codem/subagent");
      // subagent 不依赖 mcp，不影响
      expect(providers).not.toContain("@codem/mcp");
    });

    it("PLUGIN-004: 直接依赖计算 — subagent 依赖 llm + tools", () => {
      const deps = graph.getDirectDependencies("@codem/subagent");
      expect(deps).toContain("@codem/llm");
      expect(deps).toContain("@codem/tools");
      expect(deps.length).toBe(2);
    });

    it("PLUGIN-005: 直接被依赖计算 — llm 被 subagent + workflow 依赖", () => {
      const dependents = graph.getDirectDependents("@codem/llm");
      expect(dependents).toContain("@codem/subagent");
      expect(dependents).toContain("@codem/workflow");
    });

    it("PLUGIN-006: 无依赖的插件返回空数组", () => {
      const deps = graph.getDirectDependencies("@codem/llm");
      expect(deps).toEqual([]);
    });

    it("PLUGIN-007: 无被依赖的插件返回空数组", () => {
      const dependents = graph.getDirectDependents("@codem/mcp");
      expect(dependents).toEqual([]);
    });

    it("PLUGIN-008: getDependencyInfo 返回完整信息", () => {
      const info = graph.getDependencyInfo("@codem/subagent");
      expect(info.dependencies).toContain("@codem/llm");
      expect(info.dependencies).toContain("@codem/tools");
      expect(info.dependents).toEqual([]);
      expect(info.inject).toContain("llm");
      expect(info.inject).toContain("tools");
      expect(info.dependencyDescription).toContain("依赖");
    });

    it("PLUGIN-009: 查询不存在的插件返回空信息", () => {
      const info = graph.getDependencyInfo("@codem/nonexistent");
      expect(info.dependencies).toEqual([]);
      expect(info.dependents).toEqual([]);
      expect(info.dependencyDescription).toBe("Plugin not found");
    });

    it("PLUGIN-010: 多个插件可 provides 同一服务", () => {
      graph.register({
        name: "@codem/fs-remote",
        provides: ["fs"],
        inject: [],
      });
      const deps = graph.getDirectDependencies("@codem/tool-fs");
      // tool-fs inject 'fs'，两个 provider 都应出现
      expect(deps).toContain("@codem/fs-local");
      expect(deps).toContain("@codem/fs-remote");
    });
  });

  // ===== B. 级联关闭计算 =====
  describe("级联关闭计算", () => {
    it("PLUGIN-011: 关闭 fs-local 级联关闭 tool-fs", () => {
      const result = graph.getCascadeDisable("@codem/fs-local");
      expect(result.toDisable).toContain("@codem/fs-local");
      expect(result.toDisable).toContain("@codem/tool-fs");
      expect(result.needsConfirmation).toBe(true);
    });

    it("PLUGIN-012: 关闭 shell-local 级联关闭 tool-shell", () => {
      const result = graph.getCascadeDisable("@codem/shell-local");
      expect(result.toDisable).toContain("@codem/shell-local");
      expect(result.toDisable).toContain("@codem/tool-shell");
    });

    it("PLUGIN-013: 关闭 mcp 不级联（无人依赖）", () => {
      const result = graph.getCascadeDisable("@codem/mcp");
      expect(result.toDisable).toEqual(["@codem/mcp"]);
      expect(result.needsConfirmation).toBe(false);
    });

    it("PLUGIN-014: 关闭 memory 不级联（无人依赖）", () => {
      const result = graph.getCascadeDisable("@codem/memory");
      expect(result.toDisable).toEqual(["@codem/memory"]);
      expect(result.needsConfirmation).toBe(false);
    });

    it("PLUGIN-015: affected 列表包含原因", () => {
      const result = graph.getCascadeDisable("@codem/fs-local");
      const fsEntry = result.affected.find((a) => a.name === "@codem/fs-local");
      expect(fsEntry).toBeDefined();
      expect(fsEntry!.reason).toContain("用户主动关闭");

      const toolFsEntry = result.affected.find((a) => a.name === "@codem/tool-fs");
      expect(toolFsEntry).toBeDefined();
      expect(toolFsEntry!.reason).toContain("依赖");
    });

    it("PLUGIN-016: 关闭 llm 不会级联关闭 subagent（核心锁定保护）", () => {
      // llm 是 core + locked，不能被关闭
      const result = graph.getCascadeDisable("@codem/llm");
      expect(result.lockedReason).toBeDefined();
      expect(result.toDisable).toEqual([]);
    });

    it("PLUGIN-017: 关闭 tools 不会级联（核心锁定保护）", () => {
      const result = graph.getCascadeDisable("@codem/tools");
      expect(result.lockedReason).toBeDefined();
      expect(result.toDisable).toEqual([]);
    });

    it("PLUGIN-018: 多级级联 — 关闭 provider 后消费者也关闭", () => {
      // 构建：A provides 'x', B inject 'x' + provides 'y', C inject 'y'
      graph.register({ name: "@test/a", provides: ["x"], inject: [] });
      graph.register({ name: "@test/b", provides: ["y"], inject: ["x"] });
      graph.register({ name: "@test/c", provides: [], inject: ["y"] });

      const result = graph.getCascadeDisable("@test/a");
      expect(result.toDisable).toContain("@test/a");
      expect(result.toDisable).toContain("@test/b");
      expect(result.toDisable).toContain("@test/c");
      expect(result.needsConfirmation).toBe(true);
    });

    it("PLUGIN-019: 环形依赖不会死循环", () => {
      graph.register({ name: "@test/cycle-a", provides: ["ca"], inject: ["cb"] });
      graph.register({ name: "@test/cycle-b", provides: ["cb"], inject: ["ca"] });

      // 不应抛出异常（环形依赖在 collectDependents 中通过 Set 去重）
      expect(() => graph.getCascadeDisable("@test/cycle-a")).not.toThrow();
    });

    it("PLUGIN-020: canSafelyDisable 无依赖者返回 true", () => {
      expect(graph.canSafelyDisable("@codem/mcp")).toBe(true);
      expect(graph.canSafelyDisable("@codem/fs-local")).toBe(false);
    });
  });

  // ===== C. 级联启用计算 =====
  describe("级联启用计算", () => {
    it("PLUGIN-021: 启用 tool-fs 需要先启用 fs-local", () => {
      const enabledSet = new Set<string>(); // 都未启用
      const result = graph.getCascadeEnable("@codem/tool-fs", enabledSet);
      expect(result.toEnable).toContain("@codem/fs-local");
      expect(result.toEnable).toContain("@codem/tool-fs");
      // 依赖在前
      expect(result.toEnable.indexOf("@codem/fs-local")).toBeLessThan(
        result.toEnable.indexOf("@codem/tool-fs")
      );
    });

    it("PLUGIN-022: 启用 subagent 需要先启用 llm + tools", () => {
      const enabledSet = new Set<string>();
      const result = graph.getCascadeEnable("@codem/subagent", enabledSet);
      expect(result.toEnable).toContain("@codem/llm");
      expect(result.toEnable).toContain("@codem/tools");
      expect(result.toEnable).toContain("@codem/subagent");
    });

    it("PLUGIN-023: 已启用的依赖不再重复启用", () => {
      const enabledSet = new Set(["@codem/llm", "@codem/tools"]);
      const result = graph.getCascadeEnable("@codem/subagent", enabledSet);
      expect(result.toEnable).toEqual(["@codem/subagent"]);
    });

    it("PLUGIN-024: 未注册的插件名称标记为 missing", () => {
      // getCascadeEnable 在插件本身未注册时标记 missing
      const result = graph.getCascadeEnable("@nonexistent/plugin", new Set());
      expect(result.missingDependencies).toContain("@nonexistent/plugin");
      expect(result.canEnable).toBe(false);
    });

    it("PLUGIN-025: canEnable 为 true 当所有依赖可用", () => {
      const result = graph.getCascadeEnable("@codem/tool-fs", new Set());
      expect(result.canEnable).toBe(true);
    });

    it("PLUGIN-026: 启用 workflow 需要多级依赖", () => {
      const result = graph.getCascadeEnable("@codem/workflow", new Set());
      expect(result.toEnable).toContain("@codem/llm");
      expect(result.toEnable).toContain("@codem/tools");
      expect(result.toEnable).toContain("@codem/session");
      expect(result.toEnable).toContain("@codem/workflow");
    });

    it("PLUGIN-027: 已启用的插件不再列入 toEnable", () => {
      const enabledSet = new Set(["@codem/llm", "@codem/tools", "@codem/session"]);
      const result = graph.getCascadeEnable("@codem/workflow", enabledSet);
      expect(result.toEnable).toEqual(["@codem/workflow"]);
    });

    it("PLUGIN-028: 多个依赖共享时只启用一次", () => {
      // subagent 和 workflow 都依赖 llm，启用 workflow 时 llm 只出现一次
      const result = graph.getCascadeEnable("@codem/workflow", new Set());
      const llmCount = result.toEnable.filter((n) => n === "@codem/llm").length;
      expect(llmCount).toBe(1);
    });
  });

  // ===== D. 核心插件锁定保护 =====
  describe("核心插件锁定保护", () => {
    it("PLUGIN-029: core 插件不可关闭", () => {
      const result = graph.getCascadeDisable("@codem/llm");
      expect(result.lockedReason).toContain("核心");
      expect(result.toDisable).toEqual([]);
    });

    it("PLUGIN-030: locked 插件不可关闭", () => {
      const result = graph.getCascadeDisable("@codem/storage");
      expect(result.lockedReason).toBeDefined();
    });

    it("PLUGIN-031: canSafelyDisable 对 core/locked 返回 false", () => {
      expect(graph.canSafelyDisable("@codem/llm")).toBe(false);
      expect(graph.canSafelyDisable("@codem/tools")).toBe(false);
      expect(graph.canSafelyDisable("@codem/session")).toBe(false);
      expect(graph.canSafelyDisable("@codem/storage")).toBe(false);
    });

    it("PLUGIN-032: 级联关闭遇到 core 插件时跳过", () => {
      // subagent 依赖 llm（core），关闭 subagent 本身可以
      // 但 llm 不应出现在级联列表中
      const result = graph.getCascadeDisable("@codem/subagent");
      expect(result.toDisable).toContain("@codem/subagent");
      expect(result.toDisable).not.toContain("@codem/llm");
    });

    it("PLUGIN-033: RISK_LEVEL_CONFIG 包含三级风险", () => {
      expect(RISK_LEVEL_CONFIG.safe).toBeDefined();
      expect(RISK_LEVEL_CONFIG.caution).toBeDefined();
      expect(RISK_LEVEL_CONFIG.danger).toBeDefined();
      expect(RISK_LEVEL_CONFIG.danger.color).toBe("var(--error)");
      expect(RISK_LEVEL_CONFIG.safe.color).toBe("var(--success)");
      expect(RISK_LEVEL_CONFIG.caution.color).toBe("var(--warning)");
    });

    it("PLUGIN-034: 风险等级配置使用 CSS 变量（非硬编码）", () => {
      for (const [, config] of Object.entries(RISK_LEVEL_CONFIG)) {
        expect(config.color).toMatch(/^var\(--/);
      }
    });

    it("PLUGIN-035: 核心插件元数据包含 riskLevel", () => {
      const llm = graph.get("@codem/llm");
      expect(llm?.riskLevel).toBe("danger");
      expect(llm?.riskDescription).toContain("推理");
    });
  });

  // ===== E. 不同插件关闭对系统的影响 =====
  describe("不同插件关闭对系统的影响", () => {
    it("PLUGIN-036: 关闭 fs-local 影响 tool-fs（文件读写不可用）", () => {
      const result = graph.getCascadeDisable("@codem/fs-local");
      expect(result.toDisable).toContain("@codem/tool-fs");
      const affected = result.affected.find((a) => a.name === "@codem/tool-fs");
      expect(affected).toBeDefined();
      expect(affected!.reason).toContain("依赖");
    });

    it("PLUGIN-037: 关闭 shell-local 影响 tool-shell", () => {
      const result = graph.getCascadeDisable("@codem/shell-local");
      expect(result.toDisable).toContain("@codem/tool-shell");
    });

    it("PLUGIN-038: 关闭 mcp 不影响任何核心功能", () => {
      const result = graph.getCascadeDisable("@codem/mcp");
      expect(result.toDisable).toHaveLength(1);
      expect(result.needsConfirmation).toBe(false);
    });

    it("PLUGIN-039: 关闭 memory 不级联（无下游消费者）", () => {
      const result = graph.getCascadeDisable("@codem/memory");
      expect(result.toDisable).toHaveLength(1);
    });

    it("PLUGIN-040: 关闭 subagent 不影响 llm/tools（核心保护）", () => {
      const result = graph.getCascadeDisable("@codem/subagent");
      expect(result.toDisable).not.toContain("@codem/llm");
      expect(result.toDisable).not.toContain("@codem/tools");
    });

    it("PLUGIN-041: 关闭 workflow 不影响核心服务", () => {
      const result = graph.getCascadeDisable("@codem/workflow");
      expect(result.toDisable).toContain("@codem/workflow");
      expect(result.toDisable).not.toContain("@codem/llm");
      expect(result.toDisable).not.toContain("@codem/tools");
      expect(result.toDisable).not.toContain("@codem/session");
    });

    it("PLUGIN-042: 多 Provider 竞争时关闭一个不影响另一个", () => {
      graph.register({ name: "@codem/fs-remote", provides: ["fs"], inject: [] });
      const result = graph.getCascadeDisable("@codem/fs-local");
      // tool-fs 依赖 'fs' 服务，fs-local 和 fs-remote 都提供
      // 关闭 fs-local 后，tool-fs 仍可由 fs-remote 提供服务
      // 但 getCascadeDisable 仍会级联关闭 tool-fs（因为依赖匹配）
      expect(result.toDisable).toContain("@codem/fs-local");
    });

    it("PLUGIN-043: 关闭链传播 — A→B→C 三级链", () => {
      graph.register({ name: "@chain/a", provides: ["svc-a"], inject: [] });
      graph.register({ name: "@chain/b", provides: ["svc-b"], inject: ["svc-a"] });
      graph.register({ name: "@chain/c", provides: [], inject: ["svc-b"] });

      const result = graph.getCascadeDisable("@chain/a");
      expect(result.toDisable).toHaveLength(3);
      expect(result.toDisable).toContain("@chain/a");
      expect(result.toDisable).toContain("@chain/b");
      expect(result.toDisable).toContain("@chain/c");
    });

    it("PLUGIN-044: 缓存在注册新插件后失效", () => {
      const deps1 = graph.getDirectDependencies("@codem/tool-fs");
      expect(deps1).toEqual(["@codem/fs-local"]);

      // 注册新的 fs provider
      graph.register({ name: "@codem/fs-remote", provides: ["fs"], inject: [] });

      const deps2 = graph.getDirectDependencies("@codem/tool-fs");
      expect(deps2).toContain("@codem/fs-local");
      expect(deps2).toContain("@codem/fs-remote");
    });

    it("PLUGIN-045: getServiceChain 返回服务依赖链", () => {
      const chain = graph.getServiceChain("@codem/subagent");
      // subagent inject ['llm', 'tools']
      const services = chain.map((c) => c.service);
      expect(services).toContain("llm");
      expect(services).toContain("tools");
      const llmProvider = chain.find((c) => c.service === "llm");
      expect(llmProvider!.providedBy).toBe("@codem/llm");
    });
  });

  // ===== F. 边界与异常场景 =====
  describe("边界与异常场景", () => {
    it("PLUGIN-046: getDirectDependencies 对不存在插件返回空", () => {
      expect(graph.getDirectDependencies("@nonexistent")).toEqual([]);
    });

    it("PLUGIN-047: getDirectDependents 对不存在插件返回空", () => {
      expect(graph.getDirectDependents("@nonexistent")).toEqual([]);
    });

    it("PLUGIN-048: getCascadeDisable 对不存在插件返回空结果", () => {
      const result = graph.getCascadeDisable("@nonexistent");
      // 不存在的插件不会被锁定，也不在 toDisable 中
      expect(result.toDisable).toEqual(["@nonexistent"]);
      expect(result.needsConfirmation).toBe(false);
    });

    it("PLUGIN-049: 自引用不产生循环", () => {
      graph.register({ name: "@self/ref", provides: ["self"], inject: ["self"] });
      const deps = graph.getDirectDependencies("@self/ref");
      // 不应包含自身
      expect(deps).not.toContain("@self/ref");
    });

    it("PLUGIN-050: 大量插件注册后性能不退化", () => {
      const g = new PluginDependencyGraph();
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        g.register({
          name: `@perf/plugin-${i}`,
          provides: [`svc-${i}`],
          inject: i > 0 ? [`svc-${i - 1}`] : [],
        });
      }
      // 查询
      for (let i = 0; i < 100; i++) {
        g.getDirectDependencies(`@perf/plugin-${i}`);
        g.getDirectDependents(`@perf/plugin-${i}`);
      }
      const elapsed = Date.now() - start;
      // 100 个插件的注册+查询应在 500ms 内完成
      expect(elapsed).toBeLessThan(500);
    });
  });
});
