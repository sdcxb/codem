/**
 * 25 号文 P2：**自动记忆整合（consolidation）**的判据（AC-1..AC-5）。
 *
 * ## 守什么
 *
 * 1. **默认关**：`codem-context-config.autoConsolidate` 缺省 false ⇒
 *    排期函数直接返回 false、连计时器都不建；推进 30 秒也**不动任何条目**、不产生 undo；
 * 2. **开启后只合并 auto**：空闲 30 秒到点才跑；只处理 `source=auto`、非 pending、未归档；
 *    manual / pending 逐字段不变；**不按时间归档**（自动路径显式 `removeStale:false`）；
 * 3. **可撤销**：真的产生变更时写**单份** undo（复用 `codem-memory-consolidation-undo`），
 *    `undoConsolidate` 把条目逐条恢复到整合前；
 * 4. **可关闭/可取消**：排期后关掉开关 ⇒ 到点什么都不做；关闭会话 ⇒ 撤掉排期；
 * 5. **排期不重置**：同一会话重复 schedule 返回 false（首次排期优先）。
 *
 * ## 变异自证（把实现改坏，判据必须红）
 *
 * - 默认值改成 true ⇒ AC-1 红（默认就会排期并合并）；
 * - 自动路径不传 `removeStale:false` ⇒ AC-2 的「旧 auto 条目不被归档」红；
 * - 到点不再查开关 ⇒ AC-3 红；
 * - 排期不幂等（每次 schedule 都新建计时器）⇒ AC-5 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import { getMemoryService, type MemoryEntry, type MemoryScope, type MemorySource } from "../core/memory/memory";
import { getContextManager, ContextManager } from "../core/context/context";
import { cancelAutoConsolidation, scheduleAutoConsolidation } from "../core/memory/auto-consolidation";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const IDLE_MS = 30_000;

/** 深快照（独立拷贝，避免拿实现自己的对象比实现） */
function snap(entry: MemoryEntry | undefined): MemoryEntry | undefined {
  return entry === undefined ? undefined : (JSON.parse(JSON.stringify(entry)) as MemoryEntry);
}

/** 造一条 auto 记忆（默认 platform 作用域） */
function addAuto(key: string, content: string, extra: { scope?: MemoryScope; source?: MemorySource; status?: "pending" } = {}) {
  return getMemoryService().add({
    scope: extra.scope ?? "platform",
    key,
    content,
    source: extra.source ?? "auto",
    ...(extra.status ? { status: extra.status } : {}),
  }).entry!;
}

/** CONS-2 同款夹具：两条中文近重复（2-gram 合并相似度 0.345） */
function addDuplicatePair(): [MemoryEntry, MemoryEntry] {
  const a = addAuto("Vitest 位置参数是路径子串匹配", "vitest 的位置参数按路径子串匹配；传多个参数时是 OR 关系。记号 ALPHA。");
  const b = addAuto("vitest 路径参数按子串匹配、多参数为 OR", "Vitest 位置参数匹配语义：路径子串匹配，多个参数之间是 OR。记号 BETA。");
  return [a, b];
}

function archivedCount(ids: string[]): number {
  return ids.filter((id) => getMemoryService().get(id)?.archived === true).length;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  saveMemory("");
  /* 默认配置（autoConsolidate=false）显式写一遍：判据不依赖上一个用例的残留 */
  getContextManager().updateConfig({ autoConsolidate: false, segmentEpochs: false });
  await getMemoryService().reload();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("AC-1：默认关 ⇒ 不排期、不动条目", () => {
  it("配置默认值必须是 false（变异：把 DEFAULT_CONFIG 改成 true ⇒ 本用例红）", () => {
    /* 换一个**没有任何 codem-context-config** 的干净端口，让 ContextManager 走默认值 */
    setStoragePort(createFakeStoragePort());
    expect(new ContextManager().getConfig().autoConsolidate, "25 §P2：自动整合默认必须关").toBe(false);
  });

  it("缺省 false：schedule 返回 false；推进 30 秒也不合并、不写 undo", async () => {
    const svc = getMemoryService();
    const [a, b] = addDuplicatePair();

    expect(scheduleAutoConsolidation("ac-default")).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(svc.get(a.id)?.archived, "默认关：一条都不许归档").toBeUndefined();
    expect(svc.get(b.id)?.archived, "默认关：一条都不许归档").toBeUndefined();
    expect(svc.getConsolidationUndo(NOW), "默认关：不该有 undo 记录").toBeNull();
  });
});

describe("AC-2：开启后 idle 到点只合并 auto；manual/pending 原样；可撤销", () => {
  it("只归档重复的 auto；manual/pending 逐字段不变；旧 auto 不按时间归档；undo 恢复", async () => {
    const svc = getMemoryService();
    getContextManager().updateConfig({ autoConsolidate: true });

    const manual = svc.add({ scope: "platform", key: "手写约定", content: "MANUAL_KEEP", source: "manual" }).entry!;
    const pending = svc.add({
      scope: "platform",
      key: "待批准",
      content: "PENDING_KEEP",
      source: "auto",
      status: "pending",
    }).entry!;
    const [autoA, autoB] = addDuplicatePair();
    /* 已经归档的 auto：不算候选（不能重复处理），自动整合必须原样放着。
       夹具刻意与其它条目**完全不同**：并发落地的「冲突合并」会在 add 时合并高相似条目，
       那会把这条归档件本身换掉（与本判据无关，但会让夹具失真）。 */
    const archivedAuto = addAuto("ZZZ 归档哨兵 9f3a", "ARCHIVED_KEEP_SENTINEL 量子色动力学胶子禁闭，与上下文无关。");
    svc.get(archivedAuto.id)!.archived = true;
    svc.get(archivedAuto.id)!.archivedAt = NOW - DAY;
    svc.get(archivedAuto.id)!.supersededBy = "mem-old";
    /* 很旧但唯一的 auto 条目：自动路径必须**不**按时间归档（removeStale:false） */
    const oldAuto = addAuto("很旧的自动记忆", "OLD_AUTO_KEEP 唯一内容");
    svc.get(oldAuto.id)!.timestamp = NOW - 200 * DAY;

    const beforeManual = snap(svc.get(manual.id));
    const beforePending = snap(svc.get(pending.id));
    const beforeOld = snap(svc.get(oldAuto.id));
    const pairBefore = [snap(svc.get(autoA.id))!, snap(svc.get(autoB.id))!];

    expect(scheduleAutoConsolidation("ac-on"), "开启后必须排期").toBe(true);
    /* 还没到点：什么都不会发生 */
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(archivedCount([autoA.id, autoB.id]), "29.999 秒时还没有批次跑过").toBe(0);
    expect(svc.getConsolidationUndo(NOW), "未到点不该有 undo 记录").toBeNull();

    await vi.advanceTimersByTimeAsync(1);

    /* ① manual / pending 逐字段不变（不是「还在」就算数） */
    expect(snap(svc.get(manual.id)), "manual 必须逐字段不变").toEqual(beforeManual);
    expect(snap(svc.get(pending.id)), "pending 必须逐字段不变").toEqual(beforePending);

    /* ② 近重复合并：一条归档、keeper 含两边事实 */
    expect(archivedCount([autoA.id, autoB.id]), "自动整合必须合并这一对近重复").toBe(1);
    const pair = [svc.get(autoA.id)!, svc.get(autoB.id)!];
    const keeper = pair.find((entry) => entry.archived !== true)!;
    expect(keeper.content, "keeper 必须含两条的独有事实").toContain("ALPHA");
    expect(keeper.content, "keeper 必须含两条的独有事实").toContain("BETA");

    /* ③ 旧 auto 条目**不**被按时间归档（自动路径 removeStale:false） */
    expect(snap(svc.get(oldAuto.id)), "自动整合不许按时间归档").toEqual(beforeOld);
    expect(svc.get(oldAuto.id)?.archived).toBeUndefined();

    /* ③b 已归档的 auto 条目**不参与合并**：归档标记/正文/原 supersededBy 都不变。
       （不逐字段比对 rev/updatedAt/conflictGroup：那属于并发的「冲突合并」功能，
       本判据只钉「自动整合没把它当候选」。） */
    expect(svc.get(archivedAuto.id)?.archived, "已归档条目仍归档").toBe(true);
    expect(svc.get(archivedAuto.id)?.content, "已归档条目正文不许被自动整合改写").toBe(
      "ARCHIVED_KEEP_SENTINEL 量子色动力学胶子禁闭，与上下文无关。",
    );
    expect(svc.get(archivedAuto.id)?.supersededBy, "已归档条目的 supersededBy 不许被改写").toBe("mem-old");

    /* ④ 生成单份 undo；撤销后逐条回到整合前 */
    const view = svc.getConsolidationUndo(NOW + 1000);
    expect(view, "有变更必须生成 undo").toBeTruthy();
    expect(view?.sessionId, "undo 记录要带归属会话").toBe("ac-on");
    const undone = svc.undoConsolidate(view!.token, { now: NOW + 2000 });
    expect(undone.ok, undone.message).toBe(true);
    /**
     * 撤销是**一次真实的本地写**（`undoConsolidate` 会 `touchEntry` 升 rev/updatedAt，
     * 否则另一端看到 rev 相同而内容不同会判冲突）——所以这里比对的是**事实字段**：
     * 正文 / 归档标记 / supersededBy 必须回到整合前；rev 与 updatedAt 允许前进。
     */
    for (const [index, id] of [autoA.id, autoB.id].entries()) {
      const now = snap(svc.get(id))!;
      const before = pairBefore[index];
      expect(now.content, `撤销后 ${id} 的正文必须回到整合前`).toBe(before.content);
      expect(now.key, `撤销后 ${id} 的 key 必须不变`).toBe(before.key);
      expect(now.archived, `撤销后 ${id} 必须取消归档`).toBeUndefined();
      expect(now.archivedAt, `撤销后 ${id} 不许留 archivedAt`).toBeUndefined();
      expect(now.supersededBy, `撤销后 ${id} 不许留 supersededBy`).toBeUndefined();
      expect(now.timestamp, `撤销不许改写入时间`).toBe(before.timestamp);
    }
    expect(snap(svc.get(manual.id)), "撤销不许动 manual").toEqual(beforeManual);
    expect(snap(svc.get(pending.id)), "撤销不许动 pending").toEqual(beforePending);
  });
});

describe("AC-3：排期后关掉开关 ⇒ 到点什么都不做", () => {
  it("disable 后推进 30 秒：不合并、不写 undo；再次 schedule 返回 false", async () => {
    const svc = getMemoryService();
    getContextManager().updateConfig({ autoConsolidate: true });
    const [a, b] = addDuplicatePair();

    expect(scheduleAutoConsolidation("ac-off")).toBe(true);
    getContextManager().updateConfig({ autoConsolidate: false });
    expect(scheduleAutoConsolidation("ac-off-2"), "关掉后不许再排期").toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(svc.get(a.id)?.archived).toBeUndefined();
    expect(svc.get(b.id)?.archived).toBeUndefined();
    expect(svc.getConsolidationUndo(NOW), "关闭后到点不许有 undo").toBeNull();
  });
});

describe("AC-4：可取消（关闭/删除会话时撤掉排期）", () => {
  it("cancel 返回 true 且到点不跑；再 cancel 返回 false", async () => {
    const svc = getMemoryService();
    getContextManager().updateConfig({ autoConsolidate: true });
    const [a, b] = addDuplicatePair();

    expect(scheduleAutoConsolidation("ac-cancel")).toBe(true);
    expect(cancelAutoConsolidation("ac-cancel"), "应当真的撤掉一个排期").toBe(true);
    expect(cancelAutoConsolidation("ac-cancel"), "没有排期时返回 false（不算失败）").toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(svc.get(a.id)?.archived).toBeUndefined();
    expect(svc.get(b.id)?.archived).toBeUndefined();
  });
});

describe("AC-5：同一会话的排期不重置（首次排期优先）", () => {
  it("第二次 schedule 返回 false；不同会话各自独立", () => {
    getContextManager().updateConfig({ autoConsolidate: true });
    expect(scheduleAutoConsolidation("ac-idem")).toBe(true);
    expect(scheduleAutoConsolidation("ac-idem"), "已有排期 ⇒ 不新建计时器").toBe(false);
    expect(scheduleAutoConsolidation("ac-idem-2"), "另一个会话可以独立排期").toBe(true);
    cancelAutoConsolidation("ac-idem");
    cancelAutoConsolidation("ac-idem-2");
  });
});

