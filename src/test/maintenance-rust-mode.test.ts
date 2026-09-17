/**
 * 启动维护在 **rust 模式（真机常态）** 下必须真的执行 —— 第 18 轮真机缺陷的回归测试。
 *
 * ## 它守的是什么缺陷
 *
 * `runDatabaseMaintenance()` 的第一行原来是：
 *
 * ```ts
 * if (!db || dbFatal) return { ...result, sizeAfter: result.sizeBefore };
 * ```
 *
 * 而引擎切到 rust 之后 `db` 在正常路径下**永远是 `null`**（旧库刻意不加载）。
 * 于是整个函数在真机上一行都没跑：追加日志（**权威副本**）的回填与压缩、
 * 索引裁剪、外置附件预热与孤儿清理、崩溃后"索引重建标记"驱动的自愈
 * —— **全部从未执行**，而 `App.tsx` 每次启动都在 `await` 它。
 *
 * ## 为什么原来没有测试能发现它
 *
 * `src/test/setup.ts` 每个用例都会 `await initDatabase()`，于是**测试里 `db` 永远非空** ——
 * 维护路径在测试里一直是活的，与真机相反。这个盲点本身就是教训：
 * "测试基座把产品不会出现的状态维持成常态"会让一整类缺陷隐身。
 *
 * 所以本文件用 `closeDatabase()` 把旧库句柄清掉，**显式模拟真机**。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

/** 内存文件系统桩：只实现维护用到的几个命令（与 session-jsonl-index.test.ts 同形状） */
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

import { closeDatabase, getDatabase, initDatabase, resetDatabaseFatalState, resetSaveFailureState, runDatabaseMaintenance } from "../core/storage/database";
import { createMessage, listMessages, clearSessionLogCache } from "../core/storage/message";
import { readSessionMessages, __resetJsonlCache, flushSessionLogWrites } from "../core/storage/session-jsonl";
import { hasStoragePort, getStoragePort, setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort } from "./fake-storage-port";
import type { Message } from "../store";

const SESSION = "sess-maint";

function makeMessage(id: string, timestamp: number, content = `内容 ${id}`): Message {
  return { id, role: "user", content, timestamp } as Message;
}

let port: FakeStoragePort | null = null;

function seedPort(): FakeStoragePort | null {
  if (!hasStoragePort()) return null;
  if (getStoragePort().kind !== "rust") return null;
  const p = createFakeStoragePort({
    seed: {
      sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
    },
  });
  setStoragePort(p);
  return p;
}

beforeEach(async () => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSaveFailureState();
  resetDatabaseFatalState();
  port = seedPort();
  await initDatabase();
  const db = getDatabase();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM telemetry_events");
  db.run(
    "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES ('sess-maint','','t',0,0,0)",
  );
});

afterEach(() => {
  resetDatabaseFatalState();
  resetSaveFailureState();
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

/**
 * 把进程切到**真机 rust 模式的数据形态**：旧库句柄不存在。
 *
 * `closeDatabase()` 关掉并置空句柄 —— 这正是 bootstrap 调 `markLegacyDbNotUsed()`
 * 之后、`getDatabase()` 会抛 "Database not initialized" 的那个状态。
 */
function enterRustMode(): void {
  closeDatabase();
}

describe("启动维护 —— rust 模式（旧库不存在）下必须照常执行", () => {
  it("MR-1: 旧库不存在时，维护**仍**回填追加日志（权威副本）与裁剪索引", async () => {
    /**
     * 造"只有索引、没有日志"的迁移场景：直接写索引命令（绕过 `createMessage`，
     * 它本身会顺带追加日志 —— 那样就没有"待回填"的历史了）。
     * 索引在 B 态就是端口，所以预置必须走端口命令。
     */
    for (let i = 0; i < 6; i++) {
      await port!.data.execute("messages.upsert_index", {
        id: `m${i}`,
        session_id: SESSION,
        role: "user",
        content: `内容 m${i}`,
        timestamp: 1000 + i,
        status: "done",
      });
    }
    await flushSessionLogWrites();
    files.clear();
    __resetJsonlCache();
    clearSessionLogCache();

    /**
     * 从这里开始就是真机的形态：旧库句柄没了。
     * 原来（缺陷版）`runDatabaseMaintenance()` 在这一行之后立刻 return，
     * 于是下面两个数字恒为 0 —— 而日志里连一行"维护完成"都没有。
     */
    enterRustMode();

    const result = await runDatabaseMaintenance({ keepEventsPerSession: 0, compactEventsOver: 0, keepIndexedMessages: 3 });

    expect(
      result.backfilledMessages,
      "追加日志回填必须在 rust 模式下执行（原来被 `if (!db) return` 整段吃掉）",
    ).toBe(6);
    expect(result.trimmedIndexMessages, "索引裁剪同样必须在 rust 模式下执行").toBe(3);
    // 日志确实落到磁盘（不是只报了个数字）
    const { messages } = await readSessionMessages(SESSION);
    expect(messages.map((m) => m.id).sort()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("MR-2: 旧库不存在时维护不抛，且结果形状完整（防「字段缺失」这类静默退化）", async () => {
    enterRustMode();
    const result = await runDatabaseMaintenance();
    for (const key of [
      "sizeBefore",
      "sizeAfter",
      "prunedTelemetry",
      "warmedAttachments",
      "prunedAttachmentOrphans",
      "compactedLogSessions",
      "backfilledMessages",
      "rebuiltIndexMessages",
      "trimmedIndexMessages",
    ] as const) {
      expect(typeof (result as Record<string, unknown>)[key], `${key} 必须是数字（缺字段会让调用方读到 undefined）`).toBe("number");
    }
  });

  it("MR-3: 遥测裁剪在 rust 模式下走引擎命令 telemetry.prune（显式水位线）", async () => {
    enterRustMode();
    await runDatabaseMaintenance({ keepTelemetryDays: 7 });

    const prune = port?.__writes().filter((w) => w.command === "telemetry.prune") ?? [];
    expect(prune.length, "rust 模式下必须调用 telemetry.prune（原来这一步随旧库一起消失）").toBeGreaterThan(0);
    const before = (prune[0].params as { before?: number } | undefined)?.before;
    expect(typeof before, "引擎侧要求显式水位线 before（没有它直接报错）").toBe("number");
    expect(before!).toBeLessThan(Date.now());
  });

  it("MR-4: 旧库存在时行为不变（回归护栏：体积统计与事件裁剪仍按原子路径走）", async () => {
    // 不调 enterRustMode()：旧库在，走旧路径
    const result = await runDatabaseMaintenance({ keepEventsPerSession: 0, compactEventsOver: 0 });
    expect(result.sizeAfter).toBeGreaterThan(0); // 旧库在时才有"库体积"这个数字
  });

  it("MR-5: rust 模式下 initDatabase() **拒绝**而不是偷偷把 WASM 库加载起来", async () => {
    /**
     * `markLegacyDbNotUsed()` 表达的约定原来只是**约定**：任何一处
     * `await initDatabase()` 都会把 sql.js 拖回渲染进程并整库读写 `codem-db.bin`。
     * 实测漏网处是 `wechat-bridge.ts::ensureWorkspaceProject`（已修）。
     * 现在这条约定是**运行期不变量**，本用例把它钉住。
     */
    enterRustMode(); // 关掉句柄
    const { markLegacyDbNotUsed } = await import("../core/storage/database");
    markLegacyDbNotUsed();
    try {
      await expect(initDatabase(), "rust 模式下 initDatabase 必须抛（加载 WASM 才是真错误）").rejects.toThrow(
        /刻意不加载旧库/,
      );
    } finally {
      const { resetLegacyDbNotUsed } = await import("../core/storage/database");
      resetLegacyDbNotUsed(); // 别把标记漏给同文件后续用例
      await initDatabase(); // 恢复旧库，供 afterEach/后续用例使用
    }
  });

  it("MR-6: 生产代码里每一处 initDatabase() 调用都必须**先判引擎**（rust 模式下不许加载旧库）", async () => {
    /**
     * 与 settings-effect / ui-font-scale 同风格：这条不变量只能从源码上守
     * （真机才跑得到 WeChat 桥，而漏网的那处就在那里）。
     *
     * 判据：每个 `initDatabase(` 调用点的**上方 5 行窗口**里必须出现引擎判据
     * （`rustActive` / `kind === "rust"` / `hasStoragePort()` / `legacyDb`）。
     * 这样"无条件调用"和"藏在 if 里"都能被区分 —— 上一版正则只看单行，
     * 把守卫块内部的合法调用也判成了违规，等于这条用例永远红。
     */
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const SRC = join(__dirname, "..");

    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (["node_modules", "dist", "__snapshots__", "test"].includes(e.name)) continue;
          out.push(...walk(p));
        } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (rel === "core/storage/database.ts") continue; // 引擎自身（resetDatabase 在守卫之后回调它）
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\binitDatabase\s*\(/.test(line)) return;
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return; // 注释
        const window = lines.slice(Math.max(0, i - 5), i + 1).join(" ");
        if (/rustActive|legacyDb|kind === "rust"|hasStoragePort\(\)/.test(window)) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `以下调用点没有先判引擎 —— rust 模式下它们会把 sql.js 拖回渲染进程并整库读写 codem-db.bin：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
