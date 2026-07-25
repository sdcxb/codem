/**
 * 测试：系统提示词构建回归 — PROMPT-REG-001 ~ PROMPT-REG-015
 *
 * 验证 buildSystemPrompt 在各种配置组合下不崩溃，输出格式正确。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { buildSystemPrompt, type SystemPromptConfig } from "../core/prompt/prompt";
import { getAgentRegistry, type AgentDefinition } from "../core/agent/agent";
import { setLang } from "../core/i18n/lang";
import type { GitConfig, EnvironmentConfig } from "../core/settings/settings";
import type { AppIdentity, UserConfig } from "../core/types";

describe("系统提示词构建回归", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    setLang("en");
  });

  const buildAgent = getAgentRegistry().get("build")!;

  // ===== PROMPT-REG-001 ~ PROMPT-REG-005: 基本提示词结构 =====
  describe("基本提示词结构", () => {
    it("PROMPT-REG-001: build 智能体提示词完整", () => {
      const prompt = buildSystemPrompt({ agent: buildAgent });
      expect(prompt).toContain("# Identity");
      expect(prompt).toContain("# Formatting");
      expect(prompt).toContain("# Final Answer");
      expect(prompt).toContain("# Safety");
      expect(prompt).toContain("Engineering Approach");
    });

    it("PROMPT-REG-002: plan 模式提示词包含 Plan mode", () => {
      const planAgent: AgentDefinition = {
        ...buildAgent,
        id: "plan-test",
        collaborationMode: "plan",
      };
      const prompt = buildSystemPrompt({ agent: planAgent });
      expect(prompt).toContain("Plan mode");
    });

    it("PROMPT-REG-003: 默认模式提示词包含 Default mode", () => {
      const defaultAgent: AgentDefinition = {
        ...buildAgent,
        collaborationMode: "default",
      };
      const prompt = buildSystemPrompt({ agent: defaultAgent });
      expect(prompt).toContain("Default mode");
    });

    it("PROMPT-REG-004: 含 Git 配置时注入 Git Preferences", () => {
      const gitConfig: GitConfig = {
        branchPrefix: "feature/",
        mergeMethod: "squash",
        forcePush: false,
      };
      const prompt = buildSystemPrompt({ agent: buildAgent, gitConfig });
      expect(prompt).toContain("# Git Preferences");
      expect(prompt).toContain("feature/");
    });

    it("PROMPT-REG-005: 含环境配置时注入 Environment Scripts", () => {
      const envConfig: EnvironmentConfig = {
        setupScript: "install.sh",
      };
      const prompt = buildSystemPrompt({ agent: buildAgent, environmentConfig: envConfig });
      expect(prompt).toContain("# Environment Scripts");
      expect(prompt).toContain("install.sh");
    });
  });

  // ===== PROMPT-REG-006 ~ PROMPT-REG-010: 用户配置与语言 =====
  describe("用户配置与语言", () => {
    it("PROMPT-REG-006: 含用户配置时注入 Your Human", () => {
      const user: UserConfig = {
        name: "Alice",
        callBy: "Alice",
        pronouns: "she/her",
        timezone: "UTC+8",
        notes: "Prefers concise answers",
        context: "",
        raw: "",
      };
      const prompt = buildSystemPrompt({ agent: buildAgent, user });
      expect(prompt).toContain("# Your Human");
      expect(prompt).toContain("Alice");
      expect(prompt).toContain("UTC+8");
    });

    it("PROMPT-REG-007: 中文模式语言规则在最后", () => {
      setLang("zh");
      const prompt = buildSystemPrompt({ agent: buildAgent });
      // The last section should be the language rules
      const lastSection = prompt.split("---").pop()!.trim();
      expect(lastSection).toContain("语言规则");
    });

    it("PROMPT-REG-008: 英文模式语言规则在最后", () => {
      setLang("en");
      const prompt = buildSystemPrompt({ agent: buildAgent });
      const lastSection = prompt.split("---").pop()!.trim();
      expect(lastSection).toContain("Language Rules");
    });

    it("PROMPT-REG-009: 自定义智能体 prompt 被注入", () => {
      const customAgent: AgentDefinition = {
        id: "custom-prompt-test",
        name: "Custom",
        description: "Test",
        mode: "subagent",
        prompt: "UNIQUE_CUSTOM_MARKER_XYZ_12345",
        permissions: [{ tool: "*", action: "allow" }],
      };
      const prompt = buildSystemPrompt({ agent: customAgent });
      expect(prompt).toContain("UNIQUE_CUSTOM_MARKER_XYZ_12345");
    });

    it("PROMPT-REG-010: system-reminder 标签被过滤", () => {
      const customAgent: AgentDefinition = {
        ...buildAgent,
        prompt: 'Normal prompt <system-reminder>Secret instruction</system-reminder> end',
      };
      const prompt = buildSystemPrompt({ agent: customAgent });
      expect(prompt).not.toContain("<system-reminder>");
      expect(prompt).not.toContain("Secret instruction");
      expect(prompt).toContain("Normal prompt");
      expect(prompt).toContain("end");
    });
  });

  // ===== PROMPT-REG-011 ~ PROMPT-REG-015: 环境信息与边界情况 =====
  describe("环境信息与边界情况", () => {
    it("PROMPT-REG-011: 工作目录注入正确", () => {
      const prompt = buildSystemPrompt({
        agent: buildAgent,
        workingDirectory: "D:\\projects\\myapp",
      });
      expect(prompt).toContain("Working directory:");
      expect(prompt).toContain("D:\\projects\\myapp");
    });

    it("PROMPT-REG-012: Git 分支注入正确", () => {
      const prompt = buildSystemPrompt({
        agent: buildAgent,
        gitBranch: "feature/test-branch",
      });
      expect(prompt).toContain("Git branch:");
      expect(prompt).toContain("feature/test-branch");
    });

    it("PROMPT-REG-013: 模型信息注入正确", () => {
      const prompt = buildSystemPrompt({
        agent: buildAgent,
        modelInfo: "gpt-4o-2024",
      });
      expect(prompt).toContain("Model:");
      expect(prompt).toContain("gpt-4o-2024");
    });

    it("PROMPT-REG-014: 知识笔记本模式注入", () => {
      const prompt = buildSystemPrompt({
        agent: buildAgent,
        knowledgeContext: {
          notebookName: "项目文档",
          notebookDescription: "项目技术文档",
          sourceCount: 10,
          chunkCount: 50,
        },
      });
      expect(prompt).toContain("Knowledge Notebook Mode");
      expect(prompt).toContain("项目文档");
    });

    it("PROMPT-REG-015: 空配置不崩溃", () => {
      // Only agent is required, everything else undefined
      expect(() => buildSystemPrompt({ agent: buildAgent })).not.toThrow();
      const prompt = buildSystemPrompt({ agent: buildAgent });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(100);
    });
  });
});
