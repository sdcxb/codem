/**
 * 事件日志的快照式压缩（第 77 波）
 *
 * 为什么需要：本地 SQLite 整库常驻内存 + 只能整库导出，表只增不减 → 库越大，
 * 每次保存的峰值越大 → 渲染进程 out of memory。`session_events` 是"只增不减"的典型
 * （本机实测 2130 行 / 3.8 MB）。
 *
 * 但**不能直接按 seq 截断**：上一波审计发现事件日志被投影当状态读取
 * （`event-projection` 4 处重建投影、`runtime-invariants` 靠回放查不变量、
 * preset-discovery / feedback / postmortem / time-context / session-search /
 * ui-trajectory / sync-engine 都在 readAll）。所以正确做法是：
 *   **先把投影状态固化成 `session_snapshot` 事件，再丢掉它之前的事件** ——
 *   回放 = 快照 + 其后事件，必须与完整回放**等价**。
 *
 * 本文件的核心就是那条等价性（SNAP-2）：它一旦不成立，"裁剪"就变成"悄悄改数据"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  getDatabase,
  initDatabase,
  resetDatabaseFatalState,
  resetSaveFailureState,
  runDatabaseMaintenance,
} from "../core/storage/database";
import { getEventLog } from "../core/storage/event-log";
import { getEventProjection } from "../core/storage/event-projection";

beforeEach(async () => {
  installTauriStub();
  resetSaveFailureState();
  resetDatabaseFatalState();
  await initDatabase();
  const db = getDatabase();
  db.run("DELETE FROM session_events");
  db.run(
    "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES ('s1','','t',0,0,0)",
  );
});

afterEach(() => {
  resetDatabaseFatalState();
  resetSaveFailureState();
  delete (window as any).__TAURI__;
});

/** 造一段有代表性的会话事件流：多轮 user → assistant(文本+工具调用) → tool_result */
function seedSession(sessionId: string, turns: number): void {
  const log = getEventLog();
  log.append(sessionId, "session_meta", { preset: "standard" });
  for (let i = 0; i < turns; i++) {
    log.append(sessionId, "user_message", { messageId: `u${i}`, content: `问题 ${i}` });
    log.append(sessionId, "assistant_text", { messageId: `a${i}`, content: `回答 ${i}` });
    log.append(sessionId, "tool_call", {
      messageId: `a${i}`,
      toolCallId: `tc${i}`,
      toolName: "bash",
      args: { command: `echo ${i}` },
    });
    log.append(sessionId, "tool_result", { toolCallId: `tc${i}`, content: `输出 ${i}` });
  }
}

describe("事件日志快照式压缩", () => {
  it("SNAP-1: 压缩会写入快照事件并删掉它之前的事件（session_meta 保留）", () => {
    seedSession("s1", 20);
    const log = getEventLog();
    const before = log.readAll("s1").length;
    expect(before).toBe(1 + 20 * 4);

    const projection = getEventProjection();
    const result = log.compactWithSnapshot("s1", (events) => ({ messages: projection.projectFromEvents(events) }));

    expect(result.snapshotSeq).toBeGreaterThan(0);
    expect(result.removedEvents).toBeGreaterThan(0);
    const after = log.readAll("s1");
    expect(after.length).toBeLessThan(before);
    expect(after.some((e) => e.type === "session_snapshot")).toBe(true);
    // 预设归属/反馈状态依赖这条，永不能删
    expect(after.filter((e) => e.type === "session_meta")).toHaveLength(1);
  });

  it("SNAP-2: **回放等价性** —— 压缩后投影与压缩前逐条一致（这条不成立，裁剪就是改数据）", () => {
    seedSession("s1", 25);
    const projection = getEventProjection();
    const beforeMessages = projection.projectAll("s1");
    expect(beforeMessages.length).toBeGreaterThan(0);

    getEventLog().compactWithSnapshot("s1", (events) => ({ messages: projection.projectFromEvents(events) }));
    const afterMessages = projection.projectAll("s1");

    expect(afterMessages.length).toBe(beforeMessages.length);
    expect(afterMessages.map((m) => [m.id, m.role, m.content])).toEqual(
      beforeMessages.map((m) => [m.id, m.role, m.content]),
    );
  });

  it("SNAP-3: 压缩后**新增事件照样能接上**（快照不会吞掉后续消息）", () => {
    seedSession("s1", 10);
    const projection = getEventProjection();
    const before = projection.projectAll("s1");

    getEventLog().compactWithSnapshot("s1", (events) => ({ messages: projection.projectFromEvents(events) }));

    // 压缩之后继续对话
    const log = getEventLog();
    log.append("s1", "user_message", { messageId: "u-new", content: "压缩之后的问题" });
    log.append("s1", "assistant_text", { messageId: "a-new", content: "压缩之后的回答" });

    const after = projection.projectAll("s1");
    expect(after.length).toBe(before.length + 2);
    expect(after[after.length - 2].content).toBe("压缩之后的问题");
    expect(after[after.length - 1].content).toBe("压缩之后的回答");
  });

  it("SNAP-4: keepEvents 可以保留最近若干条事件（细节与压缩兼顾）", () => {
    seedSession("s1", 30);
    const log = getEventLog();
    const projection = getEventProjection();

    const result = log.compactWithSnapshot(
      "s1",
      (events) => ({ messages: projection.projectFromEvents(events) }),
      { keepEvents: 8 },
    );

    expect(result.removedEvents).toBeGreaterThan(0);
    // 快照 + 保留的尾部事件（+ session_meta）
    const remaining = log.readAll("s1").filter((e) => e.type !== "session_meta");
    expect(remaining.length).toBe(9); // 8 条保留 + 1 条快照
  });

  it("SNAP-5: 维护只在事件超阈值时才压缩，且压缩后仍可读（不破坏会话）", async () => {
    seedSession("s1", 5); // 21 条事件，低于阈值
    const small = await runDatabaseMaintenance({ compactEventsOver: 500 });
    expect(small.compactedSessions).toBe(0);

    getDatabase().run(
      "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES ('s2','','t',0,0,0)",
    );
    seedSession("s2", 5);
    const big = await runDatabaseMaintenance({ compactEventsOver: 10 });
    expect(big.compactedSessions).toBeGreaterThan(0);
    // 压缩后投影依然可用
    expect(getEventProjection().projectAll("s2").length).toBeGreaterThan(0);
  });

  it("SNAP-6: 压缩失败不影响使用（异常被吞掉并记日志）", async () => {
    seedSession("s1", 5);
    const db = getDatabase();
    const originalRun = db.run.bind(db);
    (db as any).run = () => {
      throw new Error("simulated failure");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runDatabaseMaintenance({ compactEventsOver: 1 })).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalled();
    (db as any).run = originalRun;
    warn.mockRestore();
  });
});
