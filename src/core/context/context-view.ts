/**
 * 上下文检查点的**读侧契约**（第 1 步：只做投影，不改压缩写路径）。
 *
 * 目标（见 `docs/project-guide/18-CONTEXT-CHECKPOINT-DESIGN.md`）：
 * - 压缩不再删除/隐藏消息，而是写一条带 `metadata.contextEpoch` 的 summary marker；
 * - 模型可见集合 = 最新 epoch 的 marker + `cutoffMessageId` 之后的消息；
 * - cutoff 必须按 **消息 id** 定位，不能用 timestamp、也不能用 marker 的位置；
 * - 任何一步不成立都 **fail-open 到完整输入并给出 warning**，绝不静默返回空。
 *
 * 这一步只把契约与纯函数落地，并由 `storage/message.ts` 的读路径调用：
 * 没有 epoch 时行为与旧实现逐字一致；有 epoch 时才开始裁剪。压缩写路径在后续步骤接入。
 */

/** summary marker 的 id 前缀（`nextCompactionMarkerId` 生成 `compact-<ts>-<seq>` / `compact-manual-...`） */
const CONTEXT_EPOCH_MARKER_ID = /^compact(?:-manual)?-/;

/** 读侧只依赖这些字段；用结构化类型，避免把 storage 的 Message 拖进纯函数 */
export interface ContextEpochMessageLike {
  id: string;
  role?: string;
  timestamp?: number;
  metadata?: Record<string, unknown> | null;
  hidden?: unknown;
  trimmed?: unknown;
}

export interface ContextEpoch {
  epochId: string;
  seq: number;
  cutoffMessageId: string;
  createdAt: number;
  removedCount: number;
  keptCount: number;
  trigger: string;
  /**
   * cutoff 之后仍需排除的少数 id。
   *
   * 为什么需要：cutoff 是单点，而“待移除集合”可能包含排在 cutoff 之后的陈旧 marker
   * （用户粘回的摘要、时间戳异常的历史标记）。只靠单点 cutoff 会把它们留在模型视图里。
   * 正常压缩这里为空；只有异常形态才会列 id，所以体积可控。
   */
  excludedMessageIds: string[];
}

interface ContextProjection<T> {
  messages: T[];
  epoch: ContextEpoch | null;
  applied: boolean;
  warnings: string[];
}

function asFiniteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asNonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 从 `compact-<ts>-<seq>` / `compact-manual-<ts>-<seq>` 里取尾部序号；取不到返回 0 */
function sequenceFromEpochId(epochId: string): number {
  const m = /-(\d+)$/.exec(epochId);
  return m ? asNonNegativeInt(m[1]) : 0;
}

/**
 * 构造 marker 的 `metadata.contextEpoch`（写侧唯一入口）。
 *
 * `seq` 优先用调用方给的；没给就从 epochId 尾部取。没有 epoch/cutoff 时返回 null，
 * 调用方必须**不写 metadata**（宁可不产生 epoch，也不写半截）。
 */
export function buildContextEpochMetadata(input: {
  epochId: string;
  cutoffMessageId: string;
  createdAt: number;
  removedCount?: number;
  keptCount?: number;
  trigger?: string;
  seq?: number;
  excludedMessageIds?: string[];
}): Record<string, unknown> | null {
  const epochId = typeof input.epochId === "string" ? input.epochId.trim() : "";
  const cutoffMessageId = typeof input.cutoffMessageId === "string" ? input.cutoffMessageId.trim() : "";
  if (!epochId || !cutoffMessageId) return null;
  const createdAt = asFiniteNumber(input.createdAt, 0);
  const seq = Number.isFinite(Number(input.seq)) ? Number(input.seq) : sequenceFromEpochId(epochId);
  const excludedMessageIds = Array.isArray(input.excludedMessageIds)
    ? [...new Set(input.excludedMessageIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  return {
    contextEpoch: {
      epochId,
      seq,
      cutoffMessageId,
      removedCount: asNonNegativeInt(input.removedCount),
      keptCount: asNonNegativeInt(input.keptCount),
      trigger: typeof input.trigger === "string" && input.trigger ? input.trigger : "unknown",
      createdAt,
      ...(excludedMessageIds.length > 0 ? { excludedMessageIds } : {}),
    },
  };
}

/**
 * 计算“cutoff 之后仍需排除”的 id。
 *
 * 正常压缩返回空数组；只有 `messagesToRemove` 里存在排在 cutoff 之后的消息
 * （陈旧 marker、异常时间戳）时才返回这些 id。调用方必须把结果写进 epoch metadata，
 * 否则模型会在 cutoff 后重新看到它们。
 */
export function contextCutoffExclusions(
  messages: ContextEpochMessageLike[],
  messagesToKeep: ContextEpochMessageLike[],
  messagesToRemove: ContextEpochMessageLike[],
): string[] {
  const cutoffMessageId = messagesToKeep[0]?.id;
  if (!cutoffMessageId) return [];
  const order = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) order.set(messages[i].id, i);
  const cutoffIndex = order.get(cutoffMessageId);
  if (cutoffIndex === undefined) return [];
  const out: string[] = [];
  for (const m of messagesToRemove) {
    const index = order.get(m.id);
    if (index !== undefined && index >= cutoffIndex) out.push(m.id);
  }
  return [...new Set(out)];
}

/**
 * 从一条消息里读出 epoch。
 *
 * 只有 **id 前缀 + metadata.contextEpoch 同时成立** 才算数：
 * - 用户把摘要正文粘回对话（正文前缀相同）不会造出 epoch；
 * - 旧 marker（没有 metadata）也不在这里猜，交给 legacy 兼容路径。
 */
function readContextEpoch(message: ContextEpochMessageLike | null | undefined): ContextEpoch | null {
  if (!message || typeof message.id !== "string" || !CONTEXT_EPOCH_MARKER_ID.test(message.id)) return null;
  const raw = message.metadata?.contextEpoch;
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const cutoffMessageId = typeof e.cutoffMessageId === "string" ? e.cutoffMessageId.trim() : "";
  if (!cutoffMessageId) return null;
  const epochId = typeof e.epochId === "string" && e.epochId.trim() ? e.epochId.trim() : message.id;
  return {
    epochId,
    seq: asFiniteNumber(e.seq, 0),
    cutoffMessageId,
    createdAt: asFiniteNumber(e.createdAt, asFiniteNumber(message.timestamp, 0)),
    removedCount: asNonNegativeInt(e.removedCount),
    keptCount: asNonNegativeInt(e.keptCount),
    trigger: typeof e.trigger === "string" ? e.trigger : "unknown",
    excludedMessageIds: Array.isArray(e.excludedMessageIds)
      ? e.excludedMessageIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
  };
}

/**
 * 选最新 epoch：先比 `seq`，再比 `createdAt`，最后比出现位置。
 *
 * 为什么保留三级比较：旧数据/迁移数据可能缺 seq 或 createdAt；只用 seq 会让
 * 「seq 都是 0」的两条 epoch 随机选一条，最终裁到错误边界。
 */
function selectLatestContextEpoch<T extends ContextEpochMessageLike>(
  messages: T[],
): { epoch: ContextEpoch; marker: T; index: number } | null {
  let best: { epoch: ContextEpoch; marker: T; index: number } | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const epoch = readContextEpoch(messages[i]);
    if (!epoch) continue;
    if (!best) {
      best = { epoch, marker: messages[i], index: i };
      continue;
    }
    const newer =
      epoch.seq > best.epoch.seq ||
      (epoch.seq === best.epoch.seq && epoch.createdAt > best.epoch.createdAt) ||
      (epoch.seq === best.epoch.seq &&
        epoch.createdAt === best.epoch.createdAt &&
        i > best.index);
    if (newer) best = { epoch, marker: messages[i], index: i };
  }
  return best;
}

/** 只取最新 epoch（迁移/回滚用），不改变消息集合 */
export function readLatestContextEpoch(messages: ContextEpochMessageLike[]): ContextEpoch | null {
  return selectLatestContextEpoch(messages)?.epoch ?? null;
}

/**
 * 把完整消息列表投影成**模型可见集合**。
 *
 * - 没有 epoch：原样返回（与旧实现逐字一致，便于灰度）；
 * - 有 epoch 且 cutoff 存在：`[marker, ...cutoff 之后的消息]`；
 * - cutoff 不在列表里：fail-open 原样返回 + warning（模型可能多看到，但绝不静默丢）；
 * - cutoff 落在 marker 之前/等于 marker：仍保留 marker + marker 之后的消息，并给 warning。
 *
 * ⚠️ 不在这里过滤 hidden：调用方（`listMessagesMerged`）已经按旧语义排除了
 * legacy compressed hidden；本函数只负责 epoch cutoff。等压缩写路径改成
 * 「不写 hidden」后，hidden 过滤会自然变成空操作。
 */
export function applyContextCutoff<T extends ContextEpochMessageLike>(messages: T[]): ContextProjection<T> {
  if (messages.length === 0) return { messages, epoch: null, applied: false, warnings: [] };
  const latest = selectLatestContextEpoch(messages);
  if (!latest) return { messages, epoch: null, applied: false, warnings: [] };

  const cutoffIndex = messages.findIndex((m) => m.id === latest.epoch.cutoffMessageId);
  if (cutoffIndex < 0) {
    return {
      messages,
      epoch: latest.epoch,
      applied: false,
      warnings: [`epoch ${latest.epoch.epochId}: cutoff message ${latest.epoch.cutoffMessageId} not found; fail-open`],
    };
  }

  /**
   * marker 的时间戳是 `markerTs - 1`，通常**晚于**最近保留消息，所以它在数组里
   * 往往排在 cutoff 之后；不能因此把 cutoff 当“异常”。统一规则：
   * `[marker, ...cutoff 起的后缀（去掉 marker 自身与 excluded）]`。
   *
   * 这样无论 marker 在 cutoff 前还是后，模型都先看到摘要，再看到最近保留消息；
   * cutoff 之前的历史被排除。
   */
  const excluded = new Set(latest.epoch.excludedMessageIds);
  const tail = messages
    .slice(cutoffIndex)
    .filter((m) => m.id !== latest.marker.id && !excluded.has(m.id));
  return {
    messages: [latest.marker, ...tail],
    epoch: latest.epoch,
    applied: true,
    warnings: [],
  };
}
