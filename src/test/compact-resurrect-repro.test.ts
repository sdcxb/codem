/**
 * 复现：上下文压缩的"软删除"是否被追加日志的合并**复活**（第 83 波）
 *
 * 现场（用户日志，v1.16.32 真机）：
 *   Iteration 1..4 连续压缩：「Removed 840 old messages, kept 20」然后请求仍然 105 万 token，
 *   每次都重新「Removed 841」，token 不降反升 → 三次压缩后硬停「请开启新对话」。
 *
 * 假设：压缩走 `deleteMessagesByIds`（只把索引里的行 UPDATE hidden=1），
 * 而读路径 `listMessages` = 索引(WHERE hidden=0) ∪ 缓存日志，日志里没有 hidden 语义 →
 * 被"删掉"的消息被日志整批加回来，且**不带 hidden** → 压缩等于没做。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") { files.set(args.path, args.content); return undefined; }
        if (cmd === "append_file") { files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n"); return undefined; }
        if (cmd === "read_file") { if (!files.has(args.path)) throw new Error("no such file"); return files.get(args.path); }
        if (cmd === "list_directory") return [];
        if (cmd === "delete_file") { files.delete(args.path); return undefined; }
        if (cmd === "rename_file") { const c = files.get(args.oldPath); files.delete(args.oldPath); if (c !== undefined) files.set(args.newPath, c); return undefined; }
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { getDatabase, initDatabase, resetDatabaseFatalState, resetSaveFailureState } from "../core/storage/database";
import {
  createMessage, listMessages, deleteMessagesByIds, hydrateSessionLog, clearSessionLogCache,
} from "../core/storage/message";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import type { Message } from "../store";

const SESSION = "sess-compact-repro";
/**
 * REPRO-2 用**独立会话**（用例隔离）。
 *
 * `localHiddenIds`（`message.ts`）是"本进程隐藏过的 id"的**进程级**权威补充，按会话分组、
 * 且没有跨用例的重置入口。两个用例复用同一会话名 + 同一批消息 id 时，REPRO-1 隐藏过的
 * m0..m24 会被 REPRO-2 当成"本进程隐藏过" → 在 REPRO-2 里**刚创建的**同名消息一上来就被
 * 判为已隐藏：实测 `before`（创建 30 条之后的列表）只有 5 条，`before.slice(0,25)` 于是把
 * 这 5 条全删掉 → 断言前提被破坏（这才是 REPRO-2 红的真正原因，与压缩耐久性无关）。
 * 生产里消息 id 唯一，不存在这种跨用例串味；测试里各自一个会话即可对齐真实语义。
 */
const SESSION_2 = "sess-compact-repro-2";
const mk = (id: string, ts: number): Message => ({ id, role: "user", content: `内容 ${id} `.repeat(20), timestamp: ts } as Message);

beforeEach(async () => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSaveFailureState();
  resetDatabaseFatalState();
  await initDatabase();
  getDatabase().run("DELETE FROM messages");
  for (const sid of [SESSION, SESSION_2]) {
    getDatabase().run(
      "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES (?,'','t',0,0,0)",
      [sid],
    );
  }
});

afterEach(() => {
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("压缩软删除的耐久性（复现）", () => {
  it("REPRO-1: 软删除 25 条后，读路径应该只剩 5 条", async () => {
    for (let i = 0; i < 30; i++) createMessage(mk(`m${i}`, 1000 + i), SESSION);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);

    const before = listMessages(SESSION);
    expect(before).toHaveLength(30);

    deleteMessagesByIds(before.slice(0, 25).map((m) => m.id));

    const after = listMessages(SESSION);
    console.log("[REPRO] 软删除 25 条后 listMessages 仍有:", after.length,
      "| 其中带 hidden 的:", after.filter((m) => (m as any).hidden).length,
      "| 不带 hidden 的:", after.filter((m) => !(m as any).hidden).length);
    expect(after.map((m) => m.id)).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  });

  it("REPRO-2: 压缩后再次统计『可见消息』不应又把旧消息算回来", async () => {
    for (let i = 0; i < 30; i++) createMessage(mk(`m${i}`, 1000 + i), SESSION_2);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION_2);
    const before = listMessages(SESSION_2);
    expect(before, "创建 30 条后应能全部读到").toHaveLength(30);
    deleteMessagesByIds(before.slice(0, 25).map((m) => m.id));

    const visible = listMessages(SESSION_2).filter((m) => !(m as any).hidden);
    console.log("[REPRO] 压缩后『可见』消息数:", visible.length);
    expect(visible).toHaveLength(5);
    expect(visible.map((m) => m.id)).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  });
});
