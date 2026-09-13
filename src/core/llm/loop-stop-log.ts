/**
 * 循环停止原因的结构化记录（第 65 波，L4）。
 *
 * 为什么需要它：第 62–64 波陆续加了四类停止判据（零信息增益 / 空闲 / 计划停滞 / 资源预算），
 * 但只有重复调用守卫那一条落了 EventLog —— 于是**"到底哪种卡法最多"根本统计不出来**，
 * 也没法据此决定下一步该优化哪一个。这里把四类统一成一条可查询的事件。
 *
 * 约定（`reason` 取值，写进文档便于统计）：
 *   · `no_gain`         —— 连续拿到已经见过的完全相同的内容（零信息增益）
 *   · `idle`            —— 连续 N 分钟没有任何事件（沉默）
 *   · `plan_stale`      —— 连续 N 个迭代没有计划推进、也没有产出交付物（先 `plan_stale_ask` 提醒过）
 *   · `budget`          —— 估算 token 超过资源预算
 *   · `*_ask`           —— 对应的"先问一次"（不是停止，但同样值得统计）
 */

export type LoopStopReason =
  | "no_gain"
  | "idle"
  | "tool_hung"
  | "plan_stale"
  | "plan_stale_ask"
  | "budget"
  | "repeat_guard"
  | "args_truncated"
  | "cancelled";

/**
 * 记录一次"循环层面的停止/提醒"。
 *
 * 刻意不抛错、不阻塞：EventLog 是观测设施，写不进去也不该影响任务本身。
 * 但在控制台留一行 warn，方便排查时肉眼看到。
 */
export function recordLoopStop(
  sessionId: string,
  reason: LoopStopReason,
  detail: Record<string, unknown> = {},
): void {
  try {
    // 动态导入：agentic-loop 与 executor 都在热路径上，不希望为了日志把 event-log 拉进启动依赖
    void import("../storage/event-log").then(({ getEventLog }) => {
      try {
        getEventLog().append(sessionId, "loop_stopped", { reason, ...detail });
      } catch (e) {
        console.warn("[loop-stop-log] 写入 EventLog 失败:", e);
      }
    });
  } catch (e) {
    console.warn("[loop-stop-log] 记录停止原因失败:", e);
  }
}
