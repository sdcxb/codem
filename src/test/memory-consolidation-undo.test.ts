/**
 * 24 号文 P1-3：**可撤销 consolidation** 的判据（CONS-1 / CONS-2 + 撤销幂等/过期）。
 *
 * ## 守什么
 *
 * 1. `CONS-1`：用户显式整合只动 `source=auto` 且非 pending 的条目；manual / pending
 *    逐字段不变；被合并/过期/超额的条目**只归档不删除**；整合后可用 undoToken
 *    **逐条恢复**到整合前快照（id 不变，条目集合与原文逐条相同）；
 * 2. `CONS-2`：中文近重复用 `similarity.ts` 的 **2-gram** 尺合并（不是空格切词 + 字符集
 *    Jaccard）；合并后同一事实仍可被 `memory_search` 检索到；
 * 3. 撤销的**单次有效**（第二次返回 none 且不再改动）与**过期拒绝**（状态一个字不动）；
 *    令牌不符拒绝且记录保留（拿对令牌仍可撤销）。
 *
 * ## 变异自证（把实现改坏，判据必须红）
 *
 * - 让 manual / pending 参与去重或归档 ⇒ CONS-1 红；
 * - 恢复旧的 `calculateSimilarity`（空格切词 + 字符集 Jaccard）⇒ 本文件的近重复夹具
 *   合并相似度只有 **0.253**（< 0.3）⇒ 合并不再发生 ⇒ CONS-2 红；
 * - 不存 before/after 快照（或 undo 只清归档不恢复正文）⇒ 撤销后逐条比对红；
 * - 撤销不校验过期/令牌 ⇒ 过期/令牌用例红。
 *
 * ⚠️ 键名一律加引号（带中文/括号的裸键会让 esbuild 直接报错）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSettingJSON } from "../core/storage/settings";
import { MemoryService, type MemoryEntry } from "../core/memory/memory";

const UNDO_KEY = "codem-memory-consolidation-undo";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * 深快照（与实现无关的独立拷贝，避免"拿实现自己的对象比实现"）。
 *
 * ⚠️ 24 号文 P2-A 之后**剔除版本三元组**（`rev` / `updatedAt` / `deviceId`）：
 * 整合/撤销/恢复都是**一次真实的本地写**，版本号必须前进（否则并发合并会把这次写判成冲突）。
 * 本文件的判据守的是「正文 / 时间戳 / 创建序 / 归档标记」逐字段不变，不是"版本号不变"。
 */
function snap(entry: MemoryEntry | undefined): MemoryEntry | undefined {
  if (entry === undefined) return undefined;
  const copy = JSON.parse(JSON.stringify(entry)) as MemoryEntry;
  delete copy.rev;
  delete copy.updatedAt;
  delete copy.deviceId;
  return copy;
}

function snapshotAll(svc: MemoryService): Map<string, MemoryEntry> {
  return new Map(svc.listAll().map((entry) => [entry.id, snap(entry)!] as const));
}

function entryOf(svc: MemoryService, id: string): MemoryEntry {
  const entry = svc.get(id);
  expect(entry, `条目 ${id} 必须还在（归档不等于删除）`).toBeDefined();
  return entry!;
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  saveMemory("");
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("CONS-1：manual/pending 不动；auto 只归档；可逐条撤销", () => {
  it("整合 → 归档（不删除）→ 撤销后条目集合与原文逐条相同", () => {
    const svc = new MemoryService();
    const manual = svc.add({ scope: "platform", key: "手写约定", content: "MANUAL_KEEP 用户手写的", source: "manual" }).entry!;
    const pending = svc.add({
      scope: "platform",
      key: "待批准的事项",
      content: "PENDING_KEEP 未批准",
      source: "auto",
      status: "pending",
    }).entry!;

    /* CONS-2 夹具：两条中文近重复（2-gram 合并 0.345；旧空格切词+字符集只有 0.253） */
    const nearA = svc.add({
      scope: "platform",
      key: "Vitest 位置参数是路径子串匹配",
      content: "vitest 的位置参数按路径子串匹配；传多个参数时是 OR 关系。记号 ALPHA。",
      source: "auto",
    }).entry!;
    const nearB = svc.add({
      scope: "platform",
      key: "vitest 路径参数按子串匹配、多参数为 OR",
      content: "Vitest 位置参数匹配语义：路径子串匹配，多个参数之间是 OR。记号 BETA。",
      source: "auto",
    }).entry!;

    const stale = svc.add({ scope: "project", projectId: "p1", key: "过期条目", content: "STALE_KEEP 很旧", source: "auto" }).entry!;
    /* 直接改时间戳（仓储层字段，测试夹具）⇒ 一定超过 maxAgeDays */
    entryOf(svc, stale.id).timestamp = NOW - 200 * DAY;

    const before = snapshotAll(svc);
    const result = svc.consolidate({ maxAgeDays: 90, now: NOW, sessionId: "s-cons" });

    /* ① manual / pending 逐字段不变（不是"还在"就算数；口径见 `snap`：版本三元组不入比较） */
    expect(snap(entryOf(svc, manual.id)), "manual 条目必须逐字段不变").toEqual(before.get(manual.id));
    expect(snap(entryOf(svc, pending.id)), "pending 条目必须逐字段不变").toEqual(before.get(pending.id));
    expect(entryOf(svc, manual.id).archived, "manual 永不被归档").toBeUndefined();
    expect(entryOf(svc, pending.id).archived, "pending 永不被归档").toBeUndefined();

    /* ② 近重复被合并：一条归档、keeper 正文含两边独有事实 */
    expect(result.duplicatesMerged, "2-gram 近重复必须合并（旧空格切词尺量不出这一对）").toBe(1);
    const pair = [entryOf(svc, nearA.id), entryOf(svc, nearB.id)];
    expect(pair.filter((e) => e.archived === true).length, "重复项归档（不是删除）").toBe(1);
    const keeper = pair.find((e) => e.archived !== true)!;
    expect(keeper.content, "keeper 必须同时含两条的独有事实").toContain("ALPHA");
    expect(keeper.content, "keeper 必须同时含两条的独有事实").toContain("BETA");
    expect(pair[0].archived === true ? pair[0].supersededBy : pair[1].supersededBy, "归档项要指向 keeper").toBe(keeper.id);

    /* ③ 过期条目归档（不删除），正文原样 */
    const staleAfter = entryOf(svc, stale.id);
    expect(staleAfter.archived, "过期条目只归档").toBe(true);
    expect(staleAfter.content).toBe("STALE_KEEP 很旧");
    expect(result.staleArchived).toBe(1);

    /* ④ 条目集合不变（没有删除任何一条） */
    expect(new Set(svc.listAll().map((e) => e.id)), "整合不许删除任何条目").toEqual(new Set(before.keys()));

    /* ⑤ 有 diff/undoToken；撤销后逐条等于整合前快照 */
    expect(result.changed, "本次确实改了条目").toBeGreaterThanOrEqual(2);
    expect(result.undoToken, "必须生成可撤销令牌").toBeTruthy();
    const view = svc.getConsolidationUndo(NOW);
    expect(view?.changes, "撤销记录要能报出条数").toBe(result.changed);
    expect(view?.sessionId, "撤销记录带会话").toBe("s-cons");

    const undone = svc.undoConsolidate(result.undoToken, { now: NOW + 1000 });
    expect(undone.ok, undone.message).toBe(true);
    expect(undone.restored + undone.recreated).toBe(result.changed);
    for (const [id, expected] of before) {
      expect(snap(svc.get(id)), `撤销后条目 ${id} 必须与整合前逐字段相同`).toEqual(expected);
    }
    expect(new Set(svc.listAll().map((e) => e.id))).toEqual(new Set(before.keys()));

    /* ⑥ 撤销单次有效：再撤一次不产生第二次副作用，条目仍逐条等于整合前 */
    const again = svc.undoConsolidate(result.undoToken, { now: NOW + 2000 });
    expect(again.ok, "已撤销过的记录不再可用").toBe(false);
    expect(again.reason).toBe("none");
    for (const [id, expected] of before) {
      expect(snap(svc.get(id)), "第二次撤销不许改动任何条目").toEqual(expected);
    }
  });

  it("CONS-2：合并后的同一事实仍可被 memory_search 检索到（只查会注入的条目）", () => {
    const svc = new MemoryService();
    const a = svc.add({
      scope: "platform",
      key: "Vitest 位置参数是路径子串匹配",
      content: "vitest 的位置参数按路径子串匹配；传多个参数时是 OR 关系。记号 ALPHA。",
      source: "auto",
    }).entry!;
    const b = svc.add({
      scope: "platform",
      key: "vitest 路径参数按子串匹配、多参数为 OR",
      content: "Vitest 位置参数匹配语义：路径子串匹配，多个参数之间是 OR。记号 BETA。",
      source: "auto",
    }).entry!;
    svc.consolidate({ maxAgeDays: 90, now: NOW });

    const ctx = { projectId: "p1", sessionId: "s-cons" };
    const hits = svc.search("ALPHA", "platform", 10, ctx, { onlyInjected: true });
    expect(hits.length, "合并后应只有 keeper 会命中（归档项不进上下文）").toBe(1);
    expect([a.id, b.id]).toContain(hits[0].entry.id);
    expect(hits[0].entry.content).toContain("BETA");
  });

  it("容量归档：只归档 auto、非 pending；manual/pending 超额时如实拒绝（capacityBlocked）", () => {
    const svc = new MemoryService();
    const manual = svc.add({ scope: "project", projectId: "p1", key: "手写", content: "MANUAL_CAP", source: "manual" }).entry!;
    const pending = svc.add({
      scope: "project",
      projectId: "p1",
      key: "待批准",
      content: "PENDING_CAP",
      source: "auto",
      status: "pending",
    }).entry!;
    const autos = [
      { key: "构建入口", content: "AUTO_CAP_1 构建命令是 npm run build。" },
      { key: "测试入口", content: "AUTO_CAP_2 测试命令是 npx vitest run。" },
      { key: "发布入口", content: "AUTO_CAP_3 安装包由 electron-builder 生成。" },
      { key: "日志位置", content: "AUTO_CAP_4 运行日志写在 %APPDATA% 下的 runtime 文件。" },
    ].map((item) => svc.add({ scope: "project", projectId: "p1", key: item.key, content: item.content, source: "auto" }).entry!);
    const before = snapshotAll(svc);

    const result = svc.consolidate({ removeStale: false, maxEntriesPerScope: 3, now: NOW });
    expect(result.capacityArchived, "超额的 auto 条目归档（不删除）").toBeGreaterThan(0);
    expect(entryOf(svc, manual.id).archived, "manual 不参与容量归档").toBeUndefined();
    expect(entryOf(svc, pending.id).archived, "pending 不参与容量归档").toBeUndefined();
    expect(new Set(svc.listAll().map((e) => e.id)), "仍然一条都没删").toEqual(new Set(before.keys()));

    /* 受保护条目自己就超上限 ⇒ 拒绝并上报，不归档任何一条 */
    saveMemory(""); // 清掉上面的语料（新实例会从同一份模拟存储里读回来）
    const guarded = new MemoryService();
    guarded.add({ scope: "platform", key: "m1", content: "MANUAL_OVER_1", source: "manual" });
    guarded.add({ scope: "platform", key: "m2", content: "MANUAL_OVER_2", source: "manual" });
    const blocked = guarded.consolidate({ removeStale: false, maxEntriesPerScope: 1, now: NOW });
    expect(blocked.capacityArchived, "受保护条目超额 ⇒ 不归档任何条目").toBe(0);
    expect(blocked.capacityBlocked, "必须如实上报被拒绝的桶").toBe(1);
    expect(blocked.undoToken, "什么都没变 ⇒ 无撤销记录").toBeUndefined();

    /* 撤销容量归档 */
    const undo = svc.undoConsolidate(result.undoToken, { now: NOW + 1000 });
    expect(undo.ok, undo.message).toBe(true);
    for (const [id, expected] of before) {
      expect(snap(svc.get(id)), `容量撤销后 ${id} 必须回到原样`).toEqual(expected);
    }
    for (const entry of autos) expect(entryOf(svc, entry.id).archived).toBeUndefined();
  });
});

describe("撤销：过期拒绝 / 令牌不符 / 逐条恢复归档", () => {
  it("过期 ⇒ 拒绝且条目状态一个字都不动；记录被清理", () => {
    const svc = new MemoryService();
    const target = svc.add({ scope: "platform", key: "被归档的", content: "EXPIRED_KEEP", source: "auto" }).entry!;
    const before = snap(entryOf(svc, target.id))!;
    /* 模拟"已经被整合归档"的状态 + 一份过期撤销记录 */
    entryOf(svc, target.id).archived = true;
    entryOf(svc, target.id).archivedAt = NOW - 2 * DAY;
    setSettingJSON(UNDO_KEY, {
      token: "consol-old",
      createdAt: NOW - 2 * DAY,
      expiresAt: NOW - DAY,
      sessionId: "s-cons",
      changes: [{ id: target.id, kind: "stale", before, after: null }],
      truncated: 0,
    });

    const result = svc.undoConsolidate("consol-old", { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");
    expect(entryOf(svc, target.id).archived, "过期撤销不许改条目").toBe(true);
    expect(svc.getConsolidationUndo(NOW), "过期记录要清掉（否则一直显示可撤销）").toBeNull();
  });

  it("令牌不符 ⇒ 拒绝且记录保留；拿对令牌仍可撤销", () => {
    const svc = new MemoryService();
    const target = svc.add({ scope: "platform", key: "会被归档", content: "TOKEN_KEEP", source: "auto" }).entry!;
    entryOf(svc, target.id).timestamp = NOW - 200 * DAY;
    const result = svc.consolidate({ maxAgeDays: 90, now: NOW });
    expect(result.undoToken).toBeTruthy();

    const wrong = svc.undoConsolidate("consol-wrong", { now: NOW + 1000 });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toBe("token");
    expect(entryOf(svc, target.id).archived, "令牌不符不许改动条目").toBe(true);
    expect(svc.getConsolidationUndo(NOW + 1000)?.token, "记录保留").toBe(result.undoToken);

    const right = svc.undoConsolidate(result.undoToken, { now: NOW + 2000 });
    expect(right.ok, right.message).toBe(true);
    expect(entryOf(svc, target.id).archived).toBeUndefined();
  });

  it("restoreArchived：逐条恢复归档条目（正文/时间戳不变），对未归档条目如实拒绝", () => {
    const svc = new MemoryService();
    const entry = svc.add({ scope: "platform", key: "归档后恢复", content: "RESTORE_KEEP 正文", source: "auto" }).entry!;
    entryOf(svc, entry.id).timestamp = NOW - 200 * DAY;
    const before = snap(entryOf(svc, entry.id))!;
    svc.consolidate({ maxAgeDays: 90, now: NOW });
    expect(entryOf(svc, entry.id).archived).toBe(true);

    const restored = svc.restoreArchived(entry.id);
    expect(restored.ok, restored.message).toBe(true);
    expect(snap(entryOf(svc, entry.id))).toEqual(before);
    expect(svc.restoreArchived(entry.id).ok, "未归档条目不重复恢复").toBe(false);
  });
});
