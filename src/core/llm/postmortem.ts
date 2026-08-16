/**
 * Postmortem Mechanism — 事后复盘机制
 *
 * 设计对标 DSH `docs/postmortem/` 机制。
 *
 * R3-4.2: 当会话出错或行为异常时，自动生成一份 postmortem 报告，
 * 记录：
 * - 会话 ID 和时间
 * - 错误描述
 * - 事件日志摘要（最后 N 个事件）
 * - 上下文压力状态
 * - 工具调用统计
 * - 可能的原因分析
 *
 * 报告存储在 `~/.codem/postmortem/` 目录下。
 */

import * as fs from "fs";
import * as path from "path";
import { getEventLog } from "../storage/event-log";

// ========== Types ==========

export interface PostmortemReport {
  /** 报告 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 生成时间 */
  timestamp: number;
  /** 错误描述 */
  error: string;
  /** 事件日志摘要 */
  eventSummary: {
    totalEvents: number;
    lastEvents: Array<{
      seq: number;
      type: string;
      timestamp: number;
      payloadPreview: string;
    }>;
  };
  /** 工具调用统计 */
  toolCallStats: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    toolBreakdown: Record<string, number>;
  };
  /** 可能的原因 */
  possibleCauses: string[];
}

// ========== Configuration ==========

/** postmortem 报告存储目录 */
function getPostmortemDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  const dir = path.join(home, ".codem", "postmortem");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 报告中包含的最后 N 个事件 */
const MAX_EVENTS_IN_REPORT = 20;

// ========== Report Generation ==========

/**
 * R3-4.2: 为会话生成一份 postmortem 报告。
 *
 * @param sessionId 出问题的会话
 * @param error 错误描述
 * @returns 生成的报告
 */
export function generatePostmortem(sessionId: string, error: string): PostmortemReport {
  const eventLog = getEventLog();
  const events = eventLog.readAll(sessionId);

  // 事件摘要
  const lastEvents = events
    .slice(-MAX_EVENTS_IN_REPORT)
    .map((evt) => ({
      seq: evt.seq,
      type: evt.type,
      timestamp: evt.timestamp,
      payloadPreview: JSON.stringify(evt.payload).slice(0, 200),
    }));

  // 工具调用统计
  const toolBreakdown: Record<string, number> = {};
  let successfulCalls = 0;
  let failedCalls = 0;

  for (const evt of events) {
    if (evt.type === "tool_call") {
      const toolName = (evt.payload as any)?.tool as string;
      if (toolName) {
        toolBreakdown[toolName] = (toolBreakdown[toolName] || 0) + 1;
      }
    }
    if (evt.type === "tool_result") {
      const status = (evt.payload as any)?.status as string;
      if (status === "completed") successfulCalls++;
      else if (status === "error") failedCalls++;
    }
  }

  // 可能的原因分析
  const possibleCauses: string[] = [];
  if (events.length === 0) {
    possibleCauses.push("No events in session log — session may not have started properly");
  }
  if (failedCalls > 0) {
    possibleCauses.push(`${failedCalls} tool call(s) failed — check tool error messages`);
  }
  if (events.some((e) => e.type === "abort")) {
    possibleCauses.push("Session was aborted — check if user cancelled or timeout occurred");
  }
  if (events.some((e) => e.type === "compaction")) {
    possibleCauses.push("Context compaction occurred — important context may have been lost");
  }
  // Check for unpaired tool calls
  const pendingCalls = new Set<string>();
  for (const evt of events) {
    if (evt.type === "tool_call") {
      pendingCalls.add((evt.payload as any)?.toolCallId);
    }
    if (evt.type === "tool_result") {
      pendingCalls.delete((evt.payload as any)?.toolCallId);
    }
  }
  if (pendingCalls.size > 0) {
    possibleCauses.push(`${pendingCalls.size} unpaired tool call(s) — session may have crashed mid-call`);
  }

  const report: PostmortemReport = {
    id: `pm-${sessionId}-${Date.now()}`,
    sessionId,
    timestamp: Date.now(),
    error,
    eventSummary: {
      totalEvents: events.length,
      lastEvents,
    },
    toolCallStats: {
      totalCalls: Object.values(toolBreakdown).reduce((a, b) => a + b, 0),
      successfulCalls,
      failedCalls,
      toolBreakdown,
    },
    possibleCauses,
  };

  // 保存报告到文件
  const reportPath = path.join(getPostmortemDir(), `${report.id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  return report;
}

/**
 * 列出所有 postmortem 报告。
 */
export function listPostmortems(): Array<{ id: string; sessionId: string; timestamp: number; error: string }> {
  const dir = getPostmortemDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const reports: Array<{ id: string; sessionId: string; timestamp: number; error: string }> = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const report = JSON.parse(content);
      reports.push({
        id: report.id,
        sessionId: report.sessionId,
        timestamp: report.timestamp,
        error: report.error,
      });
    } catch {
      // 跳过损坏的报告
    }
  }

  return reports.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 读取一份完整的 postmortem 报告。
 */
export function getPostmortem(reportId: string): PostmortemReport | null {
  const reportPath = path.join(getPostmortemDir(), `${reportId}.json`);
  if (!fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  } catch {
    return null;
  }
}
