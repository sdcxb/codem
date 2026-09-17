/**
 * 端到端验证：应用真实路径（initDatabase + createMessage + saveMessages）在
 * 大数据量会话下不再触发 "trap: invalid memory.fill"。
 *
 * 背景：用户改造长会话（124+ 消息、大量工具结果）时，sql-asm.js 固定 21MB
 * 堆耗尽 → memory.fill 越界 → DB 损坏。修复：切换到 sql-asm-memory-growth.js。
 *
 * ---
 *
 * ## ⚠️ L1（删 sql.js）本批判定：**保留**（不删），点名交给"旧库夹具迁移"批次
 *
 * 理由（判据：删掉引擎之后，这些断言的行为由谁守）：
 *
 * | 断言 | 性质 | 谁守 / 怎么处置 |
 * | --- | --- | --- |
 * | `expect(() => persistDatabase()).not.toThrow()`、`await flushDatabase()` | **旧引擎**（整库导出 + WASM 堆） | 随 sql.js 消失：渲染进程里不再有 WASM 堆，也没有"整库导出"这个动作。迁移时**直接删掉这两行断言** |
 * | `listMessages(sessionId)` 读回 400 条 | **产品行为**（大会话可读、不丢） | 等价覆盖在 `db-contract.test.ts` **C19**（250 条逐页读不重不漏、总数等于写入数）与 Rust `messages_list_pagination_is_exact`。夹具迁移时保留本条断言 |
 * | 单条大工具结果在端口表 `tool_calls.result` 里逐字保留（130 KB / 5 MB） | **产品行为**（大 payload 不截断） | 契约等价：`db-contract.test.ts` **C11**（单条往返保真，≈500 KB 中文/emoji/换行逐字比对）+ Rust `message_roundtrip_including_unicode_and_large_content`（1 MiB 正文往返）。**量级差异留着**：见下面的建议 |
 *
 * **保留的实质理由**：这是**唯一**在 130 KB / 5 MB 量级上走**渲染侧**写入链
 * （`createMessage` → 端口 `messages.upsert_index` → `tool_calls`）的用例，
 * 而 rust 引擎对单次查询有**硬上限** `MAX_BYTES_PER_QUERY = 16 MiB`
 * （`src-tauri/codem-db/src/engine.rs:23`，经 `capabilities.max_bytes_per_query` 暴露）。
 * 5 MB 工具结果正好处在这个上限的同一量级 —— 这类"离上限多远"的问题值得留一条用例盯着，
 * 不能因为"它是为 sql.js 堆写的"就连同数据保真一起丢掉。
 *
 * **迁移待办（下一批）**：删掉 `initDatabase/resetDatabase/persistDatabase/flushDatabase` 这些
 * 生命周期调用与两条"不抛 trap"断言，让 `beforeEach` 只依赖端口；
 * 并建议把大 payload 保真同时补进 `db-contract.test.ts`（对真 CLI，而不是只在假端口上）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase, getDatabase, persistDatabase, flushDatabase } from "../core/storage/database";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";

/**
 * 当前用例生效的端口。
 *
 * 本文件里消息/工具结果的落点已经是**端口**（`messages.upsert_index` 单事务写主行 +
 * `generated_files` 两个 JSON 列 + 整批替换 `tool_calls`）—— 断言"大工具结果完整保留"
 * 只能读端口表：消息镜像刻意只装正文那 9 个字段（内存预算，见 message.ts 的说明），
 * 不含 `tool_calls`，所以 `listMessages()[…].toolCalls` 在端口模式下必然为空。
 *
 * 用例自己注册端口（覆盖 setup 的默认端口），让 A 态（`CODEM_TEST_PORT=0`）下也走同一条路，
 * 两种态断言的是同一件事。
 */
function portWithMessages(): FakeStoragePort {
  const port = createFakeStoragePort();
  setStoragePort(port);
  return port;
}

/** 从端口表里取某条消息的某个工具调用 */
function toolCallOf(port: FakeStoragePort, messageId: string, toolCallId: string): Record<string, unknown> | undefined {
  return port
    .__table("tool_calls")
    .find((r) => r.message_id === messageId && r.id === toolCallId);
}

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
    const port = portWithMessages();

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

    // 单条大工具结果完整保留（工具调用写在端口表 `tool_calls` 上）
    const bigTool = toolCallOf(port, "a-100", "tc-100");
    expect(String(bigTool?.result ?? "").length).toBe(130_000);
  }, 60_000);

  it("BIG-002: 单条超大消息（5MB）写入 + export 正常（memory-growth 自动扩堆）", async () => {
    const db = await initDatabase();
    const port = portWithMessages();
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
    expect(rows).toHaveLength(1);
    // 单条超大工具结果完整保留（端口表上的 `tool_calls.result` 有全文）
    const tool = toolCallOf(port, "huge-1", "huge-tc");
    expect(String(tool?.result ?? "").length).toBe(5 * 1024 * 1024);
  }, 60_000);
});
