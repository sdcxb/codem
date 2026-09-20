import { appendSessionMessage, appendMessageTombstone, readSessionMessages } from "./session-jsonl";
import {
  getCachedExternalContent,
  warmExternalContent,
  hydrateAttachmentsForSession,
  externalizeAttachmentContent,
  isExternalContent,
  DEFAULT_EXTERNALIZE_THRESHOLD,
} from "./attachment-files";
import { storageUnavailable } from "./health";
import { getEventLog } from "./event-log";
import { getStoragePort, hasStoragePort } from "./port";
import type { SessionEventType } from "./event-types";
import type { Message, ToolCall, MessageAttachment, RetrievedSource } from "../../store";
import { safeJsonParse } from "../utils/safe-json";
import { reportPersistFailure } from "./persist-failure";
import {
  domainReadMany,
  domainReadOne,
  reportWriteNotAccepted,
} from "./domain-store";

/** `attachments` 表名（P5 第 2 段：外置附件预热也走端口） */
const ATTACHMENT_TABLE = "attachments";

/**
 * 附件正文的**同步缓存**（第 14 轮）。
 *
 * 为什么需要它：`getAttachmentContent()` 是**同步**接口（读取路径遍布同步上下文），
 * 而正文要从引擎按 id 单独取（`attachments.content`，异步 IPC）。解法与附件外置那套
 * 既有约定完全一致：**未命中就发一次异步预取，本次返回 undefined 并提示重试一次**，
 * 下一次同步读命中。
 *
 * 为什么不整表进镜像：正文可能是几十 MB 的长文档 —— 那正是 P6 要消灭的占用
 * （域镜像对 `attachments` 只投影元数据列）。
 */
const attachmentContentCache = new Map<string, string>();
const attachmentWarmInFlight = new Set<string>();

/** 取一次正文并填缓存（未命中时调用；失败只上报，不抛） */
function warmAttachmentContent(id: string): void {
  const port = rustMessagePort();
  if (!port || attachmentWarmInFlight.has(id)) return;
  attachmentWarmInFlight.add(id);
  const probe = port.data as unknown as {
    command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
  };
  const call = probe.command
    ? probe.command<{ content?: string | null }>("attachments.content", { id })
    : port.data.execute("attachments.content", { id });
  void call
    .then((r) => {
      const content = (r as { content?: string | null })?.content;
      if (typeof content === "string") attachmentContentCache.set(id, content);
    })
    .catch((e) => {
      reportPersistFailure("message.attachmentContent", e, "附件正文未取到（下次读取会再试一次）");
    })
    .finally(() => attachmentWarmInFlight.delete(id));
}

/** `message_feedback` 表名（P5 第 11 段：反馈读取走通用域镜像） */
const FEEDBACK_TABLE = "message_feedback";

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  timestamp: number;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  status: string;
  generated_files: string | null;
  retrieved_sources: string | null;
}


function rowToMessage(row: MessageRow, toolCalls: ToolCall[], attachments?: MessageAttachment[]): Message {
  return {
    id: row.id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    status: row.status as Message["status"],
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    generatedFiles: row.generated_files ? safeJsonParse(row.generated_files, undefined) : undefined,
    retrievedSources: row.retrieved_sources ? safeJsonParse(row.retrieved_sources, undefined) : undefined,
  };
}





/**
 * 索引裁剪等待镜像就绪的**整批**预算（毫秒）。
 *
 * 取值依据：真机启动维护的观测值是"19 个域镜像就绪 9 ms"，
 * 而这里的每个会话是**一次分页 IPC**（真机 544 行约几十毫秒）。
 * 5 秒是"网络/磁盘极端慢"与"不能让维护无限期挂住"之间的折中：
 * 健康引擎下永远用不到它，出问题时最多拖住整条维护链 5 秒（而不是 N×5 秒）。
 */
const TRIM_MIRROR_WAIT_TOTAL_MS = 5000;

/** 到整批截止时间还剩多少毫秒（至少 0；已过期就立即返回 0 → 走同步快路径判定） */
function remainingWaitMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * 等某个会话的**消息镜像就绪**（第 44 轮：这是"索引裁剪在生产上从未生效"的根因）。
 *
 * ## 为什么必须有它
 *
 * `trimIndexedMessages` 原来是这样写的：`port.messages.ensureLoaded(sessionId)` 之后
 * **立刻同步**判 `isLoaded(sessionId)`。而真端口的 `ensureLoaded` 是**异步**的
 * （内部 `loadSession` 走 IPC 分页读，见 `rust-port.ts::RustMessageMirror.ensureLoaded`）——
 * 也就是说那一瞬间 `isLoaded` **必然为 false**，于是每个会话都走"镜像未就绪 → 跳过"。
 *
 * 后果是一整条维护步骤在真机上**什么都没做**（真机日志：`索引裁剪 0 条`），
 * 而日志给出的原因还是错的（写成"日志尚未覆盖"）。测试双的 `ensureLoaded` 是同步就绪的，
 * 所以这个缺陷在 CI 里**结构上不可见** —— 与 D3 是同一类偏差。
 *
 * `ensureLoaded(id, cb)` 的契约本来就有回调（已加载时立即调用、加载中时挂到在途任务上），
 * 所以这里直接用它，并且：① 超时兜底（端口卡住时不能让维护永久挂住）；
 * ② 同步就绪的端口立即返回（测试双与"刚被别的路径加载过"这两种情形）。
 */
async function waitForSessionMirror(
  port: {
    messages?: {
      isLoaded(id: string): boolean;
      isTruncated(): boolean;
      ensureLoaded(id: string, cb?: () => void): void;
    };
  },
  sessionId: string,
  timeoutMs = 5000,
): Promise<"ready" | "truncated" | "timeout"> {
  const m = port.messages;
  if (!m) return "timeout";
  const settled = (): "ready" | "truncated" | null => {
    if (!m.isLoaded(sessionId)) return null;
    return m.isTruncated() ? "truncated" : "ready";
  };
  const immediate = settled();
  if (immediate) return immediate;
  return await new Promise<"ready" | "truncated" | "timeout">((resolve) => {
    let done = false;
    const finish = (v: "ready" | "truncated" | "timeout") => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    try {
      m.ensureLoaded(sessionId, () => {
        clearTimeout(timer);
        finish(settled() ?? "timeout");
      });
    } catch {
      clearTimeout(timer);
      finish("timeout");
    }
    // 同步就绪的端口（测试双 / 已在途完成）—— 立即返回
    const after = settled();
    if (after) {
      clearTimeout(timer);
      finish(after);
    }
  });
}

/**
 * 等这些会话的**消息镜像**就绪，返回**读不到**的会话集合（第 62 轮）。
 *
 * ## 为什么单独抽出来（而不是让每个调用方自己写一遍）
 *
 * "镜像未就绪 → 读成空 → 当成没有数据"这个坑在本仓库出现过多次，每一次的后果不同：
 * 索引裁剪**整条从不生效**（第 44 轮）、不变量审计把**每条消息都报成缺口**
 * （第 60 轮，真机 934 vs 749）、**权威日志回填静默 no-op**（第 62 轮，见下）。
 * 三处的修法是同一条：**先等就绪，等不到就如实说"没跑"**。
 * 所以这里把等待逻辑收成一个共用入口，避免第三、第四次各写一版。
 *
 * `backfillAllSessions` 的现场（第 62 轮真机取证）：`CODEM_DB_PATH` 隔离启动一个
 * 从旧库迁移过来的库 → 索引里有消息、日志目录还不存在 → 连续三次维护都打
 * `日志回填 0 条`，而**权威日志一个文件都没建出来** —— 因为 `listMessages` 在
 * 镜像未就绪的窗口里返回空数组，回填循环 `continue` 掉了。日志是这套架构的**权威副本**，
 * 它没被建出来意味着"崩溃重建"这条后路在那次启动里是空的，而日志上看起来一切正常。
 *
 * @returns 仍然读不到的会话 id 集合（调用方必须把它计入"本次没跑"，不许当成"没有数据"）
 */
export async function waitForMessageMirrors(
  sessionIds: readonly string[],
  budgetMs = TRIM_MIRROR_WAIT_TOTAL_MS,
): Promise<Set<string>> {
  const unreadable = new Set<string>();
  const ids = [...new Set(sessionIds.filter((s) => typeof s === "string" && s.length > 0))];
  if (ids.length === 0) return unreadable;
  const port = rustMessagePort();
  if (!port?.messages) {
    // 端口没有 messages 能力（未注册 / 未就绪）：**不在这里造错**，交给调用方按"没有数据源"处置
    return unreadable;
  }
  // 并发发起全部加载，再按**一个共享的截止时间**逐个确认（N 个坏会话只付一次超时）
  const deadline = Date.now() + budgetMs;
  for (const sid of ids) {
    try {
      port.messages.ensureLoaded(sid);
    } catch {
      /* 触发失败：下面按未就绪处理 */
    }
  }
  for (const sid of ids) {
    const readiness = await waitForSessionMirror(port, sid, remainingWaitMs(deadline));
    if (readiness !== "ready") unreadable.add(sid);
  }
  return unreadable;
}

/**
 * 有界裁剪 SQLite 索引 —— **只有确实已在 JSONL 里持久化的消息才允许删**（第 78 波）。
 *
 * 这是"SQLite 只是可重建索引"的落地：权威日志是 append-only JSONL，索引可以随体积增长被裁剪，
 * 但裁剪必须满足**耐久性不变量**：一条消息只要还没进 JSONL，就绝不能被删。
 * 读取侧（`loadMessagesWithDurableLog`）会把 JSONL 与索引合并，被裁掉的历史仍然读得到。
 *
 * 附加约束（数据完整性）：
 *   - 带附件（attachments）的消息**不裁**：附件行不在 JSONL 里，裁消息会级联删掉附件；
 *   - 每个会话至少保留最新 `keepPerSession` 条（默认 500），常用会话完全不触发裁剪。
 *
 * @returns 裁剪的消息数、跳过总数，以及**按原因分解的跳过数**
 *          （第 44 轮：原来只有总数，而日志把三种原因**一律**说成"日志尚未覆盖"——
 *           真机上真实原因是"镜像未就绪"，排查方向因此被日志带偏）
 */
export async function trimIndexedMessages(
  opts: { keepPerSession?: number; mirrorWaitMs?: number } = {},
): Promise<{
  deletedMessages: number;
  skippedSessions: number;
  /** 镜像没能就绪（真端口是异步的；这里会用回调等它） */
  skippedNotLoaded: number;
  /** 镜像存在但被上限截断（集合不完整 → 一律不动；与"没就绪"是两件事） */
  skippedTruncated: number;
  /** 日志里还没有这些消息（耐久性不变量：不裁） */
  skippedNoLog: number;
  /** 有候选但一条都裁不了（带附件 / 日志缺该 id） */
  skippedNoCandidates: number;
}> {
  const keepPerSession = opts.keepPerSession ?? 500;
  const out = {
    deletedMessages: 0,
    skippedSessions: 0,
    skippedNotLoaded: 0,
    skippedTruncated: 0,
    skippedNoLog: 0,
    skippedNoCandidates: 0,
  };

  /**
   * **B 态（rust 引擎）走端口**（P5 第 11 段，真机缺陷修正）。
   *
   * 原实现第一行就是 `getDatabase()`（在 `try` 之外）—— rust 引擎下旧库刻意不加载，
   * 于是整个维护步骤**直接抛错**：索引裁剪在真机上从来没有执行过
   * （调用点 `database.ts` 的启动维护会打印"索引重建失败 / 保留标记"）。
   *
   * 现在的做法与旧库路径**逐条对齐**（同样的耐久性不变量，一个都不放松）：
   * - 会话清单来自 `sessions` 域镜像（小表）；
   * - 每个会话的消息来自**会话镜像**（已完整加载才用，被截断就不用 —— 与读路径同一条规则）；
   * - `total <= keepPerSession` → 跳过；
   * - 日志里没有的（`durable` 不含）→ 一律不删；
   * - 带附件的消息 → 不删（附件行不在 JSONL 里，删消息会级联删附件）；
   * - 隐藏走 `messages.delete { ids, trim: true }`（**软删除 + 裁剪标记**，见下面裁剪那一段的长注释：
   *   行必须留在库里，否则 `message_feedback` 的外键目标消失、反馈写不进去 —— B-4；
   *   而 `trim` 这个独立标记让"被裁"与"被压缩"在库里可区分 —— 第 44 轮）。
   *
   * ⚠️ 这段描述的是**现在**的做法。它原来是硬删除（`messages.delete { ids }`），
   * 那段历史与"为什么改软删除、以及软删除之后读路径怎么不变"写在函数体里。
   * 软删除路径**刻意不带 `confirm_bulk`**：隐藏不删行、不触发级联，不是破坏性删除。
   *
   * 注意**不动全文索引**：被裁掉的消息在日志里还在、也仍然可搜（`fts.rebuild` 的
   * `keep_ids` 就是为这件事留的）。
   */
const port = rustMessagePort();
if (!port?.messages) return out;

const { durableMessageIds, flushSessionLogWrites } = await import("./session-jsonl");
await flushSessionLogWrites();

const sessionsMirror = domainReadMany<Record<string, unknown>>("sessions", (r) => r);
  /*
   * **未就绪 ≠ 没有会话**（第 44 轮）。
   *
   * 这里原来写 `?? []`：域镜像没就绪时清单为空 → 循环一次都不进 → 函数返回全 0，
   * 而调用方（启动维护）看到的是"索引裁剪 0 条" —— **与"确实没什么可裁"完全一样**。
   * 这个维护步骤已经因为另一处缺陷（同步判镜像就绪）在真机上从未执行过，
   * 而这一条会让它在"另一种未就绪形态"下继续静默 no-op。如实上报之后两者分得开。
   */
  if (sessionsMirror === undefined) {
    reportPersistFailure(
      "message.trimIndexedMessages",
      new Error("sessions 域镜像未就绪"),
      "本次索引裁剪整体跳过（未就绪不等于没有会话；下次维护会重试）",
    );
    return out;
  }
  /*
   * ## 先**并发**发起所有会话的镜像加载（第 44 轮：修"每会话 5s 串行"）
   *
   * 真端口的 `ensureLoaded` 是异步的，而等待只在**成功**时被唤醒（失败时回调永不触发）。
   * 如果"发起 + 等待"写在同一个串行循环里，N 个坏会话就要付 N × 超时：
   * 审计实测 3 个会话 = **15009 ms**，外推 100 个会话 ≈ 8.3 分钟 ——
   * 而这一步后面还串着附件预热 / 遥测裁剪 / 审计裁剪 / 空间回收 / 完整性检查 / 计数对账。
   *
   * 所以：所有加载**先一起发起**，再用**一个整批共享的截止时间**逐个确认。
   * 最坏情况从 N × 5s 变成 5s（总量有界），正常情况几乎立即全部就绪。
   */
  // `mirrorWaitMs` 只为测试注入（默认走上面那个有依据的常量）：
  // 让"超时分支"能被快速覆盖，而不必让用例真的等 5 秒。
  const deadline = Date.now() + (opts.mirrorWaitMs ?? TRIM_MIRROR_WAIT_TOTAL_MS);
  for (const row of sessionsMirror) {
    const sid = String(row.id ?? "");
    if (sid) port.messages.ensureLoaded(sid);
  }

  for (const row of sessionsMirror) {
  const sessionId = String(row.id ?? "");
  if (!sessionId) continue;
  try {
    /**
     * ⚠️ **必须等镜像就绪**（第 44 轮修掉的"整条维护步骤从不生效"）。
     *
     * 真端口的 `ensureLoaded` 是**异步**的（内部走 IPC 分页读），
     * 所以"调用它之后立刻同步判 `isLoaded`"**必然为 false** —— 每个会话都会被跳过，
     * 于是索引裁剪在真机上一条都没裁过，而日志还把原因写成"日志尚未覆盖"。
     * 测试双的 `ensureLoaded` 是同步就绪的，所以 CI 里看不见这件事。
     *
     * ⚠️ 等待用的是**整批共享的截止时间**（`deadline`），**不是每会话 5 秒**：
     * 真端口的 `ensureLoaded` 只在**加载成功**时回调，加载失败时回调**永不触发** ——
     * 于是"每会话 5s 超时"会让 N 个坏会话付 N×5s（审计实测 3 个会话 = **15009 ms**，
     * 线性外推 100 个会话 ≈ 8.3 分钟），而它后面还串着附件预热、遥测裁剪、审计裁剪、
     * 空间回收、完整性检查、计数对账 —— 拖住的不是一步，是整条维护链。
     * 所有会话的加载已经在循环之前**并发发起**了，所以共享截止时间不会漏掉谁会把谁饿死。
     */
    const readiness = await waitForSessionMirror(port, sessionId, remainingWaitMs(deadline));
    if (readiness !== "ready") {
      out.skippedSessions++;
      if (readiness === "truncated") out.skippedTruncated++;
      else out.skippedNotLoaded++;
      continue;
    }
    const rows = port.messages.list(sessionId);
    const visible = rows.filter((r) => !r.hidden);
    if (visible.length <= keepPerSession) continue;

    const durable = await durableMessageIds(sessionId);
    if (durable.size === 0) {
      out.skippedSessions++; // 老会话尚未回填 → 一律不动
      out.skippedNoLog++;
      continue;
    }

    // 与旧 SQL 的 `ORDER BY timestamp DESC LIMIT -1 OFFSET ?` 等价：保留最新 N 条
    const sorted = [...visible].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    const candidates = sorted.slice(keepPerSession).map((r) => r.id);
    if (candidates.length === 0) continue;

    const attachmentRows =
      domainReadMany<Record<string, unknown>>(ATTACHMENT_TABLE, (r) => r, { session_id: sessionId }) ?? [];
    const withAttachments = new Set(
      attachmentRows.map((r) => String(r.message_id ?? "")).filter((x) => x.length > 0),
    );

    const deletable = candidates.filter((id) => durable.has(id) && !withAttachments.has(id));
    if (deletable.length === 0) {
      out.skippedSessions++;
      out.skippedNoCandidates++;
      continue;
    }
    /**
     * ## 裁剪必须是**软删除**（B-4，真机实测的"反馈写不进去"）
     *
     * 原来这里是 `messages.delete { ids }`（**硬删除**）。看着很合理（日志才是权威副本，
     * 索引里的行可以重建），但它踢掉了一个隐藏的依赖：`message_feedback.message_id` 是
     * **外键指向 `messages(id)`**（`migrate.rs` 的表依赖里写着 `("message_feedback","messages")`）。
     *
     * 于是用户路径断成两截：
     * 1. 裁剪把索引行硬删了；
     * 2. `listMessagesMerged` 又把"只在 JSONL 里的消息"**合回 UI**（这正是设计意图 ——
     *    被裁掉的历史仍然读得到），所以用户看得到、点得动那条消息；
     * 3. 点"点赞" → `saveFeedback` → `feedback.set` → **`FOREIGN KEY constraint failed`**。
     *    真 CLI 实测（见报告）：先 `messages.delete {ids}` 再 `feedback.set` 必失败。
     * 用户的观感更糟：图标先亮了（`feedbackCache` 是**先内存后落库**），重启之后消失。
     *
     * 修法就是让裁剪走 `soft: true`（Rust 侧 `messages_delete` 的真实现是
     * `UPDATE messages SET hidden = 1`，行留着 → 外键目标还在 → 反馈写得进去）。
     *
     * ### 读路径的处置（第 44 轮把区别钉在 `trimmed` 列上）
     *
     * 两条路径对「被裁剪的行」的**可见性刻意不同**，这正是 `trimmed` 这一列存在的理由：
     *
     * | 读路径 | 被裁剪（`hidden=1, trimmed=1`） | 被压缩（`hidden=1, trimmed=0`） |
     * | --- | --- | --- |
     * | `listMessagesFromIndex`（索引视图 = `WHERE hidden = 0`） | 看不到（它读的就是索引） | 看不到 |
     * | `listMessages` / `listMessagesMerged`（用户面） | **看得到**（从权威 JSONL 合回来，SLOG-6/SLOG-8） | 看不到（否则压缩白做、token 永不下降） |
     *
     * `messages.count` 的可见计数是 `hidden = 0`，与索引视图一致（它数的是索引，不是历史）。
     * 附件消息、日志里没有的消息依旧不裁（上面两条过滤器原样保留）。
     *
     * ### 这里**不再**需要任何进程内记账
     *
     * 第 44 轮之前，读路径靠 `hiddenMessageIds()` 里「事后减掉裁剪那批」的 `trimmedIndexIds`
     * 来区分两者 —— 那份记账一重启就没了：要么历史消失，要么压缩失效。
     * 现在区别落在库里的 `trimmed` 列上，`hiddenMessageIds()` 直接读它，所以这里
     * **刻意不调用** `rememberHidden()` —— 调用它等于把这次裁剪又写回「压缩」，
     * 用户的历史会当场消失。`rememberHidden()` 只属于 `deleteMessagesByIds`（压缩）那条路径。
     */
    /**
     * ## 裁剪走 `trim: true`（第 44 轮：把"谁做的这次隐藏"变成**库里的持久事实**）
     *
     * 引擎侧 `messages.delete { trim: true }` = `UPDATE messages SET hidden = 1, trimmed = 1`。
     *
     * 为什么必须要一个独立标记：`hidden = 1` 被两条语义**相反**的路径共用 ——
     * 上下文压缩要求读路径**排除**这条消息（否则"压缩 840 条、token 一点没降"死循环），
     * 而索引裁剪要求读路径**保留**（"被裁掉的历史仍读得到"是裁剪的前提，
     * `session-jsonl-index.test.ts` 的 SLOG-6/SLOG-8 就是这条不变量）。
     *
     * 前一版修法是**进程内记账**（`trimmedIndexIds`）—— 它只在同一个进程里成立，
     * 重启后"被裁过"与"只被压缩过"在库里重新变得一模一样：要么历史消失，
     * 要么压缩失效，两者都不可接受。现在区别落在 `trimmed` 列上，
     * 镜像的 `hiddenIds()` 直接读它（`hidden=1 && trimmed≠1` 才等于"被压缩"），
     * 于是读路径不需要任何进程内状态就能给出正确答案。
     */
    /**
     * ## P2-4：走 `deleteMessageIndexRows`（**读引擎回报**），不再走裸 `execute`
     *
     * 裁剪是 `soft`（`trim: true` → `hidden=1, trimmed=1`，不删行）——
     * 引擎在软删除分支里也照常回报 `count_clamped`（恒 `false`：行没少，计数不可能被夹断），
     * 所以这条路的回报里唯一有信息量的是 `missing`（"要裁的 id 已经不在库里了"）。
     */
    deleteMessageIndexRows(
      port,
      deletable,
      "trim",
      [sessionId],
      "message.trimIndexedMessages",
      "索引裁剪的隐藏未落到查询索引",
    );
    /**
     * 镜像同步：**改隐藏与裁剪标记，而不是移除行**。
     *
     * 引擎只是 `hidden = 1, trimmed = 1`（行还在库里，`message_feedback` 的外键目标必须留着）；
     * 若镜像把行删掉，下一次整会话加载就会与引擎不一致 —— 镜像比引擎"更狠"是缺陷的来源。
     */
    port.applyMessageTrim?.(sessionId, deletable);
    out.deletedMessages += deletable.length;
    console.log(
      `[Index] 会话 ${sessionId} 裁剪索引 ${deletable.length} 条（rust；软删除 hidden=1；均在 JSONL 中；附件消息已跳过）`,
    );
  } catch (e) {
    console.warn(`[Index] 会话 ${sessionId} 裁剪失败（跳过）:`, e);
    out.skippedSessions++;
  }
}
return out;
}

/**
 * 读取会话历史：**权威日志（JSONL）+ SQLite 索引合并**（第 78 波）。
 *
 * 为什么需要合并：索引可以被有界裁剪（`trimIndexedMessages`），被裁掉的历史只存在于 JSONL 里。
 * 合并规则：以 JSONL 为准（它就是权威），索引里多的（例如附件、尚未进日志的最近消息）也保留；
 * 同 id 用 JSONL 的版本。排序按 timestamp。
 *
 * 这是同步接口 —— UI 的加载路径目前是同步的，所以这里只读**已缓存的日志**；
 * 首次加载时若日志还没读进内存，则先用索引（随后 `hydrateSessionLog` 会补齐）。
 */
/**
 * 订阅"某会话的消息镜像已就绪"（第 33 轮：修"点开会话气泡数为 0"）。
 *
 * ## 为什么必须补这个（真机实测的根因）
 *
 * 打包版实测：点开一个**确实有 27 条消息**的会话，界面气泡数为 **0**，
 * 控制台一行 `[Store] loadMessages sessionId=… → 0 条`，且**没有任何报错**。
 *
 * 机制是两条"各自都对"的规则叠在一起：
 * 1. 移植期规则：**镜像未完整加载前不路由**（`rustMessageSource` 返回 null）——
 *    这条本身是对的，否则会造成读写分裂；
 * 2. `listMessagesFromIndex` 的兜底：索引不可用时返回**空列表**
 *    （注释写着"留给 `listMessagesMerged` 用权威日志拼出完整历史"）。
 *
 * 但 `listMessagesMerged` 的日志兜底只在**日志已经被 hydrate 过**时才有内容，
 * 而进入会话的第一次读发生在 hydrate 之前 —— 于是空 + 空 = 0 条，
 * 而 `loadMessages` 是同步的一次调用，**没有任何东西会再读第二次**。
 * 界面就一直空着，用户看到的是"会话点开什么都没有"。
 *
 * 与"首屏暂无项目"（第 92 波）是同一类**启动竞态**：异步存储 + 同步读 + 无人重试。
 *
 * 修法：让读路径能**订阅就绪事件**，在镜像加载完成时回调一次让上层重新读。
 * 这是有界的一次通知（不是轮询），也不改变"未加载不路由"这条核心规则。
 */
export function onSessionMessagesReady(sessionId: string, cb: () => void): void {
  const port = rustMessagePort();
  if (!port?.messages) return;
  try {
    port.messages.ensureLoaded(sessionId, cb);
  } catch {
    /* 订阅失败不影响主流程 */
  }
}

/**
 * **作废并重拉**某会话的消息镜像（第 38 轮）。
 *
 * 用途：库内容被外部改动之后（典型场景是"运行期守护从旧库恢复"），
 * 镜像里那份旧快照必须作废 —— 否则 `isLoaded` 会一直为真，
 * 读路径继续返回**陈旧（空）集合**，表现为"数据救回来了、界面还是空的"。
 */
export function reloadSessionMessages(sessionId: string, onLoaded?: () => void): void {
  const port = rustMessagePort();
  if (!port?.messages) {
    // 端口不可用时至少保留旧行为（清日志缓存，让下一次读走权威日志）
    cachedLogMessages.delete(sessionId);
    onLoaded?.();
    return;
  }
  cachedLogMessages.delete(sessionId);
  try {
    if (port.messages.reload) {
      port.messages.reload(sessionId, onLoaded);
    } else {
      // 假端口没有 reload：退化成"先确保加载、加载完再回调"
      port.messages.ensureLoaded(sessionId, onLoaded);
    }
  } catch {
    onLoaded?.();
  }
}

export function listMessagesMerged(sessionId: string, limit?: number): Message[] {
  /**
   * P5 第 10 段：工具调用**从缓存补上**（与 `getMessage` 同一来源）。
   *
   * 为什么必须补：镜像行不含 `tool_calls`（内存预算），日志镜像也只在
   * "hydrate 过且那条记录带 toolCalls"时才有 —— 两个来源都可能缺，于是
   * "列表里这条消息有没有工具调用"会随会话是否 hydrate 过而变化。
   *
   * ⚠️ 这一步必须在**所有**返回路径之前：合并的开头有一条"日志镜像为空就直接返回
   * 索引结果"的短路（未 hydrate 的会话正是那条路），补在后面等于对最常见的形态无效。
   */
  const withToolCalls = (list: Message[]): Message[] =>
    list.map((m) => {
      if (m.toolCalls?.length) return m;
      const cached = toolCallCache.get(m.id);
      return cached?.length ? ({ ...m, toolCalls: cached } as Message) : m;
    });
  const fromIndex = listMessagesFromIndex(sessionId, limit);
  const cached = cachedLogMessages.get(sessionId);
  if (!cached || cached.length === 0) return withToolCalls(fromIndex);

  /**
   * 第 83 波：**索引里的 hidden 状态也是权威**（软删除行只在索引里）。
   *
   * `listMessagesFromIndex` 用 `WHERE hidden = 0` 过滤掉了它们，而日志里没有对应的墓碑
   * （老版本压缩只改索引），于是合并会把它们**当成"索引里没有、日志里有"的历史**重新加回来 ——
   * 这正是用户现场"压缩了 840 条、上下文一点没小"的机制。对已经踩过坑的会话（索引里已有
   * hidden=1 的行）也要能恢复：这里显式取一次 hidden id 集合，合并时一律排除。
   *
   * 这些行是**软删除**、且 `trimIndexedMessages` 只裁 `hidden = 0` 的行，所以这个集合长期有效。
   */
  const hiddenIds = hiddenMessageIds(sessionId);
  const merged = new Map<string, Message>();
  for (const m of fromIndex) merged.set(m.id, m);
  for (const rec of cached) {
    /**
     * 第 83 波（防御纵深）：日志镜像里被标记为删除/隐藏的记录**绝不能**进读集合。
     *
     * 为什么必须有这一层：`readSessionMessages` 已经过滤墓碑，但**镜像可能是删除之前填充的**
     * （`hydrateSessionLog` 进会话时读一次）。只要哪条删除路径漏了同步镜像，
     * 磁盘逻辑再正确，本进程内也照样"复活"—— 压缩被复活 = 上下文永不缩小 = 死循环，
     * 代价太大。所以这里按最保守处理：宁可少显示，绝不复活。
     */
    if ((rec as any).deleted === true || (rec as any).hidden === true || hiddenIds.has(rec.id)) {
      merged.delete(rec.id);
      continue;
    }
    const existing = merged.get(rec.id);
    merged.set(rec.id, {
      ...(existing ?? ({} as Message)),
      id: rec.id,
      role: rec.role as Message["role"],
      content: rec.content,
      timestamp: rec.timestamp,
      ...(rec.reasoning ? { reasoning: rec.reasoning } : {}),
      ...(rec.model ? { model: rec.model } : {}),
      ...((rec as any).toolCalls ? { toolCalls: (rec as any).toolCalls } : {}),
      /**
       * B-3：`retrievedSources` 与 `generatedFiles` 必须一起带上。
       *
       * 这一支是"**权威日志覆盖索引**"的方向（`...existing` 在前、日志字段在后）。
       * 而日志记录里如果没有这两个字段，覆盖就等于**把它们擦掉**：
       * 索引里明明有引用来源（`writeIndexViaRust` 一直传 `retrieved_sources`），
       * 合并之后却没了 —— `MessageBubble` 的引用块随即消失。
       *
       * 两个来源都给不出时才落到 `undefined`（既有语义：没有就是没有）。
       * 日志那份是权威（`session-jsonl.ts` 的白名单已经收录它们），索引那份是兜底
       * （老日志是这次修之前写的，里面没有这两个字段）。
       */
      ...((rec as any).retrievedSources
        ? { retrievedSources: (rec as any).retrievedSources }
        : existing?.retrievedSources
          ? { retrievedSources: existing.retrievedSources }
          : {}),
      ...((rec as any).generatedFiles
        ? { generatedFiles: (rec as any).generatedFiles }
        : existing?.generatedFiles
          ? { generatedFiles: existing.generatedFiles }
          : {}),
    } as Message);
  }
  const all = [...merged.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const enriched = withToolCalls(all);
  return limit ? enriched.slice(-limit) : enriched;
}

/**
 * 索引里被**上下文压缩**隐藏（`hidden = 1`）的消息 id 集合。
 *
 * ## `hidden` 这一列被两条语义相反的路径共用，而它们的读处置必须相反
 *
 * | 路径 | `hidden = 1` 的含义 | 读路径应当 |
 * | --- | --- | --- |
 * | 上下文压缩（`deleteMessagesByIds`） | 这条消息**从上下文里移除** | 排除（否则"压缩了 840 条、token 一点没降"） |
 * | 索引裁剪（`trimIndexedMessages`） | 行**留在库里**满足 `message_feedback` 的外键 | **保留**（"被裁的历史仍读得到"是裁剪的前提） |
 *
 * 第 44 轮之前，两者的区别只能靠**进程内记账**表达（`trimmedIndexIds`），
 * 于是重启后就分不清：不排除 → 用户看不到自己的历史（SLOG-6/SLOG-8 实测 12 条变 3 条）；
 * 一刀切排除 → 压缩失效（那个著名死循环）。真正的解法是把它变成库里的事实，
 * 所以引擎现在把裁剪写成 `hidden = 1, trimmed = 1`，
 * 而**镜像的 `hiddenIds()` 只返回 `hidden=1 && trimmed≠1` 的那些** ——
 * 这里因此不需要任何进程内状态，也不需要"事后减掉裁剪那批"的第二段逻辑。
 */
function hiddenMessageIds(sessionId: string): Set<string> {
  // 迁移期分流：走 Rust 时**必须**用镜像的 hidden 集合 ——
  // 索引里的 hidden 状态是权威（软删除行只在索引里），用旧库那份会把已压缩的消息**复活**
  // （见 listMessagesMerged 的注释：那正是"压缩了 840 条、上下文一点没小"的机制）。
  const routed = rustMessageSource(sessionId);
  const out = new Set<string>();
  if (routed?.messages) {
    for (const id of routed.messages.hiddenIds(sessionId)) out.add(id);
  }
  /**
   * 叠加**本进程刚隐藏过**的 id（第 39 轮）。
   *
   * ## 为什么必须有这一层（这就是用户报的那个 bug）
   *
   * `rustMessageSource()` 的规则是"镜像未加载完不路由"，而压缩发生在**使用中** ——
   * 那一刻镜像可能正好没加载完（或已被内存预算逐出）。此时上面的分支拿不到任何
   * hidden id，于是合并阶段会把日志里那些**已被软删除**的消息整批加回来：
   *
   *   · 压缩说"移除 840 条"，下一次读又回来 840 条 → 上下文 token 一点没降；
   *   · 每次迭代重新压缩（LLM 摘要白烧），最后硬停"请开启新对话"。
   *
   * 所以把"本进程隐藏过的 id"记在内存里当**权威补充**：只要这次 hide 是我们做的，
   * 读路径立刻就能看见它，不必等镜像重新加载。
   * （裁剪那一路**不写**这里 —— 它的隐藏会被引擎的 `trimmed` 列标出来，
   *   镜像的 `hiddenIds()` 已经把它排除在外了。）
   */
  for (const id of localHiddenIds.get(sessionId) ?? []) {
    out.add(id);
  }
  if (out.size > 0) return out;
  /**
   * B 态（端口在 rust）：**不再碰旧库**。
   *
   * 旧库在 rust 模式下刻意不存在，这里原来靠 `tryGetDatabase()` 拿到 null 再返回空集 ——
   * 结果一样，但"是否该读旧库"这件事没有被表达出来（那句 `tryGetDatabase()` 看起来
   * 像一次正常的回退尝试）。两态门控把语义写清楚：B 态直接返回本进程的权威集合。
   */
  return out;
}

/**
 * ## 这里原来有一段"被索引裁剪隐藏的 id"的**进程内**记账（第 20 轮），第 44 轮已删除
 *
 * 它存在的理由是：`hidden = 1` 被"上下文压缩"与"索引裁剪"两条语义相反的路径共用，
 * 而读路径对两者的处置必须相反（一个排除、一个保留）。当时只能靠"这次隐藏是谁做的"
 * 在内存里记一笔来区分 —— **只在同一个进程里成立**：重启后两者在库里重新变得一模一样，
 * 于是要么历史消失、要么压缩失效。
 *
 * 现在引擎把裁剪写成 `hidden = 1, trimmed = 1`（见 `messages_delete` 的 `trim` 参数），
 * 区别成了**库里的持久事实**，镜像的 `hiddenIds()` 直接读它。
 * 所以这段记账、它的容量上限、以及"事后从 hiddenIds 里减掉裁剪那批"的第二段逻辑
 * 一起删掉了 —— 少一套需要维护、且只在特定生命周期内成立的中间状态。
 */

/**
 * 会话日志的内存镜像（由 hydrateSessionLog 填充）。
 *
 * ## ⚠️ 第 63 轮：这是"审计点名的第二条无上界结构"，但**它不能按预算逐出**
 *
 * 稳定性审计第 ④ 节把它与 `RustEventMirror` 并列（`message.ts:704`）：每个被访问过的
 * 会话的**全部消息正文**常驻，而清理入口 `clearSessionLogCache` 在生产代码里没有调用者。
 * 现状与本轮结论：
 *
 * ### 为什么它会长到很大（谁把日志灌进来的，以及真机上的量级）
 *
 * 不是"用户点开多少会话"，而是"**进程里有谁按会话扫过一遍**"：
 * `maintenance.ts` 的 `detectSessionsBehindLog` 为了让"索引落后于权威日志"能被发现，
 * 会**主动把每个会话的日志读一遍**（`ensureSessionLogHydrated`，见那里的长注释）；
 * `session-log-bridge.ts` 重建索引时也是按批 `hydrateSessionLog`。
 * 于是一次启动维护就把**全部会话的正文**留在了这个 Map 里。
 *
 * 这个 Map 存的就是 `readSessionMessages()` 的解析结果，所以它的量级**直接**等于
 * `%APPDATA%\com.codem.app\sessions\*.jsonl` 的规模。本机真机库只读实测（第 63 轮）：
 *
 * | 项 | 实测 |
 * | --- | --- |
 * | 日志文件数 / 总字节 | **6 个 / 7,491,983 B（7.14 MiB）** |
 * | 其中仍在库里的两个会话 | 2,793,371 B + 1,741,168 B = **4,534,539 B** |
 * | 其中**会话行已不存在**（日志里有 `__session_deleted__` 墓碑）的两个 | 1,478,481 B × 2 = **2,956,962 B** |
 *
 * 也就是说：**本机此刻就有 2.96 MB 的"已删除会话正文"会被启动维护重新读进内存**
 * 而永远不会被任何读者用到（`listSessionLogs()` 列的是磁盘文件，不看会话表）。
 * 这正是下面那个清扫点存在的理由 —— 它不是理论风险，是这台机器上正在发生的量。
 *
 * ### 为什么本轮**不给它加预算/LRU**（这条是量过之后才敢下的结论）
 *
 * `listMessages`（= `listMessagesMerged`）是**同步**读，它把"索引视图 + 日志镜像"合并起来，
 * 而被索引裁剪掉的历史（`hidden = 1, trimmed = 1`）**只存在于日志那一侧**
 * （`listMessagesFromIndex` 是 `WHERE hidden = 0` 的索引视图，见本文件第 404-414 行的对照表）。
 * 真机库实测（只读统计）：会话 `1788268497135-31x6vdt97` 共 657 行，其中
 * **157 行是 `hidden = 1, trimmed = 1`** —— 也就是**索引视图只有 500 行**，
 * 另外 24% 的用户历史只有"日志合并"这一条路读得到。
 * 于是"按预算逐出某个会话的日志镜像"意味着：
 *
 * 1. 该会话的读者**立刻少看到 157 条**（且不是"读不到"而是"读到了更少的集合"——
 *    这正是本仓库反复修的"塌陷"，只是不再报错、更难发现）；
 * 2. **没有任何东西会把它补回来**：`store.loadMessages` 只在合并结果**为空**时才去
 *    `ensureSessionLogHydrated`（`store.ts:513` 起的那一整段都在 `if (totalCount === 0)` 里），
 *    而 UI 的"正在读取历史…/暂时读不到"也只在 `messages.length === 0` 时渲染
 *    （`ChatPanel.tsx:762/802`）。非空但变少的读，界面上**完全没有任何信号**。
 *
 * 还有两条同方向的证据：
 *
 * 3. 逐出**无法保证不碰"正在被 UI 读的会话"**：存储层没有任何"当前会话"的概念
 *    （全仓 grep：storage 里没有 current session 键；`store.ts` 把它存在 React state 里），
 *    而 `listMessages` 还被 fork / 父会话 / 不在场会话的维护路径调用
 *    （`core/store.ts:364`、`core/llm/index.ts:1722`、`runtime-invariants.ts:116`…），
 *    所以"最近被读的会话"这个信号**不等于**"UI 正在看的会话"；
 * 4. fork 这类路径会把读到的结果**写进新会话的日志**：一次"少 157 条"的读会被**固化**下来，
 *    比显示层少几条严重得多。
 *
 * 结论：**预算/逐出需要先把"非空但不完整"这一态表达出来**（例如让
 * `listMessages` 的调用方能区分三态并触发重新 hydrate，那是 `store.ts` 的改动，
 * 不在本轮所有权内）。在没有那一步之前，硬加预算就是用"静默少历史"换内存 —— 不划算。
 * （对照：事件镜像那一侧本轮的预算之所以能加，是因为它的 `isLoaded` 让"未加载"这一态
 * 本来就被表达出来，且每个读它的消费者都按"未加载不路由"处理。）
 *
 * ### 本轮做了什么（真实生产时机 + 只释放**可证明没有读者**的会话）
 *
 * `releaseSessionLogCache()`：只在该会话**已被删除**（会话行删掉、日志留下墓碑，
 * 即"这个 id 再也不会被任何用户面读路径合法地读"）时释放。
 * 两个调用点都是生产路径：`session.ts::deleteSession`（删除成功之后）与
 * `maintenance.ts::detectSessionsBehindLog`（对磁盘上有日志但已带墓碑的会话做一次清扫）。
 *
 * 顺带修掉一个一直存在的小缺陷：删除会话后**日志文件一个字节没动**（设计如此，见
 * `deleteSessionLog` 的注释），于是"已删除的会话"在本进程里还能通过这份内存镜像
 * 被 `listMessages` 读出一整段历史；释放之后读回 0 条才是事实。
 * （若之后又有一次迟到的 hydrate 把日志读回来，它仍会重新驻留 —— 读路径不按
 * **会话**墓碑过滤日志；本函数只负责"删除后不再常驻"，不改变日志文件本身。）
 */
const cachedLogMessages = new Map<string, Awaited<ReturnType<typeof readSessionMessages>>["messages"]>();

/** 第 91 波：索引不可用只提示一次（数据库致命时否则每次读都刷一行） */

/** 从日志镜像里按 id 取一条消息（索引不可用时的兜底） */
export function logMirrorMessage(sessionId: string, id: string): Message | null {
  const mirror = cachedLogMessages.get(sessionId);
  if (!mirror) return null;
  const rec: any = mirror.find((m) => m.id === id);
  if (!rec) return null;
  return {
    id: rec.id,
    role: rec.role,
    content: rec.content ?? "",
    timestamp: rec.timestamp ?? Date.now(),
    ...(rec.reasoning ? { reasoning: rec.reasoning } : {}),
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.status ? { status: rec.status } : {}),
    ...(rec.toolCalls ? { toolCalls: rec.toolCalls } : {}),
  } as Message;
}

/** 在整个日志镜像里找一个消息 id 属于哪个会话（索引不可用时的兜底） */
function sessionIdFromLogMirror(messageId: string): string | null {
  for (const [sessionId, mirror] of cachedLogMessages) {
    if (mirror.some((m) => m.id === messageId)) return sessionId;
  }
  return null;
}

/**
 * 把会话的追加日志读进内存镜像（进入会话时调用一次）。
 * 之后 listMessagesMerged 就能同步合并出被索引裁掉的历史。
 */
/**
 * 把会话的追加日志读进内存镜像（进入会话时调用一次）。
 * 之后 listMessagesMerged 就能同步合并出被索引裁掉的历史。
 *
 * 成功（哪怕读到 0 条）→ 写进镜像，`sessionLogReadState` 变 `hydrated`；
 * 失败 → 记进 `logReadFailures`（`failed`），**不写镜像**
 * （写一个空数组等于把"读失败"谎报成"这个会话没有消息"）。
 */
export async function hydrateSessionLog(sessionId: string): Promise<number> {
  /**
   * 开始读之前记下"释放世代"：写回之前再比一次（见 `releaseSessionLogCache`）。
   * 这次读取期间若发生过释放，它读回来的正文**已经过期** —— 丢弃写入，
   * 于是"释放瞬间正好在途的那次 hydrate"不会把刚释放的正文又写回来。
   * 返回值照常给条数（调用方不受影响）。
   */
  const epochAtStart = logReleaseEpoch.get(sessionId) ?? 0;
  try {
    const { messages } = await readSessionMessages(sessionId);
    if ((logReleaseEpoch.get(sessionId) ?? 0) !== epochAtStart) {
      logReadFailures.delete(sessionId);
      return messages.length;
    }
    cachedLogMessages.set(sessionId, messages);
    logReadFailures.delete(sessionId);
    return messages.length;
  } catch (e) {
    logReadFailures.add(sessionId);
    console.warn("[SessionJSONL] 读取日志失败（回退到索引）:", e);
    return 0;
  }
}

/** 测试/会话关闭时清理镜像（生产路径请用 `releaseSessionLogCache`，它会做安全判据与留痕） */
export function clearSessionLogCache(sessionId?: string): void {
  if (sessionId) cachedLogMessages.delete(sessionId);
  else cachedLogMessages.clear();
}

/**
 * **释放某会话的日志镜像（生产入口）** —— 第 63 轮给 `cachedLogMessages` 的清理时机。
 *
 * ## 为什么只在这个时机释放（"为什么这个时机是安全的"）
 *
 * 调用点只有两个，都满足同一条判据：**该会话已被删除，因此不存在任何"正在读它"的读者**
 * （会话行已删、级联删掉消息行，`sessions` 里已经没有这个 id）。
 * 具体：
 *
 * - `session.ts::deleteSession` —— 在 `domainDelete` **确认成功之后**才调用。
 *   失败时**不释放**：那会话还在，"可能会被读"的前提没有消失，
 *   释放只会白白制造一次"非空但不完整"的读（见上面 `cachedLogMessages` 的长注释）。
 * - `maintenance.ts::detectSessionsBehindLog` —— 对磁盘上有日志、但**已带会话墓碑**的会话清扫一次
 *   （覆盖"上一个进程里删掉的那些会话"：它们不可能再被本进程的 UI 读到）。
 *
 * ## 与"绝对不许碰"的那条规则的关系
 *
 * 需求原话是"不能清掉正在被 UI 读的会话"。本函数**只处理已删除的会话**，
 * 把"是否正在被读"这个问题**变成了不需要回答的问题** —— 这比"猜哪个会话正在被读"可靠：
 * 存储层根本没有"当前会话"这个概念（`store.ts` 把它存在 React state 里），
 * 而 `listMessages` 还会被 fork / 维护 / 父会话路径调用，所以
 * "最近被读的会话"这个信号并不等于"UI 正在看的会话"。
 *
 * ## 返回值与留痕
 *
 * 返回"是否真的释放了一份驻留"（`false` = 本来就没驻留）。
 * 释放量走 `console.log`（低频、可对账），**不**走 `reportPersistFailure`
 * —— 这是一次正常的内存回收，不是失败。
 */
export function releaseSessionLogCache(sessionId: string, reason: string): boolean {
  if (!sessionId) return false;
  const held = cachedLogMessages.get(sessionId);
  const had = cachedLogMessages.delete(sessionId);
  // "读失败"标记一起清：会话都删了，这个 id 的读取状态没有意义，
  // 留着会让 `sessionLogReadState` 对一个不存在的会话报 `failed`。
  logReadFailures.delete(sessionId);
  /**
   * 压住**在那次释放的同时还在途的那一次 hydrate**（否则释放等于白做）。
   *
   * 释放是同步的，而 hydrate 是异步的：`detectSessionsBehindLog` 之类的读者完全可能
   * "已经发起读取、还没 set"就被删除打断 —— 它 set 回来，这份镜像当场复活。
   * 所以这里给会话记一个**释放世代**（自增），`hydrateSessionLog` 开始读之前记下当时的世代、
   * 写回之前再比一次：**只要期间发生过释放，就丢弃这一次写入**。
   *
   * 为什么用"世代"而不是"一次性标记"：标记会被**下一次** hydrate 吃掉，
   * 于是"删除之后又被正常读了一次"会因为那个标记而写不进去
   * （`sessionLogReadState` 永远停在 `pending` → 界面永远"正在读取历史…"）。
   * 世代只说一件事：**这次读取跨越了一次释放**，所以它的结果已经过期。
   *
   * 有界：只留最近 `RELEASED_LOG_SESSIONS_MAX` 个键。被挤掉的键等价于"世代回到 0"，
   * 它能影响的最坏情况是"一次文件读取期间发生了 64 次以上释放"（实际不可能），
   * 后果只是"那一次写入没被压住" —— 会在下一次维护清扫里被再次释放。
   */
  logReleaseEpoch.delete(sessionId);
  logReleaseEpoch.set(sessionId, ++logReleaseCounter);
  if (logReleaseEpoch.size > RELEASED_LOG_SESSIONS_MAX) {
    const oldest = logReleaseEpoch.keys().next().value;
    if (oldest !== undefined) logReleaseEpoch.delete(oldest);
  }
  if (had) {
    console.log(
      `[SessionJSONL] 释放会话日志镜像 sessionId=${sessionId}（${held?.length ?? 0} 条，${reason}）—— 内存回收，非失败`,
    );
  }
  return had;
}

/**
 * 会话的"释放世代"（见 `releaseSessionLogCache` 里"压住在途的那一次 hydrate"）。
 * 有界：只保留最近若干次释放；比较用的是"期间有没有变过"，所以挤掉旧键不会造成误压。
 */
const logReleaseEpoch = new Map<string, number>();
let logReleaseCounter = 0;
const RELEASED_LOG_SESSIONS_MAX = 64;

/**
 * 该会话日志的读取状态（第 50 轮）—— **三态**，不是布尔。
 *
 * ## 为什么必须分三态
 *
 * `listMessages` 会合并"索引 + 权威日志"，当**两者都为空**时它返回 `[]` ——
 * 这个 `[]` 在过去同时代表三件完全不同的事：
 *
 * 1. `hydrated` + 空 → 这个会话**确实没有消息**（新建的、或用户删光了）→ 欢迎页是对的；
 * 2. `pending` → **日志还没读进来**（进会话的第一次读正好落在窗口内，或索引被裁/丢过）
 *    → 显示欢迎页是**错的**：用户会以为对话被清空了（本仓库记过一次真机事故就是这个形态）；
 * 3. `failed` → **读日志失败** → 同样不该说"没有"，而该说"读不到"并给重试。
 *
 * 判据来自 `cachedLogMessages`：`hydrateSessionLog` 成功时会 `set(sessionId, messages)`，
 * **空数组也 set**（那是一次定论）；失败时不 set，并把会话记进 `logReadFailures`。
 *
 * ⚠️ 为什么"读失败"不能等同于"空"：日志是**权威副本**，索引只是可重建的查询索引。
 * 索引空了（被裁 / 崩溃丢掉写入）而日志里有内容，正是这条架构要救的场景 ——
 * 把"读不到"渲染成"没有"，等于把要救的东西当成不存在。
 */
export type SessionLogReadState = "hydrated" | "pending" | "failed";

const logReadFailures = new Set<string>();
/** 在途的 hydrate（同一会话只发一次，避免并发读同一份文件） */
const hydrationInFlight = new Map<string, Promise<number>>();

export function sessionLogReadState(sessionId: string): SessionLogReadState {
  if (cachedLogMessages.has(sessionId)) return "hydrated";
  if (logReadFailures.has(sessionId)) return "failed";
  return "pending";
}

/**
 * 确保该会话的日志被读过一次（进会话时 / 读到空结果时调用），完成后回调。
 *
 * 与直接调 `hydrateSessionLog` 的区别：**幂等且去重**（同一会话并发调用只发一次 IO），
 * 并且把"失败"记成**定论**（`failed`）而不是让会话永远停在 `pending`
 * —— 停在 pending 会让界面永远显示"正在读取…"，那比说"读不到"更糟。
 */
export function ensureSessionLogHydrated(sessionId: string, onLoaded?: () => void): void {
  if (cachedLogMessages.has(sessionId) || logReadFailures.has(sessionId)) {
    onLoaded?.();
    return;
  }
  let job = hydrationInFlight.get(sessionId);
  if (!job) {
    job = hydrateSessionLog(sessionId).finally(() => {
      hydrationInFlight.delete(sessionId);
    });
    hydrationInFlight.set(sessionId, job);
  }
  if (onLoaded) void job.then(() => onLoaded());
}

/** 测试隔离：清掉"日志读失败"标记（生产不需要复位它） */
export function __resetSessionLogReadFailuresForTests(): void {
  logReadFailures.clear();
}

/**
 * 权威日志里**活着的消息条数**（未 hydrate → `null`，即"不知道"而不是 0）。
 *
 * 用途（第 52 轮）：维护里对账"索引是否落后于权威日志"。
 * 为什么必须区分 `null` 与 `0`：`0` 是"这个会话日志里确实没有消息"（正常），
 * `null` 是"日志还没读、我不知道"—— 把后者当成 0 会让对账得出"索引比日志多"的
 * 假结论，从而**永远发现不了真正落后的会话**。
 *
 * 口径对齐 `messages.count.total`：**含 hidden**（压缩/裁剪是软删除，行留在库里），
 * 因此这里数的是 `readSessionMessages` 去重、去墓碑之后留下的全部记录。
 */
export function logLiveMessageCount(sessionId: string): number | null {
  const cached = cachedLogMessages.get(sessionId);
  if (!cached) return null;
  return cached.length;
}

/**
 * 读取会话历史 —— **索引 + 追加日志合并**（第 79 波审计修正）。
 *
 * 审计发现（严重）：上一波实现了"索引可被有界裁剪"+"日志是权威"，但**读路径没接上**：
 * `listMessages` 仍然只读索引，而全平台有几十处调用它（UI 的 `store.loadMessages`、
 * agentic loop 的上下文、fork、导出、上下文监控、不变量检查…）。于是被裁掉的历史会**凭空消失**
 * （真机上已经裁掉 112 条）。这里把合并收进 `listMessages` 本身：只要日志镜像已 hydrate
 * （启动维护会回填并 hydrate），**所有调用点自动拿到完整历史**。
 */
export function listMessages(sessionId: string, limit?: number): Message[] {
  return listMessagesMerged(sessionId, limit);
}

/** 只读 SQLite 索引（内部/诊断用）；对外请用 `listMessages`（会合并权威日志） */
export function listMessagesFromIndex(sessionId: string, limit?: number): Message[] {
  /**
   * 迁移期分流（P3 第 7 段）：端口是 rust 且该会话索引**已加载** → 从镜像读。
   *
   * 这里是读路径的入口（在 `listMessagesMerged` 里比 `hiddenMessageIds` 先执行），
   * 所以把"触发加载"放在这里，能保证同一个会话的 hidden 状态与列表来自**同一份数据**。
   */
  const routed = rustMessageSource(sessionId);
  if (routed) {
    const all = routed.messages!.list(sessionId);
    // 与旧实现的语义对齐：索引列表**只含可见行**（`WHERE hidden = 0`）。
    // 镜像为了 hidden 判定必须加载全部行，所以这里是读的时候过滤
    // （契约测试 MSG-8 抓到过漏过滤 —— 那会让已压缩的消息重新出现在对话里）。
    const visible = all.filter((m) => !m.hidden);
    // limit 语义与旧实现一致：取**最后** limit 条（`listMessagesMerged` 也是 slice(-limit)）
    const rows = limit ? visible.slice(-limit) : visible;
    // 附件在另一张表：端口读路径要显式补上（否则「消息回来了、附件没了」）
    return rows.map((r) => withMirrorAttachments(messageRowToMessage(r)));
  }
  /**
   * 第 91 波（架构级修正）：索引是**可重建的查询索引**，日志才是权威 ——
   * 所以索引不可用时（数据库致命状态 / SQL 报错）**不能让读路径整体失败**：
   * 返回空列表，交给 `listMessagesMerged` 用权威日志拼出完整历史。
   * 原来这里 `getDatabase()` 直接抛错 → 数据库一崩，连"读会话历史"都失败，
   * 明明日志里一切都还在。
   *
   * B 态（端口在 rust、该会话镜像未就绪/被截断）：**不碰旧库**，直接返回空列表。
   * 原来会走到下面的 `getDatabase()` 并抛，被 catch 后同样是空列表 —— 但会顺带
   * 打一行"索引暂不可用"的告警：在 B 态这是**误导性的噪音**（索引没坏，只是镜像
   * 还在加载），而且会让"索引坏了"这个信号在日志里贬值。
   */
  return [];
}

/** List only non-hidden messages (for LLM context building) */
export function listVisibleMessages(sessionId: string): Message[] {
  const all = listMessages(sessionId);
  return all.filter(m => !(m as any).hidden);
}

/**
 * List all attachments across all sessions (for cross-session reuse).
 * Returns attachments with their owning session_id and message_id.
 *
 * P0-FIX: Excludes the `content` column from the listing query. Previously
 * this SELECT loaded every attachment's FULL TEXT CONTENT into memory —
 * for a 2000-page document that's tens of MB per row. Now only metadata is
 * loaded; content is fetched on demand via {@link getAttachmentContent}.
 * Also adds a default LIMIT of 200 to prevent unbounded result sets.
 */
export function listAllAttachments(limit?: number): Array<MessageAttachment & { sessionId: string; messageId: string }> {
  const effectiveLimit = limit ?? 200;
  /**
   * **端口优先**（第 14 轮）：附件元数据走域镜像（`attachments` 已按列投影，**不含正文**），
   * 排序与截断在镜像上做（旧 SQL 是 `ORDER BY added_at DESC LIMIT n`）。
   * 正文仍然按需取（`getAttachmentContent` → `attachments.content` + 同步缓存）。
   */
  const viaPort = domainReadMany<Record<string, unknown>>(ATTACHMENT_TABLE, (r) => r);
  if (viaPort) {
    return viaPort
      .map((r) => ({
        id: String(r.id ?? ""),
        sessionId: String(r.session_id ?? ""),
        messageId: String(r.message_id ?? ""),
        name: String(r.name ?? ""),
        type: String(r.type ?? "file") as "file" | "image" | "code" | "url",
        path: (r.path as string | undefined) ?? undefined,
        content: undefined, // 按需取：getAttachmentContent
        preview: (r.preview as string | undefined) ?? undefined,
        sandboxPath: (r.sandbox_path as string | undefined) ?? undefined,
        mimeType: (r.mime_type as string | undefined) ?? undefined,
        size: typeof r.size === "number" ? (r.size as number) : undefined,
      }))
      .sort((a, b) => {
        const av = viaPort.find((r) => String(r.id) === a.id)?.added_at;
        const bv = viaPort.find((r) => String(r.id) === b.id)?.added_at;
        return Number(bv ?? 0) - Number(av ?? 0);
      })
      .slice(0, effectiveLimit);
  }
  return [];
}

/**
 * P0-FIX: Lazy-load a single attachment's content by ID. This prevents the
 * listing query from pulling every attachment's full text into memory —
 * only the specific attachment the LLM requested is loaded.
 */
/**
 * 大附件内容外置（第 80 波）。
 * 返回要写进 `content` 列的值（标记或原文）与 `preview` 列的值。
 * 失败时回退内联 —— 宁可库大一点，也不能把附件内容丢掉。
 */
function externalizeIfLargeSync(att: MessageAttachment): { content: string | null; preview: string | null } {
  const content = typeof att.content === "string" ? att.content : null;
  const preview = att.preview ?? null;
  if (!content) return { content, preview };

  if (isExternalContent(content)) return { content, preview }; // 已经外置过
  if (content.length <= DEFAULT_EXTERNALIZE_THRESHOLD) return { content, preview };
  // 同步路径**先写内联**（保证不丢数据），同时排队外置；外置成功后把标记写回数据库。
  // 这样 `createMessage` 不必变成 async —— 几十处调用点都依赖它是同步的。
  queueAttachmentExternalization(att.id, att.name, content);
  return { content, preview };
}

/** 排队把附件内容外置（异步、幂等、失败保留内联） */
const pendingExternalization = new Set<string>();
function queueAttachmentExternalization(attachmentId: string, name: string, content: string): void {
  if (pendingExternalization.has(attachmentId)) return;
  pendingExternalization.add(attachmentId);
  void (async () => {
    try {
      const { marker, preview } = await externalizeAttachmentContent(attachmentId, name, content);
      /**
       * **端口优先**（第 14 轮）：外置成功后把 `file:<路径>` 标记写回库。
       *
       * 旧实现只有旧库一条路 —— rust 模式下它被门控挡住直接返回，于是
       * **标记永远写不回去**：库里的 `content` 还是那份大正文（内联），
       * 而外置文件已经落在磁盘上（白写一份），列表里的附件也不会显示为"已外置"。
       * Rust 侧本来就有 `attachments.update`（`content`/`preview` 均为 COALESCE 语义）。
       */
      const port = rustMessagePort();
      if (port) {
        /**
         * 标记本身也进同步缓存：`getAttachmentContent()` 命中它之后会走**文件缓存**，
         * 于是"已外置且已预热"的附件在 B 态也能同步读到全文（不必先失败一次再重试）。
         * 标记是几个字符的短串，缓存它没有内存代价。
         */
        attachmentContentCache.set(attachmentId, marker);
        void port.data
          .execute("attachments.update", { id: attachmentId, content: marker, preview })
          .catch((e) => {
            reportPersistFailure("message.attachmentExternalize", e, "附件外置标记未写回（正文保留内联，不影响使用）");
          });
      } else {
        reportWriteNotAccepted("message.attachmentExternalize", "附件未外置（正文保留内联，不影响使用）");
        return;
      }
      await hydrateAttachmentsForSession([{ id: attachmentId, content: marker }]);
    } catch (e) {
      console.warn("[Attachment] 外置失败，保留内联（不影响使用）:", e);
    } finally {
      pendingExternalization.delete(attachmentId);
    }
  })();
}

/**
 * 把一条消息写进**端口侧**的全文索引（`fts.upsert`）。
 *
 * @returns true = 已交给端口（调用方不要再走旧库）
 *
 * 失败只上报、不抛：与"索引可由日志重建"的定位一致 —— 搜索暂时漏一条，
 * 远好过让写消息的主流程失败。下一次 `rebuildSessionFts` 会把内容对齐回来。
 */
function indexFtsForMessageViaPort(sessionId: string, message: Message): boolean {
  const port = rustMessagePort();
  // 第 17 轮（L4）：原来的 `|| shouldFallbackToLegacy()` 已删 —— 该判据恒为 false（A 态已不存在）
  if (!port) return false;
  void port.data
    .execute("fts.upsert", {
      session_id: sessionId,
      message_id: message.id,
      content: message.content ?? "",
      role: message.role ?? "",
      timestamp: message.timestamp ?? Date.now(),
    })
    .catch((e) => reportPersistFailure("message.fts.upsert", e, "全文索引未更新（该条消息暂时搜不到，会话对齐时会补上）"));
  return true;
}

/** 从**端口侧**全文索引移除若干消息（删除/隐藏后调用，避免留下"命中却打不开"的孤儿行） */
function removeFtsViaPort(sessionId: string, ids: string[]): void {
  const port = rustMessagePort();
  // 第 17 轮（L4）：同上，`shouldFallbackToLegacy()` 判据已删
  if (!port || ids.length === 0) return;
  void port.data
    .execute("fts.remove", { session_id: sessionId, ids })
    .catch((e) => reportPersistFailure("message.fts.remove", e, "全文索引里的旧行未清除（搜索可能命中已删除的消息）"));
}

/**
 * 重建全文检索索引，使其与"读者能看到的消息"严格一致（第 80 波收尾项）。
 *
 * 背景：`session_fts` 是独立表、没有外键级联 —— 索引被裁剪（或消息被删除）之后，
 * FTS 里会留下**孤儿行**（真机实测 112 条）。上一波靠 `getMessage` 回退保证了"命中还能打开"，
 * 但那只是兜住了读取；这一版把一致性做正：
 *   - 删掉"既不在索引、也不在日志镜像"的行（消息已被墓碑删除）；
 *   - 为"在日志镜像里但不在 FTS 里"的消息补行（被裁掉但仍可读的历史，搜索也应该能搜到）。
 *
 * @returns 删除与补充的行数
 */
export async function rebuildSessionFts(sessionId: string): Promise<{ removed: number; added: number }> {
  const out = { removed: 0, added: 0 };

  /**
   * **B 态（rust 引擎）走端口的 `fts.rebuild`**（P5 第 11 段，真机缺陷修正）。
   *
   * 原实现第一行就是 `isFts5Available()` —— 而那个标志只在**旧库初始化**时置真，
   * rust 引擎下旧库刻意不加载 → 它恒为 false → 整个函数**直接返回 {0,0}**。
   * 后果不是"少一次优化"，而是：**rust 模式下新写入的消息永远不进全文索引**
   * （Rust 侧的 `messages.upsert_index` 只管 messages 表，FTS 由渲染侧负责对齐），
   * 于是"搜索"只能搜到迁移那一刻的老消息。
   *
   * Rust 侧 `fts.rebuild` 的语义与这里完全对齐（删孤儿 / 补缺 / 内容不符就重写，
   * 且用 `fts::tokenize` 做中文 bigram 切分）；日志里存在但索引里没有的 id 通过
   * `keep_ids` 传过去，避免被当成孤儿删掉。
   */
  // 端口没接手时的诚真空结果：索引对齐无可作为（返回 {0,0}）
  const port = rustMessagePort();
  if (!port) return out;
  const keepIds = (cachedLogMessages.get(sessionId) ?? []).map((m) => m.id);
  try {
    /**
     * ⚠️ 必须用**结构化结果**那条通道（`data.command`），**不能**用 `data.execute`。
     *
     * `execute` 刻意把结果压成 `{ written }`（见 `rust-port.ts` 的说明），而
     * `fts.rebuild` 的真实结果是 `{ removed, added, refreshed, skipped_null_id, … }` ——
     * 用 `execute` 调它，这几个字段**永远读不到**，`?? 0` 一兜底就恒报 `{removed: 0, added: 0}`：
     * 于是这行"索引对齐"日志**从不打印**，而 `message-port-coverage.test.ts` 又把这个 0
     * 断言成了期望值 —— CI 从结构上看不见这个缺陷（第 45 轮线协议审计的 P1-1）。
     *
     * 与 `migration.auto` 踩过的坑是同一个：**契约对不上时不许猜**。
     * `command` 是**可选能力**（`port.ts` 有说明），缺能力时**抛**而不是静默返回 0 ——
     * 与 `maintenance.ts::structuredCommand` 同一条纪律：缺能力要如实表达成"这一步失败"。
     */
    const structured = port.data.command;
    if (!structured) {
      throw new Error("端口没有 command 能力，无法执行 fts.rebuild（结构化结果读不到）");
    }
    const res = (await structured.call(port.data, "fts.rebuild", {
      session_id: sessionId,
      keep_ids: keepIds,
    })) as { removed?: number; added?: number; refreshed?: number };
    out.removed = Number(res?.removed ?? 0);
    out.added = Number(res?.added ?? 0) + Number(res?.refreshed ?? 0);
    if (out.removed > 0 || out.added > 0) {
      console.log(
        `[FTS] 会话 ${sessionId} 索引对齐（rust）：删除孤儿 ${res?.removed ?? 0} 条、补齐 ${res?.added ?? 0} 条、重写 ${res?.refreshed ?? 0} 条`,
      );
    }
  } catch (e) {
    reportPersistFailure("message.rebuildSessionFts", e, "会话全文索引未对齐（搜索可能漏掉新消息）");
  }
  return out;
}

/**
 * `file:` 标记 → 正文（命中缓存就返回全文，否则触发一次异步预取并返回 `undefined`）。
 *
 * 抽成函数是因为现在有**两条**来源（端口按 id 取的缓存 / 旧库的 content 列）都要走同一套
 * 标记语义 —— 第 80 波定的约定：**绝不把 `file:` 标记当正文返回给调用方**。
 */
function resolveAttachmentText(text: string): string | undefined {
  if (!text.startsWith("file:")) return text;
  const path = text.slice("file:".length);
  const cached = getCachedExternalContent(path);
  if (cached !== undefined) return cached;
  void warmExternalContent(path);
  console.warn("[getAttachmentContent] 外置附件尚未预热，已触发预取（请重试一次）:", path);
  return undefined;
}

export function getAttachmentContent(id: string): string | undefined {
  /**
   * **端口优先 + 同步缓存**（第 14 轮）：正文不进镜像（可能是几十 MB），
   * 改为按 id 单独取、取回来缓存在渲染进程里（见 `warmAttachmentContent`）。
   * 未命中时返回 `undefined` 并触发一次预取 —— 与"外置附件尚未预热"完全同一套约定：
  **宁可说"还没预热"，也绝不把标记当正文**。
   */
  const cachedContent = attachmentContentCache.get(id);
  if (cachedContent !== undefined) return resolveAttachmentText(cachedContent);
  // 端口没接手：正文读不到 —— 如实说“尚未预热”并触发一次预取（调用方按既有约定重试）
  warmAttachmentContent(id);
  console.warn(`[getAttachmentContent] 附件 ${id} 正文尚未预热，已触发预取（请重试一次）`);
  return undefined;
}

/**
 * 列出所有 `file:` 外置附件的 `{id, content}`（P5 第 2 段）。
 *
 * 用途：启动维护时预热外置附件正文（`hydrateAllAttachments`）。
 * 走域端口是为了让这一步不再依赖 WASM 库 —— 它读的只是"外置标记"（`file:<路径>`），
 * 不是正文本身，所以镜像里那份内容完全够用（正文在文件里，按需预热）。
 * 端口不可用时返回 `undefined`，调用方回退旧库。
 */
export function listExternalAttachmentMarkers(): Array<{ id: string; content: string }> | undefined {
  const rust = domainReadMany<{ id: string; content: string }>(
    ATTACHMENT_TABLE,
    (row) => ({ id: String(row.id ?? ""), content: String(row.content ?? "") }),
  );
  if (!rust) return undefined;
  return rust.filter((r) => r.content.startsWith("file:"));
}

export function getMessage(id: string): Message | null {
  /**
   * P5 第 10 段（**读写分裂修正**）：`createMessage` / `updateMessage` 早就把索引写发往
   * Rust 了（`writeIndexViaRust`），但这里一直是**只读旧库**。
   *
   * 后果是一个很难在真机上发现的形态：新消息（Rust 接手之后创建的那些）在旧库里
   * **根本没有行**，于是 `getMessage(id)` 只能靠下面"扫日志镜像"那条兜底 —— 而日志镜像
   * 要先被 hydrate 过才在内存里。换句话说，"消息明明存在、按 id 取却取不到"取决于
   * 某个缓存有没有预热过，而不是数据在不在。
   *
   * 这条分裂**是测试基座（纯端口）逼出来的**：一旦测试不再回退旧库，194 个断言立刻
   * 指向它。修法是让**读跟在写后面**：与 `listMessagesFromIndex` 用同一条路由规则
   * （会话镜像已完整加载且未被截断 → 读镜像），镜像未就绪时保持原行为，一字节不变。
   */
  const port = rustMessagePort();
  const routed = port?.messages;
  const portRow = routed?.byIdLookup(id);
  if (routed && portRow) {
    routed.ensureLoaded(portRow.session_id);
    if (routed.isLoaded(portRow.session_id) && !routed.isTruncated()) {
      const mirrored = routed.byIdLookup(id);
      if (mirrored) {
        /**
         * ⚠️ 镜像行**不含 `tool_calls`**（`MirrorMessageRow` 刻意只有 9 个字段：
         * 镜像要装的是"几百 KB × N 个会话"的正文，工具结果全文再进镜像等于把
         * P6 刚清掉的内存占用请回来）。
         *
         * 所以工具调用的形状是"**同步缓存命中就带上，未命中先触发一次异步预热**"：
         * 与附件正文（`getCachedExternalContent` + `warmExternalContent`）同一套约定 ——
         * 缓存由**写路径**（`addToolCall` / `updateToolCall` / `upsert_index`）负责维护，
         * 因此"刚写的立刻读得到"，不依赖旧库那一行存在不存在。
         */
        const cached = toolCallCache.get(id);
        if (!cached) warmToolCalls(id);
        /**
         * `byIdLookup` 的声明只覆盖"定位字段"（id / session_id），所以这里要显式放宽一次：
         * 真实实现返回的是**完整镜像行**（`MirrorMessageRow`）。
         * 保持窄声明是为了防止有人拿它当"读整行"用 —— 镜像行不含 `tool_calls`。
         */
        const message = messageRowToMessage(mirrored as unknown as Parameters<typeof messageRowToMessage>[0]);
        if (cached) return { ...message, toolCalls: cached } as Message;
        /**
         * **同步兜底：权威日志镜像里就带 `toolCalls`**（第 14 轮修正）。
         *
         * 上面的注释说"缓存由写路径维护，因此刚写的立刻读得到" —— 但写路径之外还有两条
         * 会产生工具调用的路径：**索引重建**（`messages.rebuild_index` 把日志里的消息写回索引）
         * 与**会话打开时的 hydrate**。这两条路都不经过 `addToolCall`，于是缓存是空的，
         * 而这里一旦命中镜像行就**直接返回**，永远不会走到下面那段日志兜底 ——
         * 真实形态：**重启/重建索引之后，工具调用在界面上整批消失**（fork 复制也跟着丢）。
         *
         * 日志是权威副本，它就在内存里（`cachedLogMessages`），同步读一次几乎零成本：
         * 命中就顺手填进缓存，让后续读都走快路径。
         */
        const enriched = withMirrorAttachments(message);
        const logSessionId = sessionIdFromLogMirror(id);
        if (logSessionId) {
          const fromLog = logMirrorMessage(logSessionId, id);
          if (fromLog?.toolCalls && fromLog.toolCalls.length > 0) {
            cacheToolCalls(id, fromLog.toolCalls);
            return { ...enriched, toolCalls: fromLog.toolCalls } as Message;
          }
        }
        return enriched;
      }
    }
  }

  /**
   * 权威日志镜像这条兜底**要提前**：日志里带 `toolCalls`（`logMirrorMessage` 会一起返回），
   * 而旧库那条读路径对"Rust 接手之后新建的消息"根本查不到行 —— 顺序反了就会出现
   * "从日志兜底拿到内容、但工具调用全靠旧库 → 结果为空"。
   */
  const logSessionId = sessionIdFromLogMirror(id);
  if (logSessionId) {
    const fromLog = logMirrorMessage(logSessionId, id);
    if (fromLog) return fromLog;
  }

  /**
   * B 态（端口在 rust）：镜像与日志镜像都没命中 → 这条消息**在这个进程里读不到**，
   * 而不是"去旧库再找找"。旧库在 rust 模式下刻意不存在，原来这里会抛一次
   * （被下面 catch 住并打告警）—— 告警在 B 态是误导，且真正的答案是"没有"。
   */
  return null;
}

/**
 * 写入一条消息。
 *
 * 第 91 波（**架构级**修正）：**权威日志先写，索引尽力而为。**
 *
 * 本仓库的分层是"追加日志（JSONL）= 权威存储，SQLite = 可重建的查询索引"（第 78 波定的），
 * 但写入顺序一直是反的：先 `getDatabase()` + INSERT/UPDATE + `persistDatabase()`，
 * **最后**才 `appendSessionMessage(...)`。于是索引一出问题（WASM 陷阱、致命闩锁、SQL 报错），
 * 函数在第一行就抛掉，**权威日志那一步根本没执行** —— 用户那 113 条消息之所以危险，
 * 根子就在这：号称权威的那份副本，成了最脆弱那条路径的最后一道。
 *
 * 现在的顺序是：①日志先落盘（不受索引影响）→ ②再写索引；索引失败只上报、不再让调用方失败。
 */
export function createMessage(message: Message, sessionId: string): void {
  // ① 权威日志：追加即持久，不碰索引、不做整库导出
  void appendSessionMessage(sessionId, message);

  // ② 索引：尽力而为。索引崩了不影响上面那条已经落盘的记录。
  //
  // ⚠️ 第 18 轮**不要**在这里加"存储不可用就 return"的短路：原来的 `isDatabaseFatal()` 早退
  // 是防"往已崩的 WASM 堆上反复撞"，而端口世界没有那个问题 —— 端口不在时
  // `writeMessageIndex` 内部会走 `reportWriteNotAccepted` **如实上报**。
  // 短路会让"索引没写"变成静默无动作（实测：MSG-4 立刻变红，抓的正是这一点）。
  try {
    writeMessageIndex(message, sessionId);
  } catch (e) {
    // 旧实现用 `noteDatabaseError(e)` 分类"是否致命"再决定报不报；分类机制随旧引擎删除，
    // 现在一律如实上报（索引失败永远只影响索引，不影响已落盘的权威日志）。
    reportPersistFailure("message.createMessage.index", e, "消息已写入权威日志，但查询索引更新失败（索引可由日志重建）");
  }
}

/**
 * 分叉时的**消息复制**：把源会话的一条消息复制进子会话。
 *
 * ## 为什么必须有这个函数（第 45 轮功能上下文审计 P1-D3）
 *
 * 分叉原来的实现（`core/store.ts` 里那几行）只给**消息 id** 与**工具调用 id** 换了新值，
 * 附件 id 原样带过去。而附件的主键是 `attachments.message_id` + `attachments.id`，
 * 写入走 `crud.upsert mode:"replace"` —— 于是同一次分叉会用**同一个附件 id**
 * 把那一行的 `message_id` 覆盖成子会话的新消息 id：**源会话那条消息的附件被搬走**
 * （源消息点开附件面板是空的，子会话带着源会话的同一批附件）。
 *
 * 所以：消息 id / 工具调用 id / **附件 id 三者一起换新**，附件正文按新 id 重新落库。
 *
 * ## 附件正文从哪来（不能只是 `att.content`）
 *
 * 读路径给消息补附件时（`attachmentsFromMirror`）**不投影正文**（正文可能几十 MB，
 * 见那里的注释），所以 `att.content` 在真机常态下是 `undefined`。若直接把它写下去，
 * 子会话会得到一条"有名字、点开没内容"的假附件。因此按"内联正文 → 域镜像那一行的
 * content 列（内联正文或 `file:` 外置标记）→ 本进程同步缓存"的顺序解析；
 * 三者都取不到时**跳过该附件并告警**（宁可不带，也不写一条空壳行）。
 *
 * @returns 子会话里这条消息的新 id（调用方通常不需要，测试与调用点用它做断言）
 */
export function copyMessageToSession(message: Message, targetSessionId: string, suffix: string): string {
  const newId = `${message.id}-fork-${suffix}`;
  let attachments: MessageAttachment[] | undefined;
  if (message.attachments && message.attachments.length > 0) {
    attachments = [];
    for (const att of message.attachments) {
      const content = attachmentContentForCopy(att);
      if (content === undefined) {
        console.warn(
          `[fork] 附件 ${att.id}（${att.name}）正文取不到，未复制进子会话（源会话的附件不受影响）`,
        );
        continue;
      }
      attachments.push({ ...att, id: `${att.id}-fork-${suffix}`, content });
    }
  }
  const copy: Message = {
    ...message,
    id: newId,
    toolCalls: message.toolCalls?.map((tc) => ({ ...tc, id: `${tc.id}-fork-${suffix}` })),
    ...(attachments ? { attachments } : {}),
  };
  createMessage(copy, targetSessionId);
  return newId;
}

/** 复制附件时解析正文（顺序与理由见 `copyMessageToSession`） */
function attachmentContentForCopy(att: MessageAttachment): string | undefined {
  if (typeof att.content === "string" && att.content.length > 0) return att.content;
  const row = domainReadOne<{ content: string | null }>(
    ATTACHMENT_TABLE,
    { id: att.id },
    (r) => ({ content: (r.content as string | null) ?? null }),
  );
  if (row?.content) return row.content;
  const cached = attachmentContentCache.get(att.id);
  if (cached) return cached;
  return undefined;
}

// ========== 迁移期：索引写分流到 Rust（P3 第 6 段） ==========
//
// ## 为什么索引写要整体交给 Rust
//
// 渲染侧的索引写不是"一次简单 upsert"：它要同时处理 messages 主行 +
// `generated_files` / `retrieved_sources` 两个 JSON 列 + **整批替换 tool_calls**
// （先 DELETE 再逐条 INSERT）。拆成多条 IPC 的话，中途失败会留下
// "消息更新了但工具调用只写了一半"的不一致状态。
// 所以 Rust 侧做成单事务复合命令 `messages.upsert_index`，这里只负责把行数据传过去。
//
// ## 为什么这次可以直接切（与只追加面不同）
//
// `createMessage` / `updateMessage` 的结构本来就是：
//   ① 权威日志（先写、必须成功）→ ② 索引（尽力而为、失败上报）
// 索引侧**已经很明确地是"best-effort + 可重建"**：失败会走 `reportPersistFailure`，
// 而数据不丢（权威副本在会话 JSONL 里）。
// 因此把 ② 换成"异步发往 Rust"不引入新的丢数据风险，也不产生读写分裂
// （读的是索引，索引的权威版本在 Rust；旧库那份只是过渡期缓存）。
//
// ## 返回 false 的含义
//
// 返回 false = "本次不接手，请调用方走原来的旧路径"。这样：
// - 端口未注册（**第 19 轮起这是"没有可用存储"的唯一形态**；原来的"引擎是 wasm"已随旧引擎删除）
//   → 完全维持原行为；
// - 读不到 base 行（更新路径）→ 回退到原路径，不猜数据。

type RustMessagePortLike = {
  data: {
    execute(cmd: string, params?: Record<string, unknown>): Promise<{ written: number }>;
    /**
     * **结构化结果**通道（第 45 轮线协议审计 P1-1 之后这里必须有它）。
     *
     * 声明成可选：它是可选能力（`port.ts` 的 `StorageDataPort.command?`），
     * 调用方必须显式处理"没有它"这一态（`fts.rebuild` 就是这么做的：缺能力就抛，
     * 而不是静默返回 0 —— "字段读不到就取默认值"正是本项目一直在消灭的模式）。
     */
    command?: <R>(cmd: string, params?: Record<string, unknown>) => Promise<R>;
  };
  messages?: {
    isLoaded(sessionId: string): boolean;
    /**
     * 镜像**正在加载中**（第 49 轮）。
     *
     * 声明成可选：真实端口与内存端口都有，但极简假端口可能没有 ——
     * 缺省时按"不是在途"处理（退化成旧行为：分不清"还没到"与"读不到"，
     * 与改之前一致，不会更糟）。
     */
    isLoading?(sessionId: string): boolean;
    isTruncated(): boolean;
    ensureLoaded(sessionId: string, onLoaded?: () => void): void;
    list(sessionId: string): Array<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      reasoning?: string | null;
      timestamp: number;
      model?: string | null;
      status?: string | null;
      hidden?: number;
      /** 索引裁剪标记（第 44 轮）：`hidden=1 && trimmed=1` = 被裁剪而不是被压缩 */
      trimmed?: number;
    }>;
    byIdLookup(id: string): { id: string; session_id: string } | undefined;
    hiddenIds(sessionId: string): Set<string>;
    count(sessionId: string): number;
    /**
     * 作废并重新加载该会话镜像（第 38 轮）。
     *
     * 声明为可选：真实端口（`RustMessageMirror`）与测试用的内存端口都有，
     * 但契约测试里的极简假端口可能没有 —— 缺省时 `reloadSessionMessages`
     * 会退化成"只清日志缓存"的旧行为，不会抛。
     */
    reload?(sessionId: string, onLoaded?: () => void): void;
  };
  applyMessageWrite?(row: Record<string, unknown> & { id: string; session_id: string }): void;
  applyMessageDelete?(sessionId: string, ids: string[]): void;
  /**
   * 索引裁剪的镜像同步（第 44 轮）：把这批行标成 `hidden=1, trimmed=1`。
   *
   * 声明为可选：真实端口与假端口都有，但契约测试里的极简假端口可能没有 ——
   * 缺省时读路径靠引擎下次加载时的真实列值收敛（不会抛、不会错）。
   */
  applyMessageTrim?(sessionId: string, ids: string[]): void;
};

/**
 * `tool_calls` 的同步读缓存（P5 第 10 段）。
 *
 * ## 为什么需要它
 *
 * 消息索引早就分流到 Rust 了（`writeIndexViaRust`），而 `tool_calls` 一直是"写旧库"：
 * `addToolCall` / `updateToolCall` 走 `getDatabase()`，`getMessage` 也从旧库读。
 * 于是工具调用成了整条消息链上**最后一处读写分裂**：
 * - 消息正文：写在 Rust、读在镜像 ✅
 * - 工具调用：写在旧库、读在旧库，但 Rust 侧那份只有 `upsert_index` 时写过一次
 *
 * 后果直接对应用户现场那个现象 —— **模型看不到自己这次调用的结果**（于是反复重发同一个
 * 工具调用）。这里补上缓存，让"刚写进去的工具调用立刻读得到"，与消息正文同一条规则。
 *
 * ## 为什么是缓存而不是镜像
 *
 * 工具结果全文往往很大，进镜像等于把 P6 刚清掉的内存占用请回来。所以：
 * 按 `messageId` 存"这条消息的工具调用"，只在**被读过**的消息上驻留，且有上限。
 */
/**
 * 本进程内**已软删除（hide）**的消息 id，按会话分组（第 39 轮）。
 *
 * 用途见 `hiddenMessageIds` 的说明：镜像未就绪时，它是"刚隐藏过"这一事实的唯一来源，
 * 缺了它就会把已压缩的消息复活（用户现场那个"移除 840 条、token 一点没降"）。
 * 容量有界：每个会话最多记 5 万个 id，超出丢最旧的（宁可少记也不无限涨）。
 */
const localHiddenIds = new Map<string, Set<string>>();
const LOCAL_HIDDEN_MAX = 50_000;

function rememberHidden(sessionId: string, id: string): void {
  let set = localHiddenIds.get(sessionId);
  if (!set) {
    set = new Set<string>();
    localHiddenIds.set(sessionId, set);
  }
  set.add(id);
  if (set.size > LOCAL_HIDDEN_MAX) {
    // Set 迭代序 = 插入序：删掉最早的那批
    const drop = set.size - LOCAL_HIDDEN_MAX;
    let n = 0;
    for (const old of set) {
      set.delete(old);
      if (++n >= drop) break;
    }
  }
}
const TOOL_CALL_CACHE_LIMIT = 200;
const toolCallCache = new Map<string, ToolCall[]>();

function cacheToolCalls(messageId: string, calls: ToolCall[]): void {
  // Map 的插入序即 LRU 序：删了再插 = 移到最近使用
  toolCallCache.delete(messageId);
  toolCallCache.set(messageId, calls);
  while (toolCallCache.size > TOOL_CALL_CACHE_LIMIT) {
    const oldest = toolCallCache.keys().next().value;
    if (oldest === undefined) break;
    toolCallCache.delete(oldest);
  }
}

/** 写路径调用：缓存立即反映本次写入（不依赖任何异步往返） */
function mergeCachedToolCall(messageId: string, call: ToolCall): void {
  const existing = toolCallCache.get(messageId) ?? [];
  const idx = existing.findIndex((c) => c.id === call.id);
  const next = idx >= 0 ? existing.map((c) => (c.id === call.id ? call : c)) : [...existing, call];
  cacheToolCalls(messageId, next);
}

const toolCallWarmInFlight = new Set<string>();

/**
 * 异步预热某条消息的工具调用（端口可用时走 Rust）。
 * 未命中缓存时触发，下一次同步读即命中 —— 与附件正文预热同一套约定。
 */
function warmToolCalls(messageId: string): void {
  const port = rustMessagePort();
  if (!port || toolCallWarmInFlight.has(messageId)) return;
  toolCallWarmInFlight.add(messageId);
  /**
   * ⚠️ **必须走 `command`（返回结构化结果），不能用 `execute`**（第 14 轮修正）。
   *
   * `data.execute` 刻意把结果压成 `{ written }`（见 `rust-port.ts` 的说明）——
   * 用它读 `tool_calls.list` 永远拿不到 `items`，于是这个"异步预热"**从来没有预热成功过**：
   * 缓存一直是空的，而 `getMessage` 的端口分支只认那个缓存（它不读旧库），
   * 真实形态就是"**刚写的工具调用、同步读读不到**"，连带 fork 复制时整批丢失。
   */
  const probe = port.data as unknown as {
    command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
  };
  const call = probe.command
    ? probe.command<{ items?: unknown[] }>("tool_calls.list", { message_id: messageId })
    : port.data.execute("tool_calls.list", { message_id: messageId });
  void call
    .then((r) => {
      const rows = (r as { items?: unknown[] })?.items;
      if (!Array.isArray(rows)) return;
      cacheToolCalls(
        messageId,
        rows.map((raw) => {
          const o = (raw ?? {}) as Record<string, unknown>;
          let args: Record<string, unknown> = {};
          try {
            args = typeof o.args === "string" ? JSON.parse(o.args) : ((o.args as Record<string, unknown>) ?? {});
          } catch {
            args = {};
          }
          let metadata: Record<string, unknown> | undefined;
          try {
            metadata =
              typeof o.metadata === "string" ? JSON.parse(o.metadata) : (o.metadata as Record<string, unknown> | undefined);
          } catch {
            metadata = undefined;
          }
          return {
            id: String(o.id ?? ""),
            tool: String(o.tool ?? ""),
            args,
            result: (o.result as string | null) ?? undefined,
            status: (o.status as ToolCall["status"]) ?? "running",
            ...(metadata ? { metadata } : {}),
          } as ToolCall;
        }),
      );
    })
    .catch((e) => {
      // 工具调用热身失败不阻塞读：下面是旧库兜底
      reportPersistFailure("message.toolCalls.warm", e, "工具调用未能从索引预热（本次读回退旧路径）");
    })
    .finally(() => toolCallWarmInFlight.delete(messageId));
}
function rustMessagePort(): RustMessagePortLike | null {
  if (!hasStoragePort()) return null;
  // 第 19 轮：`if (port.kind !== "rust") return null;` 已删（`kind` 是常量 "rust"，恒不成立）。
  return getStoragePort() as unknown as RustMessagePortLike;
}

/**
 * 取某会话可用的 Rust 消息索引源 —— **未加载完就返回 null**（读写必须同处）。
 *
 * 这条规则与只追加面完全一致：只有该会话的索引**已完整加载**，才允许读写都走 Rust。
 * 否则继续用旧库那份（旧库的 hidden 状态虽然旧，但读写都在同一处，不会出现
 * "写进 Rust、读到的 hidden 是旧的"这种把压缩消息复活的情形）。
 *
 * 副作用：每次调用都会顺带触发一次惰性加载，因此最迟在该会话第二次访问时切过来。
 */
function rustMessageSource(sessionId: string): RustMessagePortLike | null {
  const port = rustMessagePort();
  if (!port?.messages) return null;
  port.messages.ensureLoaded(sessionId);
  if (!port.messages.isLoaded(sessionId)) return null;
  // 加载被上限截断时不能用镜像（集合不完整 → hidden 判定会错 → 可能复活消息）
  if (port.messages.isTruncated()) return null;
  return port;
}

/**
 * 这次读**有没有真的拿到数据**（第 47 轮补，UI/UX 审计 P1）。
 *
 * ## 为什么需要它
 *
 * `listMessages(sessionId)` 返回空有两种完全不同的原因，而调用方（UI）只看得到"空"：
 * 1. 这个会话**确实没有消息**（新建的、或用户删光了）→ 界面显示"开始新对话"是对的；
 * 2. **读没有真的发生**（端口未注册 / 该会话的消息镜像还没接手 / 被上限截断）
 *    → 界面显示"开始新对话"是**错的**：用户会以为自己 27 条消息的会话被清空了
 *    （仓库自己记过一次真机事故，就是这个形态），之后输入的每句话都追加进这个
 *    他以为"空"的会话。
 *
 * ## 判据为什么不看"返回了空"
 *
 * 因为"空"本身分不出上面两种。这里看的是**读路径是否处于可用状态**：
 * 与 `rustMessageSource()` 完全同一套判据（端口在 + 该会话镜像已加载 + 没被截断），
 * 只是把"不路由"这件事**如实报出来**而不是静默降级。
 *
 * ⚠️ 有一个诚实的残留缺口：**端口就绪、镜像也加载了，但 JSONL 权威日志还没 hydrate**
 * 时，`listMessages` 可能仍然返回空。那种情况下这里会说"读到了"，
 * 界面于是显示欢迎页 —— 与改之前的行为一致（不会更糟），
 * 而 store 里那条"空结果就订阅镜像就绪后重读"的补丁正是为它准备的。
 * 要彻底消掉这个缺口得让 `listMessages` 自己区分三态，那是另一次改造。
 */
export function isMessagesReadUnavailable(sessionId: string): boolean {
  let unavailable = false;
  try {
    const port = rustMessagePort();
    if (!port?.messages) {
      // 端口没注册 / 没有 messages 能力 —— 这次读根本没有数据源
      unavailable = true;
    } else {
      port.messages.ensureLoaded(sessionId);
      if (!port.messages.isLoaded(sessionId)) {
        /**
         * ## 第 49 轮：**"还没到"不是"读不到"**
         *
         * `ensureLoaded` 是**触发**加载（按会话惰性），所以"刚触发、任务在途"
         * 与"触发过但没成功"在这一刻都表现为 `isLoaded === false`。
         * 前者应当渲染成"加载中"，后者才是"暂时读不到"。
         *
         * 真机实测（打包版，277 条消息的会话）：启动后第 225~379ms 界面渲染的是
         * 「暂时读不到这个会话的历史消息」—— 那只是惰性加载的正常过程
         * （154ms 后消息就出来了）。每次启动对着一条 277 条的会话说一次"读不到"，
         * 用户会以为存储坏了；而"喊狼来了"喊多了，真正的"读不到"就没人信了。
         */
        const pending = typeof port.messages.isLoading === "function" && port.messages.isLoading(sessionId);
        if (!pending) unavailable = true;
      } else if (port.messages.isTruncated()) {
        // 被上限截断时镜像不完整：读到的"空/少"都不是真值，同样算"读不到"
        unavailable = true;
      }
    }
  } catch {
    /**
     * 判据本身出错 → 按"读不到"处理（宁可多显示一个重试入口，
     * 也不要把"读不到"渲染成"你没有数据"）。
     *
     * 注意这里**不写裸 `return true`**：那在 B 类（假成功）门禁里是"catch 里返回成功"
     * 的形状，语义含糊。先赋值再统一 return，控制流一眼可读
     * —— 门禁抓到过我一次，它的意见是对的。
     */
    unavailable = true;
  }
  return unavailable;
}

/**
 * 该会话的消息**正在加载中**（第 49 轮）—— "还没到"，不是"读不到"。
 *
 * 与 `isMessagesReadUnavailable` 是**互斥**的两态：
 * 调用方（`store.loadMessages`）据此渲染"加载中"而不是告警。
 * 极简假端口没有 `isLoading` 能力时返回 false（那些端口本来就是同步的、
 * 不存在"在途"这一态）。
 */
export function isMessagesReadPending(sessionId: string): boolean {
  let pending = false;
  try {
    const port = rustMessagePort();
    if (port?.messages && typeof port.messages.isLoading === "function") {
      pending = !port.messages.isLoaded(sessionId) && port.messages.isLoading(sessionId);
    }
  } catch {
    pending = false;
  }
  return pending;
}

/** 镜像行 → Message（与 SQLite 行映射保持同一语义） */
function messageRowToMessage(r: {
  id: string;
  session_id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  timestamp: number;
  model?: string | null;
  status?: string | null;
  /** `generated_files` 的 JSON 文本（第 14 轮：这一列从前没有被映射回来） */
  generated_files?: string | string[] | null;
  /**
   * `retrieved_sources` 的 JSON 文本（**B-3**：这一列同样是"写了但读不回来"）。
   *
   * 两种形态都要认（snake / camel）：镜像行给的是库里的列名 `retrieved_sources`，
   * 而 `Message` 对象上的字段是 `retrievedSources` —— 既有测试与调用方两种拼法都出现过，
   * 只认一种就会在另一条路径上静默丢数据（这正是 `generated_files` 当初的老毛病）。
   */
  retrieved_sources?: string | unknown[] | null;
  retrievedSources?: string | unknown[] | null;
}): Message {
  /*
   * `generated_files` 的解析（第 14 轮修正）。
   *
   * 库里是 TEXT（JSON 文本），历史数据也可能已经是数组。解析失败**不抛**
   * （一条坏数据不该让整次列表读取失败），但也不静默吞成"没有文件"。
   */
  let generatedFiles: string[] | undefined;
  if (typeof r.generated_files === "string" && r.generated_files.trim().length > 0) {
    const parsed = safeJsonParse<string[]>(r.generated_files, []);
    if (Array.isArray(parsed) && parsed.length > 0) generatedFiles = parsed.map(String);
  } else if (Array.isArray(r.generated_files) && r.generated_files.length > 0) {
    generatedFiles = r.generated_files.map(String);
  }
  /**
   * `retrieved_sources`（B-3）。
   *
   * 真 CLI 实测 `messages.get` / `messages.list` 返回的列里**没有**这一列
   * （Rust 侧 `repo.rs` 的 `message_row` 只映射到 `generated_files` 为止），所以
   * rust 模式下这条路径拿不到引用来源 —— **渲染侧先就绪**，等 Rust SELECT 补列
   * （见报告"需要他人配合"）。这里把映射补齐：拿到就解析、解析不出来就当作没有，
   * 与 `generated_files` 同一条规矩（坏一行数据不该让整次读失败）。
   */
  const rawSources = r.retrieved_sources ?? r.retrievedSources;
  let retrievedSources: RetrievedSource[] | undefined;
  if (typeof rawSources === "string" && rawSources.trim().length > 0) {
    const parsed = safeJsonParse<RetrievedSource[]>(rawSources, []);
    if (Array.isArray(parsed) && parsed.length > 0) retrievedSources = parsed;
  } else if (Array.isArray(rawSources) && rawSources.length > 0) {
    retrievedSources = rawSources as RetrievedSource[];
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as Message["role"],
    content: r.content,
    ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    timestamp: r.timestamp,
    ...(r.model ? { model: r.model } : {}),
    status: (r.status ?? "done") as Message["status"],
    ...(generatedFiles ? { generatedFiles } : {}),
    ...(retrievedSources ? { retrievedSources } : {}),
  } as Message;
}

/** 工具调用 → 线协议形状（snake 字段、args/metadata 保留为对象由 Rust 侧序列化） */
function toolCallsForWire(message: Message): Array<Record<string, unknown>> | undefined {
  if (!message.toolCalls) return undefined; // 未提供：交给 Rust 侧"不动"
  return message.toolCalls.map((tc) => ({
    id: tc.id,
    tool: tc.tool,
    args: tc.args ?? {},
    result: tc.result ?? null,
    status: tc.status ?? "running",
    metadata: tc.metadata ?? null,
  }));
}

/**
 * 把一条完整消息行发往 Rust 索引（单事务）。
 * @returns true = 已接手（调用方不要再走旧路径）；false = 未接手
 */
function writeIndexViaRust(message: Message, sessionId: string, scope: "create" | "update"): boolean {
  const port = rustMessagePort();
  if (!port) return false;

  const params: Record<string, unknown> = {
    id: message.id,
    session_id: sessionId,
    role: message.role,
    content: message.content ?? "",
    reasoning: message.reasoning ?? null,
    timestamp: message.timestamp ?? Date.now(),
    model: message.model ?? null,
    status: message.status ?? "done",
    generated_files: message.generatedFiles ?? null,
    retrieved_sources: message.retrievedSources ?? null,
    tool_calls: toolCallsForWire(message),
  };

  /**
   * ⚠️ **先本地、再 IPC**（P5 第 10 段修正）。
   *
   * 原来这个 `applyMessageWrite` 是挂在 `.then()` 里的：写完之后镜像是**等 IPC 往返
   * 落地才更新**的，于是存在一个"写成功、紧接着同步读却是旧值"的窗口。
   * 生产里这个窗口被 UI 渲染节奏盖住了（不容易看到），但它是一条真实的时序缺陷 ——
   * `updateMessage(status)` 之后立刻读回旧 status 就是它的形态。
   *
   * 现在与 `domainWrite` 的约定完全一致（**先更新本地镜像，再写穿**）：
   * 1. 本地立即生效 → "刚写的立刻读得到"；
   * 2. IPC 失败 → 如实上报，并把镜像重新拉一次（`ensureLoaded` 会以 Rust 为准重建），
   *    让"本地镜像"和"落库结果"重新收敛，而不是留一个假的最新值。
   */
  port.applyMessageWrite?.({
    id: message.id,
    session_id: sessionId,
    role: message.role,
    content: message.content ?? "",
    reasoning: message.reasoning ?? null,
    timestamp: message.timestamp ?? Date.now(),
    model: message.model ?? null,
    status: message.status ?? "done",
  });
  /**
   * **工具调用同步缓存也要在这里刷新**（第 14 轮修正）。
   *
   * `message.ts` 里那段注释写着"缓存由**写路径**（`addToolCall` / `updateToolCall` /
   * **`upsert_index`**）负责维护，因此'刚写的立刻读得到'"—— 但这条写路径（`writeIndexViaRust`）
   * 从来没有调用过缓存，于是那句话是**空头承诺**：
   * `getMessage` 的端口分支只认缓存（不读旧库），真实形态就是"刚创建带工具调用的消息，
   * 紧接着同步读读不到 toolCalls"，连带 fork/复制整批丢失。
   *
   * 异步预热（`warmToolCalls`）是兜底，不能当作唯一手段：它是下一次读才生效。
   */
  if (message.toolCalls && message.toolCalls.length > 0) {
    cacheToolCalls(message.id, message.toolCalls);
  }

  void port.data
    .execute("messages.upsert_index", params)
    .catch((e) => {
      // 索引失败不阻塞、不抛：权威副本（会话 JSONL）已经写好，索引可由日志重建
      reportPersistFailure(
        `message.${scope}Message.index`,
        e,
        "消息已写入权威日志，但查询索引更新失败（索引可由日志重建）",
      );
      /**
       * 重新拉一次该会话的索引：镜像里那份"本地先生效"的值可能是错的
       * （落库失败 = Rust 那份没有这次更新），必须以落库结果为准重新收敛。
       */
      port.messages?.ensureLoaded(sessionId);
    });
  return true;
}

/** 消息 → SQLite 索引（createMessage 的索引侧；失败由调用方兜底） */
/**
 * 把消息的附件写进查询索引（**端口优先**，第 14 轮）。
 *
 * @returns true = 已交给端口（调用方不要再走旧库）
 *
 * 细节与旧库路径保持一致：大正文先外置（`externalizeIfLargeSync` → `file:<路径>` 标记），
 * 行里存 `content`/`preview`/`sandbox_path`/`mime_type`/`size`/`added_at`。
 * 失败只上报不抛：附件正文的权威副本是 JSONL 与外置文件，索引可以重建。
 */
/**
 * 从 **attachments 域镜像**取某条消息的附件（元数据；`content` 一律留空、按需取）。
 *
 * 为什么需要它（第 14 轮）：B 态下消息行的读路径（`listMessagesFromIndex` / `getMessage`）
 * 走的是消息镜像，而**附件是另一张表** —— 旧实现在那条路径上从不去取附件，
 * 于是 rust 模式下出现「消息读回来了、附件没了」（用户可见：附件面板/引用消失）。
 * 域镜像对 `attachments` 只投影元数据列，所以这一步**不会**把正文拉进内存。
 *
 * @returns undefined = 该域没接手（A 态由旧库路径负责）
 */
function attachmentsFromMirror(messageId: string): MessageAttachment[] | undefined {
  const rows = domainReadMany<Record<string, unknown>>(ATTACHMENT_TABLE, (r) => r, { message_id: messageId });
  if (!rows) return undefined;
  if (rows.length === 0) return [];
  return rows
    .sort((a, b) => Number(a.added_at ?? 0) - Number(b.added_at ?? 0))
    .map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      type: String(r.type ?? "file") as MessageAttachment["type"],
      content: undefined, // 懒加载：getAttachmentContent
      preview: (r.preview as string | undefined) ?? undefined,
      path: (r.path as string | undefined) ?? undefined,
      sandboxPath: (r.sandbox_path as string | undefined) ?? undefined,
      mimeType: (r.mime_type as string | undefined) ?? undefined,
      size: typeof r.size === "number" ? (r.size as number) : undefined,
    }));
}

/** 给一条已映射好的消息补上附件（仅在端口接手时生效） */
function withMirrorAttachments(message: Message): Message {
  if (message.attachments && message.attachments.length > 0) return message;
  const atts = attachmentsFromMirror(message.id);
  if (!atts || atts.length === 0) return message;
  return { ...message, attachments: atts };
}

function writeAttachmentsViaPort(message: Message, sessionId: string): boolean {
  const atts = message.attachments;
  if (!atts || atts.length === 0) return false;
  const port = rustMessagePort();
  if (!port) return false;
  const now = Date.now();
  const rows = atts.map((att) => {
    const stored = externalizeIfLargeSync(att);
    return {
      id: att.id,
      session_id: sessionId,
      message_id: message.id,
      name: att.name,
      type: att.type,
      path: (att as { path?: string }).path ?? null,
      content: stored.content,
      preview: stored.preview,
      sandbox_path: att.sandboxPath ?? null,
      mime_type: att.mimeType ?? null,
      size: att.size ?? null,
      added_at: now,
    };
  });
  /**
   * **内联正文顺手进同步缓存**：刚创建的附件立刻读得到（与工具调用"写路径维护缓存"同一条规则）。
   *
   * 不加这一步的话，`getAttachmentContent()` 在 B 态第一次读必然是"未预热 → 返回 undefined
   * + 提示重试一次" —— 对**用户刚上传的小附件**来说这是没必要的来回。
   * 只缓存**内联**内容（外置的正文在文件里，仍走文件缓存那套），所以不会把大正文留在内存。
   */
  for (const r of rows) {
    if (
      typeof r.content === "string" &&
      r.content.length > 0 &&
      r.content.length <= DEFAULT_EXTERNALIZE_THRESHOLD && // 大正文即将外置，不进缓存
      !r.content.startsWith("file:")
    ) {
      attachmentContentCache.set(r.id, r.content);
    }
  }
  void port.data.execute("crud.upsert", { table: ATTACHMENT_TABLE, rows, mode: "replace" }).catch((e) => {
    reportPersistFailure("message.attachmentIndex", e, "附件未写入查询索引（正文仍在外置文件/会话日志里）");
  });
  return true;
}

function writeMessageIndex(message: Message, sessionId: string): void {
  /**
   * 全文索引（P1-7 / P5 第 11 段）**必须在这里分流，而不是塞在下面的旧库分支里**。
   *
   * 下面第一行就是"端口接手 → return"，如果把 FTS 那段留在旧库分支的末尾，
   * rust 模式下它**永远不会执行** —— 那正是原来的缺陷（旧库专属的
   * `if (isFts5Available())` 在 rust 模式下恒为 false，新消息永远搜不到）。
   * 所以先按两态把索引这件事做掉：端口在 → `fts.upsert`（Rust 侧同一套 bigram 切分）；
   * 端口不在 → 由下面旧库分支末尾那段插行（一个字节不变）。
   */
  const ftsViaPort = indexFtsForMessageViaPort(sessionId, message);
  /**
   * **附件也要在这里分流**（第 14 轮修正，真机数据缺口）。
   *
   * 原来附件只在下面那段旧库分支里写（`INSERT OR REPLACE INTO attachments`），
   * 而端口接手时那一整段被短路跳过 —— 于是 rust 模式下**新附件只存在于内存里**：
   * 查询索引里没有行、`listAllAttachments()` 看不到、`getAttachmentContent()` 取不到。
   * 端口化测试（CHAT-022b/023b、ATT-1/2/4、全局对话往返）抓到的就是这个。
   */
  const attachmentsViaPort = writeAttachmentsViaPort(message, sessionId);

  /**
   * ## 事件溯源双写必须在这里 —— 在下面那行"端口接手就 return"**之前**（第 45 轮功能上下文审计 P0-1）
   *
   * 原来这段在 `if (writeIndexViaRust(...)) return;` **之后**。而 `writeIndexViaRust` 在端口可用时
   * 返回 `true` —— 也就是**所有生产运行**都走那条 return，于是这段一次都没执行过：
   * 主聊天的 `user_message` 事件**从未写入事件日志**（`assistant_text` / `tool_call` / `tool_result` 同理）。
   *
   * 为什么危害不只是"少一张表的数据"：事件日志是 `event-projection` 的唯一输入，
   * 而投影结果被 `runtime-invariants` / `time-context` / `session-search` / `surface-manager`
   * 读去描述"这个会话现在有什么"。日志恒空 → 那些地方会给出**与事实相反**的自我描述
   * （典型形态：把"Context: 0 visible messages"这类假事实喂进系统提示词）。
   *
   * ### 为什么只搬 `user_message` / `assistant_text` 这两种事件
   *
   * `tool_call` / `tool_result` 在生产上有一个**专职写入者**：`tool-pipeline` 的
   * `EventLogFinalizeMiddleware`（它是工具流水线的 finalize 层，每次工具调用都会走）。
   * 如果这里也写一份，同一次工具调用会在事件表里留两行（投影按 id 去重所以语义无害，
   * 但那是纯粹的行数浪费）。**一个事实一个写入者**，所以这两种事件从这里移交给流水线。
   *
   * ### 助手正文的"定稿"由谁写（第 45 轮补齐）
   *
   * 主聊天的助手消息是**先建空壳、再流式更新**：`createMessage` 那一刻 `content` 还是空串，
   * 中间态由 autosave/工具事件反复落库（`status` 仍是 `"streaming"`），最后一轮的落库
   * 带的是 `status:"done"` 的**定稿正文**（`App.tsx` 的 `safeUpdateMessage(status:"done")`
   * 之后紧跟 `persistLoopMessages()`）。所以"定稿写入点"**就是这里**：
   * 由 `appendMessageTextEvent` 统一收口 —— 它挡住流式中间态、并按正文指纹去重
   * （为什么不会把事件表写爆，见该函数的长注释）。
   */
  appendMessageTextEvent(sessionId, message);

  // 迁移期分流：端口是 rust → 索引写走 Rust（**单事务**：主行 + JSON 列 + tool_calls 整体替换）
  if (writeIndexViaRust(message, sessionId, "create")) return;
  if (!ftsViaPort) {
    // 端口没接手：查询索引这一步没有落地，如实上报（旧库那条回退路径已退役）
    reportWriteNotAccepted("message.writeMessageIndex", "消息索引未写入");
  }

  // 第 78 波：**权威日志是追加式 JSONL**（对齐 DSH 的 session-persistence-jsonl），
  // SQLite 退化为"可重建的查询索引"。这条追加已由 createMessage 在**索引之前**完成（第 91 波）。
  // 第 17 轮（L4）：原来这里还有一句 `persistDatabase()`（旧库整库导出）—— 随 A 态一起删除，
  // 它在新架构下既无对象（旧库不加载）也无意义（端口写入是单事务落地的）。
}
/**
 * 已写入事件日志的**文本事件指纹**（第 45 轮功能上下文审计 P0-D0 的定稿写入点）。
 *
 * 键：`sessionId \0 事件类型 \0 messageId`；值：`长度:内容哈希`。
 *
 * 为什么需要指纹（而不是"每次写一次"）：`createMessage` 会被**反复**调用在同一条消息上
 * （`saveMessages` 每次都把列表里变过的消息逐条写一遍；主聊天的助手消息在流式期间
 * 每 2 秒一次 autosave、每次工具开始/结束各一次）。若不做去重，
 * 事件表会按"落库次数"膨胀，而投影对同一个 messageId 是**后写者胜** ——
 * 膨胀出来的行没有信息量，只会让 `session_event_search` 里同一条回复出现十几遍。
 */
const writtenTextEventFingerprints = new Map<string, string>();

/** 内容指纹（长度 + 字符码累加）：只需"同一份正文判等"，不必抗碰撞攻击 */
function textEventFingerprint(content: string): string {
  let sum = 0;
  for (let i = 0; i < content.length; i++) sum = (sum + content.charCodeAt(i)) % 2147483647;
  return `${content.length}:${sum}`;
}

/**
 * 消息文本事件的**唯一写入点**（`user_message` / `assistant_text`）。
 *
 * ## 它为什么存在（P0-D0）
 *
 * 主聊天**只**走 `createMessage`（`store.saveMessages` → `MessageStorage.createMessage`，
 * 见 `src/store.ts:586`），不走 `executor.ts`。而 `createMessage` 的"定稿正文"就是
 * 这条消息的最终内容 —— 所以这条路径就是主聊天的事件写入点。
 *
 * ## 为什么"流式中间态"一律不写（不会把事件表写爆）
 *
 * 主聊天的助手消息是**先建空壳、再流式更新**：`App.tsx` 在 `text_delta` 时建一条
 * `status:"streaming"` 的空壳，文本由 100ms 批量 flush 进内存列表，期间
 * `persistLoopMessages()`（tool_start / tool_complete / 2 秒 autosave）会把**半截正文**
 * 写一次库。那**不是**定稿 —— 这里用两道闸门挡住它：
 * ① `status === "streaming"` 直接返回（流式期间一次都不写）；
 * ② 非流式态再按"正文指纹"去重（同一份定稿正文只写一条事件；正文真的被改过
 *    —— 例如纠错回写、编辑重发 —— 才补一条新事件）。
 * 事件表因此是"每条消息 1~N 条（N=定稿正文被改写过的次数）"，与增量无关。
 *
 * ## 消费方对 `assistant_text` 的期望语义（已逐个确认）
 *
 * - `event-projection.applyAssistantText`（`event-projection.ts:213`）：按 `messageId`
 *   **后写者胜**地更新正文 —— 所以"定稿写一条"正是它要的形态（多条也无害，但没必要）；
 * - `runtime-invariants.checkVisibleRecordedInvariant`（`runtime-invariants.ts:62`）：
 *   要求"消息存储里存在的消息在日志里有对应事件"，判定用的就是 `messageId`；
 * - `time-context.findLastVisibleMessageTime`（`time-context.ts:106`）：取
 *   `assistant_text` 的**时间戳**当"最后一次模型可见活动"；
 * - `session-search`（`tools/session-search.ts:263`）：按 payload 文本搜索 —— 重复行会污染结果；
 * - `surface-manager`（`surface-manager.ts:48`）：只数投影出来的条数。
 *
 * ## 边界（如实记下，别以为它覆盖了更多）
 *
 * - `tool_call` / `tool_result` **刻意不在这里**：它们由 `tool-pipeline` 的
 *   `EventLogFinalizeMiddleware` 专职写入（一个事实一个写入者）；
 * - 正文为空的助手消息（纯工具轮）不写 `assistant_text`：它的"事实"在
 *   `tool_call` 事件里，写一条空正文只会让投影多出一条空 assistant 行。
 */
function appendMessageTextEvent(sessionId: string, message: Message): void {
  if (message.role !== "user" && message.role !== "assistant") return;
  const content = typeof message.content === "string" ? message.content : "";
  if (!content) return;
  // ① 流式中间态不是定稿（见上）
  if (message.status === "streaming") return;

  const type = message.role === "user" ? "user_message" : "assistant_text";
  const key = `${sessionId}\u0000${type}\u0000${message.id}`;
  const fingerprint = textEventFingerprint(content);
  // ② 同一份定稿正文只写一条（正文被改写时才补写）
  if (writtenTextEventFingerprints.get(key) === fingerprint) return;

  const eventLog = getEventLog();
  const event =
    type === "user_message"
      ? eventLog.append(sessionId, "user_message", { messageId: message.id, content })
      : eventLog.append(sessionId, "assistant_text", {
          messageId: message.id,
          content,
          model: message.model,
        });
  /**
   * **只在真的落库时记账**：端口没接手时 `append` 返回 `seq === 0` 的"未落库"事件
   * （`event-log.ts:226`）。那种情况不能记指纹 —— 否则下一次同样的正文会被去重挡掉，
   * 变成"事件永久缺失"。
   */
  if (event.seq !== 0) writtenTextEventFingerprints.set(key, fingerprint);
}

/** 测试/会话清理用：清掉文本事件指纹（不传则清全部） */
export function __resetTextEventFingerprints(sessionId?: string): void {
  if (!sessionId) {
    writtenTextEventFingerprints.clear();
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const key of Array.from(writtenTextEventFingerprints.keys())) {
    if (key.startsWith(prefix)) writtenTextEventFingerprints.delete(key);
  }
}

/**
 * 更新一条消息。
 *
 * 第 91 波（架构级）：与 createMessage 同一处修正 —— **先写权威日志，再更新索引**。
 *
 * 快照的来源优先用**日志镜像/索引里的现存消息**（不依赖"索引还能用"）；两者都取不到时
 * 才退回老的"从索引读一遍再追加"路径（那样在索引崩掉时确实写不进日志，但至少不会写坏）。
 */
export function updateMessage(id: string, update: Partial<Message>): void {
  // ① 权威日志：先用现有快照 + 本次改动合成一条完整记录追加（同 id 后写者胜）
  const sessionId = currentSessionIdForMessage(id);
  /** 本次用的"现存快照"：下面第 ③ 步（全文索引）复用同一份，不重复读一次 */
  let snapshot: Message | null = null;
  if (sessionId) {
    const base = logMirrorMessage(sessionId, id) ?? (storageUnavailable() ? null : safeGetMessage(id));
    if (base) {
      snapshot = { ...base, ...update, id, timestamp: base.timestamp ?? Date.now() } as Message;
      void appendSessionMessage(sessionId, snapshot);
    } else {
      void appendUpdatedMessageToLog(id);
    }
  } else {
    void appendUpdatedMessageToLog(id);
  }

  // ② 索引：尽力而为（同理**不加**"存储不可用就短路"—— 那会让没写成变成静默无动作）
  try {
    writeMessageUpdateIndex(id, update);
  } catch (e) {
    reportPersistFailure("message.updateMessage.index", e, "消息改动已写入权威日志，但查询索引更新失败（索引可由日志重建）");
  }

  /**
   * ③ 全文索引：**只有正文变了**才需要重写。
   *
   * 为什么只认 `content`：`session_fts.content` 存的就是正文（切分后）；
   * 状态/推理/模型这些改动不影响可搜内容，而流式过程中
   * `updateMessage(id, { reasoning })` 会被调用很多次 —— 每次都发一次 IPC
   * 去重写索引纯属浪费（P5 第 11 段）。
   */
  if (sessionId && update.content !== undefined && snapshot) {
    indexFtsForMessageViaPort(sessionId, snapshot);
  }

  /**
   * ④ 事件日志：**状态落到终态（done / error）的那一次就是"消息定稿"**
   *    （第 45 轮功能上下文审计 P0-D0 的助手正文写入点）。
   *
   * 为什么放在 `status` 转变处而不是每次 `updateMessage`：流式增量会以极高频率调用本函数
   * （`updateMessage(id, { content })` 每个 flush 一次）——若每次都写事件，事件表会按 token
   * 增量膨胀。定稿只有一次（`status` 从 `streaming` 变成 `done`/`error`），
   * 而且此刻 `snapshot` 里是**合并后的最终正文**。
   *
   * 与 `createMessage` 那条路共用同一道指纹去重（`appendMessageTextEvent`），
   * 所以同一条消息无论走哪条路落定，事件都只有一条（正文被改写时才补写）。
   */
  if (sessionId && snapshot && (update.status === "done" || update.status === "error")) {
    appendMessageTextEvent(sessionId, snapshot);
  }
}

/** 索引不可用时的安全读取（不抛） */
function safeGetMessage(id: string): Message | null {
  try {
    return getMessage(id);
  } catch {
    return null;
  }
}

/** 消息更新 → SQLite 索引（updateMessage 的索引侧；失败由调用方兜底） */
function writeMessageUpdateIndex(id: string, update: Partial<Message>): void {
  // 迁移期分流：端口是 rust → 走单事务复合写
  const base = storageUnavailable() ? null : safeGetMessage(id);
  const sid = base ? currentSessionIdForMessage(id) : null;
  if (base && sid && writeIndexViaRust({ ...base, ...update, id } as Message, sid, "update")) return;
  // 端口没接手：索引这一步没有落地，如实上报（旧库那条回退路径已随 L4 退役）
  reportWriteNotAccepted("message.writeMessageUpdateIndex", "消息索引未更新");
}

/**
 * 把"当前索引里的这一条消息"追加进日志（更新路径用）。
 *
 * 审计修正（第 79 波）：这里以前靠 `getMessage(id)` 取 sessionId —— 而 `getMessage`
 * 返回的 Message **不含 session id**（UI 侧本来也不关心它），于是 `sessionId` 一直是 undefined，
 * 更新路径**从未真正写入日志**：日志里只有 createMessage 时的初版内容，
 * 流式回复/工具结果的最新版本只存在于索引里 —— 一旦索引被裁剪或重建，内容就会**回退**。
 * 现在直接查一次库拿 session_id（和删除路径同源），并在查不到时明确告警。
 */
async function appendUpdatedMessageToLog(id: string): Promise<void> {
  try {
    const sessionId = currentSessionIdForMessage(id);
    if (!sessionId) {
      console.warn(`[SessionJSONL] 更新消息 ${id} 时找不到所属会话，日志未更新（索引仍是最新）`);
      return;
    }
    const message = getMessage(id);
    if (!message) return;
    await appendSessionMessage(sessionId, message);
  } catch (e) {
    console.warn("[SessionJSONL] 更新消息追加日志失败（索引仍在）:", e);
  }
}

/**
 * 在已有正文后追加一段（流式路径的历史接口）。
 *
 * 旧实现是 SQL 级 `content = content || ?`，只有旧库一条路径 —— 在 rust 引擎下抛
 * `Database not initialized`（与 `updateMessageContent` 同一个缺陷族）。
 *
 * 改成"先同步读回当前正文（镜像优先 / 日志镜像兜底），再整体 set"：
 * - 语义与 `content || ?` 一致（拼接结果相同）；
 * - 走 `updateMessage` → 权威日志先写、索引随后（端口优先），写不到行会被发现；
 * - 读不到那一行时**如实上报**并放弃，而不是静默丢掉这段文本。
 */
export function appendToMessage(id: string, content: string): void {
  const base = safeGetMessage(id);
  if (!base) {
    reportPersistFailure(
      "message.appendToMessage",
      new Error(`消息不存在或索引不可读：id=${id}`),
      "追加上去的正文没有落地（消息读不回来）",
    );
    return;
  }
  updateMessage(id, { content: `${base.content ?? ""}${content}` });
}

/**
 * 与 `appendToMessage` 同一实现（历史上是两个名字、两条路径）。
 * `appendMessageContent` 是 agentic loop 侧的旧名字，保留为别名以免漏改调用点。
 */
export function appendMessageContent(id: string, text: string): void {
  appendToMessage(id, text);
}

/** 整段覆盖正文（`updateMessageContent` 的旧别名，同一实现） */
export function setMessageContent(id: string, content: string): void {
  updateMessageContent(id, content);
}

/** 设置推理内容（同族缺陷：原来只有旧库一条路径） */
export function setMessageReasoning(id: string, reasoning: string): void {
  updateMessage(id, { reasoning });
}

/** 设置消息状态（同族缺陷：原来只有旧库一条路径） */
export function setMessageStatus(id: string, status: string): void {
  updateMessage(id, { status: status as Message["status"] });
}

/**
 * 工具调用 → 线协议形状（`args` / `metadata` 传对象，由 Rust 侧序列化）
 */
function toolCallForWire(tc: ToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    tool: tc.tool,
    args: tc.args ?? {},
    result: tc.result ?? null,
    status: tc.status ?? "running",
    metadata: tc.metadata ?? null,
  };
}

/**
 * 新增一个工具调用（P5 第 10 段：读写同处）。
 *
 * ## 修复的是什么
 *
 * 消息正文走 `writeIndexViaRust`（写 Rust），工具调用却一直是"写旧库"。
 * 于是工具调用成了整条消息链上最后一处读写分裂 —— 而它的失效形态正是用户现场的
 * **"模型看不到自己这次调用的结果"（于是反复重发同一个工具调用）**。
 *
 * 现在：端口可用 → 写 `tool_calls.replace`（Rust 侧单事务），并**同步缓存**这条消息的
 * 工具调用；端口不可用 → 完全维持原行为。缓存由读写两侧共同维护，所以
 * "刚写进去的立刻读得到"，不再取决于旧库那一行在不在。
 */
export function addToolCall(messageId: string, toolCall: ToolCall): void {
  mergeCachedToolCall(messageId, toolCall);

  const port = rustMessagePort();
  if (port) {
    const current = toolCallCache.get(messageId) ?? [];
    void port.data
      .execute("tool_calls.replace", { message_id: messageId, tool_calls: current.map(toolCallForWire) })
      .catch((e) => reportPersistFailure("message.addToolCall", e, "工具调用未写入查询索引（索引可由日志重建）"));
    return;
  }

    reportWriteNotAccepted("message.addToolCall", "工具调用未写入索引");
    return;
}

/**
 * 更新一个工具调用（结果回填的高频路径）。
 *
 * 第 83 波那条"写不到行 = 模型看不到结果"的告警**保留**：端口那边写失败同样上报（不静默）。
 */
export function updateToolCall(messageId: string, toolId: string, update: Partial<ToolCall>): void {
  // 缓存先合并"补丁"：新值来自 update，未提到的字段沿用当前值（与 SQL UPDATE 语义一致）
  const cached = toolCallCache.get(messageId);
  const base = cached?.find((c) => c.id === toolId);
  mergeCachedToolCall(messageId, { ...(base ?? { id: toolId, tool: "", args: {} }), ...update, id: toolId } as ToolCall);

  const port = rustMessagePort();
  if (port) {
    const current = toolCallCache.get(messageId) ?? [];
    void port.data
      .execute("tool_calls.replace", { message_id: messageId, tool_calls: current.map(toolCallForWire) })
      .catch((e) => reportPersistFailure("message.updateToolCall", e, "工具调用结果未写入查询索引（索引可由日志重建）"));
    return;
  }

    reportWriteNotAccepted("message.updateToolCall", "工具调用结果未写入索引");
    return;
}

export function deleteMessage(id: string): void {
  // 先取会话 id（删掉之后就查不到了）：墓碑需要它
  const sessionId = currentSessionIdForMessage(id);
  const port = rustMessagePort();
  if (port) {
    /**
     * B 态（端口在、旧库刻意不存在）：删除走端口。
     *
     * 原来的实现第一行就是 `getDatabase()` —— 在 rust 引擎下直接抛，
     * **墓碑那一行永远走不到**，于是"删除"在下一次从权威日志重建时复活。
     * 顺序按删除链路的约定：索引（端口）→ 墓碑（日志）→ 内存镜像。
     *
     * ## `confirm_bulk: true` 为什么连"删一条"也要声明
     *
     * Rust 侧 `messages_delete` 在**硬删除**路径上有批量闸门：**按真实影响行数**
     * （含外键级联，审计触发器行已剔除）超过 50 行时必须显式声明，否则整条命令报错回滚。
     *
     * 闸门要拦的是**规模不体现在参数里**的隐式级联删除 —— 参数里只写了 1 个 id，
     * 实际可能带走它的 tool_calls / message_feedback（都是 `ON DELETE CASCADE`）。
     * 而这里的调用方**已经枚举出了确切目标**（`deleteMessage(id)` 就是用户点了"删除这一条"），
     * 所以"我在做批量（含级联）删除"这句话是**事实**，声明它是如实表达，不是绕过闸门。
     *
     * ⚠️ 反过来：`soft: true`（隐藏）**不带**这个字段 —— 隐藏不删行、不触发级联，
     * 它不是破坏性删除，声明它会误导闸门的语义（见 `deleteMessagesByIds` 的调用）。
     */
    /*
     * P2-4：这条是**硬删除**（真删行 + 外键级联），所以它是 `count_clamped`
     * 最可能的来源 —— 引擎按会话把计数减掉，减到 0 以下就夹断。
     * 夹断时这里会立刻按索引真值把该会话的计数重算回去。
     */
    deleteMessageIndexRows(
      port,
      [id],
      "hard",
      sessionId ? [sessionId] : [],
      "message.deleteMessage",
      "消息未从查询索引删除",
    );
    if (sessionId) {
      port.applyMessageDelete?.(sessionId, [id]);
      removeFtsViaPort(sessionId, [id]);
      appendTombstonesFor(sessionId, [id]);
      dropFromLogMirror(sessionId, [id]);
    }
    return;
  }
  reportWriteNotAccepted("message.deleteMessage", "消息未删除");
  return;
}

/** 查一条消息属于哪个会话（删除前调用） */
function currentSessionIdForMessage(messageId: string): string | null {
  /**
   * P5 第 10 段：**先问镜像**。
   *
   * 这条"查消息属于哪个会话"以前只查旧库 + 日志镜像。但 Rust 接手之后新建的消息
   * 在旧库那侧**根本没有行**，日志镜像也要 hydrate 过才有 —— 于是它返回 null，
   * 连带三处功能静默降级：
   * - `writeMessageUpdateIndex` 拿不到 sid → 更新**不走 Rust**，转去写旧库（读写分裂）；
   * - `appendUpdatedMessageToLog` 拿不到 sid → 更新**不进权威日志**（内容会回退）；
   * - `deleteMessage` 拿不到 sid → **不写墓碑** → 下次从日志重建时消息复活。
   *
   * 镜像的 `byIdLookup` 对"本进程写过的消息"总是有的（`upsert_index` 会同步进去），
   * 所以这里补上之后，上面三条都回到正确路径。
   */
  const fromMirror = rustMessagePort()?.messages?.byIdLookup(messageId);
  if (fromMirror?.session_id) return String(fromMirror.session_id);
  try {
  } catch {
    /* 索引不可用 → 走日志镜像兜底（第 91 波） */
  }
  return sessionIdFromLogMirror(messageId);
}

/**
 * 批量删除后补墓碑（第 78 波）。
 *
 * 为什么所有删除路径都要走这里：日志是权威存储、索引可重建 —— 任何"只删索引不记日志"的删除，
 * 都会在下次从日志合并/重建时**复活**（压缩、清理旧消息、按范围删除都属于这条路径）。
 */
function appendTombstonesFor(sessionId: string, ids: string[]): void {
  if (!sessionId || ids.length === 0) return;
  /**
   * 第 83 波：这里原来是 `await import("./session-jsonl")` 之后再写 ——
   * 本文件顶部**早就**静态 import 了 `appendMessageTombstone`，动态 import 纯属多余；
   * 更糟的是它把写入推迟到微任务之后，`flushSessionLogWrites()` 看不到这些在途写入
   * （墓碑现在会登记在途状态），"删完立刻 flush 再读日志"就可能读到旧内容。
   * 现在直接同步发起，全部登记进日志的在途集合。
   */
  for (const id of ids) {
    void appendMessageTombstone(sessionId, id);
  }
}

/** Delete all messages before a given timestamp (exclusive) in a session */
export function deleteMessagesBefore(sessionId: string, timestamp: number): number {
  /**
   * B 态（端口在）：候选 id 从**会话镜像**上算，删除走端口 —— 不碰刻意不存在的旧库。
   * 旧实现第一行 `getDatabase()` 在 rust 引擎下直接抛，墓碑写不到 → 删掉的消息会复活。
   *
   * 镜像还没就绪时**等它就绪再做**（一次性回调，不轮询）—— 与 `addNoteLink` 同一条规则：
   * 写路径宁可等，也不许退回旧库（那会造成本进程内读写分裂）。
   */
  const port = rustMessagePort();
  if (port?.messages) {
    /** @returns 删除条数；null = 镜像未就绪（调用方登记"就绪后重做"） */
    const runWhenReady = (): number | null => {
      if (!port.messages!.isLoaded(sessionId) || port.messages!.isTruncated()) return null;
      const ids = port.messages!
        .list(sessionId)
        .filter((r) => Number(r.timestamp) < timestamp)
        .map((r) => r.id);
      if (ids.length === 0) return 0;
      /**
       * **硬删除 + `confirm_bulk: true`**：`ids` 是"本会话里时间早于 `timestamp` 的全部消息"，
       * 已经在上一步从镜像里**枚举出确切目标**（调用方是 `App.tsx` 的"清空更早的上下文"）。
       *
       * 必须声明的原因：这是**真正的批量**（一次可能是几百条），而且每条还会级联带走
       * 它的 `tool_calls` / `message_feedback` —— 闸门按真实影响行数算，不声明就整条回滚。
       * 闸门要拦的不是这种"目标已经写清楚"的删除，而是**规模不体现在参数里**的隐式级联。
       */
      /*
       * P2-4：范围硬删除（一次可能几百条）是**最容易夹断**的一条 ——
       * 删的行数远超 `message_count` 现值时引擎把它夹到 0，而库里还有行。
       * 走统一入口后这件事会被当场看见、并立刻按索引真值重算。
       */
      deleteMessageIndexRows(
        port,
        ids,
        "hard",
        [sessionId],
        "message.deleteMessagesBefore",
        "旧消息未从查询索引删除",
      );
      port.applyMessageDelete?.(sessionId, ids);
      removeFtsViaPort(sessionId, ids);
      appendTombstonesFor(sessionId, ids);
      dropFromLogMirror(sessionId, ids);
      return ids.length;
    };
    const done = runWhenReady();
    if (done !== null) return done;
    port.messages.ensureLoaded(sessionId, () => {
      const later = runWhenReady();
      if (later !== null && later > 0) {
        console.log(`[MessageStorage] 会话 ${sessionId} 镜像就绪后补做"按时间删旧消息"：${later} 条`);
      }
    });
    return 0;
  }
  reportWriteNotAccepted("message.deleteMessagesBefore", "旧消息未删除");
  return 0;
}

/**
 * 批量删除（上下文压缩走这条路径）。
 *
 * ## 第 83 波：这里曾经是个**致命的假删除**（用户现场）
 *
 * 原来只做 `UPDATE messages SET hidden = 1`（索引侧软删除），**不写权威日志**。
 * 而读路径 `listMessages` = 索引(WHERE hidden=0) ∪ 缓存日志 —— 日志里根本没有 hidden 语义，
 * 于是被"删掉"的消息**被日志整批加回来，而且不带 hidden**：
 *
 *   · 压缩说"移除 840 条"，下一次读又回来 840 条 → 上下文 token 一点没降；
 *   · 每次迭代都重新压缩一遍（LLM 摘要调用白烧），最后硬停"请开启新对话"。
 *   · 用户现场日志：`Removed 840/841 … kept 20`，请求恒为 ~105 万 token，迭代 1→2→3→4 循环。
 *
 * 修法与其它删除路径一致（`deleteMessage` / `deleteMessagesBefore` 早就这么做了）：
 * **删除必须同时落到索引与权威日志**（墓碑 + 后写者胜），并且把内存镜像里的同 id 记录清掉 ——
 * 镜像不刷新的话，本进程内的合并仍会从缓存里"复活"这些消息。
 */
export function deleteMessagesByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  // 先按会话分组（墓碑要写进对应会话的日志），再软删除索引行
  const bySession = sessionIdsForMessages(ids);

  /**
   * **端口优先**（第 39 轮修复）：rust 模式下旧库刻意不存在，原来的
   * `const db = getDatabase()` 会直接抛 `Database not initialized` ——
   * 后果是压缩**一条都没隐藏**：日志里写了墓碑、索引里没有，
   * 下一次读又把它们从日志合并回来（正是用户现场的"移除 840 条、token 一点没降"）。
   *
   * 所以这里改成：端口可用 → 走 `messages.delete { ids, soft: true }`（Rust 侧真改 hidden）
   * + 记入 `localHiddenIds`（让本次同步读立刻看见）；端口不可用 → 保留旧库路径（回滚开关）。
   *
   * ## 为什么**不带** `confirm_bulk`（与三条硬删除路径刻意不同）
   *
   * Rust 侧的批量闸门只约束**硬删除**（按真实影响行数含级联，超 50 行必须显式声明）。
   * 这里是 `soft: true` —— 它只 `UPDATE … SET hidden = 1`，**不删行、不触发外键级联**，
   * 语义上不是破坏性操作。给它加 `confirm_bulk` 会让闸门那侧的语义变浑：
   * "声明了 confirm_bulk" 就不再等于"这次真的会删掉很多行"。
   *
   * 规模也不是问题：这条路一次可能隐藏几百条，但它不删任何东西 —— 闸门要拦的是
   * "参数里看不出规模、实际级联删掉一大堆"，而这里根本没有删除。
   */
  const port = rustMessagePort();
  if (port) {
    /*
     * P2-4：软删除（压缩隐藏）**不删行**，所以引擎回报里 `count_clamped` 恒 false
     * （行没少 → 计数不可能被夹断）。走统一入口仍然有意义：`missing` 会告诉我们
     * "这次要隐藏的 id 已经有不在库里的"（渲染侧 id 集合与库不一致的信号），
     * 且回报读不到时会如实降级告警，而不是静默当成"没有异常"。
     */
    deleteMessageIndexRows(
      port,
      ids,
      "soft",
      [...bySession.keys()],
      "message.deleteMessagesByIds",
      "消息未能软删除（索引侧未更新）",
    );
    // 同步记录：镜像可能还没加载完，读路径必须立刻看到这次隐藏
    for (const [sid, sids] of bySession) {
      for (const id of sids) rememberHidden(sid, id);
    }
    // A 态已退役：渲染侧只剩端口这条路 —— 隐藏没落地由下面的墓碑与上报如实表达
  } else {
    /**
     * B 态且没有 `messages` 能力（测试双/能力缺失）：**不写旧库**。
     *
     * 这时隐藏没有落地，必须如实上报 —— 否则就退化成当初那个"压缩说移除了 840 条、
     * 实际索引里一条都没变"的假成功。权威日志那一步（下面的墓碑）仍然照写：
     * 日志才是权威，索引可在下次打开时按日志重建。
     */
    reportPersistFailure(
      "message.deleteMessagesByIds",
      new Error("端口已注册但没有 messages 能力"),
      "消息未在查询索引里隐藏（本次只写了权威日志的墓碑）",
    );
  }
  // 权威日志：逐条留墓碑（后写者胜：之后再写入同 id 即为重新出现）
  for (const [sid, sids] of bySession) {
    appendTombstonesFor(sid, sids);
    // 全文索引：虚拟表没有级联，隐藏/删除后必须显式移除（否则搜索命中已删消息）
    removeFtsViaPort(sid, sids);
    // 内存镜像同步剔除：否则本次进程内的 listMessages 仍会从镜像复活这些消息
    dropFromLogMirror(sid, sids);
  }
  return ids.length;
}

/** 把一批消息 id 按所属会话分组（分块查询，避免超长 IN 子句） */
function sessionIdsForMessages(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();

  /**
   * **端口优先**（第 39 轮修复）。
   *
   * 原来这里只查旧库（`tryGetDatabase()`），而 rust 模式下旧库刻意不存在 →
   * 返回**空 Map** → 连带三件事全部静默失效：
   * ① 墓碑不写（下次从日志重建时消息复活）；② 日志镜像不剔除（本进程内立刻复活）；
   * ③ `deleteMessagesByIds` 里依赖它的隐藏记录也不生效。
   *
   * 这正是用户现场"移除 840 条、token 一点没降"的完整机制 —— 不是某一处漏了，
   * 而是**整条删除链路的会话归属查不到**，于是整条链路空转。
   */
  const port = rustMessagePort();
  if (port?.messages) {
    for (const id of ids) {
      const row = port.messages.byIdLookup(id);
      const sid = row?.session_id ? String(row.session_id) : "";
      if (!sid) continue;
      const list = out.get(sid);
      if (list) list.push(id);
      else out.set(sid, [id]);
    }
    return out; // 端口在但查不到归属：不再退回旧库（旧库本来就不存在）
  }
  /**
   * ⚠️ **这一支的注释原来是不实之词（B-5）**：它写着"让'没写墓碑'成为一个可见的、
   * 可上报的事实"，而那段代码**既没有上报、调用方也没有分支**——`deleteMessagesByIds`
   * 拿到空 Map 之后只是"一条墓碑都不写"，静默地什么也没发生。
   *
   * 现在把"没写墓碑"真的说出去：`sessionIdsForMessages` 自己上报一次（通道用既有的
   * `reportPersistFailure`，语义正是"这次没生效"）。给**每个 id** 都报一次会刷屏，
   * 所以按"本次调用"报一条，带上条数与例子 —— 出问题时至少要能看出"哪一批没写墓碑"。
   */
  reportPersistFailure(
    "message.sessionIdsForMessages",
    new Error("端口已注册但没有 messages 能力（无法判定消息归属）"),
    `本次 ${ids.length} 条消息未能按会话分组（例：${ids.slice(0, 3).join(",") || "无"}）：` +
      "权威日志的墓碑不会写入 —— 这些消息在下次从日志重建时会复活",
  );
  return out;
}

/** 从日志内存镜像里剔除若干 id（删除/隐藏后必须调用） */
function dropFromLogMirror(sessionId: string, ids: string[]): void {
  const cached = cachedLogMessages.get(sessionId);
  if (!cached || cached.length === 0) return;
  const drop = new Set(ids);
  const kept = cached.filter((rec) => !drop.has(rec.id));
  if (kept.length !== cached.length) cachedLogMessages.set(sessionId, kept);
}

export function getMessageCount(sessionId: string): number {
  const routed = rustMessageSource(sessionId);
  if (routed?.messages) return routed.messages.count(sessionId);
    return 0;
}

// ========== P2-4：`messages.delete` 回报的字段必须真的有人读 ==========

/**
 * `messages.delete` 的**结构化回报**（Rust `messages_delete`，`repo.rs:1510–1526`）。
 *
 * 五个字段都是引擎刻意给的，其中 `count_clamped` 是"`message_count` 已经漂移过"
 * 这件事的**唯一在线信号**（见 `bump_session_message_count` 的长注释，`repo.rs:790–800`）。
 */
export interface MessageDeleteOutcome {
  /** 真正被删/被隐藏的行数 */
  written: number;
  /** 请求里给了几个 id */
  requested: number;
  /** 其中在库里找不到的 id 数（批量幂等删除的正常形态） */
  missing: number;
  /** 真实影响行数（含外键级联，审计触发器行已剔除） */
  affectedRows: number;
  /**
   * 会话消息计数被 `MAX(0, …)` **夹断**过。
   *
   * 夹断**只可能**发生在"计数已经漂移过"的会话上（删除数 > 计数现值），
   * 所以它不是噪音 —— 它是"这个会话的 `message_count` 不可信"的判据。
   * 实测形态：计数 1、库里 5 条 → 硬删 3 条 → 计数 0、库里还剩 2 条。
   */
  countClamped: boolean;
}

/**
 * 硬/软删除消息索引行 —— **唯一入口**，并且**读引擎回报的每一个字段**（P2-4）。
 *
 * ## 它修的是什么
 *
 * 五个调用点原来都是 `void port.data.execute("messages.delete", …)`，
 * 而 `execute` 刻意把结果压成 `{ written }`（`rust-port.ts:504–514`）——
 * 于是 Rust 侧刻意返回的 `count_clamped` / `affected_rows` / `missing`
 * **一个都没被读过**（全仓 `grep` 零命中，连测试都没读）。
 * 而 `repo.rs:790–800` 的设计论证正是建立在"调用方会把它转发出去"之上：
 * "夹断本身是对的，错的是'夹了却不说'"。论证与实现因此是**脱节**的，
 * 后果是"0 条消息的会话里躺着 2 条"这种状态只有 12 小时一次的启动维护才可能发现。
 *
 * ## 现在的闭环（判据落在行为上）
 *
 * 1. 读回报 → `countClamped === true` 时**立刻**按索引真值重算该会话的 `message_count`
 *    （`reconcileSessionMessageCount`，与启动维护用的是**同一个**实现）；
 * 2. 重算这件事写一条 `console.warn` —— 也就是"夹断"在日志里**看得见**，
 *    而不是等下一次维护的汇总行；
 * 3. `affected_rows > written`（有外键级联）与 `missing > 0`（请求的 id 已不存在）
 *    也各留一条信号：前者是"这次删除比参数里写的更大"，后者是"这套 bookkeeping 已经与库不一致"。
 *
 * ## 拿不到回报时**不假装拿到了**（没有 `command` 能力 → 退回 `execute`）
 *
 * `StorageDataPort.command` 是**可选**能力（`port.ts` 的说明），契约测试里的极简假端口
 * 可能没有它。这一态下退回 `execute`（至少把这次删除发出去），但**如实打一条**：
 * 否则"夹断没被看见"会被误读成"这次没有夹断"。
 *
 * 顺带记下：`execute` 与 `command` 在真端口里是**同一条 dispatch**，重试规则也相同
 * （`rust-port.ts:530–543` 的注释），而 `messages.delete` 本来就不在
 * `RETRYABLE_WRITE_COMMANDS` 白名单里 —— 所以换通道**不改变**重试行为。
 */
export type MessageDeleteMode = "hard" | "soft" | "trim";

export function messageDeleteParams(ids: string[], mode: MessageDeleteMode): Record<string, unknown> {
  if (mode === "trim") return { ids, trim: true };
  if (mode === "soft") return { ids, soft: true };
  return { ids, confirm_bulk: true };
}

function deleteMessageIndexRows(
  port: RustMessagePortLike,
  ids: string[],
  mode: MessageDeleteMode,
  sessionIdsForReconcile: readonly string[],
  scope: string,
  note: string,
): void {
  const cmdParams: Record<string, unknown> = messageDeleteParams(ids, mode);
  if (!port.data.command) {
    /*
     * 没有结构化通道：命令照样发，但"回报读不到"这件事必须可见。
     * 这是一条**降级**信号（不是失败）：真机上它意味着这台机器上的夹断判据失效了。
     */
    console.warn(
      `[MessageStorage] ${scope}：端口没有 command 能力，本次删除的 count_clamped/affected_rows 读不到` +
        `（删 ${ids.length} 条；这条降级不是"没有夹断"）`,
    );
    void port.data.execute("messages.delete", cmdParams).catch((e) => reportPersistFailure(scope, e, note));
    return;
  }

  void port.data
    .command<Record<string, unknown>>("messages.delete", cmdParams)
    .then((raw) => {
      const written = Number(raw?.written ?? 0);
      const requested = Number(raw?.requested ?? ids.length);
      const missing = Number(raw?.missing ?? 0);
      const affected = Number(raw?.affected_rows ?? 0);
      /** 字段是否**真的在回报里**：读不到时不许当成 false（"字段读不到就取默认值"是本仓库一直在消灭的模式） */
      const hasClampedField = typeof raw?.count_clamped === "boolean";

      if (missing > 0 && written === 0) {
        // 请求的 id 一个都不在库里：这不是错误（幂等删除的正常形态），但它是 bookkeeping 偏了的信号
        console.warn(
          `[MessageStorage] ${scope}：${requested} 个目标在索引里一条都不存在（missing=${missing}）——` +
            `渲染侧的 id 集合与库已经不一致`,
        );
      } else if (missing > 0) {
        console.warn(`[MessageStorage] ${scope}：删 ${written}/${requested} 条，另有 ${missing} 个目标已不存在`);
      }
      if (affected > written) {
        // 外键级联：参数里看不出规模的那部分（这就是闸门关心的事）
        console.warn(
          `[MessageStorage] ${scope}：影响行数 ${affected} > 直接删除 ${written}（差额是外键级联：tool_calls / message_feedback）`,
        );
      }

      if (!hasClampedField) {
        console.warn(
          `[MessageStorage] ${scope}：引擎回报里没有 count_clamped 字段 —— 夹断判据不可用（不是"没有夹断"）`,
        );
        return;
      }
      if (raw.count_clamped !== true) return;

      /*
       * ## 夹断 → 立即按索引真值重算（P2-4 想要的那条闭环）
       *
       * 为什么必须**当场**修：夹断意味着这个会话的 `message_count` 已经不可信，
       * 而它正被侧边栏与 `session_trace` 直接展示 —— 不改的话用户看到的是
       * "0 条消息的会话"（库里其实还有行），一直持续到 12 小时后的启动维护。
       *
       * ⚠️ 一次删除**可能跨会话**（`deleteMessagesByIds` 的入参只给 id，
       * 归属由 `sessionIdsForMessages` 反查）—— 所以这里逐个会话重算，
       * 而不是"挑一个"：挑错会话等于把真值写进另一个会话。
       */
      console.warn(
        `[MessageStorage] ${scope}：` +
          `会话消息计数被夹断（count_clamped=true，删 ${written} 条）→ 立即按索引真值重算` +
          (sessionIdsForReconcile.length > 0
            ? `（会话 ${sessionIdsForReconcile.join(", ")}）`
            : "（无法定位会话：调用方没给 sessionId）"),
      );
      for (const sid of sessionIdsForReconcile) {
        void reconcileSessionMessageCountById(sid, `${scope} 检测到计数被夹断`);
      }
    })
    .catch((e) => reportPersistFailure(scope, e, note));
}

/**
 * 按**索引真值**重算并写回一个会话的 `message_count`（P2-4 的闭环动作）。
 *
 * ## 为什么读 `messages.count` 的 `total`
 *
 * `total` = `SELECT COUNT(*) FROM messages WHERE session_id = ?`（**库里的行数**，
 * 含 `hidden = 1` 的软删行）—— 这正是引擎自己维护那一列时用的口径
 * （`bump_session_message_count` 是按"真实删掉的行数"增减的）。
 * 拿 `visible`（`hidden = 0`）去写会得到**第二个真相**：压缩隐藏 200 条之后，
 * 索引真值没变而写回去的计数掉了 200 —— 下一次对账又要改回来，用户看到数字自己跳。
 * （启动维护的 `maintenance.ts` 对账块用的是同一个字段，见那里的长注释。）
 *
 * ## 返回值是**三态**，不许压成 boolean
 *
 * - `"reconciled"` —— 读到了真值，与现存计数不一致，已写回；
 * - `"consistent"` —— 读到了真值，本来就一致（**不等于失败**）；
 * - `"unavailable"` —— 读不到真值（端口没有 `command` / 该会话读失败）：**什么都没写**。
 *
 * 三态是刻意的：`consistent` 与 `unavailable` 混成一个 `false`，
 * 就会让"没读到"被读成"对上了"——那正是本项目一直在消灭的那类谎报。
 */
export async function reconcileSessionMessageCountById(
  sessionId: string,
  reason: string,
): Promise<"reconciled" | "consistent" | "unavailable"> {
  const port = rustMessagePort();
  if (!port?.data.command) return "unavailable";
  let total: number;
  try {
    const counted = await port.data.command<{ total?: number; count?: number }>("messages.count", {
      session_id: sessionId,
    });
    const n = Number(counted?.total ?? counted?.count ?? NaN);
    if (!Number.isFinite(n)) return "unavailable";
    total = n;
  } catch (e) {
    reportPersistFailure("message.reconcileMessageCount", e, `会话 ${sessionId} 的索引真值读不到（计数未重算）`);
    return "unavailable";
  }

  /*
   * 现存值从**域镜像**读（`sessions` 表的同一行）。
   *
   * 用动态 import 而不是顶层 import：`maintenance.ts` 顶层 import 了
   * `./session`（它会 import `./domain-store`），而 `domain-store` 与 `message.ts`
   * 之间已有静态依赖 —— 顶层再拉一条 `message → domain-store` 的边会把这条链
   * 绕成环（`domainWrite` 在模块初始化期被求值时拿到 `undefined`）。
   */
  const { domainReadOne } = await import("./domain-store");
  const row = domainReadOne<{ message_count?: number }>("sessions", { id: sessionId }, (r) => ({
    message_count: Number(r.message_count ?? 0),
  }));
  if (row === undefined || row === null) {
    /*
     * 镜像里没有这个会话（`undefined` = 未接手；`null` = 行不存在）。
     * 这两种态**都不能**写：写一个"读不到来源"的值就是第二次漂移。
     */
    reportPersistFailure(
      "message.reconcileMessageCount",
      new Error("会话行在镜像里读不到"),
      `会话 ${sessionId} 的 message_count 未重算（${reason}）`,
    );
    return "unavailable";
  }
  if (Number(row.message_count) === total) return "consistent";

  const { updateSession } = await import("./session");
  updateSession(sessionId, { messageCount: total });
  console.log(
    `[MessageStorage] 会话计数重算：${sessionId} ${row.message_count} → ${total}（原因：${reason}）`,
  );
  return "reconciled";
}

// ========== P0: Message Feedback (like / dislike) ==========

export type FeedbackType = "like" | "dislike";

export interface FeedbackRecord {
  id: string;
  messageId: string;
  sessionId: string;
  feedback: FeedbackType;
  timestamp: number;
}

/** Save or update feedback for a message. Passing null removes the feedback. */
/**
 * 反馈的内存缓存（P3 第 9 段）。
 *
 * ## 为什么用"写穿缓存"而不是整表加载
 *
 * `loadFeedback` 是**同步**接口，而 Rust 是异步 IPC。反馈表很小（一条消息最多一行），
 * 但没有"按会话"的天然边界 —— 一条消息的反馈可能在任何会话里被查询。
 * 整表加载会引入一个不必要的启动读；而**只缓存本进程写过的**就足够：
 *
 * - 写入走 Rust（权威），并同步进缓存 → 本进程内的读立即可见；
 * - 缓存里没有的（历史反馈）→ 继续读旧库（那里是迁移前的数据，且读与写都在同一处）。
 *
 * 这条规则与只追加面/消息镜像同源：**只有当读与写落在同一处时才切换**。
 * 旧库那份反馈值虽然会随时间变旧，但"没写过的消息"的反馈本来就没被本进程改动过。
 */
const feedbackCache = new Map<string, FeedbackType | null>();

/**
 * 反馈**写路径换人**之后的缓存失效钩子（第 45 轮功能上下文审计 **P2-D9**）。
 *
 * ## 原来坏在哪（可复现的现场形态）
 *
 * `feedbackCache` 的唯一写入者是下面的 `saveFeedback`（`feedback.set`），
 * 而 UI 上的真实写路径是 `core/llm/feedback.ts` 的 `putMessageFeedback` /
 * `deleteMessageFeedback`（走**域写** `crud.upsert` / `crud.delete`）——
 * 它们**不碰**这个缓存。于是读路径 `loadFeedback` 第一行就 `if (feedbackCache.has(id)) return …`：
 *
 * 1. 任何一次 `saveFeedback`（遗留路径、测试夹具、未来的插件）把值塞进缓存；
 * 2. 之后用户点赞 → 改踩 → 取消（走域写，库里已经是新值 / 已经没有行）；
 * 3. 而 `loadFeedback` **永远**返回缓存里那一次的值 —— 取消之后界面仍显示有点赞。
 *
 * 缓存从来没有失效点，所以这不是"概率性问题"，是"一旦进缓存就再也出不来"。
 *
 * ## 修法与"为什么不直接删掉缓存"
 *
 * `loadFeedback` 是**同步**接口而 IPC 是异步的，缓存是它唯一的同步来源；
 * 删掉缓存 = "刚写完读不到"（原注释里的第 11 段缺陷）。
 * 所以保留缓存，但把**失效点补上**：两个域写路径在写成功后调用本函数。
 *
 * ## 换人之后这里返回什么（⚠️ 如实记下的残余缺陷）
 *
 * `saveFeedback` 走的是引擎的 `feedback.set`（5 列），**不写域镜像**；
 * 而 `loadFeedback` 的镜像是启动时读进来的那份 —— 也就是说
 * **写进去了、镜像里没有**（下次读镜像还是旧值 / 没有行）。
 * 彻底修法是让 `saveFeedback` 自己走域写；但它的三个调用点里两个是测试，
 * 一个是 `store.ts:639` 的**注释**（生产调用者 0），改它的收益与风险不成比例。
 * 所以这里把这件事变成**可见**的：调它的人都从 doc 里看得见"镜像不会同步"。
 */
export function invalidateFeedbackCache(messageId: string): void {
  feedbackCache.delete(messageId);
}

/** 反馈写入是否走 Rust（端口可用时的分流判据） */
function rustFeedbackPort(): RustMessagePortLike | null {
  const port = rustMessagePort();
  return port?.data ? port : null;
}

export function saveFeedback(messageId: string, sessionId: string, feedback: FeedbackType | null): void {
  const port = rustFeedbackPort();
  if (port) {
    /*
     * 先内存后落库：本进程内读立即可见，落库失败如实上报。
     *
     * ⚠️ P2-D9 的残余（见 `invalidateFeedbackCache` 的说明）：这条命令**不写域镜像**，
     * 而 `loadFeedback` 的镜像是启动时那一份 —— 所以本函数写过的值，
     * 在**同一进程内**靠这个缓存可见，跨进程/镜像重载后读到的仍是镜像里的旧值。
     * 生产调用者为 0（UI 走 `feedback.ts` 的域写），所以这里只记事实、不改行为。
     */
    feedbackCache.set(messageId, feedback);
    void port.data
      .execute("feedback.set", { message_id: messageId, session_id: sessionId, feedback })
      .catch((e) => {
        reportPersistFailure("message.saveFeedback", e, "反馈未保存，重启后会丢失");
      });
    return;
  }
  reportWriteNotAccepted("message.saveFeedback", "反馈未保存");
  return;
}

/**
 * 读一条消息的反馈（`like` / `dislike` / `null`）。
 *
 * ## 第 11 段（P5）：修掉一个**真机可见的抛错**
 *
 * 原实现只有两条来源：本进程写过的缓存、以及旧库。rust 引擎下旧库刻意不加载，
 * 而 `const db = getDatabase()` 在 `try` **外面** —— 于是"给历史消息点开反馈按钮"
 * 会直接抛 `Database not initialized`（调用点：`store.ts` 的 `loadFeedback`、
 * `FeedbackButtons.tsx` 的 effect）。
 *
 * 现在补上中间那一层：`message_feedback` 是一张小表（只有被点过反馈的消息才有行），
 * 正好符合**通用域镜像**的适用边界，所以直接走 `domainReadOne`：
 * - 端口接手（镜像已加载）→ 命中返回、未命中 null；
 * - 端口在但镜像未就绪（B 态）→ 返回 null（**不碰旧库**），界面显示"未评价"；
 * - A 态（端口未注册）→ 维持原来的旧库读取，一个字节不变。
 *   （第 19 轮：A 态原来还有"wasm 回滚"这第二种形态，已随旧引擎删除。）
 */
export function loadFeedback(messageId: string): FeedbackType | null {
  // 本进程写过的优先（与写入落在同一处：都走 Rust）
  if (feedbackCache.has(messageId)) return feedbackCache.get(messageId) ?? null;
  // 没有可用存储时直接返回"未评价"（不再每次去撞不存在的端口、也不再刷屏）
  if (storageUnavailable()) return null;

  const rust = domainReadOne<{ feedback: string }>(
    FEEDBACK_TABLE,
    { message_id: messageId },
    (row) => ({ feedback: String(row.feedback ?? "") }),
  );
  if (rust !== undefined) {
    const value = rust?.feedback;
    return value === "like" || value === "dislike" ? value : null;
  }
  return null;
}

// ========== P0: Delete Messages After (for inline edit & resend) ==========

/**
 * Delete a message and ALL messages that come after it in the same session.
 * This is used by the inline-edit-and-resend feature: the user edits a message,
 * and everything from that point onwards is deleted so the conversation can
 * be re-run from the edited message.
 *
 * @returns the number of messages deleted (including the target message itself if includeSelf=true)
 */
export function deleteMessagesAfter(
  sessionId: string,
  messageId: string,
  options?: { includeSelf?: boolean }
): number {
  const includeSelf = options?.includeSelf ?? false;

  /**
   * B 态（端口在）：候选 id 在**会话镜像**上算（同一份数据、同一套 timestamp 语义），
   * 删除走端口。旧实现第一行 `getDatabase()` 在 rust 引擎下直接抛 ——
   * 而调用点（`App.tsx` 的"编辑并重发"）只 `console.error`，于是：
   * **被删掉的旧回复墓碑没写** → 下一次从权威日志合并时整批复活（用户现场形态）。
   *
   * 镜像未就绪时**等它就绪再做**（一次性回调）：宁可晚几百毫秒删、也不能退回旧库
   * （B 态写旧库 = 本进程内读写分裂），更不能"删了就报成功"。
   */
  const port = rustMessagePort();
  if (port?.messages) {
    /** @returns 删除条数；null = 镜像未就绪（登记"就绪后重做"） */
    const runWhenReady = (): number | null => {
      if (!port.messages!.isLoaded(sessionId) || port.messages!.isTruncated()) return null;
      const rows = port.messages!.list(sessionId);
      const target = rows.find((r) => r.id === messageId);
      if (!target) return 0;
      const targetTs = Number(target.timestamp);
      const ids = rows
        .filter((r) => (includeSelf ? Number(r.timestamp) >= targetTs : Number(r.timestamp) > targetTs))
        .map((r) => r.id);
      if (ids.length === 0) return 0;
      /**
       * **硬删除 + `confirm_bulk: true`**：`ids` = "从被编辑的那条起（含/不含自己）之后的全部消息"，
       * 同样已经在镜像上**枚举出确切目标**（调用方是 `App.tsx` 的"编辑并重发"）。
       *
       * 这里的规模完全可能超闸门（编辑第一轮 = 删掉整段会话的后续），而且每一条都会级联
       * 带走 `tool_calls` / `message_feedback` —— 不声明的话整条命令回滚，用户看到的形态是
       * "编辑重发之后旧回复还在"（比删错更难查）。
       */
      /*
       * P2-4：这条是**硬删除 + 可能很大**（"编辑并重发"会删掉该点之后的整段会话），
       * 是 `count_clamped` 的第二个来源。走统一入口后夹断可见、并当场重算。
       */
      deleteMessageIndexRows(
        port,
        ids,
        "hard",
        [sessionId],
        "message.deleteMessagesAfter",
        "编辑重发时后续消息未从查询索引删除",
      );
      port.applyMessageDelete?.(sessionId, ids);
      removeFtsViaPort(sessionId, ids);
      appendTombstonesFor(sessionId, ids);
      dropFromLogMirror(sessionId, ids);
      return ids.length;
    };
    const done = runWhenReady();
    if (done !== null) return done;
    port.messages.ensureLoaded(sessionId, () => {
      const later = runWhenReady();
      if (later !== null && later > 0) {
        console.log(`[MessageStorage] 会话 ${sessionId} 镜像就绪后补做"删除后续消息"：${later} 条`);
      }
    });
    return 0;
  }

  reportWriteNotAccepted("message.deleteMessagesAfter", "后续消息未删除");
  return 0;
}

/**
 * 更新用户消息正文（内联编辑用）。
 *
 * ## 为什么不再直接写旧库（P5 第 11 段，真机缺陷修正）
 *
 * 原实现只有旧库一条路径（`getDatabase()` + `UPDATE messages SET content`）。
 * rust 引擎下旧库**刻意不加载** → `getDatabase()` 抛 `Database not initialized`，
 * 而调用点（`App.tsx` 的"编辑并重发"）把它包在 `try/catch` 里只 `console.error` ——
 * 于是形成了一个**静默的数据丢失**：
 *
 * - store（界面）改了内容 → 用户以为编辑成功；
 * - **权威日志（JSONL）与索引都没有这次编辑** → 重启后内容回退到编辑前；
 * - 同一路径上的 `deleteMessagesAfter` 也一起抛 → **墓碑没写** → 被删掉的旧回复
 *   下次从日志合并时**整批复活**。
 *
 * 现在统一走 `updateMessage`：它本身就是"先写权威日志、再写索引（端口优先）"，
 * 并且索引写失败会如实上报（`messages.update` 影响 0 行会被 Rust 侧拒收）。
 */
export function updateMessageContent(messageId: string, content: string): void {
  updateMessage(messageId, { content });
}

// ========== Agentic Loop Helper Functions ==========
//
// 第 11 段（P5）：`appendMessageContent` / `setMessageContent` / `setMessageReasoning` /
// `setMessageStatus` 的**旧库唯一实现**已删除 —— 它们与 `appendToMessage` /
// `updateMessageContent` 完全同义，现在统一在文件上方（定义在 `updateMessage` 之后）
// 以别名形式给出，实现只有一份。保留别名是为了不动调用点（外部有按名字引用的地方）。

// ========== Convert Message to LLM API format ==========

function stripSystemReminders(content: string): string {
  // Remove <system-reminder>...</system-reminder> tags injected by MiMoCode CLI
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "audio"; mediaType: string; data: string };

export interface LLMMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
  /**
   * DeepSeek thinking mode: reasoning_content must be round-tripped back to the
   * API on historical assistant messages (HTTP 400 otherwise). Stored in DB
   * `messages.reasoning`; passed to provider.toAPIMessage as `reasoning_content`.
   */
  reasoning?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export function messagesToLLMMessages(messages: Message[]): LLMMessage[] {
  const result: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const cleanContent = stripSystemReminders(msg.content || "(empty)");
      if (!cleanContent) continue;

      // Check for media attachments (image/audio) — generate ContentBlock[] for multimodal
      const mediaAttachments = (msg.attachments || []).filter(
        (a) => (a.type === "image" || a.type === "audio") && a.content
      );
      if (mediaAttachments.length > 0) {
        const blocks: ContentBlock[] = [
          { type: "text", text: cleanContent },
        ];
        for (const att of mediaAttachments) {
          let base64Data = att.content || "";
          const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,(.+)$/);
          const mediaType = dataUrlMatch ? dataUrlMatch[1] : (att.mimeType || (att.type === "audio" ? "audio/mpeg" : "image/png"));
          const rawData = dataUrlMatch ? dataUrlMatch[2] : base64Data;
          blocks.push({
            type: att.type === "audio" ? "audio" : "image",
            mediaType,
            data: rawData,
          });
        }
        result.push({
          id: msg.id,
          role: "user",
          content: blocks,
        });
      } else {
        result.push({
          id: msg.id,
          role: "user",
          content: cleanContent,
        });
      }
    } else if (msg.role === "assistant") {
      const toolCalls = msg.toolCalls || [];
      const completedTools = toolCalls.filter((t) => t.status === "done" || t.status === "error");

      // Build content: text only (reasoning_content is a separate field for DeepSeek)
      let content = stripSystemReminders(msg.content || "");

      // Include the assistant message if it has text content OR any completed tool calls.
      // Previously this was all-or-nothing: if ANY tool call was still "running",
      // ALL tool calls and results were excluded. This caused the LLM to lose
      // visibility of previous tool results (e.g., wait_for_subagent results),
      // leading to infinite loops where the LLM repeatedly called the same tool.
      //
      // Now: only include COMPLETED tool calls and their results. Running/pending
      // tool calls are simply omitted — they'll be included in the next iteration
      // once they complete.
      if (content || completedTools.length > 0) {
        const assistantMsg: LLMMessage = {
          id: msg.id,
          role: "assistant",
          content,
        };
        // DeepSeek thinking mode REQUIRES round-tripping reasoning_content:
        // DeepSeek V4 (thinking mode) rejects requests where a previous
        // assistant message's reasoning_content is omitted — HTTP 400
        // "The `reasoning_content` in the thinking mode must be passed back
        // to the API." (multi-turn tool-call conversations trigger this).
        // DB `messages.reasoning` was previously stripped here (fear of the
        // LLM treating old reasoning as instructions), but the API now
        // enforces it. Reasoning is still displayed in UI; it is also passed
        // back verbatim as `reasoning_content` for API compatibility.
        if (msg.reasoning) {
          assistantMsg.reasoning = msg.reasoning;
        }
        if (completedTools.length > 0) {
          assistantMsg.tool_calls = completedTools.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.tool,
              arguments: JSON.stringify(tc.args || {}),
            },
          }));
        }
        result.push(assistantMsg);
      }

      // Add tool results for completed tools only
      for (const tc of completedTools) {
        const cleanResult = stripSystemReminders(tc.result || "(no output)");
        result.push({
          id: `${msg.id}-tool-${tc.id}`,
          role: "tool",
          content: cleanResult,
          toolCallId: tc.id,
        });
      }
    }
    // Skip system messages (they're handled separately)
  }

  // Remove orphan tool messages
  const cleaned: LLMMessage[] = [];
  let lastAssistantWithToolCalls = false;
  for (const msg of result) {
    if (msg.role === "assistant") {
      lastAssistantWithToolCalls = !!(msg as any).tool_calls;
      cleaned.push(msg);
    } else if (msg.role === "tool") {
      if (lastAssistantWithToolCalls) {
        cleaned.push(msg);
      }
    } else {
      lastAssistantWithToolCalls = false;
      cleaned.push(msg);
    }
  }

  return cleaned;
}
