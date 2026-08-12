/**
 * Tests for P0-4: Hooks System
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { matchesTool, shouldFireHook, type HookDefinition } from "../core/hooks/hook-types";

// Mock settings and file-api for hook-manager tests
vi.mock("../core/storage/settings", () => ({
  getSettingJSON: vi.fn().mockReturnValue({ hooks: [] }),
  setSettingJSON: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

describe("P0-4: Hooks System", () => {

  describe("matchesTool", () => {
    it("should match exact tool name", () => {
      expect(matchesTool("bash", "bash")).toBe(true);
      expect(matchesTool("read", "read")).toBe(true);
    });

    it("should be case-insensitive for tool name", () => {
      expect(matchesTool("Bash", "bash")).toBe(true);
      expect(matchesTool("BASH", "bash")).toBe(true);
    });

    it("should not match different tool names", () => {
      expect(matchesTool("bash", "read")).toBe(false);
      expect(matchesTool("read", "bash")).toBe(false);
    });

    it("should match Bash(git *) pattern for git commands", () => {
      expect(matchesTool("Bash(git *)", "bash", { command: "git commit -m fix" })).toBe(true);
      expect(matchesTool("Bash(git *)", "bash", { command: "git push" })).toBe(true);
    });

    it("should not match Bash(git *) for non-git commands", () => {
      expect(matchesTool("Bash(git *)", "bash", { command: "npm install" })).toBe(false);
      expect(matchesTool("Bash(git *)", "bash", { command: "ls -la" })).toBe(false);
    });

    it("should match exact command pattern", () => {
      expect(matchesTool("Bash(git commit)", "bash", { command: "git commit" })).toBe(true);
      expect(matchesTool("Bash(git commit)", "bash", { command: "git push" })).toBe(false);
    });
  });

  describe("shouldFireHook", () => {
    const baseHook: HookDefinition = {
      id: "test-hook",
      event: "PreToolUse",
      name: "Test Hook",
      type: "command",
      command: "echo allow",
      enabled: true,
    };

    it("should fire when event matches and no condition", () => {
      expect(shouldFireHook(baseHook, "PreToolUse", "bash")).toBe(true);
    });

    it("should not fire when event does not match", () => {
      expect(shouldFireHook(baseHook, "PostToolUse", "bash")).toBe(false);
    });

    it("should not fire when disabled", () => {
      expect(shouldFireHook({ ...baseHook, enabled: false }, "PreToolUse", "bash")).toBe(false);
    });

    it("should fire when condition matches tool name", () => {
      const hook: HookDefinition = {
        ...baseHook,
        condition: { tool: "bash" },
      };
      expect(shouldFireHook(hook, "PreToolUse", "bash")).toBe(true);
    });

    it("should not fire when condition does not match tool name", () => {
      const hook: HookDefinition = {
        ...baseHook,
        condition: { tool: "read" },
      };
      expect(shouldFireHook(hook, "PreToolUse", "bash")).toBe(false);
    });

    it("should fire when condition matches Bash(git *) pattern", () => {
      const hook: HookDefinition = {
        ...baseHook,
        condition: { tool: "Bash(git *)" },
      };
      expect(shouldFireHook(hook, "PreToolUse", "bash", { command: "git commit" })).toBe(true);
      expect(shouldFireHook(hook, "PreToolUse", "bash", { command: "npm install" })).toBe(false);
    });
  });

  describe("HookManager", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      const { resetHookManager } = await import("../core/hooks/hook-manager");
      resetHookManager();
    });

    it("should return 'allow' when no hooks are registered", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      const manager = getHookManager();
      const result = await manager.executePreToolHooks("bash", { command: "ls" }, {
        sessionId: "test",
        toolName: "bash",
        input: { command: "ls" },
        cwd: "/test",
      });
      expect(result.action).toBe("allow");
    });

    it("should return output unchanged when no PostToolUse hooks are registered", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      const manager = getHookManager();
      const result = await manager.executePostToolHooks("bash", { command: "ls" }, "output", {
        sessionId: "test",
        toolName: "bash",
        input: { command: "ls" },
        cwd: "/test",
      });
      expect(result).toBe("output");
    });

    it("should skip hooks when disabled", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      const manager = getHookManager();
      manager.setEnabled(false);
      const result = await manager.executePreToolHooks("bash", { command: "ls" }, {
        sessionId: "test",
        toolName: "bash",
        input: { command: "ls" },
        cwd: "/test",
      });
      expect(result.action).toBe("allow");
    });

    it("should skip PreToolUse hooks in sub-agent mode", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      const manager = getHookManager();
      manager.setSubAgentMode(true);
      const result = await manager.executePreToolHooks("bash", { command: "ls" }, {
        sessionId: "test",
        toolName: "bash",
        input: { command: "ls" },
        cwd: "/test",
      });
      expect(result.action).toBe("allow");
    });

    it("should add and persist hooks", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      const { setSettingJSON } = await import("../core/storage/settings");
      const manager = getHookManager();
      manager.addHook({
        id: "test-1",
        event: "PreToolUse",
        name: "Block rm -rf",
        type: "command",
        command: "echo DENY",
        enabled: true,
        condition: { tool: "bash" },
      });
      expect(setSettingJSON).toHaveBeenCalled();
      const config = manager.getConfig();
      expect(config.hooks).toHaveLength(1);
    });

    it("should remove hooks by id", async () => {
      const { getHookManager } = await import("../core/hooks/hook-manager");
      const manager = getHookManager();
      manager.addHook({
        id: "test-1",
        event: "PreToolUse",
        name: "Test",
        type: "command",
        command: "echo DENY",
        enabled: true,
      });
      manager.removeHook("test-1");
      expect(manager.getConfig().hooks).toHaveLength(0);
    });
  });
});
