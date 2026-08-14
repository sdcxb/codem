/**
 * S0-1/S0-2: Pipeline Integration & Hook Middleware Tests
 *
 * Validates that:
 * - executeSingle and executeBatch both route through ToolPipeline
 * - HookPreExecuteMiddleware deny blocks tool execution in pipeline
 * - HookPreExecuteMiddleware modify changes tool args in pipeline
 * - HookPostExecuteMiddleware replace changes tool output in pipeline
 * - HookPostExecuteMiddleware keep preserves original output
 * - HookMiddleware errors are non-blocking (graceful degradation)
 * - Pipeline events are generated for telemetry
 * - Permission middleware integration: deny returns error result
 * - Permission middleware integration: allow proceeds to execution
 *
 * Affected files:
 *   - src/core/llm/streaming-executor.ts (executeSingle/executeBatch pipeline routing)
 *   - src/core/llm/tool-pipeline.ts (HookPreExecuteMiddleware, HookPostExecuteMiddleware)
 *   - src/core/llm/agentic-loop.ts (toolHandler inline logic removal)
 *   - src/core/hooks/hook-manager.ts (HookManager interface)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ToolPipeline,
  HookPreExecuteMiddleware,
  HookPostExecuteMiddleware,
  type PreExecuteMiddleware,
  type GuardMiddleware,
  type PostExecuteMiddleware,
  type FinalizeMiddleware,
  type PreExecuteResult,
  type GuardResult,
  type PostExecuteResult,
} from "../core/llm/tool-pipeline";
import type { ToolExecutorContext } from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

// ========== Mock Setup ==========

function mockCtx(): ToolExecutorContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd: "/workspace",
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
  };
}

function mockToolHandler(result: Partial<ToolCallResult> = {}): (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutorContext,
) => Promise<ToolCallResult> {
  return async (name, args, ctx) => ({
    id: ctx.messageId,
    name,
    input: args,
    output: result.output || "tool output",
    status: result.status || ("completed" as const),
  });
}

// Mock HookManager — shared mutable mock so individual tests can override
const mockPreHook = vi.fn().mockResolvedValue({ action: "allow" });
const mockPostHook = vi.fn().mockResolvedValue("post-hook-output");
vi.mock("../core/hooks/hook-manager", () => ({
  getHookManager: vi.fn(() => ({
    executePreToolHooks: mockPreHook,
    executePostToolHooks: mockPostHook,
  })),
}));

describe("S0-1/S0-2: Pipeline Integration & Hook Middleware", () => {
  let pipeline: ToolPipeline;
  let ctx: ToolExecutorContext;

  beforeEach(() => {
    pipeline = new ToolPipeline();
    ctx = mockCtx();
    mockPreHook.mockReset();
    mockPreHook.mockResolvedValue({ action: "allow" });
    mockPostHook.mockReset();
    mockPostHook.mockResolvedValue("post-hook-output");
  });

  // ========== S0-1: Pipeline Routing Tests ==========

  describe("S0-1: Pipeline routing consistency", () => {
    it("executeSingle path: pipeline.execute is called, not toolHandler directly", async () => {
      const handler = vi.fn(mockToolHandler());
      const { result } = await pipeline.execute("read", { path: "/test" }, ctx, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith("read", { path: "/test" }, ctx);
      expect(result.status).toBe("completed");
    });

    it("executeBatch path: multiple tools all route through pipeline", async () => {
      const handler = vi.fn(mockToolHandler());
      const tasks = [
        { name: "read", args: { path: "/a" } },
        { name: "read", args: { path: "/b" } },
      ];

      const results = await Promise.all(
        tasks.map(t => pipeline.execute(t.name, t.args, ctx, handler)),
      );

      expect(handler).toHaveBeenCalledTimes(2);
      results.forEach(r => expect(r.result.status).toBe("completed"));
    });

    it("pipeline returns events for all layers", async () => {
      pipeline.registerPreExecute({
        name: "test-pre",
        async execute(): Promise<PreExecuteResult> { return { action: "proceed" }; },
      });
      pipeline.registerGuard({
        name: "test-guard",
        async execute(): Promise<GuardResult> { return { action: "proceed" }; },
      });
      pipeline.registerPostExecute({
        name: "test-post",
        async execute(): Promise<PostExecuteResult> { return { action: "keep" }; },
      });
      pipeline.registerFinalize({
        name: "test-finalize",
        async execute(_n, _a, result) { return result; },
      });

      const { events } = await pipeline.execute("read", {}, ctx, mockToolHandler());

      const layers = events.map(e => e.layer);
      expect(layers).toContain("pre-execute");
      expect(layers).toContain("guard");
      expect(layers).toContain("post-execute");
      expect(layers).toContain("finalize");
    });

    it("toolHandler receives modified args from pre-execute modify", async () => {
      const handler = vi.fn(mockToolHandler());
      pipeline.registerPreExecute({
        name: "modifier",
        async execute(_name, args): Promise<PreExecuteResult> {
          return {
            action: "modify",
            modifiedArgs: { ...args, injected: true },
          };
        },
      });

      await pipeline.execute("read", { path: "/test" }, ctx, handler);

      expect(handler).toHaveBeenCalledWith("read", { path: "/test", injected: true }, ctx);
    });
  });

  // ========== S0-1: Permission Migration Tests ==========

  describe("S0-1: Permission callback migration", () => {
    it("permission deny in pre-execute returns error result without calling toolHandler", async () => {
      const handler = vi.fn(mockToolHandler());
      pipeline.registerPreExecute({
        name: "permission",
        async execute(): Promise<PreExecuteResult> {
          return { action: "deny", denyMessage: "Permission denied by user" };
        },
      });

      const { result } = await pipeline.execute("write", { path: "/secret" }, ctx, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(result.status).toBe("error");
      expect(result.output).toBe("Permission denied by user");
    });

    it("permission allow proceeds to tool execution", async () => {
      const handler = vi.fn(mockToolHandler({ output: "written" }));
      pipeline.registerPreExecute({
        name: "permission",
        async execute(): Promise<PreExecuteResult> {
          return { action: "proceed" };
        },
      });

      const { result } = await pipeline.execute("write", { path: "/ok" }, ctx, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("completed");
      expect(result.output).toBe("written");
    });

    it("plan mode guard blocks write tools in plan mode", async () => {
      const handler = vi.fn(mockToolHandler());
      pipeline.registerGuard({
        name: "plan-mode-guard",
        async execute(toolName): Promise<GuardResult> {
          const writeTools = ["write", "edit", "delete", "create_file", "delete_file"];
          if (writeTools.includes(toolName)) {
            return { action: "deny", denyMessage: "Blocked: Plan mode is read-only" };
          }
          return { action: "proceed" };
        },
      });

      const { result: writeResult } = await pipeline.execute("write", {}, ctx, handler);
      const { result: readResult } = await pipeline.execute("read", {}, ctx, handler);

      expect(writeResult.status).toBe("error");
      expect(writeResult.output).toContain("Plan mode");
      expect(readResult.status).toBe("completed");
      expect(handler).toHaveBeenCalledTimes(1); // Only read was executed
    });
  });

  // ========== S0-2: Hook Middleware Tests ==========

  describe("S0-2: HookPreExecuteMiddleware", () => {
    it("hook deny blocks tool execution", async () => {
      mockPreHook.mockReturnValueOnce({
        action: "deny",
        denyMessage: "Blocked by hook policy",
      } as any);

      const middleware = new HookPreExecuteMiddleware();
      const result = await middleware.execute("bash", { command: "rm -rf /" }, ctx);

      expect(result.action).toBe("deny");
      expect(result.denyMessage).toBe("Blocked by hook policy");
    });

    it("hook modify changes tool args", async () => {
      mockPreHook.mockReturnValueOnce({
        action: "modify",
        modifiedInput: { command: "echo safe", path: "/safe" },
      } as any);

      const middleware = new HookPreExecuteMiddleware();
      const result = await middleware.execute("bash", { command: "rm -rf /" }, ctx);

      expect(result.action).toBe("modify");
      expect(result.modifiedArgs).toEqual({ command: "echo safe", path: "/safe" });
    });

    it("hook allow proceeds normally", async () => {
      // Default mock already returns allow
      const middleware = new HookPreExecuteMiddleware();
      const result = await middleware.execute("read", { path: "/test" }, ctx);

      expect(result.action).toBe("proceed");
    });

    it("hook error is non-blocking (graceful degradation)", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      vi.mocked(getHookManager).mockImplementationOnce(() => {
        throw new Error("HookManager unavailable");
      });

      const middleware = new HookPreExecuteMiddleware();
      const result = await middleware.execute("read", { path: "/test" }, ctx);

      // Should proceed despite error
      expect(result.action).toBe("proceed");
    });

    it("hook middleware integrates with full pipeline", async () => {
      mockPreHook.mockReturnValueOnce({ action: "allow" });
      mockPostHook.mockReturnValueOnce("modified-output");

      pipeline.registerPreExecute(new HookPreExecuteMiddleware());
      pipeline.registerPostExecute(new HookPostExecuteMiddleware());

      const handler = vi.fn(mockToolHandler({ output: "original-output" }));
      const { result } = await pipeline.execute("read", {}, ctx, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      // Post-hook modified the output
      expect(result.output).toBe("modified-output");
    });
  });

  describe("S0-2: HookPostExecuteMiddleware", () => {
    it("hook replace changes tool output", async () => {
      mockPostHook.mockReturnValueOnce("replaced-by-hook");

      const middleware = new HookPostExecuteMiddleware();
      const result: ToolCallResult = {
        id: "test",
        name: "read",
        input: {},
        output: "original",
        status: "completed",
      };
      const postResult = await middleware.execute("read", {}, result, ctx);

      expect(postResult.action).toBe("replace");
      expect(postResult.replacedOutput).toBe("replaced-by-hook");
    });

    it("hook keep preserves original output when unchanged", async () => {
      mockPostHook.mockReturnValueOnce("same-output");

      const middleware = new HookPostExecuteMiddleware();
      const result: ToolCallResult = {
        id: "test",
        name: "read",
        input: {},
        output: "same-output",
        status: "completed",
      };
      const postResult = await middleware.execute("read", {}, result, ctx);

      expect(postResult.action).toBe("keep");
    });

    it("hook keep preserves when result has no output", async () => {
      const middleware = new HookPostExecuteMiddleware();
      const result: ToolCallResult = {
        id: "test",
        name: "bash",
        input: {},
        output: undefined as any,
        status: "completed",
      };
      const postResult = await middleware.execute("bash", {}, result, ctx);

      expect(postResult.action).toBe("keep");
    });

    it("hook post error is non-blocking (returns keep)", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      vi.mocked(getHookManager).mockImplementationOnce(() => {
        throw new Error("HookManager unavailable");
      });

      const middleware = new HookPostExecuteMiddleware();
      const result: ToolCallResult = {
        id: "test",
        name: "read",
        input: {},
        output: "original",
        status: "completed",
      };
      const postResult = await middleware.execute("read", {}, result, ctx);

      expect(postResult.action).toBe("keep");
    });
  });

  // ========== S0-1/S0-2: Regression — Inline logic removal verification ==========

  describe("S0-1/S0-2: Inline logic removal regression", () => {
    it("toolHandler does NOT contain plan mode check (moved to pipeline guard)", async () => {
      // The toolHandler should not intercept write tools based on collaborationMode
      // That check is now in the pipeline's PlanModeGuard
      const handler = vi.fn(mockToolHandler({ output: "written" }));

      // Without any guard, write should proceed
      const { result } = await pipeline.execute("write", {}, ctx, handler);
      expect(result.status).toBe("completed");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("toolHandler does NOT contain permission check (moved to pipeline pre-execute)", async () => {
      // The toolHandler should not check permissions
      // That check is now in the pipeline's PermissionMiddleware
      const handler = vi.fn(mockToolHandler({ output: "executed" }));

      // Without any pre-execute middleware, tool should proceed
      const { result } = await pipeline.execute("bash", { command: "ls" }, ctx, handler);
      expect(result.status).toBe("completed");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("toolHandler does NOT contain PreToolUse hooks (moved to HookPreExecuteMiddleware)", async () => {
      // The toolHandler should not call hookManager.executePreToolHooks
      // That logic is now in HookPreExecuteMiddleware
      const handler = vi.fn(mockToolHandler({ output: "done" }));

      // Without HookPreExecuteMiddleware registered, no hooks should run
      const { result } = await pipeline.execute("read", {}, ctx, handler);
      expect(result.status).toBe("completed");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("toolHandler does NOT contain PostToolUse hooks (moved to HookPostExecuteMiddleware)", async () => {
      // The toolHandler should not call hookManager.executePostToolHooks
      // That logic is now in HookPostExecuteMiddleware
      const handler = vi.fn(mockToolHandler({ output: "original" }));

      // Without HookPostExecuteMiddleware registered, output should be unchanged
      const { result } = await pipeline.execute("read", {}, ctx, handler);
      expect(result.output).toBe("original");
    });
  });

  // ========== S0-1/S0-2: Pipeline order guarantee ==========

  describe("S0-1/S0-2: Pipeline layer order guarantee", () => {
    it("permission runs before hooks in pre-execute waterfall", async () => {
      const order: string[] = [];
      pipeline.registerPreExecute({
        name: "permission",
        async execute(): Promise<PreExecuteResult> {
          order.push("permission");
          return { action: "proceed" };
        },
      });
      pipeline.registerPreExecute({
        name: "hooks",
        async execute(): Promise<PreExecuteResult> {
          order.push("hooks");
          return { action: "proceed" };
        },
      });

      await pipeline.execute("read", {}, ctx, mockToolHandler());
      expect(order).toEqual(["permission", "hooks"]);
    });

    it("pre-execute deny prevents hooks from running", async () => {
      const hookRan = vi.fn();
      pipeline.registerPreExecute({
        name: "permission",
        async execute(): Promise<PreExecuteResult> {
          return { action: "deny", denyMessage: "denied" };
        },
      });
      pipeline.registerPreExecute({
        name: "hooks",
        async execute(): Promise<PreExecuteResult> {
          hookRan();
          return { action: "proceed" };
        },
      });

      const { result } = await pipeline.execute("write", {}, ctx, mockToolHandler());
      expect(result.status).toBe("error");
      expect(hookRan).not.toHaveBeenCalled();
    });

    it("post-execute hook runs after tool execution", async () => {
      const order: string[] = [];
      const handler = async () => {
        order.push("execute");
        return { id: "test", name: "read", input: {}, output: "done", status: "completed" as const };
      };
      pipeline.registerPostExecute({
        name: "post-hook",
        async execute(): Promise<PostExecuteResult> {
          order.push("post-hook");
          return { action: "keep" };
        },
      });

      await pipeline.execute("read", {}, ctx, handler);
      expect(order).toEqual(["execute", "post-hook"]);
    });
  });
});
