// Agent types

// ========== Agent Types ==========
export type AgentMode = "primary" | "subagent" | "all";

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
}

// ========== Agent Info ==========
export interface AgentInfo {
  definition: AgentDefinition;
  isActive: boolean;
  parentId?: string;
}

// ========== Agent Registry ==========
export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();

  constructor() {
    this.registerBuiltinAgents();
  }

  register(agent: AgentDefinition) {
    this.agents.set(agent.id, agent);
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
    });

    // Plan agent (read-only)
    this.register({
      id: "plan",
      name: "Plan",
      description: "Read-only agent for planning and analysis",
      mode: "subagent",
      prompt: `你是一个规划助手，负责分析代码并制定计划，不做实际修改。
专注于理解代码库、识别问题、提出解决方案。
不要执行任何写/编辑操作。`,
      promptEn: `You are a planning assistant. You analyze code and create plans, but do NOT make actual changes.
Focus on understanding the codebase, identifying problems, and proposing solutions.
Do NOT perform any write/edit operations.`,
      toolAllowlist: ["read", "glob", "grep", "bash"],
      permissions: [
        { tool: "read", action: "allow" },
        { tool: "glob", action: "allow" },
        { tool: "grep", action: "allow" },
        { tool: "bash", action: "allow", resource: "git*" },
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
      ],
      maxSteps: 10,
    });

    // Explore agent (read-only codebase search)
    this.register({
      id: "explore",
      name: "Explore",
      description: "Fast read-only agent for codebase exploration",
      mode: "subagent",
      prompt: `你是一个代码库探索助手，负责快速搜索和分析代码。
使用 glob 和 grep 查找相关文件和代码模式。
简洁地报告发现，包含文件路径和行号。`,
      promptEn: `You are a codebase exploration assistant. You quickly search and analyze code.
Use glob and grep to find relevant files and code patterns.
Report findings concisely, including file paths and line numbers.`,
      toolAllowlist: ["read", "glob", "grep"],
      permissions: [
        { tool: "read", action: "allow" },
        { tool: "glob", action: "allow" },
        { tool: "grep", action: "allow" },
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
        { tool: "bash", action: "deny" },
      ],
      maxSteps: 15,
    });

    // General subagent
    this.register({
      id: "general",
      name: "General",
      description: "General-purpose subagent for delegated tasks",
      mode: "subagent",
      prompt: `你是一个通用助手，负责处理委派的任务。
请全面完成任务并报告你的发现。`,
      promptEn: `You are a general-purpose assistant. You handle delegated tasks.
Complete tasks thoroughly and report your findings.`,
      permissions: [
        { tool: "*", action: "allow" },
      ],
      canSpawnSubagents: false,
      maxSteps: 10,
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
