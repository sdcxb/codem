/**
 * 第 84 波审计修正：PreToolUse 钩子的**退出码 / 异常 / 无效返回值**必须被尊重。
 *
 * 修复前的行为（全部是"守卫被缺省分支绕过"）：
 *   · `exit 1` / `exit 7` 的守卫钩子 → 只看 stdout，空输出即 allow（安全阀完全失效）
 *   · 钩子超时                     → allow（"skip"）
 *   · 钩子抛错 / 函数钩子抛错       → allow
 *   · 输出 `MODIFY: <非法 JSON>`    → allow（原意是改参数，改不成当没这回事）
 *   · 函数钩子返回 `{action:"denied"}` 之类未识别 action → allow
 *   · 返回 `{action:"modify"}` 但没给 modifiedInput      → allow
 *
 * 修复后：以上全部默认 **fail-closed**（拦下并给出可读原因），只有显式
 * `allowOnError: true` 才放行。生命周期钩子（SessionStart/Stop）不阻塞流程，
 * 但非零退出码会写进日志，不再静默。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookDefinition, HookContext } from "../core/hooks/hook-types";

vi.mock("../core/storage/settings", () => ({
  // 每次返回**新的**空配置对象：mockReturnValue 会共享同一个 {hooks:[]}，
  // 导致 addHook 在用例之间累积，后面的用例先被前面的钩子拦下。
  getSettingJSON: vi.fn(() => ({ hooks: [] })),
  setSettingJSON: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
}));

const ctx: HookContext = {
  sessionId: "s1",
  toolName: "bash",
  input: { command: "rm -rf /" },
  cwd: "C:/proj",
};

function commandHook(extra: Partial<HookDefinition> = {}): HookDefinition {
  return {
    id: `h-${Math.random().toString(36).slice(2)}`,
    event: "PreToolUse",
    name: "guard",
    type: "command",
    command: "guard.exe",
    enabled: true,
    condition: { tool: "bash" },
    ...extra,
  };
}

async function runPreTool(hook: HookDefinition) {
  const { getHookManager, resetHookManager } = await import("../core/hooks/hook-manager");
  resetHookManager();
  const manager = getHookManager();
  manager.setEnabled(true);
  manager.setSubAgentMode(false);
  manager.addHook(hook);
  return manager.executePreToolHooks("bash", { command: "rm -rf /" }, {
    ...ctx,
    input: { command: "rm -rf /" },
  });
}

describe("Hook PreToolUse fail-closed 门禁", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockReset();
    vi.mocked(executeCommand).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);
    const { resetHookManager } = await import("../core/hooks/hook-manager");
    resetHookManager();
  });

  it("HK-1: 非零退出码且无 stdout → 拦下（原来放行）", async () => {
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 7 } as any);

    const result = await runPreTool(commandHook());
    expect(result.action).toBe("deny");
    expect(result.denyMessage).toContain("7");
    expect(result.denyMessage).toContain("boom");
  });

  it("HK-2: 退出码 2（标准 block 约定）→ 拦下", async () => {
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "protected path",
      exitCode: 2,
    } as any);

    const result = await runPreTool(commandHook());
    expect(result.action).toBe("deny");
    expect(result.denyMessage).toContain("protected path");
  });

  it("HK-3: allowOnError:true 时非零退出码才放行（并在日志说明）", async () => {
    const { executeCommand } = await import("../core/file-api");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(executeCommand).mockResolvedValue({ stdout: "", stderr: "meh", exitCode: 3 } as any);

    const result = await runPreTool(commandHook({ allowOnError: true }));
    expect(result.action).toBe("allow");
    expect(warn.mock.calls.flat().join(" ")).toContain("allowOnError");
    warn.mockRestore();
  });

  it("HK-4: 钩子超时 → 拦下（原来 skip 放行）", async () => {
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockRejectedValue(
      new Error("Command timed out after 10000ms. If this is a long-running command"),
    );

    const result = await runPreTool(commandHook({ timeoutMs: 50 }));
    expect(result.action).toBe("deny");
    expect(result.denyMessage).toContain("timed out");
  });

  it("HK-5: 钩子执行本身报错 → 拦下（原来 allow）", async () => {
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockRejectedValue(new Error("spawn failed"));

    const result = await runPreTool(commandHook());
    expect(result.action).toBe("deny");
    expect(result.denyMessage).toContain("spawn failed");
  });

  it("HK-6: 退出码 0 且无输出 → 放行（正常路径不受影响）", async () => {
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);

    const result = await runPreTool(commandHook());
    expect(result.action).toBe("allow");
  });

  it("HK-7: stdout=DENY → 拦下", async () => {
    const { executeCommand } = await import("../core/file-api");
    vi.mocked(executeCommand).mockResolvedValue({ stdout: "DENY\n", stderr: "", exitCode: 0 } as any);

    const result = await runPreTool(commandHook());
    expect(result.action).toBe("deny");
  });

  it("HK-8: MODIFY: 合法 JSON → modify；非法 JSON / 数组 → 拦下", async () => {
    const { executeCommand } = await import("../core/file-api");

    vi.mocked(executeCommand).mockResolvedValue({
      stdout: 'MODIFY: {"command":"echo safe"}',
      stderr: "",
      exitCode: 0,
    } as any);
    const ok = await runPreTool(commandHook());
    expect(ok.action).toBe("modify");
    expect(ok.modifiedInput).toEqual({ command: "echo safe" });

    vi.mocked(executeCommand).mockResolvedValue({
      stdout: 'MODIFY: {"command": ',
      stderr: "",
      exitCode: 0,
    } as any);
    const bad = await runPreTool(commandHook());
    expect(bad.action).toBe("deny");
    expect(bad.denyMessage).toContain("invalid JSON");

    vi.mocked(executeCommand).mockResolvedValue({
      stdout: 'MODIFY: ["echo","safe"]',
      stderr: "",
      exitCode: 0,
    } as any);
    const arr = await runPreTool(commandHook());
    expect(arr.action).toBe("deny");
    expect(arr.denyMessage).toContain("not a JSON object");
  });

  it("HK-9: 函数钩子抛错 → 拦下；allowOnError 才放行", async () => {
    const failing: HookDefinition = {
      ...commandHook(),
      type: "function",
      command: undefined,
      function: 'throw new Error("inner failure")',
    };
    const denied = await runPreTool(failing);
    expect(denied.action).toBe("deny");
    expect(denied.denyMessage).toContain("inner failure");

    const excused = await runPreTool({ ...failing, allowOnError: true });
    expect(excused.action).toBe("allow");
  });

  it("HK-10: 函数钩子返回未识别 action → 拦下（原来静默放行）", async () => {
    const weird: HookDefinition = {
      ...commandHook(),
      type: "function",
      command: undefined,
      function: 'return { action: "denied", denyMessage: "nope" }',
    };
    const result = await runPreTool(weird);
    expect(result.action).toBe("deny");
    expect(result.denyMessage).toContain("unrecognized action");
  });

  it("HK-11: 函数钩子 action=modify 但无 modifiedInput → 拦下", async () => {
    const half: HookDefinition = {
      ...commandHook(),
      type: "function",
      command: undefined,
      function: 'return { action: "modify" }',
    };
    const result = await runPreTool(half);
    expect(result.action).toBe("deny");
    expect(result.denyMessage).toContain("without modifiedInput");
  });

  it("HK-12: 生命周期钩子非零退出码不再静默（写日志、不阻塞）", async () => {
    const { executeCommand } = await import("../core/file-api");
    const { getHookManager, resetHookManager } = await import("../core/hooks/hook-manager");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(executeCommand).mockResolvedValue({ stdout: "", stderr: "no git", exitCode: 128 } as any);

    resetHookManager();
    const manager = getHookManager();
    manager.setEnabled(true);
    manager.addHook({
      id: "s-start",
      event: "SessionStart",
      name: "start-hook",
      type: "command",
      command: "check.exe",
      enabled: true,
    });

    await expect(manager.executeSessionStartHooks({ ...ctx })).resolves.toBeUndefined();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("128");
    expect(logged).toContain("no git");
    warn.mockRestore();
  });
});
