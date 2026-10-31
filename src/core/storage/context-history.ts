/**
 * 完整历史的数据层投影（UI 只调这里，不直接碰同步整会话读）。
 *
 * `src/components/FullHistoryPanel.tsx` 需要「完整时间线 + 模型可见条数」两样东西；
 * 按第 144 波的结构边界，同步整会话读只许留在数据层，UI 不能直接 `listMessages(`。
 * 这个文件就是那层薄投影：一次读两份，组件只拿结果。
 */
import { listMessages, listTimelineMessages } from "./message";
import { reportAdvisory } from "./persist-failure";
import type { Message } from "../../store";

export interface ContextHistorySnapshot {
  /** 含旧压缩 hidden / 索引裁剪 trimmed 的完整时间线 */
  timeline: Message[];
  /** 模型当前可见集合（检查点 cutoff 之后） */
  model: Message[];
  /** 模型当前可见条数（用于「历史 N / 模型 M」） */
  modelCount: number;
}

const autoMigrated = new Set<string>();
const syncedEpochSignature = new Map<string, string>();

/** 时间线里是否还有旧版压缩留下的 hidden 行（`trimmed` 是索引裁剪，不算） */
export function needsLegacyBackfill(timeline: Message[]): boolean {
  return timeline.some(
    (m) => Number((m as unknown as { hidden?: number }).hidden ?? 0) === 1
      && Number((m as unknown as { trimmed?: number }).trimmed ?? 0) !== 1,
  );
}

/**
 * 打开会话时自动做一次 best-effort 回填：旧 hidden 行只留在索引里，
 * 索引重建前不落日志就会丢。失败上报 advisory，不阻塞界面；用户仍可手动重试。
 *
 * 生产路径才自动跑（测试里由 `migrateSessionLegacyHistory` 判据覆盖），
 * 避免单测因为读取历史而异步写盘。
 */
function scheduleLegacyBackfill(sessionId: string, timeline: Message[]): void {
  if (!sessionId || autoMigrated.has(sessionId) || !needsLegacyBackfill(timeline)) return;
  if (import.meta.env?.MODE === "test") return;
  autoMigrated.add(sessionId);
  void (async () => {
    try {
      const { migrateSessionLegacyHistory } = await import("./context-migration");
      const report = await migrateSessionLegacyHistory(sessionId);
      if (report.appended > 0) {
        console.info(`[ContextHistory] 旧压缩历史自动回填 ${report.appended} 条（${sessionId}）`);
      }
      if (report.failed > 0) {
        reportAdvisory(
          "context.legacyBackfill",
          `旧压缩历史自动回填失败 ${report.failed} 条（会话 ${sessionId}）`,
          { nextStep: "仍可在完整历史面板点「回填旧历史」重试；失败条目在索引重建后可能丢失。" },
        );
      }
    } catch (e) {
      reportAdvisory(
        "context.legacyBackfill",
        `旧压缩历史自动回填异常：${e instanceof Error ? e.message : String(e)}`,
        { nextStep: "仍可在完整历史面板点「回填旧历史」重试。" },
      );
    }
  })();
}

export function readContextHistory(sessionId: string): ContextHistorySnapshot {
  const timeline = listTimelineMessages(sessionId);
  const model = listMessages(sessionId);
  scheduleLegacyBackfill(sessionId, timeline);
  // 派生索引：marker 集合变化时才重新投影，避免每次读历史都写表
  const epochSignature = timeline
    .filter((m) => /^compact(?:-manual)?-/.test(m.id))
    .map((m) => m.id)
    .join("|");
  if (epochSignature && import.meta.env?.MODE !== "test" && syncedEpochSignature.get(sessionId) !== epochSignature) {
    syncedEpochSignature.set(sessionId, epochSignature);
    void import("./context-epochs").then((m) => m.syncContextEpochs(sessionId, timeline)).catch(() => {});
  }
  return { timeline, model, modelCount: model.length };
}
