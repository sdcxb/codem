/**
 * 子智能体结构化报告契约。
 *
 * 为什么需要它：`report` 工具原来只收一个字符串，父 agent 只能读自然语言；
 * `parseTaskResult` 又只认 `**状态**:`，导致子 agent 写了失败也可能按 success 结算。
 * 这里把「报告形状 + 校验」收成一份，工具、runtime、parser 共用。
 */

type SubagentReportStatus = "success" | "partial" | "failed" | "blocked" | "unknown";

interface SubagentVerifiedItem {
  /** 实际执行的命令（或调用方提供的核对命令） */
  command: string;
  /** 命令是否成功 */
  ok: boolean;
  /** agent = 本子智能体执行过；caller = 调用方提供的结果，不能算 agent 验证 */
  source: "agent" | "caller";
  /** 可选证据位置/输出摘要 */
  evidence?: string;
}

export interface SubagentReport {
  status: SubagentReportStatus;
  summary: string;
  changed: string[];
  verified: SubagentVerifiedItem[];
  unverified: string[];
  open: string[];
  /** 原始自由文本，可选；用于保留细节 */
  output?: string;
}

interface SubagentReportParseResult {
  ok: boolean;
  report?: SubagentReport;
  error?: string;
}

const STATUSES: readonly SubagentReportStatus[] = ["success", "partial", "failed", "blocked", "unknown"];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter(Boolean);
}

/**
 * 校验并归一化。严格拒绝坏报告，避免父 agent 收到“看起来完成”的半成品。
 */
export function parseSubagentReport(value: unknown): SubagentReportParseResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "报告必须是对象" };
  }
  const raw = value as Record<string, unknown>;
  const status = str(raw.status) as SubagentReportStatus;
  if (!STATUSES.includes(status)) {
    return { ok: false, error: `status 必须是 ${STATUSES.join(" / ")}` };
  }
  const summary = str(raw.summary);
  if (!summary) {
    return { ok: false, error: "summary 不能为空" };
  }
  if (summary.length > 300) {
    return { ok: false, error: "summary 不能超过 300 字" };
  }

  const verified: SubagentVerifiedItem[] = [];
  if (raw.verified !== undefined) {
    if (!Array.isArray(raw.verified)) return { ok: false, error: "verified 必须是数组" };
    for (const item of raw.verified) {
      if (!item || typeof item !== "object") return { ok: false, error: "verified 项必须是对象" };
      const v = item as Record<string, unknown>;
      const command = str(v.command);
      if (!command) return { ok: false, error: "verified[].command 不能为空" };
      if (typeof v.ok !== "boolean") return { ok: false, error: "verified[].ok 必须是布尔值" };
      const source = str(v.source) || "agent";
      if (source !== "agent" && source !== "caller") {
        return { ok: false, error: "verified[].source 必须是 agent / caller" };
      }
      verified.push({
        command,
        ok: v.ok,
        source,
        ...(str(v.evidence) ? { evidence: str(v.evidence) } : {}),
      });
    }
  }

  return {
    ok: true,
    report: {
      status,
      summary,
      changed: strList(raw.changed),
      verified,
      unverified: strList(raw.unverified),
      open: strList(raw.open),
      ...(str(raw.output) ? { output: str(raw.output) } : {}),
    },
  };
}

/** 供 report 工具投递、父 agent 阅读、parseTaskResult 再解析的稳定信封。 */
export function formatSubagentReport(report: SubagentReport): string {
  const lines = [
    "<subagent_report>",
    JSON.stringify(report, null, 2),
    "</subagent_report>",
    "",
    `status: ${report.status}`,
    `summary: ${report.summary}`,
  ];
  if (report.changed.length) lines.push(`changed: ${report.changed.join(", ")}`);
  if (report.verified.length) {
    lines.push("verified:");
    for (const v of report.verified) {
      lines.push(`- [${v.source}] ${v.command} -> ${v.ok ? "ok" : "failed"}${v.evidence ? ` (${v.evidence})` : ""}`);
    }
  }
  if (report.unverified.length) lines.push(`unverified: ${report.unverified.join("; ")}`);
  if (report.open.length) lines.push(`open: ${report.open.join("; ")}`);
  if (report.output) lines.push("", report.output);
  return lines.join("\n");
}

/** 从任意文本中提取结构化报告信封。 */
export function extractSubagentReport(text: string): SubagentReport | null {
  const match = /<subagent_report>\s*([\s\S]*?)\s*<\/subagent_report>/i.exec(text);
  if (!match) return null;
  try {
    const parsed = parseSubagentReport(JSON.parse(match[1]));
    return parsed.ok ? parsed.report! : null;
  } catch {
    return null;
  }
}

export interface ReportSettlement {
  status: SubagentReportStatus;
  summary: string;
  missing: boolean;
}

/**
 * 结算规则（纯函数，便于单测）：
 * - 有结构化 report：以 report 为准；
 * - 要求 report 但缺失：failed + “未提交结构化报告”，绝不按散文 success；
 * - 未要求 report：沿用旧解析结果（可能是 unknown）。
 */
export function settleSubagentReport(input: {
  reportRequired: boolean;
  report?: SubagentReport;
  parsedStatus: SubagentReportStatus;
  parsedSummary: string;
}): ReportSettlement {
  if (input.report) {
    return { status: input.report.status, summary: input.report.summary, missing: false };
  }
  if (input.reportRequired) {
    return {
      status: "failed",
      summary: "未提交结构化报告；父 agent 不应把这段文本当作完成结论",
      missing: true,
    };
  }
  return { status: input.parsedStatus, summary: input.parsedSummary, missing: false };
}
