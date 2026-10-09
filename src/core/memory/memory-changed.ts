/**
 * 「记忆域变了」的**唯一**通知出口（S4 / O-45）。
 *
 * ## 为什么需要它
 *
 * 默认审批开启时，自动提取的记忆先进「待批准」区、**不进上下文**（这是设计）。
 * 在这之前，「有一批待批准正等着」只在用户主动打开记忆面板时才看得见
 * （`MemoryManager.tsx` 的 `.memory-pending-hint` 与顶部「待批准」那格），
 * 而记忆面板是个模态框 —— **离开它就看不见**。于是默认配置下的用户会以为自动记忆不好使
 * （这正是 S4 当初要治的病）。
 *
 * 修法是在**离开面板的常态路径**（侧栏「记忆」入口）上给一个角标。角标要在
 * 「一个模型回合刚提取出一条 pending」之后**自己**出现，就必须有人通知它。
 *
 * ## 为什么是事件而不是轮询
 *
 * 角标要读的是 `getStats(ctx).pendingEntries` —— 它按项目/会话过滤，
 * 每次都要遍历当前作用域内的全部条目。按固定间隔轮询，等于把这个遍历挂在每一次界面刷新上；
 * 而记忆写入本身是**低频**的（一个回合最多一次自动提取）。事件驱动的代价接近 0。
 *
 * 本仓既有 `codem-settings-changed` 走的是同一条路子，但那条事件会让 `App.tsx` 的
 * `configureEngine` 重跑一遍引擎配置 —— 记忆写入不该有那个副作用，所以这里是**独立**事件。
 *
 * ## 谁负责发（**新增写入路径时必须一起发**）
 *
 * - `MemoryService.save()`：普通写入被接受之后；
 * - `MemoryService.saveConfirmed()`：确认式写入成功之后；
 * - `MemoryService.load()`：读盘（含重读、端口就绪后的补读）整份替换内存态之后。
 *
 * 漏发的表现是「角标落后于真实状态」—— 判据 `MEM-BADGE-1`（数字必须等于面板那个数）会红。
 */
/**
 * 事件名。**刻意不导出**：唯一实现是这个模块里的"发一次 / 订阅一次"，
 * 外面直接用那两个函数即可 —— 导出常量只会多一处可以写错字面量的地方
 * （knip 也会如实把它记成"没人用的导出"）。
 */
const MEMORY_CHANGED_EVENT = "codem-memory-changed";

/**
 * 通知「记忆域的状态变了」。**只做通知**：不改任何状态、不吞任何错误结论
 * （订阅方自己决定重读什么；重读失败由各自的读路径如实处理）。
 */
export function notifyMemoryChanged(): void {
  // 判据/工具在 node 环境下引用本模块（没有 window）⇒ 通知退化成空操作，不是错误
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MEMORY_CHANGED_EVENT));
}

/** 订阅记忆域变化；返回取消订阅函数（调用方必须在卸载时调用它）。 */
export function subscribeMemoryChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MEMORY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(MEMORY_CHANGED_EVENT, handler);
}
