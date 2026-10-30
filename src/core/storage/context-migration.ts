/**
 * 旧压缩历史的 best-effort 回填。
 *
 * 旧版本压缩把消息写成 `hidden=1, trimmed=0`，并且墓碑已经进了权威日志。
 * 完整时间线现在能从索引镜像读到它们，但**索引重建后这些行会消失**；
 * 这里把仍然存在的 hidden 行以 `hidden=1` 追加到日志（墓碑之后）：
 * 完整时间线仍能读 hidden（人看得到），模型视图仍过滤 hidden（模型看不到），
 * 索引重建后语义不变。
 *
 * 纪律：
 * - 只处理 `hidden=1 && trimmed≠1`（trimmed 是索引裁剪，不是压缩）；
 * - 日志里已经有同 id 记录 ⇒ 跳过（幂等）；
 * - 追加失败/校验失败 ⇒ 记入 failed，不伪造"已恢复"；
 * - 不删除任何东西，不改墓碑。
 */
import { listMessagesFromIndex } from "./message";
import { appendSessionMessage, flushSessionLogWrites, readSessionMessages } from "./session-jsonl";
import type { Message } from "../../store";

export interface ContextMigrationReport {
  sessionId: string;
  /** 索引里仍是旧压缩 hidden 的行数 */
  hiddenRows: number;
  /** 日志里已经有正常记录、无需回填 */
  alreadyDurable: number;
  /** 本次追加成功并通过回读校验 */
  appended: number;
  /** 追加失败或回读校验失败（不可恢复/需人工） */
  failed: number;
  dryRun: boolean;
}

export interface MigrateOptions {
  dryRun?: boolean;
}

/**
 * 回填一个会话的旧压缩历史。
 *
 * 注意：`listMessagesFromIndex(..., includeHidden=true)` 依赖该会话的索引镜像已加载；
 * 未加载时返回 0 行（报告 hiddenRows=0），调用方应把它当作「本次没有可处理数据」，
 * 而不是「历史已经全部安全」。
 */
export async function migrateSessionLegacyHistory(
  sessionId: string,
  opts: MigrateOptions = {},
): Promise<ContextMigrationReport> {
  const dryRun = opts.dryRun === true;
  const report: ContextMigrationReport = {
    sessionId,
    hiddenRows: 0,
    alreadyDurable: 0,
    appended: 0,
    failed: 0,
    dryRun,
  };
  if (!sessionId) return report;

  const rows = listMessagesFromIndex(sessionId, undefined, true);
  const hidden = rows.filter(
    (m) => Number((m as unknown as { hidden?: number }).hidden ?? 0) === 1
      && Number((m as unknown as { trimmed?: number }).trimmed ?? 0) !== 1,
  );
  report.hiddenRows = hidden.length;
  if (hidden.length === 0) return report;

  let logIds = new Set<string>();
  try {
    const { messages } = await readSessionMessages(sessionId);
    logIds = new Set(messages.map((m) => String((m as { id?: unknown }).id ?? "")));
  } catch {
    /* 日志不可读：下面按「都没落盘」处理，追加后再校验 */
  }

  const pending = hidden.filter((m) => !logIds.has(m.id));
  report.alreadyDurable = hidden.length - pending.length;
  if (dryRun || pending.length === 0) return report;

  for (const m of pending) {
    try {
      /**
       * 保留 `hidden=1`：完整时间线读 hidden 行，模型视图过滤 hidden；
       * 这样索引从日志重建后语义仍是「人看得到、模型看不到」，不会把旧 hidden 放回模型上下文。
       */
      await appendSessionMessage(sessionId, { ...m, hidden: 1 } as unknown as Message);
      report.appended += 1;
    } catch {
      report.failed += 1;
    }
  }
  await flushSessionLogWrites();

  // 回读校验：只有日志真的出现该 id 才算成功；否则把这条从 appended 移进 failed。
  try {
    const { messages } = await readSessionMessages(sessionId);
    const after = new Set(messages.map((m) => String((m as { id?: unknown }).id ?? "")));
    for (const m of pending) {
      if (!after.has(m.id)) {
        report.appended = Math.max(0, report.appended - 1);
        report.failed += 1;
      }
    }
  } catch {
    // 回读失败：已追加的条数无法证明，全部记 failed（不伪造成功）
    report.failed += report.appended;
    report.appended = 0;
  }

  return report;
}
