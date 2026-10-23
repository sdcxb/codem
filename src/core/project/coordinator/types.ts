/**
 * 项目协调者（P0）的公开类型。
 *
 * 设计约束（来自 2026-10-22 的协调者实验）：
 * 1. 协调者的上下文**不读聊天记录**，只读 brief + 记忆索引 + thread 报告 + gate；
 * 2. thread 是普通会话，协调者只持有 id/标题/状态/分支；
 * 3. 报告是契约 JSON（v3.1），未知字段拒绝，`done` 必须有日志证据；
 * 4. 项目状态落在 `<project>/.codem/project/`，可人工检查、可重建。
 */

export type ProjectThreadStatus = "idle" | "working" | "blocked" | "done" | "failed";

export interface ProjectThread {
  sessionId: string;
  title: string;
  status: ProjectThreadStatus;
  worktreePath?: string;
  createdAt: number;
  updatedAt: number;
  lastReportId?: string;
}

export interface ProjectState {
  version: 1;
  coordinatorSessionId: string | null;
  threads: ProjectThread[];
  updatedAt: number;
}

export type ReportStatus = "in_progress" | "done" | "blocked" | "failed";
export type ReportEvidenceKind = "log" | "command" | "file";
export type GateVerifier = "command" | "manual" | "none";

export interface ReportEvidence {
  kind: ReportEvidenceKind;
  ref: string;
  note?: string;
}

export interface ReportGate {
  id: string;
  passed: boolean;
  verified_by: GateVerifier;
  evidence_ref?: string;
  /** v3.2：可独立重跑的命令；没有它则这条 gate 只能算“未重验” */
  command?: string;
}

export type PullRequestState = "draft" | "open" | "merged" | "closed";
export type CiStatus = "pending" | "passing" | "failing" | "none";

export interface PullRequestInfo {
  url?: string;
  number?: number;
  title?: string;
  state: PullRequestState;
  checks?: CiStatus;
}

export interface ReportBlocking {
  question: string;
  options: string[];
  default: string;
}

export interface ThreadReport {
  report_id: string;
  thread_id: string;
  status: ReportStatus;
  summary: string;
  changes?: Array<{ path: string; kind?: string }>;
  evidence?: ReportEvidence[];
  gates?: ReportGate[];
  blocking?: ReportBlocking;
  supersedes?: string;
  timestamp?: number;
  /** v3.1：冲突字段（与既有 JSON 契约兼容） */
  conflict?: string;
  resolution?: string;
  retroactive?: boolean;
  /** v3.3：PR/CI 收口信息（本地记录，不代替 GitHub 真实状态） */
  pull_request?: PullRequestInfo;
}

export interface ProjectEvent {
  at: number;
  type: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}
