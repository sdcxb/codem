// ========== Settings Types ==========
export type SettingsSource =
  | "cli"           // Command line arguments (highest priority)
  | "policy"        // Enterprise/org policies
  | "flag"          // Feature flags (GrowthBook etc.)
  | "user"          // User global settings (~/.codem/settings.json)
  | "project"       // Project settings (.codem/settings.json)
  | "local"         // Local project settings (.codem/settings.local.json)
  | "default";      // Built-in defaults (lowest priority)

export interface SettingsSourceConfig {
  source: SettingsSource;
  priority: number;
  enabled: boolean;
  path?: string;
  data?: Record<string, unknown>;
  lastLoaded?: number;
}

export interface SettingsValue {
  value: unknown;
  source: SettingsSource;
  timestamp: number;
}

export interface PermissionRule {
  tool: string;
  action: "allow" | "deny" | "ask";
  resource?: string;
}

// ========== G Series: Git Configuration ==========

/** Git 偏好配置 */
export interface GitConfig {
  /** 分支前缀，如 "feature/"、"feat/"。创建新分支时自动添加此前缀 */
  branchPrefix?: string;
  /** PR 合并方法 */
  mergeMethod?: "merge" | "squash" | "rebase";
  /** 是否允许强制推送（force push）。默认 false */
  forcePush?: boolean;
  /** 是否默认创建草稿 PR */
  draftPR?: boolean;
  /** 提交信息生成指令（影响 AI 生成 commit message 的风格） */
  commitMessageInstructions?: string;
  /** PR 标题生成指令 */
  prTitleInstructions?: string;
  /** PR 描述生成指令 */
  prDescriptionInstructions?: string;
  /** GitHub Personal Access Token，用于 API 操作（创建仓库等） */
  githubToken?: string;
}

// ========== ENV Series: Environment Scripts ==========

/** 自定义操作（一键构建/启动/测试等） */
export interface CustomOperation {
  id: string;
  /** 显示名称，如 "构建项目" */
  name: string;
  /** 执行命令，如 "npm run build" */
  command: string;
  /** 图标 emoji */
  icon?: string;
}

/** 环境脚本配置 */
export interface EnvironmentConfig {
  /** 打开项目时自动执行的设置脚本（如安装依赖） */
  setupScript?: string;
  /** 关闭/切换项目时执行的清理脚本 */
  cleanupScript?: string;
  /** 自定义操作列表 */
  customOperations?: CustomOperation[];
}

export interface ProjectSettings {
  /** Project name */
  name?: string;
  /** Model override */
  model?: string;
  /** Temperature override */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
  /** Max iterations */
  maxIterations?: number;
  /** Permission rules */
  permissions?: PermissionRule[];
  /** MCP servers */
  mcpServers?: Record<string, unknown>;
  /** Allowed tools */
  allowedTools?: string[];
  /** Blocked tools */
  blockedTools?: string[];
  /** Auto-approve */
  autoApprove?: boolean;
  /** Custom instructions */
  instructions?: string;
  /** Feature flags */
  features?: Record<string, boolean>;
  /** Git 偏好配置 (G series) */
  git?: GitConfig;
  /** 环境脚本配置 (ENV series) */
  environment?: EnvironmentConfig;
}

export interface UserSettings {
  /** Default model */
  defaultModel?: string;
  /** Default provider */
  defaultProvider?: string;
  /** API keys */
  apiKeys?: Record<string, string>;
  /** Theme */
  theme?: "light" | "dark" | "auto";
  /** Telemetry */
  telemetry?: boolean;
  /** Auto-save */
  autoSave?: boolean;
  /** Permission rules */
  permissions?: PermissionRule[];
  /** Custom agents */
  agents?: Record<string, unknown>;
  /** MCP servers */
  mcpServers?: Record<string, unknown>;
}

export interface PolicySettings {
  /** Organization permissions */
  permissions?: PermissionRule[];
  /** Blocked models */
  blockedModels?: string[];
  /** Blocked providers */
  blockedProviders?: string[];
  /** Max tokens limit */
  maxTokensLimit?: number;
  /** Bypass permissions disabled */
  bypassPermissionsDisabled?: boolean;
  /** Remote managed settings */
  remoteManaged?: Record<string, unknown>;
}

export interface SettingsChangeEvent {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  source: SettingsSource;
  timestamp: number;
}

// ========== Settings Manager ==========
export class SettingsManager {
  private sources: Map<SettingsSource, SettingsSourceConfig> = new Map();
  private cache: Map<string, SettingsValue> = new Map();
  private listeners: Map<string, (event: SettingsChangeEvent) => void> = new Map();
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.initSources();
  }

  private initSources() {
    const sources: SettingsSourceConfig[] = [
      { source: "default", priority: 0, enabled: true },
      { source: "local", priority: 1, enabled: true, path: `${this.projectPath}/.codem/settings.local.json` },
      { source: "project", priority: 2, enabled: true, path: `${this.projectPath}/.codem/settings.json` },
      { source: "user", priority: 3, enabled: true, path: "~/.codem/settings.json" },
      { source: "flag", priority: 4, enabled: true },
      { source: "policy", priority: 5, enabled: true },
      { source: "cli", priority: 6, enabled: true },
    ];

    for (const source of sources) {
      this.sources.set(source.source, source);
    }
  }

  /** Load settings from all sources */
  async loadAll(): Promise<void> {
    for (const [, config] of this.sources) {
      if (config.path) {
        try {
          const data = await this.loadFile(config.path);
          config.data = data;
          config.lastLoaded = Date.now();
        } catch {
          config.data = {};
        }
      }
    }
    this.cache.clear();
  }

  /** Get a setting value with priority merging */
  get<T = unknown>(key: string, defaultValue?: T): T {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached) return cached.value as T;

    // Merge from all sources (lowest to highest priority)
    let result: T | undefined = defaultValue;
    let resultSource: SettingsSource = "default";

    const sortedSources = Array.from(this.sources.entries())
      .filter(([, config]) => config.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority);

    for (const [source] of sortedSources) {
      const value = this.getFromSource(key, source);
      if (value !== undefined) {
        result = value as T;
        resultSource = source;
      }
    }

    // Cache the result
    if (result !== undefined) {
      this.cache.set(key, {
        value: result,
        source: resultSource,
        timestamp: Date.now(),
      });
    }

    return result as T;
  }

  /** Get value from a specific source */
  private getFromSource(key: string, source: SettingsSource): unknown {
    const config = this.sources.get(source);
    if (!config?.data) return undefined;

    // Support nested keys like "permissions.tools.bash"
    const parts = key.split(".");
    let current: any = config.data;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }

    return current;
  }

  /** Set a value in a specific source */
  async set(key: string, value: unknown, source: SettingsSource = "user"): Promise<void> {
    const config = this.sources.get(source);
    if (!config) return;

    const oldValue = this.get(key);

    // Initialize data if needed
    if (!config.data) config.data = {};

    // Set nested value
    const parts = key.split(".");
    let current: any = config.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== "object") {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;

    // Persist if file-based source
    if (config.path) {
      await this.saveFile(config.path, config.data);
    }

    // Clear cache
    this.cache.clear();

    // Emit change event
    this.emitChange(key, oldValue, value, source);
  }

  /** Get permission rules merged from all sources */
  getPermissionRules(): PermissionRule[] {
    const rules: PermissionRule[] = [];

    const sortedSources = Array.from(this.sources.entries())
      .filter(([, config]) => config.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority);

    for (const [source] of sortedSources) {
      const sourceRules = this.get<PermissionRule[]>(`${source}.permissions`, []);
      rules.push(...sourceRules);
    }

    return rules;
  }

  /** Get MCP servers merged from all sources */
  getMCPServers(): Record<string, unknown> {
    const servers: Record<string, unknown> = {};

    const sortedSources = Array.from(this.sources.entries())
      .filter(([, config]) => config.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority);

    for (const [source] of sortedSources) {
      const sourceServers = this.get<Record<string, unknown>>(`${source}.mcpServers`, {});
      Object.assign(servers, sourceServers);
    }

    return servers;
  }

  /** Check if a feature is enabled */
  isFeatureEnabled(feature: string): boolean {
    // Check flag source first
    const flagValue = this.get<boolean>(`flag.${feature}`);
    if (flagValue !== undefined) return flagValue;

    // Check project settings
    const projectValue = this.get<boolean>(`project.features.${feature}`);
    if (projectValue !== undefined) return projectValue;

    // Check user settings
    const userValue = this.get<boolean>(`user.features.${feature}`);
    if (userValue !== undefined) return userValue;

    return false;
  }

  /** Get source info */
  getSourceInfo(source: SettingsSource): SettingsSourceConfig | undefined {
    return this.sources.get(source);
  }

  /** Get all sources */
  getAllSources(): SettingsSourceConfig[] {
    return Array.from(this.sources.values());
  }

  /** Check if bypass permissions is disabled by policy */
  isBypassDisabled(): boolean {
    return this.get<boolean>("policy.bypassPermissionsDisabled", false);
  }

  /** Get blocked models */
  getBlockedModels(): string[] {
    return this.get<string[]>("policy.blockedModels", []);
  }

  /** Get blocked providers */
  getBlockedProviders(): string[] {
    return this.get<string[]>("policy.blockedProviders", []);
  }

  /** Check if model is allowed */
  isModelAllowed(model: string): boolean {
    const blocked = this.getBlockedModels();
    return !blocked.includes(model);
  }

  /** Check if provider is allowed */
  isProviderAllowed(provider: string): boolean {
    const blocked = this.getBlockedProviders();
    return !blocked.includes(provider);
  }

  /** Subscribe to changes */
  onChange(key: string, listener: (event: SettingsChangeEvent) => void): () => void {
    this.listeners.set(key, listener);
    return () => {
      this.listeners.delete(key);
    };
  }

  /** Emit change event */
  private emitChange(key: string, oldValue: unknown, newValue: unknown, source: SettingsSource) {
    const event: SettingsChangeEvent = {
      key,
      oldValue,
      newValue,
      source,
      timestamp: Date.now(),
    };

    for (const [pattern, listener] of this.listeners) {
      if (key.startsWith(pattern) || pattern === "*") {
        listener(event);
      }
    }
  }

  /** Load settings from file */
  private async loadFile(path: string): Promise<Record<string, unknown>> {
    try {
      const { readFile } = await import("../file-api");
      const content = await readFile(path);
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /** Save settings to file */
  private async saveFile(path: string, data: Record<string, unknown>): Promise<void> {
    try {
      const { writeFile } = await import("../file-api");
      await writeFile(path, JSON.stringify(data, null, 2));
    } catch {}
  }

  /** Export all settings */
  exportSettings(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [source, config] of this.sources) {
      if (config.data) {
        result[source] = config.data;
      }
    }
    return result;
  }

  /** Import settings */
  importSettings(data: Record<string, unknown>, source: SettingsSource = "user"): void {
    const config = this.sources.get(source);
    if (config) {
      config.data = data;
      this.cache.clear();
    }
  }
}

// ========== Singleton ==========
let instance: SettingsManager | null = null;

export function getSettingsManager(projectPath?: string): SettingsManager {
  if (!instance && projectPath) {
    instance = new SettingsManager(projectPath);
  }
  return instance!;
}
