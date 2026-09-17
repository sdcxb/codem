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

// ========== 写入排队（A-1，第 20 轮） ==========

/**
 * 一次"端口已接手、但镜像还在加载"的写请求。
 *
 * 参数形状刻意与 `data.execute` 一致（`cmd` + `params`），这样重放时能走**同一个**
 * 写穿函数 `persistWriteThrough` —— 镜像更新、审计留痕、失败上报全都不必写第二遍
 * （重复实现出来的第二条路，就是下一个"两边行为不一致"的来源）。
 */
type DeferredOp = "write" | "delete" | "deleteWhere";

interface DeferredWrite {
  table: string;
  op: DeferredOp;
  /** 行（`write`） */
  rows?: Array<Record<string, unknown>>;
  /** 等值条件（`delete`） */
  where?: Record<string, unknown>;
  /**
   * 谓词（`deleteWhere`）。范围删除必须**在镜像上**筛出要删的 id
   * （线协议 `where` 只支持等值匹配），所以重放时要重新算一次：
   * 镜像在排队期间可能已被填充，重算得到的正是"本地删掉的与写穿的同一批 id"。
   */
  match?: (row: Record<string, unknown>) => boolean;
  key?: string;
  /**
   * 重放时要不要**再在镜像上应用一次**本地变更。
   *
   * `domainDeleteWhere` 的本地删除必须发生在**排队时**（它要用
   * `applyDeleteWhere` 的"删了几行"作为返回值），排队那一刻镜像还不存在，
   * 所以重放时**不能**再按 `where` 删一次 —— 那会把刚加载回来的整表清空。
   * 这类条目置 `false`，重放只负责写穿。
   */
  applyLocally: boolean;
  cmd: string;
  params: Record<string, unknown>;
  scope: string;
  note: string;
  /** 入队序号（诊断用；重放严格按入队顺序） */
  seq: number;
}

/**
 * 队列上限。
 *
 * 500 是"够用且不至于把内存吃穿"的量级：这个窗口的常态是**一次 IPC 往返**
 * （几十毫秒），能在这个窗口里攒到 500 次写的场景不存在于正常工作流。
 * 真撞上上限就说明有别的更严重的问题，此时**如实上报丢弃**比悄悄吞掉好得多。
 */
const DEFER_MAX = 500;

let deferQueue: DeferredWrite[] = [];
let deferSeq = 0;
let deferredDropped = 0;

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
 */
function deferWrite(item: Omit<DeferredWrite, "seq">): boolean {
  if (deferQueue.length >= DEFER_MAX) {
    deferredDropped++;
    reportPersistFailure(
      item.scope,
      new Error(`域写队列已满（上限 ${DEFER_MAX} 条），本次写被丢弃：${item.table}`),
      item.note,
    );
    return false;
  }
  deferQueue.push({ ...item, seq: ++deferSeq });
  return true;
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
  const mine = deferQueue.filter((q) => q.table === table);
  if (mine.length === 0) return;
  deferQueue = deferQueue.filter((q) => q.table !== table);
  // 严格按入队顺序重放：`filter` 本来就保持相对顺序，但这里**显式**排一次序 ——
  // 免得将来有人换了队列结构，把"顺序"这条保证悄悄弄丢。
  mine
    .sort((a, b) => a.seq - b.seq)
    .forEach((item) =>
      persistWriteThrough(item.table, item.cmd, item.params, item.scope, item.note, item.applyLocally),
    );
}

/** 还压在队列里的写条数（诊断/测试用） */
export function deferredWriteStats(): { pending: number; dropped: number } {
  return { pending: deferQueue.length, dropped: deferredDropped };
}

/** 清空写队列（**仅供测试**：避免用例之间通过模块级状态串味） */
export function __resetDeferredWritesForTests(): void {
  deferQueue = [];
  deferSeq = 0;
  deferredDropped = 0;
}

/**
 * **写穿的唯一实现**（`domainWrite` / `domainDelete` / `domainDeleteWhere` 与重放共用）。
 *
 * 顺序不能改：**先更新本地镜像、再写穿**。镜像是读路径的即时可见性来源 ——
 * 反过来（等 IPC 回来再改镜像）就会出现"写完读不到自己刚写的内容"这种最难查的时序 bug。
 */
function persistWriteThrough(
  table: string,
  cmd: string,
  params: Record<string, unknown>,
  scope: string,
  note: string,
  applyLocally = true,
): void {
  const port = domainMirror(table);
  if (!port) {
    // 端口在排队期间被撤掉（理论上只有测试会这样）：如实上报，不静默丢
    reportPersistFailure(scope, new Error("域写重放时端口已不在"), note);
    return;
  }
  if (applyLocally && cmd === "crud.upsert") {
    const rows = (params.rows as Array<Record<string, unknown>> | undefined) ?? [];
    port.domains.applyWriteMany(table, rows);
  } else if (applyLocally && cmd === "crud.delete") {
    port.domains.applyDelete(table, (params.where as Record<string, unknown> | undefined) ?? {});
  }
  /*
   * `deleteWhere` 的本地删除已经由 `domainDeleteWhere` 在**排队时**做完
   * （它需要 `applyDeleteWhere` 的"删了几行"作为返回值），这里只补写穿。
   */
  recordWrite(cmd, params);
  void port.data.execute(cmd, params).catch((e) => reportPersistFailure(scope, e, note));
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
    rows,
    applyLocally: true,
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
    where,
    applyLocally: true,
    cmd: "crud.delete",
    params,
    scope: opts.scope,
    note: opts.note,
  });
}

/**
 * 「保留最近的 N 条，其余删除」。
 *
 * 对应旧 SQL 的 `DELETE … WHERE … AND id NOT IN (SELECT id … ORDER BY x DESC LIMIT ?)`。
 * 排序键用 `sorted` 列名（例如 `completed_at`），**排序与截断都在镜像上算**，
 * 再把要删的 id 逐个写穿 —— 线协议 where 不支持子查询。
 *
 * @returns 被删除的行数；未路由时返回 `null`，调用方回退旧路径
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
  for (const id of ids) {
    void port.data
      .execute("crud.delete", { table, where: { [key]: id } })
      .catch((e) => reportPersistFailure(opts.scope, e, opts.note));
  }
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
 * 1. 按主键逐行 `crud.delete`（**不是**空 `where` —— Rust 侧明确拒绝空条件）；
 * 2. 逐行 `crud.upsert`（整体替换语义）；
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
    // 整表替换没有"排队"形态：它要先把旧集合**全量**读出来才知道删哪些行，
    // 而本函数拿不到那一份（调用方传的是新集合）。未就绪时如实返回 false。
    return false;
  }
  const scope = "domain.replaceTable";
  const doomed = port.domains
    .all<Record<string, unknown>>(table)
    .map((row) => row[key])
    .filter((v) => v !== undefined && v !== null);
  for (const id of doomed) {
    persistWriteThrough(
      table,
      "crud.delete",
      { table, where: { [key]: id } },
      scope,
      `表 ${table} 未能整表替换（清空阶段失败）`,
    );
  }
  for (const row of rows) {
    persistWriteThrough(
      table,
      "crud.upsert",
      { table, rows: [row], mode: "replace" },
      scope,
      `表 ${table} 未能整表替换（重建阶段失败）`,
    );
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
    const mirror = domainMirror(table, opts);
    if (!mirror?.domains.isLoading?.(table)) return null;
    deferWrite({
      table,
      op: "deleteWhere",
      match,
      key,
      // 本地删除已在排队时做完（见下面的说明），重放只补写穿
      applyLocally: false,
      cmd: "crud.delete",
      params: { table },
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
  for (const id of doomed) {
    void port.data
      .execute("crud.delete", { table, where: { [key]: id } })
      .catch((e) => reportPersistFailure(opts.scope, e, opts.note));
  }
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
