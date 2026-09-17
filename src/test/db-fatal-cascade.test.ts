/**
 * 第 90 波（用户现场）：`RuntimeError: memory access out of bounds` 级联没有被识别为"数据库已死"。
 *
 * ## 现场
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
 * ## 三个真缺陷
 *
 * 1. **不认识这类错误**：`isFatalDbError()` 的名单里只有 `out of memory` /
 *    `malformed database schema` / `bad parameter…` —— WASM 陷阱
 *    （`memory access out of bounds`、`RuntimeError: unreachable`、`Cannot enlarge memory`…）
 *    一条都不在，于是**致命状态从未闩锁**。
 * 2. **抢救流程没跑**：`codem:db-fatal` 从未派发 → App 里"把当前会话写成 JSON 抢救出来"
 *    的处理函数根本没执行（那次会话有 113 条消息只存在于内存）。
 * 3. **无限重试 + 刷屏**：查询路径（saveMessages / EventLog / loadFeedback / 遥测）
 *    各自 catch 一下就过去了，每次都往已经崩掉的 WASM 堆上再撞一次；
 *    遥测还会无限重排定时器。
 *
 * 修复（`database.ts`）：扩展致命错误名单 + 新增 `DatabaseFatalError` / `noteDatabaseError()` /
 * `installFatalGuard()`（包住 `db.exec/run/prepare`：任何 WASM 陷阱就地闩锁并派发事件；
 * 闩锁后**不再碰堆**，直接抛可读错误）；调用点（store.saveMessages / 遥测 / EventLog 终层 /
 * loadFeedback）改为致命状态下一律跳过并**一次性上报**。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";

async function db() {
  const mod = await import("../core/storage/database");
  try { await resetDatabase(); } catch { await initDatabase(); }
  mod.resetDatabaseFatalState();
  return mod;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  const mod = await import("../core/storage/database");
  mod.resetDatabaseFatalState();
});

describe("致命数据库错误识别（第 90 波）", () => {
  it("DBF-1: WASM 陷阱必须被判为致命（原来是漏网的）", async () => {
    const mod = await db();
    for (const msg of [
      "RuntimeError: memory access out of bounds",
      "RuntimeError: unreachable",
      "Cannot enlarge memory arrays to size 2147483648 bytes",
      "null function or function signature mismatch",
      "table index is out of bounds",
      "Error: out of memory",
      "malformed database schema (sqlite_master) - table x already exists",
    ]) {
      expect(mod.isFatalDbError(new Error(msg)), `应判致命：${msg}`).toBe(true);
    }
  });

  it("DBF-2: 普通 SQL 错误不能被误判为致命（否则会误触发抢救）", async () => {
    const mod = await db();
    for (const msg of [
      "UNIQUE constraint failed: messages.id",
      "no such column: foo",
      "FOREIGN KEY constraint failed",
      "Database not initialized. Call initDatabase() first.",
    ]) {
      expect(mod.isFatalDbError(new Error(msg)), `不该判致命：${msg}`).toBe(false);
    }
  });

  it("DBF-3（修复点）: 查询路径上报致命错误 → 闩锁 + 派发 codem:db-fatal（只派发一次）", async () => {
    const mod = await db();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: any[] = [];
    const onFatal = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("codem:db-fatal", onFatal);

    expect(mod.isDatabaseFatal()).toBe(false);
    expect(mod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"))).toBe(true);
    expect(mod.isDatabaseFatal()).toBe(true);
    // 第二次上报不再重复派发（避免刷屏）
    mod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"));

    window.removeEventListener("codem:db-fatal", onFatal);
    expect(events).toHaveLength(1);
    expect(String(events[0].message)).toMatch(/memory access out of bounds/);
    expect(err.mock.calls.flat().join(" ")).toMatch(/FATAL/);
    err.mockRestore();
  });

  it("DBF-4（修复点）: 闩锁后不再进入已崩的 WASM 堆 —— getDatabase() 直接抛可读错误", async () => {
    const mod = await db();
    mod.noteDatabaseError(new Error("memory access out of bounds"));
    expect(() => mod.getDatabase()).toThrow(mod.DatabaseFatalError);
    try {
      mod.getDatabase();
    } catch (e: any) {
      expect(e.message).toMatch(/数据库模块已不可用/);
      expect(e.message).toMatch(/重启应用/);
    }
  });

  it("DBF-5（修复点）: SQL 调用抛 WASM 陷阱会就地闩锁，且闩锁后不再进入底层实现", async () => {
    const mod = await db();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    // 用一个"类 sql.js 对象"验证护栏三条语义（生产里护栏装在真实 DB 实例上）
    let reached = 0;
    const fakeDb: any = {
      exec: () => {
        reached++;
        throw new Error("RuntimeError: memory access out of bounds");
      },
      run: () => {
        reached++;
      },
      prepare: () => ({}),
    };
    mod.__installFatalGuardForTests(fakeDb);

    expect(() => fakeDb.exec("SELECT 1")).toThrow(/memory access out of bounds/);
    expect(reached, "第一次调用应进入底层").toBe(1);
    expect(mod.isDatabaseFatal(), "护栏应已闩锁致命状态").toBe(true);

    // 闩锁后再调用：抛 DatabaseFatalError，且**不再**进入底层实现
    expect(() => fakeDb.exec("SELECT 1")).toThrow(mod.DatabaseFatalError);
    expect(() => fakeDb.run("SELECT 1")).toThrow(mod.DatabaseFatalError);
    expect(reached, "致命状态下不应再进入底层 SQL 调用").toBe(1);
    err.mockRestore();
  });
});

describe("致命状态下的调用点行为（不刷屏、不重试、可上报）", () => {
  /**
   * ⚠️ 第 18 轮口径变更：这两条守卫原来由**旧引擎的致命闩锁**（`noteDatabaseError` → `dbFatal`）驱动，
   * 而那个闩锁只可能由 sql.js 的 WASM 陷阱触发 —— rust 模式下恒不成立。
   *
   * 守卫本身仍然有用（"本进程没有可用存储时不要反复重试、要一次性如实上报"），
   * 所以判据换成它的新表达：**端口未注册**（`storageUnavailable()`）。
   * 数据库致命闩锁本身的用例（DBF-1..DBF-5）留在本文件上半部分，随旧引擎一起退休。
   */
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
