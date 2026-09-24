/**
 * 自动迁移的**守卫契约**（第 11 轮）。
 *
 * ## 背景：一条"整库重写"的命令，判据却在调用方
 *
 * `migration.auto` 是唯一会重写整库的命令（历史上它还会**先整表清空**，
 * 见 `migrate.rs::import_all` 的说明与 `storage_audit` 的两条真机证据）。
 * 它跑不跑，完全由渲染侧这里的三条判据决定：
 *
 * 1. 新库里不能有会话、也不能有消息；
 * 2. 有迁移标记时，只有"关键表确实为空 + 旧库有内容"才允许重跑；
 * 3. 旧库路径拿得到。
 *
 * 而这里原来有一个**致命的兜底**：读 `settings`（标记所在处）失败时，
 * `catch {}` 直接**继续往下走**去跑迁移 —— 所有守卫一个都没执行。
 * 一次瞬时读失败就能触发"整库重写"，这与 `self-heal.ts` 里那处 `?? 0` 是同一类缺陷：
 * **把"读不到"当成"是空的"**。
 *
 * 所以这一组用例守的是：**任一守卫读不到 → 不迁移**（数据本来就在，等下次）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

/** `legacyDbPath()` 走 `get_app_data_dir`，所以给它一个最简 Tauri 桩 */
function stubAppDataDir(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

const restoreCalls = (port: { __writes(): Array<{ command: string; params?: Record<string, unknown> }> }) =>
  port.__writes().filter((w) => w.command === "migration.auto" && w.params?.dry_run !== true);

const sessionRow = { id: "s1", project_id: "", title: "会话", created_at: 1, last_message_at: 1, message_count: 0, pinned: 0 };
const messageRow = { id: "m1", session_id: "s1", role: "user", content: "内容", timestamp: 1, hidden: 0 };

afterEach(() => {
  setStoragePort(null);
  failures.length = 0;
  vi.restoreAllMocks();
});

describe("自动迁移的守卫", () => {
  it("MG-1: 读不到 settings（标记与守卫数据）→ **不迁移**", async () => {
    stubAppDataDir();
    const port = createFakeStoragePort({ legacyMessageRows: 821, seed: { messages: [] } });
    // 让 crud.list(settings) 失败 —— 这就是真机上"引擎刚打开/命令超时"的形态
    const originalQuery = port.data.query.bind(port.data);
    (port.data as { query: unknown }).query = async (cmd: string, params?: Record<string, unknown>, page?: unknown) => {
      if (params?.table === "settings") throw new Error("模拟：crud.list(settings) 暂时不可用");
      return (originalQuery as never)(cmd, params, page);
    };
    setStoragePort(port);

    const { migrateFromLegacyDb } = await import("../core/storage/bootstrap");
    const res = await migrateFromLegacyDb("test");

    expect(res.kind, "读不到就必须放弃本次迁移").toBe("skipped");
    expect(restoreCalls(port).length, "**绝不能**在守卫没跑过的情况下重写整库").toBe(0);
    expect(res.kind === "skipped" && res.reason.includes("读不到"), "理由要能诊断").toBe(true);
  });

  it("MG-2: 新库已有消息 → 不迁移（不覆盖更新的数据）", async () => {
    stubAppDataDir();
    const port = createFakeStoragePort({ legacyMessageRows: 821, seed: { messages: [messageRow] } });
    setStoragePort(port);

    const { migrateFromLegacyDb } = await import("../core/storage/bootstrap");
    const res = await migrateFromLegacyDb("test");

    expect(res.kind).toBe("skipped");
    expect(restoreCalls(port).length).toBe(0);
  });

  it("MG-3: 有迁移标记且关键表非空 → 不迁移", async () => {
    stubAppDataDir();
    const port = createFakeStoragePort({
      legacyMessageRows: 821,
      seed: {
        messages: [messageRow],
        settings: [{ key: "codem-storage-migrated-at", value: "1" }],
      },
    });
    setStoragePort(port);

    const { migrateFromLegacyDb } = await import("../core/storage/bootstrap");
    const res = await migrateFromLegacyDb("test");

    expect(res.kind).toBe("skipped");
    // 具体理由可能是"已有迁移标记"，也可能是更早的一条守卫（"新库已有消息数据"）——
    // 两者都正确：**关键是没有任何一条路径去重写整库**。
    expect(restoreCalls(port).length, "有数据在就绝不允许重写整库").toBe(0);
  });

  it("MG-4: 标记在、关键表确实为空、旧库有内容 → 允许重跑（自愈路径不能被挡死）", async () => {
    stubAppDataDir();
    const port = createFakeStoragePort({
      legacyMessageRows: 5,
      seed: {
        settings: [{ key: "codem-storage-migrated-at", value: "1" }],
        // 半迁移形态：项目搬好了，会话/消息/事件/工具调用全空
        projects: [{ id: "p1", name: "项目", path: "C:/p", pinned: 0, created_at: 1, last_accessed_at: 1 }],
      },
    });
    setStoragePort(port);

    const { migrateFromLegacyDb } = await import("../core/storage/bootstrap");
    const res = await migrateFromLegacyDb("test");

    expect(res.kind, "真·空库时要能自愈，否则用户永远看不到历史").toBe("migrated");
    expect(restoreCalls(port).length).toBe(1);
  });
});
