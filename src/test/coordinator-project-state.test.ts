import { describe, it, expect, beforeEach, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("../core/file-api", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT " + p);
    return files.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  appendFile: vi.fn(async (p: string, c: string) => { files.set(p, (files.get(p) ?? "") + c); }),
  exists: vi.fn(async (p: string) => files.has(p)),
  listDirectory: vi.fn(async (dir: string) => {
    const names = new Set<string>();
    for (const p of files.keys()) {
      if (!p.startsWith(dir + "/")) continue;
      names.add(p.slice(dir.length + 1).split("/")[0]);
    }
    return [...names].map((name) => ({ name, path: dir + "/" + name, isDirectory: !name.includes(".") }));
  }),
}));

import {
  buildCoordinatorContext,
  listReports,
  registerThread,
  projectStatePath,
  readProjectState,
  setCoordinatorSession,
  writeThreadReport,
} from "../core/project/coordinator";
import { ReportContractError, validateThreadReport } from "../core/project/coordinator/report-contract";

const PROJECT = "C:/proj";

beforeEach(() => {
  files.clear();
});

describe("协调者报告契约 v3.1", () => {
  it("RPT-1：未知字段拒绝", () => {
    expect(() => validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "done", summary: "ok",
      evidence: [{ kind: "log", ref: "logs/x.log" }], extra: true,
    })).toThrow(ReportContractError);
  });

  it("RPT-2：done 必须带日志证据", () => {
    expect(() => validateThreadReport({ report_id: "r1", thread_id: "t1", status: "done", summary: "ok" }))
      .toThrow(/evidence/);
    expect(validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "done", summary: "ok",
      evidence: [{ kind: "log", ref: "logs/x.log" }],
    }).status).toBe("done");
  });

  it("RPT-3：passed gate 必须 command + evidence_ref", () => {
    expect(() => validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "in_progress", summary: "ok",
      gates: [{ id: "g1", passed: true, verified_by: "manual", evidence_ref: "x" }],
    })).toThrow(/verified_by/);
    expect(() => validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "in_progress", summary: "ok",
      gates: [{ id: "g1", passed: true, verified_by: "command" }],
    })).toThrow(/evidence_ref/);
  });

  it("RPT-4：blocked 必须给至少 2 个选项且默认项在选项里", () => {
    expect(() => validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "blocked", summary: "卡住",
      blocking: { question: "选哪个？", options: ["A"], default: "A" },
    })).toThrow(/至少 2 个/);
    expect(() => validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "blocked", summary: "卡住",
      blocking: { question: "选哪个？", options: ["A", "B"], default: "C" },
    })).toThrow(/default/);
  });
});

describe("项目状态与协调者上下文", () => {
  it("PST-1：设置协调者后，上下文包含 brief 与协调规则", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    files.set(projectStatePath(PROJECT, "brief.md"), "# Brief\n\n目标：发布官网。\n");
    const context = await buildCoordinatorContext(PROJECT, "coord-1");
    expect(context).toContain("发布官网");
    expect(context).toContain("项目协调者上下文");
    expect(context).toContain("协调规则");
  });

  it("PST-2：写报告会更新 thread registry，并在上下文里出现", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await writeThreadReport(PROJECT, {
      report_id: "r1", thread_id: "t1", status: "done", summary: "首页完成",
      evidence: [{ kind: "log", ref: "logs/t1.log" }],
      gates: [{ id: "g1", passed: true, verified_by: "command", evidence_ref: "logs/g1.log" }],
    }, { title: "首页 thread" });

    const state = await readProjectState(PROJECT);
    expect(state.threads[0].status).toBe("done");
    expect(state.threads[0].lastReportId).toBe("r1");
    const context = await buildCoordinatorContext(PROJECT, "coord-1");
    expect(context).toContain("首页 thread");
    expect(context).toContain("首页完成");
    expect(context).toContain("g1=pass");
  });

  it("PST-3：非协调者会话不注入上下文", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    expect(await buildCoordinatorContext(PROJECT, "other")).toBe("");
  });

  it("PST-4：报告校验失败时一个字都不写", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await expect(writeThreadReport(PROJECT, {
      report_id: "bad", thread_id: "t1", status: "done", summary: "没证据",
    })).rejects.toThrow(ReportContractError);
    expect(await listReports(PROJECT)).toHaveLength(0);
    expect((await readProjectState(PROJECT)).threads).toHaveLength(0);
  });

  it("PST-5：上下文有 9000 字符硬上限", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    for (let i = 0; i < 400; i++) {
      await registerThread(PROJECT, { sessionId: "t" + i, title: "thread-" + i });
    }
    const context = await buildCoordinatorContext(PROJECT, "coord-1");
    expect(context.length).toBeLessThanOrEqual(9000 + 40);
    expect(context).toContain("已截断");
  });
});
