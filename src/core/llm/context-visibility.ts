/**
 * 「这一轮到底丢了什么上下文」的**可见通道**（第 122 轮 B 项）。
 *
 * ## 病：模型少了东西，用户这边一片安静
 *
 * `agentic-loop.ts::buildMessages` 在超预算时会做三件事，**三件都只写 `console.warn`**：
 *
 * | 位置 | 做了什么 | 用户的感受 |
 * |---|---|---|
 * | `agentic-loop.ts:3138` | 助手消息的 `tool_calls` 全部没有对应结果 ⇒ 整段 `tool_calls` 被剥掉 | 模型"忘了自己调过什么工具" |
 * | `agentic-loop.ts:3142` | 部分结果被丢 ⇒ 只保留已兑现的 `tool_calls` | 同上 |
 * | `agentic-loop.ts:3161` | `valid.unshift(foldMsg)` —— **给模型**插一条 `[上下文精简]` 摘要 | **看不到**（那行只进模型的消息数组，不落库） |
 *
 * 第一条尤其刺眼：**模型看到的那条"较早的 N 条消息因上下文长度被精简"提示，
 * 用户根本看不到。** 用户能看到的只有"回答质量下降"，于是结论必然是
 * 「这模型不行」——而真实原因是我们把它的上下文抽掉了一半。
 *
 * ## 这个模块做什么
 *
 * 把 `buildMessages` 里那条**已经算出来、只喂给模型**的事实，同时投给界面：
 * 丢了几条、丢了哪些工具的结果、有没有折叠摘要。界面层（`WaterLevelBanner`）
 * 据此把"会发生什么"从**将来时**改成**现在时** —— 不是"再这样下去会丢"，
 * 而是"这一轮已经丢了"。
 *
 * ## 为什么是订阅式而不是返回值
 *
 * `buildMessages` 是循环内部的纯读函数（每轮、每次迭代都调），
 * 把"UI 要不要提示"塞进它的返回值会污染它的契约（它返回的是给模型的消息数组）。
 * 这里走一个**只增不减的旁路**：模块内一张按会话索引的表 + 一个订阅。
 * 它不参与任何决策，失败也不影响循环（写不进去就不提示，绝不抛出）。
 */

export interface ContextDropRecord {
  /** 丢了几条消息（`selectMessagesByPriority` 超预算丢弃的那一批） */
  droppedMessages: number;
  /** 被丢的消息里，各工具的调用次数（`bash: 3` 这种） */
  toolCounts: Record<string, number>;
  /** 被剥掉 `tool_calls` 的助手消息条数（`agentic-loop.ts:3138`） */
  strippedToolCallMessages: number;
  /** 被剥掉的单个 `tool_calls` 条数（`agentic-loop.ts:3142`） */
  strippedToolCalls: number;
  /** 是否插入了折叠摘要行（给模型看的那条 `[上下文精简]`） */
  foldSummaryInserted: boolean;
  /** 最近一次发生的时间（用于界面显示"这一轮"） */
  at: number;
}

/** 按会话 id 存"最近一次丢上下文"的事实。
 *
 * ⚠️ **只保存最近一次**，不累加：界面上写"已累计丢弃 47 条"是误导 ——
 * 用户真正需要知道的是"你刚才这一轮，模型少了多少"。 */
const lastBySession = new Map<string, ContextDropRecord>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * 记录一次上下文丢弃（由 `buildMessages` 调用）。
 *
 * **纯通知，不参与决策**：任何异常都被吞掉 —— 提示条不能因为"记不下来"而
 * 影响模型这一轮拿到的上下文（那才是真正重要的东西）。
 */
export function recordContextDrop(sessionId: string, record: Omit<ContextDropRecord, "at">): void {
  try {
    if (!sessionId) return;
    lastBySession.set(sessionId, { ...record, at: Date.now() });
    version++;
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* 单个订阅者失败不影响其它订阅者，更不影响循环 */
      }
    }
  } catch {
    /* 见函数头：提示是尽力而为，模型上下文是必须的 */
  }
}

/** 读某会话最近一次丢弃事实（没有则 null）。 */
export function readContextDrop(sessionId: string): ContextDropRecord | null {
  if (!sessionId) return null;
  return lastBySession.get(sessionId) ?? null;
}

/** 订阅变化（返回退订函数）。 */
export function subscribeContextDrop(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 当前版本号 —— 供 React 的 `useSyncExternalStore` 之类的订阅方判断"变了没有"。 */
export function contextDropVersion(): number {
  return version;
}

/** 测试用：清空（生产代码不该调它）。 */
export function __resetContextDrops(): void {
  lastBySession.clear();
  version = 0;
}
