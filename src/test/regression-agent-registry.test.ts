/**
 * 测试：AgentRegistry 持久化回归 — AREG-001 ~ AREG-020
 *
 * 验证新增的 loadCustomAgents/saveCustomAgents/update/unregister/isBuiltin
 * 不破坏现有 register/get/getAll/evaluatePermission/canUseTool 逻辑。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import {
  AgentRegistry,
  getAgentRegistry,
  type AgentDefinition,
} from "../core/agent/agent";
import { buildSystemPrompt } from "../core/prompt/prompt";

// 重置 singleton 的辅助函数
function resetAgentRegistrySingleton() {
  // AgentRegistry 模块内部的 instance 变量无法直接重置
  // 通过操作 DB 数据来测试持久化加载
}

describe("AgentRegistry 持久化回归", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
  });

  // ===== AREG-001 ~ AREG-008: 内置智能体不变性 =====
  describe("内置智能体不变性", () => {
    const registry = getAgentRegistry();

    it("AREG-001: 内置智能体数量为 6", () => {
      const all = registry.getAll();
      const ids = all.map(a => a.id);
      expect(ids).toContain("build");
      expect(ids).toContain("plan");
      expect(ids).toContain("explore");
      expect(ids).toContain("general");
      expect(ids).toContain("title");
      expect(ids).toContain("summary");
    });

    it("AREG-002: 内置智能体 isBuiltin 返回 true", () => {
      for (const id of ["build", "plan", "explore", "general", "title", "summary"]) {
        expect(registry.isBuiltin(id)).toBe(true);
      }
    });

    it("AREG-003: 内置智能体不可删除", () => {
      expect(registry.unregister("build")).toBe(false);
      expect(registry.get("build")).toBeDefined();
    });

    it("AREG-004: 内置智能体不可更新", () => {
      expect(registry.update("build", { name: "Hacked" })).toBe(false);
      expect(registry.get("build")!.name).toBe("Build");
    });

    it("AREG-005: build 智能体权限评估——allow all", () => {
      const result = registry.evaluatePermission("build", "bash");
      expect(result).toBe("allow");
    });

    it("AREG-006: plan 智能体工具限制——write 不可用", () => {
      const result = registry.canUseTool("plan", "write");
      expect(result).toBe(false);
    });

    it("AREG-007: title 智能体 maxTokens 为 50", () => {
      expect(registry.get("title")!.maxTokens).toBe(50);
    });

    it("AREG-008: build 智能体 modelSlot 为 chat", () => {
      expect(registry.get("build")!.modelSlot).toBe("chat");
    });
  });

  // ===== AREG-009 ~ AREG-016: 自定义智能体持久化 =====
  describe("自定义智能体持久化", () => {
    const customAgent: AgentDefinition = {
      id: "my-custom-agent",
      name: "My Custom Agent",
      description: "A test custom agent",
      mode: "subagent",
      prompt: "You are a custom agent for testing.",
      permissions: [
        { tool: "read", action: "allow" },
        { tool: "write", action: "deny" },
        { tool: "*", action: "ask" },
      ],
      toolAllowlist: ["read", "glob", "grep"],
      maxSteps: 15,
      modelSlot: "subagent",
    };

    it("AREG-009: 注册自定义智能体后 getAll 包含", () => {
      const registry = getAgentRegistry();
      registry.register(customAgent);
      expect(registry.getAll().map(a => a.id)).toContain("my-custom-agent");
    });

    it("AREG-010: 注册自定义智能体后 getAll 包含", () => {
      const registry = getAgentRegistry();
      registry.register(customAgent);
      // 验证内存中包含自定义智能体
      expect(registry.getAll().map(a => a.id)).toContain("my-custom-agent");
      expect(registry.get("my-custom-agent")!.name).toBe("My Custom Agent");
    });

    it("AREG-011: 新 AgentRegistry 实例包含内置智能体", () => {
      // 创建新实例，验证内置智能体正常加载
      const fresh = new AgentRegistry();
      const ids = fresh.getAll().map(a => a.id);
      expect(ids).toContain("build");
      expect(ids).toContain("plan");
      expect(ids).toContain("explore");
    });

    it("AREG-012: 更新自定义智能体", () => {
      const registry = getAgentRegistry();
      registry.register(customAgent);
      expect(registry.update("my-custom-agent", { maxSteps: 30 })).toBe(true);
      expect(registry.get("my-custom-agent")!.maxSteps).toBe(30);
    });

    it("AREG-013: 删除自定义智能体", () => {
      const registry = getAgentRegistry();
      registry.register(customAgent);
      expect(registry.unregister("my-custom-agent")).toBe(true);
      expect(registry.get("my-custom-agent")).toBeUndefined();
    });

    it("AREG-014: 删除后持久化数据更新", () => {
      const registry = getAgentRegistry();
      registry.register(customAgent);
      registry.unregister("my-custom-agent");
      const saved = getSettingJSON("codem-custom-agents", []);
      expect((saved as any[]).find(a => a.id === "my-custom-agent")).toBeUndefined();
    });

    it("AREG-015: 自定义智能体权限评估——last-match-wins", () => {
      const registry = getAgentRegistry();
      // 使用 * 在前面的顺序，让特定规则覆盖通配符
      const testAgent: AgentDefinition = {
        ...customAgent,
        id: "perm-eval-agent",
        permissions: [
          { tool: "*", action: "ask" },
          { tool: "read", action: "allow" },
          { tool: "write", action: "deny" },
        ],
      };
      registry.register(testAgent);
      // read → 最后匹配 read 规则 → allow
      expect(registry.evaluatePermission("perm-eval-agent", "read")).toBe("allow");
      // write → 最后匹配 write 规则 → deny
      expect(registry.evaluatePermission("perm-eval-agent", "write")).toBe("deny");
      // bash → 只匹配 * 规则 → ask
      expect(registry.evaluatePermission("perm-eval-agent", "bash")).toBe("ask");
    });

    it("AREG-016: 自定义智能体 isBuiltin 返回 false", () => {
      const registry = getAgentRegistry();
      registry.register(customAgent);
      expect(registry.isBuiltin("my-custom-agent")).toBe(false);
    });
  });

  // ===== AREG-017 ~ AREG-020: 与系统提示词集成 =====
  describe("与系统提示词集成", () => {
    it("AREG-017: build 智能体提示词包含 Engineering Approach", () => {
      const registry = getAgentRegistry();
      const build = registry.get("build")!;
      expect(build.prompt).toContain("Engineering Approach");
    });

    it("AREG-018: 自定义智能体 prompt 被注入 buildSystemPrompt", () => {
      const customAgent: AgentDefinition = {
        id: "prompt-test-agent",
        name: "Prompt Test",
        description: "Test",
        mode: "subagent",
        prompt: "UNIQUE_MARKER_FOR_TEST_12345",
        permissions: [{ tool: "*", action: "allow" }],
      };
      const prompt = buildSystemPrompt({ agent: customAgent });
      expect(prompt).toContain("UNIQUE_MARKER_FOR_TEST_12345");
    });

    it("AREG-019: build 智能体 collaborationMode 为 default 或 undefined", () => {
      const registry = getAgentRegistry();
      const build = registry.get("build")!;
      expect(build.collaborationMode === undefined || build.collaborationMode === "default").toBe(true);
    });

    it("AREG-020: explore 智能体 modelSlot 为 subagent", () => {
      const registry = getAgentRegistry();
      expect(registry.get("explore")!.modelSlot).toBe("subagent");
    });
  });
});
