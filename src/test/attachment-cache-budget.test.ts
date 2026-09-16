/**
 * 外置附件缓存的**内存预算**契约（P6 第 3 段）。
 *
 * ## 为什么单独立这一项
 *
 * 附件正文动辄几 MB（外置阈值 64KB），而缓存原来是"读过就永不释放"的 `Map`：
 * 用户翻过十个长文档附件，几十 MB 就**永久**留在渲染进程里 ——
 * 与消息镜像"加载过的会话永不释放"是同一类病（驻留无界）。
 *
 * 本文件钉住三条：
 * 1. **驻留有界**：总字节不会超过预算（`externalContentCacheStats()` 可证）；
 * 2. **逐出按 LRU**：最久未使用的先走，刚用过的留着；
 * 3. **逐出不改变语义**：被逐出的路径再读会走"补一次异步预取"的既有路径
 *    （返回 undefined、下次命中），**不会读到别的内容**。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** 受控的文件层：每个路径返回指定大小的内容 */
const files = new Map<string, string>();
vi.mock("../core/file-api", () => ({
  getAppDataDir: async () => "C:\\appdata\\codem",
  readFile: async (path: string) => {
    const v = files.get(path);
    if (v === undefined) throw new Error("ENOENT: " + path);
    return v;
  },
  writeFile: async () => {},
  renameFile: async () => {},
  listDirectory: async () => [],
  deleteFile: async () => {},
}));

const mod = await import("../core/storage/attachment-files");

afterEach(() => {
  mod.clearExternalContentCache();
  files.clear();
  vi.restoreAllMocks();
});

describe("外置附件缓存 —— 必须有界", () => {
  it("ATT-1: 超过预算时逐出最久未使用的（且总字节不超预算）", async () => {
    const stats = mod.externalContentCacheStats();
    const budget = stats.budgetBytes;
    // 造 5 份"各占预算 40%"的内容 → 只能留住 2 份
    const each = Math.floor(budget * 0.4);
    const paths = ["p1", "p2", "p3", "p4", "p5"];
    for (const p of paths) files.set(p, "a".repeat(each));

    for (const p of paths) await mod.warmExternalContent(p);

    const after = mod.externalContentCacheStats();
    expect(after.bytes, "总字节不得超过预算").toBeLessThanOrEqual(budget);
    expect(after.evictions, "必须发生过逐出").toBeGreaterThan(0);
    // 最新的那份必须还在（LRU：刚用过的不能被逐出）
    expect(mod.getCachedExternalContent("p5"), "刚预热的必须还在").toBeDefined();
    // 最老的必须被逐出
    expect(mod.getCachedExternalContent("p1"), "最久未使用的应被逐出").toBeUndefined();
  });

  it("ATT-2: 命中会把该条移到'最新使用'（LRU 语义）", async () => {
    const budget = mod.externalContentCacheStats().budgetBytes;
    const each = Math.floor(budget * 0.4);
    for (const p of ["a", "b", "c"]) files.set(p, "x".repeat(each));

    await mod.warmExternalContent("a");
    await mod.warmExternalContent("b");
    // 重新访问 a → a 变成"最新使用"
    expect(mod.getCachedExternalContent("a")).toBeDefined();
    // 再塞 c → 应该逐出 b（而不是 a）
    await mod.warmExternalContent("c");

    expect(mod.getCachedExternalContent("a"), "刚访问过的 a 不该被逐出").toBeDefined();
    expect(mod.getCachedExternalContent("b"), "b 才是最久未使用的").toBeUndefined();
  });

  it("ATT-3: 逐出后重读会走「补一次预取」的既有路径（不返回错内容）", async () => {
    const budget = mod.externalContentCacheStats().budgetBytes;
    // 每份占预算 60% → 两份额必然触发逐出（两份 40% 是装得下的，这点要先算清楚）
    const each = Math.floor(budget * 0.6);
    files.set("old", "OLD".repeat(Math.floor(each / 3)));
    files.set("new", "NEW".repeat(Math.floor(each / 3)));

    await mod.warmExternalContent("old");
    await mod.warmExternalContent("new"); // old 被逐出
    expect(mod.getCachedExternalContent("old"), "old 应已被逐出").toBeUndefined();

    // 异步预热回来：拿到的是**它自己的**内容，不是别人的
    const back = await mod.warmExternalContent("old");
    expect(back?.startsWith("OLD")).toBe(true);
    expect(mod.getCachedExternalContent("old")?.startsWith("OLD")).toBe(true);
  });

  it("ATT-4: 覆盖同一路径不会重复计入字节（避免预算被虚耗）", async () => {
    const budget = mod.externalContentCacheStats().budgetBytes;
    const each = Math.floor(budget * 0.3);
    files.set("same", "1".repeat(each));
    await mod.warmExternalContent("same");
    const first = mod.externalContentCacheStats().bytes;

    mod.clearExternalContentCache();
    files.set("same", "1".repeat(each));
    await mod.warmExternalContent("same");
    await mod.warmExternalContent("same");
    const second = mod.externalContentCacheStats().bytes;

    expect(second, "重复预热同一条不该让占用翻倍").toBe(first);
  });
});
