/**
 * FileChangeStorage — Per-turn file change tracking persistence
 *
 * Stores git tree snapshots + binary diffs + artifact metadata.
 * Independent from v2_sessions.messages JSON — not affected by context compaction.
 *
 * ## 第 269 波：本表**不再进域镜像** ✗→✓（按需查询 + 有界"一屏" ✓）
 *
 * 用户第二次报障：「表 `turn_file_changes` 超过镜像上限 5000 行。该功能本次不可用」✗。
 *
 * 量清的机制（见 `docs/HANDOFF-NEXT-SESSION.md` §3 ✓）：
 * `bootstrap.ts` 把这张表列进**启动预取清单** ⇒ 启动就整表镜像 ✗；
 * 而它既不在一张一张放宽的 `DOMAIN_MIRROR_ROW_LIMITS` 里 ✗、也没有低上限 ✗
 * ⇒ 吃默认 5000 ✗；`RustDomainMirror.loadTable` 拉满一页发现 `rows.length > cap` 就
 * **拒载**（不是截断 ✗）⇒ `refused.add(table)` + `domain.turn_file_changes.too-large` ✗
 * ⇒ 该域这一段时间读给空结果 ✗。
 *
 * ## 为什么"调 cap" ✗ 与"给它一个放宽值" ✗ 都不是治本
 *
 * 1. 拒载 ⇒ 把 cap 调低只会**更早**拒载 ✗（方向反了）；
 * 2. 这张表是**追加型热表** ✓（每轮每文件若干行 ✓）⇒ 只会越长越多 ✓
 *    ⇒ 任何固定 cap ✗ 迟早复发 ✗；
 * 3. "稍后自动重试"✗ 是**设计行为**⑥ ✓，不是修法 ✗。
 *
 * 结构性依据：`no-sync-mirror-reads.test.ts` 早已把这张表列进
 * **`UNBOUNDED_TABLES`**（无界对象 ✗，不许经同步领域读接口访问 ✗），
 * 而 `file-change-storage.ts` 正好是那份越界清单里**仅剩的三个** ✗。
 * 也就是说：把它留在镜像里，是**在已声明的边界上开一个口子** ✗。
 *
 * ## 现在的模型（与 `notebook_chunks` 同一套 ✓）
 *
 * | 环节 | 做法 |
 * |---|---|
 * | 载入 | **不预取** ✗、**不进镜像** ✗ —— `DOMAIN_QUERY_ONLY_TABLES` 结构性挡掉 ✓ |
 * | 读 | **按需查询** ✓：`crud.list` + `where{会话}` + `order_by turn_index` + 有界 `limit` ✓ |
 * | 投影 | `patch` 正文（单行上限 500,000 字符 ✗）**不进一屏** ✓ —— 回滚时按 id 单独取 ✓ |
 * | 驻留 | 有界 LRU ✓（≤ `WINDOW_SESSIONS` 个会话 × `WINDOW_ROWS` 行 ✓），**只在按需读之后**才有 ✓ |
 * | 同步读 | **只读那份有界投影** ✓（`listBySession` ✓）；没读过就返回 `[]`（不假装 ✓） |
 * | 写/删 | **直达引擎** ✓（`ON_DEMAND_TABLES` ✓），不排队等一个**永远不会就绪**的镜像 ✗ |
 *
 * ⚠️ **本波刻意删掉 `getById()` 这个同步接口** ✗→✓：它原来靠镜像，
 * 而镜像没了之后"同步读一行"只能返回 `null` —— 那就把"**没缓存**"✗
 * 说成了"**这行不存在**"✗（`revert()` 会据此报"记录不存在"✗，
 * 正是 `persist-domain-fixes.test.ts` C7-2 钉的那种假结论 ✗）。
 * 现在改成显式的 `getByIdAsync()` ✓：读不到就是读不到，调用方自己说清是哪一种 ✓。
 */

import { reportPersistFailure } from "./persist-failure";
import { domainDelete, domainWrite } from "./domain-store";
import { getStoragePort } from "./port";

export interface TurnFileChangeRecord {
  id: string;
  session_id: string;
  message_id: string;
  turn_index: number;
  before_tree: string | null;
  after_tree: string | null;
  /**
   * 统一 diff 正文。**按需读窗口里没有它** ✓（见 `WINDOW_COLUMNS`）——
   * 需要正文的调用方按 id 单独取（`FileChangeTracker.revert` ✓）。
   */
  patch?: string | null;
  changed_files: string | null; // JSON [{path, status, before_hash, after_hash}]
  patch_sha256: string | null;
  current_brief: string | null;
  status: "completed" | "reverted" | "pending_review";
  created_at: number;
}

export interface ChangedFile {
  path: string;
  status: string; // M, A, D, R
  before_hash?: string;
  after_hash?: string;
}

const TABLE = "turn_file_changes";

/**
 * **一屏**里最多几行 ✓（界面的真实需要）✗。
 *
 * 判据是"面板/交付物实际会显示多少"✓，不是"表里有多少"✗：
 * `FileChangesList` 列出逐轮记录、`DeliverableFiles` 只看**最新一轮**、
 * `PanelSidebar` 只做**路径去重**✓ —— 三者都不需要整会话 ✓，更不需要整表 ✗。
 *
 * 200 的依据：真机一轮一行到几行 ✓，200 行 ≈ 几十到上百轮 ✓，
 * 已经覆盖"用户往回翻"的合理深度 ✓；而它是**常量** ✓ ⇒ 表再长也不会变多 ✓。
 */
export const TURN_FILE_CHANGE_WINDOW_ROWS = 200;

/**
 * 同时**驻留几个会话**的一屏 ✓。
 *
 * 与 `MIRROR_KEEP_SESSIONS`（3 ✓）同一口径：把"跨会话累计"这个**无界输入端**掐掉 ✓
 * ⇒ 内存上限 = `会话数 × 行数`（常量 ✓），而不是"用户浏览过的历史总量" ✗。
 */
export const TURN_FILE_CHANGE_WINDOW_SESSIONS = 3;

/**
 * **按需查询一屏时请求的列** ✓ —— 与 `DOMAIN_COLUMN_PROJECTION.turn_file_changes`
 * （`rust-port.ts` ✓）**同一份清单** ✓，刻意不含 `patch` ✗。
 *
 * ⚠️ 两处必须一致 ✓：投影清单管"镜像不许整行装载"（这张表已不进镜像 ✓，
 * 但清单留着是因为它同时是**列契约**的声明 ✓），这里管"按需读拉回来的东西" ✓。
 * 不一致的后果是"读回来的行少了列"✗（`rowToRecord` 把缺列读成 `undefined` ✗）
 * —— 因此判据 `TFC-3` 直接按**这份导出清单**核对 ✓，不另写一遍字面量 ✗。
 */
export const TURN_FILE_CHANGE_WINDOW_COLUMNS: readonly string[] = [
  "id",
  "session_id",
  "message_id",
  "turn_index",
  "before_tree",
  "after_tree",
  "changed_files",
  "patch_sha256",
  "current_brief",
  "status",
  "created_at",
];

/**
 * 线协议行 → 记录，**并且在这里再投影一次** ✓（第 269 波 ✓）。
 *
 * ## 为什么客户端还要投一次（引擎侧已经按 `columns` 裁过了 ✗）
 *
 * 因为"一屏**不许**驻留 `patch` 正文"✗ 是本波的核心不变量 ✓（单行上限 500,000 字符 ✗），
 * 而它**不能**只依赖引擎的 `columns` 支持 ✗：
 * - 引擎侧若某天不支持列投影（真机就有过"整行返回"的历史 ✓）、
 *   或某个脚本化的传输层忽略了 `columns` ✓ ⇒ 正文就会**原封不动**进缓存 ✗
 *   ⇒ 几十上百行 × 500KB 全进渲染进程 ✗ —— 那正是本波要消灭的占用 ✓；
 * - 判据 `TFC-4` 量的就是这个形态 ✓（夹具**故意**无视列投影 ✓）：
 *   第一版只在"引擎侧"投影，`TFC-4` 当场把它抓红了 ✓（`patch` 是 5000 个 `X` ✗）。
 *
 * ⇒ 投影是**两层**的 ✓：引擎侧省**传输** ✓、客户端这里保**驻留** ✓（两者都要 ✓）。
 * ⚠️ 只砍 `patch` ✓、**别的列一个都不能少** ✗（`changed_files` / 树对象 / 状态 … 都要 ✓）
 * —— 这正是"不许顺手多砍"✗（判据 `TFC-2` / `TFC-7c` 一起钉 ✓）。
 */
function rowToRecord(row: any): TurnFileChangeRecord {
  const out: Record<string, unknown> = {};
  for (const col of TURN_FILE_CHANGE_WINDOW_COLUMNS) out[col] = (row as Record<string, unknown>)[col];
  out.status = (row as Record<string, unknown>).status || "completed";
  return out as unknown as TurnFileChangeRecord;
}

/** 记录 → 线协议行（列名一致，显式列出以避免把多余字段带进去） */
function recordToWire(r: TurnFileChangeRecord): Record<string, unknown> {
  return {
    id: r.id,
    session_id: r.session_id,
    message_id: r.message_id,
    turn_index: r.turn_index,
    before_tree: r.before_tree,
    after_tree: r.after_tree,
    patch: r.patch,
    changed_files: r.changed_files,
    patch_sha256: r.patch_sha256,
    current_brief: r.current_brief,
    status: r.status,
    created_at: r.created_at,
  };
}

/**
 * 发一条 `crud.list` 并拿回**结构化**结果 ✓。
 *
 * 走 `port.data.command`（`StorageDataPort` 上**已声明为可选** ✓，
 * 与 `self-heal` / `session-log-bridge` / `file-change-tracker` 的既有做法一致 ✓），
 * 没有它才退回 `execute`（两者是同一 dispatch，只是返回值整形不同 ✓）。
 */
async function queryRows(params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  /**
   * ⚠️ **端口没注册 ⇒ 抛** ✗→✓（第 269 波**撤销**了第一版的 `return []` ✗）。
   *
   * 第一版照抄了镜像时代"没接手就给该域的合理空结果"那句 ✓，但这里方向是错的 ✗：
   * `listBySession` 的 `[]` 是**同步读**的合理答案 ✓，而 `loadBySession` 是**按需读** ✓
   * —— 它一旦把"读不到"✗ 也答成 `[]` ✗，调用方就**再也分不出**
   * "这个会话确实没有记录"✓ 与"这次根本没读到"✗ ⇒ 界面又会回到
   * "看起来正常的空面板"✗（那正是本波要治的形态 ✓）。
   * 所以按需读只给**两个**答案 ✓：**行** ✓ 或 **抛** ✓（由调用方如实上报 ✓）。
   */
  const port = getStoragePort();
  const probe = port.data as unknown as {
    command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
  };
  const res = probe.command
    ? await probe.command<{ items?: Array<Record<string, unknown>> }>("crud.list", params)
    : ((await port.data.execute("crud.list", params)) as unknown as {
        items?: Array<Record<string, unknown>>;
      });
  return res?.items ?? [];
}

/**
 * 同一会话的**在途读**去重 ✓。
 *
 * 为什么需要：`FileChangesList` / `DeliverableFiles` / `PanelSidebar` 可能同时挂载 ✓
 * （同一屏里三个消费者 ✓）。没有它，一次切会话会发三份**一模一样的**分页查询 ✗
 * （真机上那是三次跨 IPC 的整表扫描 ✗）。
 * 只在**同一轮微任务/同一段时间内**合并 ✓ —— 请求一落地就从表里摘掉 ✓，
 * 所以"后来再读一次"永远会真的去问引擎 ✓（不会读到一个过期的合并结果 ✗）。
 */
const inFlightLoads = new Map<string, Promise<TurnFileChangeRecord[]>>();

/**
 * **有界的一屏投影缓存** ✓（本波唯一的内存驻留 ✓）。
 *
 * 为什么还留一个同步读 ✓：三个消费方都是 React 渲染路径（`listBySession()` 在
 * `useState` 初始化 / effect 里同步调 ✓）。它们的**真实需要**只是"最近若干轮"✓，
 * 所以正确的形态不是"取消同步读"✗，而是"让同步读**只能**读一份有界投影"✓
 * —— 这正是 `no-sync-mirror-reads.test.ts` 头部写的终局 ✓：
 * 「同步读的正当形式是**领域投影**」✓。
 *
 * ⚠️ 它与镜像的**根本区别**（也是为什么它不违反用户那条"只许变小"的约束 ✓）：
 * - 只有被**显式按需读过**的会话才会进这里 ✓（镜像则"启动就把整表拉进来"✗）；
 * - 每条都**有界** ✓：≤3 个会话 × ≤200 行 × **不含 patch** ✓（镜像 5000 行整表 ✗）；
 * - 淘汰是 LRU ✓（镜像到顶就是**拒载**✗ ⇒ 功能整个不可用 ✗）。
 */
const windowCache = new Map<string, TurnFileChangeRecord[]>();
/** 单调递增的"最近使用"计数（LRU 用；不依赖真实时钟 ⇒ 判据不抖 ✓） */
let windowTouch = 0;
const windowTouchedAt = new Map<string, number>();

/**
 * 把一屏放进缓存并做 LRU 淘汰 ✓。
 *
 * 淘汰**不静默** ✓：超过 `TURN_FILE_CHANGE_WINDOW_SESSIONS` 时最久未用的那个会话
 * 被移出 ✓ —— 移出的后果只是"它下次读要重新问引擎"✓（不是"读不到了"✗），
 * 所以这里不需要上报 ✓；但**要有注释说清**，免得后来者以为它是泄漏 ✗。
 */
function putWindow(sessionId: string, rows: TurnFileChangeRecord[]): void {
  windowCache.set(sessionId, rows);
  windowTouchedAt.set(sessionId, ++windowTouch);
  while (windowCache.size > TURN_FILE_CHANGE_WINDOW_SESSIONS) {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sid, at] of windowTouchedAt) {
      if (sid === sessionId) continue; // 刚放进去的那个不参与本轮淘汰
      if (at < oldestAt) {
        oldestAt = at;
        oldest = sid;
      }
    }
    if (oldest === null) break;
    windowCache.delete(oldest);
    windowTouchedAt.delete(oldest);
  }
}

/** 按 `turn_index` DESC（并列时 `created_at` DESC ⇒ 稳定 ✓）排序一屏 ✓ */
function sortWindow(rows: TurnFileChangeRecord[]): TurnFileChangeRecord[] {
  return [...rows].sort((a, b) => {
    const t = (b.turn_index ?? 0) - (a.turn_index ?? 0);
    if (t !== 0) return t;
    return (b.created_at ?? 0) - (a.created_at ?? 0);
  });
}

/** 测试用：清空一屏缓存与在途读（免得用例之间通过模块级状态串味 ✓） */
export function __resetFileChangeWindow(): void {
  windowCache.clear();
  windowTouchedAt.clear();
  inFlightLoads.clear();
  windowTouch = 0;
}

/** 测试用：当前驻留了几个会话的一屏（"驻留必须有界"要能被断言 ✓） */
export function __windowSessionCount(): number {
  return windowCache.size;
}

export const FileChangeStorage = {
  create(record: TurnFileChangeRecord): void {
    if (domainWrite(TABLE, [recordToWire(record)], { scope: "fileChange.create", note: "文件变更记录未保存" })) {
      /**
       * **顺手把刚写的这行并进一屏** ✓（按需表的"写后读得到自己" ✓）。
       *
       * 与镜像时代的 `applyWrite` 是同一件事的**有界版**：这张表现在没有镜像 ✗，
       * 若不并进来，`finalize()` 之后紧接着的那次同步读**看不到自己刚写的行** ✗
       * （"写完读不到"是本仓库最难查的一类时序缺陷 ✓）。只在**已经读过这个会话**时
       * 才并 ✓ —— 没读过就不去凭空造一份驻留 ✓（那正是镜像的老毛病 ✗）。
       */
      const cached = windowCache.get(record.session_id);
      if (cached) {
        putWindow(
          record.session_id,
          sortWindow([record, ...cached.filter((r) => r.id !== record.id)]).slice(
            0,
            TURN_FILE_CHANGE_WINDOW_ROWS,
          ),
        );
      }
      return;
    }
    /**
     * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，绝不写一份读路径看不见的副本。
     *
     * 原实现回到 `getDatabase()` 写旧库 —— 但回滚开关已退役、旧库在 rust 模式下刻意不加载，
     * A 态（端口未注册）在生产里已不可能出现；那时 `getDatabase()` 只会抛
     * "Database not initialized"，把一个"未就绪"的瞬时状态变成真故障。
     */
    reportPersistFailure(
      "fileChange.create",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "文件变更记录未保存",
    );
  },

  /**
   * **按需查询一个会话的一屏文件变更** ✓（唯一的真实来源 ✓）。
   *
   * @returns 该会话**最新** `TURN_FILE_CHANGE_WINDOW_ROWS` 行（`turn_index` DESC ✓）。
   *   `[]` 是**诚实**的空结果 ✓（"这个会话确实没有记录"✓），
   *   而"没读到"由**抛出的错误**表达 ✓（绝不把失败说成空 ✗ —— 那正是这张表以前的形态 ✗）。
   */
  async loadBySession(sessionId: string): Promise<TurnFileChangeRecord[]> {
    if (!sessionId) return [];
    const pending = inFlightLoads.get(sessionId);
    if (pending) return pending;
    const job = (async () => {
      const items = await queryRows({
        table: TABLE,
        columns: [...TURN_FILE_CHANGE_WINDOW_COLUMNS],
        where: { session_id: sessionId },
        order_by: "turn_index",
        desc: true,
        limit: TURN_FILE_CHANGE_WINDOW_ROWS,
      });
      const rows = sortWindow(items.map(rowToRecord));
      putWindow(sessionId, rows);
      return rows;
    })();
    inFlightLoads.set(sessionId, job);
    try {
      return await job;
    } finally {
      // 落地即摘：下一次读必须**真的**去问引擎（不读过期结果 ✓）
      if (inFlightLoads.get(sessionId) === job) inFlightLoads.delete(sessionId);
    }
  },

  /**
   * **按 id 读一行** ✓（按需 ✓，不碰任何整表装载 ✗）。
   *
   * 列清单同样是 `TURN_FILE_CHANGE_WINDOW_COLUMNS` ✓ ⇒ **不带 `patch` 正文** ✓；
   * 需要正文的调用方用 `FileChangeTracker.fetchPatchById` ✓（只取那一列 ✓）。
   */
  async getByIdAsync(id: string): Promise<TurnFileChangeRecord | null> {
    if (!id) return null;
    const items = await queryRows({
      table: TABLE,
      columns: [...TURN_FILE_CHANGE_WINDOW_COLUMNS],
      where: { id },
      limit: 1,
    });
    const row = items[0];
    return row ? rowToRecord(row) : null;
  },

  /**
   * 同步读**一屏投影** ✓（只读缓存 ✓，不发查询 ✗）。
   *
   * 契约（三条都要记清，否则很容易把它当成"整会话读"✗）：
   * 1. **只返回**已经按需读过的那个会话的一屏 ✓；没读过 ⇒ `[]` ✓
   *    （不假装、不触发同步 IPC ✗）；
   * 2. 顺序是 `turn_index` DESC ✓（与 `loadBySession()` 一致 ✓）；
   * 3. 它是**便利接口** ✓，不是真相来源 ✗ —— 真相来源是 `loadBySession()` ✓。
   */
  listBySession(sessionId: string): TurnFileChangeRecord[] {
    const rows = windowCache.get(sessionId);
    if (!rows) return [];
    windowTouchedAt.set(sessionId, ++windowTouch);
    return [...rows];
  },

  /**
   * 更新某条文件变更记录的状态（**按需**读 → 局部写回 → 返回真实影响行数 ✓）。
   *
   * 第 84 波（A 类：静默空写）：影响 0 行时**没有任何痕迹** ⇒ 改走可见的返回值 ✓。
   * 本波（269）把"读"从镜像换成按需查询 ✓，**语义一字不变** ✓：
   *
   * - 目标行不存在 ⇒ 返回 **0** ✓（调用方据此知道"没改成"，不是静默成功 ✗）；
   * - 目标行存在 ⇒ 写回并返回 **1** ✓。
   *
   * ⚠️ 写回是 `mode: "replace"` + **只有这几列** ✓：引擎侧 `crud.upsert` 的列集合由
   * 提供行的键求并集 ✓，而 `replace` 是"先 UPDATE、没有再 INSERT"（**不是**
   * `INSERT OR REPLACE` ✗ —— 那会先 DELETE 再 INSERT，级联带走子表 ✓）
   * ⇒ **不会**把 `patch` 正文清成 NULL ✓。
   */
  async updateStatus(id: string, status: string): Promise<number> {
    const current = await this.getByIdAsync(id);
    if (!current) return 0;
    const next: TurnFileChangeRecord = { ...current, status: status as TurnFileChangeRecord["status"] };
    /**
     * ⚠️ 这里写成"**if 条件里用掉返回值**"的形状（而不是 `const accepted = …; if (!accepted)` ✗）
     * —— 那是 `tools/audit/check-write-return.mjs`（判据 `GATE-13`）**认得出**的形态 ✓。
     * 第一版就是 `const accepted = …` ✗，当场被它报出来 ✓（"未处理返回值的写入点"✓）：
     * 静态扫描器只能证明"返回值被**用**了"✗ —— 它不是编译器 ✗，看不到 `accepted`
     * 在下一个 if 里被判 ✓。改形状（而不是往 `ALLOWLIST` 里塞一条 ✗）才是对的：
     * 允许清单每加一条，这道门就少一分作用 ✓。
     */
    if (
      domainWrite(TABLE, [recordToWire(next)], {
        mode: "replace",
        scope: "fileChange.updateStatus",
        note: "文件变更状态未更新（记录不存在或写入失败）",
      })
    ) {
      // 已读过这个会话 ⇒ 同步把缓存里那一行的状态也改掉（否则同步读会显示旧状态 ✗）
      const cached = windowCache.get(current.session_id);
      if (cached) {
        putWindow(
          current.session_id,
          cached.map((r) => (r.id === id ? { ...r, status: next.status } : r)),
        );
      }
      return 1;
    }
    /**
     * 端口没接手 ⇒ **返回 0** ✓（保住第 84 波的 A 类语义：0 的含义是
     * "状态根本没改成" ✓）。注意这里**不能**返回 1 ✗ —— 那正好就是它要修的假成功 ✓。
     *
     * 而"没接手"这件事本身也要**如实上报** ✓：这是 `GATE-13` 那条判据的本意 ✓
     * （`domainWrite` 的 `false` = 这次写没被接手 ⇒ 行没进库 ✗，静默处理它就等于
     * 把它变成静默丢弃 ✓）。上报与返回 0 **不冲突** ✓：0 是给**调用方**的分支判据 ✓，
     * 上报是给**用户**的可见性 ✓（两件事，两个接收方 ✓）。
     */
    reportPersistFailure(
      "fileChange.updateStatus",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "文件变更状态未更新（记录在，但这次写没被接手）",
    );
    return 0;
  },

  /**
   * 删除一个会话的全部文件变更记录 ✓（**直达引擎** ✓，不排队等镜像 ✗）。
   *
   * 为什么这里不能再走 `domainDelete` 的镜像分支：这张表**永远不会就绪** ✓
   * （结构性挡在 `DOMAIN_QUERY_ONLY_TABLES` ✓）⇒ 镜像分支恒不成立 ✗，
   * 而"排队等就绪"那条路会白等 15 秒再如实放弃 ✗ —— 删会话时那是纯粹的延迟 ✓。
   */
  deleteBySession(sessionId: string): void {
    if (domainDelete(TABLE, { session_id: sessionId }, { scope: "fileChange.deleteBySession", note: "文件变更记录未删除" })) {
      // 缓存里那份也同步摘掉 ✓（否则删完还能从一屏里读出来 ✗ = 陈旧数据复活 ✗）
      windowCache.delete(sessionId);
      windowTouchedAt.delete(sessionId);
      return;
    }
    // 端口没接手 → 未执行任何删除，如实上报（绝不静默当成已删除）
    reportPersistFailure(
      "fileChange.deleteBySession",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "文件变更记录未删除",
    );
  },

  parseChangedFiles(record: TurnFileChangeRecord): ChangedFile[] {
    if (!record.changed_files) return [];
    try {
      return JSON.parse(record.changed_files);
    } catch {
      return [];
    }
  },
};
