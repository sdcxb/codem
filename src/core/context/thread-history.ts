/**
 * Thread History（P0-2 / D1 / D11）：把「一个会话的完整时间线」切成**段**，并提供
 * 检索 / 按 id 回读的纯函数。
 *
 * ## 为什么是纯函数（不做 IO）
 *
 * 数据源只有两个：`listTimelineMessages`（含压缩前原文 / 被裁剪行）与每条 marker 的
 * `metadata.contextEpoch`。把它们当参数传进来，判据可以直接喂构造数据；
 * 工具层只负责取数、格式化、报错。
 *
 * ## 分段规则（与 D1 的 Session=Thread / Epoch=Segment 一致）
 *
 * - 一条消息的段号 = **它前面出现过几次 `kind="switch"`** + 1；
 * - `kind="compact"` **不换段**（段内压缩，旧消息仍在同一段里）；
 * - 旧数据没有 `kind` ⇒ 按 compact（不换段）—— 于是历史会话只有 1 段，
 *   与「第一版所有历史都算第 1 段」一致。
 *
 * ## 为什么检索不用 FTS
 *
 * FTS 索引里**没有** `hidden`/裁剪行（它由 `messages` 表重建），而 thread history
 * 要的正是"压缩前说过什么"。所以这里对时间线做**有界**扫描：
 * 每条只做小写化 + 子串判断，命中才取片段；上限由调用方给（默认 20 条）。
 * 代价是 O(消息数)，但这是"用户主动问一件旧事"的路径，不是每回合都跑。
 *
 * ## 检索面 / 回读面（独立复核的高优先级缺口）
 *
 * 编程场景的历史**不在正文里**：命令输出、报错、diff 在 `toolCalls[].result`，
 * 请求在 `toolCalls[].args`，超大结果还会被 spill 成「预览 + locator」。所以：
 *
 * - 检索面 = 正文 + 工具结果 + 工具请求侧（名字/参数）+ 机器注入可读正文；
 *   命中要标出是哪一段命中的（`matchField`）以及工具名；
 * - 回读面 = 按 id（消息 id 或 epoch id）/ 按段号（`segmentSeq`）取原文，
 *   工具调用的渲染与 spill 全文读取在工具层（这里不做 IO）；
 * - 上限一律**如实披露**：`truncatedAfter` / 段内未返回条数不许静默吞掉。
 */

/**
 * 时间线消息的形状（**只声明本模块真正读的字段**）。
 *
 * ## 为什么 `toolCalls` 必须在这里出现（独立复核的高优先级缺口）
 *
 * 真实存储形态里，工具调用（命令输出、错误、diff、spill 提示）**不在 `content` 里** ——
 * 它们在 `message.toolCalls[].result`（请求侧在 `toolCalls[].args`）。旧版本的检索与回读
 * 只看 `content`，于是「上一段跑过的构建命令为什么失败」这类**编程场景最需要的历史**
 * 对模型等于不存在（25 号文 §8.2「旧工具结果不可检索」）。
 *
 * 两种形状都认（与 `context/working-set.ts` 同一把尺）：
 * - 存储形状：`{ tool, args, result }`（`ToolCall`，见 `src/store.ts`）；
 * - 协议形状：`{ name, arguments }` / `{ function: { name } }`（`tool_calls` 原始行）。
 */
export interface ThreadHistoryMessageLike {
  id: string;
  role?: string;
  content?: unknown;
  timestamp?: number;
  metadata?: Record<string, unknown> | null;
  toolCalls?: ReadonlyArray<{
    id?: unknown;
    tool?: unknown;
    name?: unknown;
    function?: { name?: unknown } | null;
    args?: unknown;
    arguments?: unknown;
    result?: unknown;
    status?: unknown;
  }> | null;
}

/** 本模块要求读侧给出的 epoch 形状（`readContextEpochOf` 的返回值即可满足） */
type ThreadEpochLike = {
  epochId: string;
  kind: "compact" | "switch";
  segmentSeq: number;
  cutoffMessageId: string;
  createdAt: number;
  removedCount: number;
  keptCount: number;
};

/** 检索 / 回读只需要 epoch 的这两项（判据夹具可以喂更瘦的对象） */
type MinimalEpoch = { kind: "compact" | "switch"; epochId?: string };

export interface ThreadSegment {
  /** 第几段（从 1 开始；旧数据恒为 1） */
  segmentSeq: number;
  /** 本段内的 epoch（compact 与开口的 switch 都算） */
  epochs: Array<{
    epochId: string;
    kind: "compact" | "switch";
    segmentSeq: number;
    cutoffMessageId: string;
    createdAt: number;
    removedCount: number;
    keptCount: number;
  }>;
  /** 本段在时间线里的起止下标（含端点；空段 start > end） */
  startIndex: number;
  endIndex: number;
  /** 本段消息条数（含 marker 本身） */
  messageCount: number;
  /**
   * 本段里**带结果正文**的工具调用条数。
   *
   * 为什么单独给一个读数（而不是让调用方自己扫）：模型看到「段 1：4 条消息」时无法判断
   * 「为什么这里只有 4 条、我的构建到底跑过没有」—— 工具结果条数就是那条线索的读数。
   * 只数**有正文**的结果（`pending` / 空结果不算），与「能不能取回原文」同义。
   */
  toolResultCount: number;
}

export interface ThreadHistoryHit {
  id: string;
  segmentSeq: number;
  role: string;
  timestamp: number;
  /** 命中位置的片段（有界；从**命中处**截取，不是正文开头） */
  snippet: string;
  /**
   * 命中的是消息的哪一段：
   * - `content`：正文（含机器注入的 handoff / 压缩标记 / 提醒 —— 它们的正文就写在 content 里）；
   * - `tool_result`：工具结果正文（旧命令、报错、diff、spill 提示都在这里）；
   * - `tool_args`：工具请求侧（工具名 + 参数）。
   */
  matchField: "content" | "tool_result" | "tool_args";
  /** 命中的工具名（`matchField` 是 tool_* 时有值） */
  toolName?: string;
  /** 命中的工具调用 id（有就带上，便于按调用定位） */
  toolCallId?: string;
}

export interface ThreadHistoryWindow {
  /** 目标消息在时间线里的下标 */
  index: number;
  segmentSeq: number;
  messages: ThreadHistoryMessageLike[];
  /** 目标窗口是否被截断（before/after 超过可用范围时如实置位） */
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}

const SNIPPET_RADIUS = 80;
const SNIPPET_MAX = 240;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  /* 多模态/块状正文（`[{type:"text",text}]`）按文本块拼 —— 与 working-set 同一口径 */
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

/**
 * 机器注入正文**可能**落的位置（当前实现把 handoff / 压缩标记 / 提醒都写进 `content`，
 * 所以它们本来就在检索范围里；这里兜住"别处的注入形态把正文放进 metadata"）。
 *
 * 只认这几个**语义就是可读正文**的键 —— 刻意不扫任意 metadata：那样 `cutoffMessageId`
 * 之类的标识符也会变成命中（搜 `m2` 命中一条 marker），把检索读数弄脏。
 */
const MACHINE_TEXT_METADATA_KEYS = ["injectedText", "injectedBody", "handoffBody", "notesDigest"] as const;

/** 工具名（存储形状 `tool` / 协议形状 `name` / `function.name`） */
function toolNameOf(call: NonNullable<ThreadHistoryMessageLike["toolCalls"]>[number]): string {
  const name = call?.tool ?? call?.function?.name ?? call?.name;
  return typeof name === "string" ? name : "";
}

/** 工具调用 id（可能没有：老数据/夹具） */
function toolCallIdOf(call: NonNullable<ThreadHistoryMessageLike["toolCalls"]>[number]): string | undefined {
  return typeof call?.id === "string" && call.id ? call.id : undefined;
}

/** 参数的可检索文本（对象按 JSON；字符串原样；没有就空串） */
function toolArgsTextOf(call: NonNullable<ThreadHistoryMessageLike["toolCalls"]>[number]): string {
  const args = call?.arguments ?? call?.args;
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

/** 结果的可读文本（字符串原样；非字符串结构按 JSON —— 否则"看不到有什么"） */
function toolResultTextOf(call: NonNullable<ThreadHistoryMessageLike["toolCalls"]>[number]): string {
  const result = call?.result;
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/** 一条消息里"能搜的段"（顺序 = 命中优先级：正文 → 工具结果 → 工具请求侧） */
interface SearchField {
  field: ThreadHistoryHit["matchField"];
  text: string;
  toolName?: string;
  toolCallId?: string;
}

function searchFieldsOf(message: ThreadHistoryMessageLike): SearchField[] {
  const fields: SearchField[] = [];
  const content = textOf(message.content);
  if (content) fields.push({ field: "content", text: content });

  const metadata = message.metadata;
  if (metadata && typeof metadata === "object") {
    for (const key of MACHINE_TEXT_METADATA_KEYS) {
      const value = (metadata as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) fields.push({ field: "content", text: value });
    }
  }

  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  /*
   * 先结果、后请求侧：同一个调用的参数与结果都含关键词时，"结果"是用户真正想找的那一段
   * （命令输出/报错），把参数排在后面可以避免命中被"我只是传了这个参数"占掉。
   */
  for (const call of calls) {
    const text = toolResultTextOf(call);
    if (!text) continue;
    const toolName = toolNameOf(call);
    const toolCallId = toolCallIdOf(call);
    fields.push({ field: "tool_result", text, ...(toolName ? { toolName } : {}), ...(toolCallId ? { toolCallId } : {}) });
  }
  for (const call of calls) {
    const args = toolArgsTextOf(call);
    const toolName = toolNameOf(call);
    if (!args && !toolName) continue;
    const text = [toolName, args].filter(Boolean).join(" ");
    const toolCallId = toolCallIdOf(call);
    fields.push({ field: "tool_args", text, ...(toolName ? { toolName } : {}), ...(toolCallId ? { toolCallId } : {}) });
  }
  return fields;
}

/** 本段计数用：这条消息里有几条"有正文"的工具结果 */
function toolResultCountOf(message: ThreadHistoryMessageLike): number {
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  let count = 0;
  for (const call of calls) if (toolResultTextOf(call).trim()) count += 1;
  return count;
}

/**
 * 把时间线切成段。
 *
 * 边界判定只看 `kind === "switch"` 的 marker：它**自己**是新段的第一条（handoff 正文
 * 就写在这条消息里），它之前的消息属于上一段。
 */
export function segmentsOf(
  messages: readonly ThreadHistoryMessageLike[],
  readEpoch: (m: ThreadHistoryMessageLike) => ThreadEpochLike | null,
): ThreadSegment[] {
  const segments: ThreadSegment[] = [];
  let current: ThreadSegment = {
    segmentSeq: 1,
    epochs: [],
    startIndex: 0,
    endIndex: -1,
    messageCount: 0,
    toolResultCount: 0,
  };

  for (let i = 0; i < messages.length; i += 1) {
    const epoch = readEpoch(messages[i]);
    if (epoch?.kind === "switch") {
      /* 关闭上一段（它至少包含段首到 i-1） */
      current.endIndex = i - 1;
      current.messageCount = Math.max(0, i - current.startIndex);
      segments.push(current);
      current = {
        segmentSeq: current.segmentSeq + 1,
        epochs: [{ ...epoch }],
        startIndex: i,
        endIndex: i,
        messageCount: 0,
        toolResultCount: 0,
      };
      current.toolResultCount += toolResultCountOf(messages[i]);
      continue;
    }
    if (epoch) current.epochs.push({ ...epoch });
    current.endIndex = i;
    current.toolResultCount += toolResultCountOf(messages[i]);
  }
  current.messageCount = Math.max(0, messages.length - current.startIndex);
  segments.push(current);
  return segments;
}

/** 每条消息属于第几段（下标 = 消息下标；与 `segmentsOf` 同一份规则） */
function segmentSeqByMessage(
  messages: readonly ThreadHistoryMessageLike[],
  readEpoch: (m: ThreadHistoryMessageLike) => { kind: "compact" | "switch" } | null,
): number[] {
  const out: number[] = [];
  let seq = 1;
  for (const message of messages) {
    const epoch = readEpoch(message);
    if (epoch?.kind === "switch" && out.length > 0) seq += 1;
    out.push(seq);
  }
  return out;
}

function snippetAround(text: string, queryLower: string): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(queryLower);
  if (at < 0) return text.slice(0, SNIPPET_MAX);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + queryLower.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`.slice(0, SNIPPET_MAX);
}

/**
 * 在当前会话的完整时间线里检索（大小写不敏感的子串匹配）。
 *
 * ## 检索面（独立复核的缺口就在这条）
 *
 * 每条消息的**正文 + 工具结果 + 工具请求侧（名字/参数）**都参与匹配，
 * 机器注入正文（handoff / 压缩标记 / 提醒）写在 `content` 里，因此天然覆盖；
 * `metadata` 里若有显式可读正文（见 `MACHINE_TEXT_METADATA_KEYS`）也一并纳入。
 * 命中只报**第一处**（按正文 → 结果 → 参数的优先级），并标出是哪一段命中的。
 *
 * @param limit 最多返回多少条（调用方已做上限夹取）
 * @param options.segmentSeq 只搜这一段（不传 = 所有段）
 */
export function searchThreadHistory(
  messages: readonly ThreadHistoryMessageLike[],
  query: string,
  limit: number,
  readEpoch: (m: ThreadHistoryMessageLike) => { kind: "compact" | "switch" } | null,
  options?: { segmentSeq?: number },
): ThreadHistoryHit[] {
  const needle = query.trim().toLowerCase();
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!needle || max === 0) return [];
  const onlySegment =
    typeof options?.segmentSeq === "number" && Number.isFinite(options.segmentSeq)
      ? Math.floor(options.segmentSeq)
      : null;
  const seqs = segmentSeqByMessage(messages, readEpoch);
  const hits: ThreadHistoryHit[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (onlySegment !== null && seqs[i] !== onlySegment) continue;
    const field = searchFieldsOf(messages[i]).find((candidate) => candidate.text.toLowerCase().includes(needle));
    if (!field) continue;
    hits.push({
      id: messages[i].id,
      segmentSeq: seqs[i],
      role: String(messages[i].role ?? "user"),
      timestamp: Number(messages[i].timestamp ?? 0),
      snippet: snippetAround(field.text, needle),
      matchField: field.field,
      ...(field.toolName ? { toolName: field.toolName } : {}),
      ...(field.toolCallId ? { toolCallId: field.toolCallId } : {}),
    });
    if (hits.length >= max) break;
  }
  return hits;
}

/**
 * 按 id 回读一条消息及其邻域。
 *
 * `id` 既可以是**消息 id**，也可以是 **epoch id**（两者在生产里同一个值；这里两种都认，
 * 于是「按 epoch 读」不需要调用方自己换算）。
 *
 * @returns `null` = 这条 id 不在当前会话的时间线里（调用方要如实说"找不到"，
 *          而不是"没有历史"）
 */
export function readThreadHistory(
  messages: readonly ThreadHistoryMessageLike[],
  id: string,
  before: number,
  after: number,
  readEpoch: (m: ThreadHistoryMessageLike) => MinimalEpoch | null,
): ThreadHistoryWindow | null {
  const index = resolveMessageIndex(messages, id, readEpoch);
  if (index < 0) return null;
  const start = Math.max(0, index - Math.max(0, before));
  const end = Math.min(messages.length, index + Math.max(0, after) + 1);
  const seqs = segmentSeqByMessage(messages, readEpoch);
  return {
    index,
    segmentSeq: seqs[index] ?? 1,
    messages: messages.slice(start, end),
    truncatedBefore: index < before,
    truncatedAfter: messages.length - index - 1 < after,
  };
}

/** 消息 id → 时间线下标（消息 id 找不到时再按 epoch id 找一次；都没有返回 -1） */
function resolveMessageIndex(
  messages: readonly ThreadHistoryMessageLike[],
  id: string,
  readEpoch: (m: ThreadHistoryMessageLike) => MinimalEpoch | null,
): number {
  const direct = messages.findIndex((m) => m.id === id);
  if (direct >= 0) return direct;
  return messages.findIndex((m) => {
    const epoch = readEpoch(m);
    return typeof epoch?.epochId === "string" && epoch.epochId === id;
  });
}

/**
 * 按段读**整段**（`segmentSeq` 从 1 开始；与 `segmentsOf` 同一份分段规则）。
 *
 * ## 为什么要有它（25 号文 §4.5 的 `thread_history_read(anchor | messageId)`）
 *
 * 模型常有的问法是「第 2 段到底发生了什么」，而不是某个具体 id。让模型先 `search`
 * 拿到 id 再一条条读，既费调用又容易漏；按段读一次就能拿到该段的原文。
 *
 * ## 上限是**真**上限（不假装读完了）
 *
 * `maxMessages` 由调用方夹取；段内超过时 `truncatedAfter=true`，工具层必须如实说明
 * 「段内还有 N 条未返回」—— 静默截断会让模型以为"这一段就这么多"，从而漏掉事实。
 *
 * @returns `null` = 没有这一段（段号越界）
 */
export function readThreadSegment(
  messages: readonly ThreadHistoryMessageLike[],
  segmentSeq: number,
  maxMessages: number,
  readEpoch: (m: ThreadHistoryMessageLike) => MinimalEpoch | null,
): ThreadHistoryWindow | null {
  const target = Number.isFinite(segmentSeq) ? Math.floor(segmentSeq) : 0;
  if (target < 1) return null;
  const seqs = segmentSeqByMessage(messages, readEpoch);
  let start = -1;
  let end = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (seqs[i] !== target) continue;
    if (start < 0) start = i;
    end = i;
  }
  if (start < 0) return null;
  const cap = Number.isFinite(maxMessages) ? Math.max(1, Math.floor(maxMessages)) : 1;
  const sliceEnd = Math.min(end + 1, start + cap);
  return {
    index: start,
    segmentSeq: target,
    messages: messages.slice(start, sliceEnd),
    truncatedBefore: false,
    truncatedAfter: sliceEnd < end + 1,
  };
}
