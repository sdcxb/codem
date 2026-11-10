/**
 * 多设备同步：**宿主账本不丢未拉取事件**（任务 A）。
 *
 * ## 这组判据守什么
 *
 * 修前：账本固定 1200 条 / 1.5 MB，超界**丢最旧的**。快设备每拉一次就把慢设备还没拉的
 * 事件挤掉，而慢设备的游标还停在旧位置 ⇒ 它下一次 pull 只拿到「没有新事件」，
 * **静默缺一段**（用户看到的是会话少了一截，日志里只有一个没人看的 `dropped` 计数）。
 *
 * 修后：
 * 1. 修剪只删 `hostSeq ≤ min(所有已知设备游标)` 的前缀 —— 慢设备没拉的事件不会被快设备拉动修剪；
 * 2. 游标落后于已修剪范围（或超过宿主分配过的 hostSeq）⇒ `resetRequired: true` + `oldestSeq`，
 *    客户端必须走快照重建（任务 C），而不是把空增量当成功；
 * 3. 上限仍要有界（5 万条 / 8 MB）：先修剪「所有设备都拉过」的前缀；真压不住时按容量
 *    丢最旧，但**抬高 trimmedThrough 并计数**（`droppedUnpulled`），受影响设备会收到
 *    `resetRequired` —— 没有静默丢失；
 * 4. 没有设备游标（还没有客户端拉过）才按**入账时间**保留 7 天 / 最多 5 万条。
 *
 * ## 变异自证（本文件能抓到的改坏方式）
 *
 * - 修剪退回「按 1200 直接丢最旧的」⇒ LEDGER-1 红（慢设备拉不到第 2、3 条）；
 * - 重置判定只看 `trimmedThrough`、不看「游标超过宿主」⇒ LEDGER-2b 红；
 * - 容量丢弃不抬高 trimmedThrough ⇒ LEDGER-3 红（慢设备被静默丢事件）。
 */
import { describe, it, expect } from "vitest";
import {
  createHostSyncApi,
  normalizeHostSyncJournal,
  summarizeHostSyncJournal,
  type GatewaySyncApi,
  type HostSyncJournal,
  type HostSyncPorts,
} from "../core/remote/gateway-sync";

interface MemoryHost {
  api: GatewaySyncApi;
  ports: HostSyncPorts;
  /** 当前"磁盘上"的账本（null = 从空开始） */
  raw: () => unknown;
  setRaw: (value: unknown) => void;
}

function createMemoryHost(now = 1_700_000_000_000): MemoryHost {
  let raw: unknown = null;
  let clock = now;
  const ports: HostSyncPorts = {
    now: () => clock,
    loadJournal: () => raw,
    saveJournal: (journal) => {
      // 模拟落盘：深拷贝，防止内存别名掩盖"没保存"
      raw = JSON.parse(JSON.stringify(journal)) as unknown;
    },
    listSessionIds: () => [],
    readEvents: async () => [],
    appendEvent: () => 1,
    ensureSession: () => true,
    projectIdOfSession: () => "proj-a",
    readSessionMessages: async () => [],
    readMemoryPayload: async () => null,
    mergeMemory: async () => ({ ok: true, payload: "", entries: 0, conflicts: [], changed: false }),
  };
  const api = createHostSyncApi(ports);
  return {
    api,
    ports,
    raw: () => raw,
    setRaw: (value) => {
      raw = value;
    },
  };
}

let titleSeq = 0;

/** 推一条事件（走宿主数据面，hostSeq 由宿主分配）。 */
async function pushEvent(host: MemoryHost, deviceId: string, sessionId: string): Promise<void> {
  titleSeq += 1;
  const reply = await host.api.push({
    deviceId,
    events: [
      {
        eventId: `${deviceId}:${sessionId}:${titleSeq}`,
        deviceId,
        sessionId,
        type: "user_message",
        payload: { text: `第 ${titleSeq} 条` },
        timestamp: 1_700_000_000_000 + titleSeq,
      },
    ],
  });
  expect(reply.accepted).toBe(1);
}

/** 直接铺一份账本（用于构造容量/时间边界，不必真的推 5 万次）。 */
function seedJournal(host: MemoryHost, journal: Partial<HostSyncJournal> & { entries: unknown[] }): void {
  host.setRaw({
    version: 1,
    nextSeq: (journal.entries.length || 0) + 1,
    devices: {},
    deviceCursors: {},
    trimmedThrough: 0,
    pruned: 0,
    nativeCursor: {},
    scanIndex: 0,
    dropped: 0,
    droppedUnpulled: 0,
    updatedAt: 1_700_000_000_000,
    ...journal,
  });
}

function makeEntries(count: number, addedAt: number, sessionId = "sess-a"): unknown[] {
  const out: unknown[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({
      kind: "push",
      hostSeq: i,
      eventId: `seed:${sessionId}:${i}`,
      deviceId: "dev-seed",
      sessionId,
      type: "user_message",
      timestamp: addedAt,
      addedAt,
      digest: "",
      payload: { text: `seed-${i}` },
    });
  }
  return out;
}

describe("任务 A：账本只修剪「所有设备都拉过」的前缀", () => {
  it("LEDGER-1: 快设备拉完后，慢设备未拉的事件仍在（不被拉动修剪）", async () => {
    const host = createMemoryHost();
    await pushEvent(host, "dev-fast", "sess-a");
    await pushEvent(host, "dev-fast", "sess-a");
    await pushEvent(host, "dev-fast", "sess-a");

    // 慢设备先拉第 1 条
    const slowFirst = await host.api.pull({ deviceId: "dev-slow", sinceSeq: 0, limit: 1 });
    expect(slowFirst.events.map((e) => e.hostSeq)).toEqual([1]);
    expect(slowFirst.nextSeq).toBe(1);

    // 快设备从第 1 条之后拉 —— 修剪只能删 hostSeq ≤ min(3, 1) = 1 的前缀
    const fast = await host.api.pull({ deviceId: "dev-fast", sinceSeq: 1, limit: 10 });
    expect(fast.events.map((e) => e.hostSeq)).toEqual([2, 3]);
    expect(fast.resetRequired).toBe(false);
    const journal = normalizeHostSyncJournal(host.raw(), 1_700_000_000_000);
    expect(journal.trimmedThrough).toBe(1);
    expect(journal.entries.map((e) => e.hostSeq)).toEqual([2, 3]);
    expect(journal.dropped).toBe(0);

    // 慢设备继续拉：第 2、3 条必须还在，且不是 reset
    const slowRest = await host.api.pull({ deviceId: "dev-slow", sinceSeq: 1, limit: 10 });
    expect(slowRest.resetRequired).toBe(false);
    expect(slowRest.events.map((e) => e.hostSeq)).toEqual([2, 3]);
    expect(host.raw()).not.toBeNull();
  });

  it("LEDGER-1b: 所有设备都拉过之后，前缀可以正常修剪（账本不需要无限增长）", async () => {
    const host = createMemoryHost();
    await pushEvent(host, "dev-a", "sess-a");
    await pushEvent(host, "dev-a", "sess-a");

    await host.api.pull({ deviceId: "dev-a", sinceSeq: 0, limit: 10 });
    await host.api.pull({ deviceId: "dev-b", sinceSeq: 0, limit: 10 });
    expect(normalizeHostSyncJournal(host.raw(), 1_700_000_000_000).entries).toHaveLength(0);

    // 台账仍然能继续工作：新事件从 3 开始，两台设备都能拿到
    await pushEvent(host, "dev-a", "sess-a");
    const next = await host.api.pull({ deviceId: "dev-b", sinceSeq: 2, limit: 10 });
    expect(next.resetRequired).toBe(false);
    expect(next.events.map((e) => e.hostSeq)).toEqual([3]);
  });

  it("LEDGER-1c: 账本超过旧的 1200 条也不再按「条数」丢未拉取事件", async () => {
    const host = createMemoryHost();
    seedJournal(host, {
      entries: makeEntries(1300, 1_700_000_000_000),
      deviceCursors: { "dev-fast": 1300, "dev-slow": 1 },
    });
    // 快设备已经拉完 1300（游标 1300），慢设备只到 1
    const fast = await host.api.pull({ deviceId: "dev-fast", sinceSeq: 1300, limit: 10 });
    expect(fast.resetRequired).toBe(false);
    const journal = normalizeHostSyncJournal(host.raw(), 1_700_000_000_000);
    // 修剪只能删 hostSeq ≤ 1 的那一条
    expect(journal.entries.length).toBe(1299);
    expect(journal.entries[0].hostSeq).toBe(2);
    expect(journal.dropped).toBe(0);

    const slow = await host.api.pull({ deviceId: "dev-slow", sinceSeq: 1, limit: 500 });
    expect(slow.resetRequired).toBe(false);
    expect(slow.events[0]?.hostSeq).toBe(2);
    expect(slow.events).toHaveLength(500);
    expect(slow.hasMore).toBe(true);
  });
});

describe("任务 A：游标落后必须 resetRequired（不许静默空增量）", () => {
  it("LEDGER-2: 游标落在已修剪范围里 ⇒ resetRequired + oldestSeq，且不推进游标", async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 4; i += 1) await pushEvent(host, "dev-fast", "sess-a");
    // 快设备拉完 ⇒ 全部修剪
    const fast = await host.api.pull({ deviceId: "dev-fast", sinceSeq: 0, limit: 10 });
    expect(fast.events).toHaveLength(4);

    const slow = await host.api.pull({ deviceId: "dev-slow", sinceSeq: 2, limit: 10 });
    expect(slow.resetRequired).toBe(true);
    expect(slow.oldestSeq).toBe(5);
    expect(slow.events).toEqual([]);
    const journal = normalizeHostSyncJournal(host.raw(), 1_700_000_000_000);
    // 游标没有被"顺手"推进到 5（那会让客户端以为已经拉到，从而静默缺事件）
    expect(journal.deviceCursors["dev-slow"]).toBeUndefined();
  });

  it("LEDGER-2b: 游标超过宿主分配过的 hostSeq（账本被重建/清空）也 ⇒ resetRequired", async () => {
    const host = createMemoryHost();
    await pushEvent(host, "dev-a", "sess-a");
    const first = await host.api.pull({ deviceId: "dev-a", sinceSeq: 0, limit: 10 });
    expect(first.nextSeq).toBe(1);

    // 模拟「宿主账本丢了、从 1 重新开始」：客户端游标 1 已经超过 nextSeq-1
    host.setRaw({
      version: 1,
      nextSeq: 1,
      entries: [],
      devices: {},
      deviceCursors: {},
      trimmedThrough: 0,
      pruned: 0,
      nativeCursor: {},
      scanIndex: 0,
      dropped: 0,
      droppedUnpulled: 0,
      updatedAt: 1_700_000_000_000,
    });
    const stale = await host.api.pull({ deviceId: "dev-a", sinceSeq: 1, limit: 10 });
    expect(stale.resetRequired).toBe(true);
  });
});

describe("任务 A：上限仍然有界（按容量丢最旧，但必须可观测 + 逼出 reset）", () => {
  it("LEDGER-3: 有设备游标 + 超过条数上限 ⇒ 丢最旧、计 droppedUnpulled、抬高 trimmedThrough", async () => {
    const host = createMemoryHost();
    const entries = makeEntries(50_002, 1_700_000_000_000);
    seedJournal(host, { entries, deviceCursors: { "dev-slow": 1, "dev-fast": 1 } });

    const reply = await host.api.pull({ deviceId: "dev-fast", sinceSeq: 1, limit: 10 });
    // 本设备游标也落在丢弃范围里 ⇒ 本次就要求重建（不是等到下一轮）
    expect(reply.resetRequired).toBe(true);
    expect(reply.events).toEqual([]);
    const journal = normalizeHostSyncJournal(host.raw(), 1_700_000_000_000);
    // 条数上限 5 万，但 8 MB 字节上限可能先到 —— 两个上限都得有界
    expect(journal.entries.length).toBeLessThanOrEqual(50_000);
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(journal.dropped).toBeGreaterThan(0);
    expect(journal.droppedUnpulled).toBe(journal.dropped);
    expect(journal.trimmedThrough).toBe(journal.entries[0].hostSeq - 1);
    // 不清空已有游标（只丢条目；被丢到游标之后的设备会收到 resetRequired）
    expect(journal.deviceCursors["dev-slow"]).toBe(1);
    expect(journal.deviceCursors["dev-fast"]).toBe(1);
    const summary = summarizeHostSyncJournal(journal);
    expect(summary.droppedUnpulled).toBe(journal.dropped);
  });

  it("LEDGER-4: 没有设备游标时按入账时间保留 7 天（不是按事件时间）", async () => {
    const host = createMemoryHost();
    const old = 1_700_000_000_000 - 8 * 24 * 60 * 60 * 1000;
    // 两条很久以前入账的 + 一条刚入账的；事件时间故意都是"很久以前"（老历史）
    const entries = [
      ...makeEntries(2, old),
      {
        kind: "push",
        hostSeq: 3,
        eventId: "seed:new",
        deviceId: "dev-seed",
        sessionId: "sess-a",
        type: "user_message",
        timestamp: old,
        addedAt: 1_700_000_000_000,
        digest: "",
        payload: { text: "new" },
      },
    ];
    seedJournal(host, { entries });
    // 触发一次修剪：**push** 不产生设备游标（pull 会注册游标，那是另一条语义）
    await pushEvent(host, "dev-host", "sess-a");

    const journal = normalizeHostSyncJournal(host.raw(), 1_700_000_000_000);
    expect(journal.entries.map((e) => e.hostSeq)).toEqual([3, 4]);
    expect(journal.dropped).toBe(2);
    expect(journal.droppedUnpulled).toBe(2);
  });

  it("LEDGER-5: 没有游标时超过 5 万条 ⇒ 只保留有界窗口并计数", async () => {
    const host = createMemoryHost();
    seedJournal(host, { entries: makeEntries(50_003, 1_700_000_000_000) });
    // 同上：用 push 触发修剪，保证「没有设备游标」这个前提成立
    await pushEvent(host, "dev-host", "sess-a");

    const reply = await host.api.pull({ deviceId: "dev-x", sinceSeq: 0, limit: 1 });
    expect(reply.resetRequired).toBe(true);
    const journal = normalizeHostSyncJournal(host.raw(), 1_700_000_000_000);
    // 条数上限 5 万，但 8 MB 字节上限可能先到 —— 两个上限都得有界
    expect(journal.entries.length).toBeLessThanOrEqual(50_000);
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(journal.dropped).toBeGreaterThanOrEqual(4);
    expect(journal.droppedUnpulled).toBe(journal.dropped);
    expect(journal.trimmedThrough).toBe(journal.entries[0].hostSeq - 1);
  });
});
