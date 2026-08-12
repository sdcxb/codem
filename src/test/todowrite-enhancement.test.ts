/**
 * Tests for P1-8: TodoWrite Enhancement
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock storage/database with proper path resolution
vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({
    run: vi.fn(),
    exec: vi.fn().mockReturnValue([]),
  }),
  persistDatabase: vi.fn(),
  saveMessage: vi.fn(),
  listMessages: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessagesByIds: vi.fn(),
  messagesToLLMMessages: vi.fn().mockReturnValue([]),
}));

import { createShowTodoTool } from "../core/llm/tools/show-todo";
import type { ToolContext } from "../core/llm/tools";

const mockCtx: ToolContext = {
  sessionId: "test-session",
  messageId: "test-msg",
  cwd: "/test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
};

describe("P1-8: TodoWrite Enhancement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should include completion statistics in output", async () => {
    const tool = createShowTodoTool();
    const result = await tool.execute({
      todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "in_progress" },
        { content: "Task 3", status: "pending" },
      ],
    }, mockCtx);
    expect(result.output).toContain("已完成: 1");
    expect(result.output).toContain("进行中: 1");
    expect(result.output).toContain("待办: 1");
  });

  it("should include verification nudge when all tasks are completed", async () => {
    const tool = createShowTodoTool();
    const result = await tool.execute({
      todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "completed" },
      ],
    }, mockCtx);
    expect(result.output).toContain("所有任务已标记为完成");
    expect(result.output).toContain("验证");
    expect(result.title).toBe("Todo List — All Completed");
  });

  it("should NOT include verification nudge when tasks are incomplete", async () => {
    const tool = createShowTodoTool();
    const result = await tool.execute({
      todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "pending" },
      ],
    }, mockCtx);
    expect(result.output).not.toContain("所有任务已标记为完成");
    expect(result.title).toBe("Todo List Created");
  });

  it("should include metadata with verificationNudgeNeeded flag", async () => {
    const tool = createShowTodoTool();
    const result = await tool.execute({
      todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "completed" },
      ],
    }, mockCtx);
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.verificationNudgeNeeded).toBe(true);
    expect(result.metadata!.completed).toBe(2);
    expect(result.metadata!.totalTasks).toBe(2);
  });

  it("should set verificationNudgeNeeded to false when incomplete", async () => {
    const tool = createShowTodoTool();
    const result = await tool.execute({
      todos: [
        { content: "Task 1", status: "in_progress" },
      ],
    }, mockCtx);
    expect(result.metadata!.verificationNudgeNeeded).toBe(false);
  });

  it("should return error for empty todo list", async () => {
    const tool = createShowTodoTool();
    const result = await tool.execute({
      todos: [],
    }, mockCtx);
    expect(result.output).toContain("不能为空");
  });
});
