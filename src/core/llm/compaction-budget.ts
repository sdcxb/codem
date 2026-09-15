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
