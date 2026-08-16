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
 */
function formatTimestamp(date: Date, timeZone: string): string {
  const iso = date.toISOString(); // 2026-08-16T12:34:56.789Z
  // 获取时区偏移
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absMinutes / 60);
  const offsetMins = absMinutes % 60;
  const offset = `${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  // 去掉毫秒和 Z，加上偏移和 zone
  const isoShort = iso.replace(/\.\d{3}Z$/, "");
  return `${isoShort}${offset} [${timeZone}]`;
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
 */
function findLastVisibleMessageTime(sessionId: string): number | null {
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
  const lastVisibleTime = findLastVisibleMessageTime(sessionId);
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
