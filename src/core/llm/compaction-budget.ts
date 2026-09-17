/**
 * 压缩保留集的**预算规划**（第 83 波）
 *
 * 从 `AgenticLoop.doCompactMessages` 抽出来的纯逻辑，抽出来的原因很直接：
 * 这段判断是"压缩到底有没有用"的唯一依据，必须能用例逐条守住，而不是埋在 4000 行的大文件里。
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

  // 折叠后的新入口若正好落在孤儿 tool 结果上，向后推（= 多删）到安全边界
  let start = messages.length - keep;
  while (start < messages.length && messages[start].role === "tool") start++;
  keep = messages.length - start;

  return { keepCount: keep, foldedMarkers, existingSummary };
}
