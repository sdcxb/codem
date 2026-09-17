/**
 * 消息域的**端口覆盖**契约（P5 第 11 段）。
 *
 * ## 这一批修的是什么
 *
 * L3 审计（"端口没接手就回退旧库"的清单）在 message.ts 上暴露出一批**真机缺陷** ——
 * 它们的共同形态是"函数只有旧库一条实现"，而 rust 引擎下旧库**刻意不加载**：
 *
 * | 函数 | 真机形态 | 用户可见后果 |
 * | --- | --- | --- |
 * | `updateMessageContent` | `getDatabase()` 抛（调用点只 `console.error`） | 编辑并重发：**编辑重启后回退** |
 * | `deleteMessagesAfter` | 同上 | 编辑并重发：被删的旧回复**从日志复活** |
 * | `loadFeedback` | `getDatabase()` 在 try **外面** | 点历史消息的赞/踩 → 抛错 |
 * | `trimIndexedMessages` | 启动维护里抛 | 索引裁剪**从未执行过** |
 * | `rebuildSessionFts` | `isFts5Available()` 恒 false → 直接返回 | 新消息**永远搜不到** |
 *
 * 所以这里的断言只有两条主线：
 * 1. **B 态（端口在 rust）不得碰旧库** —— 用 `legacyQuery` 计数守住（0 次）；
 * 2. **写/删必须真的落到端口**（命令 + 参数形状），并且**权威日志/墓碑照写** ——
 *    少任何一条都会退化成"假成功"或"消息复活"。
 *
 * A 态（端口未注册 / wasm 回滚）的行为由 `message-index-cutover.test.ts` 的 MSG-4/5/9 守住：
 * 那几条断言"端口不在时必须回退旧库"，与本文件正好构成两态对照。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

/** 权威日志的写入记录（墓碑单独记，因为"删了必须留墓碑"是数据完整性的关键） */
const logAppends: Array<{ sessionId: string; id: string; content: string }> = [];
const tombstones: Array<{ sessionId: string; id: string }> = [];
/** 日志里"确实已经持久化"的 id（耐久性不变量用） */
let durableIds = new Set<string>();

vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async (sessionId: string, message: { id: string; content: string }) => {
    logAppends.push({ sessionId, id: message.id, content: message.content });
  },
  appendMessageTombstone: async (sessionId: string, id: string) => {
    tombstones.push({ sessionId, id });
  },
  readSessionMessages: () => [],
  durableMessageIds: async () => durableIds,
  flushSessionLogWrites: async () => {},
}));

/** 旧库不可达（B 态下它就是"刻意不存在"）：任何一次访问都会被计数 */
let legacyQuery = 0;
vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    legacyQuery++;
    throw new Error("Database not initialized. Call initDatabase() first.");
  },
  tryGetDatabase: () => {
    legacyQuery++;
    return null;
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

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1));
};

afterEach(() => {
  setStoragePort(null);
  logAppends.length = 0;
  tombstones.length = 0;
  legacyQuery = 0;
  durableIds = new Set();
  vi.restoreAllMocks();
});

/** 起一个带消息行的假端口（并预热会话镜像，模拟"用户正在这个会话里"） */
function portWithMessages(rows: Array<Record<string, unknown>>, sessionId = "s1") {
  const port = createFakeStoragePort({ seed: { messages: rows } });
  setStoragePort(port);
  port.messages.ensureLoaded(sessionId);
  return port;
}

const msg = (id: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  id,
  session_id: "s1",
  role: "user",
  content: `content-${id}`,
  reasoning: null,
  timestamp,
  model: null,
  status: "done",
  hidden: 0,
  ...extra,
});

describe("写路径覆盖（rust 模式）", () => {
  it("PC-1: updateMessageContent 走端口 + 写权威日志（不再只有旧库一条路）", async () => {
    const port = portWithMessages([msg("m1", 1)]);
    const { updateMessageContent } = await import("../core/storage/message");

    updateMessageContent("m1", "编辑后的正文");
    await settle();

    const upsert = port.__writes().find((w) => w.command === "messages.upsert_index");
    expect(upsert, "编辑必须落到端口（否则重启后回退）").toBeTruthy();
    expect((upsert?.params as Record<string, unknown>)?.content).toBe("编辑后的正文");
    expect(logAppends.at(-1)?.content, "权威日志也要更新（它才是权威副本）").toBe("编辑后的正文");
    expect(legacyQuery, "B 态不得碰旧库").toBe(0);
  });

  it("PC-2: deleteMessagesAfter 按镜像算候选 + 真删 + 留墓碑 + 清全文索引", async () => {
    const port = portWithMessages([msg("m1", 1), msg("m2", 2), msg("m3", 3)]);
    const { deleteMessagesAfter } = await import("../core/storage/message");

    const deleted = deleteMessagesAfter("s1", "m2");
    await settle();

    expect(deleted, "m2 之后的消息：m3（不含自身）").toBe(1);
    const del = port.__writes().filter((w) => w.command === "messages.delete").at(-1);
    expect((del?.params as Record<string, unknown>)?.ids).toEqual(["m3"]);
    expect(port.__table("messages").map((r) => r.id), "端口侧也要真的少一行").toEqual(["m1", "m2"]);
    expect(tombstones, "删了不写墓碑 = 下次从日志合并时复活").toEqual([{ sessionId: "s1", id: "m3" }]);
    expect(port.__writes().some((w) => w.command === "fts.remove"), "虚拟表没有级联，要显式清").toBe(true);
    expect(legacyQuery, "B 态不得碰旧库").toBe(0);
  });

  it("PC-2b: deleteMessagesAfter(includeSelf) 把目标自身也算进去", async () => {
    const port = portWithMessages([msg("m1", 1), msg("m2", 2), msg("m3", 3)]);
    const { deleteMessagesAfter } = await import("../core/storage/message");

    expect(deleteMessagesAfter("s1", "m2", { includeSelf: true })).toBe(2);
    await settle();
    const del = port.__writes().filter((w) => w.command === "messages.delete").at(-1);
    expect((del?.params as Record<string, unknown>)?.ids).toEqual(["m2", "m3"]);
  });

  it("PC-3: 镜像未就绪 → 同步返回 0（不假装删了），就绪后自动补做且只做一次", async () => {
    const port = createFakeStoragePort({ seed: { messages: [msg("m1", 1), msg("m2", 2)] } });
    setStoragePort(port);
    // 刻意不 ensureLoaded：模拟"镜像还没加载完"
    const { deleteMessagesAfter } = await import("../core/storage/message");

    expect(deleteMessagesAfter("s1", "m1"), "本次没有删除任何行 → 如实返回 0").toBe(0);
    expect(legacyQuery, "未就绪也不许退回旧库（那会造成读写分裂）").toBe(0);

    /**
     * ⚠️ 假端口的 `ensureLoaded` 是**同步就绪**的（内存里本来就有数据），
     * 所以"登记的一次性回调"会在这一步立刻执行 —— 真实端口里它由 IPC 完成触发。
     * 因此这里不能断言"此刻还没有删"，只能断言**最终**的结果：
     * 恰好删一次、删的是正确的 id、墓碑只写一次（重复执行会是数据完整性问题）。
     */
    port.messages.ensureLoaded("s1");
    await settle();
    const dels = port.__writes().filter((w) => w.command === "messages.delete");
    expect(dels.length, "就绪后的补做只能发生一次").toBe(1);
    expect((dels[0].params as Record<string, unknown>)?.ids).toEqual(["m2"]);
    expect(tombstones).toEqual([{ sessionId: "s1", id: "m2" }]);
    expect(port.__table("messages").map((r) => r.id)).toEqual(["m1"]);
  });

  it("PC-4: createMessage 把新消息写进端口全文索引（rust 模式下新消息能搜到）", async () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    const { createMessage } = await import("../core/storage/message");

    createMessage(
      { id: "n1", role: "user", content: "迁移之后的消息也要能搜", timestamp: 10, status: "done" } as never,
      "s1",
    );
    await settle();

    const fts = port.__writes().find((w) => w.command === "fts.upsert");
    expect(fts, "rust 引擎下 createMessage 必须把消息写进全文索引").toBeTruthy();
    expect(fts?.params).toMatchObject({ session_id: "s1", message_id: "n1", content: "迁移之后的消息也要能搜" });
  });
});

describe("读路径覆盖（rust 模式）", () => {
  it("PC-5: loadFeedback 从端口读**历史反馈**（旧库里有值也不算数）", async () => {
    const port = createFakeStoragePort({
      seed: {
        message_feedback: [
          { id: "fb-m1", message_id: "m1", session_id: "s1", feedback: "like", timestamp: 1 },
          { id: "fb-m2", message_id: "m2", session_id: "s1", feedback: "bogus", timestamp: 2 },
        ],
      },
    });
    setStoragePort(port);
    const { loadFeedback } = await import("../core/storage/message");

    expect(loadFeedback("m1"), "历史反馈必须读得到（否则界面每次显示未评价）").toBe("like");
    expect(loadFeedback("m2"), "非法值按未评价处理（表上也有 CHECK 兜底）").toBe(null);
    expect(loadFeedback("m404")).toBe(null);
    expect(legacyQuery, "B 态不得碰旧库").toBe(0);
  });

  it("PC-6: rebuildSessionFts 在 rust 模式下走 fts.rebuild 并把日志 id 作为 keep_ids", async () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    const { rebuildSessionFts, hydrateSessionLog } = await import("../core/storage/message");

    // 日志镜像里有内容时，keep_ids 必须带上它们（否则会被当孤儿删掉）
    await hydrateSessionLog("s1");
    const out = await rebuildSessionFts("s1");
    await settle();

    const call = port.__writes().find((w) => w.command === "fts.rebuild");
    expect(call, "rust 模式下必须交给 Rust 侧重建（那边会按 bigram 切分）").toBeTruthy();
    expect(call?.params).toMatchObject({ session_id: "s1" });
    expect(Array.isArray((call?.params as Record<string, unknown>)?.keep_ids)).toBe(true);
    expect(out).toEqual({ removed: 0, added: 0 });
    expect(legacyQuery, "B 态不得碰旧库").toBe(0);
  });
});

describe("维护路径覆盖（rust 模式）", () => {
  it("PC-7: trimIndexedMessages 只裁**日志里确实有**的行，且不动带附件的消息", async () => {
    const rows = [msg("m1", 1), msg("m2", 2), msg("m3", 3), msg("m4", 4)];
    const port = createFakeStoragePort({
      seed: {
        messages: rows,
        sessions: [{ id: "s1", project_id: "", title: "会话", created_at: 1, last_message_at: 4 }],
        // m2 带附件 → 绝不裁（附件行不在 JSONL 里，裁消息会级联删附件）
        attachments: [{ id: "att1", session_id: "s1", message_id: "m2", name: "a.txt", type: "file" }],
      },
    });
    setStoragePort(port);
    port.messages.ensureLoaded("s1");
    // 日志里只有 m1 是"确实持久化"的 → 只有它允许被裁
    durableIds = new Set(["m1"]);
    const { trimIndexedMessages } = await import("../core/storage/message");

    const out = await trimIndexedMessages({ keepPerSession: 1 });
    await settle();

    expect(out.deletedMessages, "只裁日志里有的那条（m1）").toBe(1);
    const del = port.__writes().filter((w) => w.command === "messages.delete").at(-1);
    expect((del?.params as Record<string, unknown>)?.ids).toEqual(["m1"]);
    expect(legacyQuery, "B 态不得碰旧库（原来在这里抛错 → 裁剪从未执行过）").toBe(0);
  });

  it("PC-8: 日志覆盖为空时一条都不裁（耐久性不变量优先于体积）", async () => {
    const port = createFakeStoragePort({
      seed: {
        messages: [msg("m1", 1), msg("m2", 2), msg("m3", 3)],
        sessions: [{ id: "s1", project_id: "", title: "会话", created_at: 1, last_message_at: 3 }],
      },
    });
    setStoragePort(port);
    port.messages.ensureLoaded("s1");
    durableIds = new Set(); // 老会话尚未回填
    const { trimIndexedMessages } = await import("../core/storage/message");

    const out = await trimIndexedMessages({ keepPerSession: 1 });
    await settle();

    expect(out.deletedMessages).toBe(0);
    expect(out.skippedSessions).toBe(1);
    expect(port.__writes().some((w) => w.command === "messages.delete")).toBe(false);
  });
});
