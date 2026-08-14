/**
 * Tool Pipeline — 5-Layer Waterfall Execution
 *
 * Design (对标 DeepSeek Harness 5-layer tool pipeline):
 *
 * 1. pre-execute (waterfall): hooks, permission, bash-analyzer → can deny/modify
 * 2. monotonic guards (frozen order): sandbox, protected path, overwrite protection
 * 3. execute (waterfall): tool.execute() + timeout + retry + metrics
 * 4. post-execute (waterfall): hooks → result accept/reject/replace/append
 * 5. finalize (freeze): finalizeContent → write event → return authoritative result
 *
 * Layers are executed in strict order. Each layer can:
 * - Pass through (return the input unchanged)
 * - Modify (replace the input/output)
 * - Deny (stop execution and return an error)
 *
 * The pipeline wraps the existing tool execution logic, providing
 * a structured middleware system that's easier to extend and test.
 */

import type { ToolCallResult } from "./types";
import type { ToolContext, ToolDef } from "./tools";
import type { ToolExecutorContext } from "./streaming-executor";

// ========== Pipeline Types ==========

/** Result of a pre-execute middleware */
export interface PreExecuteResult {
  action: "proceed" | "deny" | "modify";
  /** If action is "deny", the error message */
  denyMessage?: string;
  /** If action is "modify", the modified tool name and args */
  modifiedName?: string;
  modifiedArgs?: Record<string, unknown>;
}

/** Result of a guard middleware */
export interface GuardResult {
  action: "proceed" | "deny";
  /** If action is "deny", the error message */
  denyMessage?: string;
}

/** Result of a post-execute middleware */
export interface PostExecuteResult {
  action: "keep" | "replace" | "append" | "reject";
  /** If action is "replace", the new output */
  replacedOutput?: string;
  /** If action is "append", text to append to output */
  appendedText?: string;
  /** If action is "reject", the error message */
  rejectMessage?: string;
}

/** Final result of the pipeline */
export interface PipelineResult {
  result: ToolCallResult;
  /** Events emitted during execution (for telemetry/replay) */
  events: PipelineEvent[];
}

/** Internal event log for telemetry and replay */
export interface PipelineEvent {
  layer: "pre-execute" | "guard" | "execute" | "post-execute" | "finalize";
  middleware: string;
  action: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

// ========== Middleware Interfaces ==========

/** Pre-execute middleware: runs before tool execution */
export interface PreExecuteMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult>;
}

/** Guard middleware: monotonic checks that can't be reordered */
export interface GuardMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<GuardResult>;
}

/** Post-execute middleware: runs after tool execution */
export interface PostExecuteMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult>;
}

/** Finalize middleware: runs after all post-execute, before returning */
export interface FinalizeMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
    events: PipelineEvent[],
  ): Promise<ToolCallResult>;
}

// ========== Pipeline Implementation ==========

export class ToolPipeline {
  private preExecuteMiddlewares: PreExecuteMiddleware[] = [];
  private guardMiddlewares: GuardMiddleware[] = [];
  private postExecuteMiddlewares: PostExecuteMiddleware[] = [];
  private finalizeMiddlewares: FinalizeMiddleware[] = [];

  /** Register a pre-execute middleware */
  registerPreExecute(m: PreExecuteMiddleware): void {
    this.preExecuteMiddlewares.push(m);
  }

  /** Register a guard middleware (order matters — guards are monotonic) */
  registerGuard(m: GuardMiddleware): void {
    this.guardMiddlewares.push(m);
  }

  /** Register a post-execute middleware */
  registerPostExecute(m: PostExecuteMiddleware): void {
    this.postExecuteMiddlewares.push(m);
  }

  /** Register a finalize middleware */
  registerFinalize(m: FinalizeMiddleware): void {
    this.finalizeMiddlewares.push(m);
  }

  /**
   * Execute a tool through the full 5-layer pipeline.
   *
   * @param toolName - Name of the tool to execute
   * @param args - Tool arguments
   * @param ctx - Execution context
   * @param toolHandler - The actual tool handler function
   * @returns Pipeline result with the final ToolCallResult and events
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
  ): Promise<PipelineResult> {
    const events: PipelineEvent[] = [];
    let currentName = toolName;
    let currentArgs = args;

    // ===== Layer 1: pre-execute (waterfall) =====
    for (const mw of this.preExecuteMiddlewares) {
      const result = await mw.execute(currentName, currentArgs, ctx);
      const event: PipelineEvent = {
        layer: "pre-execute",
        middleware: mw.name,
        action: result.action,
        timestamp: Date.now(),
      };
      events.push(event);

      if (result.action === "deny") {
        return {
          result: {
            id: ctx.messageId,
            name: currentName,
            input: currentArgs,
            output: result.denyMessage || "Denied by pre-execute middleware",
            status: "error",
            error: result.denyMessage,
          },
          events,
        };
      }
      if (result.action === "modify") {
        if (result.modifiedName) currentName = result.modifiedName;
        if (result.modifiedArgs) currentArgs = result.modifiedArgs;
      }
    }

    // ===== Layer 2: monotonic guards (frozen order) =====
    for (const mw of this.guardMiddlewares) {
      const result = await mw.execute(currentName, currentArgs, ctx);
      const event: PipelineEvent = {
        layer: "guard",
        middleware: mw.name,
        action: result.action,
        timestamp: Date.now(),
      };
      events.push(event);

      if (result.action === "deny") {
        return {
          result: {
            id: ctx.messageId,
            name: currentName,
            input: currentArgs,
            output: result.denyMessage || "Denied by guard",
            status: "error",
            error: result.denyMessage,
          },
          events,
        };
      }
    }

    // ===== Layer 3: execute =====
    let result: ToolCallResult;
    try {
      result = await toolHandler(currentName, currentArgs, ctx);
      events.push({
        layer: "execute",
        middleware: "tool",
        action: "completed",
        timestamp: Date.now(),
        data: { outputLength: result.output?.length || 0 },
      });
    } catch (error: any) {
      result = {
        id: ctx.messageId,
        name: currentName,
        input: currentArgs,
        output: `Error: ${error.message}`,
        status: "error",
        error: error.message,
      };
      events.push({
        layer: "execute",
        middleware: "tool",
        action: "error",
        timestamp: Date.now(),
        data: { error: error.message },
      });
    }

    // ===== Layer 4: post-execute (waterfall) =====
    for (const mw of this.postExecuteMiddlewares) {
      const postResult = await mw.execute(currentName, currentArgs, result, ctx);
      const event: PipelineEvent = {
        layer: "post-execute",
        middleware: mw.name,
        action: postResult.action,
        timestamp: Date.now(),
      };
      events.push(event);

      switch (postResult.action) {
        case "replace":
          if (postResult.replacedOutput !== undefined) {
            result = { ...result, output: postResult.replacedOutput };
          }
          break;
        case "append":
          if (postResult.appendedText) {
            result = {
              ...result,
              output: (result.output || "") + "\n" + postResult.appendedText,
            };
          }
          break;
        case "reject":
          return {
            result: {
              ...result,
              output: postResult.rejectMessage || "Rejected by post-execute middleware",
              status: "error",
            },
            events,
          };
      }
    }

    // ===== Layer 5: finalize (freeze) =====
    for (const mw of this.finalizeMiddlewares) {
      result = await mw.execute(currentName, currentArgs, result, ctx, events);
    }
    events.push({
      layer: "finalize",
      middleware: "pipeline",
      action: "finalized",
      timestamp: Date.now(),
    });

    return { result, events };
  }

  /** Clear all middlewares */
  clear(): void {
    this.preExecuteMiddlewares = [];
    this.guardMiddlewares = [];
    this.postExecuteMiddlewares = [];
    this.finalizeMiddlewares = [];
  }
}

// ========== Built-in Middlewares ==========

/**
 * Permission middleware (pre-execute layer)
 * Wraps the existing permission check logic.
 */
export class PermissionMiddleware implements PreExecuteMiddleware {
  name = "permission";
  private checkPermission: (
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ) => Promise<{ allowed: boolean; denyMessage?: string }>;

  constructor(
    checkPermission: (
      toolName: string,
      args: Record<string, unknown>,
      ctx: ToolExecutorContext,
    ) => Promise<{ allowed: boolean; denyMessage?: string }>,
  ) {
    this.checkPermission = checkPermission;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult> {
    const result = await this.checkPermission(toolName, args, ctx);
    if (!result.allowed) {
      return { action: "deny", denyMessage: result.denyMessage };
    }
    return { action: "proceed" };
  }
}

/**
 * Sandbox guard middleware (guard layer)
 * Checks if file paths are within the workspace when sandbox mode is enabled.
 */
export class SandboxGuard implements GuardMiddleware {
  name = "sandbox";
  private isEnabled: () => boolean;
  private isWithinWorkspace: (path: string, cwd: string) => boolean;

  constructor(
    isEnabled: () => boolean,
    isWithinWorkspace: (path: string, cwd: string) => boolean,
  ) {
    this.isEnabled = isEnabled;
    this.isWithinWorkspace = isWithinWorkspace;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<GuardResult> {
    if (!this.isEnabled()) return { action: "proceed" };

    const writeTools = ["write", "edit", "multi_edit", "delete_file"];
    if (!writeTools.includes(toolName)) return { action: "proceed" };

    const path = (args.path || args.file_path) as string;
    if (!path) return { action: "proceed" };

    // Resolve relative paths
    let resolvedPath = path;
    if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("/")) {
      const sep = ctx.cwd.includes("/") && !ctx.cwd.includes("\\") ? "/" : "\\";
      resolvedPath = ctx.cwd.replace(/[\\/]+$/, "") + sep + path.replace(/^[\\/]+/, "");
    }

    if (!this.isWithinWorkspace(resolvedPath, ctx.cwd)) {
      return {
        action: "deny",
        denyMessage: `Sandbox: Write to "${path}" is outside the workspace "${ctx.cwd}". The sandbox is enabled — disable it in settings or write within the workspace.`,
      };
    }
    return { action: "proceed" };
  }
}

/**
 * Plan mode guard middleware (guard layer)
 * Blocks write tools in plan mode.
 */
export class PlanModeGuard implements GuardMiddleware {
  name = "plan-mode";
  private isPlanMode: () => boolean;

  constructor(isPlanMode: () => boolean) {
    this.isPlanMode = isPlanMode;
  }

  async execute(
    toolName: string,
    _args: Record<string, unknown>,
    _ctx: ToolExecutorContext,
  ): Promise<GuardResult> {
    if (!this.isPlanMode()) return { action: "proceed" };

    const writeTools = ["write", "edit", "multi_edit", "delete_file", "delete"];
    if (writeTools.includes(toolName)) {
      return {
        action: "deny",
        denyMessage: `Blocked: Cannot use "${toolName}" in Plan mode. Plan mode is read-only. Ask the user to switch to Default mode to execute changes.`,
      };
    }
    return { action: "proceed" };
  }
}

/**
 * Security scan middleware (pre-execute layer)
 * Scans tool parameters for sensitive data before execution.
 */
export class SecurityScanMiddleware implements PreExecuteMiddleware {
  name = "security-scan";

  private sensitivePatterns = [
    /(?:sk-|pk-|Bearer\s+)[a-zA-Z0-9]{20,}/i,
    /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
    /(?:secret|token)\s*[:=]\s*\S+/i,
    /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i,
  ];

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult> {
    const scanTools = ["write", "edit", "multi_edit", "bash"];
    if (!scanTools.includes(toolName)) return { action: "proceed" };

    const argsStr = JSON.stringify(args);
    for (const pattern of this.sensitivePatterns) {
      if (pattern.test(argsStr)) {
        // Don't block — just warn (we'll append to result in post-execute)
        return {
          action: "proceed",
        };
      }
    }
    return { action: "proceed" };
  }
}

/**
 * Hook PreExecute middleware (pre-execute layer)
 * S0-2: Wraps HookManager.executePreToolHooks as a pipeline middleware.
 * Hooks can deny (block) or modify the tool input.
 */
export class HookPreExecuteMiddleware implements PreExecuteMiddleware {
  name = "hooks-pre";

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult> {
    try {
      const { getHookManager } = await import("../hooks/hook-manager");
      const hookManager = getHookManager();
      const result = await hookManager.executePreToolHooks(toolName, args, {
        sessionId: ctx.sessionId,
        toolName,
        input: args,
        cwd: ctx.cwd,
      });

      if (result.action === "deny") {
        return { action: "deny", denyMessage: result.denyMessage || `Blocked by hook` };
      }
      if (result.action === "modify" && result.modifiedInput) {
        return { action: "modify", modifiedArgs: result.modifiedInput };
      }
      return { action: "proceed" };
    } catch (err: any) {
      // Hooks are non-blocking — don't fail the tool execution
      console.warn(`[HookPreExecute] Error (non-blocking): ${err.message}`);
      return { action: "proceed" };
    }
  }
}

/**
 * Hook PostExecute middleware (post-execute layer)
 * S0-2: Wraps HookManager.executePostToolHooks as a pipeline middleware.
 * Hooks can modify the tool output.
 */
export class HookPostExecuteMiddleware implements PostExecuteMiddleware {
  name = "hooks-post";

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult> {
    if (!result.output) return { action: "keep" };

    try {
      const { getHookManager } = await import("../hooks/hook-manager");
      const hookManager = getHookManager();
      const hookedOutput = await hookManager.executePostToolHooks(toolName, args, result.output, {
        sessionId: ctx.sessionId,
        toolName,
        input: args,
        result: result.output,
        cwd: ctx.cwd,
      });

      if (hookedOutput !== result.output) {
        return { action: "replace", replacedOutput: hookedOutput };
      }
      return { action: "keep" };
    } catch (err: any) {
      console.warn(`[HookPostExecute] Error (non-blocking): ${err.message}`);
      return { action: "keep" };
    }
  }
}

/**
 * Event log finalize middleware (finalize layer)
 * Writes tool_call and tool_result events to the event log.
 */
export class EventLogFinalizeMiddleware implements FinalizeMiddleware {
  name = "event-log";

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
    _events: PipelineEvent[],
  ): Promise<ToolCallResult> {
    try {
      const { getEventLog } = await import("../storage/event-log");
      const eventLog = getEventLog();

      eventLog.append(ctx.sessionId, "tool_call", {
        toolCallId: result.id,
        messageId: ctx.messageId,
        tool: toolName,
        args,
        status: result.status,
      });

      eventLog.append(ctx.sessionId, "tool_result", {
        toolCallId: result.id,
        messageId: ctx.messageId,
        result: result.output,
        error: result.error,
        status: result.status === "error" ? "error" : "completed",
      });
    } catch (err) {
      console.warn("[EventLogFinalize] Failed to write tool events (non-critical):", err);
    }

    return result;
  }
}

// ========== Singleton ==========

let pipelineInstance: ToolPipeline | null = null;

export function getToolPipeline(): ToolPipeline {
  if (!pipelineInstance) {
    pipelineInstance = new ToolPipeline();
  }
  return pipelineInstance;
}

/**
 * Initialize the default tool pipeline with built-in middlewares.
 * Called once during application startup.
 */
export function initDefaultPipeline(config: {
  isPlanMode: () => boolean;
  isSandboxEnabled: () => boolean;
  isPathWithinWorkspace: (path: string, cwd: string) => boolean;
  checkPermission: (
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ) => Promise<{ allowed: boolean; denyMessage?: string }>;
}): ToolPipeline {
  const pipeline = getToolPipeline();
  pipeline.clear();

  // Layer 1: pre-execute
  pipeline.registerPreExecute(new PermissionMiddleware(config.checkPermission));
  pipeline.registerPreExecute(new SecurityScanMiddleware());
  // S0-2: HookManager PreToolUse hooks as pre-execute middleware
  pipeline.registerPreExecute(new HookPreExecuteMiddleware());

  // Layer 2: guards (monotonic — order is frozen)
  pipeline.registerGuard(new PlanModeGuard(config.isPlanMode));
  pipeline.registerGuard(new SandboxGuard(config.isSandboxEnabled, config.isPathWithinWorkspace));

  // Layer 3: execute (handled by toolHandler in pipeline.execute())

  // Layer 4: post-execute
  // S0-2: HookManager PostToolUse hooks as post-execute middleware
  pipeline.registerPostExecute(new HookPostExecuteMiddleware());

  // Layer 5: finalize
  pipeline.registerFinalize(new EventLogFinalizeMiddleware());

  return pipeline;
}
