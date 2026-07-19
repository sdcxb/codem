/**
 * 测试：技能触发机制三层改造
 *
 * 本文件验证本轮技能触发机制改造的所有改动：
 *
 * ═══════════════════════════════════════════════════════════
 * A. buildSkillPrompt — Skills First Principle 强制指令
 *    - 无参数时包含 CRITICAL/MUST/BEFORE 等强制语义
 *    - 技能列表格式正确（name/description/aliases/tools）
 *    - 禁用技能被过滤
 *    - 空技能列表返回空字符串
 *
 * B. buildSkillPrompt(userSelectedSkills) — 用户显式选择
 *    - 选中技能标记 🎯 [USER SELECTED]
 *    - 包含 "You MUST load and prioritize" 强制指令
 *    - 未选中技能不标记
 *    - 多选/部分选/全选枚举
 *
 * C. forcePreload + buildPreloadedSkillPrompt
 *    - SKILL.md frontmatter 的 forcePreload: true 被解析
 *    - forcePreload 技能的完整 prompt 被包含在输出中
 *    - 非 forcePreload 技能不被预加载
 *    - 空时返回空字符串
 *
 * D. buildSystemPromptAsync 数据流
 *    - userSelectedSkills 传递到 buildSkillPrompt
 *    - preloadedSkillPrompt 被拼接到系统提示词
 *    - 系统提示词同时包含 Skills First Principle + 预加载指令
 *
 * E. process options 数据流
 *    - options.userSelectedSkills 被传递到 buildSystemPromptAsync
 *    - 不传 userSelectedSkills 时正常工作（向后兼容）
 *
 * F. SKILL.md 文件验证
 *    - prompt-optimization 技能有 forcePreload: true
 *    - 解析后 SkillDefinition.forcePreload === true
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  SkillRegistry,
  getSkillRegistry,
  parseSkillMarkdown,
  type SkillDefinition,
} from "../core/skill/skill";
import { setSettingJSON } from "../core/storage/settings";
import { initDatabase } from "../core/storage/database";

// ========== 辅助函数 ==========

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "A test skill for unit testing",
    prompt: "Test skill instructions here.",
    contextMode: "inline",
    source: "external",
    enabled: true,
    ...overrides,
  };
}

/** 创建一个干净的 SkillRegistry 实例（不影响单例） */
function createFreshRegistry(): SkillRegistry {
  return new SkillRegistry();
}

// ========== 测试套件 ==========

describe("技能触发机制三层改造", () => {
  beforeEach(async () => {
    localStorage.clear();
    await initDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════
  // A. buildSkillPrompt — Skills First Principle 强制指令
  // ═══════════════════════════════════════════════════════════
  describe("A. buildSkillPrompt — Skills First Principle", () => {
    it("包含 CRITICAL 强制语义", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("CRITICAL");
      expect(prompt).toContain("Skills First Principle");
    });

    it("包含 MUST load BEFORE 强制指令", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("MUST load and use it BEFORE");
    });

    it("包含 4 步工作流", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("Check Available Skills");
      expect(prompt).toContain("Match Task to Skill");
      expect(prompt).toContain("Follow Skill Instructions");
      expect(prompt).toContain("Only Fall Back if No Match");
    });

    it("包含 When in doubt 鼓励策略", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("When in doubt, load the skill");
    });

    it("包含 load_skill 工具调用说明", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("load_skill(skill_name=");
    });

    it("技能列表包含内置技能", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      // 内置技能：code-review, refactor, debug, document, test
      expect(prompt).toContain("code-review");
      expect(prompt).toContain("refactor");
      expect(prompt).toContain("debug");
    });

    it("技能列表包含 description", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("Perform a thorough code review");
    });

    it("技能列表包含 aliases", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("aliases: review, cr");
    });

    it("禁用技能被过滤", () => {
      setSettingJSON("codem-disabled-skills", ["code-review"]);
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt();
      expect(prompt).not.toContain("**code-review**");
      // 其他技能仍在
      expect(prompt).toContain("refactor");
    });

    it("空技能列表返回空字符串", () => {
      const reg = createFreshRegistry();
      // 动态获取所有内置技能名并禁用
      const allNames = reg.getAll().map(s => s.name);
      setSettingJSON("codem-disabled-skills", allNames);
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toBe("");
    });

    it("外部注册的技能出现在列表中", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({ name: "my-custom-skill", description: "Custom skill" }));
      const prompt = reg.buildSkillPrompt();
      expect(prompt).toContain("my-custom-skill");
      expect(prompt).toContain("Custom skill");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. buildSkillPrompt(userSelectedSkills) — 用户显式选择
  // ═══════════════════════════════════════════════════════════
  describe("B. buildSkillPrompt(userSelectedSkills) — 用户显式选择", () => {
    it("选中技能标记 🎯 [USER SELECTED]", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(["code-review"]);
      expect(prompt).toContain("**code-review**");
      // 在 code-review 行附近有 🎯 标记
      const reviewLine = prompt.split("\n").find(l => l.includes("**code-review**"));
      expect(reviewLine).toBeDefined();
      expect(reviewLine!).toContain("🎯 [USER SELECTED]");
    });

    it("包含 User-Selected Skills 强制指令", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(["code-review"]);
      expect(prompt).toContain("User-Selected Skills");
      expect(prompt).toContain("MUST load and prioritize");
    });

    it("未选中技能不被标记", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(["code-review"]);
      const refactorLine = prompt.split("\n").find(l => l.includes("**refactor**"));
      expect(refactorLine).toBeDefined();
      expect(refactorLine!).not.toContain("🎯");
    });

    it("多选时多个技能被标记", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(["code-review", "refactor", "debug"]);
      const reviewLine = prompt.split("\n").find(l => l.includes("**code-review**"));
      const refactorLine = prompt.split("\n").find(l => l.includes("**refactor**"));
      const debugLine = prompt.split("\n").find(l => l.includes("**debug**"));
      expect(reviewLine!).toContain("🎯");
      expect(refactorLine!).toContain("🎯");
      expect(debugLine!).toContain("🎯");
    });

    it("部分选时只有选中的被标记", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(["debug"]);
      const debugLine = prompt.split("\n").find(l => l.includes("**debug**"));
      const reviewLine = prompt.split("\n").find(l => l.includes("**code-review**"));
      expect(debugLine!).toContain("🎯");
      expect(reviewLine!).not.toContain("🎯");
    });

    it("全选时所有技能被标记", () => {
      const reg = createFreshRegistry();
      const allNames = reg.getAll().map(s => s.name);
      const prompt = reg.buildSkillPrompt(allNames);
      for (const name of allNames) {
        const line = prompt.split("\n").find(l => l.includes(`**${name}**`));
        expect(line!).toContain("🎯");
      }
    });

    it("传入不存在的技能名不报错（无标记效果）", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(["nonexistent-skill"]);
      // 不包含 User-Selected 指令（因为没有匹配的技能被标记）
      // 注意：只要 userSelectedSkills 数组非空就会加指令，但不会有技能被标记
      // 这其实是合理的——LLM 会看到指令但没有标记的技能
      expect(prompt).toContain("User-Selected Skills");
    });

    it("空数组等同于无参数（无标记）", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt([]);
      expect(prompt).not.toContain("🎯");
      expect(prompt).not.toContain("User-Selected Skills");
    });

    it("undefined 等同于无参数（无标记）", () => {
      const reg = createFreshRegistry();
      const prompt = reg.buildSkillPrompt(undefined);
      expect(prompt).not.toContain("🎯");
      expect(prompt).not.toContain("User-Selected Skills");
    });

    it("选中外部注册的技能也被标记", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({ name: "external-skill", description: "External" }));
      const prompt = reg.buildSkillPrompt(["external-skill"]);
      const line = prompt.split("\n").find(l => l.includes("**external-skill**"));
      expect(line!).toContain("🎯");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. forcePreload + buildPreloadedSkillPrompt
  // ═══════════════════════════════════════════════════════════
  describe("C. forcePreload + buildPreloadedSkillPrompt", () => {
    it("forcePreload 技能的完整 prompt 被包含", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({
        name: "preloaded-skill",
        description: "Should be preloaded",
        prompt: "FULL PRELOAD INSTRUCTIONS HERE",
        forcePreload: true,
      }));
      const prompt = reg.buildPreloadedSkillPrompt();
      expect(prompt).toContain("Pre-loaded Skill Instructions");
      expect(prompt).toContain("preloaded-skill");
      expect(prompt).toContain("FULL PRELOAD INSTRUCTIONS HERE");
    });

    it("非 forcePreload 技能不被预加载", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({
        name: "lazy-skill",
        description: "Should NOT be preloaded",
        prompt: "LAZY INSTRUCTIONS",
        forcePreload: false,
      }));
      const prompt = reg.buildPreloadedSkillPrompt();
      expect(prompt).not.toContain("lazy-skill");
      expect(prompt).not.toContain("LAZY INSTRUCTIONS");
    });

    it("无 forcePreload 技能时返回空字符串", () => {
      const reg = createFreshRegistry();
      // 内置技能都没有 forcePreload
      const prompt = reg.buildPreloadedSkillPrompt();
      expect(prompt).toBe("");
    });

    it("多个 forcePreload 技能都被预加载", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({ name: "preload-1", prompt: "P1", forcePreload: true }));
      reg.register(makeSkill({ name: "preload-2", prompt: "P2", forcePreload: true }));
      const prompt = reg.buildPreloadedSkillPrompt();
      expect(prompt).toContain("preload-1");
      expect(prompt).toContain("P1");
      expect(prompt).toContain("preload-2");
      expect(prompt).toContain("P2");
    });

    it("enabled=false 的 forcePreload 技能不被预加载", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({
        name: "disabled-preload",
        prompt: "DISABLED",
        forcePreload: true,
        enabled: false,
      }));
      const prompt = reg.buildPreloadedSkillPrompt();
      expect(prompt).not.toContain("disabled-preload");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. buildSystemPromptAsync 数据流
  // ═══════════════════════════════════════════════════════════
  describe("D. buildSystemPromptAsync 数据流", () => {
    it("index.ts buildSystemPromptAsync 接受 userSelectedSkills 参数", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../core/llm/index.ts"),
        "utf-8",
      );
      expect(src).toContain("userSelectedSkills?: string[]");
      expect(src).toMatch(/buildSystemPromptAsync\(.*userSelectedSkills/);
    });

    it("index.ts buildSkillPrompt 调用传入 userSelectedSkills", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../core/llm/index.ts"),
        "utf-8",
      );
      expect(src).toContain("buildSkillPrompt(userSelectedSkills)");
    });

    it("index.ts 拼接 preloadedSkillPrompt", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../core/llm/index.ts"),
        "utf-8",
      );
      expect(src).toContain("buildPreloadedSkillPrompt()");
      expect(src).toContain("fullSkillPrompt = skillPrompt + preloadedSkillPrompt");
    });

    it("index.ts skillInstructions 使用 fullSkillPrompt", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../core/llm/index.ts"),
        "utf-8",
      );
      expect(src).toContain("skillInstructions: fullSkillPrompt");
    });

    it("process options 包含 userSelectedSkills", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../core/llm/index.ts"),
        "utf-8",
      );
      expect(src).toContain("userSelectedSkills?: string[]");
      // process 传递到 buildSystemPromptAsync
      expect(src).toContain("options?.userSelectedSkills");
    });

    it("端到端：buildSkillPrompt + buildPreloadedSkillPrompt 拼接包含两部分", () => {
      const reg = createFreshRegistry();
      reg.register(makeSkill({
        name: "meta-skill",
        description: "Meta skill",
        prompt: "META INSTRUCTIONS",
        forcePreload: true,
      }));

      const skillPrompt = reg.buildSkillPrompt(["meta-skill"]);
      const preloadedPrompt = reg.buildPreloadedSkillPrompt();
      const fullPrompt = skillPrompt + preloadedPrompt;

      // Skills First Principle 在 skillPrompt 部分
      expect(fullPrompt).toContain("Skills First Principle");
      // 🎯 标记在 skillPrompt 部分
      expect(fullPrompt).toContain("🎯 [USER SELECTED]");
      // 预加载指令在 preloadedPrompt 部分
      expect(fullPrompt).toContain("Pre-loaded Skill Instructions");
      expect(fullPrompt).toContain("META INSTRUCTIONS");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // E. App.tsx 数据流
  // ═══════════════════════════════════════════════════════════
  describe("E. App.tsx 数据流", () => {
    it("handleSend 接受 selectedSkills 参数", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../App.tsx"),
        "utf-8",
      );
      expect(src).toContain("handleSend = async (message: string, attachments?: any[], selectedSkills?: string[])");
    });

    it("handleSend 把 selectedSkills 传给 runAgenticLoop", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../App.tsx"),
        "utf-8",
      );
      expect(src).toContain("runAgenticLoop(message, session, selectedSkills)");
    });

    it("runAgenticLoop 把 selectedSkills 传给 engine.process", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../App.tsx"),
        "utf-8",
      );
      expect(src).toContain("userSelectedSkills: selectedSkills");
    });

    it("userSelectedSkills 为空时不传给 process（向后兼容）", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../App.tsx"),
        "utf-8",
      );
      // 条件展开：selectedSkills.length > 0 才传
      expect(src).toContain("selectedSkills.length > 0");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. ChatPanel + InputArea 数据流
  // ═══════════════════════════════════════════════════════════
  describe("F. ChatPanel + InputArea 数据流", () => {
    it("ChatPanel onSend 签名包含 selectedSkills", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/ChatPanel.tsx"),
        "utf-8",
      );
      expect(src).toContain("onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void");
    });

    it("ChatPanel 把 skills 传给 onSend", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/ChatPanel.tsx"),
        "utf-8",
      );
      expect(src).toContain("onSend(msg, atts, skills)");
    });

    it("InputArea onSend 签名包含 selectedSkills", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/InputArea.tsx"),
        "utf-8",
      );
      expect(src).toContain("onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void");
    });

    it("InputArea 有 selectedSkills 状态", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/InputArea.tsx"),
        "utf-8",
      );
      expect(src).toContain("selectedSkills");
      expect(src).toContain("setSelectedSkills");
    });

    it("InputArea handleSubmit 把 selectedSkills 传给 onSend", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/InputArea.tsx"),
        "utf-8",
      );
      expect(src).toContain("selectedSkills.length > 0 ? selectedSkills : undefined");
    });

    it("InputArea 有技能选择 UI（🎯 按钮）", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/InputArea.tsx"),
        "utf-8",
      );
      expect(src).toContain("showSkillPicker");
      expect(src).toContain("🎯");
    });

    it("InputArea 导入 getSkillRegistry", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/InputArea.tsx"),
        "utf-8",
      );
      expect(src).toContain("getSkillRegistry");
    });

    it("InputArea 导入 getSettingJSON（禁用过滤）", () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../components/InputArea.tsx"),
        "utf-8",
      );
      expect(src).toContain("getSettingJSON");
      expect(src).toContain("codem-disabled-skills");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // G. SKILL.md 文件验证
  // ═══════════════════════════════════════════════════════════
  describe("G. SKILL.md 文件验证", () => {
    it("prompt-optimization SKILL.md 存在", () => {
      const skillPath = path.join(__dirname, "../core/skills/prompt-optimization/SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it("prompt-optimization SKILL.md 包含 forcePreload: true", () => {
      const skillPath = path.join(__dirname, "../core/skills/prompt-optimization/SKILL.md");
      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content).toContain("forcePreload: true");
    });

    it("parseSkillMarkdown 正确解析 forcePreload: true", () => {
      const markdown = `---
name: test-preload
description: "Test preload skill"
version: "1.0.0"
forcePreload: true
---

# Test Preload Skill

Instructions here.`;
      const skill = parseSkillMarkdown(markdown, "/fake/path/SKILL.md");
      expect(skill).not.toBeNull();
      expect(skill!.forcePreload).toBe(true);
    });

    it("parseSkillMarkdown forcePreload 默认为 undefined（未声明时）", () => {
      const markdown = `---
name: no-preload
description: "No preload"
---

# No Preload Skill

Instructions.`;
      const skill = parseSkillMarkdown(markdown, "/fake/path/SKILL.md");
      expect(skill).not.toBeNull();
      expect(skill!.forcePreload).toBeUndefined();
    });

    it("parseSkillMarkdown forcePreload: false 解析为 false", () => {
      const markdown = `---
name: explicit-false
description: "Explicit false"
forcePreload: false
---

# Explicit False

Some content here.`;
      const skill = parseSkillMarkdown(markdown, "/fake/path/SKILL.md");
      expect(skill).not.toBeNull();
      expect(skill!.forcePreload).toBe(false);
    });

    it("prompt-optimization 完整解析后 forcePreload 为 true", () => {
      const skillPath = path.join(__dirname, "../core/skills/prompt-optimization/SKILL.md");
      const content = fs.readFileSync(skillPath, "utf-8");
      const skill = parseSkillMarkdown(content, skillPath);
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("prompt-optimization");
      expect(skill!.forcePreload).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // H. skill.ts 源码验证（构建逻辑）
  // ═══════════════════════════════════════════════════════════
  describe("H. skill.ts 构建逻辑验证", () => {
    const skillSrc = fs.readFileSync(
      path.join(__dirname, "../core/skill/skill.ts"),
      "utf-8",
    );

    it("buildSkillPrompt 接受 userSelectedSkills 参数", () => {
      expect(skillSrc).toContain("buildSkillPrompt(userSelectedSkills?: string[])");
    });

    it("buildSkillPrompt 使用 userSelectedSet", () => {
      expect(skillSrc).toContain("userSelectedSet");
      expect(skillSrc).toContain("new Set(userSelectedSkills || [])");
    });

    it("buildSkillPrompt 标记 🎯 [USER SELECTED]", () => {
      expect(skillSrc).toContain('🎯 [USER SELECTED]');
    });

    it("buildSkillPrompt 包含 User-Selected 指令", () => {
      expect(skillSrc).toContain("User-Selected Skills");
      expect(skillSrc).toContain("MUST load and prioritize");
    });

    it("buildSkillPrompt 包含 Skills First Principle", () => {
      expect(skillSrc).toContain("Skills First Principle");
      expect(skillSrc).toContain("MUST load and use it BEFORE");
    });

    it("buildPreloadedSkillPrompt 过滤 forcePreload", () => {
      expect(skillSrc).toMatch(/buildPreloadedSkillPrompt[\s\S]*forcePreload/);
    });

    it("buildPreloadedSkillPrompt 过滤 enabled", () => {
      expect(skillSrc).toMatch(/buildPreloadedSkillPrompt[\s\S]*enabled/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // I. 端到端数据流模拟
  // ═══════════════════════════════════════════════════════════
  describe("I. 端到端数据流模拟", () => {
    it("模拟：用户选 prompt-optimization → 系统提示词含 🎯 + 预加载指令", () => {
      const reg = createFreshRegistry();
      // 注册 prompt-optimization 技能（模拟从 SKILL.md 加载）
      reg.register({
        name: "prompt-optimization",
        description: "View and modify the system prompt of the AI agent.",
        prompt: "# Prompt Optimization Skill\n\nFull instructions here.",
        contextMode: "inline",
        source: "external",
        enabled: true,
        forcePreload: true,
      });

      // 1. 用户选中该技能
      const skillPrompt = reg.buildSkillPrompt(["prompt-optimization"]);
      const preloadedPrompt = reg.buildPreloadedSkillPrompt();
      const fullPrompt = skillPrompt + preloadedPrompt;

      // 验证：🎯 标记
      expect(fullPrompt).toContain("🎯 [USER SELECTED]");
      const poLine = fullPrompt.split("\n").find(l => l.includes("**prompt-optimization**"));
      expect(poLine!).toContain("🎯");

      // 验证：Skills First Principle
      expect(fullPrompt).toContain("Skills First Principle");

      // 验证：预加载完整指令
      expect(fullPrompt).toContain("Pre-loaded Skill Instructions");
      expect(fullPrompt).toContain("Prompt Optimization Skill");
      expect(fullPrompt).toContain("Full instructions here");

      // 验证：User-Selected 强制指令
      expect(fullPrompt).toContain("MUST load and prioritize");
    });

    it("模拟：用户不选技能 → 仍有 Skills First Principle + 预加载", () => {
      const reg = createFreshRegistry();
      reg.register({
        name: "prompt-optimization",
        description: "View and modify the system prompt.",
        prompt: "Full instructions.",
        contextMode: "inline",
        source: "external",
        enabled: true,
        forcePreload: true,
      });

      const skillPrompt = reg.buildSkillPrompt();
      const preloadedPrompt = reg.buildPreloadedSkillPrompt();
      const fullPrompt = skillPrompt + preloadedPrompt;

      // 无 🎯 标记
      expect(fullPrompt).not.toContain("🎯");
      // 但仍有 Skills First Principle
      expect(fullPrompt).toContain("Skills First Principle");
      // 仍有预加载指令
      expect(fullPrompt).toContain("Pre-loaded Skill Instructions");
    });

    it("模拟：无 forcePreload 技能 + 用户不选 → 只有 Skills First Principle", () => {
      const reg = createFreshRegistry();
      // 内置技能都没有 forcePreload
      const skillPrompt = reg.buildSkillPrompt();
      const preloadedPrompt = reg.buildPreloadedSkillPrompt();
      const fullPrompt = skillPrompt + preloadedPrompt;

      expect(fullPrompt).toContain("Skills First Principle");
      expect(fullPrompt).not.toContain("Pre-loaded Skill Instructions");
      expect(fullPrompt).not.toContain("🎯");
    });

    it("模拟：禁用技能 + 用户选择禁用的技能 → 不出现在列表", () => {
      setSettingJSON("codem-disabled-skills", ["code-review"]);
      const reg = createFreshRegistry();
      // 用户试图选被禁用的技能
      const prompt = reg.buildSkillPrompt(["code-review"]);
      // code-review 不在列表里
      expect(prompt).not.toContain("**code-review**");
      // 但 User-Selected 指令仍会出现（因为数组非空）
      // 这是合理的——LLM 会看到指令但找不到该技能
    });

    it("模拟：forcePreload 技能被禁用 → 不预加载", () => {
      const reg = createFreshRegistry();
      reg.register({
        name: "disabled-meta",
        description: "Disabled meta skill",
        prompt: "Should not appear",
        contextMode: "inline",
        source: "external",
        enabled: false,
        forcePreload: true,
      });
      const preloadedPrompt = reg.buildPreloadedSkillPrompt();
      expect(preloadedPrompt).toBe("");
    });
  });
});
