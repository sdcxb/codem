import type { ThreadReport } from "./types";

/**
 * 报告契约 v3.1（与 `.preview-shot/coordinator-lab/validate-report.mjs` 对齐）。
 *
 * 为什么是**白名单**：报告是协调者判断"做完了"的唯一输入；多一个未识别字段，
 * 协调者就可能把 `status: "done"` 读成别的意思。未知字段一律拒绝，逼着契约先升级。
 */

const TOP_LEVEL = new Set([
  "report_id",
  "thread_id",
  "status",
  "summary",
  "changes",
  "evidence",
  "gates",
  "blocking",
  "supersedes",
  "timestamp",
  "conflict",
  "resolution",
  "retroactive",
  "pull_request",
]);

const STATUS = new Set(["in_progress", "done", "blocked", "failed"]);
const EVIDENCE_KIND = new Set(["log", "command", "file"]);
const VERIFIER = new Set(["command", "manual", "none"]);

export class ReportContractError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`报告不符合 v3.1 契约：${issues.join("；")}`);
    this.name = "ReportContractError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 校验一份未知 JSON；通过时返回**窄化后的报告**，失败抛 `ReportContractError`。
 * 这个函数是纯的（不碰磁盘），因此可以在写入前、读回后各跑一次。
 */
export function validateThreadReport(input: unknown): ThreadReport {
  const issues: string[] = [];
  if (!isRecord(input)) throw new ReportContractError(["顶层必须是对象"]);

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL.has(key)) issues.push(`未知字段 ${key}`);
  }

  const reportId = input.report_id;
  const threadId = input.thread_id;
  const status = input.status;
  const summary = input.summary;

  if (typeof reportId !== "string" || !reportId.trim()) issues.push("report_id 必须是非空字符串");
  if (typeof threadId !== "string" || !threadId.trim()) issues.push("thread_id 必须是非空字符串");
  if (typeof status !== "string" || !STATUS.has(status)) issues.push("status 必须是 in_progress/done/blocked/failed");
  if (typeof summary !== "string" || !summary.trim()) issues.push("summary 必须是非空字符串");
  else if (summary.length > 300) issues.push(`summary 超过 300 字符（当前 ${summary.length}）`);

  const evidence = input.evidence;
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) issues.push("evidence 必须是数组");
    else {
      for (const [i, ev] of evidence.entries()) {
        if (!isRecord(ev)) { issues.push(`evidence[${i}] 必须是对象`); continue; }
        if (typeof ev.kind !== "string" || !EVIDENCE_KIND.has(ev.kind)) issues.push(`evidence[${i}].kind 非法`);
        if (typeof ev.ref !== "string" || !ev.ref.trim()) issues.push(`evidence[${i}].ref 必须是非空字符串`);
      }
    }
  }

  const gates = input.gates;
  if (gates !== undefined) {
    if (!Array.isArray(gates)) issues.push("gates 必须是数组");
    else {
      for (const [i, gate] of gates.entries()) {
        if (!isRecord(gate)) { issues.push(`gates[${i}] 必须是对象`); continue; }
        if (typeof gate.id !== "string" || !gate.id.trim()) issues.push(`gates[${i}].id 必须是非空字符串`);
        if (typeof gate.passed !== "boolean") issues.push(`gates[${i}].passed 必须是布尔值`);
        if (typeof gate.verified_by !== "string" || !VERIFIER.has(gate.verified_by)) {
          issues.push(`gates[${i}].verified_by 非法`);
        }
        if (gate.command !== undefined && (typeof gate.command !== "string" || !gate.command.trim())) {
          issues.push(`gates[${i}].command 必须是非空字符串`);
        }
        if (gate.passed === true) {
          if (gate.verified_by !== "command") issues.push(`gates[${i}] passed=true 必须 verified_by=command`);
          if (typeof gate.evidence_ref !== "string" || !gate.evidence_ref.trim()) {
            issues.push(`gates[${i}] passed=true 必须带 evidence_ref`);
          }
        }
      }
    }
  }

  const blocking = input.blocking;
  if (blocking !== undefined) {
    if (!isRecord(blocking)) issues.push("blocking 必须是对象");
    else {
      if (typeof blocking.question !== "string" || !blocking.question.trim()) issues.push("blocking.question 必须是非空字符串");
      if (!Array.isArray(blocking.options) || blocking.options.length < 2) issues.push("blocking.options 至少 2 个");
      else {
        for (const [i, option] of blocking.options.entries()) {
          if (typeof option !== "string" || !option.trim()) issues.push(`blocking.options[${i}] 必须是非空字符串`);
        }
        if (typeof blocking.default !== "string" || !blocking.options.includes(blocking.default)) {
          issues.push("blocking.default 必须是 options 之一");
        }
      }
    }
  }

  if (status === "done") {
    const hasLog = Array.isArray(evidence) && evidence.some(
      (ev) => isRecord(ev) && ev.kind === "log" && typeof ev.ref === "string" && !!ev.ref.trim()
    );
    if (!hasLog) issues.push("status=done 必须带 evidence（kind=log，ref=证据路径）");
  }

  if (status === "blocked") {
    if (!isRecord(blocking)) issues.push("status=blocked 必须带 blocking（question/options/default）");
  }

  if (Array.isArray(input.changes)) {
    for (const [i, change] of input.changes.entries()) {
      if (!isRecord(change)) issues.push(`changes[${i}] 必须是对象`);
      else if (typeof change.path !== "string" || !change.path.trim()) issues.push(`changes[${i}].path 必须是非空字符串`);
    }
  } else if (input.changes !== undefined) {
    issues.push("changes 必须是数组");
  }

  if (input.supersedes !== undefined && typeof input.supersedes !== "string") issues.push("supersedes 必须是字符串");
  if (input.timestamp !== undefined && !Number.isFinite(input.timestamp)) issues.push("timestamp 必须是数字");
  if (input.conflict !== undefined && typeof input.conflict !== "string") issues.push("conflict 必须是字符串");
  if (input.resolution !== undefined && typeof input.resolution !== "string") issues.push("resolution 必须是字符串");
  if (input.retroactive !== undefined && typeof input.retroactive !== "boolean") issues.push("retroactive 必须是布尔值");

  const pr = input.pull_request;
  if (pr !== undefined) {
    if (!isRecord(pr)) issues.push("pull_request 必须是对象");
    else {
      if (typeof pr.state !== "string" || !["draft", "open", "merged", "closed"].includes(pr.state)) issues.push("pull_request.state 非法");
      if (pr.checks !== undefined && (typeof pr.checks !== "string" || !["pending", "passing", "failing", "none"].includes(pr.checks))) issues.push("pull_request.checks 非法");
      if (pr.url !== undefined && typeof pr.url !== "string") issues.push("pull_request.url 必须是字符串");
      if (pr.number !== undefined && !Number.isFinite(pr.number)) issues.push("pull_request.number 必须是数字");
      if (pr.title !== undefined && typeof pr.title !== "string") issues.push("pull_request.title 必须是字符串");
    }
  }

  if (issues.length > 0) throw new ReportContractError(issues);
  return input as unknown as ThreadReport;
}
