/**
 * 域存储的公共骨架（P3 第 12 段）
 *
 * ## 为什么要把这段抽出来
 *
 * 剩余 13 个域模块（图谱 / 笔记本 / 卡片 / 目标 / 团队 / 问题 / 收件箱 / 笔记 / 委派任务 /
 * 提议草稿 / 待办 / 轮次文件变更 / 智能体画像）形状完全一样：
 *
 * ```
 * export function listX(): X[]        → 同步读
 * export function getX(id): X | null  → 同步读
 * export function saveX(row): void    → 写
 * export function deleteX(id): void   → 写
 * ```
 *
 * 每个模块各写一遍"检查端口 → 加载镜像 → 读 → 写穿 + 报错"，就是 13 次重复。
 * 重复本身不算问题，**重复里漏掉一条**才是问题：漏掉"失败上报"就退化成 B 类假成功，
 * 漏掉"未加载不路由"就产生读写分裂。所以把这段骨架收进一个文件、由契约测试守住，
 * 各域只负责"行 shape 转换"与"业务语义"（后者才是有差异、值得单独写的地方）。
 *
 * ## 三条不变量（都由 domain-store.test.ts 守住）
 *
 * 1. **只有镜像加载完成后才路由** —— 否则"写进 Rust、读到的还是旧值"（读写分裂）；
 * 2. **写 = 先本地镜像、再写穿** —— 保证"刚写的立刻能读到"，且落库失败**如实上报**；
 * 3. **表超上限不镜像** —— 回退旧路径，避免某天大表把渲染进程压死。
 */

import { getStoragePort, hasStoragePort } from "./port";
import { reportPersistFailure } from "./persist-failure";
import { recordWrite } from "./write-audit";

/** 域镜像端口（`RustDomainMirror` 的能力子集；不直接依赖 rust-port 以免循环引用） */
export interface DomainMirrorPort {
  domains: {
    isReady(table: string): boolean;
    /**
     * **该表是否正在加载**（A-1，第 20 轮）：异步 IPC 在途、既没就绪也没失败。
     *
     * 为什么必须能问出这个状态：真端口的 `ensureLoaded` 是异步 IPC，所以**每次启动后的
     * 第一次写**都落在"加载中"这个窗口里。只有能区分"**还在加载**"与
     * "**永远不会就绪**"（超上限被拒 / 加载失败 / 从未被请求），写路径才能做出正确处置：
     * 前者应当**排队等就绪**，后者才该如实返回"未接手"。
     *
     * 可选：老实现没有它就退回旧行为（返回 false / 不上报丢弃），绝不假装排队成功。
     */
    isLoading?(table: string): boolean;
    ensureLoaded(table: string, onLoaded?: () => void, maxRowsOverride?: number): void;
    all<R>(table: string): R[];
    find<R>(table: string, where: Record<string, unknown>): R[];
    findOne<R>(table: string, where: Record<string, unknown>): R | null;
    count(table: string): number;
    applyWrite(table: string, row: Record<string, unknown>, primaryKey?: string): void;
    applyWriteMany(table: string, rows: Array<Record<string, unknown>>, primaryKey?: string): void;
    applyDelete(table: string, where: Record<string, unknown>): void;
    applyDeleteWhere(table: string, match: (row: Record<string, unknown>) => boolean): number;
    replaceTable(table: string, rows: Array<Record<string, unknown>>): void;
  };
  data: { execute(cmd: string, params?: Record<string, unknown>): Promise<{ written: number }> };
}

/**
 * 某张表的镜像上限。
 *
 * 默认 `RustDomainMirror` 的上限（5000 行）是**按行数**算的，对大多数表够用。
 * 但有两类表必须单独给更小的上限：
 * - `notebook_chunks`：每行带一个 Base64 编码的 embedding（1536 维 ≈ 8KB 文本），
 *   5000 行就是 40MB 级别的渲染进程内存 —— 这正是 P6 要消灭的那类占用；
 * - 其它"每行都很大"的表同理（将来的附件表）。
 */
export interface DomainReadOpts {
  /** 覆盖该表的镜像行数上限（超过则该表放弃镜像、回退旧路径） */
  maxRows?: number;
}

/**
 * 取该表可用的域端口，**并顺带触发一次惰性加载**（不判断是否已就绪）。
 *
 * 这是 `domainPort` 的"下层"：写路径需要拿到端口对象本身才能把写**排队**
 * （见 `deferWrite`），而它恰恰是在"未就绪"的时候才需要端口。
 */
function domainMirror(table: string, opts: DomainReadOpts = {}): DomainMirrorPort | null {
  // 判据只有"端口在不在"：`kind` 已是常量 `"rust"`（唯一实现），再加一次 `kind` 判断
  // 就是恒不成立的分支 —— 第 19 轮已删。
  if (!hasStoragePort()) return null;
  const candidate = getStoragePort() as unknown as DomainMirrorPort;
  if (!candidate.domains?.ensureLoaded) return null;
  /*
   * 把"该表刚刚就绪"这件事接住 —— 这是写队列重放的**主路径**。
   *
   * 为什么不能只靠 `if (isReady) replayDeferred()`（下一行）：加载是异步的，
   * 而这次调用只负责**发起**加载，函数返回时表还没就绪 —— 那一刻队列里有东西，
   * 却没有任何人在"就绪的那一刻"把它取走。没有这个回调，重放永远不会发生。
   *
   * 兜底的那次判断仍然保留：万一回调因为实现细节没被触发（例如某天换了端口实现），
   * 下一次访问也能把队列清掉（`replayDeferred` 以摘走条目开头，重复调用安全）。
   */
  candidate.domains.ensureLoaded(table, () => {
    if (candidate.domains.isReady(table)) replayDeferred(table);
  }, opts.maxRows);
  if (candidate.domains.isReady(table)) replayDeferred(table);
  return candidate;
}

/**
 * 取某表可用的域端口 —— **未加载完就返回 null**（读路径据此给该域的合理空结果）。
 */
export function domainPort(table: string, opts: DomainReadOpts = {}): DomainMirrorPort | null {
  const candidate = domainMirror(table, opts);
  return candidate && candidate.domains.isReady(table) ? candidate : null;
}

/**
 * 摘掉内部字段（下划线前缀），只留**线协议参数**。
 *
 * 为什么要这一步：`resolveDeferredAtReplay` 会往参数里塞 `_ids` / `_key`
 * （"这次要按 id 拆成多条命令"的内部标记）。它们必须**不进** `data.execute`
 * 的参数 —— 真引擎的参数校验遇到不认识的字段会报错，而报错的那次删除
 * 才是真正该发出去的那次。
 */
function pickLineParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

// ========== 写入排队（A-1，第 20 轮；X-1/X-2 修于第 46 轮） ==========

/**
 * 一次"端口已接手、但镜像还在加载"的写请求。
 *
 * ## 两条不变量
 *
 * 1. **`params` 是重放时的真参数，必须带条件**。早先这里只为 `deleteWhere` 存了
 *    `params: { table }`（**没有 where**），重放时发出的是空 where 的 `crud.delete`
 *    —— 真引擎明确拒绝（`crud.rs::crud_delete`："删除必须给出 where 条件"），
 *    而审计却照记一条"删过 T 表"，于是**一行都没删、审计里却有证据**（X-1）。
 *    现在 `where` 一律在**重放那一刻**从镜像上现算，见 `resolveDeferredAtReplay`。
 * 2. **声明了的字段必须真有人读**。`match` 早先是"声明了却没有任何代码读"的装饰
 *    （说明那段没写完），现在它是重放时重新求值谓词的**唯一依据**。
 *
 * ## 为什么范围删除必须"就绪后重算"而不是"入队时算好 id 集合"
 *
 * 入队发生在**镜像还没加载回来**的时刻 —— 那一刻 `all()` 是空数组，
 * 算出来的 id 集合必然为空（"什么都没删"），而真相是"镜像还没到手"。
 * 所以入队只能存下**谓词**（`match`），等镜像真的存在了再求值 ——
 * 那时算出的 id 才与"本地要删的"和"要写穿的"是同一批。
 */
type DeferredOp = "write" | "delete" | "deleteWhere";

interface DeferredWrite {
  table: string;
  /** 语义类型。**真的被消费**：决定重放时要不要在镜像上现算目标行（见 `resolveDeferredAtReplay`） */
  op: DeferredOp;
  /** 谓词（`deleteWhere`）。重放时在**已就绪的镜像**上重新求值 —— 见类型上方的说明 */
  match?: (row: Record<string, unknown>) => boolean;
  /** 主键列名（`deleteWhere` 用它把行映射成 id；默认 `id`） */
  key: string;
  cmd: string;
  /**
   * 写穿参数。`write` / `delete` 在入队时就已确定（调用方给全了）；
   * `deleteWhere` 这里是 `undefined`，重放时现算（入队那刻镜像还是空的）。
   */
  params?: Record<string, unknown>;
  scope: string;
  note: string;
  /** 入队时刻（毫秒）。老化判据的起点，见 `DEFER_STALE_MS` */
  at: number;
  /** 入队序号（诊断用；重放严格按入队顺序） */
  seq: number;
}

/**
 * 单张表的排队上限。
 *
 * ## 为什么必须有"按表"这一层（X-2）
 *
 * 队列原来是**全局**上限 500，而唯一的上限判据也是全局的。于是一张**加载失败**的表
 * （`rust-port.ts` 的 `.catch` 只计数上报、不置就绪、回调不触发）能靠滞留把整个额度占满：
 * 实测 `{"pending":500}` 之后，另一张**确实正在加载、本该排队成功**的表的写直接
 * `return false` 被丢弃（审计原文：`goals accepted = 0`）。一张坏表饿死全库。
 *
 * 100 的依据：正常窗口是**一次 IPC 往返**（`domainMirror` 的注释里写的量级是几十毫秒），
 * 能在这个窗口里对**同一张表**攒到 100 次写的场景不存在于正常工作流；
 * 而单表 100 / 全局 500 = 一张坏表最多占掉 20% 的额度，剩下 400 条留给别的表排队。
 * 数值不是精度问题，量级才是：它要保证"一张坏表无论如何都占不满"。
 */
const DEFER_MAX_PER_TABLE = 100;

/**
 * **全局**队列上限（所有表加起来的硬顶）。
 *
 * 500 是"够用且不至于把内存吃穿"的量级：这个窗口的常态是**一次 IPC 往返**
 * （几十毫秒），能在这个窗口里攒到 500 次写的场景不存在于正常工作流。
 * 真撞上上限就说明有别的更严重的问题，此时**如实上报丢弃**比悄悄吞掉好得多。
 *
 * ⚠️ 它**不能**是唯一的上限（X-2）：全局上限 + 全局队列 = 一张坏表能占满整个额度，
 * 于是别的表的写全部被拒（实测 `goals accepted = 0`）。按表那一层见 `DEFER_MAX_PER_TABLE`。
 */
const DEFER_MAX = 500;

/**
 * 入队条目在队列里的**最长滞留时间**（老化窗口）。
 *
 * ## 为什么必须有它（X-2 的滞留）
 *
 * 出队只有两个触发点：该表就绪时的 `replayDeferred`，以及每次访问时的兜底判断。
 * 而"加载失败"的表**永远不会就绪** —— 它的条目既不落库、也不再有任何上报，
 * 就那么压在队列里（实测：`after replay todos -> stats = {"pending":2,...}`）。
 * 于是那些写**被静默吞掉**（调用方拿到的是 `true`/`null` = "已接手"）。
 *
 * ## 数值依据（15 秒）
 *
 * 这个窗口要覆盖的是**正常的中等加载**：`loadTable` 按 1000 行/页分页拉，
 * 真机上几百毫秒到几秒是常态，表大一点到十几秒也出现过（"太大"才被拒，那是另一条路）。
 * 反过来，15 秒之后还没就绪，就已经不是"等一下就成"，而是"这次不成"：
 * 与其把用户的操作永远挂在内存里假装"已接手"，不如**现在如实上报放弃**。
 *
 * ⚠️ 老化**只在队列被触碰时才结算**（`deferWrite` / `replayDeferred` /
 * `deferredWriteStats`），刻意**不**起定时器：
 *
 * - 这段逻辑活在渲染进程的主路径上，一个常驻 `setInterval` 是**新的后台负担**
 *   （本仓库一直在消灭这类占用）；
 * - 定时器会让"入队 → 过期"变成依赖真实时钟的时序断言，测试必然抖。
 *
 * 代价要说清：**如果之后没有任何写、也没有人读诊断，滞留条目会原地等到下一次触碰**。
 * 那份内存（≤500 个对象、每个几十字节）与"谎报已接手"相比可以忽略；
 * 而一旦真的发生了滞留，下一次任何表的写都会把整条队列结算一次 —— 不会积累成雪崩。
 */
const DEFER_STALE_MS = 15_000;

let deferQueue: DeferredWrite[] = [];
let deferSeq = 0;
/** 因**额度**被拒的条数（单表上限 + 全局上限）—— 这些写从来就没进过队列 */
let deferredDropped = 0;
/** 入过队、但因**滞留过久**被放弃的条数（X-2）。与 `dropped` 分开计：
 *  "压根没排上"和"排上了但没成"是两件事，混成一个数就没法诊断了 */
let deferredExpired = 0;

/**
 * 结算老化：把滞留超过 `DEFER_STALE_MS` 的条目**出队并如实上报**。
 *
 * 判据用"这张表现在是否仍然**正在加载**"而不是单纯看时间：
 * 15 秒之内表就绪了，条目早被 `replayDeferred` 取走了；
 * 15 秒之后**还没就绪**（不论加载失败、退避窗口里、还是被拒），这次写就是不成。
 *
 * 绝不静默丢 —— 每个条目一条 `reportPersistFailure`，文案里带表名与窗口时长。
 */
function sweepDeferQueue(now = Date.now(), onlyTable?: string): number {
  if (deferQueue.length === 0) return 0;
  const stale: DeferredWrite[] = [];
  const kept: DeferredWrite[] = [];
  for (const item of deferQueue) {
    if (item.table !== onlyTable && now - item.at >= DEFER_STALE_MS) stale.push(item);
    else kept.push(item);
  }
  if (stale.length === 0) return 0;
  deferQueue = kept;
  for (const item of stale) {
    deferredExpired++;
    reportPersistFailure(
      item.scope,
      new Error(
        `表 ${item.table} 在 ${DEFER_STALE_MS} ms 内未就绪，本次写放弃（已排队 ${now - item.at} ms）`,
      ),
      item.note,
    );
  }
  return stale.length;
}

/**
 * 把一次写排到"该表镜像就绪之后"执行，返回是否**已入队**。
 *
 * ## 为什么必须有这一段（A-1：首触必丢）
 *
 * 原来的写路径是"先 `ensureLoaded()`（异步 IPC）→ 紧接着同步判 `isReady()`"，
 * 于是**每次启动后对某张表的第一次写**必然落在"未就绪"上 → 直接 `return false`，
 * 既不写镜像也不排队 —— 而且 `applyWriteMany` 写在 `return` 之后，连镜像都没动。
 * 不在 `HOT_DOMAIN_TABLES` 里的 12 张表（`todo_lists` / `delegation_tasks` /
 * `issue_comments` / `telemetry_events` / `message_feedback` / `cost_records` /
 * `notebook_sources` / `notebook_chunks` / `note_links` / `note_versions` /
 * `graph_nodes` / `graph_edges`）**每次启动后的第一次写都会静默消失**。
 *
 * ## 判据：只有"还在加载"才排队
 *
 * - **正在加载** → 排队，就绪后按序重放（这才是"等一下就成"的状态）；
 * - **永远不会就绪**（加载失败 / 超上限被拒 / 端口不提供 `isLoading`）→ **不排队**，
 *   仍旧如实返回"未接手"，让调用方走它原来的上报分支。
 *
 * 这个区分不是"更严格"，而是**修掉缺陷的前提**：若把"永不就绪"也排进队列，
 * 队列会只涨不消，且 `domainWrite` 会对调用方谎报"已接手"。
 *
 * ## 为什么入队即算"已接手"（返回 true）
 *
 * 调用方（`show-todo.ts` / `goal.ts` / `inbox-storage.ts` …）的形状是
 * `if (domainWrite(...)) return; reportWriteNotAccepted(...)`。
 * 若入队后仍返回 `false`，调用方会**立刻上报一次失败**，而重放成功之后这件事
 * 又"什么都没发生" —— 用户看到一次假告警。所以入队的返回值是 `true`：
 * **接手了**，失败时由重放路径上报**恰好一次**。
 *
 * 队列满时返回 `false` **并显式上报丢弃**：绝不允许"排不进去"变成静默丢数据。
 * （"已接手但最终没成"由老化通道上报，也绝不静默。）
 */
function deferWrite(item: Omit<DeferredWrite, "seq" | "at">): boolean {
  /*
   * 先结算老化再判额度：否则一张坏表的滞留条目会在**额度上**一直占着位置，
   * 而它们其实早就该被放弃了（X-2 的"饿死"就是这么发生的）。
   */
  sweepDeferQueue();
  const mine = deferQueue.reduce((n, q) => (q.table === item.table ? n + 1 : n), 0);
  if (mine >= DEFER_MAX_PER_TABLE || deferQueue.length >= DEFER_MAX) {
    deferredDropped++;
    reportPersistFailure(
      item.scope,
      new Error(
        `域写队列已满（单表上限 ${DEFER_MAX_PER_TABLE} 条 / 全局上限 ${DEFER_MAX} 条，` +
          `表 ${item.table} 已排队 ${mine} 条），本次写被丢弃：${item.table}`,
      ),
      item.note,
    );
    return false;
  }
  deferQueue.push({ ...item, at: Date.now(), seq: ++deferSeq });
  return true;
}

/**
 * **重放的那一刻**才求值：这次排队到底要写穿什么。
 *
 * ## 为什么必须推迟到这里（X-1）
 *
 * 入队发生在"镜像还没加载回来"的时刻：`all()` 是空数组。所以
 * `deleteWhere` 的目标 id 集合**不可能在入队时算出来** ——
 * 入队时算的结果恒为空集，而空集写穿就是"发一条没有 where 的 `crud.delete`"，
 * 真引擎会直接拒绝（"删除必须给出 where 条件"）。镜像就绪之后再求值，
 * 才拿得到"本地要删的"与"要写穿的"那**同一批** id。
 *
 * `write` / `delete` 的条件在入队时就已确定（调用方给全了），原样返回。
 *
 * @returns `null` = 这次重放**没有内容**（例如谓词一行都不匹配）→ 不发命令、不记审计
 */
function resolveDeferredAtReplay(
  port: DomainMirrorPort,
  item: DeferredWrite,
): Record<string, unknown> | null {
  if (item.op !== "deleteWhere") return item.params ?? null;
  const match = item.match;
  if (!match) return null;
  const doomed = port.domains
    .all<Record<string, unknown>>(item.table)
    .filter(match)
    .map((row) => row[item.key])
    .filter((v) => v !== undefined && v !== null);
  if (doomed.length === 0) return null;
  /*
   * 幂等去重：镜像里同一个主键出现两次（理论上不该有）时，
   * 对同一个 id 发两条 `crud.delete` 是纯浪费（第一条已把它删掉）。
   */
  const ids = [...new Set(doomed.map((v) => String(v)))];
  return {
    table: item.table,
    /*
     * `where` 里给一个**看得懂**的形状；真正发命令时按 `_ids` 拆成逐 id 等值删除
     * （引擎的 `where` 只支持等值匹配）。`_ids` / `_key` 是内部字段，下划线前缀
     * 表示"不是线协议参数"，`persistWriteThrough` 会把它们摘掉。
     */
    where: ids.length === 1 ? { [item.key]: ids[0] } : { [item.key]: `${ids.length} 行（按谓词）` },
    _ids: ids,
    _key: item.key,
  };
}

/**
 * 重放某张表在加载窗口里排下的写（**按入队顺序**）。
 *
 * 由 `domainMirror` 的 `onLoaded`（已就绪时立刻触发）与 `domainEnsureLoaded`
 * 的既有"就绪后回调"调用 —— 不新造第二套加载触发。
 *
 * 失败**不吞**：`persistWriteThrough` 里的 `.catch` 会带**原始的** scope/note
 * 走上报通道，也就是说这里不会把"没写进去"变成静默成功。
 */
function replayDeferred(table: string): void {
  /*
   * 先结算老化：`replayDeferred` 是"这张表就绪了"的信号，但**别的表**的滞留条目
   * 同样到了该结算的时候（它们的就绪信号可能永远不会来）。只结算**别的表**，
   * 本表的条目正要重放，不能被老化掉。
   */
  sweepDeferQueue(Date.now(), table);
  replaySpecific(table, deferQueue.filter((q) => q.table === table));
}

/**
 * 重放给定的条目集合（**已经被摘出队列**）。
 *
 * 拆出来是为了让"摘队"与"重放"是同一段代码：摘错了条目（漏摘 / 多摘）
 * 是这类队列最难查的 bug，而摘与放写在两处必然有一天会对不上。
 */
function replaySpecific(table: string, mine: DeferredWrite[]): void {
  if (mine.length === 0) return;
  const picked = new Set(mine);
  deferQueue = deferQueue.filter((q) => !picked.has(q));
  // 严格按入队顺序重放：`filter` 本来就保持相对顺序，但这里**显式**排一次序 ——
  // 免得将来有人换了队列结构，把"顺序"这条保证悄悄弄丢。
  mine
    .sort((a, b) => a.seq - b.seq)
    .forEach((item) => persistWriteThrough(item.table, item.cmd, undefined, item.scope, item.note, item));
}

/**
 * 队列诊断（X-2 第 3 条）。
 *
 * 要能回答三个问题：**现在有几张表在排队、各自多少、有多少被老化丢弃**。
 * - `pending`：总条数；`tables`：按表的分布（`{ 表名: 条数 }`）；
 * - `dropped`：**从未入队**的条数（单表 / 全局额度满了）；
 * - `expired`：入过队、但**滞留超过 `DEFER_STALE_MS` 被放弃**的条数。
 *
 * `dropped` 与 `expired` 分开：前者是"压根没排上"，后者是"排上了但一直没成" ——
 * 排查时这是两条完全不同的线索（后者意味着**某张表再也加载不出来**）。
 *
 * ⚠️ 调用它会**结算一次老化**（并可能产生上报）：它是"有人来看了"的信号，
 * 顺手把滞留条目结清比让它们继续谎报"已接手"好。这也让"过没过期"可测。
 */
export function deferredWriteStats(): {
  pending: number;
  dropped: number;
  expired: number;
  tables: Record<string, number>;
} {
  sweepDeferQueue();
  const tables: Record<string, number> = {};
  for (const q of deferQueue) tables[q.table] = (tables[q.table] ?? 0) + 1;
  return { pending: deferQueue.length, dropped: deferredDropped, expired: deferredExpired, tables };
}

/** 清空写队列（**仅供测试**：避免用例之间通过模块级状态串味） */
export function __resetDeferredWritesForTests(): void {
  deferQueue = [];
  deferSeq = 0;
  deferredDropped = 0;
  deferredExpired = 0;
}

/**
 * **写穿的唯一实现**（`domainWrite` / `domainDelete` / `domainDeleteWhere` 与重放共用）。
 *
 * 顺序不能改：**先更新本地镜像、再写穿**。镜像是读路径的即时可见性来源 ——
 * 反过来（等 IPC 回来再改镜像）就会出现"写完读不到自己刚写的内容"这种最难查的时序 bug。
 *
 * ## 两个参数为什么在"重放"时和"当场写"时不一样（X-1）
 *
 * - `params`：当场写时调用方已经算好了条件；重放时由
 *   `resolveDeferredAtReplay` 在**已就绪的镜像上**现算（`resolved` 给了就用它）。
 * - `deferred`：给了就说明这是重放。范围删除的"本地删除"因此从**入队时**
 *   挪到了这里 —— 入队那一刻镜像还不存在，删不了任何东西；而"重放却不按 where 删本地"
 *   会把刚加载回来的整表清空（早先的注释正是这么写的，所以那条路干脆什么都不写，
 *   于是既没本地删除、也没写穿，只留下一条假审计）。
 */
function persistWriteThrough(
  table: string,
  cmd: string,
  params: Record<string, unknown> | undefined,
  scope: string,
  note: string,
  deferred?: DeferredWrite,
  applyLocally = true,
): void {
  const port = domainMirror(table);
  if (!port) {
    // 端口在排队期间被撤掉（理论上只有测试会这样）：如实上报，不静默丢
    reportPersistFailure(scope, new Error("域写重放时端口已不在"), note);
    return;
  }
  /*
   * 重放：条件在**已就绪的镜像上现算**。`null` = 这次排队无事可做
   * （例如谓词一行都不匹配）—— 不发命令、不记审计。
   * 绝不发空条件删除：真引擎会拒绝，而审计却会记成"删过 T 表"（X-1 的假证据）。
   */
  const resolved = deferred ? resolveDeferredAtReplay(port, deferred) : params;
  if (!resolved) return;
  if (applyLocally && cmd === "crud.upsert") {
    const rows = (resolved.rows as Array<Record<string, unknown>> | undefined) ?? [];
    port.domains.applyWriteMany(table, rows);
  } else if (applyLocally && cmd === "crud.delete") {
    // `deleteWhere` 的镜像删除就是**按算出来的 where** 删（底层就是"按谓词删"），
    // 不需要第二套 API；这与当场写路径的 `applyDelete` 是同一条规则。
    port.domains.applyDelete(table, (resolved.where as Record<string, unknown> | undefined) ?? {});
  }
  const ids = resolved._ids as string[] | undefined;
  const lineParams = pickLineParams(resolved);
  recordWrite(cmd, lineParams);
  /*
   * 条件里可能有"一次删多个 id"的形状（`{ in: [...] }`）：线协议/引擎侧的
   * `where` 只支持**等值**匹配（`crud.rs::crud_delete`），所以这里必须拆成
   * 一条一个 id 的命令 —— 发一条引擎认不出来的条件，等于什么都没删而审计已经记上。
   */
  if (ids && ids.length > 0) {
    const key = String(resolved._key ?? "id");
    for (const id of ids) {
      void port.data
        .execute(cmd, { table, where: { [key]: id } })
        .catch((e) => reportPersistFailure(scope, e, note));
    }
    return;
  }
  void port.data.execute(cmd, resolved).catch((e) => reportPersistFailure(scope, e, note));
}

/**
 * **回退决策的唯一入口**（B0-1，第 42 轮）。
 *
 * ## 它解决的是什么
 *
 * 迁移期每个回退点都写着同一句话："端口没接手 → 走旧库"。但这句里藏着**两种完全不同的状态**：
 *
 * | 态 | 判据 | 旧库状态 | 正确处置 |
 * | --- | --- | --- | --- |
 * | **A** | 端口**未注册** | 是唯一数据源 | **必须**回退旧库 |
 * | **B** | 端口在，但该表**镜像未就绪**（加载中 / 超上限被拒 / LRU 逐出 / 被截断） | **刻意不存在** | **不能**回退：应等就绪（`domainEnsureLoaded`）或如实上报 |
 *
 * 第 19 轮：A 态原来的第二种形态（"回滚开关切到 wasm"）已随旧引擎删除，
 * A 态现在**只剩**"端口未注册"这一种。
 *
 * `domainRead*` / `domainDelete*` 对这两态返回**同一个值**（`undefined` / `null`），
 * 所以调用方无法区分、只能一律回退 —— 而"一律回退"在 B 态下就是**读写分裂**：
 * 写进旧库、随后的读/删走镜像，于是刚写的读不到、也删不掉。
 * （实测：`note-links-order.test.ts` NL-2；修复它的尝试反而把基线打红 —— 见 L3-DELETION-PLAN.md 第零节。）
 *
 * ## 用法（所有回退点都按这个形状写）
 *
 * ```ts
 * const rust = domainReadMany(T, ...);
 * if (rust !== undefined) return ...;            // 端口接手
 * if (!shouldFallbackToLegacy()) {               // B 态：不碰旧库
 *   domainEnsureLoaded(T, retry);                //   写：等就绪后重做
 *   return <该域的合理空结果>;                    //   读：先给空
 * }
 * const db = getDatabase();                       // A 态：旧库是唯一数据源
 * ```
 *
 * 这样两种态**各自有明确、可测的行为**，删回退时也不必"赌端口总是就绪"。
 */
export function shouldFallbackToLegacy(): boolean {
  // 端口未注册 → A 态：旧库是唯一数据源，回退是唯一正确做法
  if (!hasStoragePort()) return true;
  /**
   * 第 19 轮：这里原来还有一句 `if (port.kind !== "rust") return true`（"wasm 引擎
   * = 也是 A 态"）。**它恒不成立** —— `kind` 已收成字面量 `"rust"`，旧引擎整体删除，
   * 回滚开关退役，生产里不存在第二种实现。留着只会让"两种态"读起来像有三种。
   */
  // 端口在（rust）→ B 态：镜像无论就绪与否都不该碰旧库（旧库在 rust 模式下刻意不加载）
  return false;
}

/**
 * **写/删失败后的统一收尾**（B0-2，第 44 轮）。
 *
 * ## 它把"端口未接手"的两种态收敛成一步
 *
 * 每个写/删点原来是这个形状：
 * ```ts
 * if (domainWrite(...)) return;      // 端口接手
 * const db = getDatabase();          // ← 端口没接手：这里在 B 态下会抛
 * db.run(...); persistDatabase();
 * ```
 * 加上两态判据后要写三行；而这个形状在 22 个文件里要重复 180 多次 ——
 * 重复 180 次的东西，一定会有人写漏其中一种态。
 *
 * 所以收进一个函数：
 * - 返回 `true` → **调用方该走旧库**（A 态：端口未注册，旧库是唯一数据源）；
 * - 返回 `false` → B 态（端口在 rust，只是镜像没就绪）：已**如实上报**，调用方直接 return。
 *
 * 用法（写与删都一样）：
 * ```ts
 * if (domainWrite(T, rows, opts)) return;
 * if (!writeShouldFallBackToLegacy(opts.scope, opts.note)) return;
 * ...旧库写入...
 * ```
 *
 * @param scope 上报用的作用域（与其余 persist-failure 一致）
 * @param note 上报的说明（要说清"什么没写成"）
 * @returns 是否应当回退旧库
 */
export function writeShouldFallBackToLegacy(scope: string, note: string): boolean {
  if (shouldFallbackToLegacy()) return true;
  reportPersistFailure(
    scope,
    new Error("端口已注册但该域镜像未接手（未就绪 / 未镜像 / 被逐出）"),
    note,
  );
  return false;
}

/**
 * **端口已注册但该域镜像未接手** → 如实上报，**不回退旧库**（第 17 轮，L4 收尾）。
 *
 * ## 为什么需要它（而不是直接 `return;`）
 *
 * 删 A 态（旧库回退）时，写路径的形态是：
 * ```ts
 * if (domainWrite(T, rows, { scope, note })) return created;
 * if (!writeShouldFallBackToLegacy(scope, note)) return created;  // ← 里面**已经在上报**
 * const db = getDatabase(); …旧 SQL…                              // ← 要删的是这一段
 * ```
 * 天真删法是连门控一起删、直接 `return created;` —— 那会把
 * `reportPersistFailure` 一起删掉，"没写进去"于是变成**静默假成功**
 * （本仓库最在意的那类缺陷，`audit:false-success` 门禁守的就是它）。
 *
 * 所以写路径的删除不是"删两行"，而是"把**回退判据**换成**只上报**"：
 * ```ts
 * if (domainWrite(T, rows, { scope, note })) return created;
 * reportWriteNotAccepted(scope, note);   // 行为与 B 态**逐字一致**：上报 + 不回退
 * return created;
 * ```
 *
 * 读路径不需要它：那里门控的返回值（`[]` / `null` / `0`）本身就是诚实的空结果，
 * 直接 `return X;` 即可。
 *
 * 全部站点换完之后，`shouldFallbackToLegacy()` 与 `writeShouldFallBackToLegacy()`
 * 就只剩"回滚开关已退役"这一个答案了 —— 那是 L4 真正结束的标志。
 */
export function reportWriteNotAccepted(scope: string, note: string): void {
  reportPersistFailure(
    scope,
    new Error("端口已注册但该域镜像未接手（未就绪 / 未镜像 / 被逐出）"),
    note,
  );
}

/**
 * **端口是否已注册**（不看镜像是否就绪）。
 *
 * 与 `domainPort()` 的区别正是这套分流的关键：
 * - `domainPort()` 回答"**现在能不能读/写**"（镜像未就绪时为 null）；
 * - `domainPortRegistered()` 回答"**这个进程该不该走端口**"。
 *
 * 写路径必须用后者决定去路：端口已注册却回退旧库 = 本进程内读写分裂。
 *
 * 第 19 轮：名字里的 "rust" 判据已随类型收紧消失（`kind` 是常量 `"rust"`，
 * `kind === "rust"` 与"端口在不在"完全等价），函数名保留是为了不动 14 个调用点的语义。
 */
export function domainPortRegistered(): boolean {
  return hasStoragePort();
}

/**
 * **注册一次"该表镜像就绪后执行"**（第 42 轮新增）。
 *
 * ## 用途：消除"端口未就绪时写旧库"造成的读写分裂
 *
 * 写路径如果这样写：
 * ```ts
 * const existing = domainReadMany(T, ...);   // 镜像未就绪 → undefined
 * if (existing) { domainWrite(T, ...); return; }
 * legacyInsert();                             // ← 落到旧库
 * ```
 * 就会出现：**写进旧库、稍后读/删走镜像** —— 刚写的行读不到，也删不掉
 * （`note-links-order.test.ts` 的 NL-2 抓到的就是这个）。
 *
 * 正确处置：端口已注册时，**等镜像就绪再写**（一次性回调，不轮询）；
 * 端口未注册才走旧库（第 19 轮：`kind` 已是常量，判据只剩"端口在不在"）。
 */
export function domainEnsureLoaded(table: string, onReady: () => void): void {
  if (!hasStoragePort()) return;
  const candidate = getStoragePort() as unknown as DomainMirrorPort;
  candidate.domains?.ensureLoaded?.(table, () => {
    // 镜像就绪 → 先把加载窗口里排下的写按序重放（A-1），再执行调用方自己的回调。
    // 顺序很关键：调用方回调里常常是"就绪后重做一次写"，让它排在重放之后，
    // 否则同一条行的两次写会以相反的顺序落库。
    if (candidate.domains.isReady(table)) {
      replayDeferred(table);
      onReady();
    }
  });
}

/** 读一行（未路由时返回 null，调用方回退旧路径） */
export function domainReadOne<R>(  table: string,
  where: Record<string, unknown>,
  convert: (row: Record<string, unknown>) => R,
  opts: DomainReadOpts = {},
): R | null | undefined {
  const port = domainPort(table, opts);
  if (!port) return undefined; // undefined = "没接手"，与"确实没有这行"（null）区分
  const row = port.domains.findOne<Record<string, unknown>>(table, where);
  return row ? convert(row) : null;
}

/** 读多行（未路由时返回 undefined） */
export function domainReadMany<R>(
  table: string,
  convert: (row: Record<string, unknown>) => R,
  where?: Record<string, unknown>,
  opts: DomainReadOpts = {},
): R[] | undefined {
  const port = domainPort(table, opts);
  if (!port) return undefined;
  const rows = where
    ? port.domains.find<Record<string, unknown>>(table, where)
    : port.domains.all<Record<string, unknown>>(table);
  return rows.map(convert);
}

/**
 * 写入若干行：**先更新本地镜像，再写穿**。
 *
 * - 本地先更新 → 调用方紧接着的同步读能看到自己刚写的内容（否则会出现
 *   "写完读不到"这种最难查的时序 bug）；
 * - 写穿失败**如实上报**（绝不静默吞 —— 那是 B 类假成功）；
 * - `mode: "replace"` 用于"整行覆盖"（与旧实现 `INSERT OR REPLACE` 对应）。
 *
 * ## 返回值语义（A-1 之后仍在，只是多了一种"接手"方式）
 *
 * - `true` —— **端口接手了这次写**。两种形态都算接手：镜像已就绪（当场写穿），
 *   或镜像**正在加载**（已入队，就绪后按序重放，失败时上报一次）。
 * - `false` —— 没接手：端口未注册（A 态）或该表**永远不会就绪**（超上限被拒 / 加载失败）。
 *   调用方据此走它原来的"旧库回退 / 如实上报"分支。
 *
 * ⚠️ 入队必须返回 `true`（而不是"照旧返回 false 再重放"）：调用方的形状是
 * `if (domainWrite(...)) return; reportWriteNotAccepted(...)`，
 * 返回 false 会让它**当场上报一次失败**，而写其实成功了 —— 那是一次假告警。
 */
export function domainWrite(
  table: string,
  rows: Array<Record<string, unknown>>,
  opts: { mode?: "insert" | "replace"; note: string; scope: string } & DomainReadOpts,
): boolean {
  const mode = opts.mode ?? "insert";
  const params = { table, rows, mode };
  const port = domainMirror(table, opts);
  if (!port) return false; // 端口没注册：调用方走旧路径
  if (port.domains.isReady(table)) {
    if (rows.length === 0) return true;
    // `mode: "replace"` 的覆盖写是"事实上的删除 + 重写"，同样要能被审计看见
    persistWriteThrough(table, "crud.upsert", params, opts.scope, opts.note);
    return true;
  }
  if (rows.length === 0) return true;
  // 未就绪：只有"正在加载"才排队（日志与可测性都要求这两种态分开处置）
  if (!port.domains.isLoading?.(table)) return false;
  return deferWrite({
    table,
    op: "write",
    key: "id",
    cmd: "crud.upsert",
    params,
    scope: opts.scope,
    note: opts.note,
  });
}

/**
 * 删除若干行（按 where）：同样"先本地、再写穿"。
 *
 * `confirmBulk`：Rust 侧对受保护表（messages / sessions / session_events /
 * tool_calls）有批量删除闸门 —— 单次删除（含外键级联）超过 50 行必须显式确认。
 * **只有明确的用户破坏性操作**（点删除会话/项目）才该传 true；
 * 自动清理、对账、修复路径一律不传，那正是闸门要拦下的东西。
 */
export function domainDelete(
  table: string,
  where: Record<string, unknown>,
  opts: { note: string; scope: string; confirmBulk?: boolean } & DomainReadOpts,
): boolean {
  const params = {
    table,
    where,
    ...(opts.confirmBulk ? { confirm_bulk: true } : {}),
  };
  const port = domainMirror(table, opts);
  if (!port) return false;
  if (port.domains.isReady(table)) {
    persistWriteThrough(table, "crud.delete", params, opts.scope, opts.note);
    return true;
  }
  if (!port.domains.isLoading?.(table)) return false;
  return deferWrite({
    table,
    op: "delete",
    key: "id",
    cmd: "crud.delete",
    params,
    scope: opts.scope,
    note: opts.note,
  });
}

/**
 * 一次"按 id 批量删除"的物理分批大小（第 45 轮线协议审计 P2-6 的**有界批量**）。
 *
 * ## 它解决的是什么（原缺陷的形态）
 *
 * `domainDeleteWhere` / `domainDeleteBeyond` / `domainReplaceTable` 原来是
 * **一个 `for` 循环里 `void port.data.execute(...)`**：循环体内没有 `await`，
 * 于是 N 行目标 = **N 条同时在飞的 IPC**（Tauri 线程池上同时排 N 个命令，
 * 每个都要抢 `Mutex<Connection>`）。真机量级：`telemetry` 的 7 天窗口几千行、
 * `delegation_tasks` 的 TTL、`inbox` 的过期清理、`audit` 表 11.8 小时 6 万行。
 * 后果不是丢数据（单写者锁会串行化），而是**不可见的延迟**：删除几百行时
 * 其它所有写（包括流式响应的 `tool_calls.replace`）被排到后面。
 * 而且失败只有一句 `reportPersistFailure`，**归因不到具体是哪一行**。
 *
 * ## 为什么是"分批 + 顺序"而不是"一条批量命令"
 *
 * 引擎侧确实有单事务多行能力，但那是 `crud.upsert`（整批在一个事务里）；
 * **`crud.delete` 的 `where` 在线协议与 Rust 实现里都只支持等值匹配**
 * （`crud.rs::crud_delete`，明文拒绝空 where），没有 `crud.delete_many` 这条命令
 * （`src-tauri/codem-db/src/lib.rs` 的 `COMMANDS` 白名单里不存在）——
 * 发一个引擎不认识的命令，等于"什么都没删而审计已经记上"（第 31 轮事故的假证据形态）。
 * 所以不改 Rust 的前提下，能做的**有界**就是"分批 + 顺序"：
 * 同时最多 `PERSIST_CHUNK_SIZE` 条在飞，且**批与批之间是顺序的**。
 *
 * ⚠️ 这不是"已经最优"：真正的收口是引擎侧加一条
 * `crud.delete_many { table, ids, confirm_bulk }`（一个 `write_tx` +
 * `measure_delete_impact` + `guard_cascade_scope`），那时这里应当**整段删掉**、
 * 换成一次 IPC + 一个事务，并且批量闸门才第一次能看见真实规模（逐 id 删除每次只命中 1 行，
 * `guard_bulk_delete` 看 `where` 命中数 → 闸门形同不存在）。
 */
export const PERSIST_CHUNK_SIZE = 50;

/**
 * 把"已枚举好的 id 批量删除"写穿 —— **有界批量**版本（P2-6）。
 *
 * ## 为什么是"批次串行链"而不是 `await` 循环
 *
 * 这两个函数的调用方（`telemetry` / `inbox` / `note-manager` / `knowledge` /
 * `flashcard-store` / `maintenance` 共十余处）**全部依赖同步返回值**
 * （`0` = "接手了、确实没有要删的行" vs `null` = "没接手" 是它们的分支判据，
 * 见 `telemetry-clear-contract.test.ts`）。把函数改成 `async` 会让那个返回类型
 * 变成 `Promise<number | null>`，而 `await` 一个非 Promise 的 `null` 会让
 * "没接手"在调用方静默变成 `undefined` —— 那是把一条**如实上报**的分支弄丢。
 * `Promise.resolve(null)` 的形态也救不了：调用方写的是 `removed === null` 的**同步**比较。
 *
 * 所以这里不是"先调度一批、等它回来再调度下一批"，而是：
 * **一批一批地挂进同一条 promise 链**（`chain = chain.then(发下一批)`），
 * 于是任何时刻在飞的命令 ≤ `PERSIST_CHUNK_SIZE`，且批次之间严格有序，
 * 而函数本身仍然是同步返回。代价如实说清：**返回时最后一批还没落地** ——
 * 这与改前的 fire-and-forget 是同一个时序（改前连"第一批发出去"都不保证有序）。
 *
 * 失败逐批归因并汇总上报（`note` 里带行号、id），且吞掉 rejection
 * （否则这条脱离调用栈的 promise 链会在全局产生未处理的拒绝）。
 *
 * @returns 无（失败的可见性走 `reportPersistFailure` 通道）
 */
function persistDeleteIdsBounded(
  port: DomainMirrorPort,
  table: string,
  ids: string[],
  key: string,
  scope: string,
  note: string,
): void {
  const total = ids.length;
  let chain: Promise<void> = Promise.resolve();
  for (let i = 0; i < total; i += PERSIST_CHUNK_SIZE) {
    const start = i;
    const chunk = ids.slice(start, start + PERSIST_CHUNK_SIZE);
    chain = chain
      .then(() =>
        Promise.allSettled(chunk.map((id) => port.data.execute("crud.delete", { table, where: { [key]: id } }))),
      )
      .then((results) => {
        results.forEach((r, idx) => {
          if (r.status === "rejected") {
            reportPersistFailure(
              scope,
              r.reason,
              `${note}（第 ${start + idx + 1}/${total} 行，id=${chunk[idx]}）`,
            );
          }
        });
      })
      .catch((e) => {
        // `Promise.allSettled` 不会 reject，这一层只为"上报本身抛了"兜底（上报绝不影响功能）
        reportPersistFailure(scope, e, `${note}（第 ${start + 1}/${total} 行起的那一批）`);
      });
  }
}



/**
 * 「保留最近的 N 条，其余删除」。
 *
 * 对应旧 SQL 的 `DELETE … WHERE … AND id NOT IN (SELECT id … ORDER BY x DESC LIMIT ?)`。
 * 排序键用 `sorted` 列名（例如 `completed_at`），**排序与截断都在镜像上算**，
 * 再把要删的 id 逐批写穿 —— 线协议 where 不支持子查询。
 *
 * @returns 被删除的行数；未路由时返回 `null`，调用方回退旧路径
 *
 * ⚠️ 第 45 轮线协议审计 P2-6：写穿改成**有界批量**（`PERSIST_CHUNK_SIZE`，
 * 分批 + 批间顺序，见该常量的说明）。返回值与"镜像已删"的同步语义**没有变** ——
 * 改的只是"命令怎么发出去"（原来一次把 N 条全部同时发出去）。
 */
export function domainDeleteBeyond(
  table: string,
  rows: Array<Record<string, unknown>>,
  keep: number,
  opts: { note: string; scope: string; key?: string; orderBy?: string } & DomainReadOpts,
): number | null {
  const port = domainPort(table, opts);
  if (!port) return null;
  const key = opts.key ?? "id";
  const orderBy = opts.orderBy ?? "completed_at";
  // 与 SQL 的 `ORDER BY completed_at DESC LIMIT ?` 同序。
  //
  // 注意并列：SQL 的 `id NOT IN (… LIMIT ?)` 在**并列**时保留哪几条是任意的
  // （SQLite 的 ORDER BY 不保证稳定）。既然做不到"与旧实现逐行一致"，
  // 就必须自己定一个**确定的**顺序（次级键 = id），否则同一批数据在两次运行里
  // 会删掉不同的行 —— 那才是真正危险的那种不确定。
  const sorted = [...rows].sort((a, b) => {
    const av = a[orderBy] as number | null | undefined;
    const bv = b[orderBy] as number | null | undefined;
    const aNull = av === null || av === undefined;
    const bNull = bv === null || bv === undefined;
    if (aNull !== bNull) return aNull ? 1 : -1; // 无完成时间的排最后
    if (!aNull && !bNull && av !== bv) return (bv as number) - (av as number);
    const ak = String(a[key] ?? "");
    const bk = String(b[key] ?? "");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const doomed = sorted.slice(Math.max(0, keep));
  if (doomed.length === 0) return 0;
  const ids: unknown[] = doomed.map((row) => row[key]).filter((v) => v !== undefined && v !== null);
  const doomedSet = new Set(ids.map((v) => String(v)));
  port.domains.applyDeleteWhere(table, (row) => doomedSet.has(String(row[key])));
  /*
   * 批量删除只记**一条**审计（带行数与范围），不逐行记：
   * 审计要回答的是"哪条代码路径删了多少行"，逐行记会把缓冲冲掉、反而看不见调用栈。
   */
  recordWrite("crud.delete", { table, where: { [key]: `${ids.length} 行（保留 ${keep}）` } });
  /*
   * P2-6：写穿走**有界批量**（分批 + 批间顺序，见 `PERSIST_CHUNK_SIZE`），
   * 失败逐批归因上报。返回的"删了几行"仍然是镜像上算出的 `ids.length` ——
   * 那是这个函数的语义（本地已删），写穿失败由上报通道如实表达。
   */
  persistDeleteIdsBounded(
    port,
    table,
    ids.map((v) => String(v)),
    key,
    opts.scope,
    opts.note,
  );
  return ids.length;
}

/**
 * **整表替换**（清空 + 重建类操作，例如按 notebook 重算图谱）。
 *
 * ## 第 20 轮：从"只改镜像"改成**真的写穿**
 *
 * 原实现返回 `true`、只调用 `port.domains.replaceTable()`（只改渲染进程内存），
 * 而且把 **`crud.replace_table`** 记进删除审计 —— 那个命令名在 Rust `COMMANDS`
 * 白名单里**根本不存在**（真引擎会回 `UNSUPPORTED`）。也就是说：调用方拿到"成功"，
 * 库里一行没动，审计里还留下一条**假证据**。这正是本仓库最在意的那类缺陷
 * （静默假成功 + 审计说谎），所以这里把它改成**诚实的实现**：
 *
 * 1. 按主键删 `crud.delete`（**不是**空 `where` —— Rust 侧明确拒绝空条件），
 *    第 45 轮起走**有界批次**（`PERSIST_CHUNK_SIZE`，见清空阶段那段注释）；
 * 2. 重建用**一条** `crud.upsert` 带全部行（引擎侧整批一个事务，`crud.rs:486`）；
 * 3. 每一步都如实上报失败，审计只记**真实发出过**的命令名。
 *
 * `replaceTable`（只改镜像、零生产调用者）随之下线：留着一个"只改内存"的入口，
 * 就是给下一个人留一个"看起来成功、其实没落库"的坑。
 *
 * ## 为什么先删再写、而不是只 upsert
 *
 * "整表替换"的语义包含**删除**（旧集合里有、新集合里没有的行必须消失）。
 * 只 upsert 会把它们留在库里 —— 那是"替换"名下的静默数据残留。
 *
 * ## 返回值为什么**不能**表达"部分失败"（如实记下）
 *
 * 写穿是异步 IPC，而这个函数的返回类型是同步 `boolean`（调用点与
 * `domain-mirror-window.test.ts` 的 A-4 用例都依赖它）。所以返回 `true` 的准确含义是
 * **"已接手，清空与重建的命令都已发出"** —— 与改前同一句话，但改后它**真的成立**了
 * （改前 `persistWriteThrough` 的逐行拆分同样不保证发出顺序）。
 * "部分失败"的可见性走 `reportPersistFailure` 通道（改前每个失败点也一样），
 * 而不是被一个同步的 `true`/`false` 冒充 —— 同步 `false` 只能表达"没接手"
 * （端口未注册 / 该表永远不会就绪），这正是 `false` 分支唯一的语义。
 *
 * @returns `true` = 已接手（清空与重建都已发出）；`false` = 未接手（端口没注册，
 *          或该表永远不会就绪），调用方据此如实上报。
 */
export function domainReplaceTable(
  table: string,
  rows: Array<Record<string, unknown>>,
  key = "id",
): boolean {
  const port = domainMirror(table);
  if (!port) return false;
  if (!port.domains.isReady(table)) {
    /*
     * 整表替换没有"排队"形态：它要先把旧集合**全量**读出来才知道删哪些行，
     * 而本函数拿不到那一份（调用方传的是新集合）。未就绪时如实返回 false。
     *
     * （X-1 复查：这条路**不产生队列条目**，所以不存在"排队了却什么都不写"的形态。
     * 队列里别的条目由加载完成时的 `replayDeferred` 负责，与这里无关。）
     */
    return false;
  }
  const scope = "domain.replaceTable";
  const doomed = port.domains
    .all<Record<string, unknown>>(table)
    .map((row) => row[key])
    .filter((v) => v !== undefined && v !== null);

  /*
   * ## P2-6：清空阶段 = **一次** `crud.delete ... where { in }`？不 —— 但有界
   *
   * 原来这里是一个 `for` + `persistWriteThrough` 循环：N 行 = N 条命令，
   * 每条都在 `void execute()` 里**同时起飞**。现在：
   * - 本地镜像一次性删掉整组行（`applyDeleteWhere`，与"按谓词删"同一条规则）；
   * - 写穿走有界的批次串行链（`persistDeleteIdsBounded`，在飞 ≤ `PERSIST_CHUNK_SIZE`），
   *   失败逐批归因。
   *
   * ### 没有做到的那一半（如实记下）
   *
   * 这仍然是 N 条命令 / N 个独立事务 —— 因为 `crud.delete` 的 `where` 在
   * 线协议与 Rust 实现里**只支持等值匹配**（`crud.rs::crud_delete`），引擎侧
   * 也没有 `crud.delete_many`（`src-tauri/codem-db/src/lib.rs` 的 `COMMANDS` 白名单里没有）。
   * 所以"中途进程被杀 → 表处于删了一半 / 写了一半"这个半状态**依然存在**，
   * 真原子性要引擎侧加命令（属 `src-tauri/**`，本次不动）。
   */
  const doomedIds = doomed.map((v) => String(v));
  if (doomedIds.length > 0) {
    port.domains.applyDeleteWhere(table, (row) => doomedIds.includes(String(row[key])));
    recordWrite("crud.delete", { table, where: { [key]: `${doomedIds.length} 行（整表替换的清空阶段）` } });
    persistDeleteIdsBounded(
      port,
      table,
      doomedIds,
      key,
      scope,
      `表 ${table} 未能整表替换（清空阶段失败）`,
    );
  }

  /*
   * 重建阶段：**一次 `crud.upsert` 带全部行**。
   *
   * 这里正是 P2-6 想指的方向"引擎已有单事务多行能力，只是没用"——
   * `crud_upsert` 的整批在**一个事务**里完成（`crud.rs:486` 的 `engine.write_tx`
   * + 每行列可不同）。原来逐行调用把 M 行拆成 M 条 IPC / M 个事务
   * （`persistWriteThrough` 里是"按 `_ids` 逐条拆"的形态，这里每行一条），
   * 于是"替换一半就崩"与"整批要么全成要么全不成"这两件事在真机上分不开。
   *
   * 本地镜像用 `applyWriteMany` 一次写入（与 `domainWrite` 的 `mode: "replace"` 同序：
   * 先本地、再写穿），端口在期间消失时如实上报而不是静默。
   */
  if (rows.length > 0) {
    const params = { table, rows, mode: "replace" };
    port.domains.applyWriteMany(table, rows, key);
    recordWrite("crud.upsert", pickLineParams(params));
    void port.data
      .execute("crud.upsert", params)
      .catch((e) => reportPersistFailure(scope, e, `表 ${table} 未能整表替换（重建阶段失败）`));
  }
  return true;
}

/**
 * 按**谓词**删除（TTL 清理、`created_at < ?` 这类范围条件）。
 *
 * ## 为什么不能直接用 `crud.delete`
 *
 * 线协议（以及 Rust 侧的 `crud_delete`）的 `where` 只支持**等值**匹配，
 * 而且**明确拒绝空 where**（防清空整表）。所以范围删除只能由渲染进程
 * 按镜像里的行算出具体 id，再按 id 批量删除：
 *
 * - 先在镜像上筛出目标 id —— 保证"本地删掉的"与"写穿的"**是同一批 id**；
 * - 本地先删，再写穿（与 `domainDelete` 同序），中途失败如实上报。
 *
 * 本地先删还有一个必须性：这类清理常常是**先写新行、再顺手清旧行**，
 * 若等到写穿返回才删本地，调用方紧接着的同步读就会看到"早该过期的行"。
 *
 * ## 加载窗口里（排队）的语义 —— X-1 修的是这里
 *
 * 入队发生在镜像**还没加载回来**的时刻，所以：
 *
 * - 目标 id 集合**不可能在入队时算出来**（那一刻 `all()` 是空的，算出来恒是空集），
 *   只能把**谓词**存进去，等镜像就绪后由 `resolveDeferredAtReplay` 现算；
 * - 因此"本地删除"也一并从入队时挪到重放时 —— 排队那一刻删不了任何东西。
 *
 * 早先的实现把 `params` 存成 `{ table }`（**没有 where**）、`applyLocally: false`，
 * 于是重放发出的是**空条件删除**：真引擎明确拒绝（`crud.rs::crud_delete`：
 * "删除必须给出 where 条件"）→ 一行都没删，而审计里却留下一条"删过这张表"的
 * **假证据**（连带后果比什么也没做更坏：排查时会以为删除路径是通的）。
 * 并且它连本地镜像都没删，调用方拿到的 `null` 之后紧接着的读会看到"早该消失的行"。
 *
 * ## `null` 仍然是"未接手"（以及它为什么不矛盾）
 *
 * 排队分支返回 `null`：**本次同步调用确实什么都没删**（镜像还没到手上），
 * 调用方的"未接手"分支是对阅读者诚实的（例如 `inbox-storage.ts` 会如实上报一次
 * "过期通知未清理"）。区别在于：现在这次删除**真的会到库里执行**，
 * 而不是像早先那样只留一条审计 —— 宁多一条偏保守的告警，也不要静默丢数据。
 *
 * @returns 被删除的行数；未路由（未接手）时返回 `null`，调用方回退旧路径
 */
export function domainDeleteWhere(
  table: string,
  match: (row: Record<string, unknown>) => boolean,
  key: string,
  opts: { note: string; scope: string } & DomainReadOpts,
): number | null {
  /*
   * ⚠️ **先判"能不能接手"，再判"要不要排队"** —— 这两步的顺序是有意义的。
   *
   * 早先这里直接调 `domainMirror`（它不判就绪），于是"该表永远不会就绪"这条路上
   * `all()` 拿到空数组、算出来 0 行，函数就返回了 **0** —— 而 0 的语义是
   * "**接手了，删了 0 行**"。调用方（删空判定、清理计数）会把它读成
   * "清理已完成，确实没有要删的"，而真相是"这次根本没接手，什么都没做"。
   * 这正是本仓库最在意的"把'没做到'说成'做到了'"。
   *
   * 所以：**未就绪且未在加载** → `null`（未接手，如实）；**正在加载** → 排队 + `null`
   * （本次同步调用没做，但到了库里会被执行）。
   */
  const port = domainPort(table, opts);
  if (!port) {
    // 兜底那次判断仍然要"顺带发起加载"（`domainMirror` 会注册 onLoaded 回调）
    const mirror = domainMirror(table, opts);
    if (!mirror?.domains.isLoading?.(table)) return null;
    deferWrite({
      table,
      op: "deleteWhere",
      match,
      key,
      cmd: "crud.delete",
      // 没有 params：条件要到重放那一刻、在**已就绪的镜像上**才有得算（见文件头说明）
      scope: opts.scope,
      note: opts.note,
    });
    return null;
  }
  const all = port.domains.all<Record<string, unknown>>(table);
  const doomed = all
    .filter(match)
    .map((row) => row[key])
    .filter((v) => v !== undefined && v !== null);
  if (doomed.length === 0) return 0;
  const removed = port.domains.applyDeleteWhere(table, (row) => match(row));
  recordWrite("crud.delete", { table, where: { [key]: `${doomed.length} 行（按谓词）` } });
  // P2-6：有界批量（分批 + 批间顺序，见 `PERSIST_CHUNK_SIZE`），失败逐批归因
  persistDeleteIdsBounded(
    port,
    table,
    doomed.map((v) => String(v)),
    key,
    opts.scope,
    opts.note,
  );
  return removed;
}

/**
 * 便捷包装：把"域读"写成一行三目式，减少各模块的样板。
 *
 * ```ts
 * return domainOr(() => legacyRead(), (port) => port.domains.all(...));
 * ```
 */
export function domainOr<T>(table: string, rustRead: (port: DomainMirrorPort) => T, legacyRead: () => T): T {
  const port = domainPort(table);
  return port ? rustRead(port) : legacyRead();
}
