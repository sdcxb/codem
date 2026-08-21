// ========== Skill Tool Provider Types ==========

import { getSettingJSON } from "../storage/settings";

// ========== A1: Skill Discovery Provider Interface (DSH-aligned) ==========
//
// This section defines the pluggable skill discovery provider interface,
// aligned with DSH's SkillProvider/SkillRegistry architecture.
// Unlike SkillToolProvider (which carries tools), these providers are
// responsible for *discovering* skills from different sources
// (local files, remote registries, market, etc.).

/** Caller context for cwd-sensitive and abortable skill discovery. */
export interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined;
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined;
}

/** Skill invocation controls — determines visibility to model and user. */
export interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean;
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean;
}

/** Optional provider-specific base for resolving relative resources. */
export type SkillResourceBase =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "opaque"; readonly description: string };

/** Invocation-neutral skill metadata returned by list(). */
export interface SkillSummary {
  /** Kebab-case identifier. */
  readonly name: string;
  /** Short routing description. */
  readonly description: string;
  /** Optional extra routing guidance. */
  readonly whenToUse?: string;
  /** Resolved invocation controls. */
  readonly invocation: SkillInvocationPolicy;
  /** Discovery source. */
  readonly source: string;
  /** Provider that owns this skill body. */
  readonly provider: string;
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase;
}

/** Provider catalog entry — un-loaded skill metadata with a locator handle. */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names. */
  readonly rank: number;
  /** Opaque provider-owned handle passed back to provider.get(). */
  readonly locator: unknown;
  /** Absolute file path when the provider has one. */
  readonly path?: string;
  /** Parsed optional metadata from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Provider candidates plus whether discovery is authoritative. */
export interface SkillProviderObservation {
  /** Candidates from this provider. */
  readonly candidates: readonly SkillCandidate[];
  /** Whether discovery completed and candidates may be cached. */
  readonly complete: boolean;
}

/** Registration-scoped lifecycle and invalidation control. */
export interface SkillProviderControl {
  /** Aborts if registration fails or when the provider is disposed. */
  readonly signal: AbortSignal;
  /** Invalidate completed catalogs and notify consumers. */
  readonly invalidate: () => void;
}

/** Provider interface for one source of skills (files, remote, market, etc.). */
export interface SkillDiscoveryProvider {
  /** Unique provider name. */
  readonly name: string;
  /** List available skill candidates. */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>;
  /** Load a complete skill body for a candidate. */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>;
}

/** Snapshot of the skill catalog at a point in time. */
export interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries. */
  readonly skills: SkillSummary[];
  /** Whether every registered provider completed. */
  readonly complete: boolean;
}

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

  // ===== A2: Provider-based discovery (DSH-aligned) =====
  /** Registered discovery providers. */
  private discoveryProviders: Map<string, { provider: SkillDiscoveryProvider; order: number }> = new Map();
  /** Monotonic counter for provider registration order. */
  private nextProviderOrder = 0;
  /** Catalog revision — bumped on any change to invalidate caches. */
  private catalogRevision = 0;
  /** Change listeners for the 'skills/change' event. */
  private changeListeners: Set<() => void> = new Set();

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

  // ===== A2: Provider-based discovery methods (DSH-aligned) =====

  /**
   * Register a pluggable skill discovery provider.
   * Providers supply skills from different sources (files, remote, market).
   * Returns a disposer function to unregister the provider.
   */
  registerProvider(create: (control: SkillProviderControl) => SkillDiscoveryProvider): () => void {
    const lifecycle = new AbortController();
    let registration: { name: string } | undefined;

    const control: SkillProviderControl = {
      signal: lifecycle.signal,
      invalidate: () => {
        if (registration !== undefined) {
          this.invalidateCache();
        }
      },
    };

    try {
      const provider = create(control);
      const name = provider.name;
      const order = this.nextProviderOrder++;
      this.discoveryProviders.set(name, { provider, order });
      registration = { name };

      this.invalidateCache();

      return () => {
        registration = undefined;
        this.discoveryProviders.delete(name);
        this.invalidateCache();
        lifecycle.abort(new Error(`skill provider "${name}" disposed`));
      };
    } catch (error) {
      lifecycle.abort(error);
      throw error;
    }
  }

  /**
   * List invocation-neutral skill summaries from all sources.
   * Merges builtin skills with provider-discovered skills.
   */
  async listSummaries(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    return (await this.snapshot(options)).skills;
  }

  /**
   * Observe the current invocation-neutral catalog and discovery completeness.
   */
  async snapshot(options: SkillLookupOptions = {}): Promise<SkillCatalogSnapshot> {
    // Collect from builtin/runtime skills first
    const summaries: SkillSummary[] = [];
    for (const skill of this.skills.values()) {
      summaries.push(this.toSummary(skill));
    }

    // Collect from registered providers
    let complete = true;
    for (const { provider } of this.discoveryProviders.values()) {
      try {
        const output = await provider.list(options);
        const observation = this.normalizeObservation(output, provider.name);
        if (!observation.complete) complete = false;
        for (const candidate of observation.candidates) {
          summaries.push(this.candidateToSummary(candidate));
        }
      } catch (error) {
        complete = false;
        console.warn(`[SkillRegistry] Provider "${provider.name}" skipped: ${error}`);
      }
    }

    // Sort by name for stable ordering
    summaries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    return { skills: summaries, complete };
  }

  /**
   * Load a complete skill definition by name from all sources.
   */
  async getSkill(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    // Check builtin/runtime skills first
    const builtin = this.skills.get(name);
    if (builtin) return builtin;

    // Check providers
    for (const { provider } of this.discoveryProviders.values()) {
      const list = await provider.list(options);
      const observation = this.normalizeObservation(list, provider.name);
      const candidate = observation.candidates.find(c => c.name === name);
      if (candidate) {
        const definition = await provider.get(candidate, options);
        if (definition) return definition;
      }
    }

    return undefined;
  }

  /** Register a change listener. */
  onSkillsChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => { this.changeListeners.delete(callback); };
  }

  /** Invalidate caches and notify change listeners. */
  private invalidateCache(): void {
    this.catalogRevision++;
    for (const callback of this.changeListeners) {
      try { callback(); } catch (error) {
        console.warn(`[SkillRegistry] skills/change listener failed: ${error}`);
      }
    }
  }

  /** Get the current catalog revision (for cache invalidation). */
  getCatalogRevision(): number {
    return this.catalogRevision;
  }

  /** Convert a SkillDefinition to a SkillSummary. */
  private toSummary(skill: SkillDefinition): SkillSummary {
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: skill.source,
      provider: "runtime",
    };
  }

  /** Convert a SkillCandidate to a SkillSummary. */
  private candidateToSummary(candidate: SkillCandidate): SkillSummary {
    const { name, description, whenToUse, invocation, source, provider, resourceBase } = candidate;
    return { name, description, ...(whenToUse ? { whenToUse } : {}), invocation, source, provider, ...(resourceBase ? { resourceBase } : {}) };
  }

  /** Normalize provider output to a SkillProviderObservation. */
  private normalizeObservation(output: unknown, providerName: string): SkillProviderObservation {
    if (Array.isArray(output)) {
      return { candidates: output as readonly SkillCandidate[], complete: true };
    }
    if (output === null || typeof output !== "object") {
      throw new TypeError(`skill provider "${providerName}" list() must return an array or { candidates, complete } observation`);
    }
    const observation = output as Partial<SkillProviderObservation>;
    if (!Array.isArray(observation.candidates) || typeof observation.complete !== "boolean") {
      throw new TypeError(`skill provider "${providerName}" list() must return an array or { candidates, complete } observation`);
    }
    return observation as SkillProviderObservation;
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
    } catch (e) { console.warn('[skill.ts]', e) }
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
          } catch (e) { console.warn('[skill.ts]', e) }
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
          } catch (e) { console.warn('[skill.ts]', e) }
        }
      }
    } catch (e) { console.warn('[skill.ts]', e) }
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
    // ===== Cross-reference network =====
    // code-review → prose-standard (for prose quality checks)
    // code-review → trim-cot-leakage (for leaked reasoning transcript detection)
    // refactor → find-simplifications (for simplification discovery before refactoring)
    // refactor → code-review (for post-refactor verification)
    // document → prose-standard (for coverage rules and editorial quality)
    // document → trim-cot-leakage (for doc prose hygiene)
    // test → pre-push-checks (for test selection strategy)
    // test → code-review (for assertion strength verification)
    // pre-push-checks → prose-standard (for prose gate)
    // pre-push-checks → test (for test gate)
    // find-simplifications → refactor (for applying changes)
    // prose-standard → trim-cot-leakage (for leakage-specific hunting)
    // trim-cot-leakage → prose-standard (for the complete-proposition rule)

    // Code Review skill (v2: absorbs DSH review dimensions + prose-standard)
    this.register({
      name: "code-review",
      description: "Perform a thorough code review with security, lifecycle, and quality checks. Use when reviewing a PR, code changes, or auditing code quality. Covers bugs, security, performance, lifecycle, concurrency, prose quality, and interface contracts.",
      aliases: ["review", "cr"],
      allowedTools: ["read", "grep", "glob"],
      prompt: `# Code Review

**This skill is guidance, not a complete checklist.** Prioritize correctness, lifecycle, security, and broken required behavior over style; a short review with one substantiated blocker is better than a list of nits.

## Blocking Requirements

1. **New prose receives semantic review.** Use \`prose-standard\` to critically review every added or changed Markdown passage, JSDoc, comment, prompt, description, diagnostic, and visible string. Verify required coverage, accuracy, placement, and editorial quality against the owning code or behavior.

2. **Docs match the code.** Config, defaults, errors, wire fields, events, and public behavior update the package README and JSDoc in the same diff. Comments state non-obvious contracts; flag implementation narration, test walkthroughs, review history, and duplicated rationale for deletion or a link to their one home.

3. **Registrations clean up.** Verify each new registry contribution passes the disposal tests.

4. **Required evidence exists.** Verify the author ran the relevant local checks for the diff.

## Manual Checks

### Intent and interface contracts
Trace both sides of every changed interface. Confirm the implementation matches the PR, including errors, cancellation, ownership, and disposal.

### Lifecycle and concurrency
For async setup, callbacks, processes, or teardown, check:
- Races before publication
- Cancellation during awaits
- Independent error reporting
- Callback containment
- Ownership before reentry
- Complete detach cleanup
- Quiescent disposal

### Capability and consumer fit
Trace every current consumer, then flag consumer-specific behavior leaking into the interface. Flag the inverse too: a new public method on a generic service whose only caller is one internal consumer is an unnecessary API expansion.

### Scope, ownership, and necessity
Map each abstraction, state machine, option, defensive copy, and compatibility path to its current contract, production consumer, and owning plugin or service. Challenge unrelated features and speculative generality.

### Configuration and public choices
Ask what current-consumer evidence or prior art supports each default, public operation set, format, or imported external concept.

### Model perspective
Inspect the exact prompts, tool schemas, results, and diagnostics the model receives. Flag concepts outside the model's task, then verify stable text verbatim and dynamic behavior through snapshots or end-to-end coverage.

### Enforcement
Follow every denial path to the operation that executes it; exercise direct and alternate callers that can bypass schemas, prompts, facades, wrappers, or listener ordering.

### Borrowed and derived state
Determine whether each retained value is borrowed or owned under the package contract, then trace notifications and every cache, prompt, UI echo, replay, and query view to the documented success point and authoritative source.

### Bounds cover the final operation
Locate the owner of the complete emitted or retained result, including wrappers and metadata. Probe tiny and exact limits, oversized single chunks, and multibyte text for byte limits.

### Real entry path
Tests exercise the shipped Loader, bin, worker, or subprocess where relevant. A hand-mounted plugin does not catch invalid Loader exports.

### Test strength
Assertions fail on the intended regression and verify external state, logs, events, or disposal rather than restating the implementation or trusting an agent's report.

## Classic Dimensions

1. **Bugs and Logic Errors**: incorrect logic, edge cases, null checks
2. **Security Issues**: SQL injection, XSS, command injection, path traversal
3. **Performance**: unnecessary loops, memory leaks, N+1 queries
4. **Code Style**: naming conventions, DRY principle, SOLID principles
5. **Error Handling**: missing error handling, swallowed exceptions

## Reporting findings

State the defect, location, impact, and evidence. Place a localized defect inline on the tightest relevant diff range; use a PR-level comment for cross-cutting architecture, scope, or review-wide synthesis. Separate blockers from suggestions and omit issues already enforced by a green gate.

Rate severity: Critical, High, Medium, Low, Info.`,
      contextMode: "inline",
      source: "builtin",
      tags: ["review", "security", "quality", "audit"],
      version: "2.0.0",
      whenToUse: "When reviewing a PR, code changes, or auditing code quality for bugs, security, performance, lifecycle, concurrency, prose quality, or interface contracts.",
    });

    // Refactor skill (v2: absorbs DSH find-simplifications methodology)
    this.register({
      name: "refactor",
      description: "Refactor code to improve structure without changing behavior. Identifies simplification opportunities, dead code, unnecessary abstractions, and applies common refactoring patterns incrementally.",
      aliases: ["rf"],
      allowedTools: ["read", "write", "edit", "grep", "glob"],
      prompt: `# Refactor

You are a refactoring and simplification expert. Improve code structure while preserving behavior.

## Simplification Discovery

Before refactoring, identify simplification opportunities:

### Dead code and unreachable paths
- Unused exports, functions, variables, types, and fields
- Unreachable branches (e.g., type-narrowed conditions that always pass)
- Commented-out code blocks
- Empty catch/finally blocks that swallow errors

### Unnecessary abstractions
- Single-implementation interfaces with no planned second implementation
- Wrapper functions that only forward to a single callee
- Factory methods that always return the same type
- Generic parameters that are never varied
- Adapter layers where the adapted interface is identical to the target

### Redundant state and indirection
- Cached values that are always recomputed before use
- Intermediate variables that add no clarity
- Property getters that mirror private fields with no validation
- Config objects that are always passed with the same values

### Structural simplification
- Conditionals that can be replaced with lookup tables or early returns
- Nested callbacks that can be flattened with async/await
- Repeated logic that can be extracted to a shared helper
- Over-engineered state machines that can be simplified

## Common Refactoring Patterns

- Extract Method/Function
- Extract Variable
- Rename (with proper IDE support)
- Move/Inline
- Replace Temp with Query
- Introduce Parameter Object
- Replace Conditional with Polymorphism/Dispatch
- Replace Inheritance with Composition

## Workflow

1. **Read the code first** — understand the current behavior and all callers
2. **Enumerate simplification candidates** — list each with its evidence (caller count, usage frequency, structural benefit)
3. **Prioritize by impact** — high-impact, low-risk first; preserve all behavior contracts
4. **Make incremental changes** — one simplification at a time
5. **Verify each change compiles/runs** — run the narrow relevant tests after each step
6. **Keep changes minimal and focused** — do not bundle unrelated refactors

## Guardrails

- **Never change public API without tracing all consumers.** A simplification that breaks a caller is not a simplification.
- **Preserve all behavioral contracts** — return values, error conditions, side effects, timing, and ordering.
- **Challenge every abstraction** — if you cannot name a second concrete need, the abstraction may be premature.
- **Delete dead code with confidence** — but verify with grep across the full scope first.
- **Link large refactors to an issue** — do not leave half-done restructuring.`,
      contextMode: "inline",
      source: "builtin",
      tags: ["refactor", "simplification", "cleanup", "dead-code"],
      version: "2.0.0",
      whenToUse: "When refactoring code, finding simplification opportunities, removing dead code, or reducing unnecessary abstractions while preserving behavior.",
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

    // Document skill (v2: absorbs DSH doc-standards methodology)
    this.register({
      name: "document",
      description: "Generate or improve documentation for code. Covers JSDoc, README, cookbook, CHANGELOG, API docs. Applies prose-standard coverage rules, placement discipline, and editorial quality.",
      aliases: ["doc"],
      allowedTools: ["read", "write", "edit"],
      prompt: `# Document

You are a documentation expert. Create clear, comprehensive documentation that preserves every factual clause.

## Coverage Rules by Location

### Public JSDoc
Document caller-visible return distinctions, throws or rejections, side effects, ownership, timing, cancellation, and durability. A JSDoc that only restates the function name is worse than no JSDoc.

### Internal comments
Orient non-local structure and obviously complicated local structure: invariants, race ordering, ownership, security boundaries, and surprising failure behavior. Delete control-flow narration and code restatement.

### Module comments
State the module's role, dependencies, responsibilities, and non-obvious architecture choices. Link architecture choices to their owning explanation.

### Tests
Explain only non-obvious test design — why a fixture, assertion, platform accommodation, real entry path, or indirect observation is necessary. Delete walkthroughs and inventories.

### Cookbooks
Include prerequisites, required actions, the real entry path, observable verification, and concise warnings.

### READMEs
Include the consumer contract: configuration, semantics, failures, limitations, extension points, and model-visible effects. Quote stable model-visible text owned by the package; link generated catalogs and cross-package owners. Keep durable gaps and maintainer traps, not ordinary cleanup inventories.

### Skills and agent instructions
State behavioral guardrails and explicit scope limitations. Keep the workflow concise and link its source of truth.

### Diagnostics
Name the failing subject or path, violated rule, and correction when it is non-obvious. Remove internal execution narration.

## Editorial Principles

1. **One explanation has one home.** Essential contract facts may repeat locally; architecture, rationale, algorithms, history, and extended examples link to their owning document.
2. **Comments describe non-obvious contracts or rationale that code cannot express.** They do not restate what code already implies.
3. **Write enough to preserve the contract, then remove reasoning transcripts, repetition, and decoration.**
4. **Update the owner before derivative artifacts.** Generated catalogs, snapshots, and fixtures are derivative — edit the owning source or scenario first.
5. **Match the language of the surrounding code.** Chinese codebase → Chinese docs; English codebase → English docs.

## Workflow

1. Read the code and identify what needs documenting
2. Determine the appropriate documentation type (JSDoc, README, cookbook, etc.)
3. Draft following the coverage rules above
4. Verify every factual claim against the actual code behavior
5. Link to owning documents for architecture and rationale
6. Run relevant checks (lint, type-check) to verify no broken references`,
      contextMode: "inline",
      source: "builtin",
      tags: ["documentation", "jsdoc", "readme", "quality"],
      version: "2.0.0",
      whenToUse: "When generating or improving documentation — JSDoc, README, cookbook, CHANGELOG, API docs — with coverage rules and editorial discipline.",
    });

    // Test skill (v2: absorbs DSH pre-push-checks test selection strategy)
    this.register({
      name: "test",
      description: "Write and run tests for code. Selects the narrow relevant tests, verifies real entry paths, and ensures assertions fail on the intended regression rather than restating the implementation.",
      aliases: ["t"],
      allowedTools: ["read", "write", "edit", "bash", "grep", "glob"],
      prompt: `# Test

You are a testing expert. Write comprehensive tests and select the narrow relevant suite for each change.

## Test Selection Strategy

Before running tests, determine the narrow relevant set:

1. **Map the diff to test files** — use import graphs or grep to find every test that exercises the changed code path.
2. **Include disposal and lifecycle tests** — every new registry contribution, plugin, or service needs a disposal test that verifies cleanup.
3. **Include cross-cutting tests** — when the change affects a shared interface, include every consumer's test.
4. **Exclude unrelated suites** — running the full suite wastes time and hides failures; run only what the diff touches plus a type-check.
5. **Run a type-check first** — \`tsc --noEmit\` catches interface breaks faster than the full suite.

## Test Types

- **Unit tests** for individual functions and branches
- **Integration tests** for component interaction and real entry paths
- **Disposal tests** for lifecycle and cleanup verification
- **Edge case tests** for boundary conditions
- **Error handling tests** for failure modes and recovery

## Real Entry Path

Tests exercise the shipped Loader, bin, worker, or subprocess where relevant. A hand-mounted plugin does not catch invalid Loader exports. Use the real registration path, not a test-only shortcut.

## Assertion Strength

- **Assertions fail on the intended regression.** If the test passes after reverting the fix, the assertion is too weak.
- **Verify external state** — logs, events, disposal, observable output — rather than restating the implementation or trusting an agent's report.
- **One regression per test** — a test that fails for two reasons is harder to triage.
- **Use descriptive test names** — name the behavior being tested, not the implementation detail.

## Best Practices

- Follow existing test patterns in the project
- Mock external dependencies, not the code under test
- Run tests after writing to verify they pass
- Add a regression test for every bug fix — the test should fail without the fix

## Workflow

1. Read the code under test and understand all branches
2. Identify the narrow relevant existing tests
3. Write new tests for uncovered paths
4. Run the narrow suite + type-check
5. Verify each test fails without the fix (for regression tests)`,
      contextMode: "inline",
      source: "builtin",
      tags: ["test", "regression", "lifecycle", "disposal"],
      version: "2.0.0",
      whenToUse: "When writing or running tests, selecting the narrow relevant test suite for a change, verifying disposal/lifecycle, or ensuring assertion strength.",
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
      prompt: `A skill for creating, installing, and iteratively improving skills.

## Core Loop

1. Figure out what the skill is about (capture intent from the user)
2. Draft or edit the SKILL.md
3. Install the skill to the local skills directory
4. Run test prompts with the skill
5. Evaluate outputs (qualitative + quantitative)
6. Improve based on feedback
7. Repeat until satisfied

## Skill Installation Directory

Skills are stored as directories containing a \`SKILL.md\` file. The local skills directory is:

\`\`\`
~/.codem/skills/<skill-name>/SKILL.md
\`\`\`

On Windows, \`~\` is the user's home directory (e.g. \`C:\\\\Users\\\\<username>\\\\.codem\\\\skills\\\\\`).
On macOS/Linux, it is \`/home/<username>/.codem/skills/\` or \`~/.codem/skills/\`.

To find the exact path at runtime, run:
\`\`\`bash
echo $HOME/.codem/skills
\`\`\`

The system scans this directory at startup and when \`load_skill\` is called. Any \`SKILL.md\` file placed in a subdirectory of this location will be automatically discovered and become available as a skill.

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

### SKILL.md Format

\`\`\`markdown
---
name: my-skill
description: "What this skill does and when to trigger it"
version: "1.0.0"
author: "Author Name"
tags: ["category1", "category2"]
---

# Skill Name

## Instructions

Write the skill instructions here. This is the prompt that gets loaded
when the skill is triggered.

## Workflow

1. Step one
2. Step two
3. Step three
\`\`\`

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

### YAML Frontmatter Fields

| Field         | Required | Description                 | Example                                         |
| ------------- | -------- | --------------------------- | ----------------------------------------------- |
| \`name\`         | Yes      | Skill identifier (kebab-case) | \`my-skill\`                                      |
| \`description\`  | Yes      | When to trigger, what it does | \`"Debug Python code with breakpoint support"\`     |
| \`displayName\`  | No       | Display name shown in UI     | \`"Python 调试器"\`                                 |
| \`version\`      | No       | Semantic version number     | \`"1.0.0"\`                                        |
| \`author\`       | No       | Author name                 | \`"Your Name"\`                                    |
| \`tags\`         | No       | Category tags (array)       | \`["python", "debugging"]\`                       |
| \`aliases\`      | No       | Alternative trigger names   | \`["debug-py", "py-debug"]\`                      |
| \`whenToUse\`    | No       | Extra routing guidance      | \`"When debugging Python code"\`                  |

### Progressive Disclosure
Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context
2. **SKILL.md body** - In context whenever skill triggers
3. **Bundled resources** - As needed

Keep SKILL.md under 500 lines. Reference files clearly with guidance on when to read them.

## Installing a Skill

After writing the SKILL.md content, install it to the local skills directory so it becomes available as a skill.

### Installation Steps

1. **Determine the skills directory path**:
   \`\`\`bash
   SKILLS_DIR="$HOME/.codem/skills"
   mkdir -p "$SKILLS_DIR/<skill-name>"
   \`\`\`

2. **Write the SKILL.md file** to the skill directory:
   Use the \`write\` tool with path \`$HOME/.codem/skills/<skill-name>/SKILL.md\` and the full SKILL.md content.

3. **Write any bundled resources** (scripts, references, assets) to the same directory:
   \`\`\`
   $HOME/.codem/skills/<skill-name>/
   ├── SKILL.md
   ├── scripts/
   │   └── helper.py
   └── references/
       └── api-docs.md
   \`\`\`

4. **Verify installation** by reading the file back:
   \`\`\`
   read(path="$HOME/.codem/skills/<skill-name>/SKILL.md")
   \`\`\`

5. **The skill will be available** in the next \`load_skill\` call. The system scans the skills directory on each \`load_skill\` invocation, so newly created skills are automatically discovered.

### Installing from a URL or Chat Link

When a user says "install this skill: <URL>" or shares a skill link:

1. **Download the SKILL.md content** from the URL using \`bash\`:
   \`\`\`bash
   curl -sL "<URL>" -o /tmp/skill-download.md
   \`\`\`

2. **Read the downloaded content** to verify it's a valid SKILL.md:
   \`\`\`
   read(path="/tmp/skill-download.md")
   \`\`\`

3. **Extract the skill name** from the YAML frontmatter \`name\` field.

4. **Create the skill directory** and write the file:
   \`\`\`bash
   mkdir -p "$HOME/.codem/skills/<skill-name>"
   \`\`\`
   Then use \`write\` to save the content to \`$HOME/.codem/skills/<skill-name>/SKILL.md\`.

5. **If the URL points to a ZIP file**, download and extract it:
   \`\`\`bash
   curl -sL "<URL>" -o /tmp/skill.zip
   unzip /tmp/skill.zip -d "$HOME/.codem/skills/<skill-name>/"
   \`\`\`

6. **If the URL is a GitHub repository**, clone or download specific files:
   \`\`\`bash
   git clone --depth 1 "<URL>" /tmp/skill-repo
   # Copy the skill directory
   cp -r /tmp/skill-repo/<skill-dir> "$HOME/.codem/skills/<skill-name>/"
   \`\`\`

7. **Verify** by reading the installed SKILL.md and confirming the frontmatter is valid.

8. **Tell the user** the skill has been installed and is available via \`load_skill\`.

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
      tags: ["skill", "creator", "eval", "optimization", "install"],
      version: "2.0.0",
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
