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
import { hasStoragePort, setStoragePort } from "../core/storage/port";
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
  /**
   * 第 19 轮：这里原来是 `if (getStoragePort().kind !== "rust") return null;` ——
   * `kind` 是常量 `"rust"`（唯一实现），所以它恒不成立，实际效果只是"悄悄不换端口"。
   * 与其留一个不成立的守卫，不如把不变量**断言出来**（见下面 port 赋值处的 MR-0 说明）。
   */
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

  /**
   * ## B-8：遥测裁剪的三态必须分得开，且裁剪之后**镜像要跟着更新**
   *
   * 原实现只有 `execute("telemetry.prune")` + 失败时一行 `console.warn`：
   * ① 失败/没跑/没得裁在汇总行里**都显示"遥测裁剪 0 条"**（而本模块的头注释
   *   恰恰把"必须能区分没跑与跑了没事做"当设计目标）；
   * ② 裁剪只改库、**不更新域镜像**，而性能面板读的是镜像 → 用户看到"裁了之后事件还在"。
   */
  it("MR-7: 裁剪成功时汇总行报真实条数，并把过期行从遥测镜像里清掉", async () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天前（远超 7 天水位线）
    const fresh = Date.now();
    port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
        telemetry_events: [
          { id: "t-old-1", session_id: SESSION, event_name: "e", timestamp: old, event_data: "{}" },
          { id: "t-old-2", session_id: SESSION, event_name: "e", timestamp: old, event_data: "{}" },
          { id: "t-new", session_id: SESSION, event_name: "e", timestamp: fresh, event_data: "{}" },
        ],
      },
    });
    setStoragePort(port);
    /**
     * ⚠️ 假端口的 `telemetry.prune` 只是落到通用的 `persist()` 上（返回 0 行），
     * 它**模拟不了引擎那条按水位线删的 SQL**。所以这里按真引擎的语义补一个桩
     * （顺带证明"引擎裁掉的行"确实会被镜像同步那一步按 id 删掉）：
     * 这正是 B-8 要守的形态 —— 引擎归引擎、**镜像必须跟着走**。
     */
    const realExecute = port.data.execute.bind(port.data);
    (port.data as { execute: unknown }).execute = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "telemetry.prune") {
        const before = Number((params as { before?: number } | undefined)?.before ?? 0);
        const rows = port!.__table("telemetry_events") as Array<Record<string, unknown>>;
        const expired = rows.filter((r) => Number(r.timestamp ?? 0) < before);
        for (const r of expired) {
          await realExecute("crud.delete", { table: "telemetry_events", where: { id: r.id } });
        }
        return { written: expired.length };
      }
      return realExecute(cmd, params);
    };

    const result = await runDatabaseMaintenance({ keepTelemetryDays: 7 });

    expect(result.prunedTelemetry, "过期的 2 条必须被裁掉（数字必须是真的）").toBe(2);
    // 镜像同步：性能面板读的就是这份镜像
    const ids = (port.__table("telemetry_events") as Array<Record<string, unknown>>).map((r) => String(r.id));
    expect(ids, "过期行必须从遥测镜像里消失（否则面板一直显示已删事件）").not.toContain("t-old-1");
    expect(ids, "未过期的行必须留着").toContain("t-new");
  });

  it("MR-8: 没有过期数据时汇总行说「未执行（没有早于水位线的遥测事件）」——不是「裁剪 0 条」", async () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runDatabaseMaintenance({ keepTelemetryDays: 7 });
    const lines = warn.mock.calls.flat().map(String).join("\n");
    warn.mockRestore();

    expect(result.prunedTelemetry).toBe(0);
    expect(lines, "「没得裁」必须与「裁了 0 条」区分开").toContain("遥测裁剪 未执行");
    expect(lines, "原因要写在汇总行里").toContain("没有早于水位线");
  });

  it("MR-9: 裁剪失败时汇总行说「失败（原因）」，与「没得裁 / 没跑」都能区分", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = port!.data.execute;
    (port!.data as { execute: unknown }).execute = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "telemetry.prune") throw new Error("模拟：IPC 报错");
      return original.call(port!.data, cmd, params);
    };

    const result = await runDatabaseMaintenance({ keepTelemetryDays: 7 });
    const logLines = log.mock.calls.flat().map(String).join("\n");
    const warnLines = warn.mock.calls.flat().map(String).join("\n");
    log.mockRestore();
    warn.mockRestore();

    expect(result.prunedTelemetry, "失败时不能报成「裁了 0 条」").toBe(0);
    expect(logLines, "汇总行必须说明「失败了」，并带上原因").toContain("遥测裁剪 失败");
    expect(logLines, "原因要能看见（否则等于没上报）").toContain("IPC 报错");
    expect(warnLines, "既有的 warn 通道要保留（SNAP-6 / MAINT-5 按它认领这条告警）").toContain("遥测裁剪");
  });

  /**
   * ## 第 45 轮：四条"引擎有能力、渲染侧零调用"的能力接线
   *
   * | 命令 | 原来零调用的后果 | 接线后要看到什么 |
   * | --- | --- | --- |
   * | `audit.prune` | `storage_audit` **无界增长**（真机 11.8 小时 61,416 行、库内最大的表、占活数据 35.6%） | 汇总行报"裁剪 N 条 / 剩余 M 条" |
   * | `audit.stats` | 这张表在涨**没有任何途径看得见** | 汇总行报审计表规模 |
   * | `storage.compact` | 真机 115,191,808 B 里 85.8% 是永不回收的空闲页 | 汇总行区分"未达阈值"与"回收了 N 字节" |
   * | `integrity_check` | **数据页损坏无人发现**（引擎只在头部损坏时自动恢复，而渲染侧零调用） | 节流跑一次；失败 → 写索引重建标记 |
   */
  it("MR-10: 维护按保留窗口裁审计，并如实报出「裁掉多少 / 还剩多少」", async () => {
    const now = Date.now();
    const old = now - 30 * 24 * 60 * 60 * 1000; // 30 天前（远超 7 天保留窗口）
    port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
        storage_audit: [
          { id: 1, at: old, table_name: "messages", op: "DELETE", row_count: 1, key_sample: "x", session_id: "s1" },
          { id: 2, at: old, table_name: "messages", op: "DELETE", row_count: 1, key_sample: "y", session_id: "s1" },
          { id: 3, at: now, table_name: "messages", op: "HIDE", row_count: 1, key_sample: "z", session_id: "s1" },
        ],
      },
    });
    setStoragePort(port);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runDatabaseMaintenance();
    const lines = log.mock.calls.flat().map(String).join("\n");
    log.mockRestore();

    expect(result.prunedAuditRows, "窗口外的 2 条必须被裁掉").toBe(2);
    expect(result.auditStatsRead, "审计规模必须读到（它是「这张表在涨」的唯一可见途径）").toBe(true);
    expect(result.auditRemainingRows, "裁剪之后只剩窗口内的 1 条").toBe(1);
    expect(lines, "汇总行要报「裁剪 N 条 / 剩余 M 条」，不是只报裁掉多少").toContain("审计裁剪 2 条");
    expect(lines, "剩余数必须出现在同一行").toContain("剩余 1 条");
    // 真的删了（不是只报了个数字）
    expect((port.__table("storage_audit") as unknown[]).length).toBe(1);
  });

  it("MR-11: 空间回收如实区分「未达阈值」与「回收了 N 字节」", async () => {
    // 形态一：未达阈值（真机小库就是这个形态 —— 探针实测 performed:false）
    port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);
    const log1 = vi.spyOn(console, "log").mockImplementation(() => {});
    const noop = await runDatabaseMaintenance();
    const lines1 = log1.mock.calls.flat().map(String).join("\n");
    log1.mockRestore();

    expect(noop.compactPerformed, "未达阈值时**没有**做整库重写").toBe(false);
    expect(noop.compactedBytes).toBe(0);
    expect(
      lines1,
      "「跑了但没做（未达阈值）」必须与「跑了并回收了 N 字节」在汇总行里分得开 —— " +
        "把它渲染成「回收 0 字节」就退回了「三种情况一个样子」",
    ).toContain("空间回收 未执行");
    expect(lines1, "未执行要带原因/依据（空闲页规模）").toContain("空闲");

    // 形态二：真的回收了（探针实测真机上 115MB 的库会走这一支）
    port = createFakeStoragePort({
      compactReclaims: 4 * 1024 * 1024,
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);
    const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
    const done = await runDatabaseMaintenance();
    const lines2 = log2.mock.calls.flat().map(String).join("\n");
    log2.mockRestore();

    expect(done.compactPerformed).toBe(true);
    expect(done.compactedBytes, "回收字节数必须是真的（来自引擎的 reclaimed_bytes）").toBe(4 * 1024 * 1024);
    expect(lines2).toContain("空间回收 已回收 4.0 MiB");
    expect(lines2, "耗时也要如实报").toContain("10 ms");
  });

  it("MR-12: 完整性检查**首次必跑**，写节流时间戳；12 小时内不重复跑", async () => {
    port = createFakeStoragePort({
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await runDatabaseMaintenance();
    const lines = log.mock.calls.flat().map(String).join("\n");
    log.mockRestore();

    expect(first.integrity, "第一次维护必须真的检查（`quick_check` 901ms@10k / 4469ms@100k）").toBe("ok");
    expect(lines, "汇总行要报「完整性检查 通过」").toContain("完整性检查 通过");
    const marker = (port.__table("settings") as Array<Record<string, unknown>>).find(
      (s) => s.key === "codem-storage-integrity-checked-at",
    );
    expect(marker, "节流时间戳必须落进 settings（内存变量做不到跨进程节流）").toBeTruthy();

    // 同一个进程再跑一次维护：节流生效（12 小时内不重复跑）
    const second = await runDatabaseMaintenance();
    expect(second.integrity, "12 小时内不重复跑").toBe("skipped");

    /**
     * 反向对照：把时间戳改成 13 小时前 → 必须**再检查一次**。
     * 少了这条对照，"永远跳过"也会让上一条断言变绿。
     *
     * ⚠️ `__table()` 返回的是**克隆**（防用例互相污染），改它不会影响端口里的表 ——
     * 所以这里走端口自己的命令把时间戳写回去（这也是真机上唯一合法的改法）。
     */
    await port.data.execute("settings.set", {
      key: "codem-storage-integrity-checked-at",
      value: String(Date.now() - 13 * 60 * 60 * 1000),
    });
    const third = await runDatabaseMaintenance();
    expect(third.integrity, "超过窗口之后必须重新检查（否则节流会退化成永久关闭）").toBe("ok");
  });

  it("MR-13: 完整性检查失败 → 写「索引需要重建」标记 + 如实上报（D12）", async () => {
    port = createFakeStoragePort({
      integrityFailure: "database disk image is malformed",
      seed: {
        sessions: [{ id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    });
    setStoragePort(port);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runDatabaseMaintenance();
    const lines = log.mock.calls.flat().map(String).join("\n");
    const warns = warn.mock.calls.flat().map(String).join("\n");
    log.mockRestore();
    warn.mockRestore();

    expect(result.integrity).toBe("failed");
    expect(lines, "汇总行要报「失败」并带细节（否则「检查过了」与「检查失败」分不开）").toContain(
      "完整性检查 **失败**",
    );
    expect(lines).toContain("database disk image is malformed");
    expect(warns, "失败必须留下可诊断的痕迹").toContain("完整性检查失败");
    /**
     * 关键动作：**写索引重建标记**。
     * 数据页损坏时引擎不会自动恢复（只有头部损坏才走 `open_with_recovery`），
     * 而"经可从权威日志重建"这条分层就是这里的兜底 —— 标记写下之后，
     * 下一次维护会据此重建索引并清掉标记。
     */
    const markerPath = `C:\\appdata\\${"codem-index-rebuild-needed.json"}`;
    expect(files.has(markerPath), "必须写下「索引需要重建」标记（复用 markIndexRebuildNeeded）").toBe(true);
    expect(String(files.get(markerPath))).toContain("完整性检查失败");
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
