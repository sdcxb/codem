import { getAgentRegistry } from "../agent/agent";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";

// ========== Permission Types ==========
export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRequest {
  id: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  resource?: string;
  timestamp: number;
  /**
   * 审批标题（可选）：App 用它标出审批来源（`[委派任务] bash` / `[手机发起] bash`）。
   *
   * 以前这个字段不在类型里，App 用 `as any` 塞进去、`PermissionDialog` 再用 `as any`
   * 读回来 —— 两边靠"约定"而不是类型，字段丢了编译器也不会说话。现在它是契约的一部分。
   */
  title?: string;
}

export interface PermissionResult {
  requestId: string;
  action: PermissionAction;
  /**
   * 把这次放行记住（**本次运行内、同一会话、同一 tool+resource**）。
   *
   * 只有 `action === "allow"` 且请求带 `resource` 时才有效 —— 引擎侧只按**精确的
   * `(tool, resource)`** 记忆，绝不写成通配（通配放行会盖过 S2 的硬 deny）。
   */
  alwaysAllow?: boolean;
  /**
   * 用户拒绝时写的一句话（可选）。
   *
   * 它会进工具结果（模型可见），所以消费方必须单行化并截断 —— 见 `describeUserDenial()`。
   * 没有理由时保持原来的固定文案，不追加空冒号。
   */
  reason?: string;
}

export interface PermissionRule {
  /** Tool name pattern (supports wildcards) */
  tool: string;
  /** Action */
  action: PermissionAction;
  /** Optional resource pattern */
  resource?: string;
  /** Optional session ID (if session-specific) */
  sessionId?: string;
}

/** 用户拒绝理由进入模型可见文本时的长度上限（单行化之后）。 */
const DENY_REASON_MAX_CHARS = 200;

/**
 * 把用户的拒绝理由拼成**工具结果里的那句话**（模型看得见）。
 *
 * ## 为什么需要这个函数（而不是在调用点拼字符串）
 *
 * 理由来自 4 个入口（前台托盘 / 委派弹窗 / 执行器缺省 / 以后更多），而它会直接进
 * `toolCalls[].result` → 下一轮 `buildMessages` → 模型的上下文。调用点自己拼，
 * 就一定会出现"某一路没截断/带了换行/空理由也加冒号"的分叉。
 *
 * 规则：
 * - **单行化**：所有空白（含换行/制表）压成一个空格 —— 多行理由会把工具结果排版打散；
 * - **截断**：超过 `DENY_REASON_MAX_CHARS` 截断并加 `…`（理由不该挤掉真正的内容）；
 * - **空理由**：原样返回固定文案（`PRM-6`：不能变成 `… — user reason: ` 的空冒号）。
 */
export function describeUserDenial(tool: string, reason?: string): string {
  const base = `Permission denied by user for tool "${tool}"`;
  const oneLine = (reason ?? "").replace(/\s+/g, " ").trim();
  if (!oneLine) return base;
  const clipped =
    oneLine.length > DENY_REASON_MAX_CHARS
      ? `${oneLine.slice(0, DENY_REASON_MAX_CHARS)}…`
      : oneLine;
  return `${base} — user reason: ${clipped}`;
}

const CUSTOM_RULES_KEY = "codem-custom-permission-rules";

/**
 * 一条「始终允许」记忆。
 *
 * ## 为什么不是 `Map<"tool:resource", action>`
 *
 * 旧实现把键拼成 `${tool}:${resource}`，回查时又用 `key.split(":")` 拆回来 ——
 * 而 Windows 路径（`C:\…`）与带冒号的命令（`Get-Content C:\a`）里**本来就有冒号**，
 * 于是 `resource` 被截成 `"C"`：精确命中还能靠整串 `get()` 活着，
 * 但通配/跨项匹配从此不可信。这里改成结构化条目，键里不再有分隔符，也就没有这个问题。
 */
interface AlwaysAllowEntry {
  tool: string;
  resource: string;
  action: PermissionAction;
  /** 会话 ID；`undefined` = 进程级（测试/兼容调用，生产接线永远带会话）。 */
  sessionId?: string;
}

// ========== Permission Evaluator ==========
export class PermissionEvaluator {
  private rules: PermissionRule[] = [];
  private alwaysAllow: AlwaysAllowEntry[] = [];

  constructor() {
    this.loadDefaults();
    this.loadCustomRules();
  }

  /** Add a permission rule */
  addRule(rule: PermissionRule) {
    this.rules.push(rule);
  }

  /** F3.5: Add a custom rule and persist it */
  addCustomRule(rule: PermissionRule) {
    this.rules.push(rule);
    this.saveCustomRules();
  }

  /** F3.5: Remove a custom rule by index and persist */
  removeCustomRule(index: number) {
    // Calculate custom rule range (defaults are loaded first)
    const defaultCount = this.getDefaultRuleCount();
    const customIdx = index - defaultCount;
    if (customIdx < 0 || customIdx >= this.rules.length - defaultCount) return;
    this.rules.splice(index, 1);
    this.saveCustomRules();
  }

  /** F3.5: Get only the custom rules (not defaults) */
  getCustomRules(): PermissionRule[] {
    return this.rules.slice(this.getDefaultRuleCount());
  }

  /** F3.5: Get the number of default rules */
  private getDefaultRuleCount(): number {
    // Default rules are: 6 bash rules + 10 S2 protected path rules = 16
    return 16;
  }

  /** F3.5: Load custom rules from storage */
  private loadCustomRules() {
    try {
      const stored = getSettingJSON<PermissionRule[] | null>(CUSTOM_RULES_KEY, null);
      if (stored && Array.isArray(stored)) {
        for (const rule of stored) {
          if (rule.tool && rule.action) {
            this.rules.push(rule);
          }
        }
      }
    } catch (e) { console.warn('[permission.ts]', e) }
  }

  /** F3.5: Save custom rules to storage */
  private saveCustomRules() {
    try {
      const custom = this.getCustomRules();
      setSettingJSON(CUSTOM_RULES_KEY, custom);
    } catch (e) {
      // 第 87 波：自定义权限规则写不进去 = 用户以为加的"拒绝规则"没生效（安全相关），
      // 原来只打一行 warn。现在上报（error 级 + 事件 + 计数）。
      reportPersistFailure("permission.saveCustomRules", e);
    }
  }

  /** Clear all rules */
  clearRules() {
    this.rules = [];
    this.alwaysAllow = [];
  }

  /**
   * Set "always allow" for a tool pattern.
   *
   * @param sessionId 会话范围（生产接线必须传）：只有同一会话的后续调用才认这条记忆。
   *                  不传 = 进程级（仅测试/兼容调用）。
   */
  setAlwaysAllow(tool: string, resource: string, action: PermissionAction, sessionId?: string) {
    const existing = this.alwaysAllow.find(
      (entry) => entry.tool === tool && entry.resource === resource && entry.sessionId === sessionId,
    );
    if (existing) {
      existing.action = action;
      return;
    }
    this.alwaysAllow.push({
      tool,
      resource,
      action,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  /**
   * Check if "always allow" is set.
   *
   * 先精确、再通配；会话必须一致（进程级条目不限会话）。
   */
  getAlwaysAllow(tool: string, resource: string, sessionId?: string): PermissionAction | undefined {
    let wildcard: PermissionAction | undefined;
    for (const entry of this.alwaysAllow) {
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (!this.matchPattern(tool, entry.tool)) continue;
      if (!this.matchPattern(resource, entry.resource)) continue;
      // 精确命中优先：即使先看到通配条目，也继续找完全一致的那条
      if (entry.tool === tool && entry.resource === resource) return entry.action;
      if (wildcard === undefined) wildcard = entry.action;
    }
    return wildcard;
  }

  /**
   * Evaluate permission for a tool call.
   *
   * @param sessionId 会话范围：与 `setAlwaysAllow` 的会话记忆对账（不传 = 只看进程级记忆）。
   */
  evaluate(
    tool: string,
    resource: string | undefined,
    agentId: string = "build",
    sessionId?: string,
  ): PermissionAction {
    // Check "always allow" first
    if (resource) {
      const always = this.getAlwaysAllow(tool, resource, sessionId);
      if (always) return always;
    }

    // Check agent permissions
    const agentRegistry = getAgentRegistry();
    const agentAction = agentRegistry.evaluatePermission(agentId, tool, resource);
    if (agentAction !== "ask") return agentAction;

    // Check custom rules (last-match-wins)
    let result: PermissionAction = "ask";
    for (const rule of this.rules) {
      if (this.matchPattern(tool, rule.tool)) {
        if (!rule.resource || (resource && this.matchPattern(resource, rule.resource))) {
          result = rule.action;
        }
      }
    }

    return result;
  }

  /** Check if a tool is allowed without asking */
  isAllowed(tool: string, resource?: string, agentId?: string, sessionId?: string): boolean {
    const action = this.evaluate(tool, resource, agentId, sessionId);
    return action === "allow";
  }

  /** Check if a tool is denied */
  isDenied(tool: string, resource?: string, agentId?: string, sessionId?: string): boolean {
    const action = this.evaluate(tool, resource, agentId, sessionId);
    return action === "deny";
  }

  private matchPattern(name: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;

    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    return regex.test(name);
  }

  private loadDefaults() {
    // Default rules for safety
    this.addRule({ tool: "bash", action: "ask", resource: "rm -rf*" });
    this.addRule({ tool: "bash", action: "ask", resource: "git push --force*" });
    this.addRule({ tool: "bash", action: "ask", resource: "git reset --hard*" });
    this.addRule({ tool: "bash", action: "ask", resource: "chmod*" });
    this.addRule({ tool: "bash", action: "ask", resource: "chown*" });
    this.addRule({ tool: "bash", action: "ask", resource: "sudo*" });

    // S2: Protected paths — deny write/edit to critical files
    this.addRule({ tool: "write", action: "deny", resource: "**/.git/**" });
    this.addRule({ tool: "write", action: "deny", resource: "**/.env" });
    this.addRule({ tool: "write", action: "deny", resource: "**/.env.*" });
    this.addRule({ tool: "write", action: "deny", resource: "**/.codem-snapshots/**" });
    this.addRule({ tool: "write", action: "deny", resource: "**/node_modules/**" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.git/**" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.env" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.env.*" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.codem-snapshots/**" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/node_modules/**" });
  }
}

// ========== Permission Manager ==========
export class PermissionManager {
  private evaluator: PermissionEvaluator;
  private pendingRequests: Map<string, {
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
  }> = new Map();

  constructor() {
    this.evaluator = new PermissionEvaluator();
  }

  getEvaluator(): PermissionEvaluator {
    return this.evaluator;
  }

  /** Request permission (returns a promise that resolves when user responds) */
  requestPermission(request: PermissionRequest): Promise<PermissionResult> {
    // Check if already decided（会话记忆按 sessionId 对账，见 setAlwaysAllow）
    const action = this.evaluator.evaluate(request.tool, request.resource, "build", request.sessionId);
    if (action !== "ask") {
      return Promise.resolve({ requestId: request.id, action });
    }

    // Check "always allow"
    if (request.resource) {
      const always = this.evaluator.getAlwaysAllow(request.tool, request.resource, request.sessionId);
      if (always) {
        return Promise.resolve({ requestId: request.id, action: always });
      }
    }

    // Create pending request — NO time-based timeout.
    // The user may take as long as they need to review and decide.
    // If the user closes the app or cancels, abort signals handle cleanup.
    // Previous implementation had a 5-minute timeout that auto-denied,
    // which was unreliable and could interrupt long reviews.
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });
    });
  }

  /** Resolve a pending permission request */
  resolvePermission(requestId: string, result: PermissionResult) {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      pending.resolve(result);
    }
  }

  /** Deny all pending requests */
  denyAll() {
    for (const [id, { resolve }] of this.pendingRequests) {
      resolve({ requestId: id, action: "deny" });
    }
    this.pendingRequests.clear();
  }

  /** Get pending requests */
  getPendingRequests(): PermissionRequest[] {
    return Array.from(this.pendingRequests.keys()).map((id) => ({
      id,
      sessionId: "",
      tool: "",
      input: {},
      timestamp: Date.now(),
    }));
  }
}

// ========== Singleton ==========
let instance: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
  if (!instance) {
    instance = new PermissionManager();
  }
  return instance;
}

