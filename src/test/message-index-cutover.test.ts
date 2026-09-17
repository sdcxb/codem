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
import { RustStoragePort } from "../core/storage/rust-port";

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

describe("消息读路径（P3 第 7 段）—— 读写必须同处，隐藏状态不能过时", () => {
  /** 带消息镜像的端口：`messages.list` 返回给定行 */
  function portWithRows(rows: Array<Record<string, unknown>>) {
    const executed: Array<{ cmd: string; params: Record<string, unknown> }> = [];
    const transport = {
      invokeCommand: async (command: string, params?: Record<string, unknown>) => {
        executed.push({ command, params: params ?? {} });
        if (command === "messages.list") {
          return { ok: true, result: { items: rows, has_more: false, next_cursor: null } } as never;
        }
        return { ok: true, result: {} } as never;
      },
      invokeBatch: async () => ({ ok: true, result: {} }) as never,
      health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
      integrityCheck: async () => ({ ok: true, result: {} }) as never,
      checkpoint: async () => ({ ok: true, result: {} }) as never,
      capabilities: async () => ({}) as never,
    };
    const port = new RustStoragePort(transport as never, () => {});
    return { port, executed };
  }

  it("MSG-7: 已加载的会话从镜像读（含 hidden 过滤语义一致）", async () => {
    const { port } = portWithRows([
      { id: "a", session_id: "s1", role: "user", content: "一", timestamp: 1, status: "done", hidden: 0 },
      { id: "b", session_id: "s1", role: "assistant", content: "二", timestamp: 2, status: "done", hidden: 0 },
    ]);
    setStoragePort(port);
    port.warmupMessages("s1");
    await settle();
    expect(port.messages.isLoaded("s1")).toBe(true);

    const { listMessagesFromIndex } = await import("../core/storage/message");
    const list = listMessagesFromIndex("s1");
    expect(list.map((m) => m.id)).toEqual(["a", "b"]);
    expect(legacyQuery, "已路由到镜像后不得读旧库").toBe(0);
  });

  it("MSG-8: **hidden 状态来自镜像**（这是 P3 第 6 段留下的隐患，必须钉住）", async () => {
    // 镜像里 b 是 hidden=1（已被压缩）→ 它不能出现在可见列表里，
    // 且 hiddenMessageIds 必须返回它（否则合并时会被复活，上下文永不缩小）
    const { port } = portWithRows([
      { id: "a", session_id: "s1", role: "user", content: "一", timestamp: 1, status: "done", hidden: 0 },
      { id: "b", session_id: "s1", role: "assistant", content: "被压缩", timestamp: 2, status: "done", hidden: 1 },
    ]);
    setStoragePort(port);
    port.warmupMessages("s1");
    await settle();

    const { listMessagesFromIndex, listMessagesMerged } = await import("../core/storage/message");
    const visible = listMessagesFromIndex("s1");
    expect(visible.map((m) => m.id), "hidden 行不进可见列表").toEqual(["a"]);
    // 合并后也必须只有 a（日志为空时以索引为准）
    expect(listMessagesMerged("s1").map((m) => m.id)).toEqual(["a"]);
    expect(legacyQuery, "hidden 判定不得回落到旧库（那里状态已过时）").toBe(0);
  });

  it("MSG-9: 未加载完的会话**不路由，也不回退旧库**（B 态两态判据）", async () => {
    /**
     * 这条契约在第 44 轮（B0-2）被**改写**过，原断言是"未加载完应走旧库"。
     *
     * 那个旧规则被证明是错的：端口已注册（rust）时旧库在真机上刻意不加载，
     * "回退旧库"要么抛错、要么（在测试基座里）写到一份**不会被读路径看到**的库里 ——
     * 也就是本进程内的读写分裂（`note-links-order.test.ts` 的 NL-2 抓到过同一形态）。
     * 现在规则是：
     *   - B 态（端口在 rust、镜像未就绪）→ 不碰旧库，返回**该域的合理空结果**；
     *   - A 态（端口未注册 / wasm 回滚）→ 旧库是唯一数据源，必须回退。
     * 两种态各自可测，删回退时才不必赌"端口总是就绪"。
     */
    const { port } = portWithRows([
      { id: "a", session_id: "s2", role: "user", content: "一", timestamp: 1, status: "done", hidden: 0 },
    ]);
    setStoragePort(port);
    // 刻意不 warmup：s2 未加载
    const { listMessagesFromIndex } = await import("../core/storage/message");
    const list = listMessagesFromIndex("s2");
    expect(list, "B 态：镜像未就绪时给空，而不是半个集合").toEqual([]);
    expect(legacyQuery, "B 态：索引读**不得**回退旧库（那里在 rust 模式下刻意不存在）").toBe(0);

    // A 态对照：端口撤掉（等价于回滚开关切到 wasm）→ 必须回退旧库
    setStoragePort(null);
    listMessagesFromIndex("s2");
    expect(legacyQuery, "A 态：端口不在时旧库是唯一数据源，必须读它").toBeGreaterThan(0);
  });

  it("MSG-10: 写入成功后镜像立刻可读（不必等下次加载）", async () => {
    const { port } = portWithRows([]);
    setStoragePort(port);
    port.warmupMessages("s3");
    await settle();
    expect(port.messages.isLoaded("s3")).toBe(true);

    const { createMessage, listMessagesFromIndex } = await import("../core/storage/message");
    createMessage({ id: "n1", role: "user", content: "新消息", timestamp: 5 } as never, "s3");
    await settle();
    const list = listMessagesFromIndex("s3");
    expect(list.map((m) => m.id), "刚创建的消息必须立刻可见").toEqual(["n1"]);
    expect(list[0].content).toBe("新消息");
  });
});
