/**
 * 会话墓碑**必须能被作废** —— 第 184 波存储审计 S1 的回归判据。
 *
 * ## 缺陷形态（审计原文）
 *
 * `session.ts::deleteSession` 的第一行是**无条件** `void appendSessionTombstone(id)`，
 * 之后才看 `domainDelete()` 的返回值。删除没成时（`domainDelete` 返回 false；
 * 或者返回 true 但那次 `deferWrite` 之后被**队满 / 15s 老化丢弃**），
 * `sessions/<sid>.jsonl` 里已经有墓碑，而 `sessions` 那一行还在 ——
 * 而重建路径（`session-log-bridge.ts`）与对账（`maintenance.ts`）都按"已删除"处理，
 * 墓碑又是 append-only、**全仓没有撤销入口** ⇒ 从日志重建索引时**永远跳过**这个
 * 仍然存在的会话：空库恢复场景下会话从侧栏彻底消失，JSONL 正文变成孤儿。
 *
 * ## 判据（本文件守的四条）
 *
 * - S1-A 墓碑在、行还在（删除失败）⇒ 重建**必须**照常重建（`skippedDeleted = 0`）；
 * - S1-B 【反向】行确实不在库里（真删除）⇒ 墓碑成立、照常跳过（绝不复活用户删掉的会话）；
 * - S1-C 【三态】`sessions` 域镜像未就绪（判不了）⇒ 保守跳过（宁可晚一次重建）；
 * - S1-D `sessionTombstoneBinding` 的三态本身（它是 A/B/C 三处的**同一份**判据）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const A = "sess-tomb-a";
const B = "sess-tomb-b";
const APP_DIR = "C:\\appdata\\";

/** 内存文件系统桩（与 `maintenance-rust-mode.test.ts` 同形状） */
const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
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
        if (cmd === "path_exists") return files.has(args.path);
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

/** 一行合法 JSONL 记录 */
const jsonlLine = (id: string, content: string, ts: number) =>
  JSON.stringify({ v: 1, id, sessionId: A, role: "user", content, timestamp: ts });

/** 造一份"有 3 条消息"的会话日志 */
function seedLog(sessionId: string, count = 3): void {
  const lines = Array.from({ length: count }, (_, i) => jsonlLine(`${sessionId}-m${i}`, `正文 ${i}`, i + 1));
  files.set(`${APP_DIR}sessions\\${sessionId}.jsonl`, `${lines.join("\n")}\n`);
}

const sessionRow = (id: string) => ({
  id,
  project_id: "p1",
  title: id,
  created_at: 1,
  last_message_at: 2,
  message_count: 0,
});

let port: FakeStoragePort | null = null;

beforeEach(async () => {
  installFsStub();
  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

/**
 * 制造"墓碑已落盘、行还在"的现场：**端口撤掉**（= `domainDelete` 拿不到任何写通道，
 * 返回 false）后调 `deleteSession` —— 这正是审计描述的形态（删除没成）。
 */
async function tombstoneByFailedDelete(sessionId: string): Promise<void> {
  setStoragePort(null);
  const SessionStorage = await import("../core/storage/session");
  SessionStorage.deleteSession(sessionId, { confirmBulk: true });
  const jsonl = await import("../core/storage/session-jsonl");
  await jsonl.flushSessionLogWrites();
  expect(await jsonl.isSessionDeleted(sessionId), "夹具前提：删除失败时墓碑**已经**落盘").toBe(true);
}

describe("会话墓碑可作废（第 184 波存储审计 S1）", () => {
  it("S1-A: 墓碑在、sessions 行还在（删除没成）⇒ 重建**不得**跳过该会话", async () => {
    seedLog(A, 3);
    await tombstoneByFailedDelete(A);

    // 删除没成 ⇒ 那一行**还在**（这就是审计说的"多留一条待清理的记录"）
    port = createFakeStoragePort({ seed: { sessions: [sessionRow(A)] } });
    setStoragePort(port);

    const bridge = await import("../core/storage/session-log-bridge");
    const rebuilt = await bridge.rebuildIndexFromSessionLogs(A);

    expect(
      rebuilt.skippedDeleted,
      "墓碑只能被作废才会走到这里 —— 修前这里会 +1（会话从此永久被重建跳过）",
    ).toBe(0);
    expect(rebuilt.voidedTombstones, "墓碑作废要**如实计数**（不是静默忽略）").toBe(1);
    expect(rebuilt.messages, "正文必须回到索引（否则 JSONL 成孤儿、会话从侧栏消失）").toBe(3);
  });

  it("S1-B【反向】: 会话行确实不在库里（真删除）⇒ 墓碑成立，照常跳过", async () => {
    seedLog(A, 3);
    await tombstoneByFailedDelete(A);

    // 库里只有**别的**会话 ⇒ A 的墓碑成立（这正是墓碑机制存在的理由：不许复活）
    port = createFakeStoragePort({ seed: { sessions: [sessionRow(B)] } });
    setStoragePort(port);

    const bridge = await import("../core/storage/session-log-bridge");
    const rebuilt = await bridge.rebuildIndexFromSessionLogs(A);

    expect(rebuilt.skippedDeleted, "用户明确删掉的会话绝不能被重建复活").toBe(1);
    expect(rebuilt.voidedTombstones, "这不是「作废」：行确实不在库里").toBe(0);
    expect(rebuilt.messages).toBe(0);
    expect((port.__table("messages") as unknown[]).length, "库里一行都不该被写回").toBe(0);
  });

  it("S1-C【三态】: sessions 域镜像未就绪（判不了）⇒ 保守跳过", async () => {
    seedLog(A, 3);
    await tombstoneByFailedDelete(A);

    port = createFakeStoragePort({ neverReady: ["sessions"], seed: { sessions: [sessionRow(A)] } });
    setStoragePort(port);

    const bridge = await import("../core/storage/session-log-bridge");
    const rebuilt = await bridge.rebuildIndexFromSessionLogs(A);

    expect(rebuilt.skippedDeleted, "判不了的时候按墓碑跳过（宁可晚一次重建，也不复活已删会话）").toBe(1);
    expect(rebuilt.voidedTombstones, "三态里的「判不了」不是「作废」——两者必须分得开").toBe(0);
  });

  it("S1-D: `sessionTombstoneBinding` 的三态判据本身（bridge 与 maintenance 共用这一份）", async () => {
    const SessionStorage = await import("../core/storage/session");

    // ① 端口未注册 ⇒ 判不了
    setStoragePort(null);
    expect(SessionStorage.sessionTombstoneBinding(A)).toBeUndefined();

    // ② 域镜像未就绪 ⇒ 判不了（`domainReadMany` 的 undefined 不是"空表"）
    port = createFakeStoragePort({ neverReady: ["sessions"], seed: { sessions: [sessionRow(A)] } });
    setStoragePort(port);
    expect(SessionStorage.sessionTombstoneBinding(A)).toBeUndefined();

    // ③ 行还在 ⇒ 墓碑作废
    port = createFakeStoragePort({ seed: { sessions: [sessionRow(A)] } });
    setStoragePort(port);
    expect(SessionStorage.sessionTombstoneBinding(A), "行还在 = 删除没成 = 墓碑作废").toBe(false);

    // ④ 行确实不在 ⇒ 墓碑成立（**空表也要判成 true**，不能落进"判不了"）
    port = createFakeStoragePort({ seed: { sessions: [sessionRow(B)] } });
    setStoragePort(port);
    expect(SessionStorage.sessionTombstoneBinding(A), "空库恢复就是这个形态：必须判成成立").toBe(true);
  });
});
