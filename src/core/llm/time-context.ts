/**
 * TimeContext — 时间上下文注入
 *
 * 设计对标 DSH `@deepseek-ai/dsh-time-context`。
 *
 * 在每轮对话准备时注入时间上下文：
 * - 当前时间戳（ISO + 时区偏移 + IANA zone）
 * - 距离上一条模型可见消息的经过时间
 *
 * 让模型能正确解释无限定的日期和时间。
 *
 * 注入时机：在系统提示词构建阶段，追加到系统消息末尾。
 * 刷新策略：默认每次准备都注入（refreshIntervalMs = 0）。
 *
 * 模型体验：
 * ```markdown
 * Time sampled while preparing turn <turn>, step <step>: <timestamp>
 * Browser time zone for this request: <iana-zone-or-process-fallback>.
 * Elapsed since the preceding model-visible message: <duration-or-unavailable>.
 * ```
 */

import { getEventLog } from "../storage/event-log";
import { listMessages } from "../storage/message";
import { localTimeParts, offsetLabel } from "../time/local-time";

// ========== Configuration ==========

export interface TimeContextConfig {
  /**
   * 时区回退（当无浏览器时区时使用）。
   * 省略则使用进程时区（Node honors TZ）。
   */
  timeZone?: string;
  /**
   * 刷新间隔（毫秒）。0 或省略 = 每次准备都注入。
   * 正值 = 仅当距离上次注入超过此间隔时才注入。
   */
  refreshIntervalMs?: number;
  /**
   * ★ 第 184 波（G7）：**调用方已经读到的消息列表**（可选）。
   *
   * 为什么需要它：本模块回退到"读消息表"来算"距上一条模型可见消息过了多久"，
   * 而调用方（`AgenticLoop`）在**同一轮**里已经全量读过一次消息表（`buildMessages`）。
   * 不传的话就是一轮两次全量读（内存镜像 merge + 全量排序 + map）—— 实测就是这么读的。
   *
   * 语义边界：**只是省一次读**。给了就用、没给就自己读（行为与结果都不变）。
   */
  preloadedMessages?: Array<{ timestamp?: unknown }>;
}

// ========== State ==========

/** 会话级上次注入时间记录 */
interface LastInjection {
  /** 注入时的 wall-clock 时间 */
  timestamp: number;
  /** 当前 turn 编号 */
  turn: number;
  /** 当前 step 编号 */
  step: number;
}

/** 会话级注入历史 */
const injectionHistory = new Map<string, LastInjection>();

// ========== Helpers ==========

/**
 * 获取进程时区 IANA 名称。
 */
function getProcessTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 格式化时间戳为 ISO + 偏移 + IANA zone。
 *
 * ⚠️ **第 189 波 R1 修复**：旧实现取 `date.toISOString()`（**UTC 数字**）→ 去掉 `.000Z`
 * → 再拼本机偏移与 IANA 名。实测（`TZ=Asia/Shanghai`，本地 2026-10-08 06:30）输出
 * `2026-10-07T22:30:00+08:00` —— 解析回 `2026-10-07T14:30Z`，**比真实瞬时早 8 小时**，
 * 而同一请求的系统提示写 `2026-10-08T06:30:00.000+08:00`（`prompt.ts` 的 `minutePrecisionDate`）
 * ⇒ 模型在同一次请求里收到两条互相矛盾的"现在几点"，且更靠后的那条自带时区名、更可能被采信。
 *
 * 现在字段与偏移一律走 `core/time/local-time.ts` 的 `localTimeParts()` / `offsetLabel()`
 * （**允许**的用例是"共用同一处偏移计算"，不许各算一份）；判据 `TIME-CTX-1` 钉住"解析回的瞬时 == 输入瞬时"
 * 以及"与同请求的系统提示 date 表示同一分钟"。
 */
function formatTimestamp(date: Date, timeZone: string): string {
  const p = localTimeParts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local =
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetLabel(p.offsetMinutes)}`;
  return `${local} [${timeZone}]`;
}

/**
 * 格式化持续时间为 compact whole-second units。
 */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0; // backward movement clamps to zero
  if (ms === 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds > 0 ? ` ${remainingSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
}

/**
 * 查找会话中最后一条模型可见消息的时间戳。
 * 从事件日志中查找最后的 user_message / assistant_text / tool_result。
 *
 * ## 第 60 轮补：事件读不到时**回退到消息表**（不许把"读不到"渲染成 unavailable）
 *
 * `getEventLog().readAll(sessionId)` 在该会话的事件镜像没加载完时返回**空数组**
 * （读路由的既定行为，见 `event-log.ts`）—— 而这里原来把"空"直接当成
 * "查不到时间"，于是提示词里写的是 `last activity: unavailable`。
 *
 * 真机形态：应用启动后**第一轮**提示词拼装（`agentic-loop.ts:1267`）往往就是
 * 第一次访问该会话的事件，镜像还没到 —— 模型看到的"上次活动时间"是
 * `unavailable`，而不是真实时长。这不是数据缺陷，是**读不到被当成了没有**。
 * （同一根因在维护审计里闹出过更大的数字：同一份数据两次维护报 934 与 749。）
 *
 * 回退顺序：事件（最准，含工具结果时间）→ 消息表（`MessageStorage.listMessages`，
 * 索引 + 权威日志的合并视图）→ 都没有才返回 null（那才是真的"没有可依据的时间"）。
 */
function findLastVisibleMessageTime(
  sessionId: string,
  preloadedMessages?: Array<{ timestamp?: unknown }>,
): number | null {
  try {
    const events = getEventLog().readAll(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (
        evt.type === "user_message" ||
        evt.type === "assistant_text" ||
        evt.type === "tool_result"
      ) {
        return evt.timestamp;
      }
    }
  } catch {
    // 事件日志可能不存在（新会话）
  }
  /*
   * 回退：消息表（索引 + 权威日志的合并视图）。
   *
   * ⚠️ 必须是**同步**回退：提示词拼装是同步的，需要"这一次就要拿到值"——
   * 任何"后台算好、下次再用"的写法都救不了它要救的那个场景（启动后第一轮）。
   * `message.ts` 不 import `time-context`，所以这里是单向依赖，没有环。
   */
  try {
    // 第 184 波（G7）：调用方在同一轮里已读过就用它，省掉这一轮第二次全量读
    const list = preloadedMessages ?? listMessages(sessionId);
    let last: number | null = null;
    for (const m of list) {
      const ts = Number((m as { timestamp?: unknown }).timestamp);
      if (Number.isFinite(ts) && ts > 0 && (last === null || ts > last)) last = ts;
    }
    if (last !== null) return last;
  } catch {
    // 消息表也不可用：下面返回 null（那才是真的"没有可依据的时间"）
  }
  return null;
}

// ========== Public API ==========

/**
 * 构建时间上下文消息文本。
 *
 * @param sessionId 会话 ID
 * @param turn 当前 turn 编号
 * @param step 当前 step 编号
 * @param config 配置
 * @returns 时间上下文文本，空字符串表示无需注入
 */
export function buildTimeContext(
  sessionId: string,
  turn: number,
  step: number,
  config: TimeContextConfig = {},
): string {
  const now = Date.now();
  const timeZone = config.timeZone || getProcessTimeZone();
  const refreshIntervalMs = config.refreshIntervalMs ?? 0;

  // 检查刷新间隔
  if (refreshIntervalMs > 0) {
    const last = injectionHistory.get(sessionId);
    if (last) {
      const elapsed = now - last.timestamp;
      if (elapsed < refreshIntervalMs) {
        // 未到刷新间隔 — 不注入
        return "";
      }
    }
  }

  // 记录本次注入
  injectionHistory.set(sessionId, { timestamp: now, turn, step });

  // 格式化时间戳
  const timestampStr = formatTimestamp(new Date(now), timeZone);

  // 计算经过时间
  const lastVisibleTime = findLastVisibleMessageTime(sessionId, config.preloadedMessages);
  const elapsedStr = lastVisibleTime
    ? formatDuration(now - lastVisibleTime)
    : "unavailable";

  // 构建消息
  const stepLabel = step === 1
    ? `step 1`
    : `step ${step}`;

  return [
    `Time sampled while preparing turn ${turn}, ${stepLabel}: ${timestampStr}`,
    `Browser time zone for this request: ${timeZone}.`,
    `Elapsed since the preceding model-visible message: ${elapsedStr}.`,
  ].join("\n");
}

/**
 * 清除会话的时间上下文历史（会话结束时调用）。
 */
export function clearTimeContext(sessionId: string): void {
  injectionHistory.delete(sessionId);
}
