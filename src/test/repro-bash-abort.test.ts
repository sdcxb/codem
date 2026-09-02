/**
 * 回归测试：bash 工具支持外部取消（用户中止会话时立即返回）
 *
 * 背景（对标 dsh abort 语义）：
 *   之前 bash 工具超时 race 只监听内部 timeout controller，不监听 ctx.abort
 *   （用户取消/会话中止）。用户点取消后，命令继续跑直到超时（最长 600s）。
 *   修复：ctx.abort 触发时立即 reject "Command cancelled"，并在 finally 清理
 *   所有监听防泄漏。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecuteCommand } = vi.hoisted(() => ({ mockExecuteCommand: vi.fn() }));

vi.mock("../core/file-api", () => ({
  executeCommand: (...args: any[]) => mockExecuteCommand(...args),
  exists: vi.fn().mockReturnValue(true),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn().mockReturnValue([]),
  deletePath: vi.fn().mockResolvedValue(undefined),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { createDefaultToolRegistry } from "../core/llm/tools";

function makeCtx(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    sessionId: "sess",
    messageId: "msg",
    cwd: "C:\\work",
    abort: controller.signal,
    messages: [],
    metadata: () => ({}),
  } as any;
}

describe("bash 工具外部取消（abort）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ABT-001: ctx.abort 已触发时 bash 立即返回 Command cancelled（不等命令完成）", async () => {
    // executeCommand 永不完全（模拟卡住命令）
    mockExecuteCommand.mockImplementation(() => new Promise(() => {}));
    const registry = createDefaultToolRegistry();
    const tool = registry.get("bash")!;
    // 已 abort 的 ctx
    const result = await tool.execute({ command: "sleep 100" }, makeCtx(true));
    expect(result.output).toContain("Command cancelled");
    // 不应真正执行命令（已取消）
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("ABT-002: 执行中 ctx.abort 触发 → 立即返回 Command cancelled", async () => {
    // 命令 pending，之后外部 abort
    mockExecuteCommand.mockImplementation(() => new Promise(() => {}));
    const registry = createDefaultToolRegistry();
    const tool = registry.get("bash")!;

    const controller = new AbortController();
    const ctx = makeCtx(false);
    (ctx as any).abort = controller.signal;

    const promise = tool.execute({ command: "sleep 100" }, ctx);
    // 模拟用户取消
    setTimeout(() => controller.abort(), 50);

    const result = await promise;
    expect(result.output).toContain("Command cancelled");
  });

  it("ABT-003: 正常完成不受影响", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "done", stderr: "", exitCode: 0 });
    const registry = createDefaultToolRegistry();
    const tool = registry.get("bash")!;
    const result = await tool.execute({ command: "echo hi" }, makeCtx(false));
    expect(result.output).toContain("done");
    expect(mockExecuteCommand).toHaveBeenCalled();
  });
});
