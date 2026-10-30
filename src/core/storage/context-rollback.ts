/**
 * 维护 API（人工调用）：一次性回滚迁移，不在日常 UI 暴露。
 *
 * 一次性回滚迁移：检查点 → 旧版 `hidden` 视图。
 *
 * 只在需要退回旧版本时由维护动作显式调用；**不是日常开关**。
 * 规则：
 * - 取该会话最新 epoch 的 `cutoffMessageId`；
 * - cutoff 之前的消息写 `hidden=1`（保留 marker 与 cutoff 之后）；
 * - 不写墓碑、不删正文；旧版本按可见视图运行，新版本仍按 cutoff 运行；
 * - `dryRun` 只统计，不写。
 */
import { listTimelineMessages, updateMessage } from "./message";
import { readLatestContextEpoch } from "../context/context-view";

export interface ContextRollbackReport {
  sessionId: string;
  epochId: string | null;
  cutoffMessageId: string | null;
  /** cutoff 之前、需要隐藏的消息数 */
  candidates: number;
  /** 实际写入 hidden=1 的条数 */
  hidden: number;
  /** 写入失败条数 */
  failed: number;
  dryRun: boolean;
}

export async function rollbackSessionToClassicHidden(
  sessionId: string,
  opts: { dryRun?: boolean } = {},
): Promise<ContextRollbackReport> {
  const dryRun = opts.dryRun === true;
  const report: ContextRollbackReport = {
    sessionId,
    epochId: null,
    cutoffMessageId: null,
    candidates: 0,
    hidden: 0,
    failed: 0,
    dryRun,
  };
  if (!sessionId) return report;

  const timeline = listTimelineMessages(sessionId);
  const epoch = readLatestContextEpoch(timeline as never[]);
  if (!epoch) return report;
  report.epochId = epoch.epochId;
  report.cutoffMessageId = epoch.cutoffMessageId;

  const cutoffIndex = timeline.findIndex((m) => m.id === epoch.cutoffMessageId);
  if (cutoffIndex < 0) return report;
  const before = timeline.slice(0, cutoffIndex).filter((m) => m.id !== epoch.epochId);
  report.candidates = before.length;
  if (dryRun) return report;

  for (const m of before) {
    if (Number((m as unknown as { hidden?: number }).hidden ?? 0) === 1) continue;
    try {
      updateMessage(m.id, { hidden: 1 } as never);
      report.hidden += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
