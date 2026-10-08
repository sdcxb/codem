/**
 * 回合（turn）流式文本的**归属路由** 与 保尾**收尾** —— 从 `App.tsx` 里抽出来的纯逻辑。
 *
 * 为什么抽出来（第 184 波 UI 审计 F1/F2/F3）：这三件事原来都写在 `App.tsx` 的巨型组件里，
 * 而"渲染层没有便宜的整机夹具"这条既有教训（见 `core/llm/turn-outcome.ts` 文件头）意味着
 * 它们只能靠**源码文本断言**守着 —— 而源码断言恰恰是让 F1 那种缺陷活下来的原因
 * （判据写的是"某处有某字符串"，而真正漏改的是**另一处**的判据）。
 * 抽成纯函数之后，"在屏会话是谁""无正文也要收尾""中止后收尾事件仍要处理"
 * 都能被行为断言钉住。
 *
 * ## F1：同一件事**只许有一份**「在屏会话」判据
 *
 * 修前 `App.tsx` 对"这个会话此刻在不在屏上"有**两种口径**：
 *  - `isViewingSession()`（面板/工具调用/系统消息）判 `loadedSessionId === session.id`；
 *  - `flushStreamBuffer()` / `flushReasoningBuffer()`（**流式正文**）判
 *    `useProjectStore.getState().currentSession?.id === sessionId`。
 *
 * 而笔记本工作区**从不改 `currentSession`**（第 45 轮 P0-I1 的修法：打开工作区只
 * `setNotebookWorkspaceId` + `loadMessages(笔记本会话)`）。于是笔记本回合里
 * `loadedSessionId` = 笔记本会话、`currentSession` = 主聊天会话 ⇒ 正文两条 flush 路径
 * 都判成"不在屏" ⇒ **笔记本问答的正文从生成到结束界面上都是空的**。
 *
 * 现在判据只有 `isSessionOnScreen()` 一个实现，`App.tsx` 的两条 flush 路径都必须经它。
 *
 * ## "只进 loop 快照"为什么等于"正文丢失"
 *
 * loop 的落库（`persistLoopMessages`）写的是 **loop 自己那份消息快照**，
 * 而快照里的正文**只由 `routeBufferedTextToOwnCopy` 追加**。
 * 所以"没进界面"和"没进快照"必须分开：
 *  - 只进界面（不进快照）⇒ 界面看得到，但回合结束时 loop 的 explicit 落库会把这一行
 *    写成**空壳**（同一行被覆盖，定稿正文丢失）；
 *  - 只进快照（不进界面）⇒ 落库是完整的，但用户在生成期与结束后都看不到
 *    —— 这正是 F1 的真机形态。
 * 修法因此是"**两边都写**"：`routeBufferedTextToOwnCopy` 无条件更新快照，
 * 仅当在屏时再追加进界面那份。
 */

import { useAppStore, type Message } from "../../store";
import { useProjectStore } from "../store";
import { describeTurnOutcome } from "../llm/turn-outcome";

/** 流式文本的一个会话缓冲（正文/推理各自一份，字段同形） */
interface StreamBuffer {
  id: string;
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 流式文本的去向类型 */
export type StreamField = "content" | "reasoning";

/** loop 自己那份消息快照（`App.tsx` 的 `loopMessages` 挂上来的引用） */
interface LoopSnapshot {
  sessionId: string;
  messages: Map<string, Message>;
}

export interface LoopSnapshotRef {
  current: LoopSnapshot | null;
}

/** 在屏会话 id 的来源（`App.tsx` 用 state，测试直接注入） */
export interface ViewStateRef {
  current: string | null;
}

/**
 * ★★ **唯一**的「这个会话此刻在不在屏上」判据（F1）。
 *
 * 两档，顺序有意义：
 *  1. **消息列表的归属**（`loadedSessionId`）：这份 `messages` 装的就是它的消息
 *     ⇒ 它一定在屏上。笔记本工作区打开时它自己 `loadMessages(笔记本会话)`
 *     ⇒ 笔记本会话在屏（修前漏的正是这一支）；
 *  2. **兜底**：列表归属还没落定的开头一瞬（新建会话 / `loadMessages` 未跑）
 *     ⇒ 退回"全局当前会话"。
 *
 * ⚠️ 反向不成立：`currentSession` 指向 A 而 `loadedSessionId` 是 B 时，**在屏的是 B**。
 * 这正是笔记本回合的形态。
 */
export function isSessionOnScreen(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  if (useAppStore.getState().loadedSessionId === sessionId) return true;
  return useProjectStore.getState().currentSession?.id === sessionId;
}

/**
 * 缓冲文本的归属路由（F1 的修法）。
 *
 * 返回 `viewing` 让调用方知道"要不要顺手更新界面" —— 判据本身**不允许**在调用方重算。
 *
 * - `snapshotRef` 命中本会话时**无条件**把增量并进 loop 那份（落库的唯一来源，见文件头）；
 * - `viewing` 为真时返回 `true`，调用方据此追加到界面那份（**两边都有**，缺一即丢）。
 */
export function routeBufferedTextToOwnCopy(params: {
  sessionId: string | undefined;
  messageId: string;
  text: string;
  field: StreamField;
  snapshotRef: LoopSnapshotRef;
  viewRef: ViewStateRef;
}): { viewing: boolean; wroteSnapshot: boolean } {
  const { sessionId, messageId, text, field, snapshotRef, viewRef } = params;
  const viewing = isSessionOnScreen(sessionId);
  viewRef.current = viewing ? sessionId ?? null : null;

  let wroteSnapshot = false;
  const snapshot = snapshotRef.current;
  if (sessionId && text && snapshot && snapshot.sessionId === sessionId) {
    const own = snapshot.messages.get(messageId);
    if (own) {
      snapshot.messages.set(messageId, { ...own, [field]: (own[field] || "") + text } as Message);
      wroteSnapshot = true;
    }
  }
  return { viewing, wroteSnapshot };
}

/**
 * 保尾**收尾**的判定（F2）。
 *
 * 修前整个收尾被 `if (assistantContent)` 罩住 —— 末轮**只调工具、没吐正文**时
 * （第 1 迭代只发 tool_call → 第 2 迭代 LLM 失败/被中断/撞迭代上限），
 * `status` / `metadata` / `generatedFiles` **一律不写**，助手气泡永久停在 `streaming`：
 * 反馈按钮、StatsLine、文件提及全被 `status === "streaming"` 挡掉，
 * 而 `generatedFilesRef` 不清 ⇒ 下一轮"修改了 N 个文件"把上一轮算进来。
 *
 * 所以收尾**与"有没有正文"彻底解耦**：这里只看两件事 ——
 *  ① 这一轮结束了吗（由 `lastEvent` 的 `end` 结果与 `describeTurnOutcome` 决定）；
 *  ② 要写进哪条消息（由调用方给 `assistantMsgId` 决定）。
 *
 * @param generatedFiles 本 loop 累计的产物清单（**调用方负责在收尾后清空**）
 */
export function buildTurnFinalize(params: {
  assistantMsgId: string;
  /** 循环吐的最后一个事件（通常是 `{type:"end", result}`）；没跑到就是 undefined */
  lastEvent?: { type?: string; result?: unknown } | null;
  generatedFiles: string[];
  lang: string;
  /** 收尾时刻（测试可注入，默认 now） */
  now?: number;
}): {
  messageId: string;
  update: {
    status: "done" | "error";
    generatedFiles?: string[];
    metadata?: Record<string, any>;
  };
} {
  const { assistantMsgId, lastEvent, generatedFiles, lang } = params;
  const turnEndTime = params.now ?? Date.now();
  const result = lastEvent && "result" in lastEvent ? lastEvent.result : undefined;

  const metadata: Record<string, any> = {};
  if (result && typeof result === "object") {
    const r = result as any;
    // turn 级状态与呈现共用同一个判据（describeTurnOutcome），不许另立一套
    const outcomeForMeta = describeTurnOutcome(result, { lang });
    if (outcomeForMeta.turnStatus) metadata.turnStatus = outcomeForMeta.turnStatus;
    if (r.usage) {
      metadata.usage = r.usage;
      metadata.turnEndTime = turnEndTime;
    }
  }

  const finalOutcome = describeTurnOutcome(result, { lang });
  return {
    messageId: assistantMsgId,
    update: {
      status: finalOutcome.messageStatus,
      generatedFiles: generatedFiles.length > 0 ? generatedFiles : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
  };
}

/* ======================================================================
 * F3：点「停止」之后仍要处理的收尾
 * ====================================================================== */

/**
 * 中止后**仍然必须处理**的事件类型。
 *
 * 修前 `App.tsx` 的守卫是 `if (sessionAbort.signal.aborted) break;` —— 在 `switch`
 * **之前**，于是中止后到达的**第一个**事件（含引擎随后吐的
 * `agentic-loop.ts:2833` `yield { type:"end", result: abortedResult }`）及其后全部被丢弃：
 *  - `case "end"` 里那句「⏹ 已停止（本轮被中断）」在 App 里**不可达**；
 *  - `status: "running"` 的工具卡片再没有任何回收点 ⇒ 永久转圈、且落库就是 running。
 *
 * 所以中止只筛掉**过程性**事件（text_delta / tool_start / …），
 * 终局事件照旧走完整条 switch。
 */
const TURN_TERMINAL_EVENT_TYPE = "end";

/** 中止后这个事件还要不要处理？*/
export function shouldProcessEventAfterAbort(aborted: boolean, eventType: string): boolean {
  if (!aborted) return true;
  return eventType === TURN_TERMINAL_EVENT_TYPE;
}

/** 中止后工具卡片的终态文案（与「⏹ 已停止」同一件事，见 turn-outcome 的 notice） */
const ABORTED_TOOL_RESULT = "⏹ 已停止：本轮被中断，工具没有跑完";

/**
 * 中止时把**仍为 `running`** 的工具调用收成终态（F3）。
 *
 * `status: "running"` 全仓只有一个写入点（`tool_start`），
 * 而回收只在 `tool_complete` / `tool_error` 两支 —— 中止后这两支的事件都被丢弃
 * ⇒ 卡片转圈 + 落库 running（重启后仍转圈，`repairCrashedSession` 只修事件日志、
 * 不碰 `messages` 行的 `tool_calls[].status`）。
 *
 * 返回 null 表示"没有需要改的"（调用方据此避免无谓的落库与重渲染）。
 */
export function applyAbortToRunningToolCalls(msg: Message | undefined): Message | null {
  if (!msg) return null;
  const toolCalls = msg.toolCalls;
  if (!toolCalls || toolCalls.length === 0) return null;
  let changed = false;
  const next = toolCalls.map((tc) => {
    if (tc.status !== "running") return tc;
    changed = true;
    return { ...tc, status: "error" as const, result: tc.result ?? ABORTED_TOOL_RESULT };
  });
  if (!changed) return null;
  return { ...msg, toolCalls: next };
}
