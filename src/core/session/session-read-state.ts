/**
 * 会话「已读水位」—— 侧栏未读徽标的**真实数据源**（第 72 轮审计新增）
 *
 * ## 为什么会有这个文件
 *
 * 审计发现侧栏那个 `session-unread-badge` 是**死代码**：它读 `session.unreadCount`，
 * 而全仓**没有任何地方写这个字段**（`sessions` 表也没有这一列，Rust 侧更没有 `unread_count`）
 * ⇒ 徽标永远不会显示。用户看到的是"这个功能好像有、但从来没见过"。
 *
 * 修它不是"给个默认值"（那正是这两轮在治的病：界面上的数字没有真实来源），
 * 而是把**数据源补上**：每个会话记一个"已读到第几条消息"的水位，未读 = 现在比水位多了几条。
 *
 * ## 语义（刻意选成可解释、可验证的那种）
 *
 * - 水位 = 该会话 `message_count` 的**快照**（上次你看它时的条数）；
 * - 未读 = `max(0, message_count - 水位)`，即"**从你上次看过之后，这个会话又多了几条消息**"；
 * - **第一次见到的会话**（没有水位）视作"已读到当前条数" ⇒ 不会把历史会话几百条全算成未读；
 * - 你**正在看的那个会话**会被持续标记为已读 ⇒ 未读恒为 0（符合直觉，也不用特殊判断）。
 *
 * ## 为什么存 settings 而不是加一列
 *
 * `sessions` 是引擎侧的权威表，加列要走 schema 迁移（这份数据是"界面已读状态"，
 * 丢了最多多显示一个徽标，不值当动引擎 schema）；而 `settings` 是本仓库唯一
 * **允许进渲染进程内存镜像**的配置面（几十行量级），且读是同步的 —— 正好适合"渲染时要立刻拿到"。
 * 键名集中在 `KEY`，写入是**整表覆盖**（key→条数 的映射，很小）。
 *
 * ## 边界（如实写在代码里）
 *
 * - `message_count` 统计的是**消息条数**（用户与助手都算），所以徽标说的是
 *   "有几条新消息"，不是"有几条新回复"；
 * - 它由消息写入路径维护（`reconcileSessionMessageCountById` 等），若某个会话的计数没被
 *   更新到，徽标会偏小 —— 但**不会编造**：没有水位就没有徽标。
 */

import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";

/** settings 里的键（唯一来源；测试与迁移都引用它） */
const SESSION_READ_WATERMARK_KEY = "codem-session-read-watermarks";
/** "历史会话已按'此刻已读'初始化过"的一次性标记 */
const SESSION_READ_MIGRATED_KEY = "codem-session-read-initialized";

/** sessionId → 已读到的消息条数 */
export type ReadWatermarks = Record<string, number>;

/** 读水位表（同步）。任何异常都退化成"空表"，绝不让渲染路径抛。 */
export function getReadWatermarks(): ReadWatermarks {
  try {
    const raw = getSettingJSON<Record<string, unknown>>(SESSION_READ_WATERMARK_KEY, {});
    const out: ReadWatermarks = {};
    for (const [id, v] of Object.entries(raw ?? {})) {
      const n = Number(v);
      if (id && Number.isFinite(n) && n >= 0) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function writeWatermarks(marks: ReadWatermarks): boolean {
  try {
    setSettingJSON(SESSION_READ_WATERMARK_KEY, marks);
    return true;
  } catch (e) {
    reportPersistFailure(
      "session.markRead",
      e as Error,
      "会话已读状态未保存（重启后可能多显示一个未读徽标，不影响消息本身）",
    );
    return false;
  }
}

/**
 * 把某个会话标记为"已读到 `messageCount` 条"。
 *
 * **只前进，不回退**（除非同一个数字重复写）：否则"标记已读"之后又来一条更旧的长度
 * （例如计数被复核修正变小）会把水位拉回去，徽标就会凭空冒出来。
 */
export function markSessionRead(sessionId: string, messageCount: number): void {
  if (!sessionId || !Number.isFinite(messageCount) || messageCount < 0) return;
  const marks = getReadWatermarks();
  const prev = marks[sessionId];
  if (prev !== undefined && prev >= messageCount) return; // 幂等：不写、也不回退
  marks[sessionId] = messageCount;
  writeWatermarks(marks);
}

/** 该会话的已读水位（没有记录时返回 null —— "不知道"与"读到 0"必须分得开） */
export function getSessionReadMark(sessionId: string, marks: ReadWatermarks = getReadWatermarks()): number | null {
  const v = marks[sessionId];
  return typeof v === "number" ? v : null;
}

/** 单会话未读条数（纯函数：`messageCount` 与"水位"的比较） */
export function unreadFor(messageCount: number, mark: number | null): number {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return 0;
  /*
   * `mark === null` ⇒ 这个会话是在"启用未读功能之后"才出现的（历史会话由一次性迁移提前打上水位）
   * ⇒ 全部条数都算未读。这正是"委派出去的子会话产生了消息"能被看见的原因。
   */
  if (mark === null) return Math.max(0, messageCount);
  return Math.max(0, messageCount - mark);
}

/**
 * 批量算未读。
 *
 * @param sessions 会话列表（只需 id 与 messageCount）
 * @param marks    水位表（省略则现读）
 */
export function computeUnreadBySession(
  sessions: ReadonlyArray<{ id: string; messageCount?: number }>,
  marks: ReadWatermarks = getReadWatermarks(),
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) {
    const n = unreadFor(Number(s.messageCount ?? 0), getSessionReadMark(s.id, marks));
    if (n > 0) out[s.id] = n;
  }
  return out;
}

/**
 * 一次性迁移：**第一次**运行本版本时，把此刻已存在的会话全部标记为已读。
 *
 * 为什么必须有：没有它，历史会话（本机最大的一个 657 条）升级后会立刻顶一个 657 的徽标，
 * 用户会以为"消息炸了"。迁移之后**新建**的会话不走这条路（没有水位 ⇒ 全部算未读），
 * 所以"新会话/被委派的会话有新消息"照样看得见。
 *
 * 两处细节：
 * - 会话列表为空时**不打标记**（否则"列表还没加载出来"这一瞬间会把历史会话整批漏掉，
 *   它们随后就会被算成全部未读）；
 * - 写入是**批量一次**（首次升级若有上百个会话，逐条写就是上百次 IPC）。
 *
 * @returns 是否执行了迁移（供日志与用例断言）
 */
export function ensureReadStateInitialized(
  sessions: ReadonlyArray<{ id: string; messageCount?: number }>,
): boolean {
  try {
    if (getSetting(SESSION_READ_MIGRATED_KEY) === "1") return false;
    if (sessions.length === 0) return false;
    const marks = getReadWatermarks();
    for (const s of sessions) {
      if (!s?.id || marks[s.id] !== undefined) continue;
      marks[s.id] = Math.max(0, Number(s.messageCount ?? 0));
    }
    writeWatermarks(marks);
    setSetting(SESSION_READ_MIGRATED_KEY, "1");
    return true;
  } catch (e) {
    // 迁移失败不致命：没打上标记，下次启动会再试
    console.warn("[session-read-state] 历史会话已读水位初始化失败（下次启动会重试）:", e);
    return false;
  }
}

/** 测试用：清掉水位与迁移标记 */
export function __resetReadState(): void {
  try {
    setSettingJSON(SESSION_READ_WATERMARK_KEY, {});
    setSetting(SESSION_READ_MIGRATED_KEY, "");
  } catch {
    /* 没有存储的测试环境忽略 */
  }
}
