/**
 * Thread History 的**数据层实现**（P0-2）：检索 / 回读 / 分段 / 分隔锚点 / 诊断。
 *
 * ## 为什么住在 `storage/`（而不是工具里）
 *
 * 这些操作都必须读**整个会话的时间线**。`no-sync-mirror-reads` 的边界是
 * 「整会话同步读只许出现在数据层」—— 之前的写法是让工具直接调 `listTimelineMessages`，
 * 再给那个调用点起一个"语义别名"来躲开门禁的名字匹配。那是**改名逃出统计**，
 * 不是架构：业务层照样拿着整份时间线。
 *
 * 现在边界是实的：业务层（`llm/tools/thread-history.ts`）只拿到**有界结果**
 * （hits / window / segments / 锚点 / 计数），拿不到整份时间线。
 */
import * as MessageStorage from "./message";
import { readContextEpochOf, readLatestContextEpoch, type ContextEpochMessageLike } from "../context/context-view";
import {
  readThreadHistory,
  readThreadSegment,
  searchThreadHistory,
  segmentsOf,
  type ThreadHistoryHit,
  type ThreadHistoryMessageLike,
  type ThreadSegment,
  type ThreadHistoryWindow,
} from "../context/thread-history";

/**
 * 时间线消息 = 纯函数层声明的形状（含 `toolCalls`）。
 *
 * 为什么直接别名而不是再抄一份：抄一份就等于"工具结果在哪"有两处定义 —— 只要一份漂移，
 * 检索/回读就会悄悄退回"只搜 content"（正是这轮要补的高优先级缺口）。
 */
type TimelineMessage = ThreadHistoryMessageLike;

function timelineOf(sessionId: string): TimelineMessage[] {
  return MessageStorage.listTimelineMessages(sessionId) as unknown as TimelineMessage[];
}

const readEpoch = (m: TimelineMessage) => readContextEpochOf(m as unknown as ContextEpochMessageLike);

/**
 * 检索命中（有界；`limit` 已由调用方夹取）。
 *
 * 检索面 = 正文 + 工具结果 + 工具请求侧（见 `context/thread-history.ts::searchThreadHistory`）；
 * `segmentSeq` 传了就只搜那一段（25 号文 §4.5 的 `segment?` 参数）。
 */
export function searchHistoryFor(
  sessionId: string,
  query: string,
  limit: number,
  segmentSeq?: number,
): ThreadHistoryHit[] {
  return searchThreadHistory(timelineOf(sessionId), query, limit, readEpoch, { segmentSeq });
}

/** 按 id 回读一条消息及其邻域；`null` = 不在时间线里 */
export function readHistoryFor(
  sessionId: string,
  id: string,
  before: number,
  after: number,
): ThreadHistoryWindow | null {
  return readThreadHistory(timelineOf(sessionId), id, before, after, readEpoch);
}

/**
 * 按段读取整段原文（`segmentSeq` 从 1 开始）。
 *
 * 上限由调用方夹取并**如实披露**（`truncatedAfter`）；`null` = 没有这一段。
 */
export function readSegmentFor(
  sessionId: string,
  segmentSeq: number,
  maxMessages: number,
): ThreadHistoryWindow | null {
  return readThreadSegment(timelineOf(sessionId), segmentSeq, maxMessages, readEpoch);
}

/** 分段（switch 换段、compact 不换段） */
export function segmentsFor(sessionId: string): { segments: ThreadSegment[]; messageCount: number } {
  const timeline = timelineOf(sessionId);
  return { segments: segmentsOf(timeline, readEpoch), messageCount: timeline.length };
}

/**
 * **段分隔卡的锚点**（P0-4 / FAIL 9）。
 *
 * ## 被守的缺陷
 *
 * 分隔卡原来靠"渲染视图里那条消息自己带 switch metadata"来定位。但渲染视图是
 * ContextView —— 它只保留**最新**的 epoch marker。于是"换段之后又压缩过一次"时，
 * 最新 marker 是 compact，switch marker 根本不在视图里 ⇒ 分隔卡**静默消失**，
 * 而那正是 P0-3 之后最常见的形态。
 *
 * ## 规则
 *
 * 对每个 switch marker，在时间线上向后找**第一条仍然在 ContextView 里的消息**，
 * 它就是"这一段在界面上的第一个可见位置"。找不到（整段都被后来的压缩移出视野）
 * 就不出锚点 —— 那是"滚出视野"，不是"边界丢了"。
 */
export function segmentDividerAnchors(sessionId: string): Array<{ segmentSeq: number; anchorMessageId: string }> {
  const timeline = timelineOf(sessionId);
  const visible = new Set(MessageStorage.listMessages(sessionId).map((m) => m.id));
  if (visible.size === 0) return [];

  const anchors: Array<{ segmentSeq: number; anchorMessageId: string }> = [];
  for (let i = 0; i < timeline.length; i += 1) {
    const epoch = readEpoch(timeline[i]);
    if (!epoch || epoch.kind !== "switch") continue;
    for (let j = i; j < timeline.length; j += 1) {
      if (visible.has(timeline[j].id)) {
        anchors.push({ segmentSeq: epoch.segmentSeq, anchorMessageId: timeline[j].id });
        break;
      }
    }
  }
  return anchors;
}

/** 当前生效的段信息（C03/C04 的 manifest 用它说明"为什么只看到这些"） */
export function currentSegmentInfo(sessionId: string): {
  segmentSeq: number;
  epochId?: string;
  cutoffMessageId?: string;
} {
  const latest = readLatestContextEpoch(timelineOf(sessionId) as unknown as ContextEpochMessageLike[]);
  if (!latest) return { segmentSeq: 1 };
  return {
    segmentSeq: Math.max(1, Number(latest.segmentSeq) || 1),
    epochId: latest.epochId,
    cutoffMessageId: latest.cutoffMessageId,
  };
}

/** 诊断面（P0-4）：段数 / 两种 epoch 计数 / 时间线规模 */
export function segmentDiagnostics(sessionId: string): {
  segments: number;
  switches: number;
  compacts: number;
  messages: number;
} {
  const timeline = timelineOf(sessionId);
  const epochs = timeline.map(readEpoch).filter((e): e is NonNullable<ReturnType<typeof readEpoch>> => Boolean(e));
  return {
    segments: segmentsOf(timeline, readEpoch).length,
    switches: epochs.filter((e) => e.kind === "switch").length,
    compacts: epochs.filter((e) => e.kind === "compact").length,
    messages: timeline.length,
  };
}
