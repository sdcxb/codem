/**
 * 最小工作集（C03「Working Set」）：把「这一轮请求到底带哪些历史消息」算成一份**可复查的计划**。
 *
 * ## 解决什么
 *
 * `buildMessages()` 交出去的是一整个数组，发完就没了。于是「模型为什么没看到那件事」只能靠猜：
 * 是被 cutoff 裁了？被预算挤掉了？还是本来就没写进库？—— `manifest.ts` 记的是**结果**
 * （哪些 id 进了请求），这里补的是**过程**（为什么进、为什么没进）。
 *
 * 工作集的语义就一句话：**必选的留下，预算内尽量多留，放不下的移出视图但留下可检索的索引**。
 *
 * 1. **必选**：全部 system 消息、最近 `keepRecent` 条非 system 消息、最后一条 user 消息，
 *    以及调用方点名的**受保护消息**（`protectedIds`，见规则 1b）；
 * 2. **其余从新到旧填**：直到估算 token 达到 `budgetTokens`；一旦某条放不下，**它和它之前
 *    （更旧）的可选消息全部移出** —— 所以移出的永远是**最旧的那一段**（判据 WS-2），
 *    不会出现「中间掏空、两头都在」这种让模型误判时序的形状；
 * 3. **移出的内容不消失**：`indexLines` 是给模型看的「Pager 索引」（`- [role] id: 摘要`），
 *    原文仍在库里，可 `thread_history_search` / `thread_history_read` 取回；
 * 4. **顺序 = 原时间顺序**（`selected` 按输入顺序过滤，不重排）；
 * 5. **全放得下 ⇒ 原样返回**：`selected` 是**同一个数组引用**（`selected === messages`）、
 *    `indexLines` 为空。这是灰度的关键 —— 没超预算的会话必须**逐字节零变化**（判据 WS-1）。
 *
 * ## 规则 1b：受保护消息（2026-11 高优先缺陷）
 *
 * 上下文检查点把模型视图压成 `[marker, ...cutoff 之后]`，而 marker 处在**最旧**的一端 ——
 * 于是「超预算时只移出最旧的一段」这条本来正确的规则，会第一个把 marker 移出视图，
 * 只留下索引里一行 80 字摘要。marker 是被隐藏历史的**唯一自动摘要**，丢了它就等于
 * 模型再也看不到「之前发生过什么」。所以调用方可以把这类消息的 id 放进 `protectedIds`：
 * **命中即必选、永不移出**，并且和其它必选项一样**计入预算**（`tokens` 会如实包含它）。
 *
 * 为什么由调用方点名、而不是本模块自己按 id 前缀判断：本模块是纯函数、只认
 * `{id, role, content, toolCalls}`，不知道「什么算 marker」的权威口径
 * （那是 `context-view` 的 `metadata.contextEpoch`）；谁有完整消息（含 metadata），
 * 谁负责算出集合 —— 生产上是 `agentic-loop.ts::buildMessages`。
 *
 * ## 为什么是纯函数（不读存储、不碰时钟）
 *
 * - 判据可以直接喂构造数据，不用起数据库/假端口；
 * - 「同一输入两次结果逐字节一致」是可断言的（判据 WS-4）—— 一旦混进 `Date.now()` / 随机数 /
 *   库读数，这条就再也立不住，而它正是「同一轮里 buildMessages 被调用多次会不会抖」的前提。
 *
 * 估算函数由调用方注入（生产用 `token-tracker` 同一把尺），本模块不 import 任何 llm 模块。
 *
 * ## 与 `manifest.ts` 的分工
 *
 * 这里只**算**（纯函数，返回计划）；记录进 manifest 的是**数字**（预算 / 选中 / 移出 / 索引行数），
 * 不是正文也不是索引文本 —— 清单的存储口径仍然是「不记正文」（见 `manifest.ts` 文件头）。
 */

/** 默认最近保留的非 system 消息条数：6 条 = 最近 3 轮 user+assistant（与压缩/微压缩的轮次保底同口径） */
export const DEFAULT_KEEP_RECENT = 6;

/**
 * Pager 索引的**总行数**上限（含溢出注记那一行）。
 *
 * 为什么注记也占一行：判据 WS-2 要求 `indexLines` 不超过 40 行，而溢出时必须有一行
 * 「还有 N 条更早消息…」。所以溢出时是 **39 条明细 + 1 行注记**（而不是 40 + 1 = 41）。
 */
export const DEFAULT_INDEX_LINE_MAX = 40;

/** 每条索引行里摘要的字符上限（一行，不含 role/id 前缀）；只在本模块内使用 */
const INDEX_SUMMARY_MAX = 80;

/**
 * 索引消息的**标题行**。
 *
 * 它同时是三条判据的锚点（WS-5 断言请求里出现它；`manifest` 的 `indexLines` 计数与它对得上）：
 * 写成常量而不是两处字符串字面量，避免「改了一处、判据还在找旧词」。
 */
export const WORKING_SET_INDEX_HEADER =
  "# 更早消息索引（原文仍可用 thread_history_search/read 取回）";

/**
 * 本模块只依赖这些字段（结构化类型，不把 `storage/message` 的 `Message` 拖进来）。
 *
 * `toolCalls` 只为**摘要**服务：一条只有工具调用的 assistant 消息没有正文，索引行里
 * 至少要把工具名写出来，否则索引会退化成一行行「（无文本）」。
 */
export interface WorkingSetMessageLike {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown;
}

export interface PlanWorkingSetInput<M extends WorkingSetMessageLike> {
  /** 按时间顺序的消息（已含 system / 记忆块；调用方保证顺序） */
  messages: M[];
  /** 可用预算（tokens；调用方已扣掉系统提示词、输出预留等） */
  budgetTokens: number;
  /** 单条消息的 token 估算（注入，保证与调用方同一把尺） */
  estimate: (message: M) => number;
  /** 最近保留的非 system 消息条数（默认 6） */
  keepRecent?: number;
  /** Pager 索引总行数上限（默认 40） */
  indexLineMax?: number;
  /** 一行摘要（默认取正文首行/工具名，自动裁到 80 字符） */
  summaryOf?: (message: M) => string;
  /**
   * **受保护消息的 id 集合**（规则 1b）：命中即必选、永不移出，并计入预算。
   *
   * 生产上放的是压缩 / 换段 marker（`metadata.contextEpoch` 或 `id` 以 `compact-` 开头，
   * 见 `collectProtectedContextIds`）—— 它们是被移出视图的那段历史的**唯一自动摘要**。
   * 不传 = 没有受保护消息（与加这个参数之前的行为逐字节一致）。
   */
  protectedIds?: ReadonlySet<string>;
}

/**
 * `reasons` 的解释（不导出：它只作为 `WorkingSetPlan` 的字段类型出现，
 * 导出会白白多一个「没人 import 的公开类型」）。
 */
interface WorkingSetReasons {
  /** 实际使用的预算（已归一化：非负有限整数） */
  budget: number;
  /** 因「最近 keepRecent 条非 system」这条保底规则被强制保留的条数（不是总选中数） */
  keepRecent: number;
  /** 被移出视图的条数（= `evicted.length`） */
  evicted: number;
}

export interface WorkingSetPlan<M extends WorkingSetMessageLike> {
  /** 进入请求的消息（原时间顺序；全放得下时**就是入参那个数组**） */
  selected: M[];
  /** 被移出视图的消息（原时间顺序；永远是最旧的一段） */
  evicted: M[];
  /** 给模型看的 Pager 索引行（`- [role] id: 摘要`，末尾可能有溢出注记） */
  indexLines: string[];
  /** `selected` 的估算 token 合计（必选项自身就超预算时**会**大于预算，如实报，不裁剪） */
  tokens: number;
  reasons: WorkingSetReasons;
}

/** 取一条消息的**纯文本**（字符串正文或文本块拼接；其它形状按空串） */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
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

/** 压成**一行**并裁到 `max` 字符（超长时用「…」收尾，总长恰为 `max`） */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${flat.slice(0, max - 1)}…`;
}

/** 工具调用的名字（存储形状 `toolCalls[].tool` / 协议形状 `tool_calls[].function.name` 都认） */
function toolNamesOf(message: WorkingSetMessageLike): string[] {
  const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  const names: string[] = [];
  for (const call of calls) {
    const raw = call as { tool?: unknown; name?: unknown; function?: { name?: unknown } } | null;
    const name = raw?.tool ?? raw?.function?.name ?? raw?.name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

/** 默认摘要：正文首行优先；没有正文时写工具名；都没有就写「（无文本）」 */
function defaultSummaryOf(message: WorkingSetMessageLike): string {
  const text = textOf(message?.content);
  if (text.trim().length > 0) return oneLine(text, INDEX_SUMMARY_MAX);
  const names = toolNamesOf(message);
  if (names.length > 0) return oneLine(`工具调用：${names.join("、")}`, INDEX_SUMMARY_MAX);
  return "（无文本）";
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 预算归一化：非负有限整数（NaN / 负数 / 非数 → 0，判据里点过这条） */
function normalizeBudget(value: unknown): number {
  const n = finiteNumber(value);
  return n === null ? 0 : Math.max(0, Math.floor(n));
}

/** 计数归一化：给默认值 + 下限（非法值 → 默认值，不抛） */
function normalizeCount(value: unknown, fallback: number, min: number): number {
  const n = finiteNumber(value);
  if (n === null) return fallback;
  return Math.max(min, Math.floor(n));
}

/** 单条估算归一化：非负整数（估算函数返回 NaN/负数时不污染预算判断） */
function normalizeEstimate(value: unknown): number {
  const n = finiteNumber(value);
  return n === null ? 0 : Math.max(0, Math.ceil(n));
}

function roleOf(message: WorkingSetMessageLike): string {
  return String(message?.role ?? "");
}

/**
 * 压缩 / 换段 marker 的 id 前缀（`nextCompactionMarkerId` 生成 `compact-<ts>-<seq>`，
 * 手动压缩是 `compact-manual-…`，两者都以它开头）。
 *
 * 只用来兜住「元数据读不到、但 id 形状还是 marker」的形态：`metadata.contextEpoch`
 * 才是权威（见下面 `isProtectedContextMessage`），而 id 前缀是它之外的第二道保险 ——
 * 索引镜像在某些路径上会丢 metadata（`messageRowToMessage` 的注释），那时不能因此
 * 把 marker 当成普通消息移出视图。
 */
const PROTECTED_EPOCH_ID_PREFIX = "compact-";

/**
 * 一条消息是不是**受保护**的上下文 marker（压缩 / 换段两类）。
 *
 * 判据取「或」而不是「且」：
 * - `metadata.contextEpoch` 存在 ⇒ 它是写侧声明过的 epoch（权威）；
 * - `id` 以 `compact-` 开头 ⇒ 它是 `nextCompactionMarkerId` 造的 marker（读不到元数据时的兜底）。
 *
 * 不要求 `cutoffMessageId` 成立（那是 `context-view.readContextEpochOf` 的投影口径），
 * 因为「它是摘要、不许丢」与「它的 cutoff 能不能用」是两件事：坏掉 cutoff 的 marker
 * 仍然是被隐藏历史的唯一摘要，更要留在视图里让人看见。
 */
export function isProtectedContextMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { id?: unknown; metadata?: unknown };
  if (typeof candidate.id === "string" && candidate.id.startsWith(PROTECTED_EPOCH_ID_PREFIX)) {
    return true;
  }
  if (!candidate.metadata || typeof candidate.metadata !== "object") return false;
  const epoch = (candidate.metadata as Record<string, unknown>).contextEpoch;
  return Boolean(epoch && typeof epoch === "object");
}

/**
 * 从一组**存储形状**的消息里收集受保护 id（含 metadata 的那一份；见 `isProtectedContextMessage`）。
 *
 * 为什么放在这里而不是接线处：判定口径只写一遍，「哪些消息算 marker」将来要是变
 * （比如再加一种前缀），改一处就够；调用方只负责把消息数组喂进来。
 */
export function collectProtectedContextIds(
  messages: ReadonlyArray<{ id?: unknown; metadata?: unknown }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(messages)) return out;
  for (const message of messages) {
    if (!isProtectedContextMessage(message)) continue;
    const id = (message as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) out.add(id);
  }
  return out;
}

/** 没有受保护消息时的空集合（避免每次计划都新建一个 Set） */
const NO_PROTECTED_IDS: ReadonlySet<string> = new Set<string>();


/**
 * 计算最小工作集（纯函数）。
 *
 * 不读存储、不读时钟、不用随机数；同一输入两次调用的返回值**逐字节一致**（判据 WS-4）。
 */
export function planWorkingSet<M extends WorkingSetMessageLike>(
  input: PlanWorkingSetInput<M>,
): WorkingSetPlan<M> {
  const messages: M[] = Array.isArray(input?.messages) ? input.messages : [];
  const budget = normalizeBudget(input?.budgetTokens);
  const keepRecent = normalizeCount(input?.keepRecent, DEFAULT_KEEP_RECENT, 0);
  const indexLineMax = normalizeCount(input?.indexLineMax, DEFAULT_INDEX_LINE_MAX, 1);
  const estimate = typeof input?.estimate === "function" ? input.estimate : () => 0;
  const summaryOf = typeof input?.summaryOf === "function" ? input.summaryOf : defaultSummaryOf;
  /**
   * 受保护 id 集合：只认真正带 `has` 的实现（调用方可能传 null / 畸形值）。
   * 归一成空集合而不是抛 —— 工作集是「更好」，不是「必须」（这也是接线处的降级口径）。
   */
  const protectedIds: ReadonlySet<string> =
    input?.protectedIds && typeof (input.protectedIds as ReadonlySet<string>).has === "function"
      ? input.protectedIds
      : NO_PROTECTED_IDS;

  const costs = messages.map((message) => normalizeEstimate(estimate(message)));
  const totalTokens = costs.reduce((sum, cost) => sum + cost, 0);

  /**
   * 规则 4（关键）：预算内全放得下 ⇒ **原样返回同一个数组引用**。
   *
   * 这里刻意返回 `messages` 而不是 `[...messages]`：调用方用 `===` 判断「有没有发生变化」，
   * 复制一份会让"零行为变化"变成一句只能靠读代码相信的话（判据 WS-1 断言的是引用相等）。
   */
  if (totalTokens <= budget) {
    return {
      selected: messages,
      evicted: [],
      indexLines: [],
      tokens: totalTokens,
      reasons: { budget, keepRecent: 0, evicted: 0 },
    };
  }

  /** 必选集合（下标）：system 全部 + 最近 keepRecent 条非 system + 最后一条 user + 受保护消息 */
  const mandatory = new Set<number>();
  const nonSystemIndexes: number[] = [];
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const role = roleOf(messages[i]);
    if (role === "system") mandatory.add(i);
    else nonSystemIndexes.push(i);
    if (role === "user") lastUserIndex = i;
    /**
     * 规则 1b：受保护消息（压缩 / 换段 marker）**必选**。
     *
     * 它多半就是最旧的那一条（模型视图 `[marker, ...tail]`），不点进来会被
     * 「只移出最旧的一段」第一个移出视图 —— 而它是被隐藏历史的唯一自动摘要。
     */
    const id = messages[i]?.id;
    if (typeof id === "string" && protectedIds.has(id)) mandatory.add(i);
  }
  const recentIndexes = keepRecent > 0 ? nonSystemIndexes.slice(-keepRecent) : [];
  for (const i of recentIndexes) mandatory.add(i);
  /* 最后一条 user 消息是「用户当下要什么」的锚点：不在最近窗口里也要留（规则 1） */
  if (lastUserIndex >= 0) mandatory.add(lastUserIndex);

  let usedTokens = 0;
  for (const i of mandatory) usedTokens += costs[i];

  const selectedIndexes = new Set<number>(mandatory);
  const evictedIndexes: number[] = [];
  /**
   * 从新到旧填可选消息。
   *
   * `stopped` 一旦置位，**后面更旧的一律移出** —— 这是「只移出最旧的」的实现方式：
   * 若继续尝试更旧的小消息，就会出现「中间挖掉一条大消息、更旧的又塞回来」，
   * 模型看到的历史会有洞（判据 WS-2 明确要求只移最旧）。
   */
  let stopped = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (mandatory.has(i)) continue;
    if (!stopped) {
      const cost = costs[i];
      if (usedTokens + cost <= budget) {
        selectedIndexes.add(i);
        usedTokens += cost;
        continue;
      }
      stopped = true;
    }
    evictedIndexes.push(i);
  }
  /* 上面是从新到旧收集的，反转回时间顺序（`evicted` 承诺按原顺序） */
  const evicted: M[] = evictedIndexes.reverse().map((i) => messages[i]);
  const selected: M[] = messages.filter((_, i) => selectedIndexes.has(i));

  /**
   * Pager 索引：只给**被移出的**内容（system 永远不在其中，判据 WS-3）。
   *
   * 溢出时保留**离现在最近的** `indexLineMax - 1` 条（它们与当前工作最相关），
   * 末尾一行注记说明还有多少条更早的消息没被列出、用什么工具取回。
   */
  const indexLines: string[] = [];
  if (evicted.length > 0) {
    /**
     * 明细行数：不溢出时全列；溢出时给注记让出**一行**。
     *
     * ⚠️ 这里刻意不用 `evicted.slice(-detailBudget)` 来表达「0 条」——
     * `slice(-0)` 在 JS 里等于 `slice(0)`（返回**全部**），本仓被这个坑咬过好几次。
     * 所以 0 这条分支单独写。
     */
    const detailBudget = evicted.length > indexLineMax ? indexLineMax - 1 : indexLineMax;
    const shown = detailBudget > 0 ? evicted.slice(-detailBudget) : [];
    for (const message of shown) {
      const role = roleOf(message) || "unknown";
      const id = typeof message?.id === "string" && message.id.length > 0 ? message.id : "?";
      const summary = oneLine(String(summaryOf(message) ?? ""), INDEX_SUMMARY_MAX) || "（无摘要）";
      indexLines.push(`- [${role}] ${id}: ${summary}`);
    }
    const omitted = evicted.length - shown.length;
    if (omitted > 0) {
      indexLines.push(`（还有 ${omitted} 条更早消息，用 thread_history_search 检索）`);
    }
  }

  return {
    selected,
    evicted,
    indexLines,
    tokens: usedTokens,
    reasons: {
      budget,
      keepRecent: recentIndexes.length,
      evicted: evicted.length,
    },
  };
}

/**
 * 把索引行渲染成**一条尾部 user 消息的正文**（标题 + 逐行）。
 *
 * 放在这里而不是接线处：标题与行格式是同一个契约（判据按 `WORKING_SET_INDEX_HEADER` 找它），
 * 两处各写一遍字符串迟早会漂。
 */
export function renderWorkingSetIndexMessage(indexLines: readonly string[]): string {
  if (!Array.isArray(indexLines) || indexLines.length === 0) return "";
  return [WORKING_SET_INDEX_HEADER, ...indexLines].join("\n");
}
