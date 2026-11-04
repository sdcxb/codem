import { beforeEach, describe, expect, it } from "vitest";
import { createSubagentTool, setSubagentRuntime } from "../core/llm/tools/subagent-tools";

function fakeRuntime(): any {
  return {
    listChildren: () => [],
    async start() {
      return {
        id: "run-1",
        result: Promise.resolve({ output: "ok", stopReason: "completed", summary: "", filesTouched: [] }),
        dispose: async () => {},
      };
    },
    async startContinuable() {
      return { childId: "child-1" };
    },
  };
}

function ctx(): any {
  return { sessionId: "sub-budget-session", messageId: "m", cwd: "C:/w", abort: new AbortController().signal };
}

describe("SUBAGENT-TOOL-BUDGET：工具层真的会拦住第 9 次", () => {
  beforeEach(() => {
    setSubagentRuntime(fakeRuntime());
  });

  it("窗口内第 9 次返回可行动错误，前 8 次正常", async () => {
    const tool = createSubagentTool();
    for (let i = 0; i < 8; i++) {
      const result = await tool.execute({ description: `d${i}`, prompt: `task-${i}`, run_in_background: false }, ctx());
      expect(result.isError, `第 ${i + 1} 次不应被拦`).not.toBe(true);
    }
    const denied = await tool.execute({ description: "d9", prompt: "task-9", run_in_background: false }, ctx());
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("上限 8");
    expect(denied.output).toContain("复用");
  });
});
