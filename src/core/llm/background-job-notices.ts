/**
 * 后台任务**完成通知**（P1-3）—— 后台干完活要主动告诉模型，而不是等它轮询。
 *
 * ## 修的是什么（一条真实缺口，不是"再加个提示"）
 *
 * `terminal_send run_in_background` 的 job 只活在 `TerminalManager` 的内存 Map 里，
 * 完成之后**唯一的取法是模型自己再调 `job_output`**。于是有两种坏结果：
 *
 * 1. **它不知道跑完了** —— 长命令（dev server / 构建 / 测试）跑完的时机不由模型决定，
 *    它要么在下一轮里瞎猜、要么直接宣布"还在跑"；
 * 2. **它知道，但忘了** —— job id 只存在于对话里。压缩把那条消息摘要掉、或者用户开了新会话，
 *    id 就没了；而结果其实还在内存里，没人再去读。
 *
 * ## 为什么放在**会话之外**
 *
 * 这是 mcode-stack `long-command-check` 第 9 条问的那件事：**"一条没人读的结果"要存在
 * 对话历史之外**（比如一张任务表），否则压缩一次就丢。所以这里是一张按会话索引的登记表：
 * 完成即登记，模型**真的读过**才销账（`markBackgroundJobRead`），
 * 与本轮注入了什么无关。压缩只动消息，动不到这张表。
 *
 * ## 注入边界（为什么不直接贴输出）
 *
 * 通知是**追加在尾部**的易变上下文（`agentloop` 的 `trailingTurnContext`），
 * 绝不进 system 前缀（`MEM-PLACE-25` / `dsh-d5-prefix-cache-stability`）。
 * 输出**只有很短时**才带预览：命令输出是不可信文本，把一大段贴进 user 消息
 * 既烧 token 又把不可信内容抬成了指令级输入。超过 `PREVIEW_MAX_CHARS` 一律只给
 * 「多少字符 + 用 job_output 读」。
 *
 * ## 诚实边界
 *
 * - 进程重启后 Map 本来就空，这张表也随之清空 —— 不假装能恢复（Rust 侧还没有按 id 杀/查的入口）；
 * - 通知的投递时机是**下一次迭代**；如果循环已经结束、用户也不再说话，就没有"下一次"。
 *   这是"通知"而不是"唤醒"（子代理的 settlement 能唤醒父循环，是因为父循环在等它）。
 */

/** 单个 job 完成后要登记的事实（全部来自 `TerminalManager`，不含输出正文） */
export interface BackgroundJobCompletion {
  jobId: string;
  /** 承载这条命令的 PTY 会话 */
  terminalId: string;
  /**
   * 归属的对话会话。
   *
   * 空串表示"来源未知"（旧调用点 / 测试）：这类通知对**任何**会话可见，
   * 宁可多报一次，也不要把一条真实结果静默丢掉。
   */
  sessionId: string;
  status: "completed" | "error";
  /** `inferred_idle` / `timeout` —— 前台静默判定的结论，不是"命令真的退出了" */
  waitReason?: string;
  /** 输出字符数（只报大小，不存正文） */
  outputChars: number;
  /**
   * 输出**样本**：调用方只传前 `PREVIEW_MAX_CHARS + 1` 个字符即可。
   *
   * 不传整段输出是刻意的 —— 这张表是"待办清单"，不是输出仓库；正文仍留在
   * `TerminalManager` 里，由 `job_output` 按需读。
   */
  outputSample?: string;
  completedAt: number;
}

/** 每条通知最多带多少字符的预览；超过就只报大小 */
export const PREVIEW_MAX_CHARS = 400;
/** 一个会话最多保留多少条未读通知（防洪） */
const MAX_PENDING_PER_SESSION = 20;
/** 单次注入最多列几条（剩下的下一轮再说） */
const MAX_NOTICES_PER_PROMPT = 6;
/** 同一条通知最多播报几次 —— 没人读就不再唠叨（避免每轮都烧 token） */
export const MAX_ANNOUNCEMENTS = 5;

interface PendingNotice extends Omit<BackgroundJobCompletion, "outputSample"> {
  /** 已净化、且只在很短时才非空的预览 */
  preview: string;
  /** 最近一次播报所属的回合；同一回合内不重复注入 */
  announcedForTurn?: string;
  /** 播报过几次 */
  announcements: number;
}

/** key = sessionId（空串 = 来源未知，对所有会话可见） */
const pending = new Map<string, PendingNotice[]>();

/** 去掉可能被当成系统指令的片段，并把换行压平（预览是一行） */
function sanitizePreview(text: string): string {
  return String(text ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 输出很短时才带预览（长的只报大小，让模型自己 job_output） */
function previewOf(output: string): string {
  const clean = sanitizePreview(output);
  if (!clean) return "";
  return clean.length <= PREVIEW_MAX_CHARS ? clean : "";
}

function bucket(sessionId: string): PendingNotice[] {
  let list = pending.get(sessionId);
  if (!list) {
    list = [];
    pending.set(sessionId, list);
  }
  return list;
}

/**
 * 登记一条"后台任务已完成、但还没人读过"。
 *
 * 同一个 jobId 重复登记（例如 kill 之后又收到完成回调）按最后一次状态覆盖：
 * 这条记录描述的是 job 的终态，不是事件流。
 */
export function noteBackgroundJobCompletion(completion: BackgroundJobCompletion): void {
  const list = bucket(completion.sessionId);
  const existing = list.findIndex((n) => n.jobId === completion.jobId);
  const { outputSample, ...facts } = completion;
  const notice: PendingNotice = {
    ...facts,
    preview: previewOf(outputSample ?? ""),
    announcements: existing >= 0 ? list[existing].announcements : 0,
    announcedForTurn: existing >= 0 ? list[existing].announcedForTurn : undefined,
  };
  if (existing >= 0) list.splice(existing, 1, notice);
  else list.push(notice);
  // 防洪：只保留最近的 MAX_PENDING_PER_SESSION 条（最老的先丢）
  while (list.length > MAX_PENDING_PER_SESSION) list.shift();
}

/** 模型真的读过这条结果了 —— 销账。返回是否确实销掉了一条。 */
export function markBackgroundJobRead(jobId: string): boolean {
  let removed = false;
  for (const [key, list] of pending) {
    const next = list.filter((n) => n.jobId !== jobId);
    if (next.length !== list.length) {
      removed = true;
      if (next.length === 0) pending.delete(key);
      else pending.set(key, next);
    }
  }
  return removed;
}

/** 这条 job 是否还挂着"未读"（供 job_list / 测试使用） */
export function isBackgroundJobUnread(jobId: string): boolean {
  for (const list of pending.values()) {
    if (list.some((n) => n.jobId === jobId)) return true;
  }
  return false;
}

/** 只读快照（测试 / 诊断用；顺序 = 完成顺序） */
export function listPendingBackgroundJobNotices(
  sessionId?: string,
): ReadonlyArray<Omit<BackgroundJobCompletion, "outputSample">> {
  if (sessionId !== undefined) {
    return [...(pending.get(sessionId) ?? []), ...(pending.get("") ?? [])].map((n) => ({ ...n }));
  }
  return [...pending.values()].flat().map((n) => ({ ...n }));
}

/** 测试 / 维护：清空（`sessionId` 省略时清全部） */
export function clearBackgroundJobNotices(sessionId?: string): void {
  if (sessionId === undefined) pending.clear();
  else pending.delete(sessionId);
}

function formatOne(n: PendingNotice): string {
  const status = n.waitReason ? `${n.status}, ${n.waitReason}` : n.status;
  const size = `${n.outputChars.toLocaleString("en-US")} chars`;
  const head = `- ${n.jobId} [${status}, ${size}] → \`job_output({"jobId":"${n.jobId}"})\``;
  if (!n.preview) return head;
  return `${head}\n  preview (untrusted command output, short enough to inline): ${n.preview}`;
}

/**
 * 为本回合收集通知文本。
 *
 * - **同一回合内只播一次**（`announcedForTurn`），所以循环里的每次迭代不会重复烧 token；
 * - **不销账**：没被 `job_output` 读过的，下一回合还会再出现（这才是"压缩后仍能 surface"）；
 * - 播报 `MAX_ANNOUNCEMENTS` 次仍未读的，主动丢弃 —— 没人要的结果不该永久占位。
 *
 * @param sessionId 当前对话会话
 * @param turnId    本回合的稳定标识（`AgenticLoop.run` 每次进入生成一个）
 */
export function collectBackgroundJobNotices(sessionId: string, turnId: string): string {
  const merged = [...(pending.get(sessionId) ?? []), ...(pending.get("") ?? [])];
  if (merged.length === 0) return "";

  const fresh = merged.filter((n) => n.announcedForTurn !== turnId);
  if (fresh.length === 0) return "";

  const shown = fresh.slice(0, MAX_NOTICES_PER_PROMPT);
  for (const n of shown) {
    n.announcedForTurn = turnId;
    n.announcements += 1;
  }

  // 播报太多次还没人读：从登记表里退场（下回合不再出现）
  for (const [key, list] of pending) {
    const kept = list.filter((n) => n.announcements < MAX_ANNOUNCEMENTS);
    if (kept.length === 0) pending.delete(key);
    else if (kept.length !== list.length) pending.set(key, kept);
  }

  const more = merged.length - shown.length;
  const lines = [
    "## Background jobs finished (unread)",
    "These jobs finished while you were working. Their output is **not** in this conversation",
    "yet — read it before you assume the result. Each stays listed until you read it with",
    "`job_output` (or kill it, if it is still relevant).",
    "",
    ...shown.map(formatOne),
  ];
  if (more > 0) {
    lines.push(`- …and ${more} more unread job(s); call \`job_list\` to see them.`);
  }
  return lines.join("\n");
}
