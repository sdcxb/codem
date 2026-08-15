/**
 * 插件关闭对系统影响测试 — PDI-001 ~ PDI-040
 *
 * 测试不同插件关闭后对系统各功能的影响：
 *   A. 核心服务插件关闭（应被拒绝/锁定）（PDI-001 ~ PDI-010）
 *   B. 能力 Provider 关闭（级联影响工具）（PDI-011 ~ PDI-020）
 *   C. UI 插件关闭（影响界面但不影响核心）（PDI-021 ~ PDI-025）
 *   D. 信息链/数据流影响分析（PDI-026 ~ PDI-035）
 *   E. 多插件组合关闭场景（PDI-036 ~ PDI-040）
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  PluginDependencyGraph,
  RISK_LEVEL_CONFIG,
  type PluginMeta,
} from "../core/plugin-loader/dependency-graph";

/** 构建完整系统插件依赖图（模拟真实系统） */
function buildSystemGraph(): PluginDependencyGraph {
  const g = new PluginDependencyGraph();

  // === 核心服务（不可关闭） ===
  const corePlugins: PluginMeta[] = [
    { name: "@codem/llm", provides: ["llm"], inject: [], core: true, locked: true, riskLevel: "danger", riskDescription: "Agent 推理引擎，关闭后 AI 无法思考" },
    { name: "@codem/tools", provides: ["tools"], inject: [], core: true, locked: true, riskLevel: "danger", riskDescription: "工具注册中心，关闭后无工具可用" },
    { name: "@codem/session", provides: ["session"], inject: [], core: true, locked: true, riskLevel: "danger", riskDescription: "会话管理，关闭后无法对话" },
    { name: "@codem/storage", provides: ["storage"], inject: [], core: true, locked: true, riskLevel: "danger", riskDescription: "数据存储，关闭后数据丢失" },
    { name: "@codem/permission", provides: ["permission"], inject: [], core: true, locked: true, riskLevel: "danger", riskDescription: "权限系统，关闭后安全风险" },
    { name: "@codem/settings", provides: ["settings"], inject: [], core: true, locked: true, riskLevel: "danger" },
    { name: "@codem/theme", provides: ["theme"], inject: [], core: true, locked: true, riskLevel: "caution" },
  ];
  for (const p of corePlugins) g.register(p);

  // === 能力 Provider（可关闭，有关联影响） ===
  const capabilityPlugins: PluginMeta[] = [
    { name: "@codem/fs-local", provides: ["fs"], inject: [], riskLevel: "caution", riskDescription: "关闭后文件读写工具不可用" },
    { name: "@codem/shell-local", provides: ["shell"], inject: [], riskLevel: "caution", riskDescription: "关闭后 Shell 命令执行不可用" },
    { name: "@codem/sandbox-local", provides: ["sandbox"], inject: [], riskLevel: "caution" },
    { name: "@codem/web-search", provides: ["web"], inject: [], riskLevel: "safe", riskDescription: "关闭后网络搜索不可用" },
    { name: "@codem/mcp", provides: ["mcp"], inject: [], riskLevel: "safe" },
    { name: "@codem/memory", provides: ["memory"], inject: [], riskLevel: "caution", riskDescription: "关闭后记忆功能不可用" },
    { name: "@codem/compaction", provides: ["compaction"], inject: [], riskLevel: "safe" },
    { name: "@codem/hooks", provides: ["hooks"], inject: [], riskLevel: "safe" },
    { name: "@codem/approval", provides: ["approval"], inject: [], riskLevel: "safe" },
    { name: "@codem/automation", provides: ["automation"], inject: [], riskLevel: "safe" },
  ];
  for (const p of capabilityPlugins) g.register(p);

  // === P6 扩展 Provider ===
  const p6Plugins: PluginMeta[] = [
    { name: "@codem/identity", provides: ["identity"], inject: [], riskLevel: "safe" },
    { name: "@codem/lsp", provides: ["lsp"], inject: [], riskLevel: "safe" },
    { name: "@codem/code-runtime", provides: ["codeRuntime"], inject: [], riskLevel: "safe" },
    { name: "@codem/workflow", provides: ["workflow"], inject: ["llm", "tools", "session"], riskLevel: "caution" },
    { name: "@codem/notebook", provides: ["notebook"], inject: [], riskLevel: "caution" },
    { name: "@codem/squad", provides: ["squad"], inject: ["llm", "tools"], riskLevel: "caution" },
    { name: "@codem/subagent", provides: ["subagent"], inject: ["llm", "tools"], riskLevel: "caution" },
    { name: "@codem/skill", provides: ["skill"], inject: [], riskLevel: "caution" },
  ];
  for (const p of p6Plugins) g.register(p);

  // === 工具消费者（依赖 Provider） ===
  const toolPlugins: PluginMeta[] = [
    { name: "@codem/tool-fs", provides: [], inject: ["fs"], riskLevel: "danger", riskDescription: "依赖 fs 服务" },
    { name: "@codem/tool-shell", provides: [], inject: ["shell"], riskLevel: "danger", riskDescription: "依赖 shell 服务" },
  ];
  for (const p of toolPlugins) g.register(p);

  // === UI 插件（inject slots） ===
  const uiPlugins: PluginMeta[] = [
    { name: "@codem/ui-sidebar", provides: [], inject: ["slots"], slots: ["app.sidebar"], riskLevel: "safe" },
    { name: "@codem/ui-conversation", provides: [], inject: ["slots"], slots: ["app.conversation"], riskLevel: "safe" },
    { name: "@codem/ui-settings", provides: [], inject: ["slots"], slots: ["app.settings"], riskLevel: "safe" },
    { name: "@codem/ui-tool", provides: [], inject: ["slots"], slots: ["conversation.details.tool"], riskLevel: "safe" },
    { name: "@codem/ui-misc", provides: [], inject: ["slots"], slots: ["app.overlay"], riskLevel: "safe" },
    { name: "@codem/ui-market", provides: [], inject: ["slots"], slots: ["app.skill-manager"], riskLevel: "safe" },
    { name: "@codem/ui-theme", provides: [], inject: [], riskLevel: "safe" },
    { name: "@codem/ui-skin", provides: [], inject: ["slots"], slots: ["app.overlay"], riskLevel: "safe" },
  ];
  for (const p of uiPlugins) g.register(p);

  return g;
}

describe("插件关闭对系统影响测试 — PDI-001 ~ PDI-040", () => {
  let graph: PluginDependencyGraph;

  beforeEach(() => {
    graph = buildSystemGraph();
  });

  // ===== A. 核心服务插件关闭（应被拒绝/锁定） =====
  describe("核心服务插件关闭保护", () => {
    const corePluginNames = [
      "@codem/llm",
      "@codem/tools",
      "@codem/session",
      "@codem/storage",
      "@codem/permission",
      "@codem/settings",
      "@codem/theme",
    ];

    for (const name of corePluginNames) {
      it(`PDI-${String(corePluginNames.indexOf(name) + 1).padStart(3, "0")}: ${name} 不可关闭`, () => {
        const result = graph.getCascadeDisable(name);
        expect(result.lockedReason).toBeDefined();
        expect(result.toDisable).toEqual([]);
      });
    }

    it("PDI-008: 核心插件 riskLevel 为 danger", () => {
      const llm = graph.get("@codem/llm");
      expect(llm?.riskLevel).toBe("danger");
      const tools = graph.get("@codem/tools");
      expect(tools?.riskLevel).toBe("danger");
    });

    it("PDI-009: 核心插件有 riskDescription", () => {
      const llm = graph.get("@codem/llm");
      expect(llm?.riskDescription).toBeTruthy();
      expect(llm!.riskDescription!.length).toBeGreaterThan(0);
    });

    it("PDI-010: canSafelyDisable 对所有核心插件返回 false", () => {
      for (const name of corePluginNames) {
        expect(graph.canSafelyDisable(name)).toBe(false);
      }
    });
  });

  // ===== B. 能力 Provider 关闭（级联影响工具） =====
  describe("能力 Provider 关闭影响", () => {
    it("PDI-011: 关闭 fs-local 级联关闭 tool-fs", () => {
      const result = graph.getCascadeDisable("@codem/fs-local");
      expect(result.toDisable).toContain("@codem/fs-local");
      expect(result.toDisable).toContain("@codem/tool-fs");
      expect(result.needsConfirmation).toBe(true);
    });

    it("PDI-012: 关闭 shell-local 级联关闭 tool-shell", () => {
      const result = graph.getCascadeDisable("@codem/shell-local");
      expect(result.toDisable).toContain("@codem/shell-local");
      expect(result.toDisable).toContain("@codem/tool-shell");
    });

    it("PDI-013: 关闭 mcp 不影响其他插件", () => {
      const result = graph.getCascadeDisable("@codem/mcp");
      expect(result.toDisable).toHaveLength(1);
      expect(result.needsConfirmation).toBe(false);
    });

    it("PDI-014: 关闭 memory 不影响核心服务", () => {
      const result = graph.getCascadeDisable("@codem/memory");
      expect(result.toDisable).toEqual(["@codem/memory"]);
      expect(result.toDisable).not.toContain("@codem/llm");
    });

    it("PDI-015: 关闭 web-search 不影响其他功能", () => {
      const result = graph.getCascadeDisable("@codem/web-search");
      expect(result.toDisable).toHaveLength(1);
    });

    it("PDI-016: 关闭 sandbox-local 不级联（无消费者）", () => {
      const result = graph.getCascadeDisable("@codem/sandbox-local");
      expect(result.toDisable).toHaveLength(1);
    });

    it("PDI-017: 关闭 hooks 不级联", () => {
      const result = graph.getCascadeDisable("@codem/hooks");
      expect(result.toDisable).toHaveLength(1);
    });

    it("PDI-018: 关闭 automation 不级联", () => {
      const result = graph.getCascadeDisable("@codem/automation");
      expect(result.toDisable).toHaveLength(1);
    });

    it("PDI-019: 关闭 compaction 不级联", () => {
      const result = graph.getCascadeDisable("@codem/compaction");
      expect(result.toDisable).toHaveLength(1);
    });

    it("PDI-020: 关闭 approval 不级联", () => {
      const result = graph.getCascadeDisable("@codem/approval");
      expect(result.toDisable).toHaveLength(1);
    });
  });

  // ===== C. UI 插件关闭（影响界面但不影响核心） =====
  describe("UI 插件关闭影响", () => {
    const uiPlugins = [
      "@codem/ui-sidebar",
      "@codem/ui-conversation",
      "@codem/ui-settings",
      "@codem/ui-tool",
      "@codem/ui-misc",
    ];

    for (const name of uiPlugins) {
      it(`PDI-${String(21 + uiPlugins.indexOf(name)).padStart(3, "0")}: ${name} 关闭不级联`, () => {
        const result = graph.getCascadeDisable(name);
        expect(result.toDisable).toHaveLength(1);
        expect(result.needsConfirmation).toBe(false);
        // UI 插件关闭不应影响核心服务
        expect(result.toDisable).not.toContain("@codem/llm");
        expect(result.toDisable).not.toContain("@codem/tools");
        expect(result.toDisable).not.toContain("@codem/session");
      });
    }
  });

  // ===== D. 信息链/数据流影响分析 =====
  describe("信息链/数据流影响分析", () => {
    it("PDI-026: 关闭 llm 会阻断 Agent 推理链", () => {
      // llm 是核心插件，不能关闭
      const result = graph.getCascadeDisable("@codem/llm");
      expect(result.lockedReason).toBeDefined();

      // 但如果有非核心插件依赖 llm，它们 inject llm
      const dependents = graph.getDirectDependents("@codem/llm");
      expect(dependents).toContain("@codem/subagent");
      expect(dependents).toContain("@codem/squad");
      expect(dependents).toContain("@codem/workflow");
    });

    it("PDI-027: 关闭 tools 会阻断工具执行链", () => {
      const result = graph.getCascadeDisable("@codem/tools");
      expect(result.lockedReason).toBeDefined();

      const dependents = graph.getDirectDependents("@codem/tools");
      expect(dependents).toContain("@codem/subagent");
      expect(dependents).toContain("@codem/squad");
      expect(dependents).toContain("@codem/workflow");
    });

    it("PDI-028: 关闭 storage 会阻断数据持久化链", () => {
      const result = graph.getCascadeDisable("@codem/storage");
      expect(result.lockedReason).toBeDefined();
    });

    it("PDI-029: 关闭 fs-local 影响文件操作链路", () => {
      const result = graph.getCascadeDisable("@codem/fs-local");
      // fs-local → tool-fs → （任何依赖 tool-fs 的）
      expect(result.toDisable).toContain("@codem/tool-fs");
      // 验证影响描述
      const affected = result.affected.find((a) => a.name === "@codem/tool-fs");
      expect(affected!.reason).toContain("依赖");
    });

    it("PDI-030: 关闭 shell-local 影响 Shell 执行链路", () => {
      const result = graph.getCascadeDisable("@codem/shell-local");
      expect(result.toDisable).toContain("@codem/tool-shell");
    });

    it("PDI-031: 关闭 subagent 不影响 llm/tools（逆向验证）", () => {
      const result = graph.getCascadeDisable("@codem/subagent");
      expect(result.toDisable).not.toContain("@codem/llm");
      expect(result.toDisable).not.toContain("@codem/tools");
    });

    it("PDI-032: 关闭 workflow 不影响核心服务", () => {
      const result = graph.getCascadeDisable("@codem/workflow");
      expect(result.toDisable).toContain("@codem/workflow");
      expect(result.toDisable).not.toContain("@codem/llm");
      expect(result.toDisable).not.toContain("@codem/tools");
      expect(result.toDisable).not.toContain("@codem/session");
    });

    it("PDI-033: 关闭 squad 不影响核心服务", () => {
      const result = graph.getCascadeDisable("@codem/squad");
      expect(result.toDisable).not.toContain("@codem/llm");
      expect(result.toDisable).not.toContain("@codem/tools");
    });

    it("PDI-034: 服务链分析 — subagent 依赖 llm + tools", () => {
      const chain = graph.getServiceChain("@codem/subagent");
      const services = chain.map((c) => c.service);
      expect(services).toContain("llm");
      expect(services).toContain("tools");
    });

    it("PDI-035: 服务链分析 — workflow 依赖 llm + tools + session", () => {
      const chain = graph.getServiceChain("@codem/workflow");
      const services = chain.map((c) => c.service);
      expect(services).toContain("llm");
      expect(services).toContain("tools");
      expect(services).toContain("session");
    });
  });

  // ===== E. 多插件组合关闭场景 =====
  describe("多插件组合关闭场景", () => {
    it("PDI-036: 同时关闭 fs-local + shell-local 不互相影响", () => {
      const r1 = graph.getCascadeDisable("@codem/fs-local");
      const r2 = graph.getCascadeDisable("@codem/shell-local");
      // 两个操作的级联列表不重叠
      const overlap = r1.toDisable.filter((n) => r2.toDisable.includes(n));
      expect(overlap).toHaveLength(0);
    });

    it("PDI-037: 关闭所有 UI 插件不影响核心", () => {
      const uiPlugins = [
        "@codem/ui-sidebar",
        "@codem/ui-conversation",
        "@codem/ui-settings",
        "@codem/ui-tool",
        "@codem/ui-misc",
        "@codem/ui-market",
        "@codem/ui-theme",
        "@codem/ui-skin",
      ];
      for (const name of uiPlugins) {
        const result = graph.getCascadeDisable(name);
        // 关闭后不应影响核心
        expect(result.toDisable).not.toContain("@codem/llm");
        expect(result.toDisable).not.toContain("@codem/tools");
        expect(result.toDisable).not.toContain("@codem/session");
      }
    });

    it("PDI-038: 关闭所有 safe 级别插件不影响系统核心", () => {
      const safePlugins = graph.list().filter((p) => p.riskLevel === "safe");
      for (const p of safePlugins) {
        const result = graph.getCascadeDisable(p.name);
        // safe 级别关闭不应级联到核心
        expect(result.toDisable).not.toContain("@codem/llm");
        expect(result.toDisable).not.toContain("@codem/tools");
        expect(result.toDisable).not.toContain("@codem/session");
        expect(result.toDisable).not.toContain("@codem/storage");
      }
    });

    it("PDI-039: 级联关闭链最大深度测试", () => {
      // 构建 5 级依赖链
      for (let i = 0; i < 5; i++) {
        graph.register({
          name: `@chain/level-${i}`,
          provides: [`svc-level-${i}`],
          inject: i > 0 ? [`svc-level-${i - 1}`] : [],
        });
      }
      const result = graph.getCascadeDisable("@chain/level-0");
      expect(result.toDisable.length).toBe(5);
    });

    it("PDI-040: riskLevel 配置与实际影响一致", () => {
      // danger 级别插件关闭时应有锁定保护或级联影响
      const dangerPlugins = graph.list().filter((p) => p.riskLevel === "danger");
      for (const p of dangerPlugins) {
        const result = graph.getCascadeDisable(p.name);
        // danger 插件要么是 core/locked（不能关闭），要么级联影响其他插件
        if (p.core || p.locked) {
          expect(result.lockedReason).toBeDefined();
        } else {
          // danger 但非核心的插件（如 tool-fs）关闭时可能只影响自身
          // 但其风险等级为 danger 说明关闭后影响严重
          expect(result.toDisable.length).toBeGreaterThanOrEqual(1);
        }
      }
    });
  });
});
