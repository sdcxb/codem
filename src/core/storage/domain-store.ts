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
 * 取某表可用的域端口 —— **未加载完就返回 null**（调用方据此回退旧路径）。
 *
 * 副作用：每次调用都会顺带触发一次惰性加载，因此最迟在该域第二次访问时切过来。
 */
export function domainPort(table: string, opts: DomainReadOpts = {}): DomainMirrorPort | null {
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  if (port.kind !== "rust") return null;
  const candidate = port as unknown as DomainMirrorPort;
  if (!candidate.domains?.ensureLoaded) return null;
  candidate.domains.ensureLoaded(table, undefined, opts.maxRows);
  return candidate.domains.isReady(table) ? candidate : null;
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
 * | **A** | 端口**未注册**（回滚到 wasm / 旧引擎测试基座） | 是唯一数据源 | **必须**回退旧库 |
 * | **B** | 端口在，但该表**镜像未就绪**（加载中 / 超上限被拒 / LRU 逐出 / 被截断） | **刻意不存在** | **不能**回退：应等就绪（`domainEnsureLoaded`）或如实上报 |
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
  const port = getStoragePort();
  // wasm 引擎（回滚开关）→ 也是 A 态
  if (port.kind !== "rust") return true;
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
 * - 返回 `true` → **调用方该走旧库**（A 态：端口未注册 / wasm 回滚，旧库是唯一数据源）；
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
 * **端口是否已注册且是 rust 引擎**（不看镜像是否就绪）。
 *
 * 与 `domainPort()` 的区别正是这套分流的关键：
 * - `domainPort()` 回答"**现在能不能读/写**"（镜像未就绪时为 null）；
 * - `domainPortRegistered()` 回答"**这个进程该不该走端口**"。
 *
 * 写路径必须用后者决定去路：端口已注册却回退旧库 = 本进程内读写分裂。
 */
export function domainPortRegistered(): boolean {
  if (!hasStoragePort()) return false;
  return getStoragePort().kind === "rust";
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
 * 端口未注册（回滚到 wasm）才走旧库。
 */
export function domainEnsureLoaded(table: string, onReady: () => void): void {
  if (!hasStoragePort()) return;
  const port = getStoragePort();
  if (port.kind !== "rust") return;
  const candidate = port as unknown as DomainMirrorPort;
  candidate.domains?.ensureLoaded?.(table, () => {
    if (candidate.domains.isReady(table)) onReady();
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
 */
export function domainWrite(
  table: string,
  rows: Array<Record<string, unknown>>,
  opts: { mode?: "insert" | "replace"; note: string; scope: string } & DomainReadOpts,
): boolean {
  const port = domainPort(table, opts);
  if (!port) return false; // 未接手，调用方走旧路径
  if (rows.length === 0) return true;
  port.domains.applyWriteMany(table, rows);
  // `mode: "replace"` 的覆盖写是"事实上的删除 + 重写"，同样要能被审计看见
  recordWrite("crud.upsert", { table, rows, mode: opts.mode ?? "insert" });
  void port.data
    .execute("crud.upsert", { table, rows, mode: opts.mode ?? "insert" })
    .catch((e) => reportPersistFailure(opts.scope, e, opts.note));
  return true;
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
  const port = domainPort(table, opts);
  if (!port) return false;
  port.domains.applyDelete(table, where);
  recordWrite("crud.delete", { table, where });
  void port.data
    .execute("crud.delete", {
      table,
      where,
      ...(opts.confirmBulk ? { confirm_bulk: true } : {}),
    })
    .catch((e) => reportPersistFailure(opts.scope, e, opts.note));
  return true;
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

/** 整表替换（清空+重建类操作用，例如按 notebook 重算图谱） */
export function domainReplaceTable(
  table: string,
  rows: Array<Record<string, unknown>>,
): boolean {
  const port = domainPort(table);
  if (!port) return false;
  // 整表替换是"事实上的全量删除 + 重写"，必须能被审计看见
  recordWrite("crud.replace_table", { table, rows: Array.isArray(rows) ? rows : [] });
  port.domains.replaceTable(table, rows);
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
  const port = domainPort(table, opts);
  if (!port) return null;
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
