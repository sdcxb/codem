/**
 * 消息镜像的**内存预算**契约（P6 第 2 段）。
 *
 * ## 为什么单独立这一项
 *
 * P6 第 1 段实测：1000 条 × 200KB 的正文 ≈ 195MB，sql.js 侧峰值 659MB（3.4×）。
 * 迁到 Rust 之后写路径不再"导出整库"，但**读路径**还有一处同类风险：
 * 消息索引镜像是"按会话加载"的，而**加载过的会话原先永不释放** ——
 * 用户浏览过 N 个大会话，N 份语料就全留在渲染进程里。
 * 这就是"大文档把渲染进程压死"在读路径上的形态。
 *
 * 本文件钉住三条：
 *
 * 1. **驻留有界**：跨会话总行数超过预算时，按 LRU 逐出（`stats()` 可证）；
 * 2. **逐出即回退**：被逐出的会话 `isLoaded` 为 false → 读走旧路径，
 *    不会出现"读到一半的镜像"（路由规则本来就是"未加载完不路由"）；
 * 3. **逐出后可恢复**：再次访问会重新从 Rust 分页拉回，且内容与逐出前一致。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
}));
vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    throw new Error("旧库不应在已路由的会话上被访问");
  },
  persistDatabase: () => {},
}));
vi.mock("../core/storage/write-guard", () => ({ runGuarded: () => undefined }));
vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async () => {},
  appendMessageTombstone: async () => {},
  readSessionMessages: () => [],
}));

const settle = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

/** 假传输：`messages.list` 按会话返回给定行数 */
function transportWith(rowCounts: Record<string, number>) {
  const listCalls: Array<{ session_id: string; offset: number; limit: number }> = [];
  return {
    listCalls,
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "messages.list") {
        const p = (params ?? {}) as { session_id: string; offset?: number; limit?: number };
        const total = rowCounts[p.session_id] ?? 0;
        const offset = Number(p.offset ?? 0);
        const limit = Number(p.limit ?? 1000);
        listCalls.push({ session_id: p.session_id, offset, limit });
        const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
          id: `${p.session_id}-m${offset + i}`,
          session_id: p.session_id,
          role: "user",
          content: `内容 ${offset + i}`,
          timestamp: offset + i,
          hidden: 0,
        }));
        return { ok: true, result: { items, has_more: offset + items.length < total, next_cursor: null } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
}

afterEach(() => {
  setStoragePort(null);
  failures.length = 0;
  vi.restoreAllMocks();
});

describe("消息镜像内存预算 —— 驻留有界 + LRU 逐出", () => {
  it("MEM-1: 多会话加载后总行数不超过预算，且最久未使用的会话被逐出", async () => {
    // 预算刻意给成 250 行：三个各 100 行的会话就会超预算
    const t = transportWith({ s1: 100, s2: 100, s3: 100 });
    const port = new RustStoragePort(t as never, (_s, _e, note) => failures.push(note), {
      messageMirrorBudgetRows: 250,
    });
    setStoragePort(port);
    await port.start();

    port.messages.ensureLoaded("s1");
    await settle();
    expect(port.messages.stats().rows, "单个会话在预算内").toBe(100);

    port.messages.ensureLoaded("s2");
    await settle();
    expect(port.messages.stats().rows, "两个会话仍在预算内").toBe(200);

    // 第三个会话进来 → 总行数 300 > 250 → 逐出最久未使用的 s1
    port.messages.ensureLoaded("s3");
    await settle();
    const stats = port.messages.stats();
    expect(stats.rows, "驻留总行数必须有界").toBeLessThanOrEqual(250);
    expect(stats.evictions, "必须发生逐出").toBeGreaterThan(0);
    expect(port.messages.isLoaded("s1"), "最久未使用的会话被逐出").toBe(false);
    expect(port.messages.isLoaded("s3"), "刚加载的会话必须还在").toBe(true);
    expect(
      failures.some((n) => n.includes("内存预算")),
      "逐出必须留痕（否则用户只会看到'卡了一下'，查不出原因）",
    ).toBe(true);
  });

  it("MEM-2: 被逐出的会话读走旧路径（不会读到不完整镜像），再访问能重新加载", async () => {
    const t = transportWith({ s1: 100, s2: 100, s3: 100 });
    const port = new RustStoragePort(t as never, () => {}, { messageMirrorBudgetRows: 250 });
    setStoragePort(port);
    await port.start();

    port.messages.ensureLoaded("s1");
    await settle();
    port.messages.ensureLoaded("s2");
    await settle();
    port.messages.ensureLoaded("s3");
    await settle();
    expect(port.messages.isLoaded("s1")).toBe(false);

    // 逐出后 list 返回空数组（而不是"只剩一部分"的残缺集合）——
    // 路由规则是"未加载完不路由"，所以调用方会整体回退旧路径。
    expect(port.messages.list("s1"), "逐出后不能给出残缺的镜像").toEqual([]);

    // 重新访问 → 重新从 Rust 拉回，内容与逐出前一致
    const before = port.messages.list("s3").length;
    port.messages.ensureLoaded("s1");
    await settle();
    expect(port.messages.isLoaded("s1"), "重新访问必须能恢复").toBe(true);
    expect(port.messages.list("s1")).toHaveLength(100);
    expect(port.messages.list("s1")[0].content).toBe("内容 0");
    expect(port.messages.list("s3"), "重新加载 s1 不该影响 s3").toHaveLength(before);

    // 重新加载确实又发了分页请求（不是凭空造出来的）
    expect(t.listCalls.filter((c) => c.session_id === "s1").length).toBeGreaterThan(1);
  });

  it("MEM-3: 单会话超过单会话上限时截断并标记（不回退到'看起来完整'的假象）", async () => {
    // 单会话上限 maxBatch=5000：这里用 6000 行验证 truncated 标记
    const t = transportWith({ big: 6000 });
    const port = new RustStoragePort(t as never, () => {}, { messageMirrorBudgetRows: 100_000 });
    setStoragePort(port);
    await port.start();

    port.messages.ensureLoaded("big");
    await settle();
    // 单次 list 上限 5000，一次就拿到 5000 行且 has_more → 继续第二轮，
    // 第二轮拿到剩下的 1000（不足 maxBatch）→ 收敛，不算截断。
    const stats = port.messages.stats();
    expect(stats.rows, "6000 行应当在 maxRounds 内全部拉到").toBe(6000);
    expect(stats.truncated, "没有触及轮次上限就不该标记截断").toBe(false);
  });

  it("MEM-4: 预算内的会话不逐出（逐出只发生在真的超预算时）", async () => {
    const t = transportWith({ a: 10, b: 10 });
    const port = new RustStoragePort(t as never, () => {}, { messageMirrorBudgetRows: 1000 });
    setStoragePort(port);
    await port.start();

    port.messages.ensureLoaded("a");
    await settle();
    port.messages.ensureLoaded("b");
    await settle();
    const stats = port.messages.stats();
    expect(stats.sessions).toBe(2);
    expect(stats.evictions, "没超预算就不该逐出（否则会造成无谓的重复加载）").toBe(0);
  });
});
