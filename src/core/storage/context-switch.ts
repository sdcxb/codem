/**
 * 段切换的**写入侧**（P0-3 / D1 / D3）—— 数据层实现。
 *
 * ## 为什么住在 `storage/`
 *
 * 它必须读**整个会话的时间线**才能算出 cutoff（新段保留哪几条），并且要一次写
 * 两条持久事实：epoch marker 消息 + `context_steward_decision` 事件。
 * 这两件事都属于数据层；决策规则（`decideEpochAction`）与 handoff 文本
 * （`buildSwitchHandoff`）是**纯函数**，留在 `core/context/segment-switch.ts`。
 *
 * 拆开的直接收益：`no-sync-mirror-reads` 门禁的"数据层以外不许整会话同步读"
 * 不需要为这个文件开口子 —— 它现在**就是**数据层。
 */
import { createMessage, listTimelineMessages } from "./message";
import { getEventLog } from "./event-log";
import { nextCompactionMarkerId } from "../llm/compaction-budget";
import {
  buildContextEpochMetadata,
  readContextEpochOf,
  type ContextEpochMessageLike,
} from "../context/context-view";
import { buildSwitchHandoff } from "../context/segment-switch";
import { buildThreadNotesDigest, latestThreadNoteId } from "../context/thread-notes";

export interface SegmentSwitchResult {
  switched: boolean;
  epochId?: string;
  segmentSeq?: number;
  removed?: number;
  kept?: number;
  reason?: string;
}

export interface SegmentSwitchOptions {
  /** 换段后模型还看得到多少条最近消息（默认 20，与 compact 的保留数一致） */
  keepCount?: number;
  /** 注入 now（判据用） */
  now?: number;
  /** 记录决策事件（默认 true；判据可关） */
  recordEvent?: boolean;
}

/**
 * 写入一个 `kind="switch"` 的 epoch（**不新建 Session、不删任何消息**）。
 *
 * 单飞：整段是同步的（无 await），JS 单线程下不存在并发窗口 —— 这是刻意的，
 * 也是它能不引入锁/超时的原因。调用方（loop）在压力触发点串行调用。
 */
export function performSegmentSwitch(
  sessionId: string,
  options: SegmentSwitchOptions = {},
): SegmentSwitchResult {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const timeline = listTimelineMessages(sessionId);
  if (timeline.length === 0) return { switched: false, reason: "empty session" };

  /**
   * 段号 = **已有最大段号 + 1**，从**整条时间线**扫最大值，而不是只取
   * `readLatestContextEpoch` 那一条。
   *
   * ## 为什么不能只取"最新那条"的段号（2026-11 P0）
   *
   * 选最新那条本身依赖排序口径；一旦排序被老数据的 `seq` 影响（重启后计数器归零，
   * 新 epoch 的 seq 比老的小），"最新"就会指回旧段 ⇒ 新段号 = 旧段号 + 1 ⇒ 段号停滞
   * 甚至回退。取整个时间线的最大值对排序口径免疫：只要历史里出现过第 9 段，
   * 新段就一定是 10。
   *
   * ## 为什么显式把 `seq` 也传下去
   *
   * marker 主键仍由 `nextCompactionMarkerId()` 生成（它保证**跨会话**主键唯一），
   * 但它尾号是**进程内计数器**：重启归零。让 id 尾号决定 epoch 的排序序号 =
   * 把"重启"变成"版本回退"（本缺陷的根因之一）。epoch 的 `seq` / `segmentSeq`
   * 都从时间线算出来，id 只负责唯一性。
   */
  const maxSegmentSeq = timeline.reduce((max, m) => {
    const epoch = readContextEpochOf(m as unknown as ContextEpochMessageLike);
    return epoch ? Math.max(max, epoch.segmentSeq) : max;
  }, 1);
  const segmentSeq = Math.max(1, maxSegmentSeq) + 1;

  const keepCount = Math.min(
    Math.max(Math.floor(Number(options.keepCount) || 20), 1),
    timeline.length,
  );
  /**
   * 没有可切的内容就不该写 marker：`timeline.length <= keepCount` 时"移出视图"是 0 条 ——
   * 写出来只是凭空多一条 handoff，还让 loop 走"成功"收尾（清缓存 + 计连压），视图一条没少。
   * 回退压缩是正确处置（D3 的段边界必须真的切开）。
   */
  if (timeline.length <= keepCount) {
    return { switched: false, reason: "nothing to cut" };
  }
  const keep = timeline.slice(-keepCount);
  const cutoffMessageId = keep[0]?.id;
  if (!cutoffMessageId) return { switched: false, reason: "no cutoff message" };

  const epochId = nextCompactionMarkerId("auto");
  /**
   * handoff 的 "用户最近原话" 必须**排除 marker 自己**：compact/switch marker 都是
   * `role:"user"`，不过滤会把「[已切换到新段]」「[上下文已自动压缩]」甚至**上一份 handoff 正文**
   * 当成用户说过的话抄进 Goals（第二次换段起必然发生）。
   */
  const humanTimeline = timeline.filter(
    (m) => !readContextEpochOf(m as unknown as ContextEpochMessageLike),
  );
  /**
   * P1-1：把会话笔记摘要拼进 handoff **尾部**（untrusted）。
   *
   * 失败/没有笔记都必须**不阻断换段**：catch 后按空串继续，handoff 与旧版逐字一致
   * （"notes 不可用回退现有摘要"）。摘要上限见 `THREAD_NOTES_DIGEST_MAX_CHARS`（8KB）。
   */
  let notesDigest = "";
  try {
    notesDigest = buildThreadNotesDigest(sessionId);
  } catch (e) {
    console.warn("[segment-switch] 会话笔记摘要读取失败（handoff 回退为旧版内容）:", e);
  }
  const handoff = buildSwitchHandoff(
    humanTimeline as unknown as Array<{ id: string; role?: string; content?: unknown; timestamp?: number }>,
    keep as unknown as Array<{ id: string; content?: unknown }>,
    segmentSeq,
    notesDigest,
  );
  const metadata = buildContextEpochMetadata({
    epochId,
    cutoffMessageId,
    createdAt: now,
    removedCount: timeline.length - keep.length,
    keptCount: keep.length,
    trigger: "switch",
    kind: "switch",
    /* 显式给 seq：不要让 `compact-<ts>-<n>` 的尾号（进程内计数器）决定 epoch 新旧 */
    seq: segmentSeq,
    segmentSeq,
    /**
     * P1-2（24 §P1-2）：`handoffRef` / `notesRef` 只在**真的有对应内容**时写。
     *
     * - `handoffRef`：handoff 正文就写在这条 marker 里 ⇒ 指向它自己的 id（读侧/面板据此
     *   知道「这条 epoch 有交接正文可读」）；
     * - `notesRef`：本会话最新一条笔记的 id（`notes_read id=<id>` 可回读全文）。没有笔记
     *   ⇒ 不写（契约是「缺省 = 没有这个引用」，不是空串占位）。
     */
    handoffRef: epochId,
    notesRef: latestThreadNoteId(sessionId),
  });
  if (!metadata) return { switched: false, reason: "epoch metadata rejected" };

  createMessage(
    { id: epochId, role: "user", content: handoff, timestamp: now - 1, status: "done", metadata },
    sessionId,
  );

  if (options.recordEvent !== false) {
    try {
      getEventLog().append(sessionId, "context_steward_decision", {
        action: "switch",
        epochId,
        segmentSeq,
        cutoffMessageId,
        removedCount: timeline.length - keep.length,
        keptCount: keep.length,
        at: now,
      });
    } catch (e) {
      /* 事件是诊断面：写不进去不影响切换本身，但必须留痕（不静默） */
      console.warn("[segment-switch] steward_decision 事件未写入:", e);
    }
  }

  return {
    switched: true,
    epochId,
    segmentSeq,
    removed: timeline.length - keep.length,
    kept: keep.length,
  };
}
