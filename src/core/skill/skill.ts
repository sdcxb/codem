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

// ========== Skill Parser ==========
export function parseSkillMarkdown(content: string, filePath: string): SkillDefinition | null {
  const lines = content.split("\n");
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

  let inFrontmatter = false;
  let inPrompt = false;

  for (const line of lines) {
    // Parse YAML frontmatter
    if (line.trim() === "---" && !inFrontmatter) {
      inFrontmatter = true;
      continue;
    }
    if (line.trim() === "---" && inFrontmatter) {
      inFrontmatter = false;
      continue;
    }

    if (inFrontmatter) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        switch (key) {
          case "name":
            name = value.trim();
            break;
          case "description":
            description = value.trim();
            break;
          case "aliases":
            aliases = value.split(",").map((s) => s.trim());
            break;
          case "allowedTools":
            allowedTools = value.split(",").map((s) => s.trim());
            break;
          case "model":
            model = value.trim();
            break;
          case "temperature":
            temperature = parseFloat(value);
            break;
          case "maxSteps":
            maxSteps = parseInt(value);
            break;
          case "whenToUse":
            whenToUse = value.trim();
            break;
          case "references":
            references = value.split(",").map((s) => s.trim());
            break;
          case "contextMode":
            contextMode = value.trim() as "inline" | "fork";
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
    aliases,
    allowedTools,
    model,
    temperature,
    maxSteps,
    prompt: prompt.trim(),
    references,
    whenToUse,
    contextMode,
    source: "external",
    filePath,
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

  /** Build skill prompt for system prompt */
  buildSkillPrompt(): string {
    const skills = this.getAll();
    if (skills.length === 0) return "";

    const lines = skills.map((s) => {
      const aliases = s.aliases ? ` (aliases: ${s.aliases.join(", ")})` : "";
      return `- **${s.name}**${aliases}: ${s.description}`;
    });

    return `## Available Skills\n\n${lines.join("\n")}\n\nTo use a skill, mention it by name or alias.`;
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
