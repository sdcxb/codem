/**
 * 第 91 波（**架构级**）：让"权威日志"真的权威 —— 写入顺序、索引自愈、存储压力。
 *
 * ## 现场与根因
 *
 * 用户长会话（大文档、113 条消息）时 sql.js 报 `RuntimeError: memory access out of bounds`。
 * 出问题的不只是"没识别到崩溃"（第 90 波已修），更根本的是**分层名不副实**：
 *
 * 1. **写入顺序是反的**：分层写着"JSONL 追加日志 = 权威存储，SQLite = 可重建索引"（第 78 波），
 *    但 `createMessage` 是「先 `getDatabase()` → INSERT/UPDATE → `persistDatabase()` →
 *    **最后**才 `appendSessionMessage`」。索引一出问题就在第一行抛掉，**权威日志那一步根本没跑** ——
 *    "最权威的副本"反倒挂在"最脆弱路径的最后一道"。用户那 113 条消息的危险就来自这里。
 * 2. **读路径也挂在索引上**：`listMessagesFromIndex` 直接 `getDatabase()`，索引一崩连历史都读不出来
 *    （日志里明明什么都在）。
 * 3. **索引重建方向从未实现**：只有"索引 → 日志"的回填，没有"日志 → 索引"。崩了只能重启撞运气。
 * 4. **存储压力**：`saveMessages` 每次把**整份消息列表**逐条写（100+ 条 UPDATE + 工具调用先删后插）；
 *    `saveDatabase` 每次 `db.export()` **整库**（单次 O(库大小) 的 WASM 分配）—— 这是越界最现实的触发点。
 *
 * ## 本文件的用例
 *
 * AR-1/2/3：索引崩了，**消息照样进权威日志**（create / update 两条路径）、**历史照样读得出来**
 *          —— ⚠️ **第 18 轮退休（故障注入点随旧引擎删除），见下面的台账**
 * AR-4：日志在 → **索引可以从日志重建**（含工具调用）—— 保留
 * AR-5：崩溃会留下"下次启动重建索引"的标记（且维护路径真的消费它）—— ⚠️ **已随旧引擎退休，见下**
 * AR-6：`saveMessages` 只写变化过的消息（未变化的一次都不写）—— 保留
 * AR-7：整库导出有硬上限，超限即"暂停整库落盘、只写权威日志" —— ⚠️ **已随旧引擎退休，见下**
 *
 * ---
 *
 * ## ⚠️ 第 18 轮（L1 收尾：删 sql.js）退休台账：AR-1 / AR-2 / AR-3 / AR-5 / AR-7
 *
 * 这些用例断言的都是**产品契约**（"权威日志才是权威副本"这条分层承诺），但它们一律拿旧库当
 * **故障注入点 / 生命周期夹具**：`await import("../core/storage/database")` +
 * `dbMod.noteDatabaseError(...)` 制造"索引致命"。那个函数与被注入的机制（sql.js 致命闩锁）
 * **已随引擎删除**（`src-tauri/codem-db/sql/schema.sql` 是引擎建库执行的真源，渲染进程不再持有引擎），
 * 注入点消失了，所以按铁律**就地在文件里退休 + 把覆盖移交出去**：
 *
 * | 退休用例 | 为什么是引擎语义 | 覆盖移交给谁 |
 * | --- | --- | --- |
 * | **AR-1** create 路径：索引致命时消息仍进权威日志、不抛错 | 故障注入点是旧引擎致命闩锁（`noteDatabaseError` → `isDatabaseFatal`），随 `database.ts` 删除 | `message-index-cutover.test.ts` **MSG-4**（端口未注册 → 权威日志仍然要写 + 如实上报）、**MSG-6**（索引写失败不抛、不影响权威日志）。⚠️ MSG-4/6 把 `session-jsonl` 整个 mock 掉，只断言 append 被调用；AR-1 多出的"**把日志读回来核对内容**"这一步**没有**跟着移交 —— 迁移批次若要合并，请把这一步并入 MSG-4/6，别只留"append 被调用" |
 * | **AR-2** update 路径：索引致命时最新内容仍追加进权威日志 | 同上（同一个 `noteDatabaseError` 注入点） | **暂无等价用例**：MSG-1..6 只覆盖 `createMessage`（全文件只有 `updateMessage` 的注释引用）。**此处点名**：新口径是 `setStoragePort(null)` / 端口写失败，迁移批次**优先补**这条 |
 * | **AR-3** 索引致命时历史仍读得出来（走权威日志合并） | 同上（同一个注入点） | 近亲是 `session-jsonl-index.test.ts` **SLOG-6**（索引被裁后读路径仍合并日志）；"索引不可用"这个触发条件在新架构里由**端口不可用**承担 —— `message-index-cutover.test.ts` **MSG-9**（未加载完的会话不路由、不回退旧库）。⚠️ "致命态下 listMessages 仍返回全量历史"这条**没有**逐字等价用例 |
 * | **AR-5** 崩溃留标记 + 维护先重建再回填 | 标记的产生者就是旧引擎的致命闩锁（`noteDatabaseError` → `markIndexRebuildNeeded`，见 `database.ts::noteFatalDbError`）；断言里还有两条**源码契约**（`database.ts` 必须含 `await indexRebuildNeeded()` 且排在 `backfillAllSessions()` 之前），那段代码随引擎删除 | **风险随 sql.js 消失**：没有"引擎致命闩锁"就没有"下次启动要重建索引"这个标记的产生者。重建能力本身（消费侧）仍被守着：本文件 **AR-4**（只有日志也能重建索引，含工具调用）+ `maintenance-rust-mode.test.ts` **MR-1**（rust 模式下维护真的执行回填/重建，不许因为"旧库不存在"整段跳过） |
 * | **AR-7** 整库导出有硬上限（`MAX_EXPORT_BYTES`、`wholeFileExportSuspended`） | 整库导出是 sql.js **唯一的落盘方式**，上限是为它设的；现在连导出这件事都不存在 | `db-contract.test.ts` **C7**（命令清单里**没有** `db.export` / `export` / `backup` / `sql.raw`，"渲染进程不再持有整库"是架构承诺）+ **C1**（`caps.no_whole_file_export === true`）；Rust 侧 `src-tauri/codem-db/src/lib.rs` 同样只声明 `no_whole_file_export: true`，`COMMANDS` 里没有任何导出命令 |
 *
 * **保留**：AR-4（自愈重建）与 AR-6（`saveMessages` 只写变化过的消息）与引擎无关 ——
 * 它们只依赖"索引是空的"这个前提，而现在这个前提由基座保证
 * （`setup.ts` 每例注册一个干净的内存端口，`freshDb()` 不必再清旧库）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// 虚拟文件系统：JSONL 日志走 file-api（appendFile/readFile/…）
vi.mock("../core/file-api", () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    appendFile: vi.fn(async (p: string, c: string) => {
      files.set(p, (files.get(p) ?? "") + c + "\n");
    }),
    readFile: vi.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    }),
    deleteFile: vi.fn(async (p: string) => {
      files.delete(p);
    }),
    exists: vi.fn(async (p: string) => files.has(p)),
    getAppDataDir: vi.fn(async () => "C:/appdata/"),
    getDefaultCwd: vi.fn(async () => "C:/proj"),
    isPathWithinWorkspace: vi.fn(() => true),
    listDirectory: vi.fn(async () => []),
    executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  };
});

let msgMod: any;
let jsonlMod: any;
let bridgeMod: any;

/**
 * 每个用例前把内存镜像清干净。
 *
 * 第 18 轮：这里原来是「`await import("../core/storage/database")` → `resetDatabase()` /
 * `initDatabase()` / `resetDatabaseFatalState()`」—— 整套旧引擎夹具随 `database.ts` 删除。
 * "索引是空的"这个前提现在由基座承担：`setup.ts` 的 `beforeEach` 每例注册一个**干净的内存假端口**
 * （`createFakeStoragePort()`），也就是产品在 rust 模式下真正读写的那一侧。
 */
async function freshDb() {
  msgMod = await import("../core/storage/message");
  jsonlMod = await import("../core/storage/session-jsonl");
  bridgeMod = await import("../core/storage/session-log-bridge");
  msgMod.clearSessionLogCache?.();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await freshDb();
});

/**
 * ⚠️ **第 18 轮（L1 收尾）退休：AR-1 / AR-2 / AR-3 —— "索引致命时权威日志照样写、历史照样读"。**
 *
 * 这三条断言的**产品行为**没有变（"权威日志是权威副本"仍然是分层承诺），但它们唯一的
 * 故障注入点是旧引擎的致命闩锁：
 *
 * ```ts
 * dbMod = await import("../core/storage/database");
 * dbMod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"));  // 制造"索引致命"
 * ```
 *
 * `noteDatabaseError` / `isDatabaseFatal` 这套机制**已随 sql.js 引擎删除**
 * （`src/core/storage/database.ts` 不存在了；引擎侧真源是
 * `src-tauri/codem-db/sql/schema.sql` + `src/schema.rs`，渲染进程不再持有引擎），
 * 注入点没有载体 → 按铁律退休，并把覆盖**移交出去**（详见文件头台账）：
 *
 * - **AR-1**（create 路径）→ `message-index-cutover.test.ts` **MSG-4 / MSG-6**
 *   （新口径：端口未注册 / 端口写失败）。⚠️ 但 MSG-4/6 把 `session-jsonl` 整个 mock 掉，
 *   只断言 append 被调用 —— AR-1 独有的是"**把日志读回来核对内容**"，这份覆盖**未移交**，
 *   迁移批次要补回来（别只留"append 被调用"）。
 * - **AR-2**（update 路径）→ **暂无等价用例**（MSG-1..6 只覆盖 `createMessage`）。
 *   新口径是 `setStoragePort(null)` / 端口写失败，**迁移时优先补**。
 * - **AR-3**（索引致命时读历史走日志合并）→ `session-jsonl-index.test.ts` **SLOG-6** 是近亲
 *   （索引被裁后读路径仍合并日志）；"索引不可用"在新架构里由**端口不可用**承担，
 *   见 `message-index-cutover.test.ts` **MSG-9**。
 */

describe("索引可重建（自愈）", () => {
  it("AR-4（修复点）: 只有日志时可以从日志重建索引（含工具调用）", async () => {
    await jsonlMod.__writeSessionLogForTests("sess-ark4", [
      JSON.stringify({
        v: 1, id: "b1", sessionId: "sess-ark4", role: "assistant", content: "带工具的消息",
        timestamp: 10,
        toolCalls: [{ id: "tc-1", tool: "write", args: { path: "a.md" }, result: "ok", status: "done" }],
      }),
    ]);

    // 索引里本来没有（模拟重建场景）
    const before = msgMod.listMessagesFromIndex("sess-ark4");
    expect(before).toHaveLength(0);

    const rebuilt = await bridgeMod.rebuildIndexFromSessionLogs("sess-ark4");
    expect(rebuilt.messages).toBe(1);

    const after = msgMod.listMessagesFromIndex("sess-ark4");
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe("带工具的消息");
    // 工具调用也重建进索引（否则索引读路径看不到工具调用）
    const withTools = msgMod.getMessage("b1");
    expect(withTools?.toolCalls?.map((t: any) => t.tool)).toContain("write");
  });

  /**
   * ⚠️ **L1（删 sql.js）本批退休：AR-5 "崩溃留重建标记 + 维护先重建再回填"。**
   *
   * 它守的标记（`codem-index-rebuild-needed.json`）由**旧引擎的致命闩锁**写入
   * （`database.ts::noteFatalDbError` → `markIndexRebuildNeeded`），断言里还有两条
   * `database.ts` 的**源码契约**（`await indexRebuildNeeded()` 必须排在
   * `backfillAllSessions()` 之前）—— 两者都随引擎删除。
   *
   * 覆盖移交：**该风险随 sql.js 消失**（没有"引擎致命闩锁"就没有标记的产生者）。
   * 重建能力本身（消费侧）由本文件 **AR-4**（只有日志也能重建索引，含工具调用）与
   * `maintenance-rust-mode.test.ts` **MR-1**（rust 模式下维护真的执行回填/重建）守。
   */
});

describe("存储压力（越界最现实的触发点）", () => {
  it("AR-6（修复点）: saveMessages 只写变化过的消息（未变化的第二次一条都不写）", async () => {
    const { useAppStore } = await import("../store");
    const store: any = useAppStore;
    const spy = vi.spyOn(msgMod, "createMessage");

    const msgs = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as any,
      content: `内容 ${i} `.repeat(50),
      timestamp: i + 1,
      status: "done" as const,
    }));
    store.setState({ messages: msgs });
    (await import("../store")).__resetSaveFingerprints?.("sess-ark6");

    store.getState().saveMessages("sess-ark6");
    expect(spy.mock.calls.length, "首次应把 40 条都写一遍").toBe(40);

    spy.mockClear();
    store.getState().saveMessages("sess-ark6");
    expect(spy.mock.calls.length, "内容没变 → 一条都不用写").toBe(0);

    // 改一条 → 只写那一条
    const changed = msgs.map((m) => (m.id === "c7" ? { ...m, content: m.content + "补充" } : m));
    store.setState({ messages: changed });
    store.getState().saveMessages("sess-ark6");
    expect(spy.mock.calls.length, "只有变化的那条需要写").toBe(1);
    expect(spy.mock.calls[0][0].id).toBe("c7");
    spy.mockRestore();
  });

  /**
   * ⚠️ **L1（删 sql.js）本批退休：AR-7 "整库导出有硬上限，超限即暂停整库落盘"。**
   *
   * 它断言的是 `database.ts` 的源码契约（`const MAX_EXPORT_BYTES = …`、
   * `if (data.length > MAX_EXPORT_BYTES)`、`database.wholeFileExportSuspended`、
   * `isWholeFileExportSuspended()`）—— 整库导出是 sql.js **唯一的落盘方式**，
   * 这条上限是为它设的，导出本身没有了，上限也就没有载体。
   *
   * 覆盖移交：`db-contract.test.ts` **C7**（命令清单里没有 `db.export` / `export` / `backup` /
   * `sql.raw`，"渲染进程不再持有整库"是架构承诺）与 **C1**（`caps.no_whole_file_export === true`），
   * Rust 侧 `src-tauri/codem-db/src/lib.rs` 也只声明 `no_whole_file_export: true`、
   * `COMMANDS` 里没有任何导出命令 —— 也就是"整库落盘"这条压力源在架构上不存在了，
   * 而不是"有上限地存在"。
   */
});
