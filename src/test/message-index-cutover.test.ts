/**
 * 消息索引写分流契约（P3 第 6 段）。
 *
 * ## 这一段与只追加面不同的地方
 *
 * `createMessage` / `updateMessage` 的结构本来就是
 * **① 权威日志（先写、必须成功）→ ② 索引（尽力而为、失败上报）**。
 * 索引侧早已明确是"best-effort + 可重建"，所以把 ② 换成"异步发往 Rust"不引入
 * 新的丢数据风险。这里要钉住的正是这条**顺序与优先级**：
 *
 * 1. 权威日志**永远先写**，且不因索引失败而受影响；
 * 2. 端口是 rust 时索引写走 `messages.upsert_index`（单事务复合写）；
 * 3. 端口未注册 / 是 wasm（回滚）时**完全不接手**，走原路径；
 * 4. 更新路径拿不到 base 行时回退原路径（不猜数据）；
 * 5. 传参形状必须与 Rust 契约一致（snake_case、tool_calls 整体替换语义）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";

const appendCalls: Array<{ sessionId: string; id: string; content: string }> = [];
vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async (sessionId: string, message: { id: string; content: string }) => {
    appendCalls.push({ sessionId, id: message.id, content: message.content });
  },
  appendMessageTombstone: async () => {},
  readSessionMessages: () => [],
}));
const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
}));
// 旧库不可用（rust 模式下不该用它）；需要时由测试自己设置
let legacyQuery = 0;
vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    legacyQuery++;
    return { exec: () => [], run: () => {} };
  },
  persistDatabase: () => {},
  isFts5Available: () => false,
  isDatabaseFatal: () => false,
  noteDatabaseError: () => true,
}));
vi.mock("../core/storage/write-guard", () => ({
  runGuarded: () => undefined,
}));
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({ append: () => ({ seq: 1 }), appendBatch: () => [] }),
}));

function rustPortRecorder(opts: { failIndex?: boolean } = {}) {
  const executed: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  const port = {
    kind: "rust" as const,
    engine: {} as never,
    config: {} as never,
    append: {} as never,
    events: {} as never,
    configDomain: {} as never,
    data: {
      async execute(cmd: string, params: Record<string, unknown> = {}) {
        executed.push({ cmd, params });
        if (opts.failIndex) throw new Error("索引写入失败（模拟）");
        return { written: 1 };
      },
      async query() {
        return { items: [], hasMore: false };
      },
      async write() {
        return { written: 0 };
      },
    },
  };
  return { port, executed };
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1));
};

afterEach(() => {
  setStoragePort(null);
  appendCalls.length = 0;
  failures.length = 0;
  legacyQuery = 0;
  vi.restoreAllMocks();
});

describe("消息索引写分流", () => {
  it("MSG-1: 权威日志**先写**，索引另外异步发往 Rust（顺序与优先级不变）", async () => {
    const { port, executed } = rustPortRecorder();
    setStoragePort(port);
    const { createMessage } = await import("../core/storage/message");

    createMessage(
      {
        id: "m1",
        role: "user",
        content: "你好",
        timestamp: 1000,
        status: "done",
      } as never,
      "s1",
    );

    expect(appendCalls, "权威日志必须先写且同步发起").toEqual([{ sessionId: "s1", id: "m1", content: "你好" }]);
    await settle();
    expect(executed.some((e) => e.cmd === "messages.upsert_index"), "索引写应发往 Rust").toBe(true);
  });

  it("MSG-2: 发往 Rust 的参数形状与契约一致（snake_case + JSON 列 + tool_calls）", async () => {
    const { port, executed } = rustPortRecorder();
    setStoragePort(port);
    const { createMessage } = await import("../core/storage/message");

    createMessage(
      {
        id: "m2",
        role: "assistant",
        content: "回答",
        reasoning: "推理",
        timestamp: 2000,
        model: "deepseek",
        status: "done",
        generatedFiles: [{ path: "a.ts" }],
        retrievedSources: [{ id: "src1" }],
        toolCalls: [
          { id: "t1", tool: "read_file", args: { path: "a" }, status: "done", result: "A" },
        ],
      } as never,
      "s1",
    );
    await settle();

    const call = executed.find((e) => e.cmd === "messages.upsert_index");
    expect(call).toBeTruthy();
    expect(call?.params).toMatchObject({
      id: "m2",
      session_id: "s1",
      role: "assistant",
      content: "回答",
      reasoning: "推理",
      model: "deepseek",
      status: "done",
      timestamp: 2000,
    });
    expect(call?.params.generated_files, "JSON 列按原值传（数组）").toEqual([{ path: "a.ts" }]);
    expect(call?.params.retrieved_sources).toEqual([{ id: "src1" }]);
    expect(call?.params.tool_calls, "tool_calls 必须整批传（Rust 侧整体替换）").toEqual([
      { id: "t1", tool: "read_file", args: { path: "a" }, result: "A", status: "done", metadata: null },
    ]);
  });

  it("MSG-3: 未提供 toolCalls 时传 undefined（Rust 侧语义是「不动」，不是「清空」）", async () => {
    const { port, executed } = rustPortRecorder();
    setStoragePort(port);
    const { createMessage } = await import("../core/storage/message");
    createMessage({ id: "m3", role: "user", content: "x", timestamp: 1 } as never, "s1");
    await settle();
    const call = executed.find((e) => e.cmd === "messages.upsert_index");
    expect(call?.params.tool_calls, "缺省必须是 undefined/null，不能是空数组").toBeUndefined();
  });

  it("MSG-4: 端口未注册（默认/回滚）时**完全不接手**，走原 WASM 路径", async () => {
    setStoragePort(null);
    const { createMessage } = await import("../core/storage/message");
    createMessage({ id: "m4", role: "user", content: "x", timestamp: 1 } as never, "s1");
    await settle();
    expect(appendCalls, "权威日志仍然要写").toHaveLength(1);
    expect(legacyQuery, "回滚模式下索引写应落到旧库").toBeGreaterThan(0);
  });

  it("MSG-5: 端口是 wasm 时同样不接手（回滚开关生效）", async () => {
    setStoragePort({
      kind: "wasm",
      engine: {} as never,
      data: {} as never,
      config: {} as never,
      append: {} as never,
    });
    const { createMessage } = await import("../core/storage/message");
    createMessage({ id: "m5", role: "user", content: "x", timestamp: 1 } as never, "s1");
    await settle();
    expect(legacyQuery, "wasm 模式下索引写应落到旧库").toBeGreaterThan(0);
    expect(failures, "不应报索引失败").toEqual([]);
  });

  it("MSG-6: 索引写失败不抛、不影响权威日志，且如实上报", async () => {
    const { port } = rustPortRecorder({ failIndex: true });
    setStoragePort(port);
    const { createMessage } = await import("../core/storage/message");

    expect(() =>
      createMessage({ id: "m6", role: "user", content: "x", timestamp: 1 } as never, "s1"),
    ).not.toThrow();
    await settle();
    expect(appendCalls, "权威日志已写好，不因索引失败回滚").toHaveLength(1);
    expect(failures.some((n) => n.includes("索引"))).toBe(true);
  });
});
