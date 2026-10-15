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

let compactionInProgress = new Set<string>();

/**
 * 当前是否处于压缩过程中（UI 自动保存据此退让）。
 *
 * ★ 第 228 波审计修复：改成**按会话**（原来是进程级单布尔）。
 *
 * 被守的缺陷：会话 A 的压缩会让**会话 B** 的 UI 自动保存被静默丢弃
 * （`store.ts::saveMessages` 只看一个全局布尔，直接 `return`，不排队不重试）。
 * 多会话并行时这是真实的丢消息路径，而"压缩期间不要插入自动保存"这条不变量
 * 本来就只对**同一个会话**成立（压缩整段替换的是那一个会话的消息集合）。
 *
 * @param sessionId 传了就只问这个会话；不传 = "任何会话在压缩中"（给不关心归属的老调用方）
 */
export function isCompactionInProgress(sessionId?: string): boolean {
  if (sessionId === undefined) return compactionInProgress.size > 0;
  return compactionInProgress.has(sessionId);
}

/** 由 `AgenticLoop.compactMessages` / 手动压缩设置。 */
export function setCompactionInProgress(sessionId: string, value: boolean): void {
  if (value) compactionInProgress.add(sessionId);
  else compactionInProgress.delete(sessionId);
}

