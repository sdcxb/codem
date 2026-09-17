/**
 * 端到端验证：应用真实路径（createMessage → 端口 `messages.upsert_index` → `tool_calls`）
 * 在大数据量会话下不崩、且大 payload 逐字保真。
 *
 * 背景：用户改造长会话（124+ 消息、大量工具结果）时，sql-asm.js 固定 21MB
 * 堆耗尽 → memory.fill 越界 → DB 损坏。**那个堆已随 sql.js 一起消失**（L1），
 * 但"大 payload 在渲染侧写入链上不截断"这条**产品行为**必须继续守着。
 *
 * ## 第 18 轮（L1）：夹具已迁到端口
 *
 * 判据逐条复核过（判据 = "删掉引擎之后，这条断言的行为由谁守"）：
 *
 * | 断言 | 性质 | 处置 |
 * | --- | --- | --- |
 * | `persistDatabase()/flushDatabase()` 不抛 trap | **旧引擎**（整库导出 + WASM 堆） | **已删**：渲染进程里不再有 WASM 堆，也没有"整库导出"这个动作 |
 * | `listMessages()` 读回 400 条 | 产品行为（大会话可读、不丢） | **保留**（等价覆盖：`db-contract.test.ts` C19 + Rust `messages_list_pagination_is_exact`） |
 * | 单条大工具结果在 `tool_calls.result` 里逐字保留（130 KB / 5 MB） | 产品行为（大 payload 不截断） | **保留**（契约等价：**C27**（**真 CLI** 走同一写入链 `messages.upsert_index` → `tool_calls.list` 读回，130 KB 与 5 MB 两个量级**逐字比对**，并断言 `max_bytes_per_query` > 5 MB）+ C11 ≈500 KB 往返 + Rust `message_roundtrip_including_unicode_and_large_content` 1 MiB） |
 *
 * **为什么量级要留着**：这是**唯一**在 130 KB / 5 MB 量级上走**渲染侧**写入链的用例（渲染侧 = 假端口，
 * 断言"我们的写入链不截断"），而**引擎侧的同量级**由 **C27** 在真 CLI 上守
 * （同一条 `messages.upsert_index → tool_calls.list` 路径，130 KB / 5 MB 逐字比对）。
 * 两侧都必要：一个证明"我们没截断"，一个证明"引擎没截断"。
 * rust 引擎对单次查询有硬上限 `MAX_BYTES_PER_QUERY = 16 MiB`
 * （`src-tauri/codem-db/src/engine.rs:23`）。5 MB 正处在这个上限的同一量级 ——
 * "离上限多远"值得留一条用例盯着（C27 里也断言了这条上限 > 5 MB）。
 */
import { describe, it, expect, beforeEach } from "vitest";
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

describe("大数据量会话：大 payload 在渲染侧写入链上不崩、不截断", () => {
  beforeEach(() => {
    // 干净端口 = 干净数据面（第 18 轮：原来这里的 resetDatabase/initDatabase 已删）
    setStoragePort(createFakeStoragePort());
    localStorage.clear();
    // sessions 有 FOREIGN KEY (project_id)：先建 project + session
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

  it("BIG-001: 写入 200 条消息（含大工具结果，总量 > 25MB）不崩，且可读回", async () => {
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

    // 数据可读回（第 18 轮：原来的 persistDatabase/flushDatabase"不抛 trap"断言随引擎删除）
    const rows = MessageStorage.listMessages(sessionId);
    expect(rows.length).toBe(400);

    // 单条大工具结果完整保留（工具调用写在端口表 `tool_calls` 上）
    const bigTool = toolCallOf(port, "a-100", "tc-100");
    expect(String(bigTool?.result ?? "").length).toBe(130_000);
  }, 60_000);

  it("BIG-002: 单条超大消息（5MB 工具结果）写入链正常、逐字保真", async () => {
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

    const rows = MessageStorage.listMessages(sessionId);
    expect(rows).toHaveLength(1);
    // 单条超大工具结果完整保留（端口表上的 `tool_calls.result` 有全文）
    const tool = toolCallOf(port, "huge-1", "huge-tc");
    expect(String(tool?.result ?? "").length).toBe(5 * 1024 * 1024);
  }, 60_000);
});
