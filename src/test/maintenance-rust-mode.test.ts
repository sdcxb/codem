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
 *
 * ## 第 18 轮（L1）：这份用例反而变成了**常态**
 *
 * 现在旧引擎与测试基座的旧库初始化**都已删除** —— 本文件里的用例从一开始就跑在
 * "没有旧库"的形态下，不需要再模拟什么。MR-4（旧库存在时的旧路径）与
 * MR-5（`initDatabase()` 在 rust 模式下拒绝）随引擎退休；MR-6 升级为
 * "生产代码不许再有旧引擎入口"。
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

import { runDatabaseMaintenance } from "../core/storage/maintenance";
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
  // 干净端口 = 干净数据面（第 18 轮：旧引擎的 initDatabase/getDatabase 夹具已删）
  port = seedPort();
});

afterEach(() => {
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("启动维护 —— rust 模式（本进程唯一形态）下必须照常执行", () => {
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
    await runDatabaseMaintenance({ keepTelemetryDays: 7 });

    const prune = port?.__writes().filter((w) => w.command === "telemetry.prune") ?? [];
    expect(prune.length, "rust 模式下必须调用 telemetry.prune（原来这一步随旧库一起消失）").toBeGreaterThan(0);
    const before = (prune[0].params as { before?: number } | undefined)?.before;
    expect(typeof before, "引擎侧要求显式水位线 before（没有它直接报错）").toBe("number");
    expect(before!).toBeLessThan(Date.now());
  });

  it("MR-6: 生产代码里**不许再有旧引擎入口**（L1 收尾的不变量）", async () => {
    /**
     * 这条原来是"每处 `initDatabase()` 调用都必须先判引擎"（那时函数还在）。
     * 现在判据升级成更彻底的一条：**生产代码里不得出现指向旧引擎模块的 import**
     * （静态 / 动态 / 再导出都算）—— 那是"渲染进程重新加载 WASM 库"的唯一入口，
     * 也正是整轮迁移要消灭的东西。
     *
     * 注意这条**不检查文件是否存在**：引擎模块 `src/core/storage/database.ts` 会在
     * L1 的最后一步整体删除，而这条不变量的语义在删除前后都成立（"没有任何生产模块依赖它"），
     * 所以它不需要随删除一起改。
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

    /** 引擎模块自身是唯一允许"提到自己"的文件（它在 L1 最后一步会被整体删除） */
    const ENGINE_MODULE = "core/storage/database.ts";

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (rel === ENGINE_MODULE) continue;
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (/(?:from|import\s*\()\s*["'][^"']*storage\/database["']/.test(text) || /["']\.\/database["']/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `以下生产模块仍在 import 旧引擎模块：\n${offenders.join("\n")}`).toEqual([]);
  });
});
