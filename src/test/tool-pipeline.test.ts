/**
 * P0-2: Tool Pipeline — 5-Layer Waterfall Tests
 *
 * Tests:
 * 1. Pre-execute deny stops execution
 * 2. Pre-execute modify changes args
 * 3. Guard deny stops execution
 * 4. Post-execute replace changes output
 * 5. Post-execute append adds to output
 * 6. Post-execute reject stops execution
 * 7. Finalize middleware runs last
 * 8. Full pipeline flow with all layers
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ToolPipeline,
  type PreExecuteMiddleware,
  type GuardMiddleware,
  type PostExecuteMiddleware,
  type FinalizeMiddleware,
  type PreExecuteResult,
  type GuardResult,
  type PostExecuteResult,
  type PipelineEvent,
} from "../core/llm/tool-pipeline";
import type { ToolExecutorContext } from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

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
    status: result.status || "completed",
  });
}

describe("P0-2: Tool Pipeline", () => {
  let pipeline: ToolPipeline;
  let ctx: ToolExecutorContext;

  beforeEach(() => {
    pipeline = new ToolPipeline();
    ctx = mockCtx();
  });

  describe("Layer 1: pre-execute", () => {
    it("should proceed when pre-execute returns proceed", async () => {
      const mw: PreExecuteMiddleware = {
        name: "test-pre",
        async execute(): Promise<PreExecuteResult> {
          return { action: "proceed" };
        },
      };
      pipeline.registerPreExecute(mw);

      const { result } = await pipeline.execute("read", { path: "/test" }, ctx, mockToolHandler());
      expect(result.status).toBe("completed");
      expect(result.output).toBe("tool output");
    });

    it("should deny when pre-execute returns deny", async () => {
      const mw: PreExecuteMiddleware = {
        name: "test-deny",
        async execute(): Promise<PreExecuteResult> {
          return { action: "deny", denyMessage: "Not allowed" };
        },
      };
      pipeline.registerPreExecute(mw);

      const { result } = await pipeline.execute("write", { path: "/test" }, ctx, mockToolHandler());
      expect(result.status).toBe("error");
      expect(result.output).toBe("Not allowed");
    });

    it("should modify args when pre-execute returns modify", async () => {
      const mw: PreExecuteMiddleware = {
        name: "test-modify",
        async execute(name, args): Promise<PreExecuteResult> {
          return {
            action: "modify",
            modifiedName: name,
            modifiedArgs: { ...args, modified: true },
          };
        },
      };
      pipeline.registerPreExecute(mw);

      const handler = vi.fn(mockToolHandler());
      await pipeline.execute("read", { path: "/test" }, ctx, handler);
      expect(handler).toHaveBeenCalledWith("read", { path: "/test", modified: true }, ctx);
    });

    it("should run multiple pre-execute in waterfall order", async () => {
      const order: string[] = [];
      pipeline.registerPreExecute({
        name: "first",
        async execute() {
          order.push("first");
          return { action: "proceed" };
        },
      });
      pipeline.registerPreExecute({
        name: "second",
        async execute() {
          order.push("second");
          return { action: "proceed" };
        },
      });

      await pipeline.execute("read", {}, ctx, mockToolHandler());
      expect(order).toEqual(["first", "second"]);
    });
  });

  describe("Layer 2: guards", () => {
    it("should deny when guard returns deny", async () => {
      pipeline.registerGuard({
        name: "test-guard",
        async execute(): Promise<GuardResult> {
          return { action: "deny", denyMessage: "Guard blocked" };
        },
      });

      const { result } = await pipeline.execute("write", {}, ctx, mockToolHandler());
      expect(result.status).toBe("error");
      expect(result.output).toBe("Guard blocked");
    });

    it("should proceed when guard returns proceed", async () => {
      pipeline.registerGuard({
        name: "test-guard",
        async execute(): Promise<GuardResult> {
          return { action: "proceed" };
        },
      });

      const { result } = await pipeline.execute("read", {}, ctx, mockToolHandler());
      expect(result.status).toBe("completed");
    });

    it("should run guards in frozen order", async () => {
      const order: string[] = [];
      pipeline.registerGuard({
        name: "guard1",
        async execute() {
          order.push("guard1");
          return { action: "proceed" };
        },
      });
      pipeline.registerGuard({
        name: "guard2",
        async execute() {
          order.push("guard2");
          return { action: "proceed" };
        },
      });

      await pipeline.execute("read", {}, ctx, mockToolHandler());
      expect(order).toEqual(["guard1", "guard2"]);
    });
  });

  describe("Layer 3: execute", () => {
    it("should call the tool handler and return result", async () => {
      const { result } = await pipeline.execute(
        "read",
        { path: "/test" },
        ctx,
        mockToolHandler({ output: "file content" }),
      );
      expect(result.output).toBe("file content");
    });

    it("should handle tool execution errors", async () => {
      const errorHandler = async (): Promise<ToolCallResult> => {
        throw new Error("Tool crashed");
      };

      const { result } = await pipeline.execute("bash", { command: "bad" }, ctx, errorHandler);
      expect(result.status).toBe("error");
      expect(result.output).toBe("Error: Tool crashed");
    });
  });

  describe("Layer 4: post-execute", () => {
    it("should replace output when post-execute returns replace", async () => {
      pipeline.registerPostExecute({
        name: "replace-mw",
        async execute(): Promise<PostExecuteResult> {
          return { action: "replace", replacedOutput: "replaced" };
        },
      });

      const { result } = await pipeline.execute("read", {}, ctx, mockToolHandler({ output: "original" }));
      expect(result.output).toBe("replaced");
    });

    it("should append to output when post-execute returns append", async () => {
      pipeline.registerPostExecute({
        name: "append-mw",
        async execute(): Promise<PostExecuteResult> {
          return { action: "append", appendedText: "appended" };
        },
      });

      const { result } = await pipeline.execute("read", {}, ctx, mockToolHandler({ output: "original" }));
      expect(result.output).toBe("original\nappended");
    });

    it("should reject when post-execute returns reject", async () => {
      pipeline.registerPostExecute({
        name: "reject-mw",
        async execute(): Promise<PostExecuteResult> {
          return { action: "reject", rejectMessage: "Rejected" };
        },
      });

      const { result } = await pipeline.execute("read", {}, ctx, mockToolHandler({ output: "original" }));
      expect(result.status).toBe("error");
      expect(result.output).toBe("Rejected");
    });
  });

  describe("Layer 5: finalize", () => {
    it("should run finalize middleware after post-execute", async () => {
      const order: string[] = [];
      pipeline.registerPostExecute({
        name: "post",
        async execute() {
          order.push("post");
          return { action: "keep" };
        },
      });
      pipeline.registerFinalize({
        name: "finalize",
        async execute(toolName, args, result) {
          order.push("finalize");
          return result;
        },
      });

      await pipeline.execute("read", {}, ctx, mockToolHandler());
      expect(order).toEqual(["post", "finalize"]);
    });
  });

  describe("Full pipeline", () => {
    it("should execute all 5 layers in order", async () => {
      const order: string[] = [];

      pipeline.registerPreExecute({
        name: "pre",
        async execute() {
          order.push("pre");
          return { action: "proceed" };
        },
      });
      pipeline.registerGuard({
        name: "guard",
        async execute() {
          order.push("guard");
          return { action: "proceed" };
        },
      });
      pipeline.registerPostExecute({
        name: "post",
        async execute() {
          order.push("post");
          return { action: "keep" };
        },
      });
      pipeline.registerFinalize({
        name: "finalize",
        async execute(_name, _args, result) {
          order.push("finalize");
          return result;
        },
      });

      const handler = async (name: string) => {
        order.push("execute");
        return {
          id: ctx.messageId,
          name,
          input: {},
          output: "done",
          status: "completed" as const,
        };
      };

      const { result, events } = await pipeline.execute("read", {}, ctx, handler);

      expect(order).toEqual(["pre", "guard", "execute", "post", "finalize"]);
      expect(result.output).toBe("done");
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.layer === "pre-execute")).toBe(true);
      expect(events.some(e => e.layer === "guard")).toBe(true);
      expect(events.some(e => e.layer === "execute")).toBe(true);
      expect(events.some(e => e.layer === "post-execute")).toBe(true);
      expect(events.some(e => e.layer === "finalize")).toBe(true);
    });

    it("should short-circuit on first deny", async () => {
      pipeline.registerPreExecute({
        name: "blocker",
        async execute(): Promise<PreExecuteResult> {
          return { action: "deny", denyMessage: "Blocked at pre-execute" };
        },
      });
      pipeline.registerGuard({
        name: "should-not-run",
        async execute(): Promise<GuardResult> {
          throw new Error("Guard should not run after pre-execute deny");
        },
      });

      const { result, events } = await pipeline.execute("read", {}, ctx, mockToolHandler());

      expect(result.status).toBe("error");
      expect(result.output).toBe("Blocked at pre-execute");
      // Only pre-execute event should exist
      expect(events.filter(e => e.layer === "guard").length).toBe(0);
    });
  });
});
