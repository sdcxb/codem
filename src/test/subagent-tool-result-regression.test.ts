/**
 * 前台 subagent 结果：非 completed 的 stopReason 必须 isError=true，
 * 否则父 agent 会把 refusal/aborted/error 当普通成功文本继续处理。
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
