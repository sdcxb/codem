/**
 * 记忆 payload 的**体积预算**、**order 补齐落库**与**迁移回滚**（第 191 波：O-36 / O-37 / O-47）。
 *
 * ## 这组判据针对的缺陷（修复前必须是红的）
 *
 * | 判据 | 缺陷 | 修复前为什么红 |
 * | --- | --- | --- |
 * | MEM-BYTES-1 | 记忆镜像**没有字节预算**：MB 级 payload 每回合重发而无人说 | 超限语料跑完 `getPersistFailures()` 里没有任何上报 |
 * | MEM-BYTES-1b | 体积上报没有节流/复位语义（要么刷屏、要么永远只报一次） | 无上报状态机可言 |
 * | MEM-BYTES-2 | 正常语料**不许**报（反向对照）+ 体积读数不许超过棘轮基线 | —— |
 * | MEM-BYTES-3 | 「messages 有预算」≠「memory 有预算」（防拿前者的绿当后者的绿） | 记忆预算与消息镜像预算必须是**两个**不同的常量 |
 * | MEM-ORDER-1 | `order` 补齐**不落库** ⇒ 顺序真相只存在于 JSON 键序里 | load 全过程 `memory.set` 调用数为 0 |
 * | MEM-ORDER-1b | 键序一变（另一个写者重排 JSON 键）⇒ 注入顺序就变 | 修复前顺序由键序推出来，重排后必然变 |
 * | MEM-ORDER-3 | order 落库失败必须**如实上报**（不许静默） | 修复前根本没有这次写入 |
 * | MIG-SNAP-2 | 快照确认失败时**内存态已被迁移** ⇒ 同一会话里看到的归属与重启后不同 | 内存里是迁移后的形态（磁盘是迁移前的） |
 *
 * 全部是**行为断言**（调产品 API → 断言结果 / 落库轨迹 / 上报轨迹），
 * 变异见 `tools/mutate/specs/memory-budget-191.mjs`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import {
  MemoryService,
  MEMORY_PAYLOAD_BUDGET_BYTES,
  MEMORY_MIGRATED_KEY,
  MEMORY_PRE_MIGRATION_KEY,
  injectionScopeContext,
  estimatePayloadBytes,
} from "../core/memory/memory";
import { loadMemory } from "../core/storage/settings";

// ========== 夹具 ==========

const PROJ = "c:\\work\\proj";

/** 造一份"旧格式"记忆原文：条目**没有** `order` 字段（旧版本写下的形态） */
function rawWithoutOrder(ids: string[], contentOf: (id: string) => string): string {
  const entries: Record<string, unknown> = {};
  for (const id of ids) {
    entries[id] = {
      id,
      scope: "platform",
      key: `key-${id}`,
      content: contentOf(id),
      timestamp: 1_600_000_000_000 + ids.indexOf(id),
      source: "manual",
      status: "active",
    };
  }
  return JSON.stringify({ version: 2, entries, batches: [] });
}

/** 把容器里的条目键序**反过来**（模拟"另一个写者"按自己的顺序重建 JSON —— 键序不是数据） */
function reverseEntryKeys(raw: string): string {
  const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
  const entries = parsed.entries ?? {};
  const reversed: Record<string, unknown> = {};
  for (const k of Object.keys(entries).reverse()) reversed[k] = entries[k];
  return JSON.stringify({ ...parsed, entries: reversed });
}

function mount(opts: Parameters<typeof createFakeStoragePort>[0] = {}): FakeStoragePort {
  const p = createFakeStoragePort(opts);
  setStoragePort(p);
  return p;
}

const memorySetWrites = (p: FakeStoragePort) => p.__writes().filter((w) => w.command === "memory.set");
const storedMemory = (p: FakeStoragePort) => String(p.__table("memory")[0]?.content ?? "");

/** 注入顺序（`injectionPlan` 的 Set 迭代序就是块内呈现序） */
function injectionOrder(svc: MemoryService): string[] {
  return [...svc.injectionPlan(injectionScopeContext(PROJ, "s1")).ids];
}

/**
 * **棘轮基线**（O-36：只许降不许升）。
 *
 * 语料 = 40 条 × 300 字符（外加一条批次）—— 这是"重度用户"的量级。测量方法见本文件
 * `MEM-BYTES-2` 的断言：`getByteStats().payloadBytes` 必须 ≤ 这个值。
 * 若将来文案/字段增加让这个数必须上调，**必须**在这里写明理由（棘轮的意义就在这）。
 */
const PAYLOAD_RATCHET_BYTES = 60_000;

/** 超预算语料：110 条 × 10 000 字符 ≈ 1.1M 字符 ⇒ 估算 2.2 MB > 预算 2 MiB */
function oversizedIds(n = 110): string[] {
  return Array.from({ length: n }, (_, i) => `big-${String(i).padStart(3, "0")}`);
}

beforeEach(() => {
  resetPersistFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
  resetPersistFailures();
});

// ===================== O-36：体积预算 =====================

describe("MEM-BYTES：记忆镜像必须有自己的字节预算（O-36）", () => {
  it("MEM-BYTES-1: 超预算语料 ⇒ 如实上报（超了多少 / 最大的一块 / 能做什么），且**条目一条不丢**", async () => {
    const ids = oversizedIds();
    const raw = rawWithoutOrder(ids, () => "甲".repeat(10_000));
    const port = mount({ seed: { memory: [{ id: "default", content: raw }] } });
    const svc = new MemoryService();

    // ① 体积可观测：读盘之后**立刻**就有一个真实的读数（不许是 0 —— 那是假陈述）
    const before = svc.getByteStats();
    expect(before.payloadBytes, "读盘后体积读数必须已经是真的").toBeGreaterThan(MEMORY_PAYLOAD_BUDGET_BYTES);
    expect(before.entries, "条目数如实").toBe(ids.length);
    expect(before.overBy, "超出量要算得出来").toBe(before.payloadBytes - MEMORY_PAYLOAD_BUDGET_BYTES);

    // ② 触发一次写入（一次普通 add）⇒ 超预算必须被**上报**
    const added = svc.add({ scope: "conversation", sessionId: "s1", key: "新条目", content: "刚记下的一条", source: "manual" });
    expect(added.ok, "超预算**不是**拒写的理由（不许因为体积大就丢用户的记忆）").toBe(true);
    await svc.flushPendingPersist();

    const report = getPersistFailures().find((f) => f.area === "memory.byteBudget");
    expect(report, "超预算必须走可见上报通道（不是只有一句 console）").toBeTruthy();
    expect(report!.lastMessage, "要说清超了多少").toMatch(/超过预算/);
    expect(report!.lastMessage, "要说清超出量").toMatch(/超出/);
    expect(report!.lastMessage, "要点名最大的那一块").toMatch(/最大的一块是/);

    // ③ 一条都不许丢、也不许截断：内存里的条目数与内容逐字完好
    //    （ctx 必须带 `sessionId` —— 刚加的那条是对话级，`listAll` 按归属过滤，这是另一条既有纪律）
    const ctx = { projectId: PROJ, sessionId: "s1", includeUnscoped: true, includePending: true };
    const stats = svc.getStats(ctx);
    expect(stats.totalEntries, "超预算**不许**静默截断或驱逐条目").toBe(ids.length + 1);
    const all = svc.listAllForPanel(ctx);
    for (const id of ids) {
      const entry = all.find((e) => e.id === id);
      expect(entry, `条目 ${id} 不许消失`).toBeTruthy();
      expect(entry!.content.length, `条目 ${id} 的内容不许被截断`).toBe(10_000);
    }

    // ④ 落库的那一份同样完整（"内存里没丢、库里丢了"也是丢）
    const stored = JSON.parse(storedMemory(port)) as { entries: Record<string, unknown> };
    expect(Object.keys(stored.entries).length, "落库的 payload 必须含全部条目").toBe(ids.length + 1);
  });

  it("MEM-BYTES-1b: 上报节流 —— 首次必报、小涨不报、大涨再报、回落复位后再报", async () => {
    const ids = oversizedIds();
    const raw = rawWithoutOrder(ids, () => "甲".repeat(10_000));
    mount({ seed: { memory: [{ id: "default", content: raw }] } });
    /*
     * `maxContentLength` 调大：本判据要造"体积涨过 25%"，而默认上限是 10 000 字符
     * （单条涨不动 25%）。预算本身**不**受配置影响（它是模块级常量，见 `MEMORY_PAYLOAD_BUDGET_BYTES`）。
     */
    const svc = new MemoryService({ maxContentLength: 1_000_000 });
    const budgetReports = () => getPersistFailures().filter((f) => f.area === "memory.byteBudget");

    // 第 1 次写入 ⇒ 首次超限，必须报
    svc.add({ scope: "conversation", sessionId: "s1", key: "a", content: "x", source: "manual" });
    await svc.flushPendingPersist();
    expect(budgetReports().length, "首次超限必须报").toBe(1);
    const firstCount = budgetReports()[0].count;

    // 第 2 次写入（体积几乎没变）⇒ 不许再报（否则每次改动一条都刷屏）
    svc.add({ scope: "conversation", sessionId: "s1", key: "b", content: "y", source: "manual" });
    await svc.flushPendingPersist();
    expect(budgetReports()[0].count, "涨幅远小于 25% ⇒ 不许重复上报").toBe(firstCount);

    // 第 3 次写入：把体积涨过 25% ⇒ 再报一次（"越用越大"必须可见）
    svc.add({ scope: "conversation", sessionId: "s1", key: "c", content: "乙".repeat(300_000), source: "manual" });
    await svc.flushPendingPersist();
    expect(budgetReports()[0].count, "涨幅超过 25% ⇒ 必须再报").toBeGreaterThan(firstCount);

    // 回落：删掉所有大条目 ⇒ 体积回到预算内 ⇒ 状态复位
    for (const id of ids) svc.delete(id);
    await svc.flushPendingPersist();
    expect(svc.getByteStats().overBy, "删掉大条目之后体积必须真的下来（否则下面的复位断言是假的）").toBe(0);
    const afterReset = budgetReports()[0]?.count ?? 0;

    // 再次超限 ⇒ 当作"首次"再报（复位之后状态机不许卡死）
    svc.add({ scope: "conversation", sessionId: "s1", key: "d", content: "丙".repeat(1_200_000), source: "manual" });
    await svc.flushPendingPersist();
    expect(svc.getByteStats().overBy, "夹具前提：这一次真的又超了").toBeGreaterThan(0);
    expect(budgetReports()[0].count, "回落后再超限必须重新上报").toBeGreaterThan(afterReset);
  });

  it("MEM-BYTES-2 反向对照: 正常语料**不许**报，且体积不得超过棘轮基线", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `norm-${i}`);
    const raw = JSON.stringify({
      version: 2,
      entries: Object.fromEntries(
        ids.map((id) => [
          id,
          { id, scope: "platform", key: `k-${id}`, content: "甲".repeat(300), timestamp: 1_700_000_000_000, source: "manual", status: "active" },
        ]),
      ),
      batches: [{ id: "batch-1", createdAt: 1_700_000_000_000, entryIds: [], undone: false }],
    });
    const port = mount({ seed: { memory: [{ id: "default", content: raw }] } });
    const svc = new MemoryService();
    svc.add({ scope: "conversation", sessionId: "s1", key: "n", content: "正常的一条", source: "manual" });
    svc.add({ scope: "conversation", sessionId: "s1", key: "n2", content: "正常的另一条", source: "manual" });
    await svc.flushPendingPersist();

    expect(
      getPersistFailures().filter((f) => f.area === "memory.byteBudget"),
      "正常语料**一条都不许报**（报了就是阈值/口径错了，用户会以为出了问题）",
    ).toEqual([]);

    // 棘轮：只许降不许升（上调必须在 PAYLOAD_RATCHET_BYTES 处写明理由）
    const stats = svc.getByteStats();
    expect(stats.payloadBytes, `正常语料体积 ${stats.payloadBytes} 超过棘轮 ${PAYLOAD_RATCHET_BYTES}`).toBeLessThanOrEqual(
      PAYLOAD_RATCHET_BYTES,
    );
    expect(stats.budgetBytes).toBe(MEMORY_PAYLOAD_BUDGET_BYTES);

    // 可观测的那一半：面板读到的数、镜像里的数、真实 payload 三处必须**同一个事实**
    expect(stats.payloadBytes).toBe(estimatePayloadBytes(storedMemory(port)));
    expect(port.configDomain.stats().memoryBytes, "镜像的 memoryBytes 必须就是落库那份字符串的长度").toBe(
      storedMemory(port).length,
    );
  });

  it("MEM-BYTES-3: 「messages 有预算」≠「memory 有预算」（防拿前者的绿当后者的绿）", async () => {
    /*
     * 这条判据要挡的形态很具体：第 137 波给**消息/事件镜像**加了字节预算（192 MiB / 256 MiB），
     * 于是"字节预算"这件事在本仓看起来已经有人管了 —— 而记忆域（单字符串、整份 IPC）
     * **一个上限都没有**。若有人把记忆的预算"复用"成镜像那个量级，这条判据要红。
     */
    const rustPort = readFileSync("src/core/storage/rust-port.ts", "utf8");
    const mirrorBudget = /const MIRROR_MESSAGE_BUDGET_BYTES\s*=\s*([\d_\s*+]+);/.exec(rustPort);
    expect(mirrorBudget, "消息镜像的预算常量必须还在（否则这条对账失去对照物）").toBeTruthy();
    const mirrorBytes = Number(
      mirrorBudget![1]
        .replace(/_/g, "")
        .split("*")
        .map((s) => Number(s.trim()))
        .reduce((a, b) => a * b, 1),
    );
    expect(mirrorBytes, "消息镜像预算是 MB 级的大数").toBeGreaterThan(10 * 1024 * 1024);
    expect(
      MEMORY_PAYLOAD_BUDGET_BYTES,
      "记忆预算必须是**它自己的**量级（比消息镜像小一个数量级以上）；直接复用镜像预算等于没预算",
    ).toBeLessThan(mirrorBytes / 10);

    // 行为那半：这份超限语料里**没有任何消息**（没有会话、没有消息行）——绿不可能来自消息镜像
    const ids = oversizedIds(110);
    const raw = rawWithoutOrder(ids, () => "甲".repeat(10_000));
    const port = mount({ seed: { memory: [{ id: "default", content: raw }] } });
    expect(port.__table("session_messages").length, "夹具前提：这份语料里一条消息都没有").toBe(0);
    const svc = new MemoryService();
    svc.add({ scope: "conversation", sessionId: "s1", key: "z", content: "1", source: "manual" });
    await svc.flushPendingPersist();
    expect(
      getPersistFailures().some((f) => f.area === "memory.byteBudget"),
      "消息镜像一条都没有时，记忆超预算照样必须报（证明这份绿不是从消息预算借来的）",
    ).toBe(true);
  });
});

// ===================== O-37：order 补齐落库 =====================

describe("MEM-ORDER：order 补齐必须在读盘时就落库（O-37）", () => {
  it("MEM-ORDER-1: 不经过任何 save()，读盘补齐的 order 也必须已经落库", async () => {
    const raw = rawWithoutOrder(["m-b", "m-a", "m-c"], (id) => `内容-${id}`);
    const port = mount({ seed: { memory: [{ id: "default", content: raw }] } });
    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "夹具前提：读盘成功").toBe(true);

    // ① 一次 save() 都没调，但 order 必须已经被写进库（否则顺序真相只在 JSON 键序里）
    await svc.flushPendingPersist();
    const writes = memorySetWrites(port);
    expect(writes.length, "读盘补齐了 order ⇒ 必须走确认通道落库一次（修复前这里是 0）").toBeGreaterThan(0);

    const stored = JSON.parse(storedMemory(port)) as { entries: Record<string, { order?: number }> };
    for (const id of ["m-a", "m-b", "m-c"]) {
      expect(typeof stored.entries[id]?.order, `条目 ${id} 的 order 必须落库（不是靠键序推）`).toBe("number");
    }
  });

  it("MEM-ORDER-1b: 另一个写者重排键序后重载 ⇒ 注入顺序逐条不变（修复前红）", async () => {
    const raw = rawWithoutOrder(["m-b", "m-a", "m-c"], (id) => `内容-${id}`);
    const port = mount({ seed: { memory: [{ id: "default", content: raw }] } });
    const first = new MemoryService();
    await first.flushPendingPersist();
    const orderBefore = injectionOrder(first);
    expect(orderBefore.length, "夹具前提：三条都进注入块").toBe(3);

    /*
     * 模拟"另一个写者"（旧版本 / 另一实现 / 任何按自己内部顺序重建 JSON 的代码）：
     * 它保留了全部数据，只把**键序**换了 —— 键序不是数据，任何写者都可能改。
     * 顺序若靠键序推出来（修复前），这里就会变；顺序若已落库（修复后），这里必须不变。
     */
    port.__table("memory")[0].content = reverseEntryKeys(storedMemory(port));

    const second = new MemoryService();
    expect(injectionOrder(second), "键序变了不许改变注入顺序（创建序必须来自落库的 order）").toEqual(orderBefore);
  });

  it("MEM-ORDER-3: order 落库失败必须如实上报，且内存里的顺序仍然可用", async () => {
    const raw = rawWithoutOrder(["m-b", "m-a", "m-c"], (id) => `内容-${id}`);
    mount({ failCommands: ["memory.set"], seed: { memory: [{ id: "default", content: raw }] } });
    const svc = new MemoryService();
    await svc.flushPendingPersist();

    expect(
      getPersistFailures().map((f) => f.area),
      "order 落库失败必须走自己的上报区域（不许混进'你刚保存的记忆失败了'）",
    ).toContain("memory.orderBackfill");
    expect(svc.getLastPersistError(), "失败必须回传到调用方").toBeTruthy();
    expect(injectionOrder(svc).length, "落库失败不影响本次运行内的顺序（内存里已补齐）").toBe(3);
  });
});

// ===================== O-47：迁移被拒 ⇒ 内存态回滚 =====================

/** 旧版本写下的 project 池（没有 projectId）+ 旧 global —— 这份数据会触发作用域迁移 */
const LEGACY_PROJECT_JSON = JSON.stringify({
  version: 1,
  entries: {
    "legacy-1": { id: "legacy-1", scope: "project", key: "老项目池约定", content: "LEGACY_POOL_FACT", timestamp: 1_600_000_000_000 },
    "legacy-2": { id: "legacy-2", scope: "global", key: "老全局", content: "LEGACY_GLOBAL_FACT", timestamp: 1_600_000_000_001 },
  },
});

describe("MIG-SNAP-2：快照被拒 ⇒ 磁盘与内存**都是**迁移前形态（O-47）", () => {
  it("MIG-SNAP-2: 快照写不进 ⇒ 内存态回滚到迁移前（与磁盘一致），并如实说明", async () => {
    const port = mount({
      failCommands: ["crud.upsert"], // 快照（settings 写）失败、记忆写照常成功 —— 最危险的组合
      seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] },
    });
    const svc = new MemoryService();
    const report = svc.getMigrationReport()!;
    expect(report.ran, "迁移规则跑了（报告要能看到它试过）").toBe(true);
    await svc.flushPendingPersist();

    // ① 磁盘没动（既有 MIG-SNAP-1/F4 已钉）——这里同时确认快照与数据都没写
    expect(port.__table("settings").some((r) => String(r.key) === MEMORY_PRE_MIGRATION_KEY)).toBe(false);
    expect(port.__table("settings").some((r) => String(r.key) === MEMORY_MIGRATED_KEY)).toBe(false);
    expect(storedMemory(port), "库里那份旧数据逐字不变").toBe(LEGACY_PROJECT_JSON);

    // ② 报告如实说明"本次迁移未生效"
    expect(report.aborted, "报告必须能回答'本次迁移到底生效了没有'").toBeTruthy();
    expect(report.aborted).toMatch(/快照/);
    expect(report.abortedEntries, "要如实说回滚了几条").toBe(2);
    expect(svc.getLastPersistError(), "失败必须回传到调用方").toMatch(/快照/);

    // ③ **内存态也回到迁移前**（修复前这里已经是迁移后的形态 ⇒ 与磁盘分叉）
    const inMemory = svc.listAll({ includeUnscoped: true, includePending: true });
    const byId = new Map(inMemory.map((e) => [e.id, e]));
    expect(byId.get("legacy-1")!.scope, "回滚后旧 project 池仍是 project（不是 platform）").toBe("project");
    expect(byId.get("legacy-2")!.scope, "回滚后旧 global 仍是 global（不是 platform）").toBe("global");
    expect(byId.get("legacy-1")!.legacyPool, "回滚必须连迁移打的标记一起撤掉").toBeUndefined();
    expect(report.visibleAfter, "报告的'迁移后可见范围'也必须按回滚后的真实形态给").toEqual(report.visibleBefore);
    expect(loadMemory(), "镜像也要跟着回滚（同一 tick 之后的读路径不许看到迁移后形态）").not.toContain("platform");
  });

  it("MIG-SNAP-2b 反向对照: 快照确认成功 ⇒ 内存与磁盘都是迁移后形态（证明上一条不是恒真）", async () => {
    const port = mount({ seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] } });
    const svc = new MemoryService();
    const report = svc.getMigrationReport()!;
    await svc.flushPendingPersist();

    expect(report.aborted, "成功路径不许有 aborted").toBeUndefined();
    expect(report.snapshotWritten, "快照确认落库").toBe(true);
    const byId = new Map(svc.listAll({ includeUnscoped: true, includePending: true }).map((e) => [e.id, e]));
    expect(byId.get("legacy-1")!.scope, "成功路径必须真的迁移（否则上一条'回滚'无从对照）").toBe("platform");
    expect(byId.get("legacy-2")!.scope).toBe("platform");
    expect(storedMemory(port), "磁盘上也必须是迁移后的形态").toContain("platform");
  });
});
