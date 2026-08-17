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
  return `${home}/.codem/postmortem`;
}

/** 报告中包含的最后 N 个事件 */
const MAX_EVENTS_IN_REPORT = 20;

// ========== In-Memory Store (fallback when file I/O unavailable) ==========

const inMemoryReports: PostmortemReport[] = [];

// ========== Report Generation ==========

/**
 * R3-4.2: 为会话生成一份 postmortem 报告。
 *
 * @param sessionId 出问题的会话
 * @param error 错误描述
 * @returns 生成的报告（同时也尝试保存到文件，非关键路径失败不阻塞）
 */
export async function generatePostmortem(sessionId: string, error: string): Promise<PostmortemReport> {
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

  // 保存到内存存储（文件 I/O 不可用时的回退路径）
  inMemoryReports.push(report);

  // 保存报告到文件（非关键路径，失败不阻塞）
  try {
    const { writeFile, exists } = await import("../file-api");
    const reportPath = `${getPostmortemDir()}/${report.id}.json`;
    // 确保目录存在（Tauri IPC 不支持 mkdir，但 writeFile 会自动创建父目录）
    if (!await exists(getPostmortemDir())) {
      // 尝试写入一个 .gitkeep 文件来创建目录
      await writeFile(`${getPostmortemDir()}/.gitkeep`, "").catch(() => {});
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  } catch {
    // 非关键路径 — 报告已生成在内存中
  }

  return report;
}

/**
 * 列出所有 postmortem 报告。
 */
export async function listPostmortems(): Promise<Array<{ id: string; sessionId: string; timestamp: number; error: string }>> {
  let fileReports: Array<{ id: string; sessionId: string; timestamp: number; error: string }> = [];
  try {
    const { listDirectory, readFile } = await import("../file-api");
    const dir = getPostmortemDir();
    const entries = await listDirectory(dir).catch(() => []);
    const jsonFiles = entries.filter((e) => e.name.endsWith(".json"));

    for (const entry of jsonFiles) {
      try {
        const content = await readFile(`${dir}/${entry.name}`);
        const report = JSON.parse(content);
        fileReports.push({
          id: report.id,
          sessionId: report.sessionId,
          timestamp: report.timestamp,
          error: report.error,
        });
      } catch {
        // 跳过损坏的报告
      }
    }
  } catch {
    // 文件 I/O 不可用
  }

  // 合并文件报告和内存报告（去重：文件优先）
  const fileIds = new Set(fileReports.map(r => r.id));
  const memReports = inMemoryReports
    .filter(r => !fileIds.has(r.id))
    .map(r => ({ id: r.id, sessionId: r.sessionId, timestamp: r.timestamp, error: r.error }));

  return [...fileReports, ...memReports].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 读取一份完整的 postmortem 报告。
 */
export async function getPostmortem(reportId: string): Promise<PostmortemReport | null> {
  try {
    const { readFile, exists } = await import("../file-api");
    const reportPath = `${getPostmortemDir()}/${reportId}.json`;
    if (await exists(reportPath)) {
      const content = await readFile(reportPath);
      return JSON.parse(content);
    }
  } catch {
    // 文件 I/O 不可用
  }
  // 回退到内存存储
  return inMemoryReports.find(r => r.id === reportId) || null;
}
