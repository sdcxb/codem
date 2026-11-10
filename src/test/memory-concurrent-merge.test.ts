/**
 * 24 号文 P2-A：**多客户端并发写冲突**（读-改-写 + 版本合并）。
 *
 * ## 被守的缺陷
 *
 * 记忆的权威是 settings 里**一整份 JSON**：两个客户端（两个窗口 / 两个进程 / 手机桥 + 桌面）
 * 各自读一份、改一条、把**整份**写回去 —— 后写的那个把先写的改动整条覆盖掉，
 * 而双方都返回"保存成功"。这不是偶发竞态，是整份读写的结构性后果。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | MEM-SYNC-1 | 两个实例交替写：**一条都不丢**（并集保住），rev 只增不减 |
 * | MEM-SYNC-2 | 同 id 并发改：**双方内容都在**（一条保留原 id，另一条 `conflictOf` 副本），且 `memory-conflicts` 审计可见 |
 * | MEM-SYNC-3 | 删除不被旧写复活（另一实例手里的旧 payload 写回来也不复活） |
 * | MEM-SYNC-4 | 旧数据兼容：没有 `rev` 的 payload 读进来 rev=0，第一次改动升到 1 且**不产生冲突** |
 * | MEM-SYNC-5 | 墓碑有界（≤ `MEMORY_TOMBSTONE_MAX`） |
 * | MEM-SYNC-6 | **反向对照**：整份直接覆盖（改前的形态）会真的丢条目 —— 证明上面几条不是恒真 |
 *
 * ## 变异自证
 *
 * - 把 `mergeBeforeWrite` 的返回值改成 `intent`（等于不合并）⇒ MEM-SYNC-1/3 红；
 * - 把冲突分支改成"远端胜"或"本地胜"（不留副本）⇒ MEM-SYNC-2 红；
 * - 把墓碑写进 `entries` 又在合并里忽略 ⇒ MEM-SYNC-3 红。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getSetting, patchMemoryMirror } from "../core/storage/settings";
import {
  MemoryService,
  __resetMemoryPerfStats,
  MEMORY_CONFLICTS_KEY,
  MEMORY_DEVICE_ID_KEY,
  type MemoryEntry,
} from "../core/memory/memory";
import { MEMORY_TOMBSTONE_MAX } from "../core/memory/merge";

const CTX = { projectId: "c:\\work\\sync", sessionId: "s-sync" };

let port: FakeStoragePort;

beforeEach(() => {
  __resetMemoryPerfStats();
  port = createFakeStoragePort();
  setStoragePort(port);
});
afterEach(() => setStoragePort(null));

/** 全部条目（含副本/归档/待批准；用于"一条都不丢"这类集合断言） */
function allEntries(svc: MemoryService): MemoryEntry[] {
  return svc.listAll({ projectId: CTX.projectId, sessionId: CTX.sessionId });
}

const keysOf = (svc: MemoryService): string[] => allEntries(svc).map((e) => e.key).sort();

function addPlatform(svc: MemoryService, key: string, content: string) {
  const result = svc.add({ scope: "platform", key, content, source: "manual" });
  expect(result.ok, `add(${key}) 必须成功：${result.message ?? ""}`).toBe(true);
  return result.entry!;
}

describe("MEM-SYNC：多客户端并发写（读-改-写 + 版本合并）", () => {
  it("MEM-SYNC-1：两个实例交替写 ⇒ 并集保住，rev 只增不减", async () => {
    const a = new MemoryService();
    const b = new MemoryService();

    addPlatform(a, "A1", "甲的约定");
    await a.flushPendingPersist();
    addPlatform(b, "B1", "乙的约定");
    await b.flushPendingPersist();
    addPlatform(a, "A2", "甲的第二个约定");
    await a.flushPendingPersist();

    // 第三个实例是"从磁盘重新读"的中立观察者（不是任何一方的内存态）
    const c = new MemoryService();
    expect(keysOf(c), "三写之后三条都必须在（后写的不许整份覆盖先写的）").toEqual(["A1", "A2", "B1"]);

    // rev 单调：每条都是正整数；同一条改两次之后 rev 必须严格变大
    for (const entry of allEntries(c)) {
      expect(Number.isInteger(entry.rev), `rev 必须是整数：${JSON.stringify(entry)}`).toBe(true);
      expect(entry.rev!).toBeGreaterThanOrEqual(1);
    }
    const target = allEntries(c).find((e) => e.key === "A1")!;
    const revBefore = target.rev!;
    a.update(target.id, { content: "甲的约定（改）" }, { actor: "user" });
    await a.flushPendingPersist();
    const c2 = new MemoryService();
    expect(c2.get(target.id)!.rev!, "改一次 ⇒ rev 严格变大（不是原地不动）").toBeGreaterThan(revBefore);

    // 基线可见性：每次写入都会给本机一个稳定 id（同一台设备只有一个身份）
    expect(a.getMergeStats().deviceId).toBe(b.getMergeStats().deviceId);
    expect(getSetting(MEMORY_DEVICE_ID_KEY), "客户端 id 必须落库（跨重启稳定）").toBe(a.getMergeStats().deviceId);
  });

  it("MEM-SYNC-2：同 id 并发改 ⇒ 双方内容都在 + 冲突审计可见", async () => {
    const a = new MemoryService();
    const shared = addPlatform(a, "共享事实", "初始内容");
    await a.flushPendingPersist();

    // b 读过同一份（rev=1），随后两边各改一版 —— 这是"同 id 并发改"的最小形态
    const b = new MemoryService();
    expect(b.get(shared.id)!.rev).toBe(1);

    a.update(shared.id, { content: "A 的改动" }, { actor: "user" });
    await a.flushPendingPersist();
    b.update(shared.id, { content: "B 的改动" }, { actor: "user" });
    await b.flushPendingPersist();

    const c = new MemoryService();
    const contents = allEntries(c).map((e) => e.content);
    expect(contents, "A 的内容必须在（不许被静默覆盖）").toContain("A 的改动");
    expect(contents, "B 的内容也必须在（冲突 ⇒ 双方都留）").toContain("B 的改动");

    const copy = allEntries(c).find((e) => e.conflictOf === shared.id);
    expect(copy, "输掉的那一方必须变成 `conflictOf` 副本（不是被删掉）").toBeTruthy();
    expect(copy!.content === "A 的改动" || copy!.content === "B 的改动").toBe(true);
    expect(copy!.conflictGroup, "副本要带冲突组标签，面板才能把成对的条目归在一起").toBeTruthy();

    // 审计：`memory-conflicts` 里有这条冲突（id / 时间 / 双方摘要）
    const audit = c.getConflictAudit();
    expect(audit.length, "冲突必须写进审计键（否则「发生过覆盖」就只剩内存里一句话）").toBeGreaterThan(0);
    expect(audit[0].id).toBe(shared.id);
    expect(audit[0].localSummary.length).toBeGreaterThan(0);
    expect(audit[0].remoteSummary.length).toBeGreaterThan(0);
    const persisted = JSON.parse(getSetting(MEMORY_CONFLICTS_KEY) ?? "null") as { records?: unknown[] } | null;
    expect(Array.isArray(persisted?.records), "审计必须落库（重启后还要能核对）").toBe(true);

    // 双方的副本都会收敛到同一个 id（确定性副本 id ⇒ 不会每同步一次多一条）
    const d = new MemoryService();
    expect(allEntries(d).length, "再次重读不许再添一条副本（确定性 id 保证收敛）").toBe(allEntries(c).length);
  });

  it("MEM-SYNC-3：删除不被旧写复活（墓碑生效）", async () => {
    const a = new MemoryService();
    const doomed = addPlatform(a, "要删掉的", "内容");
    const kept = addPlatform(a, "保留的", "内容");
    await a.flushPendingPersist();

    // b 在删除**之前**读到这一份 —— 它手里的 payload 里 doomed 还在
    const b = new MemoryService();
    expect(b.get(doomed.id), "前提：b 的旧视图里确实有这条").toBeTruthy();

    expect(a.delete(doomed.id), "删除本身必须成功").toBe(true);
    await a.flushPendingPersist();

    // b 做一次**无关**的改动并把它的整份 payload 写回去（旧写）
    b.update(kept.id, { content: "乙改了保留的那条" }, { actor: "user" });
    await b.flushPendingPersist();

    const c = new MemoryService();
    expect(c.get(doomed.id), "已删除的条目必须**不被旧写复活**").toBeUndefined();
    expect(allEntries(c).map((e) => e.key), "别的条目不受影响").toEqual(["保留的"]);
    expect(c.get(kept.id)!.content).toBe("乙改了保留的那条");
    expect(c.getMergeStats().tombstones, "墓碑必须还在（本次进程内可见）").toBeGreaterThanOrEqual(1);
  });

  it("MEM-SYNC-4：旧数据没有 rev ⇒ 读到 0，第一次改动升到 1 且不产生冲突", async () => {
    // 旧 payload 的形状：没有 rev / updatedAt / deviceId（真实存量用户的形态）
    const legacyPayload = JSON.stringify({
      version: 2,
      entries: {
        old1: {
          scope: "platform",
          key: "旧条目",
          content: "旧正文",
          source: "manual",
          status: "active",
          timestamp: 1_700_000_000_000,
          order: 0,
        },
      },
      batches: [],
    });
    port = createFakeStoragePort({ seed: { memory: [{ id: "default", content: legacyPayload }] } });
    setStoragePort(port);

    const svc = new MemoryService();
    const old = svc.get("old1")!;
    expect(old.rev, "旧数据缺省 rev = 0").toBe(0);
    expect(old.updatedAt, "旧数据 updatedAt 缺省 = timestamp").toBe(1_700_000_000_000);
    expect(old.deviceId, "旧数据没有来源标记").toBeUndefined();

    expect(svc.update("old1", { content: "第一次改动" }, { actor: "user" })).toBe(true);
    await svc.flushPendingPersist();
    const after = new MemoryService();
    expect(after.get("old1")!.rev, "第一次改动 ⇒ rev 1").toBe(1);
    expect(after.get("old1")!.content).toBe("第一次改动");
    expect(after.getConflictAudit().length, "旧数据兼容不许被当成冲突").toBe(0);
  });

  it("MEM-SYNC-5：墓碑有界（超出上限丢最旧的）", async () => {
    const svc = new MemoryService();
    const created = Array.from({ length: MEMORY_TOMBSTONE_MAX + 5 }, (_, i) =>
      addPlatform(svc, `待删-${i}`, `内容-${i}`),
    );
    await svc.flushPendingPersist();
    for (const entry of created) svc.delete(entry.id);
    await svc.flushPendingPersist();

    expect(svc.getMergeStats().tombstones, "墓碑数必须 ≤ 上限").toBeLessThanOrEqual(MEMORY_TOMBSTONE_MAX);
    const stored = (await port.data.command("memory.get", {})) as { content?: string };
    const payload = JSON.parse(stored.content ?? "{}") as { tombstones?: unknown[] };
    expect(Array.isArray(payload.tombstones)).toBe(true);
    expect(payload.tombstones!.length).toBeLessThanOrEqual(MEMORY_TOMBSTONE_MAX);
    // 存活条目一条不剩（删干净了），而墓碑保住了最近的 200 条删除凭据
    expect(allEntries(svc).length).toBe(0);
    expect(payload.tombstones!.length).toBe(MEMORY_TOMBSTONE_MAX);
  });

  it("MEM-SYNC-6（反向对照）：整份直接覆盖会真的丢条目 —— 合并不是恒真", async () => {
    const a = new MemoryService();
    const b = new MemoryService();
    addPlatform(a, "只属于甲", "甲写的");
    await a.flushPendingPersist();

    /*
     * 模拟**改前**的写形态：b 把自己那份（不含甲的条目）整份写回去。
     * 这一条是反向对照 —— 它必须真的丢数据，否则上面几条判据只是"恒真"。
     */
    const stalePayload = JSON.stringify({
      version: 2,
      entries: {
        "b-only": { scope: "platform", key: "只属于乙", content: "乙写的", source: "manual", status: "active", timestamp: 1, order: 0 },
      },
      batches: [],
    });
    await port.data.execute("memory.set", { content: stalePayload });
    // 内存镜像也同步成这份（改前的实现就是"patchMemoryMirror + 整份写穿"）
    patchMemoryMirror(stalePayload);

    const c = new MemoryService();
    expect(c.getLoadState().ok).toBe(true);
    expect(keysOf(c), "直接整份覆盖 ⇒ 甲那条被抹掉（这正是合并要治的形态）").toEqual(["只属于乙"]);
  });
});
