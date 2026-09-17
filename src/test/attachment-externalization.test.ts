/**
 * 附件外置 + 全文索引一致性（第 80 波，路线收尾两项）
 *
 * ① 附件外置：`attachments.content` 过去把文档全文存在 SQLite 里，而本地库整库常驻内存 +
 *    只能整库导出 —— 一条大附件就把每次保存的峰值顶上去。现在大内容写
 *    `<appData>/attachments/<id>-<name>`，库里留 `file:<路径>` 标记 + 预览，小内容保持内联。
 * ② 全文索引一致性：`session_fts` 没有外键级联，索引裁剪后会留下孤儿行（真机实测 112 条）。

 * 两条都遵守同一原则：**读路径要么透明命中，要么明确说没预热，绝不把标记当正文用。**
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
        if (cmd === "write_file") { files.set(args.path, args.content); return undefined; }
        if (cmd === "append_file") { files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n"); return undefined; }
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
        if (cmd === "delete_file") { files.delete(args.path); return undefined; }
        if (cmd === "rename_file") {
          const c = files.get(args.oldPath);
          files.delete(args.oldPath);
          if (c !== undefined) files.set(args.newPath, c);
          return undefined;
        }
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
import { createMessage, getAttachmentContent, clearSessionLogCache, rebuildSessionFts, listMessages } from "../core/storage/message";
import { clearExternalContentCache, DEFAULT_EXTERNALIZE_THRESHOLD, FILE_CONTENT_PREFIX } from "../core/storage/attachment-files";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import { setStoragePort, getStoragePort, hasStoragePort } from "../core/storage/port";

/**
 * 读一条附件行：**端口优先**（第 14 轮之后附件写入已端口化），A 态回退旧库。
 *
 * 为什么必须这样读：B 态下 `createMessage` 的附件行走 `crud.upsert {table:"attachments"}`，
 * 旧库里没有这一行 —— 直接 `getDatabase().exec(...)` 会拿到 `undefined`（用例假红）。
 */
function attachmentRow(id: string): Record<string, unknown> | undefined {
  /**
   * ⚠️ A 态下 `getStoragePort()` 是**抛错**的（"端口尚未注册"），不是返回 null ——
   * 所以这里必须先判 `hasStoragePort()`，否则 A 态用例会整体红（实测踩到）。
   */
  if (hasStoragePort()) {
    const port = getStoragePort() as unknown as {
      __table?: (n: string) => Array<Record<string, unknown>>;
    };
    const fromPort = port?.__table?.("attachments")?.find((r) => String(r.id) === id);
    if (fromPort) return fromPort;
  }
  const rows = getDatabase().exec("SELECT content, preview FROM attachments WHERE id = ?", [id]);
  if (rows.length === 0 || rows[0].values.length === 0) return undefined;
  const v = rows[0].values[0];
  return { id, content: v[0], preview: v[1] };
}
import type { Message } from "../store";

const SESSION = "sess-att";

function msgWithAttachment(id: string, attId: string, content: string, timestamp = 1000): Message {
  return {
    id,
    role: "user",
    content: "带附件的消息",
    timestamp,
    attachments: [
      { id: attId, name: "doc.md", type: "file", content, size: content.length, mimeType: "text/markdown" },
    ],
  } as unknown as Message;
}

beforeEach(async () => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  clearExternalContentCache();
  resetSaveFailureState();
  resetDatabaseFatalState();
  await initDatabase();
  const db = getDatabase();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM session_fts");
  db.run(
    "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES ('sess-att','','t',0,0,0)",
  );
});

afterEach(() => {
  resetDatabaseFatalState();
  resetSaveFailureState();
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
  clearExternalContentCache();
});

describe("附件外置", () => {
  it("ATT-1: 小附件保持内联（常见场景行为不变，不做任何文件 I/O）", async () => {
    createMessage(msgWithAttachment("m1", "a1", "短内容"), SESSION);
    await flushSessionLogWrites();

    const row = String(attachmentRow("a1")?.content ?? "");
    expect(row).toBe("短内容");
    expect(row.startsWith(FILE_CONTENT_PREFIX)).toBe(false);
    expect(getAttachmentContent("a1")).toBe("短内容");
  });

  it("ATT-2: 大附件写入文件，库里留标记，读取路径透明命中（先把内容预热）", async () => {
    const big = "X".repeat(DEFAULT_EXTERNALIZE_THRESHOLD + 5000);
    createMessage(msgWithAttachment("m2", "a2", big), SESSION);
    // 等外置队列完成（异步、幂等）
    await new Promise((r) => setTimeout(r, 50));
    await flushSessionLogWrites();

    const row = attachmentRow("a2");
    const stored = String(row?.content ?? "");
    expect(stored.startsWith(FILE_CONTENT_PREFIX)).toBe(true);
    const path = stored.slice(FILE_CONTENT_PREFIX.length);
    expect(files.get(path)).toBe(big); // 全文在文件里
    expect(String(row?.preview ?? "")).toContain("X"); // 预览仍在库里，列表能显示
    // 文件写入是原子的（先 .tmp 再 rename）
    expect(invokeCalls).toContain("rename_file");

    // 预热后同步读取透明命中（这正是启动维护做的事）
    const { hydrateAttachmentsForSession } = await import("../core/storage/attachment-files");
    await hydrateAttachmentsForSession([{ id: "a2", content: stored }]);
    expect(getAttachmentContent("a2")).toBe(big);
  });

  it("ATT-3: 未预热时**绝不把标记当正文**返回（宁可返回 undefined 并提示）", async () => {
    const big = "Y".repeat(DEFAULT_EXTERNALIZE_THRESHOLD + 100);
    createMessage(msgWithAttachment("m3", "a3", big), SESSION);
    await new Promise((r) => setTimeout(r, 50));
    clearExternalContentCache(); // 模拟"还没预热"

    const value = getAttachmentContent("a3");
    expect(value).toBeUndefined();
    expect(value ?? "").not.toContain(FILE_CONTENT_PREFIX);
  });

  it("ATT-4: 维护会预热外置附件并清理孤儿文件（磁盘不能只涨不降）", async () => {
    const big = "Z".repeat(DEFAULT_EXTERNALIZE_THRESHOLD + 100);
    createMessage(msgWithAttachment("m4", "a4", big), SESSION);
    await new Promise((r) => setTimeout(r, 50));
    await flushSessionLogWrites();
    clearExternalContentCache();

    // 造一个无人引用的孤儿文件 + 一个崩溃残留的 .tmp
    files.set("C:\\appdata\\attachments\\orphan.txt", "没人引用我");
    files.set("C:\\appdata\\attachments\\crashed.txt.tmp", "半截");

    const result = await runDatabaseMaintenance({ compactEventsOver: 0, keepIndexedMessages: 0 });

    expect(result.trimmedIndexMessages).toBe(0); // 本次未裁剪索引
    expect(files.has("C:\\appdata\\attachments\\orphan.txt")).toBe(false);
    expect(files.has("C:\\appdata\\attachments\\crashed.txt.tmp")).toBe(false);
    // 被引用的那个仍在，且已预热 → 同步读取命中
    expect(getAttachmentContent("a4")).toBe(big);
  });
});

describe("全文索引一致性（收尾项）", () => {
  it("FTS-1(第 17 轮 L4 改写): 端口不在时**不假装对齐成功**（返回 0/0），且绝不碰旧库", async () => {
    /**
     * 这条用例原来验证的是**旧库对齐逻辑**（补缺 / 删孤儿，用裸 SQL 断言 `session_fts` 的内容）。
     *
     * A 态（"端口未注册 → 旧库是唯一数据源"）已随 L4 在整个仓库删除：
     * `rebuildSessionFts` 的旧库分支**不再存在**，索引对齐只有一条路 ——
     * 交给 Rust 侧 `fts.rebuild`（含 `keep_ids`，中文 bigram 切分），契约见 FTS-2。
     *
     * 那么这条用例现在守什么？守**"没有端口时的诚实"**：
     *   · 不得静默假装"对齐完成"（返回值必须是 0/0，而不是编一个数字）；
     *   · 不得去读旧库（rust 模式下那里刻意不存在）。
     * 这两条正是旧实现最容易犯的错（旧实现第一行 `isFts5Available()` 在 rust 下恒为 false，
     * 整个函数直接 `return {0,0}` —— 看起来"成功"，实际"新消息永远搜不到"）。
     */
    setStoragePort(null);
    const result = await rebuildSessionFts(SESSION);
    expect(result, "没有端口时无可作为 —— 必须如实返回 0/0，不许编数字").toEqual({ removed: 0, added: 0 });
  });

  it("FTS-2(B 态): 端口在时对齐交给 Rust 侧（绝不静默什么都不做）", async () => {
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const port = createFakeStoragePort();
    setStoragePort(port);
    const { appendSessionMessage } = await import("../core/storage/session-jsonl");
    await appendSessionMessage(SESSION, { id: "keep-1", role: "user", content: "日志里有", timestamp: 9 } as Message);
    await flushSessionLogWrites();
    const { hydrateSessionLog } = await import("../core/storage/message");
    await hydrateSessionLog(SESSION);

    await rebuildSessionFts(SESSION);

    const call = port.__writes().find((w) => w.command === "fts.rebuild");
    expect(call, "B 态必须把对齐交给 Rust（否则新消息永远搜不到）").toBeTruthy();
    expect(call?.params).toMatchObject({ session_id: SESSION });
    expect(
      (call?.params as Record<string, unknown>)?.keep_ids,
      "日志里有、索引里没有的 id 必须作为 keep_ids 传过去（否则会被当孤儿删掉）",
    ).toContain("keep-1");
  });
});
