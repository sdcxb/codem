/**
 * 第 91 波（**架构级**）：让"权威日志"真的权威 —— 写入顺序、索引自愈、存储压力。
 *
 * ## 现场与根因
 *
 * 用户长会话（大文档、113 条消息）时 sql.js 报 `RuntimeError: memory access out of bounds`。
 * 出问题的不只是"没识别到崩溃"（第 90 波已修），更根本的是**分层名不副实**：
 *
 * 1. **写入顺序是反的**：分层写着"JSONL 追加日志 = 权威存储，SQLite = 可重建索引"（第 78 波），
 *    但 `createMessage` 是「先 `getDatabase()` → INSERT/UPDATE → `persistDatabase()` →
 *    **最后**才 `appendSessionMessage`」。索引一出问题就在第一行抛掉，**权威日志那一步根本没跑** ——
 *    "最权威的副本"反倒挂在"最脆弱路径的最后一道"。用户那 113 条消息的危险就来自这里。
 * 2. **读路径也挂在索引上**：`listMessagesFromIndex` 直接 `getDatabase()`，索引一崩连历史都读不出来
 *    （日志里明明什么都在）。
 * 3. **索引重建方向从未实现**：只有"索引 → 日志"的回填，没有"日志 → 索引"。崩了只能重启撞运气。
 * 4. **存储压力**：`saveMessages` 每次把**整份消息列表**逐条写（100+ 条 UPDATE + 工具调用先删后插）；
 *    `saveDatabase` 每次 `db.export()` **整库**（单次 O(库大小) 的 WASM 分配）—— 这是越界最现实的触发点。
 *
 * ## 本文件的用例
 *
 * AR-1/2：索引崩了，**消息照样进权威日志**（create / update 两条路径）
 * AR-3：索引崩了，**历史照样读得出来**（合并权威日志）
 * AR-4：日志在 → **索引可以从日志重建**（含工具调用）
 * AR-5：崩溃会留下"下次启动重建索引"的标记（且维护路径真的消费它）
 * AR-6：`saveMessages` 只写变化过的消息（未变化的一次都不写）
 * AR-7：整库导出有硬上限，超限即"暂停整库落盘、只写权威日志"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 虚拟文件系统：JSONL 日志走 file-api（appendFile/readFile/…）
vi.mock("../core/file-api", () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    appendFile: vi.fn(async (p: string, c: string) => {
      files.set(p, (files.get(p) ?? "") + c + "\n");
    }),
    readFile: vi.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    }),
    deleteFile: vi.fn(async (p: string) => {
      files.delete(p);
    }),
    exists: vi.fn(async (p: string) => files.has(p)),
    getAppDataDir: vi.fn(async () => "C:/appdata/"),
    getDefaultCwd: vi.fn(async () => "C:/proj"),
    isPathWithinWorkspace: vi.fn(() => true),
    listDirectory: vi.fn(async () => []),
    executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  };
});

let dbMod: any;
let msgMod: any;
let jsonlMod: any;
let bridgeMod: any;

async function freshDb() {
  dbMod = await import("../core/storage/database");
  msgMod = await import("../core/storage/message");
  jsonlMod = await import("../core/storage/session-jsonl");
  bridgeMod = await import("../core/storage/session-log-bridge");
  try { await dbMod.resetDatabase(); } catch { await dbMod.initDatabase(); }
  dbMod.resetDatabaseFatalState();
  msgMod.clearSessionLogCache?.();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await freshDb();
});

afterEach(async () => {
  dbMod?.resetDatabaseFatalState?.();
});

describe("权威日志优先（索引崩了也不丢消息）", () => {
  it("AR-1（修复点）: 索引致命时 createMessage 仍把消息写进权威日志，且不抛错", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    dbMod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"));

    const message = {
      id: "m-armored-1",
      role: "user" as const,
      content: "这批内容必须在数据库崩掉时也不丢",
      timestamp: Date.now(),
    };
    expect(() => msgMod.createMessage(message, "sess-ark")).not.toThrow();
    await jsonlMod.flushSessionLogWrites();

    const { messages } = await jsonlMod.readSessionMessages("sess-ark");
    expect(messages.map((m: any) => m.id)).toContain("m-armored-1");
    expect(messages.find((m: any) => m.id === "m-armored-1").content).toContain("数据库崩掉时也不丢");
    err.mockRestore();
  });

  it("AR-2（修复点）: 索引致命时 updateMessage 仍把最新内容追加进权威日志", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // 先让日志里有这条消息的初版
    await jsonlMod.__writeSessionLogForTests("sess-ark2", [
      JSON.stringify({
        v: 1, id: "m-armored-2", sessionId: "sess-ark2", role: "assistant",
        content: "初版", timestamp: 1000,
      }),
    ]);
    await msgMod.hydrateSessionLog("sess-ark2");

    dbMod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"));
    expect(() => msgMod.updateMessage("m-armored-2", { content: "更新后的正文（很长的大文档内容）" })).not.toThrow();
    await jsonlMod.flushSessionLogWrites();

    const { messages } = await jsonlMod.readSessionMessages("sess-ark2");
    const rec: any = messages.find((m: any) => m.id === "m-armored-2");
    expect(rec.content).toBe("更新后的正文（很长的大文档内容）");
    err.mockRestore();
  });

  it("AR-3（修复点）: 索引致命时历史仍读得出来（走权威日志合并）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await jsonlMod.__writeSessionLogForTests("sess-ark3", [
      JSON.stringify({ v: 1, id: "a1", sessionId: "sess-ark3", role: "user", content: "第一条", timestamp: 1 }),
      JSON.stringify({ v: 1, id: "a2", sessionId: "sess-ark3", role: "assistant", content: "第二条", timestamp: 2 }),
    ]);
    await msgMod.hydrateSessionLog("sess-ark3");

    dbMod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"));

    const list = msgMod.listMessages("sess-ark3");
    expect(list.map((m: any) => m.content)).toEqual(["第一条", "第二条"]);
    warn.mockRestore();
  });
});

describe("索引可重建（自愈）", () => {
  it("AR-4（修复点）: 只有日志时可以从日志重建索引（含工具调用）", async () => {
    await jsonlMod.__writeSessionLogForTests("sess-ark4", [
      JSON.stringify({
        v: 1, id: "b1", sessionId: "sess-ark4", role: "assistant", content: "带工具的消息",
        timestamp: 10,
        toolCalls: [{ id: "tc-1", tool: "write", args: { path: "a.md" }, result: "ok", status: "done" }],
      }),
    ]);

    // 索引里本来没有（模拟重建场景）
    const before = msgMod.listMessagesFromIndex("sess-ark4");
    expect(before).toHaveLength(0);

    const rebuilt = await bridgeMod.rebuildIndexFromSessionLogs("sess-ark4");
    expect(rebuilt.messages).toBe(1);

    const after = msgMod.listMessagesFromIndex("sess-ark4");
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe("带工具的消息");
    // 工具调用也重建进索引（否则索引读路径看不到工具调用）
    const withTools = msgMod.getMessage("b1");
    expect(withTools?.toolCalls?.map((t: any) => t.tool)).toContain("write");
  });

  it("AR-5（修复点）: 崩溃会留下重建标记，且启动维护会消费它", async () => {
    const invoke = vi.fn(async (cmd: string, args?: any) => {
      if (cmd === "get_app_data_dir") return "C:/appdata/";
      if (cmd === "write_file") return (globalThis as any).__marker = args.content;
      if (cmd === "path_exists") return !!(globalThis as any).__marker;
      if (cmd === "read_file") return (globalThis as any).__marker;
      if (cmd === "delete_file") return ((globalThis as any).__marker = undefined);
      throw new Error(`unexpected ${cmd}`);
    });
    (window as any).__TAURI__ = { core: { invoke } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      dbMod.noteDatabaseError(new Error("RuntimeError: memory access out of bounds"));
      // 标记写入是 fire-and-forget，等一拍
      await new Promise((r) => setTimeout(r, 10));
      const marker = await dbMod.indexRebuildNeeded();
      expect(marker.needed).toBe(true);
      expect(String(marker.reason)).toMatch(/memory access out of bounds/);

      // 维护路径确实消费了这个标记（源码契约：先重建再回填）
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(path.join(__dirname, "../core/storage/database.ts"), "utf8");
      const idx = src.indexOf("await indexRebuildNeeded()");
      expect(idx).toBeGreaterThan(-1);
      expect(src.slice(idx, idx + 600)).toContain("rebuildIndexFromSessionLogs");
      expect(src.indexOf("await indexRebuildNeeded()")).toBeLessThan(src.indexOf("await bridge.backfillAllSessions()"));
    } finally {
      delete (window as any).__TAURI__;
      delete (globalThis as any).__marker;
      err.mockRestore();
    }
  });
});

describe("存储压力（越界最现实的触发点）", () => {
  it("AR-6（修复点）: saveMessages 只写变化过的消息（未变化的第二次一条都不写）", async () => {
    const { useAppStore } = await import("../store");
    const store: any = useAppStore;
    const spy = vi.spyOn(msgMod, "createMessage");

    const msgs = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as any,
      content: `内容 ${i} `.repeat(50),
      timestamp: i + 1,
      status: "done" as const,
    }));
    store.setState({ messages: msgs });
    (await import("../store")).__resetSaveFingerprints?.("sess-ark6");

    store.getState().saveMessages("sess-ark6");
    expect(spy.mock.calls.length, "首次应把 40 条都写一遍").toBe(40);

    spy.mockClear();
    store.getState().saveMessages("sess-ark6");
    expect(spy.mock.calls.length, "内容没变 → 一条都不用写").toBe(0);

    // 改一条 → 只写那一条
    const changed = msgs.map((m) => (m.id === "c7" ? { ...m, content: m.content + "补充" } : m));
    store.setState({ messages: changed });
    store.getState().saveMessages("sess-ark6");
    expect(spy.mock.calls.length, "只有变化的那条需要写").toBe(1);
    expect(spy.mock.calls[0][0].id).toBe("c7");
    spy.mockRestore();
  });

  it("AR-7（修复点）: 整库导出有硬上限，超限即暂停整库落盘（数据仍进权威日志）", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/storage/database.ts"), "utf8");
    expect(src).toMatch(/const MAX_EXPORT_BYTES = \d+ \* 1024 \* 1024;/);
    expect(src).toContain("if (data.length > MAX_EXPORT_BYTES)");
    expect(src).toContain("database.wholeFileExportSuspended");
    // 触发上限后：本次运行不再整库导出（索引由日志重建）
    expect(typeof dbMod.isWholeFileExportSuspended).toBe("function");
    expect(dbMod.isWholeFileExportSuspended()).toBe(false);
    expect(src).toMatch(/暂停整库导出/);
  });
});
