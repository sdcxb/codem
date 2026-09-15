/**
 * 静默空写探测器（第 83 波）
 *
 * ## 为什么需要它（真实事故）
 *
 * 后台执行路径（`core/session/executor.ts`）在"新一轮开始"时只换了内存里的消息 id、
 * **没有建那一行**，之后所有事件都走 `updateMessage(id, …)` / `addToolCall(id, …)` ——
 * `UPDATE … WHERE id = ?` 影响 0 行，**没有任何报错、没有任何日志**：
 *
 *   · 第 2 轮之后的正文、工具调用、工具结果全部静默丢失；
 *   · 消费方（AgenticLoop）每轮从库里重建上下文 → 看不到自己上轮干过什么 → 无限重试；
 *   · 真机表现："b 会话原地打转、a 会话干等"，排查时只能靠一句
 *     `[SessionJSONL] 更新消息 … 时找不到所属会话` 的旁证。
 *
 * 这类"写了一条不存在的记录"是**跨模块的通病**（不止消息：任务、议题、收件箱、会话设置…），
 * 共同点是**失败不可见**。所以这里做一个统一的探测器：任何有 id 定向的写操作，
 * 只要影响 0 行就记账并告警一次 —— 让"静默"变成"响"。
 *
 * 设计取舍：
 *   · **不抛错、不改控制流**：写入本身可能是合法的幂等操作（例如删一个已经删掉的行），
 *     探测器的职责是"让它可见"，不是"禁止它发生"；
 *   · **按（表+操作）去重告警**，只打第一次 + 每 100 次一次，避免刷屏把真正的问题埋掉；
 *   · 报告可被测试与运行时读取（`getSilentWriteReport()`），便于"审计 → 修复 → 再审计"闭环。
 */

/** 单条统计：哪张表、什么操作、撞了多少次、最近一次是谁 */
export interface SilentWriteEntry {
  table: string;
  op: string;
  count: number;
  /** 最近一次的目标 id（诊断用，可能是空） */
  lastId: string;
  /** 最近一次的调用方提示（调用点自己传，例如函数名） */
  lastFrom: string;
}

const entries = new Map<string, SilentWriteEntry>();
/** 已告警过的 key（每个 key 只打一次 + 每 100 次打一次） */
const warned = new Set<string>();

/** 探测器开关：测试或特殊场景可关闭（默认开） */
let enabled = true;

export function setSilentWriteDetection(on: boolean): void {
  enabled = on;
}

export function isSilentWriteDetectionOn(): boolean {
  return enabled;
}

/**
 * 记录一次写操作的结果。
 *
 * @param table 表名（或逻辑名，例如 `messages.hidden`）
 * @param op 操作名（`update` / `delete` / `hide` …）
 * @param modified `db.getRowsModified()` 的返回值
 * @param ctx 诊断上下文（id / 调用点）
 * @returns 是否属于"影响 0 行"
 */
export function noteWriteResult(
  table: string,
  op: string,
  modified: number,
  ctx: { id?: string; from?: string } = {},
): boolean {
  if (!enabled) return false;
  if (modified > 0) return false;

  const key = `${table}:${op}`;
  const entry = entries.get(key) ?? { table, op, count: 0, lastId: "", lastFrom: "" };
  entry.count++;
  entry.lastId = ctx.id ? String(ctx.id).slice(0, 80) : entry.lastId;
  entry.lastFrom = ctx.from ?? entry.lastFrom;
  entries.set(key, entry);

  const shouldWarn = !warned.has(key) || entry.count % 100 === 0;
  if (shouldWarn) {
    warned.add(key);
    console.warn(
      `[WriteGuard] 空写 #${entry.count}：${table} ${op} 影响了 0 行` +
        (entry.lastId ? `（id=${entry.lastId}）` : "") +
        (entry.lastFrom ? `，调用点：${entry.lastFrom}` : "") +
        ` —— 目标记录不存在或 id 不对，这次写入静默丢失了。`,
    );
  }
  return true;
}

/** 当前报告（按次数倒序；测试与诊断用） */
export function getSilentWriteReport(): SilentWriteEntry[] {
  return [...entries.values()].sort((a, b) => b.count - a.count).map((e) => ({ ...e }));
}

/** 是否观测到过空写 */
export function hasSilentWrites(): boolean {
  return entries.size > 0;
}

/** 清空（测试与"重置诊断数据"用） */
export function resetSilentWriteReport(): void {
  entries.clear();
  warned.clear();
}

/** 只需要 `run` 与 `getRowsModified` 两个方法，避免这里依赖 sql.js 的具体类型 */
export interface GuardedDb {
  run(sql: string, params?: unknown[]): unknown;
  /**
   * sql.js 的 `Database` 运行时有这个方法，但项目用的类型声明里没有 ——
   * 所以标成可选并做鸭子类型判断：拿不到就按"能改到"处理（探测器不该成为新的故障源）。
   */
  getRowsModified?: () => number;
}

/**
 * 执行一次**有 id 定向**的写操作，并顺带检查"是否真的改到了行"。
 *
 * 用法（只用于 UPDATE/DELETE 这类"应该改到某一行"的语句；INSERT 不要用）：
 * ```ts
 * runGuarded(db, "UPDATE messages SET content = ? WHERE id = ?", [content, id],
 *   { table: "messages", op: "update", id, from: "updateMessage" });
 * ```
 *
 * @returns `db.getRowsModified()`（调用方需要时可以据此做补偿逻辑）
 */
export function runGuarded(
  db: GuardedDb,
  sql: string,
  params: unknown[],
  meta: { table: string; op: string; id?: string; from: string },
): number {
  db.run(sql, params);
  let modified = 0;
  try {
    modified = typeof db.getRowsModified === "function" ? db.getRowsModified() : 1;
  } catch {
    // 引擎不支持时按"能改到"处理：探测器不该成为新的故障源
    return 1;
  }
  noteWriteResult(meta.table, meta.op, modified, { id: meta.id, from: meta.from });
  return modified;
}
