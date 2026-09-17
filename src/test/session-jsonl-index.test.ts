/**
 * 追加日志（JSONL）+ SQLite 索引裁剪 —— 对齐 DSH 的持久化模型（第 78 波）
 *
 * ⚠️ 核心不变量：**一条消息只要还没进追加日志，就绝不允许从索引里删掉。**
 * 这条不成立，"裁剪索引"就等于丢用户数据。本文件用 SLOG-4/SLOG-5 两条例外路径专门守它：
 *   - 还没回填的会话（日志为空）→ 一条都不动；
 *   - 已回填的会话 → 只删"日志里确实有"且"没有附件"的那些。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** 内存文件系统桩：只实现追加日志与索引裁剪用到的几个命令 */
const files = new Map<string, string>();
const invokeCalls: string[] = [];

function installFsStub(): void {
  files.clear();
  invokeCalls.length = 0;
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        invokeCalls.push(cmd);
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") {
          files.set(args.path, args.content);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n");
          return undefined;
        }
        if (cmd === "read_file") {
          if (!files.has(args.path)) throw new Error("no such file");
          return files.get(args.path);
        }
        if (cmd === "list_directory") {
          const dir = String(args.path);
          const sep = dir.endsWith("\\") ? "" : "\\";
          const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
          for (const key of files.keys()) {
            if (!key.startsWith(dir + sep)) continue;
            const rest = key.slice(dir.length + sep.length);
            if (rest.includes("\\")) continue;
            out.push({ name: rest, path: key, isDirectory: false });
          }
          return out;
        }
        if (cmd === "delete_file") {
          files.delete(args.path);
          return undefined;
        }
        if (cmd === "rename_file") {
          const content = files.get(args.oldPath);
          files.delete(args.oldPath);
          if (content !== undefined) files.set(args.newPath, content);
          return undefined;
        }
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { runDatabaseMaintenance } from "../core/storage/database";
import { createMessage, listMessages, listMessagesFromIndex, listMessagesMerged, clearSessionLogCache, trimIndexedMessages } from "../core/storage/message";
import { appendSessionMessage, readSessionMessages, durableMessageIds, backfillSessionLog, flushSessionLogWrites, sessionLogPath, __resetJsonlCache } from "../core/storage/session-jsonl";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort } from "./fake-storage-port";
import type { Message } from "../store";

function makeMessage(id: string, timestamp: number, content = `内容 ${id}`): Message {
  return { id, role: "user", content, timestamp } as Message;
}

const SESSION = "sess-jsonl";

/**
 * 当前用例的内存假端口（**端口是唯一形态**，第 18 轮 / L1）。
 *
 * 这个文件里的维护类用例（SLOG-4/5/6/8）依赖"会话清单 + 消息索引"两处数据：
 * `trimIndexedMessages` / `backfillAllSessions` 的会话清单来自 `sessions` 域镜像，
 * 消息来自会话镜像。产品**只读写端口**，所以预置必须落在端口上 ——
 * 原来把它们插进旧库，产品在端口里一个会话都看不到，于是裁剪/回填静默变成 0。
 *
 * ⚠️ 第 18 轮：A 态（`CODEM_TEST_PORT=0`：端口未注册、旧库是唯一数据源）已随 L4 删除，
 * 所以这里不再有 `port === null` 的分支，也不再 `initDatabase()` / 清旧库表 ——
 * `setup.ts` 每个用例前注册一个全新端口，下面的 `seedPort()` 只是把它换成"带 s1 父行"的那个。
 */
let port: FakeStoragePort;

/** 注册一个带 `sessions` 父行的假端口（覆盖 setup.ts 注册的那个空端口） */
function seedPort(): FakeStoragePort {
  const p = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
      ],
    },
  });
  setStoragePort(p);
  return p;
}

beforeEach(() => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  port = seedPort();
});

afterEach(() => {
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("追加日志（JSONL）", () => {
  it("SLOG-1: 追加即持久，且**不需要任何整库导出**（append_file 一次一行）", async () => {
    await appendSessionMessage(SESSION, makeMessage("m1", 1000));
    await appendSessionMessage(SESSION, makeMessage("m2", 2000));

    expect(invokeCalls.filter((c) => c === "append_file")).toHaveLength(2);
    const { messages, skippedLines } = await readSessionMessages(SESSION);
    expect(skippedLines).toBe(0);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("SLOG-2: 同 id 多次写入 → **后写者胜**（流式更新不会产生重复消息）", async () => {
    await appendSessionMessage(SESSION, makeMessage("m1", 1000, "第一版"));
    await appendSessionMessage(SESSION, makeMessage("m1", 1000, "最终版"));

    const { messages } = await readSessionMessages(SESSION);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("最终版");
  });

  it("SLOG-3: 损坏行只计数不致命（崩在写入中途最多丢最后一行）", async () => {
    const path = "C:\\appdata\\sessions\\sess-jsonl.jsonl";
    files.set(
      path,
      [
        JSON.stringify({ v: 1, id: "ok1", sessionId: SESSION, role: "user", content: "好行", timestamp: 1 }),
        "{ 这行是半截 JSON",
        JSON.stringify({ v: 1, id: "ok2", sessionId: SESSION, role: "assistant", content: "好行 2", timestamp: 2 }),
        "",
      ].join("\n"),
    );
    const { messages, skippedLines } = await readSessionMessages(SESSION);
    expect(skippedLines).toBe(1);
    expect(messages.map((m) => m.id)).toEqual(["ok1", "ok2"]);
  });

  it("SLOG-4: **耐久性不变量** —— 日志为空的会话，索引一条都不许删", async () => {
    for (let i = 0; i < 20; i++) await appendSessionMessage; // noop，保持语义清晰
    for (let i = 0; i < 20; i++) {
      createMessage(makeMessage(`db${i}`, 1000 + i), SESSION); // 只进索引（createMessage 会顺带追加日志）
    }
    // 先把在途追加写等齐，再清掉日志文件（模拟"日志尚未回填/丢失"）
    await flushSessionLogWrites();
    files.clear();
    clearSessionLogCache();

    const result = await trimIndexedMessages({ keepPerSession: 5 });

    expect(result.deletedMessages).toBe(0);
    expect(result.skippedSessions).toBeGreaterThan(0);
    expect(listMessages(SESSION).length).toBe(20); // 索引完好
  });

  it("SLOG-5: 日志覆盖后只裁'日志里确实有'的消息，且**附件消息不裁**", async () => {
    for (let i = 0; i < 12; i++) {
      const m = makeMessage(`m${i}`, 1000 + i);
      createMessage(m, SESSION); // 同时写索引与日志
    }
    /**
     * 给**最老的一条**挂附件：附件行不在日志里 → 即使它在裁剪窗口内也不许删。
     *
     * 预置必须落在**产品真正读的那一侧**：裁剪用 `domainReadMany("attachments")` 读端口。
     * 第 18 轮：A 态（往旧库插）已删，这里只剩端口这一条路。
     */
    await port.data.execute("crud.upsert", {
      table: "attachments",
      primaryKey: "id",
      rows: [
        {
          id: "a1",
          session_id: SESSION,
          message_id: "m0",
          name: "x.txt",
          type: "file",
          content: "hi",
          added_at: 0,
          size: 2,
        },
      ],
    });

    const result = await trimIndexedMessages({ keepPerSession: 3 });

    // 候选 = 除最新 3 条之外的 9 条（m0..m8）；其中 m0 有附件 → 不裁
    expect(result.deletedMessages).toBe(8);
    const remaining = listMessages(SESSION).map((m) => m.id);
    expect(remaining).toContain("m0"); // 附件消息留下
    expect(remaining).toHaveLength(4); // 3 条保留 + m0
  });

  it("SLOG-6: 索引被裁后，读路径仍能拿到完整历史（**合并日志**）", async () => {
    for (let i = 0; i < 12; i++) createMessage(makeMessage(`m${i}`, 1000 + i), SESSION);
    const before = listMessages(SESSION).length;
    expect(before).toBe(12);

    const result = await trimIndexedMessages({ keepPerSession: 3 });
    expect(result.deletedMessages).toBe(9);

    // 未 hydrate：只有索引里的 3 条
    expect(listMessages(SESSION)).toHaveLength(3);
    // hydrate 之后（进入会话时调用）：合并出完整 12 条
    const { hydrateSessionLog } = await import("../core/storage/message");
    const fromLog = await hydrateSessionLog(SESSION);
    expect(fromLog).toBe(12);
    const merged = listMessagesMerged(SESSION);
    expect(merged).toHaveLength(12);
    expect(merged.map((m) => m.id)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`));
  });

  it("SLOG-7: 回填幂等（重复回填不会把日志撑大）", async () => {
    const messages = [makeMessage("b1", 1), makeMessage("b2", 2)];
    const first = await backfillSessionLog(SESSION, messages);
    const second = await backfillSessionLog(SESSION, messages);
    expect(first).toBe(2);
    expect(second).toBe(0);
    expect((await durableMessageIds(SESSION)).size).toBe(2);
  });

  it("SLOG-8: 维护会先回填、再裁剪，并把数字报出来", async () => {
    /**
     * 直接写索引（绕过 createMessage）→ 模拟"只有索引、没有日志"的迁移场景。
     *
     * 索引就是**端口**（产品只写端口），所以预置走端口命令 `messages.upsert_index`。
     * 第 18 轮：原来这里先 `getDatabase().run("DELETE FROM messages")` 清旧库索引 ——
     * 那一步随 A 态一起删掉了（本用例的端口是 `beforeEach` 里新建的，本来就是空的）；
     * 保留 `if (port)` 那种分支只会掩盖"端口里到底有没有这些行"。
     */
    for (let i = 0; i < 8; i++) {
      await port.data.execute("messages.upsert_index", {
        id: `k${i}`,
        session_id: SESSION,
        role: "user",
        content: `内容 k${i}`,
        timestamp: 500 + i,
        status: "done",
      });
    }
    await flushSessionLogWrites();
    files.clear();
    clearSessionLogCache();

    const result = await runDatabaseMaintenance({ keepIndexedMessages: 3, compactEventsOver: 0 });

    expect(result.backfilledMessages).toBe(8); // 回填了 8 条
    expect(result.trimmedIndexMessages).toBe(5); // 裁掉 5 条（保留最新 3）
    // 索引被有界裁剪，但**读者仍然看到完整历史**（第 79 波审计修正：合并收进 listMessages）
    expect(listMessagesFromIndex(SESSION)).toHaveLength(3);
    expect(listMessages(SESSION)).toHaveLength(8);
  });
  it("SLOG-9: 删除会留墓碑 —— 被删消息不会从权威日志里复活（本波自查发现的问题）", async () => {
    createMessage(makeMessage("keep1", 1000), SESSION);
    createMessage(makeMessage("gone", 2000), SESSION);
    createMessage(makeMessage("keep2", 3000), SESSION);

    const { deleteMessage, hydrateSessionLog } = await import("../core/storage/message");
    deleteMessage("gone");
    await flushSessionLogWrites();

    expect(listMessages(SESSION).map((m) => m.id)).toEqual(["keep1", "keep2"]);
    const { messages } = await readSessionMessages(SESSION);
    expect(messages.map((m) => m.id)).toEqual(["keep1", "keep2"]);
    await hydrateSessionLog(SESSION);
    expect(listMessagesMerged(SESSION).map((m) => m.id)).toEqual(["keep1", "keep2"]);
  });
  it("SLOG-10: 日志压缩把'被取代的旧行'去掉，语义不变（后写者胜 + 墓碑），且是原子替换", async () => {
    // 造 300 条消息，其中同 id 反复更新（模拟流式）→ 日志行数远多于唯一消息数
    for (let i = 0; i < 100; i++) {
      const m = makeMessage(`c${i}`, 1000 + i, "第一版");
      createMessage(m, SESSION);
      for (let k = 0; k < 2; k++) {
        const { updateMessage } = await import("../core/storage/message");
        updateMessage(`c${i}`, { content: `第 ${k + 2} 版` });
      }
    }
    await flushSessionLogWrites();
    const before = await readSessionMessages(SESSION);
    const linesBefore = files.get(await sessionLogPath(SESSION))!.split("\n").filter((l) => l.trim()).length;

    const { compactSessionLog } = await import("../core/storage/session-jsonl");
    const result = await compactSessionLog(SESSION);

    expect(result.compacted).toBe(true);
    expect(result.linesAfter).toBe(100); // 唯一 id 数
    expect(result.linesBefore).toBeGreaterThan(result.linesAfter);
    // 语义不变：内容仍是最后一版
    const after = await readSessionMessages(SESSION);
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages.every((m) => m.content === "第 3 版")).toBe(true);
    // 原子替换：先写 .tmp 再改名
    expect(invokeCalls).toContain("rename_file");
    // 重新 hydrate 后读路径仍是 100 条
    clearSessionLogCache();
    const { hydrateSessionLog } = await import("../core/storage/message");
    await hydrateSessionLog(SESSION);
    expect(listMessages(SESSION)).toHaveLength(100);
  });
});