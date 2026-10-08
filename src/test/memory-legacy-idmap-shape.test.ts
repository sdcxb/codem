/**
 * 存量记忆的**真实容器形状**：以条目 id 为键的裸映射（LEGACY-SHAPE-1..4）。
 *
 * ## 这组判据针对的缺陷（修复前必须有红）
 *
 * 真机取证（装机版 1.16.299）：渲染侧控制台实报
 *
 * ```
 * [PersistFailure] memory.load 操作失败：记忆容器形状不认识（顶层是 object，且没有 entries 字段）
 * ```
 *
 * 用 `storage_invoke` 读出该机器 `memory` 域的**真实原文**（6817 字节，这里取前 120 字符的形状）：
 *
 * ```json
 * {"mem-1791424659167-eirq3sf0m":{"scope":"project","key":"开发环境:Windows + PowerShell","content":"…"},
 *  "mem-1791424659168-4orrzpxyh":{…}, …}
 * ```
 *
 * 即：**顶层就是以条目 id 为键的裸映射**（没有 `entries` 字段），条目里只有 `scope/key/content`，
 * 且 `scope` 是**旧值**（`"project"`）。而修复前的加载器只认 `{ entries: {…} | […] }`
 * ⇒ 对 id-keyed 映射 **fail-closed 拒绝加载** ⇒ **存量用户的记忆一条都读不出来**
 * （数据没被删，但功能等于失效，每次加载还弹一条"形状不认识"）。
 *
 * ## 口径（修复后）
 *
 * 顶层是**非数组对象**、**没有** `entries` 字段、且**其值大多是"看起来像条目"的对象**
 * （至少含 `key` 或 `content`）⇒ 认成 id-keyed 映射；键就是 `MemoryEntry.id`。
 * 判据**不许**依赖"键以 `mem-` 开头"（真实 id 前缀会变，见下面 `LEGACY-SHAPE-1` 的第二组键）。
 *
 * | 判据 | 守什么 |
 * | --- | --- |
 * | LEGACY-SHAPE-1 | 真机那种形状 ⇒ **加载成功**、条目数正确、坏条目丢弃计数照旧 |
 * | LEGACY-SHAPE-2 | 认出来之后**照常走既有链路**：迁移（旧 project ⇒ platform + legacyPool）、默认仍注入、体检进「旧版跨项目记忆」组 |
 * | LEGACY-SHAPE-3 | **真正的垃圾形状**仍然 fail-closed（不迁移、不覆盖、如实上报） |
 * | LEGACY-SHAPE-4 | **不丢条目**：输入 N 条 ⇒ 加载 + 迁移后合计仍是 N |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { loadMemory, saveMemory, getSetting } from "../core/storage/settings";
import { MemoryService, MEMORY_MIGRATED_KEY, MEMORY_PRE_MIGRATION_KEY, isLegacyPoolInjectionPaused } from "../core/memory/memory";
import { createMemoryCheckup, buildOwnershipIndexFrom } from "../core/memory/checkup";
import type { MemoryEntry } from "../core/memory/memory";
import type { Project } from "../core/types";

const PROJ_A = "c:\\work\\alpha";

/**
 * 真机 `memory` 域前 120 字符的**逐字形状**：id-keyed 裸映射，条目只有 `scope/key/content`。
 *
 * 键刻意用真机那种 `mem-<时间戳>-<随机>`（长度/字符集都照抄），条目里**没有** `id` 字段 ——
 * 这正是"记录键就是主键"这条口径的现场。
 */
const REAL_MACHINE_SHAPE: Record<string, unknown> = {
  "mem-1791424659167-eirq3sf0m": {
    scope: "project",
    key: "开发环境:Windows + PowerShell",
    content: "项目在 Windows 上进行开发，命令通过 PowerShell 执行",
  },
  "mem-1791424659168-4orrzpxyh": {
    scope: "project",
    key: "构建签名",
    content: "构建必须带签名环境变量，否则 CLI 会卡在交互输密码",
  },
  "mem-1791424659169-8xq2m1p0v": {
    scope: "project",
    key: "中文引号",
    content: "脚本里的中文引号一律用「」，写进 JS 双引号串会让脚本崩溃",
  },
  "mem-1791424659170-0i9i0aiq1": {
    scope: "session",
    key: "本次任务槽",
    content: "IDMAP_SESSION_FACT 会话级事实",
  },
  "mem-1791424659171-zz91k4m2q": {
    scope: "global",
    key: "全局偏好",
    content: "IDMAP_GLOBAL_FACT 全局事实",
  },
};

/** 真机形状的 JSON 原文（判据里断言"库里逐字就是它"时要能取到） */
const REAL_MACHINE_JSON = JSON.stringify(REAL_MACHINE_SHAPE);

let port: FakeStoragePort;

function mount(opts: Parameters<typeof createFakeStoragePort>[0] = {}): FakeStoragePort {
  const p = createFakeStoragePort(opts);
  setStoragePort(p);
  return p;
}

/** 全部视图（含未批准/无归属/跨项目）—— 与体检同口径 */
const ALL_VIEW = { includePending: true, includeUnscoped: true, showAllProjects: true } as const;

function memoryWrites(p: FakeStoragePort): Array<{ command: string; params?: Record<string, unknown> }> {
  return p.__writes().filter((w) => w.command === "memory.set");
}

function keysOf(entries: MemoryEntry[]): string[] {
  return entries.map((e) => e.key).sort();
}

beforeEach(() => {
  port = mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("LEGACY-SHAPE-1：id-keyed 裸映射是**合法容器**（修复前被拒）", () => {
  it("LEGACY-SHAPE-1：真机那种形状 ⇒ 加载成功、条目数正确（不再 fail-closed）", () => {
    saveMemory(REAL_MACHINE_JSON);
    const svc = new MemoryService();

    const state = svc.getLoadState();
    expect(state.ok, `真机上这份存量数据必须能加载（当前：${state.reason}）`).toBe(true);
    expect(state.kind, "它不是'形状不认识'").not.toBe("malformed");
    expect(state.dropped, "5 条都合法，一条都不许丢").toBe(0);

    const all = svc.listAll(ALL_VIEW);
    expect(all, "条目数必须正确").toHaveLength(5);
    expect(keysOf(all)).toEqual(
      ["全局偏好", "中文引号", "开发环境:Windows + PowerShell", "构建签名", "本次任务槽"].sort(),
    );

    // 键就是 id（真机条目里没有 `id` 字段，只能以记录键为准）
    expect(all.map((e) => e.id).sort()).toEqual(Object.keys(REAL_MACHINE_SHAPE).sort());

    // 内容逐字读进来（读入层不许篡改用户的原文）
    expect(all.map((e) => e.content)).toContain("脚本里的中文引号一律用「」，写进 JS 双引号串会让脚本崩溃");

    // 不是"推迟迁移"那一支：容器被认出来了，迁移按既有链路照跑
    expect(svc.getMigrationReport()?.deferredReason ?? null, "认出来的容器不该走'推迟迁移'").toBeNull();
  });

  it("LEGACY-SHAPE-1b：判定口径不依赖键前缀（换成任意 id 形状照样认）", () => {
    // 键**不以 mem- 开头**：真机前缀会变（uuid / 时间戳 / 别的命名都可能）
    const otherKeys = {
      "a1b2c3d4-0000-1111-2222-333344445555": { scope: "platform", key: "uuid 键", content: "UUID_KEYED_FACT" },
      "记忆-7": { scope: "platform", key: "中文键", content: "CN_KEYED_FACT" },
      "42": { scope: "platform", key: "数字样键", content: "NUM_KEYED_FACT" },
    };
    saveMemory(JSON.stringify(otherKeys));

    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "键长什么样不是判据（前缀会变）").toBe(true);
    expect(keysOf(svc.listAll(ALL_VIEW))).toEqual(["uuid 键", "中文键", "数字样键"].sort());
  });

  it("LEGACY-SHAPE-1c：混进坏值时**认得出**容器、坏条目按既有口径丢弃并计数", () => {
    saveMemory(
      JSON.stringify({
        ...REAL_MACHINE_SHAPE,
        "mem-broken-string": "这不是一个条目（值不是对象）",
        "mem-broken-nocontent": { scope: "project", key: "缺内容" },
        "mem-broken-badkey": { scope: "project", key: { obj: 1 }, content: "键是对象" },
      }),
    );

    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "少数坏值不许把整份存量判成'不认识'").toBe(true);
    expect(svc.listAll(ALL_VIEW), "合法条目一条不少").toHaveLength(5);
    expect(svc.getLoadState().dropped, "坏条目要**如实计数**（口径与 importFromJSON 一致）").toBe(3);
  });
});

describe("LEGACY-SHAPE-2：认出来之后**照常走既有链路**（迁移 + 注入 + 体检）", () => {
  it("LEGACY-SHAPE-2：旧 project ⇒ platform + legacyPool；默认仍注入；体检进「旧版跨项目记忆」组", () => {
    saveMemory(REAL_MACHINE_JSON);
    const svc = new MemoryService();

    const report = svc.getMigrationReport()!;
    expect(report.ran, "认出来的存量数据必须走同一条迁移链路").toBe(true);
    expect(report.projectToPlatform, "三条旧 project 降为 platform").toBe(3);
    expect(report.projectToLegacyPool, "三条都打 legacyPool 标记").toBe(3);
    expect(report.sessionToConversation, "旧 session ⇒ conversation（无 sessionId）").toBe(1);
    expect(report.globalToPlatform, "旧 global ⇒ platform（不迁移的话这条也读不出来）").toBe(1);

    const all = svc.listAll(ALL_VIEW);
    const projectBorn = all.filter((e) => e.key !== "本次任务槽" && e.key !== "全局偏好");
    expect(projectBorn.map((e) => e.scope)).toEqual(["platform", "platform", "platform"]);
    expect(projectBorn.every((e) => e.legacyPool === true), "迁移**必须**留下可展示的痕迹").toBe(true);
    expect(all.find((e) => e.key === "全局偏好")!.legacyPool, "旧 global 不打标记（它不是自动提取的目标作用域）").toBeFalsy();
    expect(all.find((e) => e.key === "本次任务槽")!.scope).toBe("conversation");
    expect(all.find((e) => e.key === "本次任务槽")!.sessionId, "归属键刻意不猜").toBeUndefined();

    // 默认（暂停开关关着）⇒ 与升级前一致：所有项目都能看到这些内容
    expect(isLegacyPoolInjectionPaused(), "开关默认必须是关").toBe(false);
    const promptA = svc.buildMemoryPrompt(undefined, PROJ_A, "s1");
    expect(promptA, "旧 project 池默认仍注入（行为不变）").toContain("开发环境:Windows + PowerShell");
    expect(promptA).toContain("IDMAP_GLOBAL_FACT");

    // 体检：进「旧版跨项目记忆」组（与平台级分开）
    const projects: Project[] = [{ id: "p1", name: "甲项目", path: "c:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 }];
    const checkup = createMemoryCheckup({ projectId: PROJ_A, sessionId: "s1" }, {
      index: buildOwnershipIndexFrom(projects, new Map()),
      service: svc,
    });
    const poolGroup = checkup.groups.find((g) => g.groupKey === "legacy-project-pool")!;
    expect(poolGroup, "必须有「旧版跨项目记忆」组").toBeDefined();
    expect(poolGroup.kind).toBe("legacy-pool");
    expect(poolGroup.entries).toHaveLength(3);
    expect(checkup.legacyPoolCount).toBe(3);
    expect(checkup.groups.find((g) => g.groupKey === "platform")!.entries.map((e) => e.key)).toEqual(["全局偏好"]);
  });
});

describe("LEGACY-SHAPE-3：真正的垃圾形状**仍然** fail-closed（第 3 条没被放松）", () => {
  const garbage: Array<[string, string]> = [
    ["顶层是字符串", JSON.stringify("mem-1")],
    ["顶层是数字", JSON.stringify(42)],
    ["值是数字的对象（值不像条目）", JSON.stringify({ foo: 1 })],
    ["值是普通对象但不像条目（没有 key/content）", JSON.stringify({ foo: { bar: 1 } })],
    ["值是数组的映射", JSON.stringify({ foo: [1, 2, 3] })],
    ["半截 JSON", '{"mem-1":{"scope":"project","key":"k"'],
  ];

  for (const [name, raw] of garbage) {
    it(`LEGACY-SHAPE-3：${name} ⇒ 不迁移、不覆盖、如实上报`, () => {
      saveMemory(raw);
      const writesAfterSeed = memoryWrites(port).length;

      const svc = new MemoryService();

      expect(svc.getLoadState().ok, `${name} 必须继续 fail-closed`).toBe(false);
      expect(["malformed", "parse"]).toContain(svc.getLoadState().kind);
      expect(svc.getLoadState().reason, "必须如实给出原因").toMatch(/形状|entries|解析/);
      expect(svc.getMigrationReport()?.ran, "形状不认识 ⇒ 不许迁移").toBe(false);
      expect(svc.getMigrationReport()?.deferredReason, "推迟原因要能被界面看到").toBeTruthy();
      expect(getSetting(MEMORY_MIGRATED_KEY), "形状不认识 ⇒ 不许写迁移标记").not.toBe("1");
      expect(svc.listAll(ALL_VIEW), "不许把垃圾收进池").toHaveLength(0);
      expect(loadMemory(), `库内容必须**逐字**保持原样（${name}）`).toBe(raw);
      expect(memoryWrites(port).length, "形状不认识时不许再发写穿").toBe(writesAfterSeed);
    });
  }

  it("LEGACY-SHAPE-3b：值**大多**不像条目 ⇒ 也不认（判据是「大多像」，不是「有一个像」）", () => {
    // 2 个条目 + 4 个非条目对象 = 1/3 像条目 ⇒ 不认
    saveMemory(
      JSON.stringify({
        "mem-1": { scope: "project", key: "真条目", content: "REAL_ONE" },
        "mem-2": { scope: "project", key: "真条目 2", content: "REAL_TWO" },
        junk1: { bar: 1 },
        junk2: { bar: 2 },
        junk3: { bar: 3 },
        junk4: { bar: 4 },
      }),
    );
    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "只有少数值像条目 ⇒ 不许当成存量记忆搬进来").toBe(false);
    expect(loadMemory(), "库里逐字不变").toBeTruthy();
  });
});

describe("LEGACY-SHAPE-4：不丢条目", () => {
  it("LEGACY-SHAPE-4：输入 N 条 ⇒ 加载 + 迁移后 getStats/listAll 合计仍是 N；且逐字可回退", async () => {
    const N = 40;
    const map: Record<string, unknown> = {};
    for (let i = 0; i < N; i += 1) {
      map[`mem-1791424659${String(100 + i)}-k${i}`] = {
        scope: i % 3 === 0 ? "project" : i % 3 === 1 ? "session" : "global",
        key: `条目 ${i}`,
        content: `IDMAP_BULK_FACT_${i}`,
      };
    }
    const raw = JSON.stringify(map);
    saveMemory(raw);

    const svc = new MemoryService();
    expect(svc.getLoadState().ok).toBe(true);
    expect(svc.getLoadState().dropped).toBe(0);
    expect(svc.listAll(ALL_VIEW), `${N} 条一条不少`).toHaveLength(N);
    expect(svc.getStats().totalEntries, "统计与列表同口径").toBe(N);

    // 迁移前快照必须是**逐字**的原文（真机上 6817 字节那份的可回退凭据）
    await svc.flushPendingPersist();
    expect(svc.getLastPersistError(), `快照/数据/标记三道都该成功：${svc.getLastPersistError()}`).toBeNull();
    const snapshot = svc.getPreMigrationSnapshot()!;
    expect(snapshot, "id-keyed 存量数据也必须先落快照").toBeTruthy();
    expect(snapshot.raw, "快照里必须是**迁移前**的原始字符串（逐字）").toBe(raw);
    expect(snapshot.entries).toBe(N);

    // 回退逐字恢复（真机那份数据即便判定有偏差也能原样退回）
    const restored = await svc.restorePreMigrationSnapshot();
    expect(restored.ok, restored.message).toBe(true);
    expect(loadMemory(), "回退必须逐字一致").toBe(raw);
    expect(svc.listAll(ALL_VIEW), "回退后条目仍然一条不少（id-keyed 不能被读成空表）").toHaveLength(N);
  });

  /**
   * 真机那份 6817 字节的存量数据**唯一**的安全依据：迁移前快照必须**先于**数据写入落库。
   *
   * 顺序反了就会出现那个不可逆窗口——「数据已迁 + 标记已写 + **快照没落**」：
   * 磁盘上已经是新形态、也没有可回退的原文，用户再也回不到升级前那一刻。
   * 这条只在**落库轨迹**（`port.__writes()` 的顺序）上可判，镜像/接口都看不出来。
   */
  it("LEGACY-SHAPE-4b：迁移前快照**先于**迁移数据落库（存量的可回退窗口）", async () => {
    saveMemory(REAL_MACHINE_JSON);
    // 只看"构造 MemoryService 之后"的写：`saveMemory` 自己那一次是播种，不算迁移的
    const seededWrites = port.__writes().length;

    const svc = new MemoryService();
    await svc.flushPendingPersist();
    expect(svc.getLastPersistError(), `迁移三道（快照→数据→标记）都该成功：${svc.getLastPersistError()}`).toBeNull();

    const writes = port.__writes().slice(seededWrites);
    const snapshotIdx = writes.findIndex(
      (w) =>
        w.command === "crud.upsert" &&
        (w.params as { table?: string } | undefined)?.table === "settings" &&
        ((w.params as { rows?: Array<{ key?: string }> } | undefined)?.rows ?? []).some((r) => r.key === MEMORY_PRE_MIGRATION_KEY),
    );
    const dataIdx = writes.findIndex((w) => w.command === "memory.set");

    expect(snapshotIdx, "迁移前快照必须落到磁盘上").toBeGreaterThanOrEqual(0);
    expect(dataIdx, "迁移后的数据也必须落库").toBeGreaterThanOrEqual(0);
    expect(
      snapshotIdx,
      "快照没**先**落 ⇒ 存在『数据已迁、标记已写、快照没落』的不可逆窗口（真机存量就再也退不回去了）",
    ).toBeLessThan(dataIdx);
  });
});
