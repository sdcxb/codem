/**
 * 24 号文 P2-B：**跨启动索引缓存**（`memory-index-cache`）。
 *
 * ## 被守的缺陷
 *
 * 记忆每次启动都要把整份 payload 读进来、逐条算派生读数（摘要/正文指纹）。内容没变、
 * 结果也不会变，但成本每次都要重付，而它恰好落在启动最敏感的那段时间。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | MEM-IDX-1 | 内容没变的重启：**命中缓存**，一条摘要都不重算（`summaryComputations === 0`） |
 * | MEM-IDX-2 | 内容变了（另一客户端写库，缓存没跟着更新）：缓存**失效**且只重算**变过的那一条** |
 * | MEM-IDX-3 | 缓存损坏：按没有缓存处理（warn 一行）、记忆照常读出来、下一次保存后缓存自动修好 |
 * | MEM-IDX-4 | 缓存**有界**（≤ 256 KB）：超了按"最不值钱"的顺序裁，并如实记 `truncated` |
 *
 * ## 变异自证
 *
 * - 去掉 `payloadHash` 校验（无条件复用缓存）⇒ MEM-IDX-2 红（会拿陈旧摘要当新内容）；
 * - 把 `buildMemoryIndex` 的 `previous` 恒传 `null` ⇒ MEM-IDX-1 红（每次都重算）；
 * - 去掉 `makeIndexCache` 的字节裁剪 ⇒ MEM-IDX-4 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getSetting, patchMemoryMirror, setSetting } from "../core/storage/settings";
import {
  MemoryService,
  __memoryPerfStats,
  __resetMemoryPerfStats,
  type MemoryEntry,
} from "../core/memory/memory";
import {
  MEMORY_INDEX_CACHE_KEY,
  MEMORY_INDEX_CACHE_MAX_BYTES,
  makeIndexCache,
  type MemoryIndexRecord,
} from "../core/memory/memory-index";

let port: FakeStoragePort;

beforeEach(() => {
  __resetMemoryPerfStats();
  port = createFakeStoragePort();
  setStoragePort(port);
});
afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

function addPlatform(svc: MemoryService, key: string, content: string): MemoryEntry {
  const result = svc.add({ scope: "platform", key, content, source: "manual" });
  expect(result.ok).toBe(true);
  return result.entry!;
}

/** 从库里读当前 payload（fake port 的 `memory.get`，与合并走同一条读路径） */
async function readPayload(): Promise<{ entries: Record<string, MemoryEntry> }> {
  const res = (await port.data.command("memory.get", {})) as { content?: string };
  return JSON.parse(res.content ?? "{}") as { entries: Record<string, MemoryEntry> };
}

describe("MEM-IDX：跨启动索引缓存", () => {
  it("MEM-IDX-1：内容没变的重启 ⇒ 命中缓存，一条摘要都不重算", async () => {
    const svc = new MemoryService();
    const a = addPlatform(svc, "构建约定", "跑 npm run build");
    addPlatform(svc, "测试约定", "跑 npm test");
    addPlatform(svc, "发布约定", "发布前跑回归");
    await svc.flushPendingPersist();

    // 缓存必须真的落库（独立小键，不写进 memory payload）
    const cached = getSetting(MEMORY_INDEX_CACHE_KEY);
    expect(cached, "索引缓存必须写进 settings 的独立键").toBeTruthy();
    const parsed = JSON.parse(cached!) as { version: number; payloadHash: string; entries: unknown[] };
    expect(parsed.version).toBeGreaterThan(0);
    expect(parsed.payloadHash.length).toBe(64);
    expect(parsed.entries.length).toBe(3);

    __resetMemoryPerfStats();
    const restarted = new MemoryService();
    const stats = restarted.getIndexCacheStats();
    expect(stats.status, "payload 哈希一致 ⇒ 必须判为命中").toBe("hit");
    expect(stats.recomputed, "命中缓存不许重算任何摘要").toBe(0);
    expect(
      __memoryPerfStats().summaryComputations,
      "命中缓存的启动过程里，摘要函数必须一次都没被调用（这是「缓存真的生效」的唯一硬证据）",
    ).toBe(0);
    expect(restarted.get(a.id)!.content, "记忆内容本身照常读出来").toBe("跑 npm run build");

    // 命中之后不该马上重写缓存（每份 payload 只写一次）
    const writesBefore = port.__writes().filter((w) => w.command === "crud.upsert").length;
    const again = new MemoryService();
    expect(again.getIndexCacheStats().status).toBe("hit");
    expect(
      port.__writes().filter((w) => w.command === "crud.upsert").length,
      "连续两次启动（内容没变）不该反复写同一个缓存",
    ).toBe(writesBefore);
  });

  it("MEM-IDX-2：内容变了（缓存没跟着更新）⇒ 缓存失效且只重算变过的那一条", async () => {
    const svc = new MemoryService();
    const changed = addPlatform(svc, "会变的", "原始正文");
    addPlatform(svc, "不变的", "一直这样");
    await svc.flushPendingPersist();

    /*
     * 模拟**另一个客户端**改了库：直接写 payload，**不**更新索引缓存
     * （这正是缓存必须校验 payloadHash 的场景；也是本判据的变异点）。
     */
    const payload = await readPayload();
    payload.entries[changed.id] = { ...payload.entries[changed.id], content: "另一个客户端改的正文", rev: 2 };
    const nextPayload = JSON.stringify(payload);
    await port.data.execute("memory.set", { content: nextPayload });
    patchMemoryMirror(nextPayload);

    __resetMemoryPerfStats();
    const restarted = new MemoryService();
    const stats = restarted.getIndexCacheStats();
    expect(stats.status, "payload 变了 ⇒ 不许判命中（否则就是拿陈旧摘要当新内容）").not.toBe("hit");
    expect(stats.recomputed, "只有变过的那一条需要重算（逐条内容指纹的意义）").toBe(1);
    expect(__memoryPerfStats().summaryComputations).toBe(1);
    expect(restarted.get(changed.id)!.content).toBe("另一个客户端改的正文");

    // 下一次保存会把缓存刷成新的（缓存跟着内容走）
    restarted.update(changed.id, { content: "再改一次" }, { actor: "user" });
    await restarted.flushPendingPersist();
    __resetMemoryPerfStats();
    const third = new MemoryService();
    expect(third.getIndexCacheStats().status).toBe("hit");
    expect(__memoryPerfStats().summaryComputations).toBe(0);
  });

  it("MEM-IDX-3：缓存损坏 ⇒ 按没有缓存处理，记忆照读、下一次保存自动修好", async () => {
    const svc = new MemoryService();
    addPlatform(svc, "甲", "甲的正文");
    addPlatform(svc, "乙", "乙的正文");
    await svc.flushPendingPersist();

    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSetting(MEMORY_INDEX_CACHE_KEY, "{这不是 JSON");
    __resetMemoryPerfStats();
    const restarted = new MemoryService();

    expect(restarted.getLoadState().ok, "缓存坏掉**不许**影响记忆读取").toBe(true);
    expect(restarted.listAll().length, "记忆条目一条都不少").toBe(2);
    expect(restarted.getIndexCacheStats().status).toBe("corrupt");
    expect(restarted.getIndexCacheStats().recomputed, "坏缓存 ⇒ 全部重算").toBe(2);
    expect(
      warned.mock.calls.some((call) => String(call[0]).includes("索引缓存不可用")),
      "坏缓存必须留一行 warn（不静默）",
    ).toBe(true);

    // 下一次保存之后缓存恢复成合法 JSON
    restarted.update(restarted.listAll()[0].id, { content: "改一条触发保存" }, { actor: "user" });
    await restarted.flushPendingPersist();
    const repaired = getSetting(MEMORY_INDEX_CACHE_KEY);
    expect(repaired).toBeTruthy();
    expect(() => JSON.parse(repaired!)).not.toThrow();
  });

  it("MEM-IDX-4：缓存有界（≤ 256 KB，超出按最不值钱的丢）", () => {
    const records: MemoryIndexRecord[] = Array.from({ length: 600 }, (_, i) => ({
      id: `mem-${i}`,
      key: `键-${i}`,
      scope: "platform",
      usageCount: i,
      summary: "甲".repeat(160),
      contentSha256: "a".repeat(64),
    }));
    const { cache, truncated } = makeIndexCache(records, { payloadHash: "f".repeat(64), builtAt: 1 });
    expect(truncated, "超上限必须有条目被裁掉（否则「有界」只是口号）").toBeGreaterThan(0);
    expect(JSON.stringify(cache).length * 2, "缓存字节必须 ≤ 上限（2 字节/字符的保守口径）").toBeLessThanOrEqual(
      MEMORY_INDEX_CACHE_MAX_BYTES,
    );
    expect(cache.entries.length + truncated).toBe(records.length);
    expect(cache.truncated, "裁掉多少条必须如实记下（命中后要重算的就是这些）").toBe(truncated);
    // 用得最少的先丢（`usageCount` 升序）
    const keptUsage = cache.entries.map((r) => r.usageCount);
    expect(Math.min(...keptUsage), "留下的应当是「用得较多」的那些").toBeGreaterThan(0);
  });
});
