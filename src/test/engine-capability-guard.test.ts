/**
 * **陈旧二进制守卫**（第 45 轮线协议审计 P2-8）。
 *
 * ## 它守的是什么
 *
 * `capabilities()`（`storage_capabilities`）能告诉渲染侧"这个引擎实现了哪些命令"，
 * 但在这次审计之前它**在生产代码里零消费者** —— 于是"安装了一个旧的、或被部分替换过的
 * 引擎二进制"这件事没有任何运行时信号：渲染侧照常发命令，引擎逐条回 `UNSUPPORTED`，
 * 用户看到的是"某些功能莫名其妙不生效"，而不是"引擎版本不对"。
 * `src-tauri/src/storage.rs` 的注释里记着这种事故**已经踩过两次**。
 *
 * ## 判据与"不误报"的边界
 *
 * 只查一小组**长期存在**的命令（`CRITICAL_ENGINE_COMMANDS`）：它们的缺失只可能意味着
 * "这个二进制不是本版本引擎"，而不是"某个功能还没实现"。所以这条用例同时钉住两侧 ——
 * 缺命令必须**可见地**报出来，健康引擎**一条都不许报**（误报会让真信号贬值）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { registerRustStoragePort, shutdownRustStoragePort } from "../core/storage/bootstrap";
import type { StorageTransport } from "../core/storage/rust-port";

const reported: Array<{ scope: string; note: string; error: unknown }> = [];

vi.mock("../core/storage/persist-failure", () => ({
  reportActionFailure: (scope: string, error: unknown, note: string) => {
    reported.push({ scope, note, error });
  },
  reportPersistFailure: (scope: string, error: unknown, note: string) => {
    reported.push({ scope, note, error });
  },
  reportAdvisory: (_s, finding, _o) => {
    reported.push(typeof finding === "string" ? finding : String(finding));
  },
}));

/** 健康的引擎命令清单（与真机 `commands` 输出同形，取其中长期存在的那一小组） */
const HEALTHY_COMMANDS = [
  "settings.get_all",
  "settings.set",
  "events.append",
  "messages.create",
  "messages.upsert_index",
  "messages.get",
  "messages.list",
  "messages.delete",
  "messages.count",
  "sessions.upsert",
  "projects.upsert",
  "crud.list",
  "crud.upsert",
  "crud.delete",
  "crud.count",
  "health",
  "integrity_check",
  "checkpoint",
  "counts",
];

function makeTransport(commands: string[] | null): StorageTransport {
  return {
    invokeCommand: async () => ({ ok: true, result: { written: 1 } }) as never,
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () =>
      ({
        ok: true,
        result: {
          ready: true,
          path: "C:/tmp/rust.bin",
          size_bytes: 4096,
          journal_mode: "wal",
          wal_size_bytes: 0,
          tables: 45,
          fts_module: "fts5",
          last_error_code: null,
        },
      }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true, detail: "ok" } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => {
      // `null` = 引擎不回命令清单（老引擎形态）
      if (commands === null) throw new Error("storage_capabilities 不可用");
      return { commands } as never;
    },
  };
}

beforeEach(async () => {
  reported.length = 0;
  await shutdownRustStoragePort();
  setStoragePort(null);
});

afterEach(async () => {
  await shutdownRustStoragePort();
  setStoragePort(null);
});

describe("存储引擎能力守卫（陈旧二进制的运行时信号）", () => {
  it("CAP-1: 引擎缺少必需命令 → **必须**上报一条可见失败，并列出缺了哪些", async () => {
    // 只有 health 的"残缺引擎"
    await registerRustStoragePort(makeTransport(["health"]), "test.capabilities");
    await new Promise((r) => setTimeout(r, 20)); // 守卫是异步发起的（不阻塞启动）

    const hit = reported.find((r) => r.scope === "test.capabilities.capabilities");
    expect(hit, "缺命令必须有一条上报 —— 否则'功能莫名不生效'永远查不到引擎版本这一层").toBeTruthy();
    const msg = String((hit?.error as Error)?.message ?? "");
    expect(msg, "上报必须说清缺了多少条").toMatch(/缺少 \d+ 条必需命令/);
    expect(msg, "并且要点名（可诊断）").toContain("messages.upsert_index");
    expect(String(hit?.note), "要给用户可执行的下一步").toContain("重新安装");
  });

  it("CAP-2: 健康引擎（命令齐全）→ **一条都不许报**（误报会让真信号贬值）", async () => {
    await registerRustStoragePort(makeTransport(HEALTHY_COMMANDS), "test.capabilities");
    await new Promise((r) => setTimeout(r, 20));

    expect(
      reported.filter((r) => r.scope.includes("capabilities")),
      "健康引擎缺命令是不成立的：报了就说明判据写错了",
    ).toEqual([]);
  });

  it("CAP-3: 读不到命令清单 → 留痕但不误判成'版本不匹配'", async () => {
    await registerRustStoragePort(makeTransport(null), "test.capabilities");
    await new Promise((r) => setTimeout(r, 20));

    const hit = reported.find((r) => r.scope === "test.capabilities.capabilities");
    expect(hit, "校验不了必须留痕 —— '校验不了'不能长得像'校验通过'").toBeTruthy();
    expect(
      String((hit?.error as Error)?.message ?? ""),
      "读不到清单与'缺命令'是两件事，文案不许混为一谈",
    ).not.toMatch(/缺少 \d+ 条必需命令/);
  });
});
