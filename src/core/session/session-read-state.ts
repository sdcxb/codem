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
 * - 你**正在看的那个会话**会被持续标记为已读 ⇒ 未读恒为 0（符合直觉，也不用特殊判断）；
 * - ★ **第 187 波**：反过来也要能标 —— 一条 App 级消息写进**归属会话**而用户已经切走时，
 *   由 `markSessionUnread` 把水位退一格（见该函数的说明），否则那条消息就"静默丢"了。
 * - ★ **第 191 波（GAP-LIST `O-42`）**：写消息与**标未读**的顺序反过来（先写、再标），
 *   且写路径让会话计数在**同一个同步段**里可见 ⇒ 标未读走**精确分支**（水位不动、未读恰好 1）；
 *   只有"计数不可见"的调用点才走"宁可多显示 1 条"的兜底（见 `markSessionUnread` 的长注释）。
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

/**
 * 把某个会话标记为「**有你还没看到的东西**」—— `markSessionRead` 的**反向**操作
 * （第 187 波：App 级消息写进归属会话之后的可见性兜底）。
 *
 * ## 为什么需要它
 *
 * `runAgenticLoop` 的早退错误（会话忙 / 引擎未初始化 / 认证缺失 / provider 未配置 /
 * 工作树失败…）现在都写进**归属会话**（`session`），而用户此刻可能已经切到别的会话
 * ⇒ 那条气泡他当场看不见。既有的"未读水位"正好是这件事的载体：水位退一格，
 * 侧栏那个 `session-unread-badge` 就会出现，用户切回来就看得到 —— 不打断、也不丢。
 *
 * ## 语义与两条守卫
 *
 * - **只降不升**（与 `markSessionRead` 只前进恰好相反）：调用方只在"刚往这个会话里
 *   写了一条**用户没看过**的消息"时调它，所以下降是**有据**的；
 * - **幂等**（不会越调越低）：水位已经低于该会话当前条数时（`known > prev`）直接返回 ——
 *   那正是"已经有 ≥1 条未读"的状态，不需要再动。这一条同时挡住了
 *   "一轮里每条工具消息都调一次 ⇒ 水位被一路踩低 / 写风暴"。
 *
 * ## ⚠️ 如实记账：`-1` 是**兜底分支**，不是无条件偏移（GAP-LIST `O-42`）
 *
 * **为什么曾经必须踩一格**：`message_count` 由**引擎侧**在 `messages.upsert_index` 里维护
 * （`repo.rs::bump_session_message_count`，引擎是唯一写入者），而渲染侧镜像读到它隔着一次 IPC。
 * 更硬的一条是**调用点的顺序**：`App.tsx::safeAddMessage` 里原来先 `deliverOwnedMessage(...)`
 * （= 标未读）再 `persistLoopMessages()`（= 写消息）—— 标的那一刻 `known` **必然是旧值**。
 * 若那时什么都不做（把水位留成 `known`），徽标就**一条都不显示** —— 那正是这个函数要治的病。
 *
 * **第 191 波（`O-42`）之后**：写路径让**读模型在写入返回时就反映新计数**
 * （`message.ts` 的 `messageCountAdjustment`：本进程首次写入的消息 ⇒ 该会话计数 +1；
 * 引擎回传权威计数（`session_message_count`）后归零对账），而标未读被挪到**写消息之后**。
 * 于是 `known` 就是**写入后的真值**：水位**一格都不用踩**（`known > prev` 那一支本来就
 * 什么都不做），未读**恰好 1** —— `O-42` 记的那个"多显示 1 条"的偏差就此消失。
 *
 * **但仍然保留兜底分支**（`countVisible: false`）：只要还有"先标未读、后写消息"
 * 或"端口不带权威计数"的形态，踩一格就是**不静默丢**的唯一保证。代价（计数随后涨上来时
 * 多显示 1 条）仍然有界、且 `ChatPanel` 的 `markSessionRead`（取 `max(...)`）会自愈。
 *
 * **判据（把注释里那句"什么时候该改回去"变成机器条件）**：
 * `src/test/session-unread-count-visibility.test.ts` 的
 * `UNREAD-V1`（同步可见 ⇒ 水位不许动、未读恰好 1）与
 * `UNREAD-V2` / `UNREAD-V2b`（不可见 ⇒ 恰好踩一格、计数涨上来后恰好 1）互为反向对照。
 * 变异自证：`tools/mutate/specs/unread-191.mjs`。
 *
 * ## ⚠️ 如实记账：`countVisible` 这个入参**今天在两种真实形态下不可观察**
 *
 * 这是写这一波变异时**量出来的**（不是推测）：三支的入口只由 `known` 与 `prev` 决定，
 * 而"写后计数可见"的形态**必然**是 `known > prev`（写路径 +1 了），于是它在上面的守卫里
 * 就返回了，根本走不到 `countVisible`；`known < prev`（漂移态）也走不到它。
 * 唯一经过它的 `known === prev` 上，"可见"与"不可见"给出的**可观察结果恰好相同**
 * （都是"水位不动"）。实测：把调用点的 `Boolean(persist) && persisted` 钉死成 `false`，
 * `UNREAD-V1/V2/V2b` 全绿 ⇒ 这个分支**没有**对应的变异（写一条恒定绿的变异等于没测）。
 *
 * 那为什么还留着它：它是**保守缺省**（判据缺省退到"宁可多显示 1 条"那一侧），
 * 并且把"调用方必须如实说明自己读的是不是写入后的值"这件事写在类型上。
 * `O-42` 的真实修复落在**顺序**（先写后标）与**同步读模型**上，那两处各有一条能红的变异。
 *
 * @param messageCount 该会话**当前已知**的消息条数（`getSession(id)?.messageCount`）。
 *   读不到（镜像未就绪 / ≤0）时退回用现有水位当基准，仍然保证"至少 1 条"。
 * @param countVisible  这个 `messageCount` 是不是**写入之后**读到的（= 同步可见）。
 *   调用方必须如实传：`loop-owned-message.ts` 在写消息**之后**读计数 ⇒ `true`；
 *   旧形态（先标未读）或缺这个判据的调用点传 `false` ⇒ 走兜底。**默认 `false`**：
 *   判据缺省时必须退到"宁可多显示 1 条"那一侧（少显示才是静默丢）。
 *   ⚠️ 它今天只在 `known === prev` 这一支起作用，而那一支的两种取值结果相同（见上）。
 * @returns 是否真的改动了水位（供调用方与用例区分"标了"与"本来就可见"）
 */
export function markSessionUnread(
  sessionId: string,
  messageCount: number,
  countVisible = false,
): boolean {
  if (!sessionId) return false;
  const marks = getReadWatermarks();
  const prev = marks[sessionId];
  /*
   * 没有水位 ⇒ `unreadFor` 走 `mark === null` 那一支：**全部条数**都算未读（≥1 条）
   * ⇒ 本来就看得见，不需要（也不该）在这里凭空造一个水位出来。
   */
  if (prev === undefined) return false;
  const known = Number.isFinite(messageCount) && messageCount > 0 ? messageCount : prev;
  /*
   * **精确分支**：计数已经越过水位（`known > prev`）⇒ 这个函数什么都不用做 ——
   * 未读 ≥ 1 本来就是**算出来**的，不需要动水位。
   *
   * `countVisible` 只影响下面**兜底分支**该不该生效，不影响这一行：
   * `known > prev` 在任何时序下都已经是"有 ≥1 条未读"的事实。
   */
  if (known > prev) return false;
  /*
   * `known === prev` 有**两种含义相反**的形态（这正是本函数唯一需要判断的地方）：
   *
   * - `countVisible`：计数与水位相等是**写入后的真值**（你刚看完全部、此刻没有新消息）
   *   ⇒ 水位**一格都不许动**（动了就会在计数涨上来后凭空多一条）；
   * - `!countVisible`：`known` 是**写入之前**的旧值 ⇒ 水位必须踩一格，
   *   否则"刚写进去的那条"在计数涨上来之前**一条都不显示**。
   */
  if (countVisible) return false;
  /*
   * ## ⚠️ 兜底分支的基准**只取 `known`**（GAP-LIST `O-42` 的第二半）
   *
   * 第 187 波写的是 `Math.min(known, prev) - 1`。在这一支里 `known` **必然 ≤ `prev`**
   * （上面那行守卫已经把 `known > prev` 送走了），所以两者在**正常态**下等价
   * —— 这正是它一直没被发现的原因。但在**漂移态**（水位被 `ChatPanel` 的
   * `Math.max(fresh, currentSession, messages.length)` 推高过，`prev > known`）两者分道扬镳：
   *
   * - `min(...)`：取 `prev` ⇒ 水位从 5 踩到 4，而真实条数（读模型给的 `known`）是 3
   *   ⇒ 未读 = 3 − 4 = **0** —— 那条刚写的消息**一条都不显示**（兜底失效 = 静默丢）；
   * - 只取 `known`：水位从 5 踩到 2 ⇒ 未读 = 3 − 2 = 1 —— 兜底的真意（"至少 1 条"）成立。
   *
   * 也就是说：`min` 把"恰好踩一格"变成了"相对水位踩一格"，而那**不保证**任何东西。
   * 判据：`loop-owned-message.test.ts` 的 XSESS-3b 第三段（漂移态必须落在 `known - 1`）。
   */
  const target = Math.max(0, known - 1);
  if (prev <= target) return false; // 只降不升 + 幂等（已经更低就不写，避免写风暴）
  marks[sessionId] = target;
  return writeWatermarks(marks);
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
