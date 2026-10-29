/**
 * 子智能体结构化报告契约：形状、必填、信封往返。
 */
import { describe, it, expect } from "vitest";
import {
  parseSubagentReport,
  formatSubagentReport,
  extractSubagentReport,
  settleSubagentReport,
} from "../core/subagent/report-contract";

describe("子智能体报告契约", () => {
  it("REPORT-1: 合法报告归一化，caller 来源保留", () => {
    const parsed = parseSubagentReport({
      status: "partial",
      summary: "改了锁，iOS 未测",
      changed: ["src/auth/refresh.ts"],
      verified: [
        { command: "npm test auth", ok: true, source: "agent", evidence: "48 passed" },
        { command: "调用方给的 111", ok: true, source: "caller" },
      ],
      unverified: ["iOS 未测"],
      open: ["确认 iOS 路径"],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.report?.status).toBe("partial");
    expect(parsed.report?.verified[1].source).toBe("caller");
  });

  it("REPORT-2: 缺 status/summary、verified 缺 ok/source → 拒绝", () => {
    expect(parseSubagentReport({ summary: "x" }).ok).toBe(false);
    expect(parseSubagentReport({ status: "success" }).ok).toBe(false);
    expect(parseSubagentReport({ status: "success", summary: "x", verified: [{ command: "npm test" }] }).ok).toBe(false);
    expect(parseSubagentReport({ status: "bogus", summary: "x" }).ok).toBe(false);
  });

  it("REPORT-3: 要求报告但缺失 -> failed，不能按散文成功", () => {
    const missing = settleSubagentReport({
      reportRequired: true,
      parsedStatus: "unknown",
      parsedSummary: "散文",
    });
    expect(missing.status).toBe("failed");
    expect(missing.missing).toBe(true);

    const parsed = parseSubagentReport({ status: "success", summary: "完成" });
    expect(
      settleSubagentReport({
        reportRequired: true,
        report: parsed.report,
        parsedStatus: "unknown",
        parsedSummary: "x",
      }).status,
    ).toBe("success");
    expect(
      settleSubagentReport({ reportRequired: false, parsedStatus: "unknown", parsedSummary: "散文" }).status,
    ).toBe("unknown");
  });

  it("REPORT-4: 信封可往返，extract 能取回", () => {
    const parsed = parseSubagentReport({
      status: "success",
      summary: "完成",
      verified: [{ command: "npx tsc --noEmit", ok: true, source: "agent" }],
    });
    const text = formatSubagentReport(parsed.report!);
    expect(text).toContain("<subagent_report>");
    expect(extractSubagentReport(text)?.status).toBe("success");
    expect(extractSubagentReport("no report")).toBeNull();
  });
});
