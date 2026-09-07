/**
 * 测试：@codem/computer-use 核心（对标 EAC computer-user）
 *
 * 覆盖 CU-001 ~ CU-007（纯逻辑，不执行 PowerShell）：
 *   - CU-001: 默认模式 = manual（用户决策：插件开 + 工具默认手动批准）
 *   - CU-002: disabled 模式全拒
 *   - CU-003: readonly 模式仅放行只读工具（screenshot/读光标/wait）
 *   - CU-004: manual 模式未批准时副作用工具拒绝（awaitingApproval）
 *   - CU-005: /computer 批准切换（toggle on/off）
 *   - CU-006: 批准后 manual 放行副作用工具
 *   - CU-007: setComputerMode 持久化
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getComputerSettings, setComputerMode, approveSession, isSessionApproved, modeGate,
} from "../core/computer-use/computer-use";

function fakeCtx(sessionId: string) {
  return { sessionId, messageId: "m", cwd: "D:/test", abort: new AbortController().signal } as any;
}

describe("computer-use 核心 — 安全门禁", () => {
  beforeEach(() => {
    localStorage.clear();
    // 重置批准集（模块级内存 Set —— 通过 toggle 成对清理）
  });

  it("CU-001: 默认模式 manual（工具默认手动批准）", () => {
    expect(getComputerSettings().mode).toBe("manual");
  });

  it("CU-002: disabled 全拒（含只读）", () => {
    setComputerMode("disabled");
    expect(() => modeGate("computer_screenshot", fakeCtx("s1"))).toThrow(/禁用/);
    expect(() => modeGate("computer_wait", fakeCtx("s1"))).toThrow(/禁用/);
  });

  it("CU-003: readonly 仅放行只读工具", () => {
    setComputerMode("readonly");
    expect(() => modeGate("computer_screenshot", fakeCtx("s1"))).not.toThrow();
    expect(() => modeGate("computer_get_cursor_position", fakeCtx("s1"))).not.toThrow();
    expect(() => modeGate("computer_wait", fakeCtx("s1"))).not.toThrow();
    expect(() => modeGate("computer_click", fakeCtx("s1"))).toThrow(/只读/);
    expect(() => modeGate("computer_type", fakeCtx("s1"))).toThrow(/只读/);
  });

  it("CU-004: manual 未批准 → 副作用工具拒绝并带 awaitingApproval", () => {
    setComputerMode("manual");
    let err: any = null;
    try { modeGate("computer_click", fakeCtx("s1")); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.awaitingApproval).toBe(true);
    expect(err.message).toContain("批准");
  });

  it("CU-005: /computer 批准 toggle on/off", () => {
    expect(isSessionApproved("s1")).toBe(false);
    expect(approveSession("s1")).toBe(true);   // on
    expect(isSessionApproved("s1")).toBe(true);
    expect(approveSession("s1")).toBe(false);  // off
    expect(isSessionApproved("s1")).toBe(false);
  });

  it("CU-006: 批准后 manual 放行副作用工具", () => {
    setComputerMode("manual");
    approveSession("s1");
    expect(() => modeGate("computer_click", fakeCtx("s1"))).not.toThrow();
    // 其它会话不受影响
    expect(() => modeGate("computer_click", fakeCtx("s2"))).toThrow(/批准/);
  });

  it("CU-007: setComputerMode 持久化", () => {
    setComputerMode("auto");
    expect(getComputerSettings().mode).toBe("auto");
    // 再次读取（模拟跨调用恢复）仍为 auto —— 经 settings 存储层持久
    expect(getComputerSettings().mode).toBe("auto");
    setComputerMode("manual");
    expect(getComputerSettings().mode).toBe("manual");
  });
});
