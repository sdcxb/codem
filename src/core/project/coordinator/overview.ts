import { readProjectState, scanReports } from "./storage";
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
}

export interface ProjectOverview {
  threads: OverviewThread[];
  counts: Record<OverviewBucket, number>;
  invalidReports: Array<{ file: string; error: string }>;
  updatedAt: number;
}

export function bucketForThread(thread: ProjectThread, report?: ThreadReport): OverviewBucket {
  if (report) {
    if (report.status === "blocked" || report.status === "failed") return "waiting";
    if (report.status === "done") {
      const gates = report.gates ?? [];
      if (gates.length > 0 && gates.every((g) => g.passed)) return "done";
      return "review";
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
  const threads: OverviewThread[] = state.threads.map((thread) => {
    const latestReport = thread.lastReportId ? byId.get(thread.lastReportId) : undefined;
    return { ...thread, latestReport, bucket: bucketForThread(thread, latestReport) };
  });
  const counts: Record<OverviewBucket, number> = { waiting: 0, working: 0, review: 0, done: 0 };
  for (const thread of threads) counts[thread.bucket]++;
  return { threads, counts, invalidReports: scan.invalid, updatedAt: state.updatedAt };
}
