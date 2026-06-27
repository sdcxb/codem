import { getAgentRegistry } from "../agent/agent";

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

// ========== Permission Evaluator ==========
export class PermissionEvaluator {
  private rules: PermissionRule[] = [];
  private alwaysAllow: Map<string, PermissionAction> = new Map(); // key = tool:resource

  constructor() {
    this.loadDefaults();
  }

  /** Add a permission rule */
  addRule(rule: PermissionRule) {
    this.rules.push(rule);
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

    // Create pending request
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          resolve({ requestId: request.id, action: "deny" });
        }
      }, 5 * 60 * 1000);
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
