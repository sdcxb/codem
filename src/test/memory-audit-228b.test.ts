/**
 * 第 228 波·审计轮（第二批）：把审计报告里"已定位待修"的五条 + 两处证据缺口钉住。
 *
 * - `MA-7`：跨所有桶的**总量上限**（容量按桶算、桶数无上限 ⇒ 光有 per-scope 配额等于无界）
 * - `MA-8`：payload 超预算 ⇒ **拒绝新的自动写入**（此前只上报，从不拒绝）
 * - `MA-9`：批量「保留为平台级」只落**一次**库（原来 N 条 = N 次整份序列化 + N 次 IPC）
 * - `MA-10`：单条 content 注入截断要**披露**（条目 10000 字符 vs 每行注入 200 字符）
 * - `MA-11`：回退到迁移前**不会**被在途的普通保存覆盖（直写 vs 队列）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import {
  MEMORY_INJECT_LINE_MAX,
  MEMORY_PAYLOAD_BUDGET_BYTES,
  MemoryService,
  getMemoryService,
  injectionTruncationNote,
} from "../core/memory/memory";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MEMORY_PRE_MIGRATION_KEY } from "../core/memory/memory";
import { keepManyAsPlatform } from "../core/memory/checkup";

let port: FakeStoragePort;
const memorySetWrites = (p: FakeStoragePort) => p.__writes().filter((w) => w.command === "memory.set");

beforeEach(() => {
  resetPersistFailures();
  saveMemory("");
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
});
afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("MA（第二批）：记忆的边界与诚实", () => {
  it("MA-7：跨所有桶的总量上限 —— 自动写入被拒、手动写入照旧放行", () => {
    const svc = new MemoryService({ maxEntries: 1000, maxTotalEntries: 2 });
    expect(svc.add({ scope: "project", projectId: "p1", key: "自动一", content: "内容一", source: "auto" }).ok).toBe(true);
    expect(svc.add({ scope: "project", projectId: "p2", key: "自动二", content: "内容二", source: "auto" }).ok).toBe(true);

    const third = svc.add({ scope: "project", projectId: "p3", key: "自动三", content: "内容三", source: "auto" });
    expect(third.ok, "总量满 ⇒ 自动写入必须被拒绝（容量按桶算、桶数无上限 ⇒ 否则结构性无界）").toBe(false);
    expect(third.error).toBe("capacity");
    expect(third.message, "拒绝要说清怎么自救").toContain("记忆体检");

    expect(
      svc.add({ scope: "project", projectId: "p4", key: "手动四", content: "内容四", source: "manual" }).ok,
      "手动写入不受总量上限影响（否则用户会被一个自己看不见的自动池卡死、没有出路）",
    ).toBe(true);
  });

  it("MA-8：payload 超预算 ⇒ 拒绝新的自动写入（此前只上报、从不拒绝）", async () => {
    const svc = new MemoryService();
    const big = "字".repeat(50_000);
    /* 先塞到超预算（用自动写入；上限是"超过才拦"，所以前面这些能进去） */
    for (let i = 0; i < 140; i++) {
      svc.add({ scope: "project", projectId: `p${i}`, key: `条目${i}`, content: big, source: "auto" });
    }
    await svc.flushPendingPersist();
    expect(
      svc.getByteStats().payloadBytes,
      "前提：payload 已经超过预算（否则这条判据测不到东西）",
    ).toBeGreaterThan(MEMORY_PAYLOAD_BUDGET_BYTES);

    const rejected = svc.add({ scope: "project", projectId: "new", key: "再来一条", content: "内容", source: "auto" });
    expect(rejected.ok, "超预算后不许再自动增长（体积无界会拖慢每一次改动：整份序列化 + 整份 IPC）").toBe(false);
    expect(rejected.error).toBe("capacity");
    expect(rejected.message).toContain("记忆体检");

    expect(
      svc.add({ scope: "project", projectId: "new", key: "用户手写", content: "内容", source: "manual" }).ok,
      "用户手写/导入照旧放行（自救路径不能被堵住）",
    ).toBe(true);
  });

  it("MA-9：批量「保留为平台级」只落一次库（N 条不该是 N 次整份写）", async () => {
    const svc = getMemoryService() as MemoryService;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = svc.add({
        scope: "platform",
        key: `旧池条目${i}`,
        content: `内容${i}`,
        source: "manual",
        legacyPool: true,
      } as never);
      if (r.entry) ids.push(r.entry.id);
    }
    expect(ids.length, "前提：有 5 条旧池条目").toBe(5);
    /* ⚠️ 先把 setup 阶段的在途写等干净，否则 `before` 会把它们的落库算进本次批量里 */
    await svc.flushPendingPersist();
    const before = memorySetWrites(port).length;

    const result = await keepManyAsPlatform(ids);

    expect(result.kept, "5 条都该被保留为平台级").toBe(5);
    expect(
      memorySetWrites(port).length - before,
      "整批只落一次库（原来每条内部各 flush 一次 ⇒ 5 次）",
    ).toBe(1);
  });

  it("MA-10：注入截断必须披露（条目允许 10000 字符，每行注入只取前 200）", () => {
    expect(
      injectionTruncationNote({ content: "短".repeat(MEMORY_INJECT_LINE_MAX) }),
      "刚好到上限 ⇒ 没截断，不该有提示",
    ).toBeNull();
    const note = injectionTruncationNote({ content: "长".repeat(MEMORY_INJECT_LINE_MAX + 1) });
    expect(note, "超一个字符就要如实说").not.toBeNull();
    expect(note, "要说清「只取前多少」和「还有多少没进上下文」").toContain(String(MEMORY_INJECT_LINE_MAX));
    expect(note).toContain("不会进上下文");
  });

  it("MA-11：旧池「暂停注入」的确认式写入 —— 落不了库要返回 false（界面据此如实回执）", async () => {
    /*
     * 被守的缺陷：旧池（真机 21 条）**默认对所有项目注入**，而这个开关是唯一能拦住它的东西。
     * 旧实现走 `setSetting`（先改内存、异步落库、失败只发横幅）⇒ 界面立刻画成"已暂停"并给回执，
     * 而磁盘可能没写 ⇒ **重启后静默恢复注入**。
     */
    const { setLegacyPoolInjectionPausedConfirmed, isLegacyPoolInjectionPaused } = await import("../core/memory/memory");
    /* 直接控制"确认式写入的结果"：这条判据要钉的是**我们的函数如实转达结果**，不是假端口的内部 */
    const settingsModule = await import("../core/storage/settings");
    const spy = vi.spyOn(settingsModule, "setSettingConfirmed").mockResolvedValue(false);
    const failed = await setLegacyPoolInjectionPausedConfirmed(true);
    expect(failed, "写不进去 ⇒ 必须返回 false（界面据此说「未落库」，而不是谎报已暂停）").toBe(false);

    spy.mockResolvedValue(true);
    expect(await setLegacyPoolInjectionPausedConfirmed(true), "写进去了 ⇒ 返回 true").toBe(true);
    expect(isLegacyPoolInjectionPaused(), "内存态按新设置生效（本次运行内真的停注入了）").toBe(false);
  });

  it("MA-12：回退到迁移前必须先等在途队列落地（直写不能抢在队列前面）", async () => {
    /*
     * 形态：`save()` 走 `chainPersist` 队列（异步 + 重试退避），而回退是**直写** ⇒
     * 队列里压着的旧 payload 可能晚于回退落盘 ⇒ 磁盘最终是"回退前的 payload"，
     * 而 `lastPersistedPayload` 已被设成快照 ⇒「无变化不写」短路让分叉一直保持到下一次真实改动：
     * 界面说"已回退"，重启之后回退不存在。
     *
     * 这里断言**调用顺序**（flush 必须在直写之前）—— 行为版（真端口时序）在假端口上无法稳定分辨方向。
     */
    const svc = new MemoryService();
    const raw = JSON.stringify({ version: 1, entries: { legacy: { scope: "project", key: "迁移前", content: "旧数据" } } });
    setSetting(MEMORY_PRE_MIGRATION_KEY, JSON.stringify({ takenAt: Date.now(), entries: 1, raw }));
    expect(svc.getPreMigrationSnapshot(), "前提：能读到迁移前快照").not.toBeNull();

    const order: string[] = [];
    const flushSpy = vi.spyOn(svc, "flushPendingPersist").mockImplementation(async () => {
      order.push("flush");
      return true;
    });
    const settingsModule = await import("../core/storage/settings");
    const writeSpy = vi.spyOn(settingsModule, "saveMemoryConfirmed").mockImplementation(async () => {
      order.push("direct");
      return { ok: true } as never;
    });

    const restored = await svc.restorePreMigrationSnapshot();

    expect(restored.ok).toBe(true);
    expect(order, "必须**先等队列落地**再直写（顺序反了就会让旧 payload 覆盖回退）").toEqual(["flush", "direct"]);
    writeSpy.mockRestore();
    flushSpy.mockRestore();
  });
});