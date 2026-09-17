/**
 * 数据库维护的边界 —— **端口口径**（本文件由 L1 收尾收窄而来）
 *
 * ## 历史（第 76 波）
 *
 * 事故链：本地 SQLite 整库常驻内存 + 只能整库导出 → 库越大，每次保存的峰值越大 →
 * 渲染进程 out of memory → asm.js 模块 abort → 所有 DB 操作刷屏失败。
 * 当时维护（裁剪 + VACUUM）是这条链上的一环，但**裁剪必须有边界**：
 * `session_events` 不是普通日志，它被当作**状态**读取 ——
 * `event-projection.ts`（4 处）从事件重建投影、`runtime-invariants.ts` 靠回放检查不变量、
 * `preset-discovery` / `feedback` / `postmortem` / `time-context` / `session-search` /
 * `ui-trajectory` / `sync-engine` 都在 `readAll`。截断它 = 悄悄改数据。
 *
 * ---
 *
 * ## ⚠️ L1（删 sql.js）本批的处置：4 条随旧引擎退休，1 条改口径留下
 *
 * 原文件的 MAINT-1..MAINT-4 断言的都是**旧引擎专属的实现**（裸 SQL 截断事件表、
 * `legacy.run("VACUUM")` + `PRAGMA freelist_count` 的空闲页判据），
 * 这些代码路径写死在 `runDatabaseMaintenance` 的 `if (legacy && …)` 分支里 ——
 * 引擎删掉的那天它们连"被测对象"都不存在。**逐条移交如下**（判据：这条断言的行为，
 * 删掉引擎之后由谁守）：
 *
 * | 退休用例 | 原来断言什么 | 覆盖移交给谁 |
 * | --- | --- | --- |
 * | **MAINT-1** 默认不裁剪事件日志 | `keepEventsPerSession` 默认 0 → `prunedEvents === 0`，51 条事件一条不少 | **该风险随引擎一起消失，且新引擎里"悄悄截断事件"这条路径根本不存在**：能删事件的只有快照式压缩 `events.compact`，而它必须先校验**真实存在的锚点**（`src-tauri/codem-db/src/repo.rs::events_compact` 先 `SELECT COUNT(*)` 校验锚点，不存在就报 NOT_FOUND），由 Rust 测试 `compact_requires_real_anchor_and_removes_old_events`（`src-tauri/codem-db/src/migrate.rs:1249`）守 —— 不存在"每会话保留 N 条"这种按 seq 尾部截断的入口 |
 * | **MAINT-2** 遥测按天清理 | `prunedTelemetry === 1`（只有 timestamp=1 的那条被删） | **`maintenance-rust-mode.test.ts` 的 MR-3**（真机 rust 模式下真的调用 `telemetry.prune`，且水位线 `before` 是显式时间戳）+ Rust **`telemetry_prune_requires_watermark`**（`engine_tests.rs:173`，没水位线直接报错，防"以为传了条件其实全表清空"） |
 * | **MAINT-3** 显式开启时 `session_meta` 永不裁 | 裁 40 条 user_message，session_meta 必须留 1 条 | Rust 同一处硬编码 + 同一条测试：`events_compact` 的 DELETE 带 `AND event_type <> 'session_meta'`（`repo.rs:393`），`compact_requires_real_anchor_and_removes_old_events` 里断言"session_meta 不该被压缩删掉"（`migrate.rs:1276-1279`） |
 * | **MAINT-4** 无内容可回收时不做 VACUUM | `vacuumed === false`、`isDatabaseFatal() === false` | **该风险随引擎一起消失**：自由页/VACUUM 是"整库在内存里重写一遍"的产物（`freePageRatio()` 读 `PRAGMA freelist_count`、`legacy.run("VACUUM")`，只对 sql.js 句柄成立）。rust 引擎的**命令白名单里没有 vacuum**（`src-tauri/codem-db/src/lib.rs::COMMANDS`），改 `PRAGMA auto_vacuum` 会被 authorizer 拒绝（Rust `dangerous_pragma_is_denied_but_wal_pragma_is_allowed`），落盘交给 SQLite 自己的 WAL —— "维护为了回收空间把界面卡住"这件事没有实现载体了 |
 *
 * **留下的 MAINT-5（口径改写）**：它的契约是"**维护失败不影响使用，且如实留痕**" ——
 * 这不是引擎语义，而是维护这个功能的可靠性契约（`App.tsx` 每次启动都 `await` 它，
 * 抛错就等于把启动路径交给一个"可选优化"）。
 *
 * 改口径的理由与做法，与第 18 轮把 DBF-6/DBF-7 的判据从 `dbFatal` 换成
 * `storageUnavailable()` **完全一致**：旧的注入点是旧库句柄（`db.run` 被打桩抛错），
 * 而旧句柄在真机 rust 模式下**刻意不存在**（第 18 轮真机缺陷：维护整个函数一行没跑）。
 * 现在维护里唯一还会失败的活路径是**端口命令**，所以注入点换成端口，
 * 断言不变（不抛 / 结果完整 / 留下日志）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { runDatabaseMaintenance } from "../core/storage/maintenance";

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("数据库维护的边界（端口口径）", () => {
  it("MAINT-5: 维护失败不影响使用（异常被吞掉且带日志）", async () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    /** 让维护用到的引擎命令失败（真机上最常见的形态：IPC 层报错） */
    const execute = vi.spyOn(port.data, "execute").mockRejectedValue(new Error("simulated failure"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runDatabaseMaintenance()).resolves.toBeTruthy();

    const commands = execute.mock.calls.map((c) => String(c[0]));
    expect(
      commands,
      "维护必须真的走到端口命令（否则这条用例会因为「什么都没跑」而假绿 —— 第 18 轮真机缺陷的教训）",
    ).toContain("telemetry.prune");

    const logged = warn.mock.calls.flat().map((c) => String(c)).join(" ");
    expect(logged, "失败必须如实留痕：「没跑」与「跑了但失败」在日志里必须能区分").toMatch(/遥测裁剪/);
  });
});
