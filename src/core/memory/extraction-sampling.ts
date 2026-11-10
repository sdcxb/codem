/**
 * 记忆提取的**取样与预算**（24 号文 §P0-3 的剩余细项）。
 *
 * ## 被守的两件事
 *
 * ① **tier 取样**：提取输入是按价值排序取的，不是"按时间先取"。
 *    `Human > Final > Agent > Commentary > Context > Tool` —— 用户的长期偏好、
 *    一轮的最终结论、代理动作，比工具读出来的大段文件正文更值得沉淀成记忆；
 *    工具结果只留摘要（原文动辄几 MB，进提示词既贵又会把真正的事实挤掉）。
 * ② **预算**：输入上限 = `min(8MB, 窗口 70%)`，**头 10 + 尾 40 保留**，中间按 tier 选；
 *    超限时**有界**（`selectedBytes ≤ budgetBytes`）且**标注**（截断标记写进正文）。
 *
 * ## 为什么是纯函数
 *
 * 判据要能直接钉住"预算紧张时 Human/Final 保留、Tool 先丢"，而不用起一个会话、
 * 造几 MB 的工具输出、再数请求体。取样规则（tier 分类、预算分配、截断标注）都在这里，
 * 接线（`llm/index.ts`）只负责把消息递进来、把结果递给 forked agent。
 *
 * ## 已知边界（如实写）
 *
 * - 预算按 **UTF-8 字节**算，窗口按 `tokens × 4 bytes/token` 折算（`EXTRACTION_BYTES_PER_TOKEN`）。
 *   这是**估算**：CJK 实际约 5 bytes/token，所以这个折算偏保守（预算只会更小，不会更大）；
 * - `Context` tier 在排除系统消息 / marker / 机器注入之后很少出现（那三类在调用方就被滤掉了），
 *   它保留给"角色不认识 / 将来新增的上下文类消息"，分类规则不猜；
 * - 截断按**字符边界**切（`truncateToBytes` 二分找最大安全前缀，不切坏代理对）。
 */

/**
 * tier 的**取值顺序就是优先级**（高 → 低）。
 *
 * 语义（与 24 §P0-3 的「Human > Final > Agent > Commentary > Context > Tool」逐字对应）：
 * - `human`：用户自己打的话（机器注入的提醒/委派在调用方已排除）；
 * - `final`：一轮里**最后一条**助手消息（这一轮的结论/最终回答）；
 * - `agent`：带已完成工具调用的助手消息（代理动作步骤；工具结果只取摘要）；
 * - `commentary`：一轮中间的助手叙述（没有工具调用、也不是最后一条）；
 * - `context`：角色不认识的上下文类消息（系统/marker/机器注入已在调用方排除）；
 * - `tool`：独立的工具角色消息（`role === "tool"`）。
 */
const EXTRACTION_TIERS = ["human", "final", "agent", "commentary", "context", "tool"] as const;

export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];

/** 提取输入**绝对上限**（8 MB）：再大的会话也不许把整份工具输出塞进请求 */
export const EXTRACTION_MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** 窗口占比（70%）：留 30% 给提示词、已有记忆清单与模型输出 */
const EXTRACTION_WINDOW_RATIO = 0.7;

/**
 * token → 字节的**估算**系数。
 *
 * 取值理由：Latin 约 4 bytes/token、CJK 约 5 bytes/token；取 4 是**保守**方向
 * （算出来的预算偏小 ⇒ 更安全）。这不是精确分词，只给预算一个可复算的口径。
 */
const EXTRACTION_BYTES_PER_TOKEN = 4;

/** 头部保留条数（24 §P0-3：早期事实最该沉淀，只取尾部会让第 1 段永远进不来） */
export const EXTRACTION_HEAD_KEEP = 10;

/** 尾部保留条数（最近进展 / 当前状态） */
export const EXTRACTION_TAIL_KEEP = 40;

/** 单条工具结果保留的摘要字符数（原文更长的部分不进提示词） */
export const EXTRACTION_TOOL_SUMMARY_CHARS = 400;

/** 截断标注（判据逐字断言它存在 ⇒「有界」必须能被看见） */
export const EXTRACTION_TRUNCATION_MARK = "[提取预算截断";

/** 工具结果摘要的标注（与上一条分开：一个是预算，一个是工具摘要） */
export const EXTRACTION_TOOL_SUMMARY_MARK = "[工具结果已截断：";

/**
 * 中间段单条消息**最多**占用预算的比例。
 *
 * 为什么需要：一条 7 MB 的用户粘贴正文若独占整个剩余预算，它会把同批的 Final/Agent
 * 全部挤掉 —— tier 优先级的本意是"高价值先取"，不是"最大的那条通吃"。
 */
const EXTRACTION_MAX_MIDDLE_MESSAGE_SHARE = 0.25;

/** 切片的**最小可用字节数**（低于这个值就整条丢弃，切出来的碎片没有信息量） */
const EXTRACTION_MIN_MIDDLE_SLICE_BYTES = 1024;

/** 截断标记本身的字节预留（CJK 标记较长，按 160 字节留足） */
const TRUNCATION_MARK_RESERVE_BYTES = 160;

export interface ExtractionSampleOptions {
  /** 本次可用**字节**预算（由 `extractionBudgetBytes` 算；判据可直接给固定值） */
  budgetBytes: number;
  /** 头部保留条数（默认 `EXTRACTION_HEAD_KEEP`） */
  headKeep?: number;
  /** 尾部保留条数（默认 `EXTRACTION_TAIL_KEEP`） */
  tailKeep?: number;
  /** 单条工具结果摘要字符数（默认 `EXTRACTION_TOOL_SUMMARY_CHARS`） */
  toolSummaryChars?: number;
}

interface ExtractionSampleStats {
  /** 本次预算（字节） */
  budgetBytes: number;
  /** 输入总字节（未取样前的近似值，仅诊断） */
  inputBytes: number;
  /** 取样后总字节（**必须 ≤ budgetBytes**） */
  selectedBytes: number;
  inputCount: number;
  selectedCount: number;
  headKept: number;
  tailKept: number;
  middleSelected: number;
  /** 每个 tier 被选中的条数 */
  selectedByTier: Record<ExtractionTier, number>;
  /** 每个 tier 因预算 / 切不出可用片段被丢掉的条数 */
  droppedByTier: Record<ExtractionTier, number>;
  /** 有工具结果被摘要（不是原样进提示词） */
  toolResultsSummarized: number;
  /** 有正文被预算截断的消息条数 */
  truncatedMessages: number;
  /** 预算是否被用尽（有内容因为预算没进来） */
  budgetExhausted: boolean;
  /** 是否有任何形式的截断 / 摘要（"超限并标注"的总开关） */
  truncated: boolean;
}

export interface ExtractionSampleResult {
  /** 取样后的消息（**按原始时间顺序**；副本，不改调用方的对象） */
  messages: Array<Record<string, unknown>>;
  stats: ExtractionSampleStats;
}

type AnyMessage = Record<string, unknown> & {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
};

function emptyTierCounts(): Record<ExtractionTier, number> {
  return { human: 0, final: 0, agent: 0, commentary: 0, context: 0, tool: 0 };
}

/** 已完成（done/error）的工具调用 —— 与 `messagesToLLMMessages` 的口径一致 */
function completedToolCalls(message: AnyMessage): Array<Record<string, unknown>> {
  const raw = message.toolCalls;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (tc): tc is Record<string, unknown> =>
      !!tc &&
      typeof tc === "object" &&
      ((tc as Record<string, unknown>).status === "done" || (tc as Record<string, unknown>).status === "error"),
  );
}

/**
 * 算每一轮**最后一条助手消息**的下标（Final tier）。
 *
 * 规则：一轮 = 一条用户消息之后、下一条用户消息之前的所有助手消息；这一轮里**最后一条**
 * 助手消息是 Final，其余是 Commentary（无工具调用）或 Agent（有工具调用）。
 * 用户消息之前/之后没有助手消息的轮次不产生 Final —— 不猜。
 */
function finalAssistantIndexes(messages: readonly AnyMessage[]): Set<number> {
  const finals = new Set<number>();
  let lastAssistantInTurn = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (lastAssistantInTurn >= 0) finals.add(lastAssistantInTurn);
      lastAssistantInTurn = -1;
      continue;
    }
    if (role === "assistant") lastAssistantInTurn = i;
  }
  if (lastAssistantInTurn >= 0) finals.add(lastAssistantInTurn);
  return finals;
}

/** 一条消息的 tier（分类规则写在 `EXTRACTION_TIERS` 的注释里） */
export function extractionTierOf(message: AnyMessage, isFinalAssistant = false): ExtractionTier {
  const role = message?.role;
  if (role === "user") return "human";
  if (role === "assistant") {
    if (isFinalAssistant) return "final";
    if (completedToolCalls(message).length > 0) return "agent";
    return "commentary";
  }
  if (role === "tool") return "tool";
  return "context";
}

/** UTF-8 字节数（拿不到 TextEncoder 时按 3 字节/字符保守兜底） */
const ENCODER: TextEncoder | null = (() => {
  try {
    return new TextEncoder();
  } catch {
    return null;
  }
})();

function utf8Bytes(text: string): number {
  if (!text) return 0;
  return ENCODER ? ENCODER.encode(text).length : text.length * 3;
}

/** 按**字节**截断到不超过 `maxBytes` 的最大字符前缀（二分；不切坏代理对） */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  /* 不把代理对切成两半 */
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/** 工具结果摘要（只保留前 `maxChars` 字符 + 明确标注） */
export function summarizeToolResult(
  result: unknown,
  maxChars = EXTRACTION_TOOL_SUMMARY_CHARS,
): { text: string; summarized: boolean } {
  const text =
    typeof result === "string" ? result : result === undefined || result === null ? "" : String(result);
  if (!text) return { text: "", summarized: false };
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { text, summarized: false };
  return {
    text: `${text.slice(0, limit)}\n${EXTRACTION_TOOL_SUMMARY_MARK}原文 ${text.length} 字符，提取只用摘要]`,
    summarized: true,
  };
}

interface PreparedMessage {
  message: AnyMessage;
  /** 该消息进提示词后的**精确**字节数（id + role + content + 工具结果） */
  bytes: number;
  /** 固定的结构开销（id/role/name），用来算"正文还能占多少" */
  fixedBytes: number;
  /** 有几个工具结果被摘要 */
  toolSummarized: number;
  /** 有几个工具结果（可被预算单独丢掉的条数 —— Tool 是最低 tier） */
  toolCount: number;
  /** 正文是否被预算截断 */
  truncated: boolean;
}

/** 一条消息的固定结构开销（不含正文与工具结果） */
function fixedBytesOf(message: AnyMessage): number {
  return utf8Bytes(String(message.id ?? "")) + utf8Bytes(String(message.role ?? "")) + 16;
}

/** 一条消息里**工具结果**的字节数（不含正文） */
function toolBytesOf(message: AnyMessage): number {
  if (!Array.isArray(message.toolCalls)) return 0;
  return message.toolCalls.reduce((sum, tc) => {
    const r = (tc as Record<string, unknown> | null)?.result;
    return sum + utf8Bytes(typeof r === "string" ? r : "");
  }, 0);
}

/** 把一条消息**原样**（工具结果已摘要）准备成待发形状；`contentMaxBytes` 给定时截断正文 */
function prepareMessage(
  raw: AnyMessage,
  toolSummaryChars: number,
  contentMaxBytes?: number,
  /**
   * `true` = **丢掉工具结果**（Tool 是最低 tier：预算不够时先丢它，保留同级消息的正文）。
   * 丢的时候留一条省略标记 —— 直接删掉会让 tool_calls 变成"有调用没结果"，
   * 模型会以为工具执行失败。
   */
  omitToolResults = false,
): PreparedMessage {
  const copy: AnyMessage = { ...raw };
  let toolSummarized = 0;
  let toolCount = 0;
  if (Array.isArray(raw.toolCalls)) {
    copy.toolCalls = raw.toolCalls.map((tc) => {
      if (!tc || typeof tc !== "object") return tc;
      const next: Record<string, unknown> = { ...(tc as Record<string, unknown>) };
      if ("result" in next) {
        toolCount += 1;
        const summary = summarizeToolResult(next.result, toolSummaryChars);
        if (omitToolResults) {
          const rawText = typeof next.result === "string" ? next.result : "";
          next.result = `${EXTRACTION_TOOL_SUMMARY_MARK}预算不足，本条工具结果未进提示词（原文 ${rawText.length} 字符）]`;
          toolSummarized += 1;
        } else {
          next.result = summary.text;
          if (summary.summarized) toolSummarized += 1;
        }
      }
      return next;
    });
  }

  let truncated = false;
  const rawContent = typeof copy.content === "string" ? copy.content : "";
  let content = rawContent;
  const rawContentBytes = utf8Bytes(rawContent);
  if (contentMaxBytes !== undefined && rawContentBytes > contentMaxBytes) {
    const kept = truncateToBytes(rawContent, Math.max(0, contentMaxBytes));
    content = `${kept}\n\n${EXTRACTION_TRUNCATION_MARK}：原文 ${rawContentBytes} 字节，只保留前 ${utf8Bytes(kept)} 字节]`;
    truncated = true;
  }
  if (typeof copy.content === "string") copy.content = content;

  const toolBytes = toolBytesOf(copy);
  return {
    message: copy,
    bytes: fixedBytesOf(copy) + utf8Bytes(content) + toolBytes,
    fixedBytes: fixedBytesOf(copy),
    toolSummarized,
    toolCount,
    truncated,
  };
}

/**
 * 头尾自身超预算时：把一条消息压进 `quota` 字节。
 *
 * 顺序：先压工具结果（摘要 → 更短摘要），再压正文；每一步都按**精确字节**复算，
 * 最后仍未达标就继续对正文做等比缩小（最多 8 轮 —— 每轮至少减半，必然收敛）。
 */
function fitMessageToQuota(
  raw: AnyMessage,
  quota: number,
  toolSummaryChars: number,
): PreparedMessage {
  const base = prepareMessage(raw, toolSummaryChars);
  if (base.bytes <= quota) return base;
  const fixed = base.fixedBytes;
  const tools = completedToolCalls(base.message);
  /** 工具结果最多占一半额度（另一半留给正文 —— 只给摘要不给正文等于没给对话） */
  const toolBudgetBytes = tools.length > 0 ? Math.max(0, Math.floor((quota - fixed) / 2)) : 0;
  const perToolChars =
    tools.length > 0 ? Math.max(24, Math.floor(toolBudgetBytes / (tools.length * 3))) : 0;
  const withShortTools = prepareMessage(raw, perToolChars);
  /** 正文额度 = 配额 - 固定开销 - 工具结果 - 截断标记预留 */
  const contentMax = Math.max(
    0,
    quota - withShortTools.fixedBytes - toolBytesOf(withShortTools.message) - TRUNCATION_MARK_RESERVE_BYTES,
  );
  let prepared = prepareMessage(raw, perToolChars, contentMax);
  let shrink = 1;
  while (prepared.bytes > quota && contentMax > 0 && shrink <= 8) {
    shrink *= 2;
    prepared = prepareMessage(raw, perToolChars, Math.floor(contentMax / shrink));
  }
  /* 极端：正文压到 0 仍超（工具结果本身就超）⇒ 只留最短工具摘要 */
  if (prepared.bytes > quota) prepared = prepareMessage(raw, 24, 0);
  return prepared;
}

/**
 * 算本次提取的字节预算：`min(8MB, 窗口 70%)`（取小）。
 *
 * 窗口拿不到（`undefined` / 非正数 / NaN）时**退回 8MB**并如实说明 —— 不静默按 0
 * 把提取整个关掉（那会让用户看到"记忆系统不工作了"）。
 */
export function extractionBudgetBytes(
  windowTokens: number | undefined,
  ratio = EXTRACTION_WINDOW_RATIO,
): number {
  const tokens = Number(windowTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return EXTRACTION_MAX_INPUT_BYTES;
  const byWindow = Math.floor(tokens * ratio * EXTRACTION_BYTES_PER_TOKEN);
  if (byWindow <= 0) return EXTRACTION_MAX_INPUT_BYTES;
  return Math.min(EXTRACTION_MAX_INPUT_BYTES, byWindow);
}

/**
 * 取样：头 10 + 尾 40 无条件保留，中间按 tier 优先级选，总字节不超过预算。
 *
 * 头尾本身超预算时**等分额度后截断**（而不是先丢头/丢尾）：24 §P0-3 要的是"头尾保留"，
 * 丢头会让第 1 段的早期事实永远进不了提取器（那正是 MEM-EXTRACT-1 要防的）。
 */
export function sampleExtractionMessages(
  messages: readonly AnyMessage[],
  options: ExtractionSampleOptions,
): ExtractionSampleResult {
  const budgetBytes = Math.max(0, Math.floor(Number(options.budgetBytes) || 0));
  const headKeep = Math.max(0, Math.floor(options.headKeep ?? EXTRACTION_HEAD_KEEP));
  const tailKeep = Math.max(0, Math.floor(options.tailKeep ?? EXTRACTION_TAIL_KEEP));
  const toolSummaryChars = Math.max(0, Math.floor(options.toolSummaryChars ?? EXTRACTION_TOOL_SUMMARY_CHARS));

  const list = messages.filter((m): m is AnyMessage => !!m && typeof m === "object");
  const stats: ExtractionSampleStats = {
    budgetBytes,
    inputBytes: 0,
    selectedBytes: 0,
    inputCount: list.length,
    selectedCount: 0,
    headKept: 0,
    tailKept: 0,
    middleSelected: 0,
    selectedByTier: emptyTierCounts(),
    droppedByTier: emptyTierCounts(),
    toolResultsSummarized: 0,
    truncatedMessages: 0,
    budgetExhausted: false,
    truncated: false,
  };
  /* 预算为 0（坏配置 / 判据边界）：如实返回空集 + 全部计入 dropped，不假装"没消息" */
  if (budgetBytes <= 0) {
    for (let i = 0; i < list.length; i += 1) {
      const prepared = prepareMessage(list[i], toolSummaryChars);
      stats.inputBytes += prepared.bytes;
      stats.droppedByTier[extractionTierOf(list[i], false)] += 1;
    }
    stats.budgetExhausted = list.length > 0;
    stats.truncated = list.length > 0;
    return { messages: [], stats };
  }

  const headCount = Math.min(headKeep, list.length);
  const tailCount = Math.min(tailKeep, Math.max(0, list.length - headCount));
  const head = list.slice(0, headCount);
  const tailStart = list.length - tailCount;
  const tail = tailCount > 0 ? list.slice(tailStart) : [];
  const middle = list.slice(headCount, tailStart);
  const finals = finalAssistantIndexes(list);
  const tierAt = (index: number) => extractionTierOf(list[index], finals.has(index));

  /* 输入规模（未取样）只做诊断。工具结果按原文计 —— 这正是"取样前有多大"的意思。 */
  for (const m of list) {
    const prepared = prepareMessage(m, Number.MAX_SAFE_INTEGER);
    stats.inputBytes += prepared.bytes;
  }

  /* ---------- ① 头 + 尾：无条件保留 ---------- */
  let remaining = budgetBytes;
  let headPrepared: PreparedMessage[];
  let tailPrepared: PreparedMessage[];

  const rawHeadTailBytes = [...head, ...tail].reduce(
    (sum, m) => sum + prepareMessage(m, toolSummaryChars).bytes,
    0,
  );
  if (rawHeadTailBytes > budgetBytes && head.length + tail.length > 0) {
    /* 超预算：等分额度，逐条压进 quota（保证 sum ≤ budget） */
    const quota = Math.floor(budgetBytes / (head.length + tail.length));
    headPrepared = head.map((m) => fitMessageToQuota(m, quota, toolSummaryChars));
    tailPrepared = tail.map((m) => fitMessageToQuota(m, quota, toolSummaryChars));
    remaining = 0;
    /* 头尾都放不下 ⇒ 预算确实被用尽（不是"没有内容"） */
    stats.budgetExhausted = true;
  } else {
    headPrepared = head.map((m) => prepareMessage(m, toolSummaryChars));
    tailPrepared = tail.map((m) => prepareMessage(m, toolSummaryChars));
    remaining = budgetBytes - rawHeadTailBytes;
  }
  for (const p of [...headPrepared, ...tailPrepared]) {
    if (p.truncated) {
      stats.truncatedMessages += 1;
      stats.truncated = true;
    }
    if (p.toolSummarized > 0) stats.toolResultsSummarized += p.toolSummarized;
  }
  stats.headKept = head.length;
  stats.tailKept = tail.length;
  for (let i = 0; i < headCount; i += 1) stats.selectedByTier[tierAt(i)] += 1;
  for (let i = 0; i < tailCount; i += 1) stats.selectedByTier[tierAt(tailStart + i)] += 1;

  /* ---------- ② 中间按 tier 优先级选（同 tier 内取**更近**的） ---------- */
  const middleIndexesByTier = new Map<ExtractionTier, number[]>();
  for (const tier of EXTRACTION_TIERS) middleIndexesByTier.set(tier, []);
  for (let i = 0; i < middle.length; i += 1) {
    middleIndexesByTier.get(tierAt(headCount + i))!.push(i);
  }

  const chosenMiddle = new Map<number, PreparedMessage>();
  for (const tier of EXTRACTION_TIERS) {
    const candidates = middleIndexesByTier.get(tier)!.slice().sort((a, b) => b - a);
    for (const i of candidates) {
      if (remaining <= 0) {
        stats.droppedByTier[tier] += 1;
        stats.droppedByTier.tool += prepareMessage(middle[i], toolSummaryChars).toolCount;
        stats.budgetExhausted = true;
        continue;
      }
      const full = prepareMessage(middle[i], toolSummaryChars);
      if (full.bytes <= remaining) {
        chosenMiddle.set(i, full);
        remaining -= full.bytes;
        stats.selectedByTier[tier] += 1;
        stats.middleSelected += 1;
        if (full.toolSummarized > 0) stats.toolResultsSummarized += full.toolSummarized;
        continue;
      }
      /**
       * ★ Tool 是最低 tier：**先丢工具结果，再考虑丢整条**。
       *
       * 一条带 5 个工具结果的代理步，正文可能只有两行；只因为 5 份摘要放不下就把
       * 正文也丢了，等于把"代理做了什么"整段抹掉。这里先试"正文保留、工具结果省略"。
       */
      if (full.toolCount > 0) {
        const withoutTools = prepareMessage(middle[i], toolSummaryChars, undefined, true);
        if (withoutTools.bytes <= remaining) {
          chosenMiddle.set(i, withoutTools);
          remaining -= withoutTools.bytes;
          stats.selectedByTier[tier] += 1;
          stats.middleSelected += 1;
          stats.droppedByTier.tool += full.toolCount;
          stats.truncated = true;
          /* 工具结果是因为预算才没进来的 ⇒ 预算确实用尽了（不是"没有内容可放"） */
          stats.budgetExhausted = true;
          continue;
        }
      }
      /* 剩余空间还够一个最小切片 ⇒ 截断后放进（高价值内容不许因为太大就整条丢） */
      const sliceCap = Math.min(
        remaining,
        Math.max(
          EXTRACTION_MIN_MIDDLE_SLICE_BYTES,
          Math.floor(budgetBytes * EXTRACTION_MAX_MIDDLE_MESSAGE_SHARE),
        ),
      );
      if (remaining >= EXTRACTION_MIN_MIDDLE_SLICE_BYTES) {
        const contentMax = Math.max(0, sliceCap - full.fixedBytes - TRUNCATION_MARK_RESERVE_BYTES);
        const sliced = prepareMessage(middle[i], toolSummaryChars, contentMax);
        if (sliced.bytes <= remaining) {
          chosenMiddle.set(i, sliced);
          remaining -= sliced.bytes;
          stats.selectedByTier[tier] += 1;
          stats.middleSelected += 1;
          stats.truncatedMessages += 1;
          stats.truncated = true;
          if (sliced.toolSummarized > 0) stats.toolResultsSummarized += sliced.toolSummarized;
          continue;
        }
      }
      stats.droppedByTier[tier] += 1;
      /* 整条被丢时，它的工具结果当然也没进提示词 ⇒ 如实记进 Tool 的丢弃数 */
      stats.droppedByTier.tool += full.toolCount;
      stats.budgetExhausted = true;
    }
  }

  /* ---------- ③ 还原时间顺序：头 + 中间（原始顺序）+ 尾 ---------- */
  const out: AnyMessage[] = [
    ...headPrepared.map((p) => p.message),
    ...[...chosenMiddle.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p.message),
    ...tailPrepared.map((p) => p.message),
  ];
  let selectedBytes = [...headPrepared, ...tailPrepared, ...chosenMiddle.values()].reduce(
    (sum, p) => sum + p.bytes,
    0,
  );

  /**
   * 兜底：等分/切片是精确字节算的，理论上不会超；真超了就从**中间最低 tier** 开始丢，
   * 最后才丢尾部（头尾保留是硬要求），并标注 `budgetExhausted`。
   */
  while (selectedBytes > budgetBytes && chosenMiddle.size > 0) {
    const lastIndex = [...chosenMiddle.keys()].sort((a, b) => b - a)[0];
    const dropped = chosenMiddle.get(lastIndex)!;
    chosenMiddle.delete(lastIndex);
    selectedBytes -= dropped.bytes;
    const tier = tierAt(headCount + lastIndex);
    stats.selectedByTier[tier] = Math.max(0, stats.selectedByTier[tier] - 1);
    stats.droppedByTier[tier] += 1;
    stats.droppedByTier.tool += dropped.toolCount;
    stats.middleSelected = Math.max(0, stats.middleSelected - 1);
    stats.budgetExhausted = true;
    stats.truncated = true;
    out.splice(out.indexOf(dropped.message), 1);
  }

  stats.selectedBytes = selectedBytes;
  stats.selectedCount = out.length;
  stats.truncated = stats.truncated || stats.toolResultsSummarized > 0;
  return { messages: out, stats };
}
