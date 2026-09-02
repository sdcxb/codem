/**
 * 回归测试：execute_command 前端传 timeout_ms 给 Rust（超时杀进程树）
 *
 * 背景（对标审计，dsh subprocess-local 树级 kill）：
 *   bash 工具超时用 Promise.race 放弃 Promise，底层 PowerShell 仍在后台跑 →
 *   反复超时堆积僵尸进程。修复：file-api.executeCommand 透传 timeout_ms 给
 *   Rust，Rust 超时后 taskkill /T /F 杀进程树。
 *
 * 本测试验证前端契约：executeCommand 第 3 参 timeoutMs 会出现在传给
 * Rust execute_command 的 args.timeout_ms 中。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

describe("execute_command timeout 透传（防僵尸进程）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).__TAURI__;
  });

  it("TMO-001: file-api.executeCommand 透传 timeout_ms 给 Rust", async () => {
    const invoke = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    (window as any).__TAURI__ = { core: { invoke } };

    const { executeCommand } = await import("../core/file-api");
    await executeCommand("sleep 60", "C:\\work", 15000);

    expect(invoke).toHaveBeenCalledWith("execute_command", {
      command: "sleep 60",
      cwd: "C:\\work",
      timeout_ms: 15000,
    });
  });

  it("TMO-002: 不传 timeoutMs 时 Rust 用默认（undefined → 后端 600s 兜底）", async () => {
    const invoke = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    (window as any).__TAURI__ = { core: { invoke } };

    const { executeCommand } = await import("../core/file-api");
    await executeCommand("echo hi", "C:\\work");

    const call = invoke.mock.calls[0];
    expect(call[0]).toBe("execute_command");
    expect((call[1] as any).timeout_ms).toBeUndefined();
    expect((call[1] as any).command).toBe("echo hi");
  });
});
