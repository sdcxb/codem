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
 * 2. **可见性**：归属会话**不在屏**时，走**既有**的未读水位（`markSessionUnread`）
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
 * 本模块只回答两件事：**这条消息有没有归属**（记进快照）、**要不要留未读痕迹**。
 *
 * ## 判据
 *
 * 行为判据在 `src/test/loop-owned-message.test.ts`（XSESS-1..4，用真 store + 假存储端口）。
 */
import type { Message } from "../../store";
import { getSession } from "../storage/session";
import { markSessionUnread } from "../session/session-read-state";
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
}

export interface DeliverOwnedMessageResult {
  /** 归属会话此刻在不在屏上（在屏时调用方照旧 `addMessage` 进界面） */
  onScreen: boolean;
  /** 是否记进了归属那份快照 */
  recorded: boolean;
  /** 是否真的把归属会话的**已读水位**退了一格（= 侧栏会出现未读徽标） */
  markedUnread: boolean;
}

/**
 * 把一条 App 级消息**交付给它的归属会话**。
 *
 * 只做两件事（界面那一支见文件头）：
 * ① 记进 `ownCopy`（loop 自己那份，落库来源）；
 * ② 归属会话**不在屏**时把它标成未读（`markSessionUnread`）—— 这是"不静默丢"的唯一兜底。
 */
export function deliverOwnedMessage(params: DeliverOwnedMessageParams): DeliverOwnedMessageResult {
  const { sessionId, message, ownCopy } = params;
  if (!sessionId || !message) return { onScreen: false, recorded: false, markedUnread: false };

  const onScreen = isSessionOnScreen(sessionId);

  let recorded = false;
  if (ownCopy) {
    ownCopy.set(message.id, message);
    recorded = true;
  }

  let markedUnread = false;
  if (!onScreen) {
    /*
     * 条数取**库里读到的**（`getSession`），与 `ChatPanel` 推进水位时用的是同一个来源。
     * 读不到（镜像未就绪）就传 0 ⇒ `markSessionUnread` 退回用现有水位当基准，
     * 仍然保证"至少 1 条未读"（见那个函数的说明）。
     */
    let known = 0;
    try {
      known = Number(getSession(sessionId)?.messageCount ?? 0);
    } catch {
      known = 0;
    }
    markedUnread = markSessionUnread(sessionId, known);
  }

  return { onScreen, recorded, markedUnread };
}
