/**
 * Context Manifest（C03/C04）：**每次请求**的上下文快照 + 两次请求的差异。
 *
 * ## 解决什么
 *
 * 「模型这一轮到底看到了什么」以前只能靠猜：`buildMessages(sessionId)` 返回一份数组，
 * 发完就没了。出了「模型忘了某件事 / 答得和上一轮矛盾」时，无法回答：
 * 那条消息在不在？是被 cutoff 掉了，还是预算不够没进去？
 *
 * 这个模块记录**可复查的最小集合**：
 * - `messageIds`：这次请求实际带上的消息 id（按顺序）；
 * - `sources`：system / chat / tool / memory 各自的字符占比；
 * - `budgetTokens` / `estimatedTokens`：预算与实际估算；
 * - epoch 信息（segmentSeq / cutoff）：为什么只看到这些。
 *
 * 不记录正文（正文在 JSONL 与 messages 表里，按 id 可还原）—— 记录正文会让事件表
 * 体积按"每轮 × 全文"增长，而 id 已经能还原"集合"这个事实。
 *
 * ## 边界（诚实）
 *
 * - 只记录**发出去的那一份**（`messagesForIteration`），不是"模型内部看到的"；
 * - `estimatedTokens` 是本地估算（与 token tracker 同一把尺），不是服务端计数；
 * - 还原依赖消息仍在库里（删除/裁剪后按 id 找不到，会如实计入 `missingIds`）。
 */
import { sha256Hex } from "../remote/aa-protocol-ids";
import { getSettingJSON, removeSetting, setSettingJSON } from "../storage/settings";

/** 只依赖结构的最小子集（不 import llm 类型，避免 context → llm 的循环依赖） */
type LoopMessageLike = { role?: string; content?: unknown };

/**
 * Manifest 的 **schema 版本**（C04）。
 *
 * 为什么要显式版本：这个对象会落到 settings 键里跨进程读回，而结构会演进。
 * 没有版本时，只能靠「字段在不在」猜——猜错的方向是**旧数据被当成新数据**，
 * 那种错误在复盘时会给出与事实相反的结论。读侧（`loadManifests`）只认这个版本，
 * 其它一律按坏数据返回空数组。
 */
const CONTEXT_MANIFEST_VERSION = 1 as const;

interface ContextManifestSources {
  system: number;
  chat: number;
  tool: number;
  memory: number;
}

/**
 * **最小工作集**的请求侧数字（C03）。
 *
 * 为什么只记数字、不记 `indexLines` 的正文：清单的存储口径是「不记正文」
 * （见文件头：正文在 JSONL / messages 里按 id 可还原，记正文会让清单按
 * 「每轮 × 全文」增长）。工作集要回答的问题是**定量**的：
 * 「这一轮预算是多少、选中几条、移出几条、有没有产生索引行」——
 * 四条数字足够复查；具体被移出的是哪些 id 由 `messageIds` 与上一份的
 * `evictedIds` 差异给出，索引文本本身**不是**持久化事实。
 */
export interface ContextManifestWorkingSet {
  /** 这一轮工作集的可用预算（tokens，已扣掉输出预留与系统提示词） */
  budgetTokens: number;
  /** 选中条数（进入请求的消息条数，不含后面追加的索引消息） */
  selected: number;
  /** 移出条数（进了 Pager 索引的那一段） */
  evicted: number;
  /** Pager 索引行数（含溢出注记那一行；0 = 全放得下、没有索引） */
  indexLines: number;
}

export interface ContextManifest {
  /** schema 版本（写入记录；读侧校验，见 `loadManifests`） */
  version: 1;
  sessionId: string;
  at: number;
  segmentSeq: number;
  epochId?: string;
  cutoffMessageId?: string;
  pressure: number;
  budgetTokens: number;
  estimatedTokens: number;
  sources: ContextManifestSources;
  messageIds: string[];
  /**
   * **稳定前缀摘要**（C04）：全部 system 内容 + 第一条 user 内容（拼接后取 sha256）。
   *
   * 定义与理由见 `computePrefixHash`。拿不到（既没有 system 也没有 user）时是空串。
   */
  prefixHash: string;
  /**
   * 相对**上一份同会话 manifest** 被移出视图的 id（C04）。
   *
   * 首份（没有上一份）恒为空数组；由 `AgenticLoop.recordContextManifest` 用
   * `diffManifests` 计算后写入。它回答的是「这一轮为什么少看到了东西」——
   * 只记 id 不记正文，正文仍可按 id 从 JSONL/消息表还原。
   */
  evictedIds: string[];
  /**
   * **最小工作集**（C03）：这一轮工作集的预算 / 选中 / 移出 / 索引行数。
   *
   * `undefined` = **旧记录或未触发工作集**时没有该字段（这一轮请求原样发出；该字段是 C03 才有的）。
   * 读侧两种都接受；有该字段则说明工作集真的算过，四个数字见 `ContextManifestWorkingSet`。
   */
  workingSet?: ContextManifestWorkingSet;
}

export interface ManifestInput {
  sessionId: string;
  at?: number;
  segmentSeq?: number;
  epochId?: string;
  cutoffMessageId?: string;
  pressure?: number;
  budgetTokens?: number;
  estimatedTokens?: number;
  prefixHash?: string;
  evictedIds?: string[];
  /** C03：工作集数字（不传 = 这一轮没走工作集） */
  workingSet?: ContextManifestWorkingSet;
  messages: ReadonlyArray<LoopMessageLike & { id?: string }>;
}

function roleOf(message: { role?: string; content?: unknown }): string {
  return String(message.role ?? "");
}

/** 粗略按字符归属四个来源（只看角色与内容形状，不解析工具协议） */
function sourceOf(message: { role?: string; content?: unknown }): keyof ContextManifestSources {
  const role = roleOf(message);
  if (role === "system") return "system";
  if (role === "tool") return "tool";
  const content = typeof message.content === "string" ? message.content : "";
  if (role === "user" && /^## (记忆|Memory)|^<memory/i.test(content)) return "memory";
  return "chat";
}

function textLength(message: { content?: unknown }): number {
  return textOf(message).length;
}

/** 取一条消息的**纯文本**（字符串正文或文本块拼接；其它形状按空串） */
function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: unknown) => {
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

/**
 * **稳定前缀摘要**（C04）：全部 system 内容 + 第一条 user 内容，拼接后取 sha256。
 *
 * ## 为什么是这两个
 *
 * provider 的前缀缓存命中的是「每条请求开头那段稳定字节」。这段字节由
 * 系统提示词与**本轮之前的第一条用户消息**构成——后面无论追加多少轮，
 * 前缀都不该变。把它的摘要记进 manifest，就能在复盘时回答：
 * 「这一轮的前缀还和上一轮一样吗？如果不一样，是哪里变了？」
 *
 * ## 为什么允许调用方额外传 `systemPrompt`
 *
 * `buildMessages()` 返回的数组里**没有 system 消息**（它在 `callLLM` 里才被拼到最前，
 * 见 `appendVolatileAppendix`）。所以调用方把本轮基础 system 提示词传进来，
 * 否则这里只剩「第一条 user」——那会漏掉真正最大的那段稳定字节。
 * 传入的 system 文本视为「消息序列里的 system 内容」，与数组里真正的 system 消息
 * 一起按顺序拼接（数组里的 system 在前，调用方基础提示词在最前）。
 *
 * ## 拿不到时
 *
 * 既没有 system 文本、也没有 user 消息 ⇒ 返回空串（不伪造一个 hash）。
 * 空串在 manifest 里是**明确的「未采集」**，不是「前缀为空」。
 */
export function computePrefixHash(
  messages: ReadonlyArray<LoopMessageLike>,
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.length > 0) parts.push(base);
  for (const message of messages) {
    if (roleOf(message) === "system") parts.push(textOf(message));
  }
  const firstUser = messages.find((message) => roleOf(message) === "user");
  if (firstUser) parts.push(textOf(firstUser));
  if (parts.length === 0) return "";
  return sha256Hex(parts.join("\n\n"));
}

export function buildContextManifest(input: ManifestInput): ContextManifest {
  const sources: ContextManifestSources = { system: 0, chat: 0, tool: 0, memory: 0 };
  const messageIds: string[] = [];
  for (const message of input.messages) {
    sources[sourceOf(message)] += textLength(message);
    if (typeof message.id === "string" && message.id.length > 0) messageIds.push(message.id);
  }
  return {
    version: CONTEXT_MANIFEST_VERSION,
    sessionId: input.sessionId,
    at: Number.isFinite(input.at) ? Number(input.at) : Date.now(),
    segmentSeq: Math.max(1, Math.floor(Number(input.segmentSeq) || 1)),
    ...(input.epochId ? { epochId: input.epochId } : {}),
    ...(input.cutoffMessageId ? { cutoffMessageId: input.cutoffMessageId } : {}),
    pressure: Number.isFinite(input.pressure) ? Number(input.pressure) : 0,
    budgetTokens: Math.max(0, Math.floor(Number(input.budgetTokens) || 0)),
    estimatedTokens: Math.max(0, Math.floor(Number(input.estimatedTokens) || 0)),
    sources,
    messageIds,
    prefixHash: typeof input.prefixHash === "string" ? input.prefixHash : "",
    evictedIds: Array.isArray(input.evictedIds)
      ? input.evictedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
    ...(() => {
      const workingSet = normalizeWorkingSet(input.workingSet);
      return workingSet ? { workingSet } : {};
    })(),
  };
}

/**
 * 工作集数字的归一化（C03）。
 *
 * 语义：**`undefined` / `null` 一律当「没走工作集」** —— 不写这个字段，
 * 于是旧 manifest 与「未触发工作集的请求」的 manifest 形状一致（判据 WS-6 要求旧数据能读）。
 * 传了对象就逐字段收敛成非负有限整数（坏值当 0），避免把 NaN 写进 settings 之后
 * `loadManifests` 的校验与界面显示同时失真。
 */
function normalizeWorkingSet(value: unknown): ContextManifestWorkingSet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const num = (field: keyof ContextManifestWorkingSet): number => {
    const n = Number(raw[field]);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  return {
    budgetTokens: num("budgetTokens"),
    selected: num("selected"),
    evicted: num("evicted"),
    indexLines: num("indexLines"),
  };
}

export interface ManifestDiff {
  addedIds: string[];
  removedIds: string[];
  segmentChanged: boolean;
  cutoffChanged: boolean;
  sourcesDelta: ContextManifestSources;
  tokenDelta: number;
}

/** 两次请求的差异（回答"这一轮为什么不一样"） */
export function diffManifests(before: ContextManifest, after: ContextManifest): ManifestDiff {
  const beforeIds = new Set(before.messageIds);
  const afterIds = new Set(after.messageIds);
  return {
    addedIds: after.messageIds.filter((id) => !beforeIds.has(id)),
    removedIds: before.messageIds.filter((id) => !afterIds.has(id)),
    segmentChanged: before.segmentSeq !== after.segmentSeq,
    cutoffChanged: before.cutoffMessageId !== after.cutoffMessageId,
    sourcesDelta: {
      system: after.sources.system - before.sources.system,
      chat: after.sources.chat - before.sources.chat,
      tool: after.sources.tool - before.sources.tool,
      memory: after.sources.memory - before.sources.memory,
    },
    tokenDelta: after.estimatedTokens - before.estimatedTokens,
  };
}

export interface ManifestReplay {
  /** 按 manifest 顺序还原出来的消息（只含仍存在的） */
  messages: Array<{ id: string; role?: string; content?: unknown }>;
  missingIds: string[];
}

/**
 * 用当前库还原 manifest 那一刻的**消息集合**（按 id + 顺序）。
 *
 * 读整个时间线是数据层的事：调用方传 `lookup`（生产用 `listTimelineMessages` 的调用点）。
 */
export function replayManifest(
  manifest: ContextManifest,
  lookup: (id: string) => { id: string; role?: string; content?: unknown } | null,
): ManifestReplay {
  const messages: ManifestReplay["messages"] = [];
  const missingIds: string[] = [];
  for (const id of manifest.messageIds) {
    const found = lookup(id);
    if (found) messages.push({ id: found.id, role: found.role, content: found.content });
    else missingIds.push(id);
  }
  return { messages, missingIds };
}

// ========== 请求记录（C04）：内存环形 + 回合末落库 ==========
//
// 为什么**不写事件**：事件总数会进模型可见的时间上下文（`[Context: …, M total events]`），
// 每请求写一条事件 = 每轮改变前缀 ⇒ 直接打爆 provider 前缀缓存（本仓 D5 判据实测）。
// 所以清单走独立的 settings 键（不参与事件计数），内存里保留最近若干条供当轮读取。

const RING_MAX = 50;
const memoryRing = new Map<string, ContextManifest[]>();

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** settings 键（独立于事件表：见上面「为什么不写事件」） */
function manifestKey(sessionId: string): string {
  return `codem-context-manifests:${sessionId}`;
}

export function recordManifest(manifest: ContextManifest): void {
  const list = memoryRing.get(manifest.sessionId) ?? [];
  list.push(manifest);
  while (list.length > RING_MAX) list.shift();
  memoryRing.set(manifest.sessionId, list);
  /* 防抖落库：同一段落里多次 buildMessages 只写一次 settings（不写事件，见上） */
  const prev = flushTimers.get(manifest.sessionId);
  if (prev) clearTimeout(prev);
  flushTimers.set(manifest.sessionId, setTimeout(() => {
    flushTimers.delete(manifest.sessionId);
    void flushManifests(manifest.sessionId);
  }, 400));
}

/** @public 供命令/判据查询"这一轮请求带了哪些消息"（无 UI 入口，属诊断 API） */
export function listManifests(sessionId: string): readonly ContextManifest[] {
  return memoryRing.get(sessionId) ?? [];
}

/**
 * 校验持久化里的一条记录是否是**本版本**的完整 manifest。
 *
 * 坏数据的处理是「整批返回空数组」而不是「能用的先用」：一份被截断/串版本的历史
 * 会在复盘时给出不完整的淘汰集合，那比「没有数据」更危险（会得出相反结论）。
 */
function isManifestRecord(value: unknown): value is ContextManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (m.version !== CONTEXT_MANIFEST_VERSION) return false;
  if (typeof m.sessionId !== "string" || typeof m.at !== "number" || typeof m.segmentSeq !== "number") return false;
  if (typeof m.pressure !== "number" || typeof m.budgetTokens !== "number" || typeof m.estimatedTokens !== "number") {
    return false;
  }
  if (!Array.isArray(m.messageIds) || !m.messageIds.every((id) => typeof id === "string")) return false;
  if (!Array.isArray(m.evictedIds) || !m.evictedIds.every((id) => typeof id === "string")) return false;
  if (typeof m.prefixHash !== "string") return false;
  /**
   * C03：`workingSet` 是**后加**的字段 —— 缺它（旧数据 / 没走工作集的请求）按 `undefined` 接受；
   * 但**一旦存在**就必须是四条非负有限数字，否则按坏数据整批拒绝
   * （与本函数其它字段同一条纪律：宁可没有数据，也不给出一份会导出相反结论的半成品）。
   */
  if (m.workingSet !== undefined) {
    if (!m.workingSet || typeof m.workingSet !== "object") return false;
    const ws = m.workingSet as Record<string, unknown>;
    for (const key of ["budgetTokens", "selected", "evicted", "indexLines"] as const) {
      const value = ws[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
    }
  }
  const sources = m.sources as Record<string, unknown> | null;
  if (!sources || typeof sources !== "object") return false;
  for (const key of ["system", "chat", "tool", "memory"] as const) {
    if (typeof sources[key] !== "number") return false;
  }
  return true;
}

/**
 * 读回某会话的请求清单（C04）。
 *
 * 顺序：**先内存环，空则回读 settings**。内存环是进程内的热副本；跨进程/重启后
 * 只能靠 settings。坏 JSON、版本不符、结构不全 ⇒ 一律返回 `[]`（不猜、不部分恢复）。
 *
 * 返回的是**副本**：调用方改数组不会污染内存环（清单是诊断事实，不是可编辑状态）。
 */
export function loadManifests(sessionId: string): ContextManifest[] {
  const ring = memoryRing.get(sessionId);
  if (ring && ring.length > 0) return [...ring];
  try {
    const raw = getSettingJSON<unknown>(manifestKey(sessionId), []);
    if (!Array.isArray(raw) || raw.length === 0) return [];
    if (!raw.every(isManifestRecord)) return [];
    return raw as ContextManifest[];
  } catch (e) {
    console.warn("[context-manifest] 清单回读失败（按空处理）:", e);
    return [];
  }
}

/** 回合末把最近清单落到 settings（跨进程可查），失败不影响收尾 */
/** @public 回合末落库；由 recordManifest 的防抖定时器调用 */
export async function flushManifests(sessionId: string): Promise<void> {
  const list = memoryRing.get(sessionId);
  if (!list || list.length === 0) return;
  try {
    setSettingJSON(manifestKey(sessionId), list.slice(-20));
  } catch (e) {
    console.warn("[context-manifest] 清单落库失败（已忽略）:", e);
  }
}

/**
 * **会话删除时清掉清单**（C04 的清理判据）。
 *
 * 为什么必须在删除路径显式调用：这份数据在独立的 settings 键里，既不在 `sessions`
 * 的外键级联里，也不在消息表里——不清理就是「会话已删、清单还在」的孤儿数据，
 * 下次同 id 会话（分叉/恢复）会读到上一份的淘汰集合。
 *
 * 同时清内存环与防抖定时器：否则删除后 `loadManifests` 仍会从内存环返回旧清单，
 * 而待触发的定时器还会把旧清单重新写回 settings。
 */
export function forgetManifests(sessionId: string): void {
  memoryRing.delete(sessionId);
  const timer = flushTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(sessionId);
  }
  try {
    removeSetting(manifestKey(sessionId));
  } catch (e) {
    console.warn("[context-manifest] 清单清理失败（已忽略，不影响会话删除）:", e);
  }
}