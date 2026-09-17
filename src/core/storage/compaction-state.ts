/**
 * 压缩互斥标志（第 18 轮从 `database.ts` 搬出来）。
 *
 * ## 为什么它不该住在 `database.ts`
 *
 * 这个标志**与 sql.js 没有任何关系** —— 它只是"压缩期间不要插入 UI 自动保存"的进程内约定：
 * `AgenticLoop.compactMessages` 在多步操作（删除 → LLM 摘要 → 插标记）的 `await` 空档里
 * 把标志置真，UI 的自动保存看到它就跳过本轮。
 *
 * 它原先住在旧引擎模块里，于是**删引擎时会连带删掉一个仍然有用的并发保护**
 * （`store.ts::saveMessages` / `telemetry.flush` 都在用它）。搬到独立小模块后，
 * 删 `database.ts` 不再需要动这两处调用点。
 *
 * 历史（保留以便查证）：那段注释原本写的是"sql.js 的内部状态会被并发 db.run 搞坏"——
 * 那个具体机制随 sql.js 一起消失了，但"压缩期间的写入要退让"这条**不变量本身仍然成立**
 * （压缩会整段替换消息集合，插进去的自动保存会被后来的写覆盖或反过来覆盖它）。
 */

let compactionInProgress = false;

/** 当前是否处于压缩过程中（UI 自动保存据此退让）。 */
export function isCompactionInProgress(): boolean {
  return compactionInProgress;
}

/** 由 `AgenticLoop.compactMessages` 设置。 */
export function setCompactionInProgress(value: boolean): void {
  compactionInProgress = value;
}
