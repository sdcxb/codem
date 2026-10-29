/**
 * 前台子智能体（无 Activation）也必须受“缺报告即失败”门控。
 */
import { describe, it, expect } from "vitest";
import { SubagentRuntime } from "../core/subagent/runtime";

describe("前台子智能体报告门控", () => {
  it("GATE-1: 要求 report 但缺失 → stopReason=refusal，summary 写明未提交", async () => {
    const runtime = new SubagentRuntime({} as any);
    let resolveResult!: (value: any) => void;
    const pending = new Promise((r) => { resolveResult = r; });
    runtime.registerProvider({
      name: "fake",
      capabilities: {} as any,
      start: async () => ({
        id: "fg-1",
        result: pending as any,
        dispose: async () => {},
      }),
    } as any);

    const run = await runtime.start("fake", {
      prompt: "do it",
      parentSessionId: "parent",
      cwd: "C:\\tmp",
    } as any);
    runtime.setReportRequired(run.id, true);
    resolveResult({ output: "散文说完成了", stopReason: "completed", filesTouched: [], summary: "done" });

    const result = await run.result;
    expect(result.stopReason).toBe("refusal");
    expect(result.summary).toContain("未提交结构化报告");
  });
});
