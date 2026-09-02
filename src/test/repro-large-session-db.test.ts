/**
 * 端到端验证：应用真实路径（initDatabase + createMessage + saveMessages）在
 * 大数据量会话下不再触发 "trap: invalid memory.fill"。
 *
 * 背景：用户改造长会话（124+ 消息、大量工具结果）时，sql-asm.js 固定 21MB
 * 堆耗尽 → memory.fill 越界 → DB 损坏。修复：切换到 sql-asm-memory-growth.js。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase, getDatabase, persistDatabase, flushDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";

describe("大数据量会话：database 使用 memory-growth 版本不崩溃", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    // sessions 表有 FOREIGN KEY (project_id)，需先建 project + session
    ProjectStorage.createProject({
      id: "big-proj",
      name: "大数据项目",
      path: "C:\\big",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  });

  function ensureSession(sessionId: string): void {
    SessionStorage.createSession({
      id: sessionId,
      projectId: "big-proj",
      title: "大数据会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
  }

  it("BIG-001: 写入 200 条消息（含大工具结果，总量 > 25MB）不触发 trap，且可持久化", async () => {
    const db = await initDatabase();
    expect(db).toBeDefined();

    const sessionId = "big-session-001";
    ensureSession(sessionId);
    // 每轮：1 user + 1 assistant(带大工具结果) = 2 条消息
    // 200 轮 × ~130KB 工具结果 ≈ 26MB > 固定堆 21MB
    for (let i = 0; i < 200; i++) {
      MessageStorage.createMessage({
        id: `u-${i}`,
        role: "user",
        content: `第 ${i} 轮请求`,
        timestamp: Date.now() + i,
        status: "done",
      }, sessionId);
      MessageStorage.createMessage({
        id: `a-${i}`,
        role: "assistant",
        content: `第 ${i} 轮回复`,
        timestamp: Date.now() + i + 1,
        status: "done",
        toolCalls: [{
          id: `tc-${i}`,
          tool: "bash",
          args: { command: "echo test" },
          result: "x".repeat(130_000), // 130KB 工具结果
          status: "done",
        }],
      }, sessionId);
    }

    // 关键断言：export（persistDatabase 的核心）不抛 trap
    expect(() => {
      persistDatabase();
    }).not.toThrow();

    await flushDatabase();

    // 数据可读回
    const rows = MessageStorage.listMessages(sessionId);
    expect(rows.length).toBe(400);

    // 单条大工具结果完整保留
    const assistantMsg = rows.find((m: any) => m.id === "a-100");
    const bigTool = assistantMsg?.toolCalls?.find((tc: any) => tc.id === "tc-100");
    expect(bigTool?.result?.length).toBe(130_000);
  }, 60_000);

  it("BIG-002: 单条超大消息（5MB）写入 + export 正常（memory-growth 自动扩堆）", async () => {
    const db = await initDatabase();
    const sessionId = "big-session-002";
    ensureSession(sessionId);
    MessageStorage.createMessage({
      id: "huge-1",
      role: "assistant",
      content: "超大内容",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [{
        id: "huge-tc",
        tool: "read",
        args: { path: "C:\\big.txt" },
        result: "z".repeat(5 * 1024 * 1024), // 5MB
        status: "done",
      }],
    }, sessionId);

    expect(() => { persistDatabase(); }).not.toThrow();
    await flushDatabase();

    const rows = MessageStorage.listMessages(sessionId);
    const tool = rows[0]?.toolCalls?.[0];
    expect(tool?.result?.length).toBe(5 * 1024 * 1024);
  }, 60_000);
});
