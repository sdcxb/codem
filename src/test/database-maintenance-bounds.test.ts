/**
 * 数据库维护的两条硬规矩（第 76 波审计）
 *
 * 事故链：本地 SQLite 整库常驻内存 + 只能整库导出 → 库越大，每次保存的峰值越大 →
 * 渲染进程 out of memory → asm.js 模块 abort → 所有 DB 操作刷屏失败。
 *
 * 维护（裁剪 + VACUUM）是这条链上的一环，但**裁剪必须有边界**：
 * `session_events` 不是普通日志，它被当作**状态**读取 ——
 * `event-projection.ts`（4 处）从事件重建投影、`runtime-invariants.ts` 靠回放检查不变量、
 * `preset-discovery` / `feedback` / `postmortem` / `time-context` / `session-search` /
 * `ui-trajectory` / `sync-engine` 都在 `readAll`。截断它 = 悄悄改数据，
 * 表现会是"投影缺段""不变量检查报事件序列不完整"这类**很难往维护上想**的怪现象。
 *
 * 所以本文件守两条：
 *   1. 默认**不裁剪**事件（0 = 关闭），只在显式开启时才裁，且 `session_meta` 永不裁；
 *   2. VACUUM 有护栏（大库 / 空闲页太少时跳过并说明理由）—— 维护本身不能再成为新的卡顿源。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function installTauriStub(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import {
  flushDatabase,
  getDatabase,
  initDatabase,
  isDatabaseFatal,
  resetDatabaseFatalState,
  resetSaveFailureState,
  runDatabaseMaintenance,
  __resetDirtyForTests,
} from "../core/storage/database";

beforeEach(async () => {
  vi.useFakeTimers();
  installTauriStub();
  resetSaveFailureState();
  resetDatabaseFatalState();
  __resetDirtyForTests();
  await initDatabase();
  // 造一个"事件很多"的会话，再加上一条很久以前的遥测
  const db = getDatabase();
  db.run("DELETE FROM session_events");
  db.run("DELETE FROM telemetry_events");
  // 外键：事件与遥测都挂在会话上，先建会话（project_id 用初始化时种下的全局项目 ""）
  db.run(
    "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES ('s1','','t',0,0,0)",
  );
  db.run(
    "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES ('s1','session_meta','{}',0)",
  );
  for (let i = 0; i < 50; i++) {
    db.run(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES ('s1','user_message',?,?)",
      [`{"i":${i}}`, i],
    );
  }
  db.run(
    "INSERT INTO telemetry_events (id, session_id, event_name, event_data, timestamp) VALUES ('t-old','s1','e','{}',1)",
  );
  db.run(
    `INSERT INTO telemetry_events (id, session_id, event_name, event_data, timestamp) VALUES ('t-new','s1','e','{}',${Date.now()})`,
  );
});

afterEach(() => {
  vi.useRealTimers();
  resetDatabaseFatalState();
  resetSaveFailureState();
  delete (window as any).__TAURI__;
});

describe("数据库维护的边界", () => {
  it("MAINT-1: 默认不裁剪事件日志（它是被当作状态读取的，不是普通日志）", () => {
    const before = Number(getDatabase().exec("SELECT count(*) FROM session_events")[0].values[0][0]);
    expect(before).toBe(51);

    const result = runDatabaseMaintenance();

    expect(result.prunedEvents).toBe(0);
    const after = Number(getDatabase().exec("SELECT count(*) FROM session_events")[0].values[0][0]);
    expect(after).toBe(before); // 投影/不变量/预设发现都还在读它
  });

  it("MAINT-2: 遥测按天清理（只用于本地统计，删掉不影响任何状态重建）", () => {
    const result = runDatabaseMaintenance({ keepTelemetryDays: 7 });

    expect(result.prunedTelemetry).toBe(1); // 只有那条 timestamp=1 的被删
    const ids = getDatabase().exec("SELECT id FROM telemetry_events")[0].values.map((r) => r[0]);
    expect(ids).toEqual(["t-new"]);
  });

  it("MAINT-3: 显式开启事件裁剪时，session_meta 永不裁（预设归属/反馈状态靠它）", () => {
    const result = runDatabaseMaintenance({ keepEventsPerSession: 10 });

    expect(result.prunedEvents).toBe(40); // 50 条 user_message 保留 10 条
    const rows = getDatabase().exec("SELECT event_type FROM session_events")[0].values.map((r) => r[0]);
    expect(rows.filter((t) => t === "session_meta")).toHaveLength(1);
    expect(rows.filter((t) => t === "user_message")).toHaveLength(10);
  });

  it("MAINT-4: 无内容可回收时不做 VACUUM（维护不能变成新的卡顿源）", async () => {
    // 遥测一条都不过期 → 没有任何裁剪 → 不应触发 VACUUM
    getDatabase().run("DELETE FROM telemetry_events WHERE id = 't-old'");
    const result = runDatabaseMaintenance({ keepTelemetryDays: 3650 });
    expect(result.prunedTelemetry).toBe(0);
    expect(result.vacuumed).toBe(false);
    await flushDatabase();
    expect(isDatabaseFatal()).toBe(false);
  });

  it("MAINT-5: 维护失败不影响使用（异常被吞掉且带日志）", () => {
    const db = getDatabase();
    const originalRun = db.run.bind(db);
    (db as any).run = () => {
      throw new Error("simulated failure");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => runDatabaseMaintenance()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    (db as any).run = originalRun;
    warn.mockRestore();
  });
});
