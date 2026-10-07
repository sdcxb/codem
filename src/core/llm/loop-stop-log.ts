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
 *   · `plan_stale`      —— 连续 N 个**零进展迭代**没有计划推进、没有产出交付物、
 *                          也没有获得新信息（先 `plan_stale_ask` 提醒过）。
 *                          第 93 波治本：判据从「有没有写盘」扩成「有没有获得新信息」——
 *                          只认写盘会把大仓库里的逐文件探索误杀（一手证据见 stall-guard.ts）。
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
  | "output_truncated"
  | "context_overflow"
  /**
   * 改动了文件却一次都没跑过验证（测试/构建/类型检查）就收尾。
   * 真机与实测都出现过：模型报「任务完成」而缺陷还在（实测 38 次工具调用、判据 3/7 红）。
   * 这个归类是为了能统计"未验证就收尾"到底多常见 —— 它是"假完成"的直接来源。
   */
  | "completed_unverified"
  | "cancelled"
  /**
   * 第 309 波：**回合心跳** ✓ —— 每轮开头一条，用来回答"这一轮**走到第几轮**停住了" ✓。
   *
   * 为什么要有它 ✗：那一批失败轮是**被跑批掐停**的（引擎静默 2 分钟 ✓），
   * `run()` 的收尾段**从没执行** ✗ ⇒ 任何"循环之后"（或"某个出口上"）的记录都到不了 ✓
   * （归档 §13.209 ✓）。心跳写在**循环里面** ✓，是那种轮次里**唯一必然执行到**的报点 ✓。
   *
   * ⚠️ 它**曾经被撤回一次** ✗（§13.210 ✓）：每轮多一条事件 ⇒ 上下文摘要里的
   * `M total events` 变了 ⇒ **破坏 provider 前缀缓存** ✗。
   * 现在 `projectSurface` 的 `totalEvents` **已排除诊断类** ✓（`loop_stopped` / `turn_end` ✓），
   * 所以心跳**不再影响**那个数 ✓ —— **先解结构性约束、再加事件** ✓。
   */
  | "turn_heartbeat";

/**
 * ⚠️ 第 309 波曾在这里加过一个 `"turn_exit"` 归类 ✗，**已撤销** ✓。
 *
 * 理由（值得留着，因为它是一次真实的白改 ✓）：出口原因第一版是写成**会话事件**的 ✓，
 * 结果当场把 `dsh-d5-prefix-cache-stability` 打红 ✗ ——
 * 每轮多一条事件 ⇒ 上下文里 `[Context: … M total events]` 的计数变了 ⇒
 * **第二轮不再以第一轮为前缀** ⇒ 破坏 provider 前缀缓存 ✓（而缓存正是目标②在读的东西 ✓）。
 * ⇒ 改走 `AgenticLoop` 的**实例字段** ✓，由 `executor` 并进**既有的** `turn_end` 事件 ✓
 * （那条本来就存在 ✓，不新增事件 ✓）—— 见 `agentic-loop.ts::noteExit` ✓。
 */

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
