import { describe, expect, it } from "vitest";
import { SubagentAdmission } from "../core/subagent/admission";

describe("SUBAGENT-ADMISSION：启动侧长尾闸门", () => {
  it("窗口内第 9 次启动被拒绝，并给出可行动原因", () => {
    const admission = new SubagentAdmission({ maxStartsPerWindow: 8, windowMs: 60_000, duplicateWindowMs: 60_000 });
    for (let i = 0; i < 8; i++) {
      expect(admission.check("s", `task-${i}`, 1_000 + i).ok).toBe(true);
      admission.record("s", `task-${i}`, 1_000 + i);
    }
    const denied = admission.check("s", "task-9", 1_010);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("上限 8");
    expect(denied.reason).toContain("复用");
  });

  it("完全相同的 prompt 在窗口内不重复派生", () => {
    const admission = new SubagentAdmission({ maxStartsPerWindow: 8, windowMs: 60_000, duplicateWindowMs: 60_000 });
    expect(admission.check("s", "same task", 1_000).ok).toBe(true);
    admission.record("s", "same task", 1_000);
    const duplicate = admission.check("s", "same   task", 2_000);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.duplicateAt).toBe(1_000);
    expect(duplicate.reason).toContain("send_message");
  });

  it("窗口过期后释放预算；不同父会话互不影响", () => {
    const admission = new SubagentAdmission({ maxStartsPerWindow: 1, windowMs: 1_000, duplicateWindowMs: 1_000 });
    admission.record("a", "x", 1_000);
    expect(admission.check("a", "y", 1_500).ok).toBe(false);
    expect(admission.check("a", "y", 2_001).ok).toBe(true);
    expect(admission.check("b", "y", 1_500).ok).toBe(true);
  });

  it("reset 清空所有会话（引擎切换/测试隔离）", () => {
    const admission = new SubagentAdmission({ maxStartsPerWindow: 1, windowMs: 60_000, duplicateWindowMs: 60_000 });
    admission.record("a", "x", 1_000);
    admission.reset();
    expect(admission.recentStarts("a", 1_000)).toBe(0);
    expect(admission.check("a", "x", 1_000).ok).toBe(true);
  });
});
