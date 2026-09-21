/**
 * FIX-B：会话 / 消息 / 事件生命周期的一批真缺陷（第 20 轮）
 *
 * 本文件按"一条缺陷 → 一条用例"组织，每条都**先用真 CLI 或既有假端口证过缺陷存在**，
 * 再把判据钉住。缺陷清单一句话版：
 *
 * | 编号 | 缺陷 | 本文件里的用例 |
 * | --- | --- | --- |
 * | **B-1** | 删掉的会话在「索引重建」后整批复活（日志没有会话墓碑、重建的清单来自磁盘 JSONL） | `FIXB-1*` |
 * | **B-3** | `retrieved_sources` 只写不读（读映射漏了它、权威日志白名单也不含它） | `FIXB-3*` |
 * | **B-4** | 索引裁剪用**硬删**→ 被裁消息的反馈写不进去（`message_feedback` 外键指向 `messages`） | `FIXB-4*` |
 * | **B-5** | `sessionIdsForMessages` 静默跳过却谎称"可上报"，另有两处重复 `return` 死语句 | `FIXB-5` |
 * | **B-6** | 会话拖拽写了 `sort_order` 但 `listSessions` 不读它 → 拖完弹回原位 | `FIXB-6*` |
 * | **B-7** | `forkSession` 零调用者；UI 的 fork 不写 `parent_id` → 谱系永远报 `(root)` | `FIXB-7*` |
 *
 * B-2（事件压缩的 `cutoff_seq`）与 B-8 / B-9 分别由 `snapshot-compaction.test.ts`、
 * `maintenance-rust-mode.test.ts`、`self-heal-safety.test.ts` 里新增的用例守着。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** 内存文件系统桩：只实现追加日志 / 墓碑 / 重建用到的几个命令（与 session-jsonl-index.test.ts 同一套） */
const files = new Map<string, string>();

function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") {
          files.set(args.path, args.content);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n");
          return undefined;
        }
        if (cmd === "read_text_window") return textWindowSlice(files, args);
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

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  appendSessionMessage,
  appendSessionTombstone,
  isSessionDeleted,
  flushSessionLogWrites,
  __resetJsonlCache,
} from "../core/storage/session-jsonl";
import { listSessions, reorderSessions, forkSession, deleteSession, createSession, updateSession, togglePinned } from "../core/storage/session";
import {
  createMessage,
  listMessages,
  listMessagesMerged,
  trimIndexedMessages,
  saveFeedback,
  deleteMessagesByIds,
  deleteMessage,
  deleteMessagesBefore,
  deleteMessagesAfter,
  hydrateSessionLog,
} from "../core/storage/message";
import { rebuildIndexFromSessionLogs } from "../core/storage/session-log-bridge";
import { reportPersistFailure, getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import type { Message } from "../store";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

function makeMessage(id: string, timestamp: number, content = `内容 ${id}`): Message {
  return { id, role: "user", content, timestamp } as Message;
}

const SESSION = "s-fixb";

beforeEach(() => {
  installFsStub();
  __resetJsonlCache();
  resetPersistFailures();
});

afterEach(() => {
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("FIXB-1：会话墓碑（删掉的会话不许在索引重建后复活）", () => {
  it("FIXB-1a: 墓碑写进会话自己的日志，且不影响消息集合", async () => {
    await appendSessionMessage(SESSION, makeMessage("m1", 1));
    await appendSessionTombstone(SESSION);
    await flushSessionLogWrites();

    expect(await isSessionDeleted(SESSION), "日志里有会话墓碑").toBe(true);
    const raw = files.get(`C:\\appdata\\sessions\\${SESSION}.jsonl`) ?? "";
    expect(raw, "墓碑必须落在那份日志文件里（不另开一份全局清单）").toContain("__session_deleted__");
    expect(raw.split("\n").filter((l) => l.trim()).length, "日志里应为 1 条消息 + 1 条墓碑").toBe(2);
  });

  it("FIXB-1b: 没有墓碑的会话不受影响（不能把活会话判死）", async () => {
    await appendSessionMessage("s-alive", makeMessage("m1", 1));
    await flushSessionLogWrites();
    expect(await isSessionDeleted("s-alive")).toBe(false);
    expect(await isSessionDeleted("s-never-existed"), "没有日志文件 = 没有墓碑").toBe(false);
  });

  it("FIXB-1c: **索引重建跳过已删除的会话，并如实计数**（这是缺陷本体）", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);

    // 两个会话的日志都在磁盘上（模拟"删过一个会话、日志按设计保留"）
    await appendSessionMessage(SESSION, makeMessage("m1", 1));
    await appendSessionMessage("s-keep", makeMessage("k1", 2));
    await appendSessionTombstone(SESSION);
    await flushSessionLogWrites();

    const rebuilt = await rebuildIndexFromSessionLogs();

    expect(rebuilt.skippedDeleted, "被跳过的已删除会话必须**计数并上报**，不能静默").toBe(1);
    expect(rebuilt.sessions, "只有未删除的那个会话进了索引").toBe(1);

    /**
     * 缺陷的原始形态（改之前会红）：`sessions` 是**无条件 upsert**，
     * 于是被删掉的 `s-fixb` 会被整行写回索引 —— 用户的"删除"被静默撤销。
     *
     * ⚠️ 这里用 `rebuilt.sessions === 1` + `skippedDeleted === 1` 钉住"重建的输入清单"，
     * 而**不能**只看 `sessions` 表里有没有 `s-fixb`：种子行本来就在表里
     * （那是"用户点删除之前"的状态，与重建无关）。
     */
    expect(
      rebuilt.sessions + rebuilt.skippedDeleted,
      "两份日志都要被清点：一份被跳过、一份进索引（丢一份就是静默少写）",
    ).toBe(2);
    const messagesInIndex = (port as any).__table("messages").map((r: any) => r.id);
    expect(messagesInIndex, "已删除会话的消息也不能被重建写回").not.toContain("m1");
    expect(messagesInIndex, "未删除会话的消息照常重建").toContain("k1");
    expect(
      ((port as any).__table("sessions") as Array<Record<string, unknown>>)
        .filter((r) => r.id === "s-keep")
        .length,
      "未删除的会话必须被写回索引（供 UI 的会话列表读）",
    ).toBe(1);
  });

  it("FIXB-1d: `deleteSession` 真的会写墓碑（写点接线）", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 1 }],
      },
    });
    setStoragePort(port);
    await appendSessionMessage(SESSION, makeMessage("m1", 1));
    await flushSessionLogWrites();

    deleteSession(SESSION, { confirmBulk: true });
    await flushSessionLogWrites();

    expect(await isSessionDeleted(SESSION), "deleteSession 必须留下会话墓碑").toBe(true);
    expect(
      (port as any).__table("sessions").map((r: any) => r.id),
      "会话行本身照常删除（墓碑只管重建方向）",
    ).not.toContain(SESSION);
  });

  /**
   * ## 第 45 轮：重建必须带上**项目归属**
   *
   * 引擎侧 `messages_rebuild_index` 原来把 `project_id` **硬编码为 `''`** ——
   * 于是"重建复活的会话"全部落到"全局对话"（真机形态：删掉的会话自愈之后
   * 出现在全局项目下，标题看着像一句用户话）。
   * 现在它接受 `sessions[].project_id`（已存在的会话行不受影响），
   * 而**权威 JSONL 日志里没有这一列** —— 归属只能从会话元数据（`sessions` 域镜像）取，
   * 且必须在重建写库**之前**读。
   */
  it("FIXB-1e: 重建带上真实项目归属（不许落到全局项目）", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "s-proj", project_id: "proj-1", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
      },
    });
    setStoragePort(port);
    await appendSessionMessage("s-proj", makeMessage("p1", 1));
    await flushSessionLogWrites();

    const rebuilt = await rebuildIndexFromSessionLogs();
    expect(rebuilt.sessions).toBe(1);
    expect(rebuilt.withoutProject, "归属取到了 → 这个数字必须是 0").toBe(0);

    const row = ((port as any).__table("sessions") as Array<Record<string, unknown>>).find(
      (r) => r.id === "s-proj",
    );
    expect(row?.project_id, "重建写回的会话必须挂在原来的项目下").toBe("proj-1");
  });

  it("FIXB-1f: 取不到归属时传 `\"\"` 并**如实计数**（不猜、也不静默落到全局）", async () => {
    const port = createFakeStoragePort({
      // 会话行不存在（库被清过 / 这个会话只存在于 JSONL）→ 归属无从可取
      seed: { sessions: [] },
    });
    setStoragePort(port);
    await appendSessionMessage("orphan", makeMessage("o1", 1));
    await flushSessionLogWrites();

    const rebuilt = await rebuildIndexFromSessionLogs();
    expect(rebuilt.sessions).toBe(1);
    expect(
      rebuilt.withoutProject,
      "取不到归属必须计数上报 —— 它是「复活的会话会不会掉进全局项目」的唯一可见信号",
    ).toBe(1);
    const row = ((port as any).__table("sessions") as Array<Record<string, unknown>>).find(
      (r) => r.id === "orphan",
    );
    expect(row?.project_id, "取不到就传空串（引擎缺省语义 = 全局项目），刻意**不猜**").toBe("");
  });
});

describe("FIXB-3：`retrieved_sources` 必须能读回来、并且能重建", () => {
  it("FIXB-3a: 写一条带 retrievedSources 的消息 → 从索引读回，引用来源仍在", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);

    const sources = [{ sourceName: "doc1", chunkIndex: 0, content: "片段", score: 0.9 }];
    createMessage({ ...makeMessage("m-src", 5), retrievedSources: sources } as Message, SESSION);

    const fromIndex = listMessagesMerged(SESSION);
    const hit = fromIndex.find((m) => m.id === "m-src");
    expect(hit, "消息必须读得回来").toBeTruthy();
    expect(
      hit?.retrievedSources,
      "索引读路径必须映射 retrieved_sources（写侧一直在传它，读侧从来没读）",
    ).toEqual(sources);
  });

  it("FIXB-3b: **权威日志里也要有它**，合并读不许把它覆盖掉", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);

    const sources = [{ sourceName: "doc2", score: 0.5 }];
    // 索引与权威日志**都写**（真实写入路径就是两边都写：`createMessage` + `appendSessionMessage`）
    createMessage({ ...makeMessage("m-log", 6), retrievedSources: sources } as Message, SESSION);
    await appendSessionMessage(SESSION, {
      ...makeMessage("m-log", 6),
      retrievedSources: sources,
    } as Message);
    await flushSessionLogWrites();

    const raw = files.get(`C:\\appdata\\sessions\\${SESSION}.jsonl`) ?? "";
    expect(
      raw,
      "JsonlMessageRecord 的白名单必须收录 retrievedSources —— 它是「索引可从日志重建」的前提",
    ).toContain("retrievedSources");

    /**
     * 合并读（`listMessagesMerged`）的第二个坑：**日志记录会覆盖索引那份**
     * （`...existing` 在前、日志字段在后），而日志记录如果没带这个字段，
     * 覆盖就等于把它擦掉 —— 界面上引用块消失（`MessageBubble` 只认 `message.retrievedSources`）。
     */
    await hydrateSessionLog(SESSION);
    const merged = listMessagesMerged(SESSION);
    expect(
      merged.find((m) => m.id === "m-log")?.retrievedSources,
      "日志与索引合并之后，引用来源不能被覆盖成 undefined",
    ).toEqual(sources);
  });

  it("FIXB-3c: **索引重建**也要把 retrievedSources 写回去（否则裁一次就永久丢）", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);

    const sources = [{ sourceName: "doc3", score: 0.7 }];
    await appendSessionMessage(SESSION, {
      ...makeMessage("m-rebuild", 7),
      retrievedSources: sources,
    } as Message);
    await flushSessionLogWrites();

    const rebuilt = await rebuildIndexFromSessionLogs();
    expect(rebuilt.messages).toBe(1);

    const row = ((port as any).__table("messages") as Array<Record<string, unknown>>).find(
      (r) => r.id === "m-rebuild",
    );
    expect(row, "重建必须把消息写回索引").toBeTruthy();
    expect(
      row?.retrieved_sources,
      "重建必须带上 retrieved_sources —— 白名单收了它、桥接层却漏传的话，重建就等于把它删了",
    ).toEqual(sources);
  });
});

describe("FIXB-4：索引裁剪必须是软删除（否则被裁消息的反馈写不进去）", () => {
  it("FIXB-4a: 裁剪之后消息行仍在（`hidden=1`），默认列表看不到它", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);

    for (let i = 0; i < 5; i++) {
      createMessage(makeMessage(`m${i}`, 100 + i), SESSION);
      await appendSessionMessage(SESSION, makeMessage(`m${i}`, 100 + i));
    }
    await flushSessionLogWrites();

    const trimmed = await trimIndexedMessages({ keepPerSession: 2 });
    expect(trimmed.deletedMessages, "应当裁掉 3 条（保留最新 2 条）").toBe(3);

    const rows = (port as any).__table("messages") as Array<Record<string, unknown>>;
    const survivingIds = rows.map((r) => String(r.id));
    expect(survivingIds, "**软删除：行必须还在**（外键目标 message_feedback.message_id 指向它）").toContain("m0");
    expect(
      rows.find((r) => r.id === "m0")?.hidden,
      "被裁的行必须是 hidden=1，不是被删掉",
    ).toBe(1);

    const visible = listMessages(SESSION).map((m) => m.id);
    expect(visible, "默认列表里被裁的消息依旧不出现（靠 hidden 过滤，语义不变）").not.toContain("m0");
    expect(visible).toEqual(expect.arrayContaining(["m3", "m4"]));
  });

  it("FIXB-4b: 对被裁消息写反馈**不再失败**（`feedback.set` 必须落到端口）", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);
    for (let i = 0; i < 4; i++) {
      createMessage(makeMessage(`m${i}`, 200 + i), SESSION);
      await appendSessionMessage(SESSION, makeMessage(`m${i}`, 200 + i));
    }
    await flushSessionLogWrites();
    await trimIndexedMessages({ keepPerSession: 1 });

    /**
     * 真机上的失败形态是 `FOREIGN KEY constraint failed`（Rust 侧 `feedback.set`
     * 往 `message_feedback` 插行，而 `message_id` 的外键指向 `messages(id)`；
     * 硬删之后目标行不存在）。假端口没有外键，所以**在假端口下只能断言"行还在"**
     * —— 那正是真机外键得以成立的前提（见 FIXB-4a）。
     *
     * 这一条守的是**另一半**：反馈写入必须真的走到 `feedback.set`，
     * 而不是被某个读路径的异常吞掉（真机那条路径上一旦抛，`saveFeedback` 只上报不抛）。
     */
    const failures: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      failures.push(args.map(String).join(" "));
    });
    saveFeedback("m0", SESSION, "like");
    await Promise.resolve();
    spy.mockRestore();

    const writes = (port as any).__writes().map((w: any) => w.command);
    expect(writes, "反馈必须写穿到 feedback.set").toContain("feedback.set");
    expect(
      failures.join(" "),
      "反馈写入不该上报失败（真机上这一条曾经是 FOREIGN KEY constraint failed）",
    ).not.toContain("message.saveFeedback");
  });
});

describe("FIXB-5：`sessionIdsForMessages` 的静默跳过必须变成可上报的事实", () => {
  it("FIXB-5: 端口缺 messages 能力时如实上报（不再谎称「已经上报」却什么都不做）", () => {
    /**
     * 造一个"端口在、但没有 messages 能力"的形态：直接把它摘掉。
     * 产品里这一支不应发生（测试双可能如此），但**它必须有明确处置** ——
     * 原来这里静默返回空 Map，注释却写着"让没写墓碑成为可见的、可上报的事实"。
     */
    const port = createFakeStoragePort();
    setStoragePort(port);
    (port as unknown as { messages?: unknown }).messages = undefined;

    const notes: string[] = [];
    /**
     * ⚠️ 断言必须钉在**上报通道**上：`reportPersistFailure` 走的是 `console.error`
     * （`persist-failure.ts::reportFailure`），不是 `console.warn`。
     * 用错通道会让这条用例**永远绿**（什么都没捕获到也"通过"）——
     * 那正是 B-5 那种"注释声称会上报、其实什么都不做"的同一种错。
     */
    const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      notes.push(args.map(String).join(" "));
    });
    // 经过 deleteMessagesByIds → sessionIdsForMessages（公开入口只有它）
    const deleted = deleteMessagesByIds(["nope-1", "nope-2"]);
    err.mockRestore();

    expect(deleted, "契约不变：返回请求删除的条数").toBe(2);
    expect(
      notes.join(" "),
      "查不到归属时必须上报（否则「没有写墓碑」这件事在日志里完全看不见）",
    ).toContain("message.sessionIdsForMessages");
    expect(
      notes.join(" "),
      "上报内容要说清后果：这些消息的墓碑没写 → 下次从日志重建时会复活",
    ).toContain("复活");
    expect(
      getPersistFailures().some((f) => f.area === "message.sessionIdsForMessages"),
      "上报必须落在可查询的失败清单里（测试与真机排查都靠它）",
    ).toBe(true);
  });
});

describe("FIXB-6：会话拖拽顺序必须真的生效", () => {
  it("FIXB-6a: 拖拽 → 重新 list → 顺序保持", () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "a", project_id: "p", title: "A", created_at: 1, last_message_at: 300, message_count: 0, pinned: 0 },
          { id: "b", project_id: "p", title: "B", created_at: 2, last_message_at: 200, message_count: 0, pinned: 0 },
          { id: "c", project_id: "p", title: "C", created_at: 3, last_message_at: 100, message_count: 0, pinned: 0 },
        ],
      },
    });
    setStoragePort(port);

    // 默认（都没拖过）：按 last_message_at DESC = a, b, c
    expect(listSessions("p").map((s) => s.id)).toEqual(["a", "b", "c"]);

    // 用户拖成 c, a, b
    reorderSessions("p", ["c", "a", "b"]);
    expect(
      listSessions("p").map((s) => s.id),
      "拖拽之后顺序必须保持（原来 sort_order 写了没人读 → 立刻弹回原位）",
    ).toEqual(["c", "a", "b"]);
  });

  it("FIXB-6b: 从未拖拽过的会话仍按时间序（`?? 0` 那种默认值会把它们顶到最前面）", () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "old", project_id: "p", title: "O", created_at: 1, last_message_at: 100, message_count: 0, pinned: 0 },
          { id: "new", project_id: "p", title: "N", created_at: 2, last_message_at: 900, message_count: 0, pinned: 0 },
          { id: "mid", project_id: "p", title: "M", created_at: 3, last_message_at: 500, message_count: 0, pinned: 0 },
        ],
      },
    });
    setStoragePort(port);
    expect(listSessions("p").map((s) => s.id), "没有任何排序键时 = 纯时间序").toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("FIXB-6c: 拖过的排在没拖过的前面，且置顶永远在最前", () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "a", project_id: "p", title: "A", created_at: 1, last_message_at: 900, message_count: 0, pinned: 0 },
          { id: "b", project_id: "p", title: "B", created_at: 2, last_message_at: 100, message_count: 0, pinned: 0 },
          { id: "pin", project_id: "p", title: "P", created_at: 3, last_message_at: 1, message_count: 0, pinned: 1 },
        ],
      },
    });
    setStoragePort(port);
    reorderSessions("p", ["b", "a"]);
    expect(listSessions("p").map((s) => s.id), "置顶第一、拖过的次之（按拖拽序）").toEqual([
      "pin",
      "b",
      "a",
    ]);
  });

  it("FIXB-6d: 改标题/置顶不会把拖拽顺序清掉（`sort_order` 必须跟着整体写回）", async () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "a", project_id: "p", title: "A", created_at: 1, last_message_at: 900, message_count: 0, pinned: 0 },
          { id: "b", project_id: "p", title: "B", created_at: 2, last_message_at: 100, message_count: 0, pinned: 0 },
        ],
      },
    });
    setStoragePort(port);
    reorderSessions("p", ["b", "a"]);
    expect(listSessions("p").map((s) => s.id)).toEqual(["b", "a"]);

    /**
     * `updateSession` / `togglePinned` 走的是"读出整行 → 改字段 → 整体 replace 写回"。
     * 如果 `sessionToWire` 不带 `sort_order`，这次写回就会把排序键**清成 NULL** ——
     * 用户改个标题，拖拽顺序就没了。
     */
    const { updateSession, togglePinned } = await import("../core/storage/session");
    updateSession("a", { title: "A2" });
    togglePinned("b");
    expect(
      listSessions("p").map((s) => s.id),
      "改标题 / 置顶之后排序键必须还在（否则一次无关的写入就把拖拽顺序清掉）",
    ).toEqual(["b", "a"]);
  });
});

/**
 * ## FIXB-8：`messages.delete` 的批量闸门契约（Rust 侧新增）
 *
 * Rust 侧 `repo.rs::messages_delete` 现在对**硬删除**（不带 `soft: true`）加了闸门：
 * **按真实影响行数**（含外键级联，审计触发器行已剔除）超过 50 行时，必须显式传
 * `confirm_bulk: true`，否则整条命令返回错误且事务回滚。`soft: true`（隐藏）不受约束。
 *
 * 所以渲染侧每一条硬删除都必须**如实声明"我在做显式批量删除"** ——
 * 闸门要拦的是"规模不体现在参数里"的隐式级联（参数写 1 个 id、实际带走它的一堆子行），
 * 而渲染侧这三条路径的 id 都是**已经从镜像里枚举出来的确切目标**，声明是真话。
 *
 * 假端口不校验闸门，所以这里断言的是**发出的参数**；另有 FIXB-8d 用源码扫描
 * 保证"将来新增的硬删除路径也逃不掉"。
 */
describe("FIXB-8：硬删除必须声明 confirm_bulk（软删除不许带）", () => {
  /** 造会话 + N 条消息（索引与权威日志**都写**，与真实写入路径一致） */
  async function seed(port: ReturnType<typeof createFakeStoragePort>, count: number): Promise<void> {
    setStoragePort(port);
    for (let i = 0; i < count; i++) {
      createMessage(makeMessage(`m${i}`, 100 + i), SESSION);
      await appendSessionMessage(SESSION, makeMessage(`m${i}`, 100 + i));
    }
    await flushSessionLogWrites();
  }

  const makePort = () =>
    createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });

  /**
   * 本次用例里发出去的全部 `messages.delete` 参数。
   *
   * ⚠️ `trim` 也要看：索引裁剪走的是 `trim: true`（第 44 轮加的**裁剪专用**软删除语义，
   * 引擎侧 = `UPDATE messages SET hidden = 1, trimmed = 1`）—— **不带 `soft`**，
   * 所以"有没有 `soft`"不能当"是不是软删除"的判据，必须把两个键都取出来。
   *
   * ## 第 45 轮（线协议 P2-4）：同一次删除会**同时**出现在两个通道里，必须去重
   *
   * 五个调用点统一收口到 `message.ts::deleteMessageIndexRows` 之后：
   * - 端口有 `command` 能力 → 发 `data.command("messages.delete", …)`（结构化回报）；
   * - 没有 → 退回 `data.execute(...)`。
   *
   * 而假端口的 `command` 内部会走**同一个** `persist`，于是 `__writes()` 里
   * 同一条逻辑删除会留下**两条**记录（一条来自 `command`、一条来自 `execute`）——
   * 它们是同一个目标，不是"删了两次"。这里按键去重，用例要守的
   * "参数长什么样 / 发了几次**逻辑**删除"因此仍然成立。
   */
  const deleteParams = (port: ReturnType<typeof createFakeStoragePort>) => {
    const byKey = new Map<string, Record<string, unknown>>();
    for (const w of port.__writes()) {
      if (w.command !== "messages.delete") continue;
      const p = (w.params ?? {}) as Record<string, unknown>;
      byKey.set(`${JSON.stringify(p.ids ?? [])}|${String(p.soft ?? "")}|${String(p.trim ?? "")}`, p);
    }
    return [...byKey.values()];
  };
  const deleteCalls = (port: ReturnType<typeof createFakeStoragePort>) =>
    deleteParams(port).map(
      (p) =>
        p as {
          ids?: string[];
          soft?: boolean;
          trim?: boolean;
          confirm_bulk?: boolean;
        },
    );

  /** 一条 `messages.delete` 是不是软删除（`hidden` 路径）—— 两个键任一为真即是 */
  const isSoft = (p: { soft?: boolean; trim?: boolean }) => p.soft === true || p.trim === true;

  it("FIXB-8a: 三条硬删除路径都带 confirm_bulk（单条 / 按时间 / 编辑重发）", async () => {
    // 单条删除
    const p1 = makePort();
    await seed(p1, 2);
    deleteMessage("m0");
    const single = deleteCalls(p1);
    expect(single.length, "deleteMessage 必须走到 messages.delete").toBe(1);
    expect(isSoft(single[0]), "单条删除是硬删除（不带 soft / trim）").toBe(false);
    expect(
      single[0].confirm_bulk,
      "硬删除必须显式声明 confirm_bulk —— 闸门按**真实影响行数**算（含 tool_calls / message_feedback 的级联），" +
        "参数里只写 1 个 id 也可能超阈值；渲染侧已经枚举出确切目标，声明是真话",
    ).toBe(true);

    // 按时间删（"清空更早的上下文"）
    const p2 = makePort();
    await seed(p2, 5);
    deleteMessagesBefore(SESSION, 100 + 3);
    const before = deleteCalls(p2);
    expect(before.length).toBe(1);
    expect(isSoft(before[0]), "按时间删是硬删除").toBe(false);
    expect(before[0].confirm_bulk, "按时间批量删是真正的批量（一次可能几百条）").toBe(true);
    expect(before[0].ids?.length, "id 是从镜像枚举出来的确切目标").toBe(3);

    // 编辑并重发（删后续）
    const p3 = makePort();
    await seed(p3, 4);
    deleteMessagesAfter(SESSION, "m0", { includeSelf: true });
    const after = deleteCalls(p3);
    expect(after.length).toBe(1);
    expect(isSoft(after[0]), "编辑重发是硬删除").toBe(false);
    expect(after[0].confirm_bulk, "编辑第一轮 = 删掉整段后续，规模完全可能超闸门").toBe(true);
  });

  it("FIXB-8b: **软删除不许带 confirm_bulk**（压缩隐藏 + 索引裁剪两条路）", async () => {
    // 上下文压缩：deleteMessagesByIds
    const p1 = makePort();
    await seed(p1, 3);
    deleteMessagesByIds(["m0", "m1"]);
    const compact = deleteCalls(p1);
    expect(compact.length).toBe(1);
    expect(compact[0].soft, "压缩走软删除（`soft: true`，不带 `trim`）").toBe(true);
    expect(compact[0].trim, "压缩**不是**裁剪 —— 它不该带 `trim`（那会让读路径保留这条消息）").toBeUndefined();
    expect(
      compact[0].confirm_bulk,
      "隐藏不删行、不触发级联 —— 给它声明 confirm_bulk 会让闸门那侧的语义变浑" +
        "（「声明了 confirm_bulk」就不再等于「这次真的会删掉很多行」）",
    ).toBeUndefined();

    // 索引裁剪：trimIndexedMessages
    const p2 = makePort();
    await seed(p2, 6);
    const trimmed = await trimIndexedMessages({ keepPerSession: 2 });
    expect(trimmed.deletedMessages, "应当裁掉 4 条").toBe(4);
    const trims = deleteCalls(p2);
    expect(trims.length).toBe(1);
    expect(
      trims[0].trim,
      "裁剪走 `trim: true`（第 44 轮的裁剪专用软删除：引擎侧写 `hidden = 1, trimmed = 1`）—— " +
        "这一列是「被裁过的历史仍读得到」与「被压缩的要排除」两条相反语义的**持久**分界",
    ).toBe(true);
    expect(isSoft(trims[0]), "裁剪是软删除（B-4：行必须留着满足 message_feedback 的外键）").toBe(true);
    expect(trims[0].confirm_bulk, "同上：软删除不是破坏性删除").toBeUndefined();
  });

  it("FIXB-8c: 会话删除如实转发 confirmBulk（UI 传 true、非交互路径不传）", async () => {
    const p1 = makePort();
    setStoragePort(p1);
    deleteSession(SESSION, { confirmBulk: true });
    const withConfirm = p1.__writes().filter((w) => w.command === "crud.delete");
    expect(withConfirm.length, "删会话走 crud.delete").toBe(1);
    expect(
      (withConfirm[0].params as Record<string, unknown>).confirm_bulk,
      "UI（Sidebar）明确要删会话 → confirmBulk 必须如实翻译成线协议的 confirm_bulk",
    ).toBe(true);

    /**
     * 反向对照：**非交互路径不传**。
     * 自动清理 / 对账 / 修复走的是同一个 `domainDelete`，它们**不该**声明确认 ——
     * 那正是闸门要拦下的东西。所以这里必须证明"不传就是不带"，而不是"永远都带上"。
     */
    const p2 = makePort();
    setStoragePort(p2);
    deleteSession(SESSION);
    const withoutConfirm = p2.__writes().filter((w) => w.command === "crud.delete");
    expect(withoutConfirm.length).toBe(1);
    expect(
      (withoutConfirm[0].params as Record<string, unknown>).confirm_bulk,
      "没传 confirmBulk 时不得凭空声明（否则闸门形同虚设）",
    ).toBeUndefined();
  });

  it("FIXB-8d: 源码级不变量 —— 参数生成点三模式互斥，且每个调用点显式传模式", async () => {
    /**
     * 为什么还要一条源码扫描：假端口不校验闸门，所以"今天测到的三条路径"之外
     * **将来新增的第四条**不会有任何测试照看它 —— 真机上表现为"这个功能静默不生效"
     * （命令整条回滚），而单测全绿。这条扫描把"新增硬删除必须声明"变成编译期之外
     * 的第二道网（与 `MR-6` 那条"生产代码不许 import 旧引擎"同一个套路）。
     *
     * ## 第 45 轮（线协议 P2-4）：判据跟着"收口"改，但**没有变松**
     *
     * 五个调用点原来各自写 `messages.delete` 的参数；现在统一收口到
     * `messageDeleteParams(ids, mode)`（**参数形状的唯一生成点**），调用点传的是
     * `"hard" | "soft" | "trim"` 字面量（同时它们走结构化通道读引擎回报 —— P2-4）。
     * 于是扫描分两步：
     *
     * 1. **生成点**：三种模式各自只映射到一组参数（硬删除 `confirm_bulk: true`、
     *    压缩隐藏 `soft: true`、索引裁剪 `trim: true`），且后两者**不许**带
     *    `confirm_bulk`（软删除不是破坏性删除）；
     * 2. **调用点**：必须显式传模式字面量 —— 不许出现"缺参数即默认硬删除"
     *    这种要在脑子里推的形态（那正是这条网要防的）。
     */
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "core", "storage", "message.ts"), "utf8")
      // 去掉块注释与行注释：注释里会**举例**说明"别带 confirm_bulk"，扫到会假红
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    // ---- ① 生成点：三种模式的参数形状 ----
    const genAt = src.indexOf("export function messageDeleteParams(");
    expect(genAt, "参数生成点必须存在（P2-4 把五处参数收口到这里）").toBeGreaterThan(0);
    const genBody = src.slice(genAt, src.indexOf("\n}", genAt));
    /** 取某个模式分支的单行返回（`if (mode === "x") return {...};`） */
    const branchOf = (mode: string): string => {
      const at = genBody.indexOf(`mode === "${mode}"`);
      if (at < 0) return "";
      const end = genBody.indexOf(";", at);
      return genBody.slice(at, end < 0 ? at + 120 : end);
    };
    expect(/confirm_bulk: true/.test(genBody), "硬删除的生成点必须带 confirm_bulk").toBe(true);
    expect(/trim: true/.test(branchOf("trim")), "裁剪生成点必须是 trim: true").toBe(true);
    expect(/soft: true/.test(branchOf("soft")), "压缩隐藏生成点必须是 soft: true").toBe(true);
    expect(/confirm_bulk/.test(branchOf("soft")), "软删除的生成点不许带 confirm_bulk").toBe(false);
    expect(/confirm_bulk/.test(branchOf("trim")), "裁剪的生成点不许带 confirm_bulk").toBe(false);

    // ---- ② 每个调用点必须显式给出模式 ----
    const offenders: string[] = [];
    let from = 0;
    let calls = 0;
    for (;;) {
      const at = src.indexOf("deleteMessageIndexRows(", from);
      if (at < 0) break;
      from = at + 1;
      if (src.slice(Math.max(0, at - 30), at).includes("function ")) continue; // 定义处本身
      calls += 1;
      const tail = src.slice(at, at + 400);
      if (!/["'](hard|soft|trim)["']/.test(tail)) {
        offenders.push(`调用点没有显式传模式（不许有隐式默认）：${tail.slice(0, 100)}`);
      }
    }
    expect(offenders, `message.ts 里的 messages.delete 调用点违反了闸门契约：\n${offenders.join("\n")}`).toEqual([]);
    expect(calls, "至少要扫到五处调用（否则这条用例是空转）").toBeGreaterThanOrEqual(5);
  });
});

describe("FIXB-7：fork 必须写 parent_id（谱系功能的数据来源）", () => {
  /**
   * ## 第 45 轮修正：这条用例的"事件复制"断言反过来了
   *
   * 原来这里断言"子会话必须继承源会话的事件日志（fork 的语义）"，`toBe(2)`。
   * 而功能上下文审计（`FEATURE-CONTEXT.md` 的 F8 / P2-D6）实测的形态是：
   * 事件被**原样整段复制**（payload 里的 `messageId` / `toolCallId` 仍是源会话的 id），
   * 而子会话的消息是新 id（`core/store.ts` 的复制循环）—— 两边主键**完全脱钩**：
   * 投影会为这些孤儿 id 凭空造出 `content: ""` 的 assistant 行与 `tool-result-*` 行
   * （`event-projection.ts:252–307`），`session_meta`（如 `feedback_record`）被抄过来后
   * 子会话里还会凭空出现源会话的反馈条目（`feedback.ts:87` 按 session_id 过滤）。
   *
   * 现在 `SessionStorage.forkSession` **不再复制事件日志**（理由写在那个函数里）：
   * 子会话的消息表是唯一来源，事件由消息自己的写入产生（`user_message` /
   * `assistant_text`，见 `MessageStorage.appendMessageTextEvent`），主键必然一致。
   * 所以这条用例改为守**新契约**（并顺带守住"源会话的事件没被动过"）。
   */
  it("FIXB-7a: forkSession 建子会话、写 parent_id；**不**复制源会话事件（主键一致由 FC-D6a 守）", () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "src", project_id: "p", title: "源会话", created_at: 1, last_message_at: 2, message_count: 3, pinned: 0 },
        ],
        session_events: [
          { seq: 1, session_id: "src", event_type: "session_meta", payload: "{}", timestamp: 1 },
          { seq: 2, session_id: "src", event_type: "user_message", payload: '{"messageId":"u1"}', timestamp: 2 },
        ],
      },
    });
    setStoragePort(port);

    const child = forkSession("src", "child", "p");
    expect(child, "源会话存在 → 必须建出子会话").toBeTruthy();
    expect(child?.id).toBe("child");

    const rows = (port as any).__table("sessions") as Array<Record<string, unknown>>;
    const childRow = rows.find((r) => r.id === "child");
    expect(childRow, "子会话行必须落地").toBeTruthy();
    expect(
      childRow?.parent_id,
      "`parent_id` 是 session_trace 谱系的唯一数据来源（UI 的 fork 不写它 → 永远报 (root)）",
    ).toBe("src");

    const childEvents = ((port as any).__table("session_events") as Array<Record<string, unknown>>).filter(
      (e) => e.session_id === "child",
    );
    expect(
      childEvents.length,
      "子会话不该继承源会话的事件：payload 里的 messageId 是源会话的 id，抄过去就是一批指向不存在消息的孤儿事件",
    ).toBe(0);
    const srcEvents = ((port as any).__table("session_events") as Array<Record<string, unknown>>).filter(
      (e) => e.session_id === "src",
    );
    expect(srcEvents.length, "源会话自己的事件必须原样不动").toBe(2);
  });

  it("FIXB-7b: 源会话不存在 → 返回 null（不造没有父的孤儿会话）", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    expect(forkSession("nope", "child", "p")).toBeNull();
    expect((port as any).__table("sessions").length, "不该写入任何行").toBe(0);
  });

  it("FIXB-7c: 自己 fork 自己 → 返回 null（否则谱系成自环，Ancestors 会绕圈）", () => {
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "src", project_id: "p", title: "源", created_at: 1, last_message_at: 1, message_count: 0, pinned: 0 },
        ],
      },
    });
    setStoragePort(port);
    expect(forkSession("src", "src", "p")).toBeNull();
  });

  it("FIXB-7d: `createSession` 之后立刻 fork —— 父会话必须查得到", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    createSession({
      id: "p1",
      projectId: "proj",
      title: "P1",
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 0,
    });
    const child = forkSession("p1", "p2", "proj", "P2");
    expect(child?.id, "刚创建的会话必须能被 fork（域镜像写后立即可读）").toBe("p2");
    expect(listSessions("proj").map((s) => s.id).sort()).toEqual(["p1", "p2"]);
  });
});
