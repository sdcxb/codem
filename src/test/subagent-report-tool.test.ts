/**
 * report 工具：结构化报告必须校验后才投递；坏报告不能被父 agent 收到。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReportTool, setSubagentRuntime } from "../core/llm/tools/subagent-tools";

const reportFrom = vi.fn(async () => "msg-1");

describe("report 工具契约", () => {
  beforeEach(() => {
    reportFrom.mockClear();
    setSubagentRuntime({ reportFrom } as any);
  });

  it("REPORT-TOOL-1: 合法结构化报告 → 投递并带 report", async () => {
    const tool = createReportTool();
    const res = await tool.execute(
      {
        status: "success",
        summary: "完成",
        verified: [{ command: "npx tsc --noEmit", ok: true, source: "agent" }],
      },
      { sessionId: "sub-1" } as any,
    );
    expect(res.isError).toBe(false);
    expect(reportFrom).toHaveBeenCalledTimes(1);
    const [, content, options] = reportFrom.mock.calls[0] as any[];
    expect(String(content)).toContain("<subagent_report>");
    expect(options.report.status).toBe("success");
  });

  it("REPORT-TOOL-2: 缺 summary/verified 缺 ok → 拒绝，不投递", async () => {
    const tool = createReportTool();
    const missingSummary = await tool.execute({ status: "success" }, { sessionId: "sub-1" } as any);
    expect(missingSummary.isError).toBe(true);
    const badVerified = await tool.execute(
      { status: "success", summary: "x", verified: [{ command: "npm test" }] },
      { sessionId: "sub-1" } as any,
    );
    expect(badVerified.isError).toBe(true);
    expect(reportFrom).not.toHaveBeenCalled();
  });

  it("REPORT-TOOL-3: 旧 output 仍可投递，但不伪造 report", async () => {
    const tool = createReportTool();
    const res = await tool.execute({ output: "旧格式结果" }, { sessionId: "sub-1" } as any);
    expect(res.isError).toBe(false);
    expect(reportFrom).toHaveBeenCalledTimes(1);
    expect((reportFrom.mock.calls[0] as any[])[2].report).toBeUndefined();
  });
});
