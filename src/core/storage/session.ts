// 第 45 轮：`getEventLog` 的 import 已随"fork 不再复制事件日志"一起删除
// （原来这里唯一的用途就是 `getEventLog().forkSession(...)`，见下面 `parent_id` 写入处的说明）。
import type { Session } from "../types";
import { appendSessionTombstone } from "./session-jsonl";
import { releaseSessionLogCache } from "./message";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, reportWriteNotAccepted } from "./domain-store";

/**
 * `sessions` 域接入端口（P5 第 4 段）。
 *
 * ## 为什么这一段是"必须补"而不是"顺手接"
 *
 * P5 第 4 段把启动路径改成"引擎为 rust 时不加载 WASM 库"之后，真机复验发现：
 * **这个文件一个端口调用都没有** —— 创建会话、改标题、置顶、删除、fork、拖拽排序
 * 全都还在打旧库。旧库不加载之后这些操作会直接失败，而这是最核心的一条用户路径。
 *
 * ## 各函数的语义要点
 *
 * - `sessions` 表**没有** `updated_at` 列（时间列是 `last_message_at`）；
 * - 一批列是 ALTER 加的（execution_mode / worktree_* / *_mode / parent_id / sort_order），
 *   整体 upsert 时必须**显式列全**，否则会被写成 NULL；
 * - `listSessions` 排序是 `pinned DESC, last_message_at DESC`；
 * - `reorderSessions` 只改 `sort_order`，不能顺手改别的列。
 */
const SESSION_TABLE = "sessions";

/**
 * 拖拽排序的落点（B-6）。
 *
 * `sort_order` 一直是**"写了但没人读"**的一列：`reorderSessions` 写它，
 * 而 `listSessions` 只按 `pinned DESC, last_message_at DESC` 排 —— 于是拖拽之后
 * 下一次 list 就把它盖掉了（UI 上表现为"拖完弹回原位"）。
 *
 * 这里不去动 `Session` 类型（它在 `src/core/types.ts`，不在本批所有权内），
 * 而是把这一列**挂在这个模块自己的映射上**：读取时捕获、写回时带上、排序时使用。
 * 好处是零类型改动、零跨文件影响；代价是"排序值"不随 `Session` 对象外流 ——
 * 而它本来也不该外流（UI 不该关心排序键，它只该收到排好序的列表）。
 */
const sessionSortOrder = new Map<string, number>();

function wireToSession(row: Record<string, unknown>): Session {
  const id = String(row.id ?? "");
  // 捕获排序键（同一次读出顺手记下，避免再查一次库）
  const rawOrder = row.sort_order;
  if (rawOrder !== null && rawOrder !== undefined && Number.isFinite(Number(rawOrder))) {
    sessionSortOrder.set(id, Number(rawOrder));
  }
  return {
    id,
    projectId: String(row.project_id ?? ""),
    title: String(row.title ?? ""),
    model: (row.model as string) ?? undefined,
    createdAt: Number(row.created_at ?? 0),
    lastMessageAt: Number(row.last_message_at ?? 0),
    messageCount: Number(row.message_count ?? 0),
    pinned: Number(row.pinned ?? 0) === 1,
    executionMode: (row.execution_mode as Session["executionMode"]) ?? undefined,
    worktreePath: (row.worktree_path as string) ?? undefined,
    worktreeBranch: (row.worktree_branch as string) ?? undefined,
    correctionMode: (row.correction_mode as number) ?? undefined,
    deepThinkingMode: (row.deep_thinking_mode as number) ?? undefined,
    preserveExecutor: (row.preserve_executor as number) ?? undefined,
  // 第 54 轮：谱系要**读回来**才谈得上"写侧不丢"（写侧见 `sessionToWire` 的 parent_id）
  parentId: (row.parent_id as string | null) ?? null,
  };
}

/** `Session` → 线协议行。可选列**必须显式写 null**，否则"清空某列"写不进去。 */
function sessionToWire(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    project_id: s.projectId,
    title: s.title,
    model: s.model ?? null,
    created_at: s.createdAt,
    last_message_at: s.lastMessageAt,
    message_count: s.messageCount,
    pinned: s.pinned ? 1 : 0,
    execution_mode: s.executionMode ?? null,
    worktree_path: s.worktreePath ?? null,
    worktree_branch: s.worktreeBranch ?? null,
    correction_mode: s.correctionMode ?? null,
    deep_thinking_mode: s.deepThinkingMode ?? null,
    preserve_executor: s.preserveExecutor ?? null,
    /**
     * `sort_order` 必须一起写回（B-6）。
     *
     * 这条路径是"读出整行 → 改几个字段 → 整体写回"（见 `updateSession` /
     * `togglePinned` / `forkSession`）。带上这一列的理由有两条，**都要写清楚是哪一条**：
     *
     * 1. **`mode: "insert"`（`domainWrite` 的默认，建行路径用它）**：引擎侧是裸 `INSERT INTO`，
     *    落库的那一行**就是构造器给出的列** —— 漏掉哪列，那列就是 NULL。这是硬理由；
     * 2. **读-改-写要能成立为"整行写回"这个不变量**：`replace` 在引擎里是"先 UPDATE 只写
     *    本次提供的列，0 行才 INSERT"（`crud.rs:412-429`），所以**未提供的列其实保持原值**
     *    —— 靠这一条并不能证明"漏列会清空"。但旧库导入那条路用的是真正的
     *    `INSERT OR REPLACE`（`migrate.rs:290`），那里漏列就是静默清空；
     *    构造器把整行写全，就不用去分辨调用点落在哪条路上。
     *
     * ⚠️ 本注释的初版写的是"不带上这一列，`replace` 语义就会把用户的拖拽顺序清成 NULL" ——
     * 那是把 `replace` 当成了 `INSERT OR REPLACE`（**错**，见上面第 2 条；同一段注释里
     * 前面刚写过"upsert 是按传入列写的"，自相矛盾）。第 54 轮自查时改正。
     *
     * 显式写 `null` 也是一种表达（"这个会话没有排序键"）：在 `replace` 路径上，
     * **只有**显式 null 才能把一列清空（省略键 = 保持原值）。
     */
    sort_order: sessionSortOrder.get(s.id) ?? null,
  /**
   * `parent_id` 必须一起写回（第 54 轮）。
   *
   * 与 `sort_order` 同一个道理，但这一列**真的丢过一次**（有证据的那种）：
   * 建行路径（`createSession` / `ensureSubagentSession`）走 `mode: "insert"`，
   * 落库行 = 构造器给出的列 —— 而 `sessionToWire` 里原来**没有** `parent_id`，
   * 于是"带 `parentId` 的实体"建出来的会话行里这一列永远是 NULL：
   * 第 45 轮给子智能体补的 `sessions` 行就是这样，子会话在 `session_trace` 里
   * 永远报 `Parent: (root)`、队长会话报 `Descendants: []`。
   *
   * 显式写 `null` 是合法表达（"根会话"），所以用 `?? null` 而不是省略键；
   * 在 `replace` 路径上，这一列也是"显式 null 才能清空"。
   *
   * ⚠️ 本注释初版声称"改名 / 置顶 / 拖拽排序会把谱系清空" —— **错的**，
   * 详见 `src/core/types.ts` 里 `parentId` 字段上的更正记录（连同那条结论的成因：
   * 假端口比引擎更严格）。
   */
  parent_id: s.parentId ?? null,
  };
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  model: string | null;
  created_at: number;
  last_message_at: number;
  message_count: number;
  pinned: number;
  execution_mode?: string | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
  correction_mode?: number | null;
  deep_thinking_mode?: number | null;
  preserve_executor?: number | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    pinned: row.pinned === 1,
    executionMode: (row.execution_mode as Session["executionMode"]) ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
    correctionMode: row.correction_mode ?? undefined,
    deepThinkingMode: row.deep_thinking_mode ?? undefined,
    preserveExecutor: row.preserve_executor ?? undefined,
  };
}

function rowToSessionFromAny(row: any[]): Session {
  return rowToSession({
    id: row[0] as string,
    project_id: row[1] as string,
    title: row[2] as string,
    model: row[3] as string | null,
    created_at: row[4] as number,
    last_message_at: row[5] as number,
    message_count: row[6] as number,
    pinned: row[7] as number,
    correction_mode: row[8] as number | null,
    deep_thinking_mode: row[9] as number | null,
    preserve_executor: row[10] as number | null,
    execution_mode: row[11] as string | null,
    worktree_path: row[12] as string | null,
    worktree_branch: row[13] as string | null,
  });
}


export function listSessions(projectId: string): Session[] {
  const rust = domainReadMany(SESSION_TABLE, wireToSession, { project_id: projectId });
  if (rust) {
    /**
     * 排序：`pinned DESC, sort_order ASC, last_message_at DESC`（B-6）。
     *
     * 旧 SQL 是 `ORDER BY pinned DESC, last_message_at DESC`（端口化之后由这里承担）。
     * 第一段（`pinned DESC`）语义不变，**新增的只是中间那段 `sort_order ASC`**。
     *
     * ## 为什么必须让 `sort_order` 参与
     *
     * 它原来是"写了没人读"：`reorderSessions` 老老实实写 `sort_order`，
     * 而这里只按 `pinned` + `last_message_at` 排 —— 拖拽之后**下一次 list 就弹回原位**，
     * 交互等于纯装饰。UI 既然已经暴露了拖拽（`Sidebar.tsx`），写点就不能是假的。
     *
     * ## `?? Number.MAX_SAFE_INTEGER` 的语义（这是"默认值"的关键）
     *
     * 从未拖拽过的会话 `sort_order` 是 NULL。绝**不能**用 `?? 0`：那会让它们全部排到
     * 已拖拽会话（0、1、2…）**前面**，于是"用户刚拖过的顺序"被一堆没拖过的会话顶下去 ——
     * 比不排序还糟。给一个"最大"值，等价于"全都跟在有排序键的会话后面"，
     * 组内再按 `last_message_at DESC` → **默认就是时间序**（与拖拽前完全一致）。
     */
    return rust.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const oa = sessionSortOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const ob = sessionSortOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return b.lastMessageAt - a.lastMessageAt;
    });
  }
  return []; // 第 17 轮（L4）：旧库回退（ORDER BY pinned/last_message_at）已删 —— 空结果
}

export function getSession(id: string): Session | null {
  const rust = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rust !== undefined) return rust;
  return null; // 第 17 轮（L4）：旧库回退已删 —— 镜像未就绪就是"查不到"（端口就绪后会重读）
}

/**
 * 读一个会话，**保留三态**（第 47 轮补）。
 *
 * ## 为什么 `getSession` 的二态在这里不够（一个会毁数据的收敛）
 *
 * `domainReadOne` 本来就分得清两件事：
 * - `undefined` = **端口/镜像没接手**（未注册 / 加载中 / 超上限被拒 / 从未请求）；
 * - `null` = **确实没有这一行**（查到了，就是不存在）。
 *
 * 而 `getSession` 把两者都返回 `null`（见它上面那行注释，那个收敛对绝大多数调用方是对的：
 * 读不到就是读不到）。但对「恢复上次打开的会话」这条路，把两者混起来是**有破坏性的**：
 * 恢复逻辑会认定"会话已被删除"，然后**把用户的上次会话键清成 null**，
 * 而调用点用了一次性闸门 —— **一次误判之后就再也不会重试**。
 * 于是"镜像还没加载完"这一个瞬间，会永久抹掉用户的"上次打开的会话"。
 *
 * 这个窗口是真实存在的，仓库里已有物证：`App.tsx` 的启动补丁记录的
 * `[Store] loadFromDB: found 0 projects` →（端口/镜像就绪后重读）`found 1` 就是同一个窗口。
 *
 * 所以这条路径不再用压平过的 `getSession`，而是显式问出状态。**判据仍然是
 * "从库里读得回来"**，只是"读不到"不再被当成"不存在"。
 */
export type SessionReadState =
  | { kind: "found"; session: Session }
  | { kind: "missing" }
  | { kind: "unavailable" };

export function getSessionState(id: string): SessionReadState {
  const rust = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rust === undefined) return { kind: "unavailable" };
  return rust === null ? { kind: "missing" } : { kind: "found", session: rust };
}

export function createSession(session: Session): void {
  if (domainWrite(SESSION_TABLE, [sessionToWire(session)], { scope: "session.create", note: "会话未保存" })) {
    return;
  }
  // 第 17 轮（L4）：旧库回退（`tryGetDatabase()` + 旧 INSERT + persistDatabase）已删。
  // B 态（端口已注册、镜像未接手）**必须如实上报** —— 静默 return 就是"会话没保存"
  // 却让调用方以为成功（`createSession` 的契约是 void，上报是唯一可见通道）。
  reportWriteNotAccepted("session.create", "会话未保存");
}

export function updateSession(id: string, update: Partial<Session>): void {
  const hasAnyField =
    update.title !== undefined || update.model !== undefined || update.lastMessageAt !== undefined ||
    update.messageCount !== undefined || update.pinned !== undefined || update.executionMode !== undefined ||
    update.worktreePath !== undefined || update.worktreeBranch !== undefined ||
    update.correctionMode !== undefined || update.deepThinkingMode !== undefined ||
    update.preserveExecutor !== undefined;
  if (!hasAnyField) return;

  // 迁移期：读出整行 → 应用改动 → 整体写回（未改动列必须保留）
  const rustCurrent = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rustCurrent !== undefined) {
    if (!rustCurrent) return; // 会话不存在：旧实现是 UPDATE 影响 0 行
    const next: Session = {
      ...rustCurrent,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.model !== undefined ? { model: update.model ?? undefined } : {}),
      ...(update.lastMessageAt !== undefined ? { lastMessageAt: update.lastMessageAt } : {}),
      ...(update.messageCount !== undefined ? { messageCount: update.messageCount } : {}),
      ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
      ...(update.executionMode !== undefined ? { executionMode: update.executionMode ?? undefined } : {}),
      ...(update.worktreePath !== undefined ? { worktreePath: update.worktreePath ?? undefined } : {}),
      ...(update.worktreeBranch !== undefined ? { worktreeBranch: update.worktreeBranch ?? undefined } : {}),
      ...(update.correctionMode !== undefined ? { correctionMode: update.correctionMode ?? undefined } : {}),
      ...(update.deepThinkingMode !== undefined ? { deepThinkingMode: update.deepThinkingMode ?? undefined } : {}),
      ...(update.preserveExecutor !== undefined ? { preserveExecutor: update.preserveExecutor ?? undefined } : {}),
    };
    domainWrite(SESSION_TABLE, [
      /**
       * ## `message_count` 不写回（第 45 轮线协议审计 P1-2）
       *
       * 这一列在引擎侧是**由消息写入自动维护**的（`repo.rs::bump_session_message_count`，
       * 注释里写着"引擎是唯一写入者"），而渲染侧的镜像行是**启动时读进来的快照** ——
       * 引擎后来增减的计数**从不回流到镜像**。
       *
       * 于是"读出整行 → 改标题 → 整体 replace 写回"会把镜像里那个**陈旧**的计数写回去：
       * 用户重命名一次会话，侧边栏的条数就退回启动那一刻的值，而 12 小时一次的
       * 计数对账（`maintenance.ts`，写的是索引真值）随后又会把它改回来 ——
       * 两个机制互相打架，用户看到的是数字自己跳。
       *
       * 修法：**只在这一列没有被调用方显式给出时不写它**（`crud.upsert` 的 replace 语义
       * 只写传入列，于是引擎的值保持不动）。显式给出时必须照写 ——
       * `maintenance.ts` 的对账与 `NotebookWorkspace` 的计数都是**有意**在写它。
       */
      update.messageCount === undefined
        ? (() => {
            const wire = sessionToWire(next);
            delete wire.message_count;
            return wire;
          })()
        : sessionToWire(next),
    ], {
      mode: "replace",
      scope: "session.update",
      note: "会话未更新（会话不存在或写入失败）",
    });
    return;
  }

  // 第 17 轮（L4）：旧库回退（`tryGetDatabase()` + 动态拼 SQL + `runGuarded` + persistDatabase）已删。
  // B 态如实上报：契约是 void，调用方只能靠上报判断"这次更新没落地"。
  reportWriteNotAccepted("session.update", "会话未更新（会话不存在或写入失败）");
}

/**
 * 删除一个会话。
 *
 * ## `confirmBulk` 是什么（第 32 轮）
 *
 * 删 1 个会话会**级联**删掉它的全部消息 / 工具调用 / 事件 —— 实测事故里
 * "删 2 个会话"带走了 821 条消息 + 883 个工具调用 + 2131 条事件，
 * 而调用参数里完全看不出这个规模。Rust 侧因此加了闸门：
 * 受保护表上单次删除（含级联）超过 50 行必须显式 `confirm_bulk: true`。
 *
 * 用户点"删除会话"是明确的破坏性意图，所以 UI 路径传 `confirmBulk: true`；
 * 而**任何非交互路径**（自动清理、对账、修复）都不该传 —— 那正是闸门要拦的。
 *
 * ## B-1：删除必须**同时写会话墓碑**（否则索引重建会把整批会话复活）
 *
 * 缺陷机制（已核实）：
 * 1. 这里只删 `sessions` 那一行（Rust 侧按外键级联删消息等）；
 * 2. 权威 JSONL 日志**一个字节没动**（这是对的，见 `deleteSessionLog` 的注释：
 *    日志删了不可恢复，删除要靠墓碑表达）；
 * 3. 但 `rebuildIndexFromSessionLogs` 的输入清单来自**磁盘上的 JSONL 文件**
 *    （`listSessionLogs()`），Rust 侧 `messages_rebuild_index` 对 `sessions`
 *    又是**无条件 upsert**、不看任何"已删除"标记；
 * 4. ⇒ 索引一旦需要重建（损坏自动恢复、写过重建标记），**用户删掉的会话整批回来**。
 *
 * 修法：删除会话时往**它自己的日志**里追加一条会话墓碑（`appendSessionTombstone`），
 * 重建时读墓碑并跳过（跳过要如实计数并上报，见 `rebuildIndexFromSessionLogs` 的
 * `skippedDeleted`）。墓碑与消息墓碑同处一文件、同一种格式 —— 只有一份真相。
 *
 * ⚠️ 顺序：**先写墓碑、再删行**。
 * - 先写墓碑：即使随后的删除失败（网络/引擎报错），后果是"会话被标记为已删但行还在"
 *   —— 用户还能看到它（可重试删除），数据没丢；
 * - 反过来先删行再写墓碑：万一墓碑写失败，重建就会把会话复活，且**没有任何痕迹**表明
 *   用户删过它。两害相权，前者是"多留一条待清理的记录"，后者是"删除被静默撤销"。
 */
export function deleteSession(id: string, opts: { confirmBulk?: boolean } = {}): void {
  /**
   * 墓碑是 fire-and-forget（`appendSessionTombstone` 内部自己吞异常并告警）：
   * 删除路径不该因为一次文件写入失败而卡住 —— 日志写入失败会留下
   * `[SessionJSONL] 追加会话墓碑失败` 的告警，而删除本身照常进行。
   */
  void appendSessionTombstone(id);
  if (
    domainDelete(SESSION_TABLE, { id }, {
      scope: "session.delete",
      note: "会话未删除",
      confirmBulk: opts.confirmBulk,
    })
  ) {
    /*
     * ## 第 63 轮：删除成功后**释放该会话的日志正文镜像**（内存预算的唯一生产时机）
     *
     * 为什么必须是"删除成功之后"：`deleteSession` 失败时那会话还在，
     * "它可能被读"这个前提没有消失 —— 那时释放只会制造一次"非空但不完整"的读
     * （被索引裁剪的历史只在日志那一侧，见 `message.ts::cachedLogMessages` 的实测数字：
     * 本机真库某个会话 657 行里有 157 行只读得到于日志），
     * 而 `store.loadMessages` 只在结果**为空**时才重新 hydrate，界面上不会有任何提示。
     *
     * 为什么这个时机安全：会话行已删（外键级联删掉消息行），
     * 这个 id 再也不会被任何用户面读路径合法地读 —— 于是"清理会不会打断正在被 UI 读的会话"
     * 这个问题**不需要回答**（存储层也答不了：它没有"当前会话"的概念）。
     * 反过来，不释放会让这份镜像继续供 `listMessages` 读出**一段已经不存在的历史**
     * （日志文件按设计不动、只留会话墓碑）。
     *
     * 覆盖范围：UI 删除（`core/store.ts::deleteSession`）与"删项目"级联
     * （`core/store.ts:144` 的循环）都走这个函数，所以两条路都在。
     */
    releaseSessionLogCache(id, "会话已删除");
    return;
  }
  // 第 17 轮（L4）：旧库回退（`DELETE FROM sessions` + persistDatabase）已删 → 如实上报。
  reportWriteNotAccepted("session.delete", "会话未删除");
}

/** Atomically toggle the pinned state of a session */
export function togglePinned(id: string): boolean {
  const rustRow = domainReadOne(SESSION_TABLE, { id }, wireToSession);
  if (rustRow !== undefined) {
    if (!rustRow) return false; // 会话不存在
    const nextPinned = !rustRow.pinned;
    domainWrite(SESSION_TABLE, [sessionToWire({ ...rustRow, pinned: nextPinned })], {
      mode: "replace",
      scope: "session.togglePinned",
      note: "会话置顶状态未更新",
    });
    return nextPinned;
  }
  // 第 17 轮（L4）：旧库回退（SELECT pinned → UPDATE → persistDatabase）已删。
  // 返回 `false` 即"没有切换成功"，与旧实现 `if (!db) return false` 同义 ——
  // 这里**不上报**是刻意的：`boolean` 返回值本身就是调用方可见的如实回绝
  // （与 `fileChange.updateStatus` 返回 0 同理，见 L3-DELETION-PLAN.md 第 17 轮）。
  return false;
}

function searchSessions(query: string): Session[] {
  const rust = domainReadMany(SESSION_TABLE, wireToSession);
  if (rust) {
    const q = query.toLowerCase();
    return rust
      .filter((s) => !s.projectId.startsWith("notebook:") && s.title.toLowerCase().includes(q))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, 50);
  }
  return []; // 第 17 轮（L4）：旧库回退（LIKE 查询）已删 —— 镜像未就绪 → 诚实的空结果
}

/**
 * R3-2.2: Fork 一个会话 —— 建一个子会话，`parent_id` 指向源会话。
 *
 * ## 这个入口为什么必须存在（B-7：`parent_id` 全仓零调用者）
 *
 * `session_trace` 的谱系功能（`Parent: …` / `Ancestors: […]`）读的就是 `parent_id`，
 * 而全仓**唯一**写这一列的地方就是这里。UI 上真正的 fork 是内联在 `App.tsx` 里的
 * （不走这个函数），那条路径**不写 `parent_id`** —— 于是谱系功能永远只报
 * `Parent: (root)` / `Ancestors: []`：数据模型有它、读侧有它，只有写侧没人用。
 *
 * 修法（本文件内能做的部分）：把这个入口修成"能被 UI 直接调用的最小入口"——
 * 确认它真的写 `parent_id`、参数全都用到（原来 `title` 是可选的、
 * `projectId` 只写进子行），并把用法写清楚（见报告里给 `App.tsx` 的最小改法）。
 *
 * ## 契约（调用方需要知道的三件事）
 *
 * 1. **子会话的会话级字段由源会话继承**（`model` / `executionMode` / `worktreePath` /
 *    `worktreeBranch` / `correctionMode` / `deepThinkingMode` / `preserveExecutor`）——
 *    第 45 轮修正：原来只继承 `model`，其余四列被 `sessionToWire` 显式写成 `null`，
 *    于是"分叉后深度思考/纠错模式悄悄关了"（功能上下文审计 P1-D3）；
 * 2. **子会话的消息由调用方复制**（`core/store.ts` 走 `MessageStorage.copyMessageToSession`）；
 *    这里**不再复制事件日志**（第 45 轮修正，见下面 `parent_id` 写入处的说明）；
 * 3. **源会话不存在 / 自 fork / 落库失败 → 返回 `null`**（不造没有父的孤儿会话，
 *    也不在会话行没落地时写任何从属数据）。
 *
 * @param sourceSessionId 父会话
 * @param newSessionId 子会话的新 id（由调用方生成，便于 UI 立刻跳转）
 * @param projectId 子会话所属项目
 * @param title 子会话标题（缺省 `"<父标题> (fork)"`）
 * @returns 建好的子会话；源会话不存在、自 fork 或落库失败时为 `null`
 */
export function forkSession(
  sourceSessionId: string,
  newSessionId: string,
  projectId: string,
  title?: string,
): Session | null {
  const source = getSession(sourceSessionId);
  if (!source) return null;
  // 自己 fork 自己没有意义，且会让谱系变成自环（`session_trace` 的 Ancestors 会绕圈）
  if (newSessionId === sourceSessionId) return null;

  const now = Date.now();
  const child: Session = {
    id: newSessionId,
    projectId,
    title: title || `${source.title} (fork)`,
    model: source.model,
    createdAt: now,
    lastMessageAt: now,
    messageCount: source.messageCount,
    pinned: false,
    /**
     * 谱系（第 54 轮）：分叉的**本体**就是"子会话指向源会话"。
     *
     * 原来这一列靠在写行时手工塞进去（`{ ...sessionToWire(child), parent_id: source }`），
     * 于是"谁能写谱系"取决于每条路径各自记不记得塞 —— 漏一条（第 47 轮查出的回退路径）
     * 就是静默丢谱系。现在它是 `Session` 的字段、由 `sessionToWire` 统一写，写侧只有一种形状。
     *
     * ⚠️ 本注释初版还写了"另外三条 replace 写入（改名 / 置顶 / 拖拽排序）都会把它清成 NULL"
     * —— **错**：`replace` 在引擎里只写本次提供的列、未提供的列保持原值
     * （`crud.rs:412-429` + 引擎用例 `crud_upsert_replace_does_not_cascade_delete_children`），
     * 渲染侧镜像也是合并写（`rust-port.ts:2063`）。更正记录见 `src/core/types.ts` 的 `parentId`。
     */
    parentId: sourceSessionId,
    /**
     * 会话级模式字段**必须继承**（第 45 轮功能上下文审计 P1-D3）。
     *
     * `sessionToWire` 对这些列显式写 `?? null`（第 19 行附近的说明：显式写 null 才能清空列），
     * 所以"这里不带"就等于"分叉把用户选过的模式全清掉"。用户可见的形态是
     * "分叉后深度思考/纠错模式悄悄关了"，而没有任何提示。
     *
     * `worktreePath` 也一起继承：源会话在 worktree 里跑时，子会话继续用同一个工作区
     * （由调用方按目标项目再决定是否新建 worktree，见 `core/store.ts` 的 forkSession）。
     */
    executionMode: source.executionMode,
    worktreePath: source.worktreePath,
    worktreeBranch: source.worktreeBranch,
    correctionMode: source.correctionMode,
    deepThinkingMode: source.deepThinkingMode,
    preserveExecutor: source.preserveExecutor,
  };

  // Create the child session row with parent_id。
  // 走端口：`parent_id` 与 `sort_order` 都是 ALTER 加的列，整行写回时**显式带上**
  // （`parent_id` 漏了就没有谱系；`sort_order` 漏了在这一列上倒不会丢 ——
  //  `replace` 只写提供的列 —— 但构造器写全整行才谈得上"读写同一个形状"，
  //  详见 `sessionToWire` 里那两段更正过的注释）。
  //
  /**
   * ## ⚠️ 第 47 轮补（功能上下文审计 P1）：必须显式 `mode: "replace"`
   *
   * `domainWrite` 的缺省 mode 是 **`"insert"`**（`domain-store.ts` 的
   * `const mode = opts.mode ?? "insert"`），而引擎侧只有 `mode === "replace"` 才走
   * "先 UPDATE、0 行才 INSERT" 那条路（`crud.rs`）；`"insert"` 就是一条**裸 INSERT**。
   *
   * 于是"编辑并回退"这条路**从来没写进过 `parent_id`**：调用方
   * （`App.tsx::handleEditAndRewind`）先 `createSession()`（已经 INSERT 了那一行），
   * 再调这里 → 裸 INSERT 撞主键 → 整笔写失败 → 谱系丢失。
   *
   * 更糟的是它以**假成功**的形式呈现：`persistWriteThrough` 会先把行应用到本地镜像，
   * 失败只走旁路上报，而 `domainWrite` 照样返回 `true` —— 于是 `session_trace`
   * （读的正是镜像）在整个进程内都报得出父子关系，**重启之后又变回 `Parent: (root)`**。
   * 调用点那句注释"会话行走 upsert，重复写是幂等的"是**错的**。
   *
   * 分叉路径（`core/store.ts::forkSession`）之所以没踩到，是因为它先 fork 再写别的字段；
   * 而回退路径是"先建行、再补谱系"。显式 `replace` 让两条路都成立（且幂等）。
   */
  if (
    domainWrite(
      SESSION_TABLE,
      [{ ...sessionToWire(child), sort_order: null }],
      // `mode: "replace"` = 引擎侧"UPDATE 命中就更新、否则 INSERT"，重复写安全
      { scope: "session.fork", note: "fork 出的会话未保存", mode: "replace" },
    )
  ) {
    /**
     * ## 为什么**不再**复制事件日志（第 45 轮功能上下文审计 P2-D6）
     *
     * 原来这里调 `getEventLog().forkSession(sourceSessionId, newSessionId)`，把源会话的
     * `session_events` **整段原样复制**（引擎侧 `INSERT … SELECT` 连 payload 一起抄）。
     * 而子会话的消息是**新 id**（`core/store.ts` 的复制循环给每条消息、每个工具调用换了 id）——
     * 于是子会话的事件里 `payload.messageId` / `toolCallId` 全是**源会话**的 id，
     * 一条都对不上子会话的消息表。投影会为这些孤儿 id 凭空造出 `content: ""` 的
     * assistant 行与 `tool-result-*` 行（`event-projection.ts:252–307`），
     * 而 `session_meta`（如 `feedback_record`）这类会话级事件被抄过来后，
     * 子会话里会**凭空出现源会话的反馈条目**（`feedback.ts:87` 按 session_id 过滤）。
     *
     * "复制事件"和"复制消息"只能留一个（两者各做一半、主键还对不上，是比全不做更糟的状态）。
     * 这里选**后者**：子会话的消息表是唯一来源，事件由**消息自己的写入**产生 ——
     * `MessageStorage.createMessage` 会为每条复制过来的消息写 `user_message` /
     * `assistant_text`（`appendMessageTextEvent`），id 天然是子会话的新 id，主键必然一致。
     * 工具调用的事件由 `tool-pipeline` 在**真正执行**时写（一个事实一个写入者），
     * 所以复制来的历史工具调用在子会话里没有对应事件 —— 这是刻意的取舍：
     * 宁可"少一段历史工具事件"，也不要"一堆指向不存在消息的事件"。
     *
     * `parent_id` 与子会话行本身不受影响（谱系功能仍然成立）。
     */
    return child;
  }

  // 第 17 轮（L4）：旧库回退（INSERT 子会话 + persistDatabase）已删。
  // ⚠️ 这里**没有**沿用"回退旧库时也照做 forkSession"的旧行为：会话行都没落地，
  // 再去复制事件日志只会造出"有事件、没有会话行"的孤儿数据 —— 如实上报后返回 null。
  reportWriteNotAccepted("session.fork", "fork 出的会话未保存");
  return null;
}

/** P2 #29: Reorder sessions by a given list of IDs (for drag-and-drop sorting) */
export function reorderSessions(projectId: string, orderedIds: string[]): void {
  // 迁移期：读出这些会话的整行 → 只改 sort_order → 整体写回。
  // 注意**只改 sort_order**（旧实现是 `UPDATE sessions SET sort_order = ? WHERE id = ? AND project_id = ?`），
  // 不要顺手把别的列一起改了。
  const rows = domainReadMany(SESSION_TABLE, wireToSession, { project_id: projectId });
  if (rows) {
    const order = new Map(orderedIds.map((sid, i) => [sid, i]));
    const targets = rows.filter((s) => order.has(s.id));
    if (targets.length > 0) {
      domainWrite(
        SESSION_TABLE,
        targets.map((s) => {
          const wire = sessionToWire(s);
          wire.sort_order = order.get(s.id);
          return wire;
        }),
        { mode: "replace", scope: "session.reorder", note: "会话顺序未保存" },
      );
    }
    return;
  }

  // 第 17 轮（L4）：旧库回退（逐条 UPDATE sort_order + persistDatabase）已删 → 如实上报。
  // 契约是 void，调用方只能靠上报判断"这次排序没落地"。
  reportWriteNotAccepted("session.reorder", "会话顺序未保存");
}
