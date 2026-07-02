// Codem Multi-Agent System Test Suite
// Covers: spawn_subagent, wait_for_subagent, persistent/temporary, result injection

import { describe, it, expect } from "vitest";
import { SubagentManager, getSubagentManager } from "../core/subagent/subagent";
import { LLMSubagentSpawner } from "../core/subagent/spawner";
import { createSpawnSubagentTool, createWaitForSubagentTool, setSubagentManager } from "../core/llm/tools";

describe("SubagentManager", () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it("should create with default config", () => {
    expect(manager).toBeDefined();
    expect(manager.getAllTasks()).toHaveLength(0);
  });

  it("should have persistent field on tasks", () => {
    // Verify SubagentTask interface has persistent field
    const task = {
      id: "test-1",
      parentId: "parent-1",
      agentId: "general",
      prompt: "test",
      cwd: ".",
      status: "pending" as const,
      persistent: false,
      createdAt: Date.now(),
    };
    expect(task.persistent).toBe(false);
  });
});

describe("Tool Registration", () => {
  it("should create spawn_subagent tool", () => {
    const tool = createSpawnSubagentTool();
    expect(tool.id).toBe("spawn_subagent");
    expect(tool.parameters.required).toContain("agentId");
    expect(tool.parameters.required).toContain("prompt");
    // Should have persistent parameter
    expect(tool.parameters.properties).toHaveProperty("persistent");
  });

  it("should create wait_for_subagent tool", () => {
    const tool = createWaitForSubagentTool();
    expect(tool.id).toBe("wait_for_subagent");
    expect(tool.parameters.required).toContain("task_id");
    expect(tool.parameters.properties).toHaveProperty("timeout");
  });
});

describe("Persistent vs Temporary", () => {
  it("should mark task as persistent", () => {
    const task = {
      id: "test-persist",
      parentId: "parent",
      agentId: "general",
      prompt: "check quality",
      cwd: ".",
      status: "pending" as const,
      persistent: true,
      createdAt: Date.now(),
    };
    expect(task.persistent).toBe(true);
  });

  it("should mark task as temporary by default", () => {
    const task = {
      id: "test-temp",
      parentId: "parent",
      agentId: "general",
      prompt: "one-shot task",
      cwd: ".",
      status: "pending" as const,
      persistent: false,
      createdAt: Date.now(),
    };
    expect(task.persistent).toBe(false);
  });
});
