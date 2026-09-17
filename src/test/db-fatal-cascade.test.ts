/**
 * 第 90 波（用户现场）：`RuntimeError: memory access out of bounds` 级联没有被识别为"数据库已死"。
 *
 * ## 现场（历史留档 —— 它解释了这两条用例为什么存在）
 *
 * 用户跑"生成 2．主要研究内容 文档"这类长会话时，控制台开始刷：
 * ```
 * [Store] saveMessages failed: RuntimeError: memory access out of bounds
 *     at sql-wasm-…wasm:0x64b0c … at saveMessages
 * [EventLogFinalize] Failed to write tool events (non-critical): RuntimeError: memory access out of bounds
 * [loadFeedback] Failed: RuntimeError: memory access out of bounds
 * [Telemetry] Flush failed, keeping events for retry: RuntimeError: memory access out of bounds
 * ```
 * 同一条错误出现几十次，`[Telemetry]` 还带着层层嵌套的 `setTimeout` 调用栈。
 *
 * ## 三个真缺陷（当时的修复针对旧引擎：`isFatalDbError()` 名单 + `DatabaseFatalError` /
 * `noteDatabaseError()` / `installFatalGuard()`，见 DBF-1..DBF-5）
 *
 * 1. **不认识这类错误**：WASM 陷阱（`memory access out of bounds`、`RuntimeError: unreachable`、
 *    `Cannot enlarge memory`…）一条都不在致命名单里，于是致命状态从未闩锁。
 * 2. **抢救流程没跑**：`codem:db-fatal` 从未派发 → App 里"把当前会话写成 JSON 抢救出来"
 *    的处理函数根本没执行（那次会话有 113 条消息只存在于内存）。
 * 3. **无限重试 + 刷屏**：查询路径（saveMessages / EventLog / loadFeedback / 遥测）
 *    各自 catch 一下就过去了，遥测还会无限重排定时器。
 *
 * ---
 *
 * # ⚠️ L1（删 sql.js）本批的处置
 *
 * ## 一、DBF-1..DBF-5（第一个 describe）随旧引擎一并退休
 *
 * 那五条断言的是**旧引擎自身的致命闩锁语义**（WASM 陷阱识别、`dbFatal` 闩锁、
 * `installFatalGuard` 包住 `db.exec/run/prepare`、闩锁后 `getDatabase()` 抛可读错误），
 * 而被断言的那套机制（sql.js WASM 堆 + 模块 abort + on-heap 护栏）在 rust 引擎下
 * **不存在**。逐条移交（判据：这条断言的行为，删掉引擎之后由谁守）：
 *
 * | 退休用例 | 原来断言什么 | 覆盖移交给谁 |
 * | --- | --- | --- |
 * | **DBF-1** WASM 陷阱必须判致命 | 7 条陷阱文案（`memory access out of bounds` / `unreachable` / `Cannot enlarge memory` / `null function` / `table index is out of bounds` / OOM / malformed schema）都判 `true` | **该风险随 sql.js 一起消失**：渲染进程里不再有 WASM 堆，也就没有"堆越界 → 模块 abort"这一整族错误。真机现在的失败形态是**端口命令的结构化错误码**，由 Rust `error.rs`（`ErrorCode` 映射：`Corrupt` / `Busy` / `Constraint` / `NotFound` / `Unsupported`）+ `db-contract.test.ts` 的 **C14**（外键违规映射为 `CONSTRAINT`、`retryable=false`）、**C2/C3**（未知命令/裸 SQL → `UNSUPPORTED`）守 |
 * | **DBF-2** 普通 SQL 错误不得误判致命 | `UNIQUE constraint` / `no such column` / `FOREIGN KEY` / "Database not initialized" 都判 `false` | 同一族语义现在由 Rust 错误码**结构**保证（不是靠文案黑名单）：`db-contract.test.ts` **C12**（类型不合法报错且不静默强转）、**C13**（update 未命中 → `NOT_FOUND`）、**C14**（FK → `CONSTRAINT`）+ Rust `foreign_key_violation_maps_to_constraint`（`engine_tests.rs`）、`missing_param_reports_structured_error`、`wrong_param_type_is_rejected_not_coerced` |
 * | **DBF-3** 上报致命错误 → 闩锁 + 一次性派发 `codem:db-fatal` | `noteDatabaseError()` 返回 true、`isDatabaseFatal()` 置位、事件只派发一次、console.error 带 FATAL | **同一契约由下面的 DBF-6 以新判据承担**（"本进程没有可用存储"→ 一次性上报、不刷屏）；"同一区域只报一次、重复失败只累计次数"由 `persist-failure-reporting.test.ts` **PF-2** 守 |
 * | **DBF-4** 闩锁后不再进入已崩的 WASM 堆（`getDatabase()` 抛可读错误） | `DatabaseFatalError` + 文案"数据库模块已不可用…重启应用" | **随引擎消失**：不再有"已崩的 WASM 堆"这个对象；"没有可用存储时**不接手、如实上报**"的新表达是 `health.ts::storageUnavailable()`，由 DBF-6 / `message-index-cutover.test.ts` **MSG-4/MSG-6**（端口不在或索引写失败时：权威日志照写、不抛、如实上报）守 |
 * | **DBF-5** SQL 调用抛陷阱会就地闩锁，且闩锁后不再进底层 | `__installFatalGuardForTests(fakeDb)` 三条语义（进底层一次 → 闩锁 → 之后只抛 `DatabaseFatalError`、`reached` 不再增长） | **随引擎消失**：护栏装在 sql.js 实例上，实例没有了；"危险操作不重复打到底层"的等价物是 Rust authorizer（`attach_is_denied_by_authorizer`、`load_extension_is_denied`、`dangerous_pragma_is_denied_but_wal_pragma_is_allowed`）+ 命令白名单（`dispatch_never_accepts_sql`） |
 *
 * ## 二、DBF-6 / DBF-7 留下 —— 它们的判据第 18 轮就已经不是旧引擎了
 *
 * 这两条守卫原来由旧引擎的致命闩锁（`noteDatabaseError` → `dbFatal`）驱动，
 * 而那个闩锁只可能由 sql.js 的 WASM 陷阱触发 —— rust 模式下恒不成立。
 * 守卫本身仍然有用（"本进程没有可用存储时不要反复重试、要一次性如实上报"），
 * 所以判据早已换成它的新表达：**端口未注册**（`storageUnavailable()`）。
 * 它们守的是**产品契约**（不刷屏、不重试、如实上报、事件不丢），与用哪个引擎无关。
 *
 * ## 三、同批退休的**同族文件**（L1 收尾这一批的覆盖移交台账）
 *
 * 那四个文件整文件删除了，留不下注释；台账记在这里（同族 = 全部为"旧引擎自身语义"用例）。
 * 移交目标一律写成**可 grep 的用例编号**，便于复核：
 *
 * | 退休文件（原用例） | 它守的旧引擎语义 | 覆盖移交给谁 |
 * | --- | --- | --- |
 * | `database-oom-defense.test.ts` **DB-OOM-1** | 认出 OOM / `malformed schema` / WASM abort | **风险随 sql.js 消失**（渲染进程不再有 WASM 堆）。真机失败形态改为端口命令的**结构化错误码**：Rust `error.rs` 的 `ErrorCode` 映射 + `db-contract.test.ts` **C2/C3**（未知命令/裸 SQL → `UNSUPPORTED`）、**C12**（类型不合法不静默强转）、**C13**（未命中行 → `NOT_FOUND`）、**C14**（FK → `CONSTRAINT`，`retryable=false`） |
 * | 同上 **DB-OOM-2** | 整库导出的防抖 + 2 秒节流（"没有变化不导出"） | **导出本身不存在了**：`db-contract.test.ts` **C7**（命令清单里没有 `db.export`/`export`/`backup`）与 **C1**（`caps.no_whole_file_export === true`）；Rust `lib.rs:270` 同一声明 |
 * | 同上 **DB-OOM-3** | 原子写盘：先写 `codem-db.bin.tmp` 再 `rename` 覆盖 | **随整库写盘路径消失**：库文件由 SQLite 自己管（WAL）—— `db-contract.test.ts` **C4**（`journal_mode === "wal"`）、**C5**（`quick_check` ok），Rust `wal_checkpoint_then_integrity_still_ok` / `integrity_check_reports_ok` |
 * | 同上 **DB-OOM-4** | 致命错误只报一次、停止后续写入 | **本文件 DBF-6**（没有可用存储 → 一次性上报、不重试）+ `persist-failure-reporting.test.ts` **PF-2**（同区域重复失败只累计次数） |
 * | 同上 **DB-OOM-5** | 分块 base64 编码无损（边界填充错位会字节不一致） | **随 helper 消失**：`encodeBytesToBase64` 是引擎模块里的私有工具，渲染侧不再做"整库 → base64"（base64 只剩 Tauri 文件参数的编解码，由 Rust 侧承担） |
 * | 同上 **DB-OOM-6** | `importDatabase()` 不再把 Promise 当构造函数 | **随引擎导入路径消失**：数据面导入在 Rust（`import.begin` / `import.table` / `import.end`），Rust `import_order_covers_all_generated_tables`、`import_does_not_delete_rows_missing_from_source` + `db-contract.test.ts` **C15**（批量原子）、**C25**（库丢失后重建） |
 * | `db-persistence-hardening.test.ts` **STOR-H1/H2** | `flushDatabase()` 返回 Promise、`persistDatabase()` 串行队列不抛 | **整库保存队列消失**：写是逐命令事务 —— `db-contract.test.ts` **C15**（批次内一条失败整批不落）+ Rust `create_many_is_all_or_nothing`、`upsert_index_replaces_tool_calls_atomically` |
 * | 同上 **STOR-H3/H4/H5** | 载入时 `PRAGMA quick_check` 失败（或打不开）→ 备份 `.corrupt-` + 删除 + 重建 | `quick_check` 现在由新引擎承担：`db-contract.test.ts` **C5**（`integrity` ok）、**C26**（真实生产库副本 quick_check 必须 ok）+ Rust `integrity_check_reports_ok`；"库损坏/丢失 → 重建 + schema 幂等"由 **C25**（把主库+WAL+SHM 全删后重开 = 全新库、`integrity` ok）与 **C24**（反复打开幂等）守。**诚实说明**：`.corrupt-` 备份那一步**没有等价物** —— 渲染进程不再持有库文件，也没有"把整个库读进内存再校验"的动作可备份 |
 * | 同上 **STOR-H6** | 损坏恢复后库可写（`INSERT/SELECT` 通） | `db-contract.test.ts` **C24/C25** + Rust `crud_upsert_list_count_delete_roundtrip`、`message_roundtrip_including_unicode_and_large_content` |
 * | `db-save-failure-alert.test.ts` **DBSAVE-F1~F4** | 整库保存失败的可见性：派发 `codem:db-save-failed`、限流只提示一次、3 秒自动重试、成功后派发 recovered 并复位 | "失败必须可见、同区域只提示一次"由 `persist-failure-reporting.test.ts` **PF-1**（记账 + error 日志 + `codem:persist-failed` 事件）、**PF-2**（重复失败只累计次数）与 **PF-4**（接线契约）守；调用点层面由 **本文件 DBF-6** 守（没有可用存储 → 一次上报，不再每几秒打一行）。**随整库保存一起消失**的是"3 秒自动重试 + recovered 事件" —— 不再有"整库落盘"这一个可重试动作；失败现在是端口命令的结构化错误（`error.rs` 的 `retryable` + **C13/C14**） |
 * | `compact-resurrect-repro.test.ts` **REPRO-1/2** | 压缩软删除（`hidden=1`）必须真的在读路径生效，且不被追加日志合并复活 | 同族 **`compaction-budget.test.ts` CB-7**（建 40 条 → 软删 35 条 → `listMessages` / `listVisibleMessages` 都必须只剩 5 条，与 REPRO-1/2 同形状且更严）、**CB-8**（清镜像/清缓存模拟重启后仍不复活）、**CB-9**（软删除的 id 保持隐藏，陈旧写入拉不回来）、**CB-11**（老版本"只改索引不写墓碑"的现场也不复活）+ `session-jsonl-index.test.ts` **SLOG-9**（删除留墓碑） |
 *
 * 本批**保留但点名要迁移**：`repro-large-session-db.test.ts`（产品行为：大会话 + 大工具结果保真，
 * 文件头有逐条判定）、`authority-first-storage.test.ts` 的 AR-1~AR-4/AR-6（文件头有逐条判定）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("致命状态下的调用点行为（不刷屏、不重试、可上报）", () => {
  it("DBF-6（修复点）: 没有可用存储时 saveMessages 跳过并一次性上报（不再每几秒打一行）", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { useAppStore } = await import("../store");
    const persist = await import("../core/storage/persist-failure");
    persist.resetPersistFailures();

    setStoragePort(null); // = storageUnavailable()
    useAppStore.getState().saveMessages("sess-1");
    useAppStore.getState().saveMessages("sess-1"); // 第二次不应再产生新上报

    const failures = persist.getPersistFailures().filter((f) => f.area === "store.saveMessages");
    expect(failures).toHaveLength(1);
    expect(failures[0].count).toBe(1);
    expect(failures[0].lastMessage).toMatch(/没有可用存储/);
    warn.mockRestore();
  });

  it("DBF-7（修复点）: 没有可用存储时遥测不再无限重排定时器", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel: any = getTelemetry();

    setStoragePort(null); // = storageUnavailable()
    tel.record("sess-1", "probe", { a: 1 });
    tel.flush();

    expect(tel.flushTimer ?? null, "没有可用存储时不应再安排重试").toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/存储不可用/);
    // 事件必须**留在内存里**（不能因为写不进去就丢掉）
    expect(tel.events.length, "遥测事件应保留待下次重试").toBeGreaterThan(0);
    warn.mockRestore();
    err.mockRestore();
  });
});
