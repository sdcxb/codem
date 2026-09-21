/**
 * 索引裁剪 vs 上下文压缩：**两者在库里必须可区分**（第 44 轮）。
 *
 * ## 这条测试守的是什么
 *
 * `messages.hidden = 1` 被两条语义**相反**的路径共用：
 *
 * | 路径 | 含义 | 读路径应当 |
 * | --- | --- | --- |
 * | 上下文压缩（`deleteMessagesByIds`） | 这条消息从上下文里移除 | **排除**（否则"压缩 840 条、token 一点没降"死循环） |
 * | 索引裁剪（`trimIndexedMessages`） | 行留在库里满足 `message_feedback` 外键 | **保留**（"被裁的历史仍读得到"是裁剪的前提） |
 *
 * 这两条路径在库里原来长得一模一样，唯一的区别是"这次隐藏是谁做的" ——
 * 于是只能**进程内记账**（`trimmedIndexIds`）。而进程内记账的弱点很直白：
 * **重启之后就分不清了**。分不清的两个后果都不可接受：
 * 一刀切排除 → 用户看不到自己的历史；一刀切保留 → 压缩失效（那个著名死循环）。
 *
 * 现在引擎把裁剪写成 `hidden = 1, trimmed = 1`，区别成了**库里的持久事实**，
 * 镜像的 `hiddenIds()` 只返回 `hidden=1 && trimmed≠1` 的那些。
 *
 * ## 为什么 TRIM-3 要"换一个端口"
 *
 * 同一个端口里读一次只能证明**本次进程**对。TRIM-3 刻意换一个新端口、把行从旧端口
 * 复制过去（等价于重启：镜像从库重新加载、进程内记账全部消失）——
 * 这是"持久标记"与"进程内记账"之间**唯一**能区分开的判据。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * 内存文件系统桩（照 `session-jsonl-index.test.ts` 的做法）。
 *
 * 为什么必须装：索引裁剪的耐久性判据是"这条消息**在权威 JSONL 里已经有**"，
 * 而 JSONL 的读写走 Tauri 的 `append_file` / `read_file`。没有这个桩，
 * 追加会全部失败（只在控制台留一行"追加消息失败"），于是"日志里没有 → 一律不裁"
 * 这条守卫会让裁剪**一条都不裁**，测试就变成了空转。
 */
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
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import {
  hydrateSessionLog,
  createMessage,
  listMessagesMerged,
  listMessagesFromIndex,
  trimIndexedMessages,
  deleteMessagesByIds,
  clearSessionLogCache,
} from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { appendSessionMessage, flushSessionLogWrites } from "../core/storage/session-jsonl";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const PROJECT = "p-trim";
const SESSION = "s-trim";

/** 造 N 条消息：**同时**写进索引与权威日志（裁剪只会裁"日志里已经有"的那些） */
function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    const msg = { id: `m${i}`, role: "user", content: `内容 ${i}`, timestamp: 1000 + i, status: "done" };
    createMessage(msg as never, SESSION);
    appendSessionMessage(SESSION, msg as never);
  }
}

function rows(port: FakeStoragePort, name: string): Array<Record<string, unknown>> {
  return port.__table(name) as unknown as Array<Record<string, unknown>>;
}

function rowOf(port: FakeStoragePort, id: string): Record<string, unknown> | undefined {
  return rows(port, "messages").find((r) => r.id === id);
}

/** 删掉某个会话的 JSONL 缓存与墓碑，让合并读重新从磁盘读一遍 */
function resetReadCaches(): void {
  clearSessionLogCache();
}

describe("索引裁剪的持久标记（hidden vs trimmed）", () => {
  let port: FakeStoragePort;

  beforeEach(() => {
    installFsStub();
    port = createFakeStoragePort();
    setStoragePort(port as never);
    ProjectStorage.createProject({
      id: PROJECT,
      name: "P",
      path: "D:\\p",
      createdAt: 1,
      lastAccessedAt: 1,
    } as never);
    SessionStorage.createSession({
      id: SESSION,
      projectId: PROJECT,
      title: "T",
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 0,
    } as never);
  });

  afterEach(() => {
    setStoragePort(null);
    resetReadCaches();
  });

  it("TRIM-1: 裁剪发出的是 `trim: true`（不是普通软删除）", async () => {
    seed(6);
    await flushSessionLogWrites();
    await trimIndexedMessages({ keepPerSession: 3 });

    const writes = port
      .__writes()
      .filter((w) => w.command === "messages.delete")
      .map((w) => w.params ?? {});
    expect(writes.length, "裁剪应当发出一条 messages.delete").toBeGreaterThan(0);
    expect(writes[0].trim, "必须带 trim 标记，否则读路径无法与压缩区分").toBe(true);
  });

  it("TRIM-2: 库里那一行变成 hidden=1 **且** trimmed=1；压缩隐藏则是 trimmed=0", async () => {
    seed(6);
    await flushSessionLogWrites();
    await trimIndexedMessages({ keepPerSession: 3 });

    // 被裁掉的是最早的那批（保留最近的 keepPerSession 条）—— 行必须还在库里
    const trimmedRow = rowOf(port, "m0");
    expect(trimmedRow, "裁剪是软删除：行必须还在库里（否则外键目标消失、反馈写不进去）").toBeTruthy();
    expect(Number(trimmedRow?.hidden ?? 0)).toBe(1);
    expect(Number(trimmedRow?.trimmed ?? 0)).toBe(1);

    // 对照：压缩隐藏只设 hidden
    deleteMessagesByIds(["m5"]);
    const compactedRow = rowOf(port, "m5");
    expect(Number(compactedRow?.hidden ?? 0)).toBe(1);
    expect(
      Number(compactedRow?.trimmed ?? 0),
      "压缩**不是**裁剪：trimmed 必须保持 0，否则读路径会把被压缩的消息当历史放回来",
    ).toBe(0);

    // 端到端：被裁的历史仍读得到，被压缩的那条不出现
    resetReadCaches();
    await hydrateSessionLog(SESSION);
    const merged = listMessagesMerged(SESSION);
    expect(
      merged.some((m) => m.id === "m0"),
      "被裁掉的历史必须仍能读到（这是裁剪这条分层的前提）",
    ).toBe(true);
    expect(merged.some((m) => m.id === "m5"), "被压缩的消息不该出现在读集合里").toBe(false);
  });

  it("TRIM-3: 换一个端口（等价于重启）之后仍然分得清 —— 持久标记与进程内记账的分水岭", async () => {
    seed(6);
    await flushSessionLogWrites();
    await trimIndexedMessages({ keepPerSession: 3 });
    deleteMessagesByIds(["m5"]);

    /*
     * 新端口从零开始 —— "库"的内容通过**它自己的写通道**灌进去（`crud.upsert`），
     * 这正是"重启后镜像从库里重新加载"的等价形态：进程内记账全部消失，
     * 只剩库里真实存下来的列值。
     */
    const restarted = createFakeStoragePort();
    for (const name of ["projects", "sessions", "messages"]) {
      const copied = rows(port, name).map((r) => ({ ...r }));
      if (copied.length === 0) continue;
      await restarted.data.execute("crud.upsert", { table: name, rows: copied, mode: "replace" });
    }
    setStoragePort(restarted as never);
    resetReadCaches();

    const hidden = (restarted as unknown as { messages: { hiddenIds(s: string): Set<string> } }).messages.hiddenIds(
      SESSION,
    );
    expect(
      hidden.has("m5"),
      "被压缩的消息在重启后仍必须是隐藏的（否则它会复活、token 永远降不下来）",
    ).toBe(true);
    expect(
      hidden.has("m0"),
      "被**裁剪**的消息不该进隐藏集合 —— 它必须仍能从权威日志读到（用户看得到自己的历史）",
    ).toBe(false);
  });

  /**
   * TRIM-4 = **用户面的最终判据**。
   *
   * TRIM-1..3 守的是「库里分得清」，可「分得清」只是手段，不是目的。目的是两句话：
   * **被裁剪的历史必须仍然读得到**（`session-jsonl-index.test.ts` 的 SLOG-6/SLOG-8 就是这条不变量），
   * 而**被压缩的必须仍然读不到**（否则就是那个著名死循环：压缩 840 条、token 一点没降）。
   *
   * 这两句话只有在**用户面读路径**（`listMessagesMerged`）上才能被同时验证 ——
   * 而真机上出错的位置恰好就在这里：`normalize()` 漏搬 `trimmed` 之后，
   * 裁剪被当成压缩，用户的历史整批消失。所以这一条不能只测 `hiddenIds()` 的返回值。
   */
  it("TRIM-4: 裁剪之后**仍读得到**被裁的历史，同时被压缩的**不复活**", async () => {
    seed(6);
    await flushSessionLogWrites();
    const trimmed = await trimIndexedMessages({ keepPerSession: 3 }); // 裁掉 m0..m2
    expect(trimmed.deletedMessages, "裁掉 3 条（保留最新 3 条）").toBe(3);
    deleteMessagesByIds(["m5"]); // 压缩：hidden=1 且 trimmed=0
    await new Promise((r) => setTimeout(r, 0)); // 索引写入是异步的（假端口也一样）

    resetReadCaches(); // 合并读重新从权威日志读一遍（等价于重启后的第一次读）
    await hydrateSessionLog(SESSION);

    const index = listMessagesFromIndex(SESSION).map((m) => m.id);
    const merged = listMessagesMerged(SESSION).map((m) => m.id);

    expect(index, "索引视图里不出现被裁剪的行（它读的就是索引 = `WHERE hidden = 0`）").toEqual(["m3", "m4"]);
    expect(merged, "用户面：被裁剪的历史必须仍然读得到（这正是裁剪能成立的前提）").toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(merged, "被压缩的消息绝不能复活（否则上下文 token 永远降不下来）").not.toContain("m5");
  });
});
