/**
 * 记忆提取的**水位游标**（24 号文 §P0-3：水位按事件 id / epoch 持久化，不再按可见消息长度）。
 *
 * ## 被守的缺陷
 *
 * 旧水位是**消息条数**（`Map<sessionId, number>`，进程内）：
 * - 重启即失效 ⇒ 每次启动第一次提取都会把整段对话重新提取一遍（写重复条目）；
 * - 源换了（模型视图 → 完整时间线）之后同一个条数对应的是**不同的消息集合** ⇒
 *   水位差变负 ⇒ 提取被限频门永久挡住（用户侧："这个会话再也不沉淀记忆了"）；
 * - 压缩把可见消息并掉之后条数变小 ⇒ 同样的负差。
 *
 * 现在游标是**最后一条已提取的消息 id** + 它所在 epoch 的 `epochId` / `segmentSeq`：
 * - 新消息判定 = "按 id 之后"（顺序取消息列表里的定位，不靠条数差）；
 * - 持久化到 settings（跨启动有效）；键名与既有会话级设置键同一套形状
 *   （`memory-extraction-watermark-<sessionId>`），**同一个键**也接受旧的纯数字；
 * - 坏游标（坏 JSON / 形状不符）⇒ **回退全量**并 warn（不静默当"没有游标"，
 *   也不抛错打断提取）。
 *
 * ## 为什么"坏游标回退全量"而不是 fail-closed 跳过
 *
 * 游标的失败方向决定用户看到什么：回退全量最坏是重复提取一次（多花一次模型调用、
 * 写入侧还有查重挡着）；跳过则是"记忆系统不工作了"，而且**没有信号**。宁可多跑一次。
 */

import { getSetting, setSetting } from "../storage/settings";

/** 会话级游标键前缀（与 `memory-enabled-<sessionId>` 同一套键形状） */
const MEMORY_EXTRACTION_WATERMARK_KEY_PREFIX = "memory-extraction-watermark-";

/** 游标键（导出给判据/诊断；生产读点只走本模块的 API） */
export function memoryExtractionWatermarkKey(sessionId: string): string {
  return `${MEMORY_EXTRACTION_WATERMARK_KEY_PREFIX}${sessionId}`;
}

export interface MemoryExtractionCursor {
  /** 最后一条**已成功提取**的消息 id（新消息 = 时间线里它之后的那些） */
  messageId: string;
  /** 这条消息所属的最新 epoch（`metadata.contextEpoch.epochId`）；没有换段/压缩时缺省 */
  epochId?: string;
  /** 该 epoch 的段号（`segmentSeq`）；缺省表示没有段信息 */
  segmentSeq?: number;
  /** 写入时的消息总数（诊断用；也是旧数字游标的兼容字段） */
  messageCount?: number;
  /** 写入时间（`Date.now()`；诊断用） */
  at?: number;
}

/** 读游标的结果：四种状态**互斥**，调用方必须各走各的路 */
export type MemoryExtractionCursorRead =
  | { kind: "none" }
  | { kind: "cursor"; cursor: MemoryExtractionCursor }
  | { kind: "legacy"; count: number }
  | { kind: "bad"; raw: string; reason: string };

/** 坏游标只 warn 一次（按"会话 + 原值"去重，避免每回合刷屏） */
const warnedBadCursor = new Set<string>();
/** "游标 id 不在当前时间线"也只 warn 一次（会话 + id） */
const warnedMissingCursorId = new Set<string>();

function warn(message: string): void {
  try {
    console.warn(`[memory-extraction-cursor] ${message}`);
  } catch {
    /* 日志通道异常不影响提取 */
  }
}

function asFiniteNonNegative(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * 读某会话的游标。
 *
 * 兼容三种形态：
 * 1. 键不存在 ⇒ `none`（首次提取 / 旧版本从没写过）；
 * 2. 纯数字（`"12"` 或 JSON 数字 `12`，以及 `{ "count": 12 }`）⇒ `legacy`（旧口径：已提取条数）；
 * 3. 带 `messageId` 的对象 ⇒ `cursor`。
 *
 * 其余一律 `bad`：**保留原值不覆盖**，调用方回退全量并 warn。
 */
export function readMemoryExtractionCursor(sessionId: string): MemoryExtractionCursorRead {
  if (!sessionId) return { kind: "none" };
  let raw: string | null = null;
  try {
    raw = getSetting(memoryExtractionWatermarkKey(sessionId));
  } catch (e) {
    /* 设置读不出来 ≠ 没有游标：退回全量，并如实告警 */
    warn(`会话 ${sessionId} 的提取游标读不出来（按全量处理）：${e instanceof Error ? e.message : String(e)}`);
    return { kind: "none" };
  }
  if (raw === null || raw === undefined) return { kind: "none" };
  const text = String(raw).trim();
  if (text.length === 0) return { kind: "none" };

  const bad = (reason: string): MemoryExtractionCursorRead => {
    const key = `${sessionId}\u0000${text}`;
    if (!warnedBadCursor.has(key)) {
      warnedBadCursor.add(key);
      warn(
        `会话 ${sessionId} 的提取游标格式不符（${reason}）⇒ 回退全量提取；` +
          `原值保留在 settings 键 ${memoryExtractionWatermarkKey(sessionId)}，下一次成功提取会覆盖它`,
      );
    }
    return { kind: "bad", raw: text, reason };
  };

  /* 兼容旧数字：直接写 "12" 的形态 */
  if (/^\d+$/.test(text)) {
    return { kind: "legacy", count: Number.parseInt(text, 10) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("不是合法 JSON");
  }

  if (typeof parsed === "number") {
    const count = asFiniteNonNegative(parsed);
    return count === undefined ? bad("数字不是非负整数") : { kind: "legacy", count };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return bad("既不是数字也不是对象");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.messageId === "string" && obj.messageId.trim().length > 0) {
    const cursor: MemoryExtractionCursor = { messageId: obj.messageId.trim() };
    if (typeof obj.epochId === "string" && obj.epochId.trim().length > 0) cursor.epochId = obj.epochId.trim();
    const seq = asFiniteNonNegative(obj.segmentSeq);
    if (seq !== undefined && seq >= 1) cursor.segmentSeq = seq;
    const count = asFiniteNonNegative(obj.messageCount);
    if (count !== undefined) cursor.messageCount = count;
    const at = asFiniteNonNegative(obj.at);
    if (at !== undefined) cursor.at = at;
    return { kind: "cursor", cursor };
  }
  const count = asFiniteNonNegative(obj.count);
  if (count !== undefined) return { kind: "legacy", count };
  return bad("缺少 messageId");
}

/**
 * 写游标（成功解析模型响应之后才写）。
 *
 * 写失败**不影响**本次提取（条目已经写入）；只如实告警 —— 下次会再提取一遍，
 * 由写入侧查重挡住重复，代价是一次模型调用，不是数据错误。
 */
export function writeMemoryExtractionCursor(sessionId: string, cursor: MemoryExtractionCursor): boolean {
  if (!sessionId || !cursor || typeof cursor.messageId !== "string" || cursor.messageId.length === 0) return false;
  const payload: MemoryExtractionCursor = {
    messageId: cursor.messageId,
    ...(cursor.epochId ? { epochId: cursor.epochId } : {}),
    ...(cursor.segmentSeq !== undefined ? { segmentSeq: cursor.segmentSeq } : {}),
    ...(cursor.messageCount !== undefined ? { messageCount: cursor.messageCount } : {}),
    ...(cursor.at !== undefined ? { at: cursor.at } : {}),
  };
  try {
    setSetting(memoryExtractionWatermarkKey(sessionId), JSON.stringify(payload));
    return true;
  } catch (e) {
    warn(
      `会话 ${sessionId} 的提取游标写入失败（下次会重复提取一次，写入侧查重会挡住重复）：` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * 从"实际发出去的那批消息"里算新游标：取**时间顺序上最后一条**的消息 id，
 * 以及它之前最近一个 epoch marker 的 `epochId` / `segmentSeq`。
 *
 * 为什么取整份会话里的最后一个 marker（而不是只看被选中的消息）：epoch 是会话级事实，
 * 被选区不一定包含 marker；游标里的 epoch 只是给下一次判断"是不是换段了"留证据。
 *
 * @param selected 本次真的发给模型的消息（时间顺序）
 * @param all 本次读取的完整消息列表（用来找最新的 epoch marker）
 * @param messageCount 本次完整列表的条数（诊断 / 旧口径兼容）
 * @param at 写入时间
 */
export function cursorFromExtraction(
  selected: readonly Record<string, unknown>[],
  all: readonly Record<string, unknown>[],
  messageCount: number,
  at: number,
): MemoryExtractionCursor | null {
  const last = selected.length > 0 ? selected[selected.length - 1] : all.length > 0 ? all[all.length - 1] : null;
  const messageId = last && typeof last.id === "string" ? last.id : "";
  if (!messageId) return null;

  const cursor: MemoryExtractionCursor = {
    messageId,
    messageCount: Math.max(0, Math.floor(messageCount)),
    at: Math.max(0, Math.floor(at)),
  };
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const metadata = all[i]?.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    const epoch = (metadata as Record<string, unknown>).contextEpoch;
    if (!epoch || typeof epoch !== "object") continue;
    const e = epoch as Record<string, unknown>;
    const epochId = typeof e.epochId === "string" && e.epochId ? e.epochId : typeof all[i].id === "string" ? String(all[i].id) : "";
    if (!epochId) continue;
    cursor.epochId = epochId;
    const seq = asFiniteNonNegative(e.segmentSeq);
    if (seq !== undefined && seq >= 1) cursor.segmentSeq = seq;
    break;
  }
  return cursor;
}

/** `messagesSinceCursor` 的结果（`mode` 说明这次水位是怎么用的） */
export interface CursorSlice {
  messages: Array<Record<string, unknown>>;
  mode: "cursor" | "legacy" | "none" | "bad";
  /** 游标 id 是否真的在当前列表里找到（`false` ⇒ 按全量处理） */
  matched: boolean;
}

/**
 * 按游标切出"这次需要检查的新消息"。
 *
 * - `cursor`：找到 id ⇒ 取它之后的那些；**找不到**（被裁剪 / 删除 / 换了会话）⇒
 *   按全量处理并 warn（游标不能成为"永远提取不到"的锁）；
 * - `legacy`：按旧口径取 `slice(count)`（`count ≥ 长度` ⇒ 没有新消息，与旧行为一致）；
 * - `none` / `bad`：全量。
 */
export function messagesSinceCursor(
  messages: readonly Record<string, unknown>[],
  read: MemoryExtractionCursorRead,
  sessionId = "",
): CursorSlice {
  if (read.kind === "legacy") {
    const start = Math.min(Math.max(0, read.count), messages.length);
    return { messages: messages.slice(start), mode: "legacy", matched: read.count <= messages.length };
  }
  if (read.kind === "cursor") {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.id === read.cursor.messageId) {
        return { messages: messages.slice(i + 1), mode: "cursor", matched: true };
      }
    }
    const key = `${sessionId}\u0000${read.cursor.messageId}`;
    if (!warnedMissingCursorId.has(key)) {
      warnedMissingCursorId.add(key);
      warn(
        `会话 ${sessionId} 的提取游标 id「${read.cursor.messageId}」不在当前消息列表里` +
          `（可能被裁剪 / 删除）⇒ 按全量处理，不把提取锁死`,
      );
    }
    return { messages: messages.slice(), mode: "cursor", matched: false };
  }
  return { messages: messages.slice(), mode: read.kind, matched: false };
}
