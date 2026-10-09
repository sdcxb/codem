/**
 * App 级消息的**归属投递**（"跨会话污染"与"不在屏就静默丢"两面一起修）—— 从 `App.tsx` 抽出来。
 *
 * ## 被守的缺陷（真机形态）
 *
 * `runAgenticLoop` 拿到的是一个**归属会话**（`session`），而 `App.tsx` 的 `addMessage` 写的是
 * **store 里"当前加载的那份消息列表"**（`loadedSessionId`）。两者在 `await` 之后可能**不再是
 * 同一个会话** —— 用户切走了。于是原来那 6 处裸 `addMessage(...)`
 * （会话忙 / 引擎未初始化 / MiMo 认证缺失 / provider 未配置 / 工作树创建失败 / 工作树已创建）
 * 会把错误气泡加进**别人的会话**里（症状：另一个会话凭空多出一条错误）。
 *
 * 把它改成语义正确的"写进归属会话"之后会冒出**第二个**问题：用户此刻已经切到别的会话，
 * 这条气泡他当场看不见 —— 这正是上一轮没敢改它的原因。所以本模块把两面一起做掉：
 *
 * 1. **正确性**：记进 loop 自己那份快照（`ownCopy`，落库的唯一来源）——
 *    写谁的消息由 loop 自己声明，与"用户在看谁"彻底解耦；
 * 2. **落库**（`persist`，可选）：由调用方交出"把这条写进归属会话"的那一步，
 *    本模块**在标未读之前**执行它 —— 顺序是 `O-42` 的实质（见 `deliverOwnedMessage` 的说明）；
 * 3. **可见性**：归属会话**不在屏**时，走**既有**的未读水位（`markSessionUnread`）
 *    ⇒ 侧栏那个 `session-unread-badge` 会出现，用户切回来就看得到 —— **不静默丢**。
 *
 * ## 为什么是未读徽标，而不是横幅 / toast
 *
 * 见 `AGENTS.md` §4 与交接第 50/88/89/90 轮：**只有"用户能采取动作"的提示才展示**；
 * 一条"某个会话里出错了"的消息用户**能**采取动作（切回去重试）⇒ 该让他知道。
 * 而既有机制里最贴近、且**不打断**的就是未读水位/徽标（`core/session/session-read-state.ts`），
 * 所以首选它，**不新造** toast / 横幅。
 *
 * ## 界面那一支**不在**这里（判据只许有一份）
 *
 * "在屏就进界面"仍然由 `App.tsx` 的 `if (isViewingSession()) addMessage(msg);` 负责。
 * "这个会话此刻在不在屏上"只有一份实现 —— `core/ui/loop-stream-state.ts` 的
 * `isSessionOnScreen()`，这里与 App 都读它（同一次同步调用内结果一致，不存在两套口径）。
 * 本模块只回答三件事：**这条消息有没有归属**（记进快照）、**有没有落库**、**要不要留未读痕迹**。
 *
 * ## 判据
 *
 * 行为判据在 `src/test/loop-owned-message.test.ts`（XSESS-1..4，用真 store + 假存储端口）；
 * `O-42` 的时序判据在 `src/test/session-unread-count-visibility.test.ts`（UNREAD-V1..V3）。
 */
import type { Message } from "../../store";
import { getSession } from "../storage/session";
import { markSessionUnread, getSessionReadMark } from "../session/session-read-state";
import { isSessionOnScreen } from "./loop-stream-state";

export interface DeliverOwnedMessageParams {
  /** 这条消息的**归属会话**（不是"当前会话"） */
  sessionId: string | undefined;
  message: Message;
  /**
   * loop 自己那份快照（`App.tsx` 的 `loopMessages`）。
   * 没有快照的调用点（例如 `handleSend` 的斜杠命令）可以省略 —— 那种调用点由调用方自己落库。
   */
  ownCopy?: Map<string, Message>;
  /**
   * **落库这一步**（把这条消息写进归属会话），可选。
   *
   * 给了它就**先落库、再标未读**：写路径（`storage/message.ts::writeIndexViaRust`）会在
   * 同一个同步段里让会话计数可见，于是标未读走精确分支、未读数**恰好 1**（`O-42`）。
   * 省略它 = 调用方自己在别处落库（或压根不落库）⇒ 标未读退到兜底分支
   * （"宁可多显示 1 条"，与第 187 波逐字一致）。
   *
   * 它由调用方给（而不是这里自己 `saveMessages`）是为了**判据只有一份**：
   * "写谁的消息"由 loop 自己那份快照（`ownCopy`）决定，见 `App.tsx::persistLoopMessages`。
   */
  persist?: () => void;
}

export interface DeliverOwnedMessageResult {
  /** 归属会话此刻在不在屏上（在屏时调用方照旧 `addMessage` 进界面） */
  onScreen: boolean;
  /** 是否记进了归属那份快照 */
  recorded: boolean;
  /** 是否真的留下了未读痕迹（= 侧栏会出现未读徽标）：精确分支与兜底分支都算"留下了" */
  markedUnread: boolean;
}

/**
 * 把一条 App 级消息**交付给它的归属会话**。
 *
 * 三件事，**顺序是语义的一部分**（GAP-LIST `O-42`）：
 * ① 记进 `ownCopy`（loop 自己那份，落库来源）；
 * ② `persist`：把这条落进归属会话（App 的 `persistLoopMessages` / `saveMessages`）；
 * ③ 归属会话**不在屏**时把它标成未读（`markSessionUnread`）—— 这是"不静默丢"的唯一兜底。
 *
 * ## ⚠️ 为什么顺序必须是「先写、后标」（`O-42` 的实质）
 *
 * 第 187 波的顺序是**先标、后写**（`deliverOwnedMessage(...)` 排在 `persistLoopMessages()`
 * 之前）—— 标未读那一刻读到的 `message_count` **必然是旧值**，于是水位只能多踩一格
 * （"宁可多显示 1 条"），代价是计数涨上来后徽标显示"2 条"而实际 1 条，**有界但持续**。
 * 现在写路径让计数在**同一个同步段**里可见（见 `storage/message.ts` 的
 * `messageCountAdjustment`），所以先写、再标 ⇒ `known` 就是写入后的真值 ⇒ 未读**恰好 1**。
 *
 * `persist` 是可选参数：省略时按"无法保证计数可见"处理（仍然走兜底分支，行为与第 187 波
 * 逐字一致）—— 于是这条改动对既有调用点是**加法**，不会因为漏传而静默丢徽标。
 */
export function deliverOwnedMessage(params: DeliverOwnedMessageParams): DeliverOwnedMessageResult {
  const { sessionId, message, ownCopy, persist } = params;
  if (!sessionId || !message) return { onScreen: false, recorded: false, markedUnread: false };

  const onScreen = isSessionOnScreen(sessionId);

  let recorded = false;
  if (ownCopy) {
    ownCopy.set(message.id, message);
    recorded = true;
  }

  /*
   * ② 落库（可选）。**必须排在标未读之前**：写路径会把这次写入同步算进读模型，
   * 标未读随后读到的才是"写入后的真值"。落库抛错不吞（由 `saveMessages` 自己上报），
   * 但也不许把这一次投递整个打断 —— 所以放在 try 里，失败就当"没写"（退兜底分支）。
   */
  let persisted = true;
  if (persist) {
    try {
      persist();
    } catch {
      persisted = false;
    }
  }

  let markedUnread = false;
  if (!onScreen) {
    /*
     * 条数取**库里读到的**（`getSession`），与 `ChatPanel` 推进水位时用的是同一个来源。
     * 读不到（镜像未就绪）就传 0 ⇒ `markSessionUnread` 退回用现有水位当基准，
     * 仍然保证"至少 1 条未读"（见那个函数的说明）。
     *
     * `countVisible`：**落库真的执行过**才把这次读数当作"写入后的真值"
     * （写路径保证"写入返回时计数已经同步可见"）。没落库 / 没给 `persist` 时
     * 一律 `false`（走兜底）—— 判据缺省必须退到"宁可多显示 1 条"那一侧。
     *
     * ⚠️ 如实记账：这个布尔在**今天能走到的两支里不改变结果**（`known > prev` 由
     * `markSessionUnread` 的守卫直接返回，`known < prev` 走兜底，两者都不经过它）。
     * 它是**保守缺省 + 意图声明**，不是一条能判红的机器条件 —— 详见
     * `session-read-state.ts::markSessionUnread` 注释里"`countVisible` 不可观察"那一段。
     */
    let known = 0;
    try {
      known = Number(getSession(sessionId)?.messageCount ?? 0);
    } catch {
      known = 0;
    }
    markedUnread = markSessionUnread(sessionId, known, Boolean(persist) && persisted);
    /*
     * `markedUnread` 的语义是"**这条消息现在看得见吗**"（徽标会不会出现），不是
     * "`markSessionUnread` 有没有写水位"：精确分支**刻意不写水位**（计数已经越过水位，
     * 未读本来就是算出来的），此时它的返回值是 `false` —— 若把那个值直接透出去，
     * 调用方与判据就会把"精确地标成未读"读成"没标未读"（XSESS-2 要的正是"留下痕迹"这一事实）。
     * 所以这里按**可观察结果**再判一次：计数 > 水位 ⇒ 徽标会出现。
     */
    if (!markedUnread) {
      const mark = getSessionReadMark(sessionId);
      markedUnread = mark === null || known > mark;
    }
  }

  return { onScreen, recorded, markedUnread };
}
