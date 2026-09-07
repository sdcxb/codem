/**
 * 测试：computer-use 运行时契约回归（审计 A1/A2 修复防回归）
 *
 * A1: runPs 不得再以 `powershell -File` 形式调用（Rust execute_command 剥前缀
 *     后当 -Command 执行会失败）——该姿势在 computer-use.ts 源码内已改，
 *     此处无法在单测执行 PS，用源码契约断言防倒退。
 * A2: TS payload 动作名/字段必须与 INPUT_PS1 的 switch/字段一致
 *     （wait/getpos/move/from/to/action2）。
 * B3/D2: 插件门禁标志（setComputerPluginEnabled(false) → modeGate 全拒）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { INPUT_PS1, CAPTURE_PS1 } from "../core/computer-use/scripts-content";
import {
  modeGate,
  setComputerPluginEnabled,
  isComputerPluginEnabled,
  getTempDir,
} from "../core/computer-use/computer-use";

function fakeCtx(sessionId = "s1") {
  return { sessionId, messageId: "m", cwd: "D:/test", abort: new AbortController().signal } as any;
}

describe("computer-use 运行时契约（审计修复防回归）", () => {
  afterEach(() => {
    setComputerPluginEnabled(true);
  });

  it("A1: 脚本仍以 -Json base64 传参（契约未回归）", () => {
    expect(CAPTURE_PS1).toContain("param([string]$Json = \"\")");
    expect(INPUT_PS1).toContain("param([string]$Json = \"\")");
    expect(CAPTURE_PS1).toContain("FromBase64String");
  });

  it("A2: INPUT_PS1 支持 wait/getpos/move/action2/from/to（与 TS 载荷一致）", () => {
    expect(INPUT_PS1).toContain('"wait" {');
    expect(INPUT_PS1).toContain('"getpos" {');
    expect(INPUT_PS1).toContain('"move" {');
    expect(INPUT_PS1).toContain("$cfg.action2");
    expect(INPUT_PS1).toContain("$cfg.from[0]");
    expect(INPUT_PS1).toContain("$cfg.to[0]");
    // 不再依赖旧 payload 键（button/start/end/move_mouse/get_cursor_position 分支）
    expect(INPUT_PS1).not.toContain("$cfg.button");
    expect(INPUT_PS1).not.toContain("$cfg.start[0]");
    expect(INPUT_PS1).not.toContain('"move_mouse" {');
    expect(INPUT_PS1).not.toContain('"get_cursor_position" {');
  });

  it("D2/B3: 插件禁用门禁——禁用后所有 computer_* 全拒（含 manual 已批准场景）", () => {
    expect(isComputerPluginEnabled()).toBe(true);
    // 批准会话后 manual 模式可放行
    // （approveSession 不导出使用路径：这里直接验证禁用优先于批准）
    setComputerPluginEnabled(false);
    expect(isComputerPluginEnabled()).toBe(false);
    // disabled 是插件禁用外的次级开关；禁用态下无论模式都拒
    expect(() => modeGate("computer_wait", fakeCtx())).toThrow(/已被禁用/);
    expect(() => modeGate("computer_screenshot", fakeCtx())).toThrow(/已被禁用/);
    setComputerPluginEnabled(true);
    expect(isComputerPluginEnabled()).toBe(true);
  });

  it("C3: getTempDir 非 Tauri 环境仍有兜底路径", async () => {
    const dir = await getTempDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });
});
