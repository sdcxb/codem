/**
 * Feedback — 反馈机制
 *
 * 设计对标 DSH `command-feedback` + `message-feedback`。
 *
 * 两层反馈：
 * 1. 会话级反馈：用户通过 /feedback 命令记录关于整个会话的反馈
 *    — 记录为事件日志中的 feedback/record 事件（log-only，不进入模型上下文）
 * 2. 消息级反馈：per-message rating + optional note
 *    — 存储在 message_feedback sidecar 表（已有基础）
 *    — 增加 note 字段支持
 *
 * 关键设计（与 DSH 一致）：
 * - feedback/record 是 log-only 事件 — 不出现在投影消息中
 * - 消息级反馈是 sidecar — 不影响事件日志
 * - 版本控制：乐观并发控制（ifVersion 匹配）
 * - note 有最大字节限制
 */

import { getEventLog } from "../storage/event-log";
import { invalidateFeedbackCache } from "../storage/message";
import { domainDelete, domainPortRegistered, domainReadMany, domainReadOne, domainWrite } from "../storage/domain-store";
import { reportPersistFailure } from "../storage/persist-failure";

// ========== Types ==========

/**
 * 反馈评分。
 *
 * ⚠️ `"neutral"` **不是**一个能存进库的值：`message_feedback` 表上有
 * `CHECK (feedback IN ('like','dislike'))`（真 CLI 实测会报 `CHECK constraint failed`）。
 * 它在本 API 里表示"**取消反馈**"，由 `putMessageFeedback` 归一成**删除那一行** ——
 * "未评价"这个状态在库里表达为"没有这一行"，不是"有一行 neutral"。
 */
export type FeedbackRating = "like" | "dislike" | "neutral";

export interface MessageFeedbackItem {
  messageId: string;
  rating: FeedbackRating;
  note?: string;
  version: string; // 乐观并发 token
  createdAt: number;
  updatedAt: number;
}

export interface SessionFeedbackEntry {
  /** 事件日志中的 seq */
  seq: number;
  /** 反馈文本 */
  text: string;
  /** 记录时间 */
  timestamp: number;
}

// ========== Configuration ==========

/** note 的最大 UTF-8 字节数 */
const MAX_NOTE_BYTES = 4096;

// ========== Session-Level Feedback ==========

/**
 * 记录会话级反馈 — 追加 feedback/record 事件到事件日志。
 *
 * 这是 log-only 事件：不进入模型上下文投影。
 * 对标 DSH `recordFeedback(session, text)`。
 *
 * @param sessionId 目标会话
 * @param text 反馈文本（trim 后不能为空）
 * @throws TypeError 当文本为空
 */
export function recordSessionFeedback(sessionId: string, text: string): void {
  const normalized = text.trim();
  if (normalized.length === 0) {
    throw new TypeError("feedback text must not be empty");
  }

  getEventLog().append(sessionId, "session_meta", {
    action: "feedback_record",
    text: normalized,
  });
}

/**
 * 读取会话的所有反馈记录。
 * 从事件日志中过滤 session_meta + action=feedback_record 事件。
 */
export function listSessionFeedback(sessionId: string): SessionFeedbackEntry[] {
  const events = getEventLog().readAll(sessionId);
  return events
    .filter(
      (e) =>
        e.type === "session_meta" &&
        (e.payload as any)?.action === "feedback_record",
    )
    .map((e) => ({
      seq: e.seq,
      text: (e.payload as any).text,
      timestamp: e.timestamp,
    }));
}

// ========== Message-Level Feedback (Sidecar) ==========

/**
 * 验证 note 的字节长度。
 */
function validateNote(note: string | undefined): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (note === undefined) return { ok: true, value: undefined };
  if (note.trim().length === 0) {
    return { ok: false, error: "note must not be blank" };
  }
  const bytes = Buffer.byteLength(note, "utf8");
  if (bytes > MAX_NOTE_BYTES) {
    return { ok: false, error: `note too large: ${bytes} bytes (max ${MAX_NOTE_BYTES})` };
  }
  return { ok: true, value: note };
}

/**
 * 确保 message_feedback 表有 note 和 version 列。
 *
 * ## P5 第 1 段：这四列已经进了真源，这里只剩"兼容老库"的兜底
 *
 * 原来这四列**只**靠这个函数在运行期 `ALTER TABLE` 加 —— 而 `gen-schema-sql.mjs`
 * 只读 SCHEMA，看不见这些 ALTER，于是 Rust 侧的库根本没有这四列，
 * `putMessageFeedback()` 按九列写入被 Rust 引擎直接拒收（真机实测确认）。
 * 现在四列已在 SCHEMA 里声明、并由 migrations 补齐（两条路径都幂等），
 * 这个函数因此**不再是必需的**，保留只是为了兼容"列确实缺失"的极端老库。
 *
 * 安全边界（必须记住）：Rust 侧引擎**不允许 ALTER**（authorizer 只放行只读语句），
 * 所以这里在端口可用时**直接跳过** —— 否则每次调用都会产生一条注定失败、且毫无意义的
 * 引擎往返。端口可用就意味着 schema+迁移已经应用过，列必然存在。
 *
 * 判据用 `hasStoragePort()`（任何引擎）而不是"端口是 rust"：
 * 端口存在就说明磁盘 schema 由引擎自己管，渲染侧不该再碰 `getDatabase()` ——
 * 否则在"端口已注册但镜像尚未加载"的窗口里，这个函数会把旧库拉起来
 * （踩过一次：契约测试里表现为"旧库不应在已路由的域上被访问"）。
 */
function ensureNoteColumn(): void {
  /**
   * **这个函数已经什么都不做了**（第 16 轮，L4）。
   *
   * 它存在的唯一理由是"极老库缺这四列时补上"：`note` / `version` / `created_at` / `updated_at`。
   * 而渲染进程**已经没有旧库可 ALTER 了**（回滚开关退役、旧引擎即将删除）——
   * 列的存在由引擎侧保证：它们已在 `SCHEMA` 里声明，并由 `migrations` 幂等补齐
   * （两条路径都验过，见 `src-tauri/codem-db/sql/`）。
   *
   * 保留函数壳而不删调用点，是为了让"为什么这里不再需要 ALTER"留下痕迹；
   * 顺带把 import 一起收掉（`getDatabase` / `shouldFallbackToLegacy` 在本文件若不再使用）。
   */
}

// ========== 行 ↔ 线协议行（P5 第 1 段：走域端口，不再依赖 WASM 库） ==========

const TABLE = "message_feedback";

interface FeedbackWireRow {
  id: string;
  message_id: string;
  session_id: string;
  feedback: FeedbackRating;
  timestamp: number;
  note: string | null;
  version: string | null;
  created_at: number | null;
  updated_at: number | null;
}

function wireToFeedback(row: Record<string, unknown>): FeedbackWireRow {
  return {
    id: String(row.id ?? ""),
    message_id: String(row.message_id ?? ""),
    session_id: String(row.session_id ?? ""),
    feedback: String(row.feedback ?? "like") as FeedbackRating,
    timestamp: Number(row.timestamp ?? 0),
    note: (row.note as string) ?? null,
    version: (row.version as string) ?? null,
    created_at: (row.created_at as number) ?? null,
    updated_at: (row.updated_at as number) ?? null,
  };
}

function feedbackToItem(row: FeedbackWireRow): MessageFeedbackItem {
  return {
    messageId: row.message_id,
    rating: row.feedback,
    ...(row.note ? { note: row.note } : {}),
    version: row.version || "",
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
  };
}

/**
 * 创建或替换消息级反馈。
 *
 * 乐观并发：如果该消息已有反馈，request 中的 ifVersion 必须匹配。
 * 对标 DSH MessageFeedbackService.put()。
 *
 * ## 任务 C-4 ②：`ifVersion` 的 `undefined` 语义（原实现恒判冲突）
 *
 * 原实现是 `if (ifVersion !== currentVersion)`，其中 `currentVersion = existing?.version ?? null`。
 * 于是**没传版本**（`ifVersion === undefined`）与"当前没有版本"（`null`）被比成
 * `undefined !== null` —— **恒为真** → 直接返回 `version-conflict`，**任何写入都没发生**。
 * 而 UI 侧（`store.ts` 的 `setFeedback`）调用的正是**不传版本**的形态，
 * 且它把返回值 `catch {}` 掉了 —— 用户点了赞/踩，界面变了，库里一条都没有。
 *
 * 正确语义（也是 DSH `put()` 的语义）：
 * - `ifVersion === undefined` → **不做版本校验**（"我没看到版本"≠"我要求一个特定版本"）；
 * - `ifVersion === null` → 要求"当前**没有**反馈行"（新增语义，供"首次评价"用）；
 * - 给了具体字符串 → 必须与当前版本**严格相等**。
 *
 * ## 任务 C-4 ③：`neutral` 不是"评分"
 *
 * `message_feedback.feedback` 上有 `CHECK (feedback IN ('like','dislike'))`，
 * 传 `'neutral'` 会被引擎拒绝（真 CLI 实测）—— 而调用方把它当"取消反馈"用。
 * 真正的取消在表里表达为"没有这一行"，所以这里把 `neutral` 归一成**删除**。
 *
 * @returns 成功则返回提交的 item，失败返回错误信息
 */
export function putMessageFeedback(
  sessionId: string,
  messageId: string,
  rating: FeedbackRating,
  note?: string,
  ifVersion?: string | null,
): { ok: true; item: MessageFeedbackItem } | { ok: false; error: string } {
  ensureNoteColumn();

  const noteResult = validateNote(note);
  if (!noteResult.ok) return { ok: false, error: noteResult.error };

  const now = Date.now();

  /*
   * 这次读**一次取齐**（任务 Y-1）：`undefined`（没接手）/ `null`（确实没有）/ 行 三态
   * 全都要用 —— 后面的写入分支要判"端口接没接手"，若再调一次 `getMessageFeedback()`
   * 就把 `undefined` 压成了 `null`，那个判据就没了（原来正是这么写的，
   * 只不过当时还有第二次 `domainReadOne` 兜着）。
   */
  const { row: existingRow, item: existing } = readMessageFeedback(messageId);

  // 版本检查（C-4 ②：`undefined` = 不校验，见上面的说明）
  const versionConflict = checkVersion("put", ifVersion, existing?.version ?? null);
  if (versionConflict) return { ok: false, error: versionConflict };

  /**
   * `neutral` = 取消反馈（C-4 ③）。
   *
   * 归一成删除而不是"写一个 neutral 值"：表上的 CHECK 不允许 neutral，
   * 而"没有这一行"正是这个域表达"未评价"的方式（`getMessageFeedback` 返回 null）。
   *
   * 契约形态：`MessageFeedbackItem.version` 的语义是"**当前存库行**的并发 token"，
   * 取消之后没有行 —— 所以这里显式返回空串（`feedbackToItem` 对无 version 的历史行
   * 也是这么给的：`row.version || ""`）。**不编造**一个 UUID：那会让调用方以为
   * "取消"产生了一个可继续做乐观并发的新版本。
   *
   * ## Y-1：`removed.ok === false` 必须**原样传出去**
   *
   * 存储不可用时 `deleteMessageFeedback` 现在返回 `{ ok:false, error:"…暂不可用…" }`
   * （改前它会把"读不到"当"本来就没有"而返回成功）。这里若把失败吞掉，
   * 就又在**上一层**重演了同一个假成功 —— 所以 `error` 必须带上去，
   * 由 `store.setFeedback` 走上报通道告诉用户"没有真的取消"。
   */
  if (rating === "neutral") {
    const removed = deleteMessageFeedback(messageId, ifVersion);
    if (!removed.ok) return { ok: false, error: removed.error };
    return {
      ok: true,
      item: {
        messageId,
        rating,
        ...(noteResult.value !== undefined ? { note: noteResult.value } : {}),
        version: "",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
    };
  }

  // 如果完全相同，返回现有（no-op）
  if (
    existing &&
    existing.rating === rating &&
    existing.note === noteResult.value
  ) {
    return { ok: true, item: existing };
  }

  const newVersion = crypto.randomUUID();

  const item: MessageFeedbackItem = {
    messageId,
    rating,
    ...(noteResult.value !== undefined ? { note: noteResult.value } : {}),
    version: newVersion,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // 迁移期：先用镜像判空/取现有行，再整体写回（旧实现是 DELETE + INSERT 两条语句，
  // 中间失败会留下"反馈消失"的状态；整体 upsert 没有这个中间态）。
  // Y-1：这里的"判空/取现有行"直接复用开头那一次读的结果（同一个快照），
  // 不重复问一次镜像 —— 两次读之间镜像状态可以变化，那就又出现两个不同的判断了。
  if (existingRow !== undefined) {
    const writeRow = (): void => {
      domainWrite(
        TABLE,
        [{
          id: `fb-${messageId}`,
          message_id: messageId,
          session_id: sessionId,
          feedback: rating,
          timestamp: now,
          note: noteResult.value ?? null,
          version: newVersion,
          created_at: item.createdAt,
          updated_at: now,
        }],
        { mode: "replace", scope: "feedback.put", note: "消息反馈未保存" },
      );
      /**
       * **P2-D9**：域写之后必须让 `message.ts` 的 `feedbackCache` 失效。
       *
       * 那个缓存是 `loadFeedback`（同步接口）的写穿缓存，唯一写入者是遗留的
       * `saveFeedback`。只要它里面有这条消息的值，`loadFeedback` 就**永远**返回它 ——
       * 而这里刚刚把库里改成了别的评级（或取消了）。
       * 失效必须在**这里**发生：缓存键是 message id，与 session 无关，
       * 而"域写发生在哪"只有本模块知道。
       */
      invalidateFeedbackCache(messageId);
    };
    if (existingRow && existingRow.id !== `fb-${messageId}`) {
      // 历史行用了别的 id（例如 message.ts 的轻量路径写的 `fb-...`）：
      // 先删掉再加，保持"一条消息最多一条反馈"这个不变量。
      domainDelete(TABLE, { id: existingRow.id }, { scope: "feedback.replace", note: "旧反馈未删除" });
    }
    writeRow();
    return { ok: true, item };
  }

  /**
   * **旧库写入已删除**（第 17 轮，L4）：端口没接手时**如实回绝**，绝不写一份读路径看不见的副本。
   * （原实现会把反馈写进旧库，而 rust 模式下旧库既不存在、读路径也只认端口 —— 那就是读写分裂。）
   */
  return { ok: false, error: "反馈存储暂不可用（索引未就绪），请稍后重试" };
}

/**
 * 乐观并发的版本判据（`put` / `delete` 共用，保证两处语义**永远一致**）。
 *
 * 三态语义见 `putMessageFeedback` 的说明：`undefined` 不校验、`null` 要求"当前无行"、
 * 字符串必须严格相等。抽成函数是因为这个判据原来在两个地方各写了一遍，
 * 而其中一处写错了（`!= null` 那半边）—— 同一个判断写两遍就会变成两个不同的判断。
 *
 * @returns 冲突时的错误文案；不冲突返回 `null`
 */
function checkVersion(
  op: "put" | "delete",
  ifVersion: string | null | undefined,
  currentVersion: string | null,
): string | null {
  // 未提供版本 = 不做校验（**不是**"当前必须为 null"）—— 这是 C-4 ② 的核心
  if (ifVersion === undefined) return null;
  // 显式 `null` = 要求"当前没有反馈行"（首次评价 / 期望已取消）
  if (ifVersion === null) {
    return currentVersion === null
      ? null
      : `version-conflict: expected null (no existing feedback), got ${currentVersion}`;
  }
  return ifVersion === currentVersion
    ? null
    : `version-conflict: expected ${ifVersion}, got ${currentVersion ?? "null"} (op=${op})`;
}

/**
 * 反馈行的**原始读结果**：把"读不到"与"确实没有"分开（任务 Y-1）。
 *
 * ## 为什么必须有一个把 `undefined` 留在原地的读函数
 *
 * `getMessageFeedback` 的契约是 `MessageFeedbackItem | null` —— 它把
 * `domainReadOne` 的 **`undefined`（没接手）压成了 `null`（确实没有）**。
 * 这对"读"是对的（调用方只能拿到"这条反馈现在读不到"这一件事），
 * 但对"删除"是致命的：
 *
 * – `deleteMessageFeedback` 用 `existing === null` 当作"本来就没有这一行"，
 *   于是在"端口未接手 / 镜像未就绪"这两个**什么都没确认**的状态下，
 *   直接返回 `{ ok: true, absent: true }`（取消成功）；
 * - 而 `putMessageFeedback` 的**写入**路径在同一个状态下是
 *   `{ ok: false, error: "反馈存储暂不可用（索引未就绪），请稍后重试" }`。
 *
 * **同一个函数里两条路对同一个状态给出相反的答复**，用户看到的就是
 * "点取消赞 → 界面变了、库里那行还在 → 重启后赞又回来了"。
 *
 * 所以这里保留三态原样返回，让调用方**自己**决定"读不到"该怎么处置。
 */
function readMessageFeedback(
  messageId: string,
): {
  /** `undefined` = 端口没接手（读不到）；`null` = 镜像接手了但确实没有这一行 */
  row: FeedbackWireRow | null | undefined;
  item: MessageFeedbackItem | null;
} {
  ensureNoteColumn();
  const row: FeedbackWireRow | null | undefined = domainReadOne(TABLE, { message_id: messageId }, wireToFeedback);
  return { row, item: row ? feedbackToItem(row) : null };
}

/**
 * 获取消息级反馈。
 *
 * 读语义**一个字没改**（Y-1 只改删除路径）：读不到时返回 `null`，
 * 因为调用方（`getMessageFeedback` 的读路径 / UI）能表达的只有"现在读不到"。
 * 区分"读不到"与"确实没有"的责任在写/删路径（见 `readMessageFeedback`）。
 */
export function getMessageFeedback(messageId: string): MessageFeedbackItem | null {
  return readMessageFeedback(messageId).item;
}

/**
 * 删除消息级反馈。
 * 对标 DSH MessageFeedbackService.delete()。
 *
 * ## 任务 Y-1（中高）：原实现在"没确认过"的状态下报"取消成功"
 *
 * 原实现的第一件事是 `existing = getMessageFeedback(messageId)`，**为 null 直接
 * `return { ok: true, absent: true }`** —— 而 `getMessageFeedback` 在
 * **端口未接手 / 该域镜像未就绪**时同样返回 `null`（那是"读不到"，不是"没有"）。
 * 于是"存储不可用"被表达成"本来就没有这一行 → 取消成功"，
 * `putMessageFeedback(neutral)` 返回 `{ ok: true, item: { rating: "neutral", version: "" } }`。
 *
 * 症状：点"取消赞" → 界面图标灭了、库里那一行还在 → 重启后赞又回来。
 * 同一函数里的**写入**路径（见 `putMessageFeedback` 末尾）对同一个状态是正确的
 * `{ ok: false, error: "反馈存储暂不可用（索引未就绪），请稍后重试" }` ——
 * 一个函数里两条路给出相反的答复，正是这条缺陷的本质。
 *
 * ## 四种形态（端口未接手 / 镜像未就绪 / 确实不存在 / 确实存在）
 *
 * `domainReadOne` 的三态（`undefined` / `null` / 行）**加上**端口的注册与否，
 * 恰好把这四态分干净 —— 判据只有 `domainPortRegistered()`，不猜任何内部状态：
 *
 * | 形态 | `hasStoragePort()` | `domainReadOne` | 处置 | 返回 |
 * |---|---|---|---|---|
 * | ① 端口未接手（本进程没有可用存储） | false | `undefined` | 上报 + 不删 | `{ ok:false, error:"…暂不可用…" }` |
 * | ② 端口在、镜像未就绪（加载窗口/被拒/被逐出） | true | `undefined` | 上报 + 不删 | `{ ok:false, error:"…暂不可用…" }` |
 * | ③ 镜像已就绪、确实没有这一行 | true | `null` | 无需删除（本次确实没删任何行） | `{ ok:true, absent:true }` |
 * | ④ 镜像已就绪、确实有这一行 | true | 行 | 版本校验 → 删除 | `{ ok:true, absent:true }` |
 *
 * ⚠️ ① 与 ② 的**处置相同**（都回绝），但必须分开写：它们的成因不同
 * （没有存储 vs 存储还在加载），日志与上报文案要说清是哪一种，
 * 否则真机排查时看到"暂不可用"根本不知道等一会儿会不会好。
 *
 * ⚠️ ③ 与 ④ 都返回 `absent: true` —— 这是**既有契约**（"这次调用之后库里没有这一行"），
 * ④ 的删除动作本身失败会走 `domainDelete` 的写穿失败上报，不会静默。
 * 本任务**不动**这个契约（改了会连带影响 `putMessageFeedback` 的返回值语义）。
 */
export function deleteMessageFeedback(
  messageId: string,
  ifVersion?: string | null,
): { ok: true; absent: boolean } | { ok: false; error: string } {
  ensureNoteColumn();

  // 形态 ①②③④ 的判据一次取齐：`row === undefined` = 没接手（①②），
  // 否则镜像确实接手了，`row === null` 就是"确实没有这一行"（③）。
  const { row, item } = readMessageFeedback(messageId);

  if (row === undefined) {
    /*
     * ①②：**什么都没确认** —— 绝不能报"本来就没有"。
     *
     * 这里必须**上报**（而不是只返回错误）：调用方里既有走返回值判断的
     * （`putMessageFeedback` → `store.setFeedback`），也有只看界面的路径；
     * 上报通道（`persist-failure`）是同仓"失败必须可见"的统一约定。
     * 文案区分两态，理由见函数注释上方。
     */
    const registered = domainPortRegistered();
    reportPersistFailure(
      "feedback.delete",
      new Error(registered ? "反馈域镜像未就绪" : "本进程没有可用存储（端口未注册）"),
      registered
        ? `消息 ${messageId} 的反馈未删除（镜像未就绪，**不能**当作"本来就没有"）`
        : `消息 ${messageId} 的反馈未删除（没有可用存储，**不能**当作"本来就没有"）`,
    );
    return { ok: false, error: "反馈存储暂不可用（索引未就绪），请稍后重试" };
  }

  // C-4 ②：与 `put` 用**同一个**判据（原来这里也是 `!==`，同样会被 undefined 误判）
  // ③ 的 `item` 是 null → `currentVersion` 传 null，语义正是"当前没有反馈行"。
  const versionConflict = checkVersion("delete", ifVersion, item?.version ?? null);
  if (versionConflict) return { ok: false, error: versionConflict };

  // ③：镜像确认接手且确实无行 —— 这才是真正可以报"本来就没有"的唯一形态
  if (row === null) return { ok: true, absent: true };

  // ④：确实有行 → 删。删除写穿的失败由 `domainDelete` 上报，不静默。
  domainDelete(TABLE, { id: row.id }, { scope: "feedback.delete", note: "消息反馈未删除" });
  /**
   * **P2-D9**：删除也是"换人写"——`message.ts` 的 `feedbackCache` 若还留着一条旧评级，
   * `loadFeedback` 会**永远**返回它，于是"用户点了取消、界面却仍然显示已点赞"
   * 这个形态会一直存在（缓存没有别的失效点）。与 `putMessageFeedback` 同一个理由。
   */
  invalidateFeedbackCache(messageId);
  return { ok: true, absent: true };
}
/**
 * 列出会话的所有消息级反馈。
 */
export function listMessageFeedback(sessionId: string): MessageFeedbackItem[] {
  ensureNoteColumn();
  const rust = domainReadMany(TABLE, wireToFeedback, { session_id: sessionId });
  if (rust) {
    // 旧 SQL：ORDER BY created_at ASC（NULL 排在最前，与 SQLite 一致）
    return rust
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
      .map(feedbackToItem);
  }
  // 端口没接手 → 该域的合理空结果（旧库已从渲染进程移除）
  return [];
}
