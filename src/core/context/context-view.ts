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

/**
 * epoch 的**类型**（D3：compact 与 switch 分离）。
 *
 * - `compact`：段内压缩，写检查点摘要；
 * - `switch`：段边界，写 handoff 摘要。
 *
 * 两者在**读侧形状相同**（都是 `[marker, ...cutoff 之后]`），差别只在语义：
 * switch 之后旧段属于「上一个段」，用户/手机/分叉仍应看得到（DisplayView 完整）。
 * 旧数据没有这个字段，一律按 `compact` 处理 —— 下面 `readContextEpoch` 的默认值。
 */
export type ContextEpochKind = "compact" | "switch";

/** 旧 epoch / 缺字段时的段号默认值（D1：第一版所有历史都算第 1 段） */
const CONTEXT_EPOCH_DEFAULT_SEGMENT_SEQ = 1;

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
   * 段内压缩还是段边界（D3）。
   *
   * 读侧**不据此改变投影形状** —— switch 也是 `[marker, ...tail]`；
   * 它改变的是「用户/手机/分叉要不要看完整时间线」（`hasSwitchEpoch` + DisplayView guard）。
   */
  kind: ContextEpochKind;
  /**
   * 段号（D1：Epoch=Segment）。
   *
   * 历史数据无法回填真实段号（当时没有这个概念），一律 1；
   * 新写入由调用方给，缺省也是 1。
   */
  segmentSeq: number;
  /**
   * 这次检查点所依据的 **handoff 摘要**引用（24 §P1-2）。
   *
   * 语义：指向承载交接正文的那条消息 id —— 目前就是 `kind="switch"` 的 marker 自己
   * （`storage/context-switch.ts` 把 handoff 正文写在这条消息里）。读侧只把它当**指针**，
   * 不据此改变投影形状：拿它去 `thread_history_read` 能取回交接正文。
   *
   * 旧 marker 没有这个字段 ⇒ 读回 `undefined`（不是空串，也不猜）。字段缺失是合法状态：
   * P1-1 的 notes / handoff 能力落地之前，普通段内压缩就不会写它。
   */
  handoffRef?: string;
  /**
   * 这次检查点对应的**会话 notes** 引用（24 §P1-1 / P1-2）。
   *
   * 语义：notes 是「目标 / 进度 / 卡点」的会话级记录（不是长期记忆）。压缩前若写过 notes，
   * epoch 就带上它的引用，压缩后模型/用户能按指针取回。**没有 notes 时不写**（不写空串、
   * 不写占位值）；旧 marker 缺这个字段同样合法，读侧忽略。
   */
  notesRef?: string;
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
 * `kind` 归一：**只有显式 `switch` 才算 switch**，其余（未知取值、旧数据、坏数据）
 * 一律 `compact`。
 *
 * 为什么默认必须偏向 compact：switch 会让 DisplayView 读完整时间线（D11 的 guard）。
 * 把未知值猜成 switch = 让一个坏字段把手机/分叉的历史读法整个改掉；猜成 compact
 * 最坏只是「少看到旧段」—— 而那种情况本来就有 thread history 检索兜底。
 */
function normalizeEpochKind(value: unknown): ContextEpochKind {
  return value === "switch" ? "switch" : "compact";
}

/** 段号归一：正整数；0 / 负数 / NaN / 缺失 → 1（历史数据没有段号） */
function normalizeSegmentSeq(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : CONTEXT_EPOCH_DEFAULT_SEGMENT_SEQ;
}

/**
 * 给派生索引（`storage/context-epochs.ts`）复用的**同一份**归一。
 *
 * 为什么导出：派生表与读侧必须用同一套默认值，否则「表里是 switch、读侧当 compact」
 * 会让完整历史面板与模型视图对同一份数据给出两个答案（本仓最忌讳的口径分叉）。
 */
export { normalizeEpochKind, normalizeSegmentSeq };

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
  /** 段内压缩（默认）还是段边界（D3） */
  kind?: ContextEpochKind;
  /** 第几段；缺省 1（D1） */
  segmentSeq?: number;
  /** handoff 摘要引用（有 handoff 时写；没有就不写，见 `ContextEpoch.handoffRef`） */
  handoffRef?: string;
  /** 会话 notes 引用（有 notes 时写；没有就不写，见 `ContextEpoch.notesRef`） */
  notesRef?: string;
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
  /**
   * `handoffRef` / `notesRef`：**有才写，没有就整个键都不出现**（24 §P1-2）。
   *
   * 为什么不写空串/占位：读侧的契约是「缺省 = 没有这个引用」，空串会让调用方
   * 误以为存在一个可读的引用；而写一个占位值等于对模型/用户编造了一个来源。
   * 这两个键也因此对旧读侧零风险（显式取字段、忽略未知键）。
   */
  const optionalRef = (value: unknown): string | undefined => {
    const ref = typeof value === "string" ? value.trim() : "";
    return ref.length > 0 ? ref : undefined;
  };
  const handoffRef = optionalRef(input.handoffRef);
  const notesRef = optionalRef(input.notesRef);
  return {
    contextEpoch: {
      epochId,
      seq,
      cutoffMessageId,
      removedCount: asNonNegativeInt(input.removedCount),
      keptCount: asNonNegativeInt(input.keptCount),
      trigger: typeof input.trigger === "string" && input.trigger ? input.trigger : "unknown",
      createdAt,
      /**
       * kind / segmentSeq **总是写出**（不是「开关打开才写」）。
       *
       * 理由：它们描述的是这条 epoch **本来是什么**，不是新能力。旧读侧显式取字段、
       * 忽略未知键，所以多写两个键是零风险的；反过来「开关关着就写半截形状」会让
       * 契约出现两种形态，判据与迁移都要分叉（本仓已经因为「同一件事两套口径」栽过）。
       */
      kind: normalizeEpochKind(input.kind),
      segmentSeq: normalizeSegmentSeq(input.segmentSeq),
      ...(handoffRef ? { handoffRef } : {}),
      ...(notesRef ? { notesRef } : {}),
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
  /* 旧 marker 没有这两个字段 ⇒ 读回 undefined（键也不出现）；坏值同样按「没有」处理，不猜 */
  const handoffRef = typeof e.handoffRef === "string" && e.handoffRef.trim() ? e.handoffRef.trim() : undefined;
  const notesRef = typeof e.notesRef === "string" && e.notesRef.trim() ? e.notesRef.trim() : undefined;
  return {
    epochId,
    seq: asFiniteNumber(e.seq, 0),
    cutoffMessageId,
    createdAt: asFiniteNumber(e.createdAt, asFiniteNumber(message.timestamp, 0)),
    removedCount: asNonNegativeInt(e.removedCount),
    keptCount: asNonNegativeInt(e.keptCount),
    trigger: typeof e.trigger === "string" ? e.trigger : "unknown",
    /* 旧 marker 没有这两个字段 ⇒ compact/1（见 normalize* 的说明） */
    kind: normalizeEpochKind(e.kind),
    segmentSeq: normalizeSegmentSeq(e.segmentSeq),
    ...(handoffRef ? { handoffRef } : {}),
    ...(notesRef ? { notesRef } : {}),
    excludedMessageIds: Array.isArray(e.excludedMessageIds)
      ? e.excludedMessageIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
  };
}

/**
 * 选最新 epoch：**先比 `createdAt`，再比 `seq`**，最后比出现位置。
 *
 * ## 为什么 createdAt 优先（2026-11 重启缺陷，P0）
 *
 * `seq` 不是跨进程事实：compact 路径的 `seq` 来自 `nextCompactionMarkerId()` 的
 * **进程内计数器**（重启归零），而换段路径修复前也依赖同一个尾号。老会话里已有
 * `seq=9`，重启后新写的 epoch 是 `seq=1` —— 虽然 `createdAt` 更新，按 seq 优先
 * 仍会选老那条 ⇒ 模型视图不换段、`currentSegmentInfo` 报旧段，**一声不响**。
 * 同理，修复后只保证「新写 switch 的 seq 单调」，历史数据里 seq 逆序的形态仍存在。
 *
 * 创建时间是新旧关系里唯一跨进程的事实；`seq` 退化为**同一时刻内的消歧**
 * （同毫秒两次写入），再退化为出现位置（数组顺序即写入顺序）。
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
      epoch.createdAt > best.epoch.createdAt ||
      (epoch.createdAt === best.epoch.createdAt && epoch.seq > best.epoch.seq) ||
      (epoch.createdAt === best.epoch.createdAt &&
        epoch.seq === best.epoch.seq &&
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
 * 读**单条消息**上的 epoch（`null` = 这条不是 marker 或 metadata 不成立）。
 *
 * 为什么导出：thread history 的分段/检索要逐条判断"这一条是不是段边界"，
 * 而 `readLatestContextEpoch` 只回答"最新的是哪一条"。两件事共用同一个解析
 * （`readContextEpoch`），避免出现"history 认段、投影不认"的第二套口径。
 */
export function readContextEpochOf(message: ContextEpochMessageLike | null | undefined): ContextEpoch | null {
  return readContextEpoch(message);
}

/**
 * 时间线里**是否出现过段边界**（D3 / E5 / D11）。
 *
 * ## 为什么必须扫全部 epoch，而不是只看最新一条
 *
 * `kind=switch` 之后，新段里还会继续 compact ⇒ 最新 epoch 通常是 `compact`。
 * 只看最新一条会在「换段后第一次压缩」时把 switch 事实弄丢，于是手机/分叉
 * 又开始按投影视图读 —— 正是 D11 要挡的那个静默丢段。
 *
 * ## 为什么读**时间线**而不是模型视图
 *
 * `applyContextCutoff` 只保留最新 marker，更早的 marker（含 switch）在投影视图里
 * 根本不存在 ⇒ 拿模型视图判断必然漏。调用方必须传 `listTimelineMessages` 的结果。
 *
 * 纯函数，不做 IO；坏数据（非对象 metadata、坏 JSON、无 cutoff）由 `readContextEpoch`
 * 统一跳过，不会误判。
 */
export function hasSwitchEpoch(messages: ContextEpochMessageLike[]): boolean {
  for (const message of messages) {
    if (readContextEpoch(message)?.kind === "switch") return true;
  }
  return false;
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
