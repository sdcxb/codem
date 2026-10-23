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
  executeCommand: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
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
  buildProjectOverview,
  bucketForThread,
  scanReports,
  verifyProjectGates,
  updateThreadStatus,
  removeThread,
  resolveThreadDecision,
  readDecisions,
  syncPullRequests,
  listReports,
  registerThread,
  projectStatePath,
  readProjectState,
  setCoordinatorSession,
  writeThreadReport,
} from "../core/project/coordinator";
import { ReportContractError, validateThreadReport } from "../core/project/coordinator/report-contract";
import type { ProjectThread, ThreadReport } from "../core/project/coordinator/types";

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


  it("RPT-5：pull_request 只接受合法状态/CI", () => {
    expect(() => validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "done", summary: "ok",
      evidence: [{ kind: "log", ref: "logs/x.log" }],
      pull_request: { state: "unknown" },
    })).toThrow(/pull_request.state/);
    expect(validateThreadReport({
      report_id: "r1", thread_id: "t1", status: "done", summary: "ok",
      evidence: [{ kind: "log", ref: "logs/x.log" }],
      pull_request: { number: 12, state: "open", checks: "passing" },
    }).pull_request?.checks).toBe("passing");
  });

describe("项目状态与协调者上下文", () => {
  it("PST-1：设置协调者后，上下文包含 brief 与协调规则", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    files.set(projectStatePath(PROJECT, "brief.md"), "# Brief\n\n目标：发布官网。\n");
    const context = await buildCoordinatorContext(PROJECT, "coord-1");
    expect(context).toContain("发布官网");
    expect(context).toContain("项目协调者上下文");
    expect(context).toContain("协调规则");
    expect(context).toContain("记忆索引");
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

describe("项目 Overview 四态", () => {
  const thread = (status: ProjectThread["status"]): ProjectThread => ({
    sessionId: "t1", title: "T1", status, createdAt: 1, updatedAt: 1,
  });
  const report = (status: ThreadReport["status"], gates?: ThreadReport["gates"]): ThreadReport => ({
    report_id: "r1", thread_id: "t1", status, summary: "s", gates,
  });

  it("OV-1：blocked→等你，done 无 gate→待评审，done 全过→完成，in_progress→运行中", () => {
    expect(bucketForThread(thread("blocked"))).toBe("waiting");
    expect(bucketForThread(thread("working"), report("done"))).toBe("review");
    const passedGate = report("done", [{ id: "g1", passed: true, verified_by: "command", evidence_ref: "log" }]);
    expect(bucketForThread(thread("working"), passedGate)).toBe("review");
    expect(bucketForThread(thread("working"), passedGate, {
      gateChecks: [{ reportId: "r1", gateId: "g1", ok: true, checkedAt: 1 }],
    })).toBe("done");
    expect(bucketForThread(thread("working"), report("in_progress"))).toBe("working");
    expect(bucketForThread(thread("working"), report("blocked"))).toBe("waiting");
  });

  it("OV-3：证据文件缺失会被 Overview 与协调者上下文标记", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await writeThreadReport(PROJECT, {
      report_id: "r-miss", thread_id: "t1", status: "done", summary: "声称完成",
      evidence: [{ kind: "log", ref: "logs/does-not-exist.log" }],
    }, { title: "T1" });
    const overview = await buildProjectOverview(PROJECT);
    expect(overview.missingEvidence).toBe(1);
    files.set(projectStatePath(PROJECT, "brief.md"), "# Brief");
    const context = await buildCoordinatorContext(PROJECT, "coord-1");
    expect(context).toContain("证据缺失");
  });

  it("OV-2：坏报告被计数，且不出现在 thread 结论里", async () => {
    files.set(projectStatePath(PROJECT, "reports/bad.json"), "{ not json");
    files.set(projectStatePath(PROJECT, "reports/r1.json"), JSON.stringify({
      report_id: "r1", thread_id: "t1", status: "done", summary: "ok",
      evidence: [{ kind: "log", ref: "logs/t1.log" }],
    }));
    // 让 t1 进入 registry
    await writeThreadReport(PROJECT, {
      report_id: "r2", thread_id: "t1", status: "done", summary: "ok2",
      evidence: [{ kind: "log", ref: "logs/t2.log" }],
    }, { title: "T1" });
    const scan = await scanReports(PROJECT);
    expect(scan.invalid.map((i) => i.file)).toContain("bad.json");
    const overview = await buildProjectOverview(PROJECT);
    expect(overview.invalidReports).toHaveLength(1);
    expect(overview.counts.review).toBe(1);
  });

  it("OV-4：T3 假绿回归——没有 command 的 gate 不能算 done", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await writeThreadReport(PROJECT, {
      report_id: "r-fake-green", thread_id: "t1", status: "done", summary: "五道门禁全绿",
      evidence: [{ kind: "log", ref: "logs/t3.log" }],
      gates: [{ id: "g1", passed: true, verified_by: "command", evidence_ref: "logs/t3.log" }],
    }, { title: "T3 测试验收" });
    files.set(projectStatePath(PROJECT, "logs/t3.log"), "claim only");
    const checks = await verifyProjectGates(PROJECT);
    expect(checks[0]).toMatchObject({ gateId: "g1", ok: false, reason: "no-command" });
    const overview = await buildProjectOverview(PROJECT);
    expect(overview.counts.done).toBe(0);
    expect(overview.counts.review).toBe(1);
    expect(overview.unverifiedGates).toBe(1);
  });

  it("OV-5：带 command 的 gate 重验通过后才算 done", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    files.set(PROJECT + "/logs/t5.log", "exit 0");
    await writeThreadReport(PROJECT, {
      report_id: "r-verified", thread_id: "t5", status: "done", summary: "真绿",
      evidence: [{ kind: "log", ref: "logs/t5.log" }],
      gates: [{ id: "g1", passed: true, verified_by: "command", evidence_ref: "logs/t5.log", command: "node site/check.mjs" }],
    }, { title: "T5 测试" });
    const checks = await verifyProjectGates(PROJECT);
    expect(checks[0]).toMatchObject({ gateId: "g1", ok: true });
    const overview = await buildProjectOverview(PROJECT);
    expect(overview.counts.done).toBe(1);
  });

describe("thread 生命周期", () => {
  it("TL-1：未写报告的 thread 也算运行中，blocked 进等你，删除后消失", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await registerThread(PROJECT, { sessionId: "t-idle", title: "T idle", status: "idle" });
    let overview = await buildProjectOverview(PROJECT);
    expect(overview.counts.working).toBe(1);
    expect(overview.threads[0].title).toBe("T idle");

    await updateThreadStatus(PROJECT, "t-idle", "blocked");
    overview = await buildProjectOverview(PROJECT);
    expect(overview.counts.waiting).toBe(1);

    await removeThread(PROJECT, "t-idle");
    overview = await buildProjectOverview(PROJECT);
    expect(overview.threads).toHaveLength(0);
  });

  it("TL-2：协调者自身不进 thread registry", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await registerThread(PROJECT, { sessionId: "coord-1", title: "协调者" });
    const overview = await buildProjectOverview(PROJECT);
    expect(overview.threads.some((t) => t.sessionId === "coord-1")).toBe(false);
  });
});

describe("审批动作", () => {
  it("D-1：blocked 选项拍板后写入 decisions，thread 从等你转运行中", async () => {
    await setCoordinatorSession(PROJECT, "coord-1");
    await writeThreadReport(PROJECT, {
      report_id: "r-blocked", thread_id: "t-blocked", status: "blocked", summary: "需要选择",
      blocking: { question: "选 A 还是 B？", options: ["A", "B"], default: "A" },
    }, { title: "T blocked" });
    let overview = await buildProjectOverview(PROJECT);
    expect(overview.counts.waiting).toBe(1);

    await expect(resolveThreadDecision(PROJECT, "t-blocked", "C")).rejects.toThrow(/选项/);
    const d = await resolveThreadDecision(PROJECT, "t-blocked", "B");
    expect(d.choice).toBe("B");
    expect((await readDecisions(PROJECT))[0].choice).toBe("B");

    overview = await buildProjectOverview(PROJECT);
    expect(overview.counts.waiting).toBe(0);
    expect(overview.counts.working).toBe(1);
    const context = await buildCoordinatorContext(PROJECT, "coord-1");
    expect(context).toContain("选 A 还是 B？ → B");
  });
});

describe("PR/CI 同步", () => {
  it("PR-1：gh 返回成功/挂起/失败时映射成 passing/pending/failing", async () => {
    const fileApi = await import("../core/file-api");
    await setCoordinatorSession(PROJECT, "coord-1");
    await writeThreadReport(PROJECT, {
      report_id: "r-pr", thread_id: "t-pr", status: "done", summary: "PR 已开",
      evidence: [{ kind: "log", ref: "logs/pr.log" }],
      pull_request: { number: 12, state: "open", checks: "pending" },
    }, { title: "T PR" });
    files.set(PROJECT + "/logs/pr.log", "ok");

    vi.mocked(fileApi.executeCommand).mockResolvedValueOnce({
      stdout: JSON.stringify({ state: "OPEN", url: "https://github.com/x/y/pull/12", statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }] }),
      stderr: "", exitCode: 0,
    });
    let snaps = await syncPullRequests(PROJECT);
    expect(snaps[0]).toMatchObject({ state: "open", checks: "passing" });

    vi.mocked(fileApi.executeCommand).mockResolvedValueOnce({
      stdout: JSON.stringify({ state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS" }] }),
      stderr: "", exitCode: 0,
    });
    snaps = await syncPullRequests(PROJECT);
    expect(snaps[0].checks).toBe("pending");

    vi.mocked(fileApi.executeCommand).mockResolvedValueOnce({ stdout: "", stderr: "gh: not found", exitCode: 1 });
    snaps = await syncPullRequests(PROJECT);
    expect(snaps[0].error).toContain("gh: not found");
  });
});
})
