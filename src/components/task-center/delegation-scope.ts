/**
 * 委派任务的显示边界 —— **唯一实现**（第 72 轮审计新增）
 *
 * ## 为什么必须只有一处
 *
 * 真机实测（装机版 1.16.122，无项目时同一屏里两处显示同一个事实）：
 * ```text
 * 概览页签「委派任务」卡： 0 运行中 / 0 已完成 / 0 等待中
 * 委派页签：              5 总计 / 0 运行中 / 3 已完成 / 2 失败
 * ```
 * 根因不是"哪一处算错了"，而是**同一个过滤条件被各写了一遍**：
 * 修「委派」页签时只改了那一处，概览卡还留着旧的 `projectId ? filter : []`。
 * 这类"同一事实多处显示、每处各写一遍口径"的写法，只要改一处就必然对不上 ——
 * 所以把口径收成一个函数，两个调用方都只能用它。
 *
 * ## 口径（三个作用域各自的正确含义）
 *
 * | 当前项目 | 显示的委派任务 |
 * | --- | --- |
 * | 有（`projectId` 非空） | **该项目**的 + **全局**的（`task.projectId` 为空串/未设 —— 从全局会话发起的交接） |
 * | 无（`null`） | **只显示全局**的（没有任何"当前项目"，就不该显示别的项目的） |
 *
 * 跨项目串数据这条（P2-12）没有放松：别的项目的任务在任何情况下都不会出现。
 */
export function scopeDelegations<T extends { projectId?: string | null }>(
  tasks: readonly T[],
  currentProjectId: string | null,
): T[] {
  if (!currentProjectId) return tasks.filter((t) => !t.projectId);
  return tasks.filter((t) => !t.projectId || t.projectId === currentProjectId);
}
