// ========== Skill Tool Provider Types ==========

import { getSettingJSON } from "../storage/settings";

/** Settings key for persisting disabled skill names */
const DISABLED_SKILLS_KEY = "codem-disabled-skills";

/** Re-export for internal use */
const settingsModule = { getSettingJSON };

/**
 * Provider module path for dynamic tool loading.
 * When a skill declares a provider, the system will attempt to load
 * the module and instantiate the provider class.
 */
export interface SkillProviderConfig {
  /** Module path relative to the skill directory (e.g. "./provider.ts") */
  module: string;
  /** Class/function name to import from the module */
  exportName?: string;
  /** Optional static config passed to the provider */
  config?: Record<string, unknown>;
}

/**
 * Tool declaration within a skill.
 * The actual tool implementation is provided by the skill's provider.
 */
export interface SkillToolDeclaration {
  /** Tool name, must be unique across the session */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Provider key that implements this tool (maps to SkillProviderConfig) */
  provider?: string;
  /** Optional static config for this specific tool */
  config?: Record<string, unknown>;
}

/**
 * MCP server declaration within a skill.
 * When the skill is loaded, these MCP servers are connected automatically.
 */
export interface SkillMcpServerDeclaration {
  /** Server name (unique within the session) */
  name: string;
  /** Transport type */
  transport: "stdio" | "http" | "sse";
  /** Command to run (for stdio) */
  command?: string;
  /** Arguments for the command (for stdio) */
  args?: string[];
  /** URL (for http/sse) */
  url?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

// ========== Skill Types ==========
export interface SkillDefinition {
  /** Skill name (unique identifier) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Aliases for triggering the skill */
  aliases?: string[];
  /** Tools this skill can use (empty = all tools) */
  allowedTools?: string[];
  /** Model override for this skill */
  model?: string;
  /** Temperature override */
  temperature?: number;
  /** Max steps override */
  maxSteps?: number;
  /** Skill prompt/instructions */
  prompt: string;
  /** Reference files to include in context */
  references?: string[];
  /** When to activate this skill (auto-detection) */
  whenToUse?: string;
  /** Context mode: inline = inject into main, fork = separate session */
  contextMode: "inline" | "fork";
  /** Where this skill was loaded from */
  source: "builtin" | "project" | "user" | "external";
  /** File path where skill was found */
  filePath?: string;

  // ===== B1: Extended fields for tool-carrying skills =====

  /** Display name shown in UI (defaults to name) */
  displayName?: string;
  /** Version string (semver, e.g. "1.0.0") */
  version?: string;
  /** Author name */
  author?: string;
  /** Tags for categorization and search */
  tags?: string[];
  /** Shell types this skill binds to (e.g. ["powershell", "bash"]) */
  bindShells?: string[];
  /** Provider configuration for dynamic tool loading */
  provider?: SkillProviderConfig;
  /** Tool declarations provided by this skill */
  tools?: SkillToolDeclaration[];
  /** MCP servers this skill depends on */
  mcpServers?: SkillMcpServerDeclaration[];
  /** NPM/module dependencies required by the provider */
  dependencies?: string[];
  /** Skill-level configuration key-value pairs */
  config?: Record<string, unknown>;
  /** Whether this skill is enabled (can be toggled by user) */
  enabled?: boolean;
  /** Whether to force preload this skill (skip lazy loading) */
  forcePreload?: boolean;
}

export interface SkillSearchResult {
  skill: SkillDefinition;
  score: number;
  reason: string;
}

export interface SkillConfig {
  /** Directories to search for SKILL.md files */
  searchPaths: string[];
  /** Maximum skills to load */
  maxSkills: number;
}

// ========== YAML Frontmatter Parser ==========

/**
 * Parse a YAML value string into the appropriate JS type.
 * Supports: strings, numbers, booleans, arrays (inline [a,b] or block - item),
 * and simple key-value objects.
 */
function parseYamlValue(raw: string): unknown {
  const value = raw.trim();

  // Empty
  if (!value) return undefined;

  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  // Inline array: [a, b, c]
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  }

  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Plain string
  return value;
}

/**
 * Parse block-level YAML array entries (lines starting with "  - ").
 * Returns the array items, or null if the line is not a block array item.
 */
function tryParseBlockArrayItem(line: string): string | null {
  const match = line.match(/^\s+-\s+(.+)$/);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

// ========== Skill Parser ==========
export function parseSkillMarkdown(content: string, filePath: string): SkillDefinition | null {
  const lines = content.split(/\r?\n/);
  let name = "";
  let description = "";
  let prompt = "";
  let aliases: string[] = [];
  let allowedTools: string[] = [];
  let model: string | undefined;
  let temperature: number | undefined;
  let maxSteps: number | undefined;
  let whenToUse: string | undefined;
  let references: string[] = [];
  let contextMode: "inline" | "fork" = "inline";

  // B1: Extended fields
  let displayName: string | undefined;
  let version: string | undefined;
  let author: string | undefined;
  let tags: string[] = [];
  let bindShells: string[] = [];
  let provider: SkillProviderConfig | undefined;
  let tools: SkillToolDeclaration[] | undefined;
  let mcpServers: SkillMcpServerDeclaration[] | undefined;
  let dependencies: string[] | undefined;
  let skillConfig: Record<string, unknown> | undefined;
  let forcePreload: boolean | undefined;

  let inFrontmatter = false;
  let inPrompt = false;

  // Track current block array context (for parsing multi-line arrays)
  let currentBlockArray: { key: string; items: string[] } | null = null;

  // Track nested object parsing (for provider/tools/mcpServers)
  let currentNestedObj: { key: string; fields: Record<string, unknown> } | null = null;
  let currentToolObj: Record<string, unknown> | null = null;
  let currentMcpObj: Record<string, unknown> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse YAML frontmatter
    if (line.trim() === "---" && !inFrontmatter) {
      inFrontmatter = true;
      continue;
    }
    if (line.trim() === "---" && inFrontmatter) {
      // Flush any pending block arrays or nested objects
      if (currentBlockArray) {
        switch (currentBlockArray.key) {
          case "tags": tags = currentBlockArray.items; break;
          case "bindShells": bindShells = currentBlockArray.items; break;
          case "dependencies": dependencies = currentBlockArray.items; break;
        }
        currentBlockArray = null;
      }
      if (currentToolObj && tools) {
        tools.push(currentToolObj as unknown as SkillToolDeclaration);
        currentToolObj = null;
      }
      if (currentMcpObj && mcpServers) {
        mcpServers.push(currentMcpObj as unknown as SkillMcpServerDeclaration);
        currentMcpObj = null;
      }
      if (currentNestedObj) {
        if (currentNestedObj.key === "provider") {
          provider = currentNestedObj.fields as unknown as SkillProviderConfig;
        }
        currentNestedObj = null;
      }
      inFrontmatter = false;
      continue;
    }

    if (inFrontmatter) {
      // Check for block array item (  - value)
      const blockItem = tryParseBlockArrayItem(line);
      if (blockItem !== null && currentBlockArray) {
        currentBlockArray.items.push(blockItem);
        continue;
      }

      // Check for nested object field (  key: value under provider/tools/mcpServers)
      const nestedMatch = line.match(/^\s+(\w+):\s*(.*)$/);
      if (nestedMatch && currentNestedObj) {
        const [, subKey, subValue] = nestedMatch;
        currentNestedObj.fields[subKey] = parseYamlValue(subValue);
        continue;
      }

      // Check for tool/mcp block item start (  - name: value for tools/mcpServers arrays)
      const toolItemMatch = line.match(/^\s+-\s+name:\s*(.+)$/);
      if (toolItemMatch) {
        // Flush previous tool object if exists
        if (currentToolObj && tools) {
          tools.push(currentToolObj as unknown as SkillToolDeclaration);
        }
        if (!tools) tools = [];
        currentToolObj = { name: toolItemMatch[1].trim() };
        continue;
      }
      const mcpItemMatch = line.match(/^\s+-\s+name:\s*(.+)$/);
      if (mcpItemMatch && mcpServers !== undefined) {
        // This is handled above for tools; only reaches here for mcpServers
        if (currentMcpObj && mcpServers) {
          mcpServers.push(currentMcpObj as unknown as SkillMcpServerDeclaration);
        }
        if (!mcpServers) mcpServers = [];
        currentMcpObj = { name: mcpItemMatch[1].trim() };
        continue;
      }

      // Nested field under a tool or mcp object
      const objFieldMatch = line.match(/^\s+(\w+):\s*(.*)$/);
      if (objFieldMatch && currentToolObj) {
        const [, subKey, subValue] = objFieldMatch;
        currentToolObj[subKey] = parseYamlValue(subValue);
        continue;
      }
      if (objFieldMatch && currentMcpObj) {
        const [, subKey, subValue] = objFieldMatch;
        currentMcpObj[subKey] = parseYamlValue(subValue);
        continue;
      }

      // Top-level key: value
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        // Flush any pending block arrays
        if (currentBlockArray) {
          switch (currentBlockArray.key) {
            case "tags": tags = currentBlockArray.items; break;
            case "bindShells": bindShells = currentBlockArray.items; break;
            case "dependencies": dependencies = currentBlockArray.items; break;
          }
          currentBlockArray = null;
        }
        // Flush pending nested objects
        if (currentToolObj && tools) {
          tools.push(currentToolObj as unknown as SkillToolDeclaration);
          currentToolObj = null;
        }
        if (currentMcpObj && mcpServers) {
          mcpServers.push(currentMcpObj as unknown as SkillMcpServerDeclaration);
          currentMcpObj = null;
        }
        if (currentNestedObj) {
          if (currentNestedObj.key === "provider") {
            provider = currentNestedObj.fields as unknown as SkillProviderConfig;
          }
          currentNestedObj = null;
        }

        const [, key, rawValue] = match;
        const value = rawValue.trim();

        switch (key) {
          case "name":
            name = value;
            break;
          case "displayName":
            displayName = value;
            break;
          case "description":
            description = value;
            break;
          case "version":
            version = value;
            break;
          case "author":
            author = value;
            break;
          case "aliases":
            aliases = value.split(",").map((s) => s.trim());
            break;
          case "allowedTools":
            allowedTools = value.split(",").map((s) => s.trim());
            break;
          case "model":
            model = value;
            break;
          case "temperature":
            temperature = parseFloat(value);
            break;
          case "maxSteps":
            maxSteps = parseInt(value, 10);
            break;
          case "whenToUse":
            whenToUse = value;
            break;
          case "references":
            references = value.split(",").map((s) => s.trim());
            break;
          case "contextMode":
            contextMode = value as "inline" | "fork";
            break;
          case "tags":
          case "bindShells":
          case "dependencies":
            if (value.startsWith("[")) {
              // Inline array
              const parsed = parseYamlValue(value) as string[];
              if (key === "tags") tags = parsed;
              else if (key === "bindShells") bindShells = parsed;
              else dependencies = parsed;
            } else if (!value) {
              // Block array starts on next lines
              currentBlockArray = { key, items: [] };
            } else {
              // Single value
              if (key === "tags") tags = [value];
              else if (key === "bindShells") bindShells = [value];
              else dependencies = [value];
            }
            break;
          case "provider":
            if (!value) {
              // Block-style provider with nested fields
              currentNestedObj = { key: "provider", fields: {} };
            } else {
              // Inline provider module path
              provider = { module: value };
            }
            break;
          case "tools":
            if (!value) {
              tools = [];
              // Next lines will be block items
            }
            break;
          case "mcpServers":
            if (!value) {
              mcpServers = [];
            }
            break;
          case "config":
            if (value.startsWith("{")) {
              try { skillConfig = JSON.parse(value); } catch { skillConfig = undefined; }
            }
            break;
          case "forcePreload":
            forcePreload = value === "true";
            break;
        }
      }
      continue;
    }

    // Parse prompt content
    if (line.startsWith("# ")) {
      inPrompt = true;
      continue;
    }

    if (inPrompt) {
      prompt += line + "\n";
    }
  }

  // Fallback: use filename as name if not specified
  if (!name) {
    const parts = filePath.split(/[/\\]/);
    name = parts[parts.length - 2] || parts[parts.length - 1] || "unknown";
  }

  // Fallback: use first line of prompt as description
  if (!description && prompt) {
    description = prompt.split("\n")[0].trim();
  }

  if (!prompt.trim()) return null;

  return {
    name,
    description,
    aliases: aliases.length > 0 ? aliases : undefined,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    model,
    temperature,
    maxSteps,
    prompt: prompt.trim(),
    references: references.length > 0 ? references : undefined,
    whenToUse,
    contextMode,
    source: "external",
    filePath,
    displayName,
    version,
    author,
    tags: tags.length > 0 ? tags : undefined,
    bindShells: bindShells.length > 0 ? bindShells : undefined,
    provider,
    tools,
    mcpServers,
    dependencies,
    config: skillConfig,
    enabled: true,
    forcePreload,
  };
}

// ========== Skill Registry ==========
export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();

  constructor(_config?: Partial<SkillConfig>) {
    this.registerBuiltinSkills();
  }

  /** Register a skill */
  register(skill: SkillDefinition) {
    this.skills.set(skill.name, skill);
  }

  /** Get a skill by name */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** Get a skill by alias */
  getByAlias(alias: string): SkillDefinition | undefined {
    for (const skill of this.skills.values()) {
      if (skill.aliases?.includes(alias)) {
        return skill;
      }
    }
    return undefined;
  }

  /** Get all skills */
  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** Get skills by source */
  getBySource(source: SkillDefinition["source"]): SkillDefinition[] {
    return this.getAll().filter((s) => s.source === source);
  }

  /** Search skills by query */
  search(query: string): SkillSearchResult[] {
    const queryLower = query.toLowerCase();
    const results: SkillSearchResult[] = [];

    for (const skill of this.skills.values()) {
      let score = 0;
      let reason = "";

      // Name match
      if (skill.name.toLowerCase().includes(queryLower)) {
        score += 10;
        reason = "name match";
      }

      // Description match
      if (skill.description.toLowerCase().includes(queryLower)) {
        score += 5;
        reason = reason ? `${reason}, description match` : "description match";
      }

      // Alias match
      if (skill.aliases?.some((a) => a.toLowerCase().includes(queryLower))) {
        score += 8;
        reason = reason ? `${reason}, alias match` : "alias match";
      }

      // When-to-use match
      if (skill.whenToUse?.toLowerCase().includes(queryLower)) {
        score += 3;
        reason = reason ? `${reason}, when-to-use match` : "when-to-use match";
      }

      if (score > 0) {
        results.push({ skill, score, reason });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /** Auto-detect relevant skills for a query */
  detectRelevant(query: string, limit: number = 3): SkillDefinition[] {
    return this.search(query)
      .slice(0, limit)
      .map((r) => r.skill);
  }

  /** Build skill prompt for system prompt (only name + description, not full prompt) */
  buildSkillPrompt(userSelectedSkills?: string[]): string {
    // C3: Check disabled skills from settings
    let disabled: string[] = [];
    try {
      const { getSettingJSON } = settingsModule;
      disabled = getSettingJSON<string[]>(DISABLED_SKILLS_KEY, []);
    } catch {}
    const disabledSet = new Set(disabled);

    const skills = this.getAll().filter((s) => !disabledSet.has(s.name));
    if (skills.length === 0) return "";

    const userSelectedSet = new Set(userSelectedSkills || []);

    const lines = skills.map((s) => {
      const aliases = s.aliases?.length ? ` (aliases: ${s.aliases.join(", ")})` : "";
      const tools = s.tools?.length ? ` [tools: ${s.tools.map((t) => t.name).join(", ")}]` : "";
      const version = s.version ? ` v${s.version}` : "";
      const selected = userSelectedSet.has(s.name) ? " 🎯 [USER SELECTED]" : "";
      return `- **${s.name}**${version}${aliases}${tools}${selected}: ${s.description}`;
    });

    // Build user-selected notice if any
    const userSelectedNotice = userSelectedSet.size > 0
      ? `\n\n**🎯 User-Selected Skills:** The skills marked with [USER SELECTED] above were explicitly chosen by the user for this message. You MUST load and prioritize them.\n`
      : "";

    return `## Available Skills\n\nThe following skills provide specialized guidance for specific tasks. When your task matches a skill's description, use the \`load_skill\` tool to load the full instructions.\n\n${lines.join("\n")}\n\n### How to Use Skills\n\n**Load the skill**: Call \`load_skill(skill_name="<skill-name>")\` to load detailed instructions.\n\n### When to Use Skills\n\n**⚠️ CRITICAL: Skills First Principle**\n\n**When a matching skill is available, you MUST load and use it BEFORE attempting to solve the problem with your general capabilities.** Skills contain curated, domain-specific knowledge and best practices that will produce higher quality results than ad-hoc solutions.\n\n**Workflow:**\n1. **Check Available Skills:** Before starting any task, review the skill list above\n2. **Match Task to Skill:** If ANY skill description matches your current task, load it immediately\n3. **Follow Skill Instructions:** Execute the task following the loaded skill's guidance\n4. **Only Fall Back if No Match:** Use general capabilities ONLY when no skill matches the task\n\n**Use skills when:**\n1. **Task Matches Skill Description:** The user's request aligns with one of the available skill descriptions — **load the skill immediately**\n2. **Specialized Knowledge Required:** The task requires domain-specific expertise, best practices, or structured approaches\n3. **Complex Multi-Step Tasks:** The task involves multiple steps or decisions that benefit from guided instructions\n\n**Do NOT use skills when:**\n1. **No Matching Skill:** None of the available skills match the user's request — proceed with your general capabilities\n2. **Simple Factual Questions:** The user asks a straightforward factual question that doesn't require task execution\n3. **General Conversation:** The interaction is casual chat without a specific task\n\n**Best Practice:** Always scan the skill list first. When in doubt, load the skill — it's better to have specialized guidance than to miss important best practices.${userSelectedNotice}`;
  }

  /** Build skill prompt including full prompts for force-preload skills */
  buildPreloadedSkillPrompt(): string {
    const preloaded = this.getAll().filter((s) => s.enabled !== false && s.forcePreload);
    if (preloaded.length === 0) return "";
    const sections = preloaded.map((s) => `### Skill: ${s.name}\n\n${s.prompt}`);
    return `\n\n## Pre-loaded Skill Instructions\n\n${sections.join("\n\n")}`;
  }

  /** Get skill instructions for a specific skill */
  getSkillInstructions(skillName: string): string {
    const skill = this.get(skillName);
    if (!skill) return "";
    return skill.prompt;
  }

  /** Load skills from a directory */
  async loadFromDirectory(dirPath: string): Promise<number> {
    let loaded = 0;
    try {
      const { listDirectory, readFile } = await import("../file-api");
      const entries = await listDirectory(dirPath);

      for (const entry of entries) {
        if (entry.isDirectory) {
          // Check for SKILL.md in subdirectory
          try {
            const content = await readFile(`${entry.path}\\SKILL.md`);
            const skill = parseSkillMarkdown(content, entry.path);
            if (skill) {
              skill.source = "external";
              this.register(skill);
              loaded++;
            }
          } catch {}
        } else if (entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
          // Direct .md file
          try {
            const content = await readFile(entry.path);
            const skill = parseSkillMarkdown(content, entry.path);
            if (skill) {
              skill.source = "external";
              this.register(skill);
              loaded++;
            }
          } catch {}
        }
      }
    } catch {}
    return loaded;
  }

  /** Remove a skill */
  remove(name: string): boolean {
    return this.skills.delete(name);
  }

  /** Clear all non-builtin skills */
  clearExternal() {
    for (const [name, skill] of this.skills) {
      if (skill.source !== "builtin") {
        this.skills.delete(name);
      }
    }
  }

  private registerBuiltinSkills() {
    // Code Review skill
    this.register({
      name: "code-review",
      description: "Perform a thorough code review with security and quality checks",
      aliases: ["review", "cr"],
      allowedTools: ["read", "grep", "glob"],
      prompt: `You are a code review expert. Analyze the provided code for:

1. **Bugs and Logic Errors**: Look for incorrect logic, edge cases, null checks
2. **Security Issues**: SQL injection, XSS, command injection, path traversal
3. **Performance**: Unnecessary loops, memory leaks, N+1 queries
4. **Code Style**: Naming conventions, DRY principle, SOLID principles
5. **Error Handling**: Missing error handling, swallowed exceptions

Provide specific file paths and line numbers for each issue found.
Rate severity: Critical, High, Medium, Low, Info.`,
      contextMode: "inline",
      source: "builtin",
    });

    // Refactor skill
    this.register({
      name: "refactor",
      description: "Refactor code to improve structure without changing behavior",
      aliases: ["rf"],
      allowedTools: ["read", "write", "edit", "grep", "glob"],
      prompt: `You are a refactoring expert. Improve code structure while preserving behavior.

Common refactoring patterns:
- Extract Method/Function
- Extract Variable
- Rename (with proper IDE support)
- Move/Inline
- Replace Temp with Query
- Introduce Parameter Object

Always:
1. Read the code first
2. Understand the current behavior
3. Make incremental changes
4. Verify each change compiles/runs
5. Keep changes minimal and focused`,
      contextMode: "inline",
      source: "builtin",
    });

    // Debug skill
    this.register({
      name: "debug",
      description: "Help debug issues by analyzing code and error messages",
      aliases: ["db"],
      allowedTools: ["read", "grep", "glob", "bash"],
      prompt: `You are a debugging expert. Help identify and fix issues.

Approach:
1. Understand the error message/behavior
2. Locate relevant code
3. Identify root cause
4. Propose a fix
5. Verify the fix

Use bash to run tests or check logs when helpful.
Always explain WHY the fix works, not just WHAT to change.`,
      contextMode: "inline",
      source: "builtin",
    });

    // Document skill
    this.register({
      name: "document",
      description: "Generate or improve documentation for code",
      aliases: ["doc"],
      allowedTools: ["read", "write", "edit"],
      prompt: `You are a documentation expert. Create clear, comprehensive documentation.

For code:
- Add/update JSDoc/docstrings
- Explain complex logic
- Document parameters and return values
- Add usage examples

For projects:
- Update README
- Create/update CHANGELOG
- Document API endpoints
- Write setup instructions

Use appropriate format (Markdown, JSDoc, etc.) based on context.`,
      contextMode: "inline",
      source: "builtin",
    });

    // Test skill
    this.register({
      name: "test",
      description: "Write and run tests for code",
      aliases: ["t"],
      allowedTools: ["read", "write", "edit", "bash", "grep", "glob"],
      prompt: `You are a testing expert. Write comprehensive tests.

Test types:
- Unit tests for individual functions
- Integration tests for component interaction
- Edge case tests
- Error handling tests

Best practices:
- Follow existing test patterns in the project
- Use descriptive test names
- Test one thing per test
- Use appropriate assertions
- Mock external dependencies

Run tests after writing to verify they pass.`,
      contextMode: "inline",
      source: "builtin",
    });

    // Explain skill
    this.register({
      name: "explain",
      description: "Explain how code works in detail",
      aliases: ["ex"],
      allowedTools: ["read", "grep", "glob"],
      prompt: `You are a code explanation expert. Help users understand code.

Provide:
1. High-level overview of what the code does
2. Step-by-step walkthrough of the logic
3. Key concepts and patterns used
4. How it interacts with other parts
5. Common pitfalls or gotchas

Use clear language, avoid jargon when possible.
Include relevant file paths and line numbers.`,
      contextMode: "inline",
      source: "builtin",
    });

    // B6: Mermaid Diagram skill
    this.register({
      name: "mermaid-diagram",
      description: "Generate Mermaid diagrams (flowchart, sequence, class, ER, state, gantt) from text descriptions",
      aliases: ["diagram", "mermaid"],
      allowedTools: [],
      prompt: `You are an expert at creating Mermaid diagrams. When the user asks for a diagram, flowchart, or visual representation, generate a Mermaid code block.

## Supported Diagram Types

1. **Flowchart** (\`graph TD\` / \`graph LR\`) — Process flows, decision trees
2. **Sequence Diagram** (\`sequenceDiagram\`) — Interactions between actors/systems
3. **Class Diagram** (\`classDiagram\`) — Object-oriented class structures
4. **State Diagram** (\`stateDiagram-v2\`) — State machines and transitions
5. **Entity Relationship** (\`erDiagram\`) — Database schemas
6. **Gantt Chart** (\`gantt\`) — Project timelines
7. **Pie Chart** (\`pie\`) — Proportional data
8. **Git Graph** (\`gitGraph\`) — Git branch/commit history
9. **Mindmap** (\`mindmap\`) — Hierarchical ideas

## Rules

1. **Always wrap in a mermaid code block** — Use \`\`\`mermaid fencing
2. **Keep it readable** — Use descriptive node IDs and labels
3. **Use appropriate styling** — Add colors for important nodes using \`style\` or \`classDef\`
4. **Validate syntax** — Ensure the Mermaid syntax is correct before outputting
5. **Explain the diagram** — After the code block, provide a brief explanation`,
      contextMode: "inline",
      source: "builtin",
      tags: ["visualization", "diagram"],
      version: "1.0.0",
    });

    // D1: conversation_to_prompt skill
    this.register({
      name: "conversation-to-prompt",
      description:
        "Convert the current conversation into a reusable system prompt. Use when the user says 'save this as a prompt', 'turn this into a skill', 'create a reusable prompt from this conversation', or wants to extract reusable instructions from the current session.",
      aliases: ["c2p", "to-prompt"],
      allowedTools: [],
      prompt: `Transform the current conversation into a reusable system prompt draft.

## Output Protocol

Output **only** the final prompt text body. No code fences, no JSON, no explanations before or after.

## Multi-Stage Flow

1. **Analyze conversation**
   - Extract stable collaboration preferences (how the user likes to work)
   - Extract reusable task methods (the approach that worked)
   - Identify one-off context that must be removed (specific file names, temporary decisions)

2. **Generate first draft**
   - Produce one complete prompt body following the required structure below

3. **Evaluate draft**
   - Check: does it start with identity and responsibility?
   - Check: is it reusable, not a conversation summary?
   - Check: are instructions specific and actionable?
   - Reject if any check fails, rewrite

4. **Final protocol check**
   - Ensure output is plain text only, no markdown wrappers

## Required Prompt Structure

\`\`\`text
你是{助手身份}，负责{核心职责}。

你的工作方式：
- {协作偏好 1}
- {协作偏好 2}

处理任务时请遵循以下原则：
- {任务方法 1}
- {任务方法 2}

输出要求：
- {输出要求 1}
- {输出要求 2}
\`\`\`

## Evaluation Rules

Reject and rewrite if any condition is true:
1. The prompt does not start with assistant identity and responsibility
2. The output reads like a conversation summary instead of reusable instructions
3. One-off project details or temporary decisions leak into the draft
4. Instructions are vague and not actionable
5. Instructions contain internal conflicts
6. Output contains markdown wrappers or extra text outside the prompt body

## Forbidden Patterns

- Returning JSON objects or fenced code blocks
- Returning bullet-point summaries instead of the required prompt structure
- Including specific file paths, user names, or project-specific details`,
      contextMode: "inline",
      source: "builtin",
      tags: ["prompt", "reuse", "conversation"],
      version: "1.0.0",
      displayName: "对话转提示词",
    });

    // D2: prompt-optimization skill
    this.register({
      name: "prompt-optimization",
      description:
        "View and modify the system prompt of the AI agent. Use when the user wants to 'optimize the prompt', 'change the system prompt', 'improve the agent behavior', 'make the AI more focused on X', or 'modify how the AI responds'.",
      aliases: ["prompt-opt"],
      allowedTools: [],
      prompt: `This skill allows you to view and modify the system prompts of the current AI agent.

## Available Tools

- \`get_system_prompt()\` — Get the current system prompt and its source mapping
- \`submit_prompt_changes(changes)\` — Send optimized prompts to the user for review

## Workflow

### Step 1: Get Current Prompts

Call \`get_system_prompt()\`. It returns:
- \`assembled_prompt\`: The full assembled prompt
- \`sources\`: Array of prompt sources, each with:
  - \`type\`: The source type
  - \`name\`: Display name
  - \`content\`: The actual prompt text

### Step 2: Analyze and Rewrite

Based on the user's request, determine which source(s) need modification.
Write complete, production-quality prompts (not just appending text).
Match the language of the original prompt (Chinese or English).

### Step 3: Submit Changes

Call \`submit_prompt_changes(changes=[...])\` with your changes. Each change must include:

\`\`\`json
{
  "type": "system",
  "name": "system prompt",
  "original": "original content",
  "suggested": "optimized content"
}
\`\`\`

This will display interactive cards to the user showing the original vs modified prompt.
The user can then apply or cancel each change independently.

## Important Notes

- Changes are NOT applied automatically — the user reviews and clicks "Apply" on each card
- Only modify the sources that are relevant to the user's request
- Preserve the overall structure and intent of unrelated parts`,
      contextMode: "inline",
      source: "builtin",
      tags: ["prompt", "optimization", "system-prompt", "agent-config"],
      version: "1.0.0",
      displayName: "提示词管理工具",
      tools: [
        {
          name: "get_system_prompt",
          description: "Get the current system prompt and its source mapping for the AI agent.",
        },
        {
          name: "submit_prompt_changes",
          description: "Submit optimized prompt changes for user review. Shows interactive diff cards.",
        },
      ],
      provider: {
        module: "./provider.ts",
        exportName: "PromptOptimizationProvider",
      },
    });

    // D3: interactive form skill
    this.register({
      name: "interactive",
      description:
        "Ask the user questions or present choices via an interactive form. Use when you need to gather preferences, clarify ambiguous instructions, get decisions on implementation choices, or present a list of options for the user to select from. Never write options or questions as plain text — always use this tool.",
      aliases: ["ask", "form"],
      allowedTools: [],
      prompt: `You now have access to the \`interactive_form_question\` tool. Use it to ask the user questions during execution.

## When to Use

1. **Gather user preferences or requirements** — before starting or when more detail is needed
2. **Clarify ambiguous instructions** — when the request could be interpreted multiple ways
3. **Get decisions on implementation choices** — when a fork in the road requires user input
4. **Offer choices on direction** — let the user steer when multiple valid paths exist
5. **Present any list of options** — whenever you would naturally write a numbered/bulleted list of choices, use \`interactive_form_question\` instead

**Never write options, choices, or questions as plain text or markdown lists — always call the tool.**

## Usage Notes

- Users can always select "Other" to provide custom text input, even on choice questions
- Use \`multi_select: true\` to allow multiple answers
- If you recommend a specific option, set \`"recommended": true\` on that option
- After receiving answers, call \`interactive_form_question\` again if follow-up questions arise

## Tool Parameters

- \`questions\` (list, required): The full list of questions to render
- Each item has:
  - \`id\`: Unique identifier
  - \`question\`: Question text shown to the user
  - \`input_type\`: "choice" or "text"
  - \`options\` (optional): [{label, value, recommended?}] for choice questions
  - \`multi_select\` (optional): Allow multiple selections; default false
  - \`required\` (optional): Whether the question must be answered; default true
  - \`placeholder\` (optional): Placeholder for text input

## Response Format

**Single-question:** {"answer": ["value"]} (choice) or {"answer": "text"} (text)
**Multi-question:** {"answers": {"id1": ["value"], "id2": "text"}}`,
      contextMode: "inline",
      source: "builtin",
      tags: ["interaction", "user-input", "form", "clarification"],
      version: "1.0.0",
      displayName: "交互式表单提问",
      tools: [
        {
          name: "interactive_form_question",
          description: "Present an interactive form with questions to the user. Displays choice or text input fields and returns the user's answers.",
        },
      ],
      provider: {
        module: "./provider.ts",
        exportName: "InteractiveFormProvider",
      },
    });

    // D4: skill-creator skill
    this.register({
      name: "skill-creator",
      description:
        "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit or optimize an existing skill, run evals to test a skill, benchmark skill performance, or optimize a skill's description for better triggering accuracy.",
      aliases: ["create-skill", "skill-eval"],
      allowedTools: ["read", "write", "edit", "bash", "grep", "glob"],
      prompt: `A skill for creating new skills and iteratively improving them.

## Core Loop

1. Figure out what the skill is about (capture intent from the user)
2. Draft or edit the SKILL.md
3. Run test prompts with the skill
4. Evaluate outputs (qualitative + quantitative)
5. Improve based on feedback
6. Repeat until satisfied

## Creating a Skill

### Capture Intent
1. What should this skill enable the AI to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases?

### Write the SKILL.md
Fill in these components:
- **name**: Skill identifier (kebab-case)
- **description**: When to trigger, what it does. Include both what the skill does AND specific contexts for when to use it. Make descriptions "pushy" to combat undertriggering.
- **prompt**: The actual instructions for the AI when this skill is loaded.

### Skill Structure
\`\`\`
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons)
\`\`\`

### Progressive Disclosure
Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context
2. **SKILL.md body** - In context whenever skill triggers
3. **Bundled resources** - As needed

Keep SKILL.md under 500 lines. Reference files clearly with guidance on when to read them.

## Test Cases

After writing the skill draft, create 2-3 realistic test prompts. Save to \`evals/evals.json\`:

\`\`\`json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result"
    }
  ]
}
\`\`\`

## Evaluation

### Qualitative
- Run test prompts and review outputs
- Check: does the skill produce the expected behavior?
- Check: is the output quality good?

### Quantitative
- Define assertions for each test case
- Grade: pass/fail for each assertion
- Track: pass rate, token usage, execution time

### Iteration
1. Apply improvements to the skill
2. Rerun test cases
3. Compare with previous iteration
4. Repeat until satisfied

## Writing Tips

- Prefer imperative form in instructions
- Explain WHY things are important, not just WHAT to do
- Make skills general, not narrow to specific examples
- Start with a draft, then review with fresh eyes and improve
- Look for repeated work across test cases — bundle into scripts

## Description Optimization

The description field determines whether the AI invokes a skill. After creating or improving a skill:

1. Generate 10-20 trigger eval queries (mix of should-trigger and should-not-trigger)
2. Review with user
3. Test current description against eval queries
4. Iterate on description for better triggering accuracy
5. Apply best description to SKILL.md

## Packaging

When the skill is complete, package it as a .zip file:
- Include SKILL.md and all bundled resources
- Validate the structure
- Present to user for installation`,
      contextMode: "inline",
      source: "builtin",
      tags: ["skill", "creator", "eval", "optimization"],
      version: "1.0.0",
      displayName: "技能创建器",
    });
  }
}

// ========== Singleton ==========
let instance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!instance) {
    instance = new SkillRegistry();
  }
  return instance;
}
