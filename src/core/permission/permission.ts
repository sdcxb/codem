import { getAgentRegistry } from "../agent/agent";
import { getSettingJSON, setSettingJSON } from "../storage/settings";

// ========== Permission Types ==========
export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRequest {
  id: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  resource?: string;
  timestamp: number;
}

export interface PermissionResult {
  requestId: string;
  action: PermissionAction;
  alwaysAllow?: boolean; // Remember this decision for this session
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

const CUSTOM_RULES_KEY = "codem-custom-permission-rules";

// ========== Permission Evaluator ==========
export class PermissionEvaluator {
  private rules: PermissionRule[] = [];
  private alwaysAllow: Map<string, PermissionAction> = new Map(); // key = tool:resource

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
    } catch {}
  }

  /** F3.5: Save custom rules to storage */
  private saveCustomRules() {
    try {
      const custom = this.getCustomRules();
      setSettingJSON(CUSTOM_RULES_KEY, custom);
    } catch {}
  }

  /** Clear all rules */
  clearRules() {
    this.rules = [];
    this.alwaysAllow.clear();
  }

  /** Set "always allow" for a tool pattern */
  setAlwaysAllow(tool: string, resource: string, action: PermissionAction) {
    this.alwaysAllow.set(`${tool}:${resource}`, action);
  }

  /** Check if "always allow" is set */
  getAlwaysAllow(tool: string, resource: string): PermissionAction | undefined {
    // Check exact match first
    const exact = this.alwaysAllow.get(`${tool}:${resource}`);
    if (exact) return exact;

    // Check wildcard patterns
    for (const [key, action] of this.alwaysAllow) {
      const [pattern, resPattern] = key.split(":");
      if (this.matchPattern(tool, pattern) && (!resPattern || this.matchPattern(resource, resPattern))) {
        return action;
      }
    }

    return undefined;
  }

  /** Evaluate permission for a tool call */
  evaluate(
    tool: string,
    resource: string | undefined,
    agentId: string = "build",
  ): PermissionAction {
    // Check "always allow" first
    if (resource) {
      const always = this.getAlwaysAllow(tool, resource);
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
  isAllowed(tool: string, resource?: string, agentId?: string): boolean {
    const action = this.evaluate(tool, resource, agentId);
    return action === "allow";
  }

  /** Check if a tool is denied */
  isDenied(tool: string, resource?: string, agentId?: string): boolean {
    const action = this.evaluate(tool, resource, agentId);
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
    this.addRule({ tool: "write", action: "deny", resource: "**/.mimo-snapshots/**" });
    this.addRule({ tool: "write", action: "deny", resource: "**/node_modules/**" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.git/**" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.env" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.env.*" });
    this.addRule({ tool: "edit", action: "deny", resource: "**/.mimo-snapshots/**" });
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
    // Check if already decided
    const action = this.evaluator.evaluate(request.tool, request.resource);
    if (action !== "ask") {
      return Promise.resolve({ requestId: request.id, action });
    }

    // Check "always allow"
    if (request.resource) {
      const always = this.evaluator.getAlwaysAllow(request.tool, request.resource);
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
