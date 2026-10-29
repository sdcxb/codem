/**
 * 前台 subagent 工具：非 completed 的 stopReason 必须返回 isError，
 * 否则父 agent 会把 refusal 当成普通文本继续写“已完成”。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createSubagentTool, setSubagentRuntime } from "../core/llm/tools/subagent-tools";

describe("subagent 工具错误标记", () => {
  beforeEach(() => {
    setSubagentRuntime({
      start: async () => ({
        id: "fg-1",
        result: Promise.resolve({
          output: "2+2=4",
          stopReason: "refusal",
          filesTouched: [],
          summary: "未提交结构化报告",
        }),
        dispose: async () => {},
      }),
    } as any);
  });

  it("SUBAGENT-TOOL-1: refusal → isError=true", async () => {
    const tool = createSubagentTool();
    const res = await tool.execute(
      { description: "t", prompt: "p", run_in_background: false },
      { sessionId: "p", cwd: "C:\\tmp", abort: new AbortController().signal } as any,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("refusal");
    expect((res.metadata as any).stopReason).toBe("refusal");
  });
});
