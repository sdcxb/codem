/**
 * 压缩保留集的**预算规划**（第 83 波）
 *
 * 从 `AgenticLoop.doCompactMessages` 抽出来的纯逻辑，抽出来的原因很直接：
 * 这段判断是"压缩到底有没有用"的唯一依据，必须能用例逐条守住，而不是埋在 4000 行的大文件里。
 *
 * ## 第 47 轮：又抽了两块出来，理由是同一个 —— "两处口径"必须变成"一份实现"
 *
 * - `selectMessagesByPriority`：**"送往模型的消息到底是哪几条"**的唯一回答。
 *   它原来只存在于 `AgenticLoop` 里（`private`），而 `ContextMonitor` 面板
 *   用 `listMessages().length` 显示"消息数/占用" —— 两个数字说的不是一件事
 *   （面板数的是"库里有多少行"，模型看到的是"按优先级选完还剩哪些"）。
 *   抽到这里之后，面板与循环**共用同一份选择**，占用率才有可对齐的口径；
 * - `renderStructuredHistorySummary`：历史摘要的**渲染器**。手动压缩原来自己拼
 *   一行行 `substring(0, 100)`，把代码/路径/命令从中间切断，且"可有可无"的结论
 *   （文件路径、错误串、待办）全丢了 —— 与自动压缩的 LLM 结构化检查点不可比。
 *   现在两条路共用同一个渲染器（含"路径/错误/待办"三段），只保留**显式上限**。
 *
 * ## 用户现场（为什么固定"保留最近 20 条"不够）
 *
 * ```
 * [compactMessages] Removed 840 old messages, kept 20 … 请求仍然 105 万 token
 * [compactMessages] Removed 841 old messages, kept 20 … 105 万 token
 * [compactMessages] Removed 841 old messages, kept 20 … 105 万 token   ← 迭代 1→2→3→4 白烧
 * ```
 *
 * 固定的"保留 20 条"完全不看体积：一条大文件读取、一段大粘贴就能让这 20 条自己顶满窗口，
 * 于是压缩**永远压不进窗口**，只剩"压缩 → 仍然溢出 → 再压缩"的死循环。
 * 这里按估算 token 成半收缩，并对"连下限都装不下"给出明确判定（压缩救不了，要如实上报）。
 */

// `selectMessagesByPriority` 的默认估算器：与 `AgenticLoop` 用的是**同一个**（CJK 感知）
import { estimateTokens } from "./token-tracker";

/** 保留集预算规划参数 */
export interface CompactionKeepPlanParams {
  /** 会话里可见消息总数 */
  totalMessages: number;
  /** 期望保留的条数（现有实现是 min(20, 总数)） */
  desiredKeep: number;
  /** 保留集的 token 预算（= 窗口的一半，另一半点留给系统提示/工具/输出） */
  budget: number;
  /** 最少保留条数（下限，避免把正在进行的上下文全丢掉） */
  minKeep: number;
  /** 估算"保留最后 N 条"的 token 数 */
  estimate: (keepCount: number) => number;
  /** 把"保留最后 N 条"对齐到安全轮次边界（返回对齐后的条数） */
  align: (desired: number) => number;
}

export interface CompactionKeepPlan {
  /** 最终保留条数（已对齐轮次边界） */
  keepCount: number;
  /** 该保留集的估算 token */
  estimated: number;
  /** 是否发生过收缩 */
  shrunk: boolean;
  /** 收缩到下限后仍超预算（压缩解决不了，调用方应如实上报） */
  overBudget: boolean;
  /** 收缩前的保留条数（用于日志对比） */
  initialKeep: number;
}

/**
 * 规划保留集：先按期望条数，超预算就**成半收缩**（每次至少减到一半，且不越过下限），
 * 直到进预算或触到 `minKeep`。
 *
 * 为什么是"成半"而不是"每次减一条"：整个会话可能有上千条消息，一条一条试会在大会话上
 * 反复估算（每次估算都要遍历保留集），成半收敛是 O(log n) 次估算。
 */
export function planCompactionKeep(params: CompactionKeepPlanParams): CompactionKeepPlan {
  const { totalMessages, budget, minKeep, estimate, align } = params;
  const initialKeep = align(Math.max(1, Math.min(params.desiredKeep, totalMessages)));
  let keepCount = initialKeep;
  let estimated = estimate(keepCount);

  if (estimated <= budget) {
    return { keepCount, estimated, shrunk: false, overBudget: false, initialKeep };
  }

  while (keepCount > minKeep && estimated > budget) {
    const next = Math.max(minKeep, Math.floor(keepCount / 2));
    const aligned = align(next);
    // 对齐可能因为边界回退而不减反增；保底直接砍到 next，避免死循环
    keepCount = aligned >= keepCount ? next : aligned;
    estimated = estimate(keepCount);
  }

  return {
    keepCount,
    estimated,
    shrunk: keepCount < initialKeep,
    overBudget: estimated > budget,
    initialKeep,
  };
}

/**
 * 把"保留最后 N 条"对齐到安全的轮次边界。
 *
 * 为什么要对齐：保留集若从**工具结果消息**（role=tool）中间开始，请求里就会出现
 * "没有对应 tool_use 的 tool_result"，多数 provider 直接 400。
 * 规则：从期望位置往前找最近的一条 assistant / user 消息作为边界。
 *
 * @returns 对齐后的保留条数（1..messages.length）
 */
export function alignKeepToRoundBoundary(
  messages: Array<{ role?: string }>,
  desiredCount: number,
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const keep = Math.max(1, Math.min(desiredCount, messages.length));
  if (keep >= messages.length) return messages.length;
  let boundary = messages.length - keep;
  while (boundary > 0 && messages[boundary].role !== "assistant" && messages[boundary].role !== "user") {
    boundary--;
  }
  return messages.length - boundary;
}

// ========== 压缩标记的折叠（第 45 轮：摘要累积 P1-D4） ==========

/**
 * 摘要标记的前缀。
 *
 * 自动压缩写 `[上下文已自动压缩]`（`agentic-loop.ts`），手动压缩写 `[上下文已手动压缩]`
 * （`ContextMonitor.tsx`）。两条路径写的都是**普通可见 user 行**，所以"哪些行是摘要标记"
 * 这件事必须由**一份共享判定**回答 —— 原来只有自动路径认第一种前缀，
 * 手动标记因此永远折叠不了（也不会被任何清理路径看到）。
 */
export const COMPACTION_MARKER_PREFIXES = ["[上下文已自动压缩]", "[上下文已手动压缩]"] as const;

/** 这一行是不是压缩摘要标记（role=user + 已知前缀） */
export function isCompactionMarker(message: { role?: string; content?: unknown }): boolean {
  if (!message || message.role !== "user") return false;
  const content = typeof message.content === "string" ? message.content : "";
  return COMPACTION_MARKER_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * 压缩摘要标记的**主键生成器**（自动 / 手动两条写路径共用）。
 *
 * ## 为什么不能是 `compact-${Date.now()}`（第 45 轮复核：偶发"摘要标记凭空消失"）
 *
 * `messages.id` 是**全局主键**（不是"会话内唯一"），而 `Date.now()` 只有毫秒粒度。
 * 两次压缩的"写标记"这一步落在同一毫秒时就会共用主键，而这一步在标记写入前
 * **一定**先软删了旧标记（`messagesToRemove` 覆盖它），于是：
 *
 * 1. **同一会话**：新标记写进"刚刚被软删的那一行"。而
 *    - 引擎侧 `messages_upsert_index` 对**不传** `hidden` 的写入刻意保留库里已有的
 *      hidden（`codem-db/src/repo.rs:1018-1031`，用例
 *      `engine_tests.rs:1088 upsert_index_preserves_hidden_unless_explicitly_given`），
 *      渲染侧 `writeIndexViaRust` 的 params 里也确实没有 `hidden`（`message.ts:1507-1519`）；
 *    - 读路径还会叠加"本进程隐藏过"的 `localHiddenIds`（`message.ts:1294` 只增不减，
 *      `message.ts:616` 无条件并进 hidden 集合）。
 *    两个来源都还认为这个 id 是隐藏的 ⇒ **新摘要标记写成功却读不到**：
 *    上下文里既没有摘要、也没有被摘要的原文，用户看到的是"压缩完，摘要没了"。
 * 2. **不同会话**：后一个会话的标记按主键覆盖前一个会话那一行（`session_id` 是被提供的列），
 *    于是前一个会话的摘要标记整行**归属被抢走** —— 实测（探针）：两个会话冻结在同一毫秒压缩，
 *    最终 `messages` 表里只剩一条 `compact-…` 行，`session_id` 是后一个会话的。
 *
 * 所以主键必须带一个**进程内单调递增**的序号（毫秒前缀保留，便于排查/排序）：
 * 同一毫秒内连续压缩多少次都不会撞车，且"时间不前进"时也不会撞。
 *
 * ## 边界（如实记下）
 *
 * 序号只在进程内单调；跨进程（两个实例连同一个库）仍靠毫秒前缀区分 —— 与仓库里
 * 其它 id 生成器（`core/agent-teams/engine.ts:19` 的 `genId`）同一量级的保证，不更高。
 */
let compactionMarkerSeq = 0;

/**
 * 生成一个不会与本次进程内任何已生成值重复的压缩标记主键。
 *
 * @param scope `"auto"` = 自动压缩（`agentic-loop.ts` 的 `doCompactMessages`）；
 *              `"manual"` = 手动压缩（`ContextMonitor.tsx` 的 `manualCompact`）。
 *              前缀必须能被 `isCompactionMarker` 认出来（两者都是标记，只是来源不同）。
 */
export function nextCompactionMarkerId(scope: "auto" | "manual"): string {
  compactionMarkerSeq += 1;
  return scope === "manual"
    ? `compact-manual-${Date.now()}-${compactionMarkerSeq}`
    : `compact-${Date.now()}-${compactionMarkerSeq}`;
}

export interface CompactionBoundaryPlan {
  /** 折叠旧标记**之后**的保留条数（remove 集 = 前 total - keepCount 条） */
  keepCount: number;
  /** 从保留集里被折叠进待删集的旧标记条数（诊断/用例断言用） */
  foldedMarkers: number;
  /** 待删集里**最新**那条摘要标记的正文（用于级联摘要），没有则为空串 */
  existingSummary: string;
}

/**
 * 决定"删哪些、留哪些"，并把保留集里的**旧摘要标记**一并折叠进待删集。
 *
 * ## 为什么需要这一步（P1-D4 / C13：摘要累积）
 *
 * 摘要标记落到保留集里时会发生两件坏事（两件都是静默的）：
 * 1. 级联摘要失效：找旧标记的搜索范围只有"待删集"，标记在保留集里 ⇒ 找不到 ⇒
 *    `existingSummary` 为空 ⇒"摘要的摘要"在最常见的形态下不生效，早期上下文直接丢；
 * 2. 标记永久留在上下文里：没有任何路径把它设为 hidden，于是上下文不断堆积
 *    "请基于以上摘要继续工作"的块 —— 与"压缩让上下文变小"的目标正好相反。
 *
 * ## 为什么"折叠到最后一个标记"（而不是只删那一条）
 *
 * 待删集必须是一个**连续前缀**（`messages.slice(0, len - keepCount)`）：保留集是从尾部
 * 起算的连续一段，中间挖洞会让"删哪些"不再可表达。所以保留集里最靠后的那个标记
 * 之后才能留，它之前的（含标记自身）全部进待删集。
 *
 * 折叠后的保留集入口是"上一个保留集的起点"（标记写在它前面一条），
 * 也就是当时已经对齐好的轮次边界；万一不是，再把入口**向后**推过 role=tool 的孤儿结果
 * （向后推 = 多删，方向安全 —— 它的 tool_use 已经被删掉了）。
 *
 * @param messages 可见消息（已过滤 hidden），顺序即上下文顺序
 * @param keepCount 期望保留条数（已按预算/轮次边界规划）
 */
export function foldStaleCompactionMarkers(
  messages: Array<{ role?: string; content?: unknown }>,
  keepCount: number,
): CompactionBoundaryPlan {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { keepCount: 0, foldedMarkers: 0, existingSummary: "" };
  }
  let keep = Math.max(1, Math.min(keepCount, messages.length));

  /**
   * 找保留集里**最靠后**的标记：它是最新的一次压缩留下的，
   * 而它带的摘要已经包含了它之前所有的摘要（每次压缩都是"摘要 + 新增对话"的合并结果）。
   */
  let foldedMarkers = 0;
  let existingSummary = "";
  const removeStart = messages.length - keep;
  for (let i = messages.length - 1; i >= removeStart; i--) {
    if (!isCompactionMarker(messages[i])) continue;
    foldedMarkers = messages.slice(i).filter(isCompactionMarker).length;
    existingSummary = String(messages[i].content ?? "");
    keep = messages.length - (i + 1);
    break;
  }

  // 没在保留集里找到标记：仍要从待删集里取"最新的一条标记"做级联摘要
  if (foldedMarkers === 0) {
    for (let i = messages.length - keep - 1; i >= 0; i--) {
      if (isCompactionMarker(messages[i])) {
        existingSummary = String(messages[i].content ?? "");
        break;
      }
    }
  }

  /**
   * ## ⚠️ 第 47 轮补（功能上下文审计 P1）：`keepCount` **绝不能是 0**
   *
   * 缺陷形态（真会被 `slice(-0)` 放大成灾难）：标记正好是**最后一条**消息时
   * 上面那段循环取到 `i === messages.length - 1`，于是
   * `keep = messages.length - (i + 1) === 0`。而调用方写的是
   * `messagesToKeep = messages.slice(-keepCount)` —— **JS 里 `slice(-0) === slice(0)`**，
   * 于是"保留 0 条"实际变成"**保留全部**"，而
   * `messagesToRemove = messages.slice(0, len - 0)` 变成"**删掉全部**"：
   * 一次压缩把整个会话的可见历史全隐藏掉，只留一条有损摘要，且没有反悔路径。
   *
   * 触发前提窄但不荒唐：标记的判据是"user 行且正文以 `[上下文已自动压缩]` 开头"
   * （`isCompactionMarker`），所以**用户把摘要正文粘回对话**就会造出这个状态。
   *
   * 这里把下限钉在 1（保留标记本身）：压缩的语义是"删掉标记**之前**的内容"，
   * 标记必须留着，否则摘要本身也被删掉、以后没法级联。
   */
  if (keep <= 0 && messages.length > 0) {
    keep = 1;
    console.warn(
      "[compaction] 保留数为 0（标记正好是最后一条）→ 收敛为 1：保留摘要本身，" +
        "否则 slice(-0) 会把整段历史都算进待删集（一次压缩清空会话）",
    );
  }

  // 折叠后的新入口若正好落在孤儿 tool 结果上，向后推（= 多删）到安全边界
  let start = messages.length - keep;
  while (start < messages.length && messages[start].role === "tool") start++;
  keep = messages.length - start;

  return { keepCount: keep, foldedMarkers, existingSummary };
}

// ========== 送往模型的消息选择（第 47 轮：从 AgenticLoop 抽出，两处共用一份） ==========

/**
 * 按优先级在 token 预算内选择送给模型的消息。
 *
 * 优先级（与 `AgenticLoop` 原实现逐字一致，抽取不改语义）：
 *   4 CRITICAL — 压缩摘要标记（历史结论，必须留）
 *   3 HIGH     — 用户消息（意图必须留）
 *   2 MEDIUM   — 带 tool_calls 的助手消息 / 近期的
 *   1 LOW      — 陈旧的工具结果与纯文本助手消息
 *
 * @param messages 已经是"模型视角"的消息列表（**不含 hidden**；见调用方口径说明）
 * @param maxTokens 预算（真实现用"真实窗口的 90%"）
 * @param estimateTokens 估算函数（默认注入 `token-tracker` 的实现，单独抽参数是为了纯函数可测）
 */
export function selectMessagesByPriority(
  messages: any[],
  maxTokens: number,
  estimateTokensFn?: (text: string) => number,
): any[] {
  if (messages.length === 0) return [];
  const estimate = estimateTokensFn ?? estimateTokens;

  // Estimate tokens for each message with the shared estimator (CJK-aware).
  const tokens = messages.map((msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    return Math.max(1, Math.ceil(estimate(content)));
  });

  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  if (totalTokens <= maxTokens) return [...messages]; // Everything fits

  // Assign priorities
  const recencyThreshold = Math.floor(messages.length * 0.7);
  const priorities = messages.map((msg, i) => {
    const content = typeof msg.content === "string" ? msg.content : "";
    const isRecent = i >= recencyThreshold ? 1 : 0;

    // Compaction markers — CRITICAL
    if (msg.role === "user" && content.startsWith("[上下文已自动压缩]")) return 4;
    // User messages — HIGH
    if (msg.role === "user") return 3;
    // Assistant with tool calls — MEDIUM
    if (msg.role === "assistant" && (msg as any).tool_calls) return 2 + isRecent;
    // Tool results — LOW-MEDIUM
    if (msg.role === "tool") return 1 + isRecent;
    // Assistant text-only — LOW
    return 1 + isRecent;
  });

  // Greedy selection: keep by priority tier, most recent first within each tier
  const selected = new Set<number>();
  let usedTokens = 0;

  // Tier 1: CRITICAL + HIGH (always keep)
  for (let i = 0; i < messages.length; i++) {
    if (priorities[i] >= 3) {
      selected.add(i);
      usedTokens += tokens[i];
    }
  }

  // Tier 2: MEDIUM (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (priorities[i] >= 2 && !selected.has(i)) {
      if (usedTokens + tokens[i] <= maxTokens) {
        selected.add(i);
        usedTokens += tokens[i];
      }
    }
  }

  // Tier 3: LOW (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!selected.has(i)) {
      if (usedTokens + tokens[i] <= maxTokens) {
        selected.add(i);
        usedTokens += tokens[i];
      }
    }
  }

  // Build result preserving order, with truncation for oversized tool results
  const result: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!selected.has(i)) continue;
    let msg = messages[i];
    // Truncate very large tool results if over 90% budget
    if (msg.role === "tool" && usedTokens > maxTokens * 0.9) {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.length > 5000) {
        const truncated = content.substring(0, 2000) + "\n...(truncated for context budget)";
        usedTokens -= tokens[i];
        usedTokens += Math.max(1, Math.ceil(estimate("x".repeat(2000))));
        msg = { ...msg, content: truncated };
      }
    }
    result.push(msg);
  }

  return result;
}

/**
 * `selectMessagesByPriority` 包成"用量形状"的估算器（`ContextMonitor` 面板用）。
 *
 * ## 为什么需要它（P2-D8/D12 的另一半）
 *
 * 判定"本次新产生"之外，"占用是多少"这件事在面板与循环里必须是**同一个算法** ——
 * 之前面板直接把 `listMessages()` 全量丢给 `ContextManager.calculateBudgetFromMessages`，
 * 那里面包含被软删的历史与被裁掉的旧消息，于是面板显示"占用 130%"而模型其实只收到一半。
 * 这个函数返回模型**实际会收到**的那几条，以及它们的估算 token 合计。
 */
export function summarizeModelContext(
  messages: any[],
  contextWindow: number,
  estimateTokensFn?: (text: string) => number,
): { selected: any[]; usedTokens: number; budgetTokens: number } {
  const estimate = estimateTokensFn ?? estimateTokens;
  const budgetTokens = Math.max(16_000, Math.round(contextWindow * 0.9));
  const selected = selectMessagesByPriority(messages, budgetTokens, estimate);
  const usedTokens = selected.reduce((sum, m) => {
    const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    return sum + Math.max(1, Math.ceil(estimate(content)));
  }, 0);
  return { selected, usedTokens, budgetTokens };
}

// ========== 历史摘要的结构化渲染（第 47 轮：手动压缩与自动路径共用） ==========

/** 结构化历史摘要的渲染上限（每条 / 每段） */
export interface HistorySummaryCaps {
  /** 单条用户请求的字符上限 */
  userChars: number;
  /** 单条 AI 正文的字符上限 */
  assistantChars: number;
  /** 单个工具调用的参数 / 结果字符上限 */
  toolChars: number;
  /** 整个摘要的字符上限 */
  totalChars: number;
}

const DEFAULT_HISTORY_SUMMARY_CAPS: HistorySummaryCaps = {
  userChars: 2000,
  assistantChars: 1500,
  toolChars: 400,
  totalChars: 8000,
};

/**
 * 把一批即将被移除的消息渲染成**结构化、可比、不丢结论**的摘要文本。
 *
 * ## 它替换掉的是什么（P2-D8 的缺陷形状）
 *
 * ```ts
 * const snippet = (msg.content || "").substring(0, 100);   // ← 从中间切断代码/路径/命令
 * summaryParts.push(`- 工具调用: ${tc.tool}`);              // ← 只有名字，参数与结果全丢
 * if (summary.length > 1000) summary = summary.substring(0, 1000) + "…";  // ← 全局砍尾
 * ```
 *
 * 后果：一个几十万 token 的会话被压成 ≤1000 字符、且切断位置毫无意义 —— 恢复工作时
 * 既不知道动过哪些文件、也不知道报过什么错。下面四条是这次修的**最小契约**：
 *
 * 1. **不按 100 字截断**：每条消息给小得多的上限（默认 2000 → 实际内容基本完整），
 *    截断时明确写"（本条超出上限 N 字符已省略）"，而不是静默切断；
 * 2. **工具调用三段留全**：`名字 → 参数 → 结果`（各带上限），不再只留名字 ——
 *    "改过哪个文件、跑过什么命令、结果是什么"正是恢复工作最需要的事实；
 * 3. **抽出三段可检索结论**：`涉及文件`（从工具参数里的路径/命令抽取）、
 *    `错误`（含 error/失败/异常 的行）、`待办`（含 TODO/待办/未完成 的行）——
 *    这三段是自动路径 LLM 检查点契约里的段，手动路径以前完全对不上；
 * 4. **总量上限是显式的、分段计数的**：超限时按"最老的先丢"裁剪每一段，
 *    并在末尾如实写"共 N 条消息，正文合计 M 字符（已按上限裁剪）"，
 *    于是"摘要被裁剪过"这件事本身是可见的（原来那个 `...(更多历史已省略)` 只有一句话，
 *    看不出丢了多少）。
 */
export function renderStructuredHistorySummary(
  messages: Array<{
    role?: string;
    content?: unknown;
    toolCalls?: Array<{ tool?: string; args?: unknown; result?: unknown; status?: string }>;
  }>,
  caps: HistorySummaryCaps = DEFAULT_HISTORY_SUMMARY_CAPS,
): string {
  const clip = (text: string, max: number): string => {
    const s = String(text ?? "");
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…（本条超出上限 ${s.length - max} 字符已省略）`;
  };
  /** 从内容里抓"看起来是路径 / 命令 / 错误 / 待办"的行（去重、保序、有上限） */
  const collectLines = (
    text: string,
    match: RegExp,
    limit = 12,
  ): string[] => {
    const out: string[] = [];
    for (const rawLine of String(text ?? "").split("\n")) {
      const line = rawLine.trim();
      if (!line || !match.test(line)) continue;
      const clipped = clip(line, 200);
      if (!out.includes(clipped)) out.push(clipped);
      if (out.length >= limit) break;
    }
    return out;
  };

  const requests: string[] = [];
  const replies: string[] = [];
  const toolLines: string[] = [];
  const files = new Set<string>();
  const errors = new Set<string>();
  const todos = new Set<string>();
  let bodyChars = 0;

  const argsToText = (args: unknown): string => {
    if (args === undefined || args === null) return "";
    if (typeof args === "string") return args;
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  };

  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "";
    bodyChars += content.length;
    if (msg.role === "user") {
      const text = clip(content, caps.userChars);
      if (text.trim()) requests.push(`- ${text}`);
      for (const l of collectLines(content, /(?:[A-Za-z]:\\|\/|\.\/)[^\s"'`]+/)) files.add(l);
      for (const l of collectLines(content, /(?:error|Error|错误|失败|异常)/)) errors.add(l);
      for (const l of collectLines(content, /(?:TODO|待办|未完成|还没|尚未)/)) todos.add(l);
    } else if (msg.role === "assistant") {
      const text = clip(content, caps.assistantChars);
      if (text.trim()) replies.push(`- ${text}`);
      for (const l of collectLines(content, /(?:error|Error|错误|失败|异常)/)) errors.add(l);
      for (const l of collectLines(content, /(?:TODO|待办|未完成|还没|尚未)/)) todos.add(l);
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const argsText = clip(argsToText(tc?.args), caps.toolChars).replace(/\s+/g, " ");
          const resultText = clip(
            typeof tc?.result === "string" ? tc.result : tc?.result ? argsToText(tc.result) : "",
            caps.toolChars,
          ).replace(/\s+/g, " ");
          toolLines.push(
            `- ${tc?.tool ?? "(未知工具)"}${tc?.status ? ` [${tc.status}]` : ""}: ${argsText || "(无参数)"}` +
              (resultText ? ` → ${resultText}` : " → (无结果)"),
          );
          for (const l of collectLines(argsToText(tc?.args), /(?:[A-Za-z]:\\|\/|\.\/)[^\s"'`]+/)) files.add(l);
          if (tc?.status === "error") {
            const line = clip(`${tc?.tool ?? "(未知工具)"} 执行失败`, 200);
            errors.add(line);
          }
        }
      }
    }
  }

  const sections: string[] = [];
  if (requests.length > 0) sections.push(`## 用户请求\n${requests.join("\n")}`);
  if (replies.length > 0) sections.push(`## AI 回复\n${replies.join("\n")}`);
  if (toolLines.length > 0) sections.push(`## 工具调用（名字 / 参数 / 结果）\n${toolLines.join("\n")}`);
  if (files.size > 0) sections.push(`## 涉及文件\n${[...files].map((f) => `- ${f}`).join("\n")}`);
  if (errors.size > 0) sections.push(`## 错误\n${[...errors].map((e) => `- ${e}`).join("\n")}`);
  if (todos.size > 0) sections.push(`## 待办\n${[...todos].map((t) => `- ${t}`).join("\n")}`);

  let summary = sections.join("\n\n");
  if (summary.length > caps.totalChars) {
    summary = `${summary.slice(0, caps.totalChars)}\n…（摘要超出上限 ${summary.length - caps.totalChars} 字符已省略）`;
  }
  return `（共 ${messages.length} 条消息，正文字符合计 ${bodyChars}）\n\n${summary}`;
}

