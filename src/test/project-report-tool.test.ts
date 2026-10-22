import { describe, it, expect, vi, beforeEach } from "vitest";

const writeThreadReport = vi.fn();

vi.mock("../core/project/coordinator/storage", () => ({
  writeThreadReport: (...args: unknown[]) => writeThreadReport(...args),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "C:/proj/.git", stderr: "", exitCode: 0 })),
  exists: vi.fn(async () => false),
  readFile: vi.fn(async () => "LOG"),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("../core/storage/session", () => ({
  getSession: vi.fn(() => ({ title: "T1 需求审计" })),
}));

import { createProjectReportTool } from "../core/llm/tools/project-report";

const tool = createProjectReportTool();
const ctx = {
  sessionId: "thread-1",
  messageId: "m1",
  cwd: "C:/proj",
  workspace: "C:/proj",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => undefined,
} as never;

beforeEach(() => {
  writeThreadReport.mockReset();
});

describe("project_report 工具", () => {
  it("PRT-1：把 thread_id 固定为当前会话，并透传 status/summary", async () => {
    writeThreadReport.mockResolvedValue({ report_id: "r1", status: "done", summary: "完成了" });
    const res = await tool.execute({ status: "done", summary: "完成了", evidence: [{ kind: "log", ref: "logs/a.log" }] }, ctx);
    expect(res.isError, res.output).toBe(false);
    expect(writeThreadReport).toHaveBeenCalledWith("C:/proj", expect.objectContaining({
      thread_id: "thread-1",
      status: "done",
      summary: "完成了",
    }), { title: "T1 需求审计" });
    expect(res.output).toContain(".codem/project/reports/r1.json");
  });

  it("PRT-2：报告被契约拒绝时返回 isError，不假装成功", async () => {
    writeThreadReport.mockRejectedValue(new Error("summary 超过 300 字符"));
    const res = await tool.execute({ status: "done", summary: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("summary 超过 300 字符");
  });

  it("PRT-3：没有工作区时直接拒绝", async () => {
    const res = await tool.execute({ status: "in_progress", summary: "x" }, { ...ctx, cwd: "", workspace: "" } as never);
    expect(res.isError).toBe(true);
    expect(writeThreadReport).not.toHaveBeenCalled();
  });
});

  it("PRT-4：worktree 里的日志证据复制到主工作区并改写 ref", async () => {
    const fileApi = await import("../core/file-api");
    vi.mocked(fileApi.exists).mockImplementation(async (p: string) => p === "C:/proj/.worktrees/t1/logs/a.log");
    writeThreadReport.mockResolvedValue({ report_id: "r2", status: "done", summary: "ok" });
    const wtCtx = { ...ctx, cwd: "C:/proj/.worktrees/t1", workspace: "C:/proj/.worktrees/t1" } as never;
    const res = await tool.execute({ status: "done", summary: "ok", evidence: [{ kind: "log", ref: "logs/a.log" }] }, wtCtx);
    expect(res.isError, res.output).toBe(false);
    expect(fileApi.writeFile).toHaveBeenCalledWith(
      "C:/proj/.codem/evidence/thread-1/a.log",
      "LOG",
      expect.objectContaining({ workspace: "C:/proj" })
    );
    expect(writeThreadReport).toHaveBeenCalledWith("C:/proj", expect.objectContaining({
      evidence: [expect.objectContaining({ ref: ".codem/evidence/thread-1/a.log" })],
    }), { title: "T1 需求审计" });
  });
