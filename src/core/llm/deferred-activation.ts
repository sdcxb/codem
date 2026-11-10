/**
 * 延迟工具（deferred）的**运行期激活** —— Bug 1 的修复核心。
 *
 * ## 为什么需要这一层
 *
 * `tool_search` 原来的行为是：命中延迟工具后，**只在工具结果文本里回一份 schema**，
 * 不改变后续请求的 `tools` 列表。模型于是处在一种荒谬状态：它刚「看到」了
 * `doc_compile` 的参数定义，但下一轮请求的工具表里**没有这个工具** ——
 * 真机上表现为「搜到了、仍然调不了、再搜一遍」，plan 又把「搜索工具」写成步骤，
 * 于是原地打转（取证见 `docs/marketing/evidence/bot-peer-real.txt` §3）。
 *
 * 这一层只记「本会话里哪些延迟工具已经被 tool_search 命中」：
 * - 按 **sessionId** 记忆（同一会话的后续请求/后续 loop 都生效）；
 * - 去重（重复搜索不重复占位）；
 * - 上限 {@link DEFERRED_ACTIVATION_LIMIT} 个，满了按**最久未激活**淘汰（FIFO）；
 * - 只影响**请求侧**的 tools 列表，不改 `ToolDef.shouldDefer` ⇒ 常驻 schema 预算不变。
 *
 * ## 生命周期
 *
 * 进程内 Map，按会话惰性创建；超过 {@link MAX_TRACKED_SESSIONS} 个会话时淘汰最久未
 * 访问的会话（防止长跑进程里无限累积）。每个会话最多记住 8 个工具名，内存有界。
 * 该状态**不落盘**：重启后模型重新 `tool_search` 一次即可，不把运行期激活当成持久事实。
 */

/** 单个会话最多激活多少个延迟工具（超过后淘汰最久未激活的那个） */
export const DEFERRED_ACTIVATION_LIMIT = 8;

/** 最多跟踪多少个会话（LRU，防止进程内无界增长） */
const MAX_TRACKED_SESSIONS = 64;

/** sessionId → 已激活工具名（Map 的插入顺序就是激活顺序，最早的在前） */
const activatedBySession = new Map<string, string[]>();

function touchSession(sessionId: string): string[] | undefined {
  const names = activatedBySession.get(sessionId);
  if (names === undefined) return undefined;
  // 重新插入 = 移到 Map 末尾，让它成为「最近使用」的会话
  activatedBySession.delete(sessionId);
  activatedBySession.set(sessionId, names);
  return names;
}

function evictOldestSessions(): void {
  while (activatedBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = activatedBySession.keys().next().value;
    if (oldest === undefined) break;
    activatedBySession.delete(oldest);
  }
}

interface DeferredActivationResult {
  /** 本次是否真的新增了激活（已激活过 ⇒ false，但工具仍然可用） */
  activated: boolean;
  /** 因为上限被淘汰的工具名（没有淘汰时为 undefined） */
  evicted?: string;
  /** 激活之后的完整列表（按激活顺序，最多 DEFERRED_ACTIVATION_LIMIT 个） */
  names: string[];
}

/**
 * 激活一个延迟工具（幂等）。
 *
 * @param sessionId 会话作用域；空串表示拿不到会话（例如离线判定），此时**不激活**，
 *                  绝不把激活泄漏成全局状态。
 */
export function activateDeferredTool(sessionId: string, toolName: string): DeferredActivationResult {
  const name = String(toolName ?? "").trim();
  if (sessionId === "" || name === "") return { activated: false, names: [] };

  const existing = touchSession(sessionId);
  if (existing === undefined) {
    const names = [name];
    activatedBySession.set(sessionId, names);
    evictOldestSessions();
    return { activated: true, names: [...names] };
  }

  if (existing.includes(name)) {
    return { activated: false, names: [...existing] };
  }

  let evicted: string | undefined;
  if (existing.length >= DEFERRED_ACTIVATION_LIMIT) {
    // 淘汰最久未激活的那个（数组头部），保证「刚搜索到的」一定可调用
    evicted = existing.shift();
  }
  existing.push(name);
  touchSession(sessionId);
  return { activated: true, evicted, names: [...existing] };
}

/** 取本会话已激活的工具名（副本；按激活顺序）。 */
export function getActivatedDeferredTools(sessionId: string): string[] {
  if (sessionId === "") return [];
  const names = touchSession(sessionId);
  return names === undefined ? [] : [...names];
}

