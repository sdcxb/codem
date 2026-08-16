// Agent types

import type { TaskSlot } from "../llm/model-profile";

// ========== Agent Types ==========
export type AgentMode = "primary" | "subagent" | "all";

/** Collaboration mode (C1): controls agent behavior style */
export type CollaborationMode = "default" | "plan";

export interface AgentPermission {
  /** Tool name pattern (supports wildcards like "bash", "file.*") */
  tool: string;
  /** Action: allow, deny, or ask user */
  action: "allow" | "deny" | "ask";
  /** Optional resource pattern (e.g., "*.env", "/etc/*") */
  resource?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  mode: AgentMode;

  /** System prompt for this agent (Chinese) */
  prompt: string;

  /** System prompt for this agent (English, falls back to prompt) */
  promptEn?: string;

  /** Tools this agent can use (empty = all tools) */
  toolAllowlist?: string[];

  /** Permission rules (evaluated last-match-wins) */
  permissions: AgentPermission[];

  /** Model override (if different from default) */
  model?: string;

  /** Temperature override */
  temperature?: number;

  /** Max steps (tool call iterations) */
  maxSteps?: number;

  /** Max tokens for output */
  maxTokens?: number;

  /** Whether this agent can spawn subagents */
  canSpawnSubagents?: boolean;

  /** Context mode: inline = full context, fork = isolated */
  contextMode?: "inline" | "fork";

  /** Collaboration mode (C1): "default" = autonomous execution, "plan" = read-only planning */
  collaborationMode?: CollaborationMode;

  /** Reasoning effort override (E2): "low" | "medium" | "high" */
  reasoningEffort?: "low" | "medium" | "high";

  /** M1: Model slot for this agent — determines which Profile slot to use for model resolution */
  modelSlot?: TaskSlot;
}

// ========== Agent Info ==========
export interface AgentInfo {
  definition: AgentDefinition;
  isActive: boolean;
  parentId?: string;
}

// ========== Agent Registry ==========

const BUILTIN_AGENT_IDS = new Set(["build", "plan", "explore", "general", "title", "summary", "verify"]);

export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();

  constructor() {
    this.registerBuiltinAgents();
    this.loadCustomAgents();
    // R3-2.3: Fire-and-forget preset discovery (async, can't await in constructor)
    this.loadPresets().catch(() => {});
  }

  /**
   * R3-2.3: Load agent presets from directory discovery.
   * Scans for agent.cordis.yml files in preset root directories.
   */
  private async loadPresets() {
    try {
      const { discoverPresets, getDefaultRoots } = await import("./preset-discovery");
      const roots = getDefaultRoots();
      const presets = await discoverPresets(roots);
      for (const preset of presets) {
        if (!this.agents.has(preset.id)) {
          // Only register presets that don't collide with built-in agents
          // Convert AgentPreset to AgentDefinition
          this.agents.set(preset.id, {
            id: preset.id,
            name: preset.displayName || preset.id,
            description: preset.description || "",
            mode: "subagent",
            prompt: preset.composition?.prompt || "",
            modelSlot: preset.composition?.modelSlot,
          });
        }
      }
      if (presets.length > 0) {
        console.log(`[AgentRegistry] Loaded ${presets.length} agent preset(s) from discovery`);
      }
    } catch (e: any) {
      // Non-critical — presets are optional
      console.warn("[AgentRegistry] Preset discovery failed:", e.message);
    }
  }

  register(agent: AgentDefinition) {
    this.agents.set(agent.id, agent);
    if (!BUILTIN_AGENT_IDS.has(agent.id)) {
      this.saveCustomAgents();
    }
  }

  /** Update an existing agent definition (only custom agents) */
  update(id: string, updates: Partial<AgentDefinition>): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (BUILTIN_AGENT_IDS.has(id)) return false;
    this.agents.set(id, { ...agent, ...updates, id });
    this.saveCustomAgents();
    return true;
  }

  /** Unregister / delete an agent (only custom agents) */
  unregister(id: string): boolean {
    if (BUILTIN_AGENT_IDS.has(id)) return false;
    const existed = this.agents.delete(id);
    if (existed) this.saveCustomAgents();
    return existed;
  }

  /** Check if an agent is built-in */
  isBuiltin(id: string): boolean {
    return BUILTIN_AGENT_IDS.has(id);
  }

  /** Load custom agents from SQLite settings */
  private loadCustomAgents() {
    try {
      const { getSettingJSON } = require("../storage/settings");
      const custom = getSettingJSON("codem-custom-agents", []) as AgentDefinition[];
      if (Array.isArray(custom)) {
        for (const agent of custom) {
          if (agent.id && !BUILTIN_AGENT_IDS.has(agent.id)) {
            this.agents.set(agent.id, agent);
          }
        }
      }
    } catch {}
  }

  /** Save custom agents to SQLite settings */
  private saveCustomAgents() {
    try {
      const { setSettingJSON } = require("../storage/settings");
      const custom = this.getAll().filter(a => !BUILTIN_AGENT_IDS.has(a.id));
      setSettingJSON("codem-custom-agents", custom);
    } catch {}
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  getPrimary(): AgentDefinition[] {
    return this.getAll().filter((a) => a.mode === "primary" || a.mode === "all");
  }

  getSubagents(): AgentDefinition[] {
    return this.getAll().filter((a) => a.mode === "subagent" || a.mode === "all");
  }

  /** Evaluate permission for a tool call */
  evaluatePermission(agentId: string, toolName: string, resource?: string): "allow" | "deny" | "ask" {
    const agent = this.agents.get(agentId);
    if (!agent) return "ask";

    // Last-match-wins evaluation
    let result: "allow" | "deny" | "ask" = "ask";

    for (const rule of agent.permissions) {
      if (this.matchPattern(toolName, rule.tool)) {
        if (!rule.resource || (resource && this.matchPattern(resource, rule.resource))) {
          result = rule.action;
        }
      }
    }

    return result;
  }

  /** Check if agent can use a specific tool */
  canUseTool(agentId: string, toolName: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    if (agent.toolAllowlist && agent.toolAllowlist.length > 0) {
      return agent.toolAllowlist.some((pattern) => this.matchPattern(toolName, pattern));
    }

    return true; // No allowlist = can use all tools
  }

  private matchPattern(name: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;

    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    return regex.test(name);
  }

  private registerBuiltinAgents() {
    // Build agent (default, full permissions)
    this.register({
      id: "build",
      name: "Build",
      description: "Default agent with full tool access for coding tasks",
      mode: "primary",
      prompt: `## Engineering Approach

When the user doesn't specify implementation details, choose the simplest approach that fits the existing codebase:
- Follow the project's existing patterns, naming conventions, and helper functions rather than introducing new abstractions.
- Keep changes tightly scoped — don't refactor unrelated code or rename things the user didn't ask about.
- Add an abstraction only when it eliminates real duplication or matches an established pattern in the codebase.
- Test coverage should match risk: focused for small changes, broader when touching shared logic or user-facing features.

## Editing Style
- Use ASCII by default. Add non-ASCII only when the file already uses it.
- Write comments only where the code isn't self-explanatory. No narration like "assigns the value to x".
- Prefer editing existing files over creating new ones.
- After making changes, read the file back to verify.
- Reference code as \`file_path:line_number\` — it's clickable in most editors.

## Working Habits
- Don't stop at the analysis phase. Implement the fix, verify it works, then report back.
- If you hit a blocker, try a different approach before asking the user for help.
- When the user asks for a plan, give a plan. Otherwise, assume they want you to build it.`,
      permissions: [
        { tool: "*", action: "allow" },
      ],
      canSpawnSubagents: true,
      maxSteps: 20,
      modelSlot: "chat",
    });

    // Plan agent (read-only)
    this.register({
      id: "plan",
      name: "Plan",
      description: "Read-only agent for planning and analysis",
      mode: "all",
      prompt: `你是一个规划助手，负责分析代码并制定计划，不做实际修改。
专注于理解代码库、识别问题、提出解决方案。
不要执行任何写/编辑操作。`,
      promptEn: `You are a planning assistant. You analyze code and create plans, but do NOT make actual changes.
Focus on understanding the codebase, identifying problems, and proposing solutions.
Do NOT perform any write/edit operations.`,
      toolAllowlist: ["read", "glob", "grep", "bash", "lsp_tool", "tool_search", "web_search"],
      collaborationMode: "plan",
      permissions: [
        { tool: "read", action: "allow" },
        { tool: "glob", action: "allow" },
        { tool: "grep", action: "allow" },
        { tool: "bash", action: "allow", resource: "git*" },
        { tool: "lsp_tool", action: "allow" },
        { tool: "tool_search", action: "allow" },
        { tool: "web_search", action: "allow" },
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
      ],
      maxSteps: 10,
      modelSlot: "subagent",
    });

    // Explore agent (read-only codebase search)
    this.register({
      id: "explore",
      name: "Explore",
      description: "Fast read-only agent for codebase exploration",
      mode: "all",
      prompt: `你是一个代码库探索助手，负责快速搜索和分析代码。
使用 glob 和 grep 查找相关文件和代码模式。
简洁地报告发现，包含文件路径和行号。`,
      promptEn: `You are a codebase exploration assistant. You quickly search and analyze code.
Use glob and grep to find relevant files and code patterns.
Report findings concisely, including file paths and line numbers.`,
      toolAllowlist: ["read", "glob", "grep", "bash", "lsp_tool", "tool_search", "web_search"],
      permissions: [
        { tool: "read", action: "allow" },
        { tool: "glob", action: "allow" },
        { tool: "grep", action: "allow" },
        { tool: "bash", action: "allow" },
        { tool: "lsp_tool", action: "allow" },
        { tool: "tool_search", action: "allow" },
        { tool: "web_search", action: "allow" },
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
        { tool: "multi_edit", action: "deny" },
        { tool: "tts", action: "deny" },
        { tool: "image_gen", action: "deny" },
      ],
      maxSteps: 15,
      modelSlot: "subagent",
    });

    // General subagent
    this.register({
      id: "general",
      name: "General",
      description: "General-purpose agent for tasks and delegated work",
      mode: "all",
      prompt: `你是一个通用助手，负责处理委派的任务。
请全面完成任务并报告你的发现。`,
      promptEn: `You are a general-purpose assistant. You handle delegated tasks.
Complete tasks thoroughly and report your findings.`,
      permissions: [
        { tool: "*", action: "allow" },
      ],
      canSpawnSubagents: false,
      maxSteps: 10,
      modelSlot: "subagent",
    });

    // Title agent (generates conversation titles)
    this.register({
      id: "title",
      name: "Title",
      description: "Generates concise conversation titles",
      mode: "subagent",
      prompt: `Generate a concise 3-5 word title for this conversation.
Output ONLY the title, no quotes, no explanation.`,
      toolAllowlist: [],
      permissions: [
        { tool: "*", action: "deny" },
      ],
      maxSteps: 1,
      maxTokens: 50,
      modelSlot: "memory",
    });

    // Summary agent
    this.register({
      id: "summary",
      name: "Summary",
      description: "Generates conversation summaries",
      mode: "subagent",
      prompt: `Provide a concise summary of this conversation.
Include: key decisions, changes made, and current state.
Keep it under 200 words.`,
      toolAllowlist: [],
      permissions: [
        { tool: "*", action: "deny" },
      ],
      maxSteps: 1,
      maxTokens: 500,
      modelSlot: "memory",
    });

    // Verification agent (runs builds/tests/linters, produces PASS/FAIL verdict)
    this.register({
      id: "verify",
      name: "Verify",
      description: "Verification specialist — runs builds, tests, and linters to verify implementation correctness",
      mode: "all",
      prompt: `你是一个验证专家。你的职责是验证实现是否正确，而不是确认实现能工作——而是尝试找出问题。

你的工作流程：
1. 读取项目的 README / CLAUDE.md 了解构建和测试命令
2. 运行构建（如适用）——构建失败即 FAIL
3. 运行测试套件——测试失败即 FAIL
4. 运行 linter / 类型检查器（如已配置）
5. 检查相关代码是否有回归

验证策略（根据变更类型选择）：
- 前端变更：启动开发服务器 → 检查浏览器自动化工具 → 截图、点击、读取控制台
- 后端/API 变更：启动服务器 → curl/fetch 端点 → 验证响应格式
- CLI/脚本变更：运行代表性输入 → 验证 stdout/stderr/exit code
- Bug 修复：复现原始 bug → 验证修复 → 运行回归测试

对抗性测试（至少运行一个）：
- 并发请求测试
- 边界值测试（0, -1, 空字符串, 超长字符串）
- 幂等性测试
- 不存在的资源访问测试

输出格式（每个检查必须包含）：
### 检查：[验证内容]
**执行命令：** [确切命令]
**观察输出：** [实际输出]
**结果：PASS** 或 **FAIL**（附预期 vs 实际）

最终输出以下之一：
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

PARTIAL 仅用于环境限制（无测试框架、工具不可用等）。`,
      promptEn: `You are a verification specialist. Your job is to try to break the implementation, not to confirm it works.

Your workflow:
1. Read project README/CLAUDE.md for build/test commands
2. Run build (if applicable) — broken build is automatic FAIL
3. Run test suite — failing tests are automatic FAIL
4. Run linters/type-checkers if configured
5. Check for regressions in related code

Then apply type-specific verification strategy (frontend/backend/CLI/bug-fix).

Run at least one adversarial probe (concurrency, boundary, idempotency, orphan op).

End with exactly: VERDICT: PASS or VERDICT: FAIL or VERDICT: PARTIAL`,
      toolAllowlist: ["read", "glob", "grep", "bash", "lsp_tool", "tool_search", "web_search"],
      permissions: [
        { tool: "read", action: "allow" },
        { tool: "glob", action: "allow" },
        { tool: "grep", action: "allow" },
        { tool: "bash", action: "allow" },
        { tool: "lsp_tool", action: "allow" },
        { tool: "tool_search", action: "allow" },
        { tool: "web_search", action: "allow" },
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
        { tool: "multi_edit", action: "deny" },
        { tool: "tts", action: "deny" },
        { tool: "image_gen", action: "deny" },
      ],
      canSpawnSubagents: false,
      maxSteps: 15,
      modelSlot: "subagent",
    });
  }
}

// ========== Singleton ==========
let instance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!instance) {
    instance = new AgentRegistry();
  }
  return instance;
}
