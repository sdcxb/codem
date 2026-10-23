import { missingEvidenceRefs, readDecisions, readGateChecks, readProjectState, scanReports, type GateCheck, type ProjectDecision } from "./storage";
import type { ProjectThread, ThreadReport } from "./types";

/**
 * 项目 Overview 的四个桶（对齐 Claude Projects 的“是否等你”语义）：
 * - waiting：blocked / failed，需要用户拍板或重试；
 * - working：正在跑 / 还没有报告；
 * - review：报告说 done，但 gate 没全过（或没登记 gate），需要人评审；
 * - done：done 且所有 gate 都 passed。
 */
export type OverviewBucket = "waiting" | "working" | "review" | "done";

export interface OverviewThread extends ProjectThread {
  bucket: OverviewBucket;
  latestReport?: ThreadReport;
  missingEvidence: number;
  gateChecks: GateCheck[];
  decisions: ProjectDecision[];
}

export interface ProjectOverview {
  threads: OverviewThread[];
  counts: Record<OverviewBucket, number>;
  invalidReports: Array<{ file: string; error: string }>;
  missingEvidence: number;
  unverifiedGates: number;
  updatedAt: number;
}

export function bucketForThread(
  thread: ProjectThread,
  report?: ThreadReport,
  opts: { missingEvidence?: number; gateChecks?: GateCheck[]; hasDecision?: boolean } = {}
): OverviewBucket {
  if (report) {
    if (report.status === "blocked") return opts.hasDecision ? "working" : "waiting";
    if (report.status === "failed") return "waiting";
    if (report.status === "done") {
      const gates = report.gates ?? [];
      if (gates.length === 0 || !gates.every((g) => g.passed)) return "review";
      if ((opts.missingEvidence ?? 0) > 0) return "review";
      const checks = opts.gateChecks ?? [];
      const allVerified = gates.every((g) => checks.some((c) => c.gateId === g.id && c.reportId === report.report_id && c.ok));
      if (!allVerified) return "review";
      return "done";
    }
    return "working";
  }
  if (thread.status === "blocked" || thread.status === "failed") return "waiting";
  if (thread.status === "done") return "review";
  return "working";
}

export async function buildProjectOverview(projectPath: string): Promise<ProjectOverview> {
  const [state, scan] = await Promise.all([readProjectState(projectPath), scanReports(projectPath)]);
  const byId = new Map(scan.valid.map((r) => [r.report_id, r] as const));
  const [checks, decisions] = await Promise.all([readGateChecks(projectPath), readDecisions(projectPath)]);
  const threads: OverviewThread[] = [];
  let missingEvidence = 0;
  let unverifiedGates = 0;
  for (const thread of state.threads) {
    const latestReport = thread.lastReportId ? byId.get(thread.lastReportId) : undefined;
    const missing = latestReport ? await missingEvidenceRefs(projectPath, latestReport) : [];
    missingEvidence += missing.length;
    const reportChecks = latestReport ? checks.filter((c) => c.reportId === latestReport.report_id) : [];
    const threadDecisions = decisions.filter((d) => d.threadId === thread.sessionId);
    if (latestReport) {
      for (const gate of latestReport.gates ?? []) {
        if (gate.passed && !reportChecks.some((c) => c.gateId === gate.id && c.ok)) unverifiedGates++;
      }
    }
    threads.push({
      ...thread,
      latestReport,
      missingEvidence: missing.length,
      gateChecks: reportChecks,
      decisions: threadDecisions,
      bucket: bucketForThread(thread, latestReport, {
        missingEvidence: missing.length,
        gateChecks: reportChecks,
        hasDecision: latestReport ? threadDecisions.some((d) => d.reportId === latestReport.report_id) : false,
      }),
    });
  }
  const counts: Record<OverviewBucket, number> = { waiting: 0, working: 0, review: 0, done: 0 };
  for (const thread of threads) counts[thread.bucket]++;
  return { threads, counts, invalidReports: scan.invalid, missingEvidence, unverifiedGates, updatedAt: state.updatedAt };
}
