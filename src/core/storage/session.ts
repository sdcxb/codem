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
  // 第 189 轮：内部会话标记（子智能体轨迹）。老库/未迁移时该列为 undefined → 当 false。
  isInternal: Number(row.is_internal ?? 0) === 1,
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
  /**
   * 第 189 轮：`is_internal` 也必须一起写回 —— 与上面 `parent_id` 同一个道理
   * （建行路径走 `mode: "insert"`，构造器漏列 = 落库静默丢值）。
   * 显式写 0/1 而不是省略键：`replace` 路径上只有显式值才能改这一列。
   */
  is_internal: s.isInternal ? 1 : 0,
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


/**
 * 旧版本写子智能体会话行的两种**可机检形态**（都是旧代码自己写下的，不是"长得像"的推测）：
 *   · id：`sub-<13 位时间戳>-<9 位随机>`
 *     （`subagent/spawn-in-process-provider.ts` 与 `subagent/runtime.ts` 的生成式）
 *   · 标题：`子智能体 <id>`（`subagent/subagent-session.ts::childTitle()` 写死的前缀）
 */
const SUBAGENT_SESSION_ID = /^sub-\d+-[a-z0-9]+$/;
const SUBAGENT_SESSION_TITLE = /^子智能体\s/;

function looksLikeLegacySubagentSession(s: Pick<Session, "id" | "title">): boolean {
  return SUBAGENT_SESSION_ID.test(s.id) || SUBAGENT_SESSION_TITLE.test(String(s.title ?? ""));
}

/**
 * 这个会话**是不是内部轨迹**（而不是用户眼里的对话目录）。
 *
 * ## 判据1：表里的显式列 `is_internal`（第 189 轮起，新数据都带）
 *
 * ## 判据2：**旧数据的形态兜底**（第 191 轮补）
 *
 * ⚠️ 这段注释里要留一条**判断错误**的记录：第 190 轮我在**自己这台机器**上查了库，
 * 看到 `sub-%` 是 0 行、磁盘上 16 个 `sessions/*.jsonl` 没有对应行，于是写下
 * 「老数据里根本没有子智能体会话条目，这个前提不成立」。
 * **用户当场纠正：「我是再另一个电脑里安装后测试的，你不要这么机械！」**
 * ——他是在**另一台机器**上测的，那台上子智能体会话**确实写进了 `sessions` 表**、
 * 也确实出现在侧栏；而 `is_internal` 是 189 轮才加的列，那些老行是 0。
 * **拿一台机器的读数去否定另一台机器上的现象，是无效推断。**
 *
 * ## 第 193 轮补的判据3：**委派任务会话**（跨对话交接产生的中间任务）
 *
 * 用户现场：「左侧栏里有个全局对话 [DELEGATED TASK] 内容是【交接：项目 1.4.2.5 → 课题3 会话】…
 * 是做跨对话交接的时候产生的，这种中间任务应该也不显示在对话目录中吧？」
 *
 * ### ⚠️ 第一版判据写错了 —— 是本机真库取证当场纠正的
 *
 * 我原先要求「`delegation_tasks.task` 里有一条带 `[DELEGATED TASK]` 前缀的记录」。
 * 真库一读就露馅（`_audit-193-delegation-sessions.mjs`）：**8 条真实委派记录的正文开头
 * 全是 `【会话交接】…`**（那是模型按 `HANDOVER_TEMPLATE` 写的**原文**）；
 * `[DELEGATED TASK] ` 是 `executor.ts` 在**注入消息**时才加的
 * （`content: prefix + message + receiverNote`），**从不写回 `task` 列**。
 * ⇒ 那条判据**永远匹配不到任何东西** —— 等于上线一个静默失效的功能。
 * 这就是"单测全绿也看不出来、真机一读就穿"的那类错误：
 * **判据必须落在真实存在的数据上，而不是我以为存在的数据上。**
 *
 * ### 改后的判据：只看**消息**（那个前缀真正所在的地方）
 *   1. 这个会话里**有**机器注入的 user 消息（以 `[DELEGATED TASK] ` 开头），**且**
 *   2. **没有任何一条人打的 user 消息**（非空、且不以该前缀开头）
 *
 * 第 1 条证明"委派任务确实被注入过这个会话"（前缀用户不可能手打）；
 * 第 2 条是**防误伤**：用户只要在里面说过一句自己的话，就永远不会被自动隐藏。
 * 两条一起，落到的正是用户说的那类"跨对话交接产生的中间任务"。
 *
 * ### 为什么渲染期的 `isChildSession` 里只留判据1/2
 * 这条判据要读该会话的消息（DB 读），**不能**放进每次渲染都会跑的 `isChildSession` 里。
 * 所以它是**回填时**判定一次、落成 `is_internal` 列（见 `backfillInternalSessions` 的
 * `isDelegationArtifact` 参数），渲染期照旧只读列。
 *
 * ## 两条被否掉的判据（免得第三个人再走一遍）
 *
 * 1. **按 `parentId` 一刀切**：`parent_id` 有三处写（分叉 / 编辑并回退 / 子智能体建行），
 *    一刀切会**连带滤掉分叉会话**，而分叉是用户真会切回去继续聊的对话 ——
 *    `FIXB-7d` 当场把那一版判红（它是对的）。
 * 2. **裸的"出现在 `delegation_tasks` 里"**：`delegate_to_session` 的目标是**已存在的会话**，
 *    用户确实会把任务委派给**自己的对话**（真机 5 条委派关系里有一条目标会话首条用户消息是
 *    「我们正在对标 codex 开发本项目…」，那是人打的）⇒ 单凭它会把用户的对话判进去。
 */
export function isChildSession(s: Pick<Session, "isInternal" | "id" | "title">): boolean {
  if (s.isInternal === true || s.isInternal === 1) return true;
  /* 老数据兜底：`is_internal` 对 189 之前建的行是 0，只能靠"旧代码写下的 id/标题"认。
     这不是重新启用"按 id 猜"——那是**迁移期**的兜底；回填之后（见 `backfillInternalSessions`）
     这些行也会带上列，判据1 就足够了。两条都留着是为了"还没回填完"的那段时间也不漏。 */
  return looksLikeLegacySubagentSession(s);
}

/**
 * 委派任务注入目标会话时，由 `session/executor.ts` 加在 user 消息前面的机器前缀。
 *
 * 放在这里导出是为了**判据与写入点共用一个常量** —— 两处各写一遍字符串，
 * 将来改前缀时必然漏一处，而漏的那一处表现是"回填静默失效"（最难查的那种）。
 */
export const DELEGATED_TASK_PREFIX = "[DELEGATED TASK] ";

/**
 * 这个会话是不是**纯委派任务产物**（可以安全地不进对话目录）。
 *
 * **两条必须同时成立**（理由见 `isChildSession` 的长注释）：
 *   1. 这个会话里**有**机器注入的 user 消息（以 `[DELEGATED TASK] ` 开头）
 *   2. **没有任何一条人打的 user 消息**
 *
 * ⚠️ **注意参数只有"消息"一份**：第一版曾要求"委派表里有带前缀的记录"，
 * 而真库证明那个前缀**从不写进 `delegation_tasks.task`**（只加在注入的消息上）——
 * 那条判据永远匹配不到东西。现在只认消息，因为它才是前缀真正所在的地方。
 *
 * @param userMessages 该会话的 user 消息正文（**只取 user 角色**；调用方从消息表取）
 */
export function isDelegationArtifact(userMessages: readonly string[]): boolean {
  /* 判据1：必须有一条**机器注入**的消息。前缀由 `executor.ts` 加，用户不可能手打。 */
  const injected = userMessages.filter(
    (m) => typeof m === "string" && m.startsWith(DELEGATED_TASK_PREFIX),
  );
  if (injected.length === 0) return false;
  /* 判据2：**一条人打的用户消息都不能有**（防误伤）。
     空白消息不算"人打的"——否则敲个空格就能逃过收纳。 */
  const humanMessages = userMessages.filter(
    (m) => typeof m === "string" && m.trim().length > 0 && !m.startsWith(DELEGATED_TASK_PREFIX),
  );
  return humanMessages.length === 0;
}


/**
 * **一次性回填**：把老数据里能确认是子智能体轨迹的会话标上 `is_internal = 1`。
 *
 * ## 为什么要有它（用户的真实处境）
 *
 * 用户原话：「左侧栏里，原有聊天产生的子智能体对话还是在目录里没被收纳」
 * ＋ 纠正：「我是再另一个电脑里安装后测试的」。
 * ⇒ **他那台机器上，旧版本真的把子智能体会话写进了 `sessions` 表**，于是它们出现在侧栏；
 * 而 `is_internal` 是 189 轮才加的列，那些老行是 0，列表过滤对它们无效。
 *
 * ## 只认"旧代码写下的形态"（两种，见 `looksLikeLegacySubagentSession`）
 *
 * 不做更"聪明"的推测（理由见 `isChildSession` 注释里被否掉的第 2 条）。
 *
 * ## 第 193 轮：多了一类候选 —— **纯委派任务会话**
 *
 * 判据由调用方注入（`isDelegationArtifact`），因为它要查委派表 + 该会话的消息，
 * 这两样都不属于本模块。**默认不注入 ⇒ 行为与第 191 轮完全一致**（不改变既有测试与调用方）。
 *
 * ## 幂等 + 可逆 + 有读数
 *
 * · 只改 `is_internal` 为空/0 **且**判据成立的行；标过的不会再动 ⇒ 可重复调用；
 * · 返回**本次新标记的条数**，调用方据此决定要不要告诉用户（0 就什么都不用说）；
 * · 撤销走 `set_session_internal(session_id, false)`，不删任何数据。
 *
 * @param sessions 候选集合（由调用方按项目取，便于逐个项目跑，也便于测试注入）
 * @param mark     真正的写入函数（默认 `updateSession`；测试可注入以观察/构造失败）
 * @param isDelegationArtifact 可选：判断某会话是否是"纯委派任务产物"
 *        （不传 ⇒ 只按子智能体形态回填，与 191 轮同）
 * @returns        本次新标记的条数
 */
export function backfillInternalSessions(
  sessions: Array<Pick<Session, "id" | "title" | "isInternal">>,
  mark: (id: string) => void = (id) => updateSession(id, { isInternal: true }),
  isDelegationArtifact?: (sessionId: string) => boolean,
): number {
  let marked = 0;
  for (const s of sessions) {
    if (s.isInternal === true || s.isInternal === 1) continue; // 已经是内部会话
    /**
     * 两条判据是**或**的关系：命中任一条就标。
     * `isDelegationArtifact` 的调用包在 try 里 —— 它要读库，读失败时**不能**
     * 让"这一条"把整批带崩（更糟的是：读失败若被当成 `true`，就会误伤真对话）。
     * 所以异常一律按 `false`（不标）处理，宁可漏判。
     */
    let byShape = looksLikeLegacySubagentSession(s);
    if (!byShape && isDelegationArtifact) {
      try {
        byShape = isDelegationArtifact(s.id) === true;
      } catch {
        byShape = false;
      }
    }
    if (!byShape) continue;                                    // 判据不成立：**绝不动**
    try {
      mark(s.id);
      marked++;
    } catch {
      /* 单条失败不打断整批（能改多少改多少；失败由调用方按返回值汇总上报） */
    }
  }
  return marked;
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
     *
     * ⚠️ 第 188 轮：**子会话（子智能体轨迹 / 分叉副本）不进这个列表** ——
     * 见上面 `isChildSession` 的长注释。过滤放在这里（而不是侧栏里）的理由：
     * 用户的诉求是"不作为单独的对话目录"，也就是**任何把会话当目录列的地方**都不该出现它们；
     * 逐个调用点去滤，早晚会漏一处（本仓库已经因为"点名法"漏过好几次）。
     */
    return rust
      .filter((s) => !isChildSession(s))
      .sort((a, b) => {
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

/**
 * `updateSession` 支持的字段（**唯一**白名单来源，第 184 波存储审计 S7/③）。
 *
 * 为什么必须是一份**具名清单**（而不是原来那样内联在 `hasAnyField` 里）：
 * 白名单的失败形态是**静默丢弃** —— "改一个没列进来的字段"不写库、不上报、也没有返回值，
 * 看起来和"改成功了"一模一样。第 190 轮 `isInternal` 就是这么被丢掉的
 * （那次靠工具自己的回读校验才发现）。收成一份之后，未列出的字段才能被**如实看见**（点名到字段）。
 */
const SESSION_UPDATE_FIELDS = [
  "title",
  "model",
  "lastMessageAt",
  "messageCount",
  "pinned",
  "executionMode",
  "worktreePath",
  "worktreeBranch",
  "correctionMode",
  "deepThinkingMode",
  "preserveExecutor",
  "isInternal",
] as const;

export function updateSession(id: string, update: Partial<Session>): void {
  /**
   * ⚠️ 这是一个**字段白名单**：没列在 `SESSION_UPDATE_FIELDS` 里的字段会被丢弃。
   *
   * 第 190 轮踩到过：`set_session_internal` 工具调 `updateSession(id, { isInternal })`，
   * 而这里没有 `isInternal` ⇒ 更新被丢掉、库里那一列纹丝不动。
   * 那次是工具自己的**回读校验**当场抓到的（"标记未生效（回读仍是 false）"）——
   * 如果当时只写不验，用户看到的就是"工具说标好了，侧栏里那条还在"。
   * **加字段时这里必须同步**（`sessionToWire` 那边也一样）。
   *
   * ## 第 184 波存储审计 S7/③：**静默丢弃改成可见**
   *
   * "加字段时这里必须同步"是**纪律**（靠人记得），而这个坑已经踩过一次。
   * 现在未列出的字段**当场可见**（一行 warn 点名是哪个字段）—— 不再是一个查无痕迹的 no-op。
   * （`parentId` / `projectId` / `createdAt` 这类"建会话时定下来、之后不该改"的列仍然不支持更新，
   * 但调用方会**知道**自己那次调用被丢了一半。）
   *
   * ⚠️ 刻意**走日志、不走横幅**（`reportActionFailure`）：这是**调用方写错了字段名**
   * （开发者问题），用户没有任何可介入的动作 —— 按本仓库第 50 波的规则
   * （「用户没有可介入动作的发现不许进任何上报通道」），它只该进日志。
   */
  const given = Object.keys(update as Record<string, unknown>).filter(
    (k) => (update as Record<string, unknown>)[k] !== undefined,
  );
  const known = new Set<string>(SESSION_UPDATE_FIELDS);
  const unsupported = given.filter((k) => !known.has(k));
  if (unsupported.length > 0) {
    console.warn(
      `[Session] updateSession(${id}) 丢弃了未在字段白名单里的字段：${unsupported.join("、")}` +
        "（这些字段的更新**没有生效**；加字段时请同步 session.ts 的 SESSION_UPDATE_FIELDS 与 sessionToWire）",
    );
  }
  const hasAnyField = given.some((k) => known.has(k));
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
      /* 第 190 轮：内部标记也要能改（`set_session_internal` 走这条路径） */
      ...(update.isInternal !== undefined ? { isInternal: update.isInternal } : {}),
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
 * - 先写墓碑：即使随后的删除失败（引擎报错 / 那次写被队满或 15s 老化丢弃），后果是
 *   "会话被标记为已删但行还在" —— 用户还能看到它（可重试删除），数据没丢；
 * - 反过来先删行再写墓碑：万一墓碑写失败，重建就会把会话复活，且**没有任何痕迹**表明
 *   用户删过它。两害相权，前者是"多留一条待清理的记录"，后者是"删除被静默撤销"。
 *
 * ## ⚠️ 但"行还在"必须**真的能让墓碑作废**（第 184 波存储审计 S1 的实质缺陷）
 *
 * 上面那段论证成立的前提是**墓碑能被撤销**。而墓碑是 append-only、全仓没有任何撤销入口，
 * 重建路径（`session-log-bridge.ts` 的 `skippedDeleted`）与对账
 * （`maintenance.ts::detectSessionsBehindLog`）又都按"日志里有墓碑 ⇒ 这个会话已被删除"处理。
 * 于是"删除失败/被丢弃"这个形态的后果是：**那个仍然存在的会话被永久跳过** ——
 * 空库恢复（引擎头损坏 → 建空库 → 从 JSONL 重建索引）之后它不会回到 `sessions` 表，
 * 会话从侧栏彻底消失，JSONL 正文变成没有任何读路径会去读的孤儿。
 * 也就是说"数据没丢"这句话在**重建这条路**上不成立。
 *
 * 所以判据补在**读墓碑的那一侧**（`sessionTombstoneBinding`）：
 * `sessions` 镜像里**还有这一行** ⇒ 墓碑作废、照常重建/对账；行确实不在 ⇒ 墓碑成立、跳过。
 * 这样"删除失败不丢会话"与"删除成功不复活会话"才同时成立。
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

/**
 * 会话墓碑**是否仍然成立**（第 184 波存储审计 S1）。
 *
 * ## 为什么必须有这条判据
 *
 * 墓碑（`session-jsonl.ts::appendSessionTombstone`）是 append-only 的，全仓**没有撤销入口**；
 * 而删除路径是"先写墓碑、再删行"，删除可能没成（`domainDelete` 返回 false），
 * 也可能"返回了 true 但那次 `deferWrite` 之后被队满 / 15s 老化丢弃"
 * （`domain-store.ts::deferWrite` / `sweepDeferQueue`）。这两种形态下墓碑已经落盘、
 * `sessions` 行却还在 —— 若重建/对账只按"日志里有墓碑"判，这个**仍然存在的会话**
 * 就会被**永久**跳过（空库恢复后从侧栏彻底消失，JSONL 正文成孤儿）。
 *
 * 所以"墓碑是否成立"必须问**库里现在有没有这一行**，而不是只看日志里出现过什么。
 *
 * ## 三态（不把"读不到"当成"没有"）
 *
 * - `true`  —— 墓碑成立（`sessions` 镜像里确实没有这一行）：重建/对账必须跳过；
 * - `false` —— 墓碑**作废**（镜像里还有这一行 ⇒ 那次删除没成或被丢弃）：照常重建/对账；
 * - `undefined` —— **判不了**（`sessions` 域镜像未就绪）。调用方必须按最保守处理：
 *   仍旧按墓碑跳过（宁可晚一次重建，也不要在"判不了"的时候把用户明确删掉的会话复活）；
 *   而 `sessions` 镜像**就绪且为空**（空库恢复的正常形态）时返回的是 `true`，不是 `undefined`。
 */
export function sessionTombstoneBinding(id: string): boolean | undefined {
  const rows = domainReadMany<Record<string, unknown>>(SESSION_TABLE, (r) => r);
  if (rows === undefined) return undefined;
  return !rows.some((r) => String(r.id ?? "") === id);
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
