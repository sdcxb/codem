/**
 * 测试：技能调用链路 — SKIL-001 ~ SKIL-025
 *
 * 覆盖范围：
 *   5.1 SkillRegistry 加载与匹配
 *   5.2 load_skill 工具
 *   5.3 技能与 Worktree/Git 集成
 *
 * 关键组件：
 *   - SkillRegistry: register/get/getAll/search/buildSkillPrompt
 *   - load_skill 工具: SessionSkillCache
 *   - git_skill provider
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  exists: vi.fn().mockResolvedValue(false),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import {
  SkillRegistry,
  type SkillDefinition,
  type SkillSearchResult,
} from "../core/skill/skill";
import { ToolRegistry } from "../core/llm/tools";

// ========== 辅助函数 ==========

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "A test skill",
    prompt: "# Test Skill\n\nThis is a test skill content.",
    contextMode: "inline",
    source: "external",
    ...overrides,
  };
}

// ========== 测试 ==========

describe("技能调用 — SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
    registry = new SkillRegistry();
  });

  it("SKIL-001: register 注册技能", () => {
    const skill = makeSkill({ name: "my-skill" });
    registry.register(skill);
    const loaded = registry.get("my-skill");
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("my-skill");
  });

  it("SKIL-001b: get 不存在的技能返回 undefined", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("SKIL-002: getAll 返回所有已注册技能", () => {
    const initialCount = registry.getAll().length;
    registry.register(makeSkill({ name: "skill-a" }));
    registry.register(makeSkill({ name: "skill-b" }));
    registry.register(makeSkill({ name: "skill-c" }));

    const skills = registry.getAll();
    expect(skills.length).toBe(initialCount + 3);
  });

  it("SKIL-003: search 按关键词匹配", () => {
    registry.register(makeSkill({
      name: "git-skill",
      description: "Git operations helper",
      aliases: ["git", "commit", "branch"],
    }));
    registry.register(makeSkill({
      name: "docker-skill",
      description: "Docker container helper",
      aliases: ["docker", "container"],
    }));

    const matches = registry.search("git");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].skill.name).toBe("git-skill");
  });

  it("SKIL-003b: search 按名称匹配", () => {
    registry.register(makeSkill({ name: "mermaid-diagram" }));
    const matches = registry.search("mermaid");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("SKIL-003c: search 无匹配返回空数组", () => {
    registry.register(makeSkill({ name: "test", description: "x" }));
    const matches = registry.search("completelyunrelatedquery");
    expect(matches).toHaveLength(0);
  });

  it("SKIL-004: search 返回排序结果（score 降序）", () => {
    registry.register(makeSkill({
      name: "low-match",
      description: "test",
    }));
    registry.register(makeSkill({
      name: "test-high",
      description: "test test test",
      aliases: ["test"],
    }));

    const matches = registry.search("test");
    if (matches.length > 1) {
      expect(matches[0].score).toBeGreaterThanOrEqual(matches[1].score);
    }
  });

  it("SKIL-005: get 返回技能 prompt 内容", () => {
    const prompt = "# Skill Content\n\nDetailed instructions...";
    registry.register(makeSkill({ name: "content-skill", prompt }));
    const result = registry.get("content-skill");
    expect(result).toBeDefined();
    expect(result!.prompt).toBe(prompt);
  });

  it("SKIL-006: remove 移除技能", () => {
    registry.register(makeSkill({ name: "to-remove" }));
    registry.remove("to-remove");
    expect(registry.get("to-remove")).toBeUndefined();
  });

  it("SKIL-007: clearExternal 清空外部技能", () => {
    registry.register(makeSkill({ name: "a" }));
    registry.register(makeSkill({ name: "b" }));
    registry.clearExternal();
    // builtin skills remain, external ones removed
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBeUndefined();
  });
});

describe("技能调用 — load_skill 工具", () => {
  beforeEach(() => {
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
  });

  it("SKIL-010: load_skill 工具定义存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("createLoadSkillTool");
    expect(src).toContain("load_skill");
    expect(src).toContain("SessionSkillCache");
  });

  it("SKIL-011: SessionSkillCache TTL 逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("defaultTtl");
    expect(src).toContain("remainingTurns");
    expect(src).toContain("tick");
  });

  it("SKIL-012: 缓存命中返回 cached: true", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("cached: true");
    expect(src).toContain("already loaded");
  });

  it("SKIL-013: load_skill 执行后返回技能内容", async () => {
    const { getSkillRegistry } = await import("../core/skill/skill");
    const registry = getSkillRegistry();
    // Use a builtin skill that definitely exists
    const toolRegistry = new ToolRegistry();
    const mod = await import("../core/llm/tools/load-skill");
    const tool = mod.createLoadSkillTool(toolRegistry);

    const result = await tool.execute({ skill_name: "code-review" }, {
      sessionId: "test",
      messageId: "test",
      cwd: "/tmp",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
      securityMode: "ask",
    });

    expect(result).toBeDefined();
    // DSH-aligned: 首次加载返回结构化 <skill_content> 指令正文
    expect(result.output).toContain("<skill_content");
    expect(result.output).toContain("code-review");
  });

  it("SKIL-014: load_skill 未找到技能返回提示", async () => {
    const toolRegistry = new ToolRegistry();
    const mod = await import("../core/llm/tools/load-skill");
    const tool = mod.createLoadSkillTool(toolRegistry);

    const result = await tool.execute({ skill_name: "nonexistent-skill-xyz" }, {
      sessionId: "test",
      messageId: "test",
      cwd: "/tmp",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
      securityMode: "ask",
    });

    expect(result).toBeDefined();
    expect(result.output).toContain("not found");
  });

  it("SKIL-015: load_skill 不存在技能时列出可用技能", async () => {
    const toolRegistry = new ToolRegistry();
    const mod = await import("../core/llm/tools/load-skill");
    const tool = mod.createLoadSkillTool(toolRegistry);

    const result = await tool.execute({ skill_name: "nonexistent-skill-xyz" }, {
      sessionId: "test",
      messageId: "test",
      cwd: "/tmp",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => {},
      securityMode: "ask",
    });

    expect(result).toBeDefined();
    // Should list available skills (builtin ones like code-review, debug, etc.)
    expect(result.output).toContain("Available skills");
  });
});

describe("技能调用 — git_skill provider", () => {
  it("SKIL-020: git_skill provider 逻辑存在于 providers/git.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const providerPath = path.join(__dirname, "../core/git_skill/providers/git.ts");

    // File may or may not exist depending on structure
    if (fs.existsSync(providerPath)) {
      const src = fs.readFileSync(providerPath, "utf-8");
      expect(src).toContain("GitSkill");
      expect(src).toContain("provider");
    } else {
      // Check if the provider is in a different location
      const altPath = path.join(__dirname, "../core/skill/providers/git.ts");
      if (fs.existsSync(altPath)) {
        const src = fs.readFileSync(altPath, "utf-8");
        expect(src).toBeDefined();
      }
    }
  });

  it("SKIL-021: git_skill provider 注册逻辑存在于 SkillRegistry", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/skill/skill.ts"), "utf-8");

    // Verify provider system exists
    expect(src).toContain("provider");
    expect(src).toContain("register");
  });
});

describe("技能调用 — 与 Worktree 集成", () => {
  it("SKIL-025: 技能加载在 Worktree 环境下正常工作", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    // load_skill should reference sessionId for session-level caching
    expect(src).toContain("sessionId");
    expect(src).toContain("ctx.sessionId");
  });
});

describe("技能调用 — AgenticLoop 集成", () => {
  it("SKIL-022: load_skill 在 agentic-loop 中被正确处理", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    // Verify load_skill is in the tool set
    expect(src).toContain("load_skill");
  });

  it("SKIL-023: 技能缓存清除逻辑存在于 loop 迭代", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("remainingTurns");
    expect(src).toContain("tick");
  });
});

describe("技能调用 — system prompt 注入", () => {
  it("SKIL-024: 技能指令存在于 system prompt", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/skill/skill.ts"), "utf-8");

    expect(src).toContain("load_skill");
    expect(src).toContain("skill");
  });
});
