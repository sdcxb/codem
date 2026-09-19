// ========== Settings Types ==========
import { reportPersistFailure } from "../storage/persist-failure";
import { getSettingJSON } from "../storage/settings";

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
  /** 最近一次装载失败的原因（如实记录，供诊断面板显示"为什么无数据"） */
  loadError?: string;
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

/** `policy` 来源在 DB 里的键（第 45 轮 D-7）：组织下发的策略快照 */
export const POLICY_SETTING_KEY = "codem-policy";

// ========== Settings Manager ==========

/**
 * 分层设置管理器。
 *
 * ## 第 45 轮 D-7 修复说明（原实现整条链路是死的）
 *
 * 原实现有三处**结构性**错误，使"分层设置"面板上的一切都是装饰品：
 *
 * 1. `getPermissionRules/getMCPServers` 循环里已经按来源取，却又拼了一次来源名
 *    （`this.get(\`${source}.permissions\`)` → 查 `data[source].permissions`），永远 undefined；
 * 2. `isFeatureEnabled` 同样拼了来源名（`get("flag.\${feature}")`）；
 * 3. `policy` 来源**没有 path、也没有装载器**，而 `isBypassDisabled/getBlockedModels/
 *    getBlockedProviders` 直接读 `this.get("policy.xxx")` → 恒定返回默认值
 *    （面板把它当"真实检查结果"渲染成 `❌ 否 / None`）。
 *
 * 现在：来源内的键**只按来源取**（`getFromSource`），`policy` 从 DB 的
 * `codem-policy` 键装载（`applyPolicyFromDb`），装载失败的原因记进 `loadError`（不再静默）。
 */

/**
 * 导出设置时的**凭据脱敏**（第 62 轮，见 `docs/CREDENTIALS-PLAN.md` 的阶段 0）。
 *
 * 判据两条，**只替换 + 计数，从不打印值**：
 * 1. **键名**像凭据（`apiKey`/`api_key`/`token`/`secret`/`password`/`authorization`）→ 值换占位符；
 * 2. **值形状**像凭据（`sk-` / `gho_` / `ghp_` / `AKIA`）→ 换占位符。
 *
 * 为什么两条都要：只看键名会漏掉"被塞进别的字段里的密钥"（本仓库真发生过：一个 GitHub token
 * 形状的值出现在 reasoning / tool 结果 / 事件载荷里）；只看值形状会漏掉"形状不像但确实是密钥"
 * 的自定义 provider（比如自建网关的短 token）。
 */
export const CREDENTIAL_KEY_RE = /^(.*[-_])?(api[-_]?key|apikey|token|secret|password|passwd|authorization|auth[-_]?token)$/i;
export const CREDENTIAL_VALUE_RES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gho_[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export function redactCredentialShapes<T>(value: T): { value: T; redacted: number } {
  let redacted = 0;
  const walk = (node: unknown, keyName: string | null): unknown => {
    if (typeof node === "string") {
      let text = node;
      for (const re of CREDENTIAL_VALUE_RES) {
        text = text.replace(re, () => {
          redacted += 1;
          return "<redacted:credential-shape>";
        });
      }
      if (keyName && CREDENTIAL_KEY_RE.test(keyName) && node.trim().length > 0 && text === node) {
        redacted += 1;
        return "<redacted:credential-field>";
      }
      return text;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, keyName));
    if (node && typeof node === "object") {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) next[k] = walk(v, k);
      return next;
    }
    return node;
  };
  const value2 = walk(value, null) as T;
  return { value: value2, redacted };
}

export class SettingsManager {
  private sources: Map<SettingsSource, SettingsSourceConfig> = new Map();
  private cache: Map<string, SettingsValue> = new Map();
  private listeners: Map<string, (event: SettingsChangeEvent) => void> = new Map();
  private projectPath: string;
  /** 文件来源是否已经装载过（`loadAll()` 的幂等依据） */
  private loaded = false;
  /** 装载中的 promise（并发调用共用同一次装载，避免重复 IO） */
  private loading: Promise<void> | null = null;

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
      // policy 的来源是 DB 的 `codem-policy` 键（见 applyPolicyFromDb），不是磁盘文件
      { source: "policy", priority: 5, enabled: true },
      { source: "cli", priority: 6, enabled: true },
    ];

    for (const source of sources) {
      this.sources.set(source.source, source);
    }
  }

  /** 当前管理器绑定的项目路径（诊断用） */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * 装载所有文件来源（幂等；并发调用共用同一次装载）。
   *
   * 注意：原来这个方法全仓**零调用**，所以 `config.data` 永远是空的 ——
   * 导出为空、来源列表"无数据"、策略恒默认值，三个现象都是同一个根因。
   */
  async loadAll(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.doLoadAll().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doLoadAll(): Promise<void> {
    for (const [, config] of this.sources) {
      if (!config.path) continue;
      // 已经有数据（`importSettings()` 灌进来的 / 之前装载过）就不重读：
      // `exportSettings()` 每次都会 `await loadAll()`，若不跳过就会把调用方刚灌进去的来源**清空**
      if (config.data !== undefined) continue;
      // `loadFile` **不吞异常**（读不到 ≠ 空设置）：读失败时记 `loadError`，面板才能说清"为什么无数据"
      try {
        const data = await this.loadFile(config.path);
        config.data = data;
        config.lastLoaded = Date.now();
        config.loadError = undefined;
      } catch (e) {
        config.data = {};
        config.loadError = e instanceof Error ? e.message : String(e);
      }
    }
    this.applyPolicyFromDb();
    this.loaded = true;
    this.cache.clear();
  }

  /**
   * 从 DB 装载组织策略（第 45 轮 D-7）。
   *
   * 策略存在 DB 的 `codem-policy` 键里（JSON 对象，形如
   * `{"blockedModels":["gpt-4o"],"bypassPermissionsDisabled":true}`）。
   * 端口未就绪 / 键不存在时**保持原 data**（不清空 —— 清了会把"读不到"当成"策略为空"）。
   */
  applyPolicyFromDb(): boolean {
    const config = this.sources.get("policy");
    if (!config) return false;
    try {
      const stored = getSettingJSON<PolicySettings | null>(POLICY_SETTING_KEY, null);
      if (!stored || typeof stored !== "object") return false;
      config.data = { ...(stored as Record<string, unknown>) };
      config.lastLoaded = Date.now();
      config.loadError = undefined;
      this.cache.clear();
      return true;
    } catch (e) {
      config.loadError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** 是否已装载过（面板可据此区分"无数据"与"还没装载"） */
  isLoaded(): boolean {
    return this.loaded;
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

  /**
   * Get value from a specific source（来源内的相对键路径，如 `permissions` / `features.x`）。
   *
   * 公开的（第 45 轮 D-7）：`getPermissionRules/getMCPServers/isFeatureEnabled` 就是
   * "按来源取同一个相对键"的循环 —— 之前它们错误地走了 `this.get(来源名 + "." + 键)`。
   */
  getFromSource(key: string, source: SettingsSource): unknown {
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
      // D-7：来源内的键是相对的 `permissions`，不能再拼来源名
      const sourceRules = this.getFromSource("permissions", source);
      if (Array.isArray(sourceRules)) rules.push(...(sourceRules as PermissionRule[]));
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
      // D-7：同上
      const sourceServers = this.getFromSource("mcpServers", source);
      if (sourceServers && typeof sourceServers === "object") {
        Object.assign(servers, sourceServers as Record<string, unknown>);
      }
    }

    return servers;
  }

  /** Check if a feature is enabled */
  isFeatureEnabled(feature: string): boolean {
    // 按优先级从高到低找第一个显式声明（cli → policy → flag → user → project → local → default）
    const sortedSources = Array.from(this.sources.entries())
      .filter(([, config]) => config.enabled)
      .sort(([, a], [, b]) => b.priority - a.priority);

    for (const [source] of sortedSources) {
      // D-7：来源内的键是相对的 `features.<name>`
      const value = this.getFromSource(`features.${feature}`, source);
      if (value !== undefined) return value === true || value === "true";
      // `flag` 来源的形态是顶层开关名（`{"new-ui": true}`），不是 features 子对象
      if (source === "flag") {
        const flagValue = this.getFromSource(feature, source);
        if (flagValue !== undefined) return flagValue === true || flagValue === "true";
      }
    }

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
    // D-7：只查 policy 来源内的键（原来 get("policy.bypassPermissionsDisabled") 在多来源
    // 合并的结果上又拼了一次来源名 → 恒定 false）
    return this.getFromSource("bypassPermissionsDisabled", "policy") === true;
  }

  /** Get blocked models */
  getBlockedModels(): string[] {
    const v = this.getFromSource("blockedModels", "policy");
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** Get blocked providers */
  getBlockedProviders(): string[] {
    const v = this.getFromSource("blockedProviders", "policy");
    return Array.isArray(v) ? (v as string[]) : [];
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

  /**
   * 读一个设置文件。
   *
   * ⚠️ 读不到时**必须抛**（原来 `catch { return {} }`）。返回空对象会让"文件不存在 / 无权限 /
   * 内容不是 JSON"三种情况全部退化成"这个来源没有配置" —— 面板上表现为"无数据"，
   * 而用户/排查者无从知道到底是没有文件还是读不动（这正是 D-7 里"失败没有任何提示"的一半）。
   * 异常由 `doLoadAll()` 捕获并记进 `loadError`。
   */
  private async loadFile(path: string): Promise<Record<string, unknown>> {
    const { readFile } = await import("../file-api");
    const content = await readFile(path);
    return JSON.parse(content);
  }

  /** Save settings to file */
  private async saveFile(path: string, data: Record<string, unknown>): Promise<void> {
    try {
      const { writeFile } = await import("../file-api");
      await writeFile(path, JSON.stringify(data, null, 2));
    } catch (e) {
      // 第 87 波：导出设置写盘失败原来只打一行 warn（用户以为导出成功了）
      reportPersistFailure("settings.saveFile", e, `path=${path}`);
    }
  }

  /**
   * Export all settings（第 45 轮 D-7）。
   *
   * 原实现直接遍历 `sources` 里已有的 `config.data`，而 `data` 只可能由 `loadAll()` /
   * `set()` / `importSettings()` 填充 —— 三者当时**全都没有调用点**，于是号称
   * "导出所有设置"的按钮永远导出 `{}`（而且失败/空结果没有任何提示）。
   *
   * 现在：导出前先 `await loadAll()`（幂等，装载过一次就直接返回），
   * 于是导出的是**磁盘上的真实来源数据**；没装载成功的来源仍会出现在结果里（空对象），
   * 具体原因看 `getAllSources()[i].loadError`。
   */
  async exportSettings(): Promise<Record<string, unknown>> {
    await this.loadAll();
    this.applyPolicyFromDb();

    /**
     * 第 62 轮：**导出前先脱敏**（见 `docs/CREDENTIALS-PLAN.md` 阶段 0）。
     *
     * 导出是"把设置写到用户能随手分享的文件里"这条路径 —— 原样返回等于**把密钥交给导出文件**。
     * 脱敏只替换 + 计数，从不打印值；导出结果里仍能看到"这里原本有一个凭据字段"，
     * 所以恢复配置的人知道要重新填，而不是以为"这个字段本来就不存在"。
     */
    const result: Record<string, unknown> = {};
    let redactedTotal = 0;
    for (const [source, config] of this.sources) {
      if (config.enabled) {
        const { value, redacted } = redactCredentialShapes(config.data ?? {});
        redactedTotal += redacted;
        result[source] = value;
      }
    }
    if (redactedTotal > 0) {
      console.log(`[Settings] 导出已脱敏：${redactedTotal} 处凭据字段/形状被替换为占位符（值从不打印）`);
    }
    return result;
  }

  /** Import settings（把一份配置灌进指定来源；`loadAll()` 之后不会再被文件覆盖） */
  importSettings(data: Record<string, unknown>, source: SettingsSource = "user"): void {
    const config = this.sources.get(source);
    if (config) {
      config.data = data;
      config.lastLoaded = Date.now();
      this.cache.clear();
    }
  }
}

// ========== Singleton ==========

let instance: SettingsManager | null = null;
/** 单例当前绑定的项目路径（用于识别"面板换了项目"） */
let instancePath: string | undefined;

/**
 * 取分层设置管理器单例。
 *
 * 第 45 轮 D-7：原实现 `if (!instance && projectPath)` 把**首次调用时的项目路径固化**，
 * 之后无论传什么路径都返回同一个实例 —— 面板每次渲染都传新路径，却永远拿回第一次那个，
 * 于是"当前项目"标题与实际的 `.codem/settings.json` 路径对不上。
 * 现在显式路径会触发**重建**（不同项目就是不同的来源集合）。
 *
 * ⚠️ 已知限制（写在报告里，需要他人配合）：`LLMEngine` 在构造时按当时的路径取走一份引用
 * （`llm/index.ts:200`），重建不会自动换掉它手里那份。引擎侧读取的
 * `getPermissionRules/isFeatureEnabled` 目前没有生产消费者，所以实际影响为零。
 */
export function getSettingsManager(projectPath?: string): SettingsManager {
  if (!instance && !projectPath) {
    // 与旧行为一致：没有路径时返回空（非空断言只是为了兼容既有签名，
    // 调用方 `llm/index.ts:200` 已经用 `?? new SettingsManager(...)` 兜住了这种情况）
    return instance!;
  }
  if (!instance) {
    instance = new SettingsManager(projectPath!);
    instancePath = projectPath;
    return instance;
  }
  if (projectPath && projectPath !== instancePath) {
    instance = new SettingsManager(projectPath);
    instancePath = projectPath;
  }
  return instance;
}

/** 测试用：丢弃单例（避免用例之间互相串味） */
export function __resetSettingsManagerForTests(): void {
  instance = null;
  instancePath = undefined;
}
