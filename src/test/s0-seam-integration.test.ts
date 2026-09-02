/**
 * S0-3: Capability Seam Integration Tests
 *
 * Validates:
 * - SeamRegistry register/get/has/clear
 * - LocalFileSystemProvider implements FileSystemSeam interface
 * - LocalShellProvider implements ShellSeam interface
 * - initDefaultSeams registers filesystem and shell providers
 * - Provider hot-swap: registering a new provider replaces the old one
 * - FileSystemSeam definitions are registered correctly
 * - Provider isAvailable() returns true for local providers
 * - readViaSeam fallback when seam not initialized
 *
 * Affected files:
 *   - src/core/seam/types.ts (SeamRegistry, initDefaultSeams)
 *   - src/core/seam/local-fs-provider.ts (LocalFileSystemProvider)
 *   - src/core/seam/local-shell-provider.ts (LocalShellProvider)
 *   - src/core/llm/tools.ts (readViaSeam helper)
 *   - src/App.tsx (initDefaultSeams call)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock file-api to avoid actual filesystem access
vi.mock("../core/file-api", () => ({
  readFile: vi.fn().mockResolvedValue("mock file content"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  listDirectory: vi.fn().mockResolvedValue([
    { name: "file1.txt", isDirectory: false, path: "/test/file1.txt" },
    { name: "dir1", isDirectory: true, path: "/test/dir1" },
    { name: "path", isDirectory: false, path: "/test/path" },
  ]),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn().mockResolvedValue(true),
  globSearch: vi.fn().mockResolvedValue(["/mock/path1", "/mock/path2"]),
  grepSearch: vi.fn().mockResolvedValue([
    { file: "/mock/file.ts", line: 1, content: "test line" },
  ]),
  executeCommand: vi.fn().mockResolvedValue({
    stdout: "command output",
    stderr: "",
    exitCode: 0,
  }),
}));

// Mock settings for HookManager
vi.mock("../core/storage/settings", () => ({
  getSettingJSON: vi.fn().mockReturnValue({ hooks: [] }),
  setSettingJSON: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
}));

describe("S0-3: Capability Seam Integration", () => {

  // ========== SeamRegistry Tests ==========

  describe("SeamRegistry", () => {
    let registry: any;

    beforeEach(async () => {
      const { getSeamRegistry } = await import("../core/seam/types");
      registry = getSeamRegistry();
      registry.clear();
    });

    it("registers and retrieves a provider", async () => {
      const { getSeamRegistry } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      const mockProvider = {
        id: "test-provider",
        isAvailable: () => true,
        readFile: vi.fn().mockResolvedValue("test"),
      };
      registry.registerProvider("filesystem", mockProvider);

      const retrieved = registry.getProvider("filesystem");
      expect(retrieved).toBe(mockProvider);
    });

    it("hasProvider returns true for registered, false for missing", async () => {
      const { getSeamRegistry } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      registry.registerProvider("filesystem", { id: "test", isAvailable: () => true });
      expect(registry.hasProvider("filesystem")).toBe(true);
      expect(registry.hasProvider("shell")).toBe(false);
    });

    it("getProvider throws when no provider registered", async () => {
      const { getSeamRegistry } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      expect(() => registry.getProvider("nonexistent")).toThrow(
        "No provider registered for seam: nonexistent",
      );
    });

    it("clear removes all providers", async () => {
      const { getSeamRegistry } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.registerProvider("filesystem", { id: "test" });
      expect(registry.hasProvider("filesystem")).toBe(true);

      registry.clear();
      expect(registry.hasProvider("filesystem")).toBe(false);
    });

    it("registerDefinition stores service definition", async () => {
      const { getSeamRegistry, FileSystemSeamDefinition } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      registry.registerDefinition(FileSystemSeamDefinition);
      expect(registry.listSeams()).toContain("filesystem");
    });

    it("registering a new provider replaces the old one (hot-swap)", async () => {
      const { getSeamRegistry } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      const provider1 = { id: "provider-1", isAvailable: () => true, readFile: () => Promise.resolve("v1") };
      const provider2 = { id: "provider-2", isAvailable: () => true, readFile: () => Promise.resolve("v2") };

      registry.registerProvider("filesystem", provider1);
      expect(registry.getProvider("filesystem").id).toBe("provider-1");

      registry.registerProvider("filesystem", provider2);
      expect(registry.getProvider("filesystem").id).toBe("provider-2");
    });
  });

  // ========== LocalFileSystemProvider Tests ==========

  describe("LocalFileSystemProvider", () => {
    it("implements FileSystemSeam interface", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const provider = new LocalFileSystemProvider();

      expect(provider.id).toBe("local-fs");
      expect(typeof provider.isAvailable).toBe("function");
      expect(typeof provider.readFile).toBe("function");
      expect(typeof provider.writeFile).toBe("function");
      expect(typeof provider.listDirectory).toBe("function");
      expect(typeof provider.deleteFile).toBe("function");
      expect(typeof provider.exists).toBe("function");
      expect(typeof provider.glob).toBe("function");
      expect(typeof provider.grep).toBe("function");
    });

    it("isAvailable returns true", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const provider = new LocalFileSystemProvider();
      expect(provider.isAvailable()).toBe(true);
    });

    it("readFile delegates to file-api", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const { readFile } = await import("../core/file-api");
      const provider = new LocalFileSystemProvider();

      const result = await provider.readFile("/test/path");
      // Absolute path is passed through directly (cwd is undefined)
      expect(readFile).toHaveBeenCalledWith("/test/path");
      expect(result).toBe("mock file content");
    });

    it("readFile resolves relative path against cwd", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const { readFile } = await import("../core/file-api");
      const provider = new LocalFileSystemProvider();

      (readFile as any).mockClear();
      await provider.readFile("src/main.ts", "/workspace");
      expect(readFile).toHaveBeenCalledWith("/workspace/src/main.ts");
    });

    it("writeFile delegates to file-api", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const { writeFile } = await import("../core/file-api");
      const provider = new LocalFileSystemProvider();

      await provider.writeFile("/test/path", "content");
      expect(writeFile).toHaveBeenCalledWith("/test/path", "content", { workspace: undefined });
    });

    it("listDirectory maps entries correctly", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const provider = new LocalFileSystemProvider();

      const entries = await provider.listDirectory("/test");
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ name: "file1.txt", isDir: false, size: 0 });
      expect(entries[1]).toEqual({ name: "dir1", isDir: true, size: 0 });
    });

    it("exists delegates to file-api.listDirectory", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const { listDirectory } = await import("../core/file-api");
      const provider = new LocalFileSystemProvider();

      const result = await provider.exists("/test/path");
      // exists() uses listDirectory to check if the file is listed in the parent dir
      expect(listDirectory).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("glob delegates to file-api.globSearch", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const { globSearch } = await import("../core/file-api");
      const provider = new LocalFileSystemProvider();

      const result = await provider.glob("*.ts", "/workspace");
      expect(globSearch).toHaveBeenCalledWith("*.ts", "/workspace");
      expect(result).toEqual(["/mock/path1", "/mock/path2"]);
    });

    it("grep delegates to file-api.grepSearch", async () => {
      const { LocalFileSystemProvider } = await import("../core/seam/local-fs-provider");
      const { grepSearch } = await import("../core/file-api");
      const provider = new LocalFileSystemProvider();

      const result = await provider.grep("pattern", "/workspace", "*.ts");
      expect(grepSearch).toHaveBeenCalledWith("pattern", "/workspace", "*.ts");
      // grep returns mapped results (file, line, content from the raw string results)
      expect(result).toHaveLength(1);
      expect(result[0].file).toBeDefined();
    });
  });

  // ========== LocalShellProvider Tests ==========

  describe("LocalShellProvider", () => {
    it("implements ShellSeam interface", async () => {
      const { LocalShellProvider } = await import("../core/seam/local-shell-provider");
      const provider = new LocalShellProvider();

      expect(provider.id).toBe("local-shell");
      expect(typeof provider.isAvailable).toBe("function");
      expect(typeof provider.execute).toBe("function");
    });

    it("isAvailable returns true", async () => {
      const { LocalShellProvider } = await import("../core/seam/local-shell-provider");
      const provider = new LocalShellProvider();
      expect(provider.isAvailable()).toBe(true);
    });

    it("execute delegates to file-api.executeCommand", async () => {
      const { LocalShellProvider } = await import("../core/seam/local-shell-provider");
      const { executeCommand } = await import("../core/file-api");
      const provider = new LocalShellProvider();

      const result = await provider.execute("ls -la", "/workspace", 5000);
      // FIX: timeoutMs 现在转发给 file-api.executeCommand（Rust 超时杀进程树）
      expect(executeCommand).toHaveBeenCalledWith("ls -la", "/workspace", 5000);
      expect(result).toEqual({
        stdout: "command output",
        stderr: "",
        exitCode: 0,
      });
    });

    it("execute handles undefined timeoutMs", async () => {
      const { LocalShellProvider } = await import("../core/seam/local-shell-provider");
      const provider = new LocalShellProvider();

      const result = await provider.execute("echo hello", "/workspace");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("command output");
    });
  });

  // ========== initDefaultSeams Tests ==========

  describe("initDefaultSeams", () => {
    it("registers filesystem and shell providers", async () => {
      const { getSeamRegistry, initDefaultSeams } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      await initDefaultSeams();

      expect(registry.hasProvider("filesystem")).toBe(true);
      expect(registry.hasProvider("shell")).toBe(true);

      const fs = registry.getProvider("filesystem");
      expect(fs.id).toBe("local-fs");
      expect(fs.isAvailable()).toBe(true);

      const shell = registry.getProvider("shell");
      expect(shell.id).toBe("local-shell");
      expect(shell.isAvailable()).toBe(true);
    });

    it("registers all service definitions", async () => {
      const { getSeamRegistry, initDefaultSeams } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      await initDefaultSeams();

      const seams = registry.listSeams();
      expect(seams).toContain("filesystem");
      expect(seams).toContain("shell");
      expect(seams).toContain("llm");
      expect(seams).toContain("subagent");
      expect(seams).toContain("web");
    });

    it("is idempotent — calling twice doesn't break", async () => {
      const { getSeamRegistry, initDefaultSeams } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();

      await initDefaultSeams();
      await initDefaultSeams(); // Should not throw

      expect(registry.hasProvider("filesystem")).toBe(true);
      expect(registry.hasProvider("shell")).toBe(true);
    });
  });

  // ========== Seam Hot-Swap Simulation ==========

  describe("Provider hot-swap", () => {
    it("swapping filesystem provider changes behavior without code changes", async () => {
      const { getSeamRegistry, initDefaultSeams } = await import("../core/seam/types");
      const registry = getSeamRegistry();
      registry.clear();
      await initDefaultSeams();

      // Original local provider
      const localFs = registry.getProvider("filesystem");
      expect(localFs.id).toBe("local-fs");

      // Simulate swapping to a "remote" provider
      const remoteProvider = {
        id: "remote-fs",
        isAvailable: () => true,
        async readFile() { return "remote content"; },
        async writeFile() {},
        async listDirectory() { return []; },
        async deleteFile() {},
        async exists() { return false; },
        async glob() { return []; },
        async grep() { return []; },
      };
      registry.registerProvider("filesystem", remoteProvider);

      const swapped = registry.getProvider("filesystem");
      expect(swapped.id).toBe("remote-fs");
      expect(await swapped.readFile("/any")).toBe("remote content");
    });
  });
});
