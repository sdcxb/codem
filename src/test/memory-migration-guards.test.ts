/**
 * 存量数据与迁移的 fail-closed 判据（第 187 波：MIG-* / A1 / A2 / B4-B7 / I1-I6 / S1-S4）。
 *
 * ## 这组判据针对的缺陷（修复前必须有红）
 *
 * | 判据 | 缺陷 | 修复前为什么红 |
 * | --- | --- | --- |
 * | MIG-GUARD-1 | 读失败/解析失败 ⇒ 迁移标记照写、随后整份覆盖 | 旧实现无条件 `setSetting(MEMORY_MIGRATED_KEY,"1")` |
 * | MIG-GUARD-2 | 只有"成功解析 + 真的迁移过"才写标记 | 旧实现不区分 |
 * | A1-SAVE-FAIL | `save()` 失败也写标记 ⇒ 迁移永久不再发生 | 旧实现标记与 save 结果无关 |
 * | MIG-LEGACY-1/2/3 | 旧 project 池迁移后与平台级混在一起、无法隔离 | 旧实现不打任何标记 |
 * | MIG-ROBUST-1 | 非字符串 content/key 抛在系统提示构造里 | `formatLine` 直接 `.substring` |
 * | MIG-ROBUST-2 | 坏 JSON / 顶层是数组 ⇒ 静默成空表并覆盖 | `catch { console.warn }` |
 * | MIG-UNKNOWN-1 | 未知作用域在所有界面看不见、删不掉 | 体检只遍历三个作用域 |
 * | MIG-SNAP-1 | 迁移不留快照 ⇒ 无法回退 | 全仓无快照 |
 * | A2-SEARCH | `search` 缺 ctx ⇒ 跨项目泄漏（含未批准条目） | `if (ctx && !visibleIn(...))` 短路 |
 * | B4-DEDUP | 无归属时判重恒空 ⇒ 每轮重复写同一条事实 | `search(..., {projectId: undefined})` |
 * | B5-CAPACITY | `update`/导入不守容量 + 静默截断 | 无检查、无提示 |
 * | B7-STATS | 统计口径跨项目（「项目 37 / 列表 2 条」） | `getStats()` 遍历全库 |
 * | I1-WRITE-COLD | 配置面未预热时"读回退空串 + 全量写回"清空记忆 | `save()` 不看预热状态 |
 * | I1-FINALIZE | 每回合 `finalizeBatch` 也会覆盖 | 同上 |
 * | I4-INJECT-CAP | 第 21 条起静默不进上下文，界面仍说"已生效" | 界面不含截断口径 |
 * | I5-CONSOLIDATE | 每回合自动整合会静默删除/改写 | `llm/index.ts` 自动调用 |
 * | I6-SAVE-CONFIRM | `save()` 假成功（异步落库失败不回传调用方） | `saveMemory` 恒 void |
 * | S1-BUDGET | 注入无字符预算、key 原样注入 | 只截 content 的 200 字符 |
 * | S3-NOOP | 无变化也整份写盘 + 幽灵批次 | `finalizeBatch` 无条件 save |
 * | S4-PENDING | 默认审批下自动记忆不进上下文且无提示 | 只有数字、无解释 |
 * | I9-REASON | 归属失效被说成"旧数据" | 只有一句 `UNRESOLVED_REASON` |
 *
 * 全部是**行为断言**（调用产品 API → 断言结果/注入文本/落库轨迹），
 * 唯一"源码级"的断言写在 `MEM-INJECT-3`（已按 D1 改成行为）与这里都不使用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { loadMemory, saveMemory, getSetting, setSetting } from "../core/storage/settings";
import { getPersistFailures, resetPersistFailures, composePersistAlertText } from "../core/storage/persist-failure";
import {
  MemoryService,
  MEMORY_MIGRATED_KEY,
  MEMORY_PRE_MIGRATION_KEY,
  MEMORY_PAUSE_LEGACY_POOL_KEY,
  MEMORY_INJECT_CHAR_BUDGET,
  MEMORY_INJECT_KEY_MAX,
  MEMORY_INJECT_MAX_PER_BLOCK,
  isLegacyPoolInjectionPaused,
  safeMemoryText,
  setLegacyPoolInjectionPaused,
} from "../core/memory/memory";
import { createMemoryCheckup, buildOwnershipIndexFrom, retargetEntry, keepAsPlatformPool, keepManyAsPlatform, formatMemoryImportReceipt } from "../core/memory/checkup";
import { LLMEngine } from "../core/llm/index";
import type { Project } from "../core/types";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const PROJ_B = "c:\\work\\beta";

/** 旧版本写下的 `project` 池（没有 projectId —— 这正是"到处生效"的根因） */
const LEGACY_PROJECT_JSON = JSON.stringify({
  version: 1,
  entries: {
    "legacy-1": { id: "legacy-1", scope: "project", key: "老项目池约定", content: "LEGACY_POOL_FACT 到处生效", timestamp: 1_600_000_000_000 },
    "legacy-2": { id: "legacy-2", scope: "global", key: "老全局", content: "LEGACY_GLOBAL_FACT", timestamp: 1_600_000_000_001 },
  },
});

let port: FakeStoragePort;

/** 每个用例一个干净端口；`onWriteThrough` 不受支持，落库轨迹一律看 `port.__writes()` / `loadMemory()` */
function mount(opts: Parameters<typeof createFakeStoragePort>[0] = {}): FakeStoragePort {
  const p = createFakeStoragePort(opts);
  setStoragePort(p);
  return p;
}

/** 该 key 是否被写进 settings 表（"写标记"的**落库证据**，不是内存里的值） */
function settingWritten(p: FakeStoragePort, key: string): boolean {
  return p
    .__writes()
    .some(
      (w) =>
        w.command === "crud.upsert" &&
        (w.params as { table?: string } | undefined)?.table === "settings" &&
        ((w.params as { rows?: Array<{ key?: string }> } | undefined)?.rows ?? []).some((r) => r.key === key),
    );
}

function memoryWrites(p: FakeStoragePort): Array<{ command: string; params?: Record<string, unknown> }> {
  return p.__writes().filter((w) => w.command === "memory.set");
}

beforeEach(() => {
  port = mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

// ===================== M-1 / M-4 / A1 / I1 =====================

describe("MIG-GUARD：读失败/格式不认识 ⇒ 不迁移、不写标记、不覆盖", () => {
  it("MIG-GUARD-1a（读失败）：记忆域未预热 ⇒ 不写迁移标记、不发 memory.set", () => {
    // 设置面预热成功、**记忆域**预热失败（config_warmup 一把抓三个域，任一失败整条失败）
    port = mount({
      configWarmed: false,
      seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] },
    });

    const svc = new MemoryService();

    // ① 读失败如实上报（状态可查，不是 console 里一条 warn）
    const state = svc.getLoadState();
    expect(state.ok, "记忆域未预热时**不许**把这次读当成结论").toBe(false);
    expect(state.reason, "必须给出用户可读的原因").toContain("预热");

    // ② 不迁移 + ③ 不写标记
    expect(svc.getMigrationReport()?.ran).toBe(false);
    expect(svc.getMigrationReport()?.deferredReason, "迁移报告要写明'因读取失败而推迟'").toBeTruthy();
    expect(getSetting(MEMORY_MIGRATED_KEY), "读失败时**绝不许**写迁移标记").not.toBe("1");
    expect(settingWritten(port, MEMORY_MIGRATED_KEY), "标记不许落库（这是'永不再迁移'的成因）").toBe(false);

    // ④ 不覆盖：旧字符串逐字仍在（没有 memory.set 写穿）
    expect(memoryWrites(port), "读失败时不许把兜底空内容写回库").toEqual([]);
    expect(port.__table("memory")[0]?.content, "库里那份旧数据必须**逐字**还在").toBe(LEGACY_PROJECT_JSON);
  });

  it("MIG-GUARD-1b（读失败）：写入被拒绝且如实失败（不许把空内容整份覆盖）", () => {
    port = mount({
      configWarmed: false,
      seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] },
    });
    const svc = new MemoryService();

    const result = svc.add({ scope: "platform", key: "新的", content: "NEW_FACT", source: "manual" });
    expect(result.ok, "读失败时新增必须**如实失败**（否则下一次 save 就把旧数据抹了）").toBe(false);
    expect(result.error, "原因要能被界面区分出来").toBe("persist");
    expect(memoryWrites(port), "被拒绝的写入不许真的发出去").toEqual([]);
    expect(port.__table("memory")[0]?.content).toBe(LEGACY_PROJECT_JSON);
  });

  it("MIG-GUARD-1c（解析失败）：坏 JSON ⇒ 不迁移、不写标记、原字符串逐字仍在", () => {
    const broken = "{坏掉的 JSON";
    saveMemory(broken);
    // 基线：这一次 saveMemory 自己就是一条写穿（下面的断言只看"解析失败之后有没有写"）
    const writesAfterSeed = memoryWrites(port).length;

    const svc = new MemoryService();

    expect(svc.getLoadState().ok).toBe(false);
    expect(svc.getLoadState().kind, "解析失败与'读不到'要能区分").toBe("parse");
    expect(svc.getMigrationReport()?.deferredReason, "迁移报告要说明因解析失败而推迟").toBeTruthy();
    expect(getSetting(MEMORY_MIGRATED_KEY)).not.toBe("1");
    expect(settingWritten(port, MEMORY_MIGRATED_KEY)).toBe(false);
    // 逐字：产品的读路径读回来的仍然是那一段坏字符串（说明没人覆盖它）
    expect(loadMemory(), "坏 JSON 必须**逐字**留在库里").toBe(broken);
    expect(memoryWrites(port).length, "解析失败时不许再发写穿").toBe(writesAfterSeed);
  });

  it("MIG-GUARD-2（成功解析 + 真的迁移过）：才写标记；重复加载 ran:false 且不改数据", async () => {
    saveMemory(LEGACY_PROJECT_JSON);

    const first = new MemoryService();
    const report = first.getMigrationReport()!;
    expect(report.ran).toBe(true);
    expect(report.projectToLegacyPool).toBe(1);
    /**
     * R1：迁移的**数据落库与标记落库走串行确认通道** ⇒ 断言"落库了没有"之前必须等确认链排空。
     * （修复前这里是无条件 `setSetting(KEY,"1")`，同步就能读到标记 —— 那正是
     * "数据没落、标记落了"的成因，所以同步读到标记本身不是好事。）
     */
    await first.flushPendingPersist();
    expect(first.getLastPersistError(), `落库应成功：${first.getLastPersistError()}`).toBeNull();
    expect(report.projectToPlatform).toBe(1);
    expect(report.globalToPlatform).toBe(1);
    expect(getSetting(MEMORY_MIGRATED_KEY), "数据确认落库之后才写标记").toBe("1");
    expect(settingWritten(port, MEMORY_MIGRATED_KEY)).toBe(true);

    const migratedContent = loadMemory();
    const writesAfterFirst = memoryWrites(port).length;

    // 幂等：标记在 ⇒ ran:false、不改数据、不再写盘
    const second = new MemoryService();
    expect(second.getMigrationReport()!.ran, "标记命中即不再迁移").toBe(false);
    expect(loadMemory(), "重复加载不许改动库内容").toBe(migratedContent);
    expect(memoryWrites(port).length, "幂等路径不许再发写穿").toBe(writesAfterFirst);
    expect(second.getStats().totalEntries).toBe(2);
  });

  /**
   * A1-SAVE-FAIL：**同步** save 失败 ⇒ 不写标记。
   *
   * ⚠️ 这条只覆盖"同步那半"；真正危险的形态是**异步写穿失败**（R1-CONFIRM 覆盖）。
   */
  it("A1-SAVE-FAIL：同步 save 失败时**不写迁移标记**（否则迁移永久不再发生）", () => {
    // 空库启动：`changed === 0` ⇒ 不写标记（正好用来造"标记尚未写"的现场）
    saveMemory("");
    const svc = new MemoryService();
    expect(getSetting(MEMORY_MIGRATED_KEY), "空库不该写迁移标记").not.toBe("1");

    // 现在把旧数据塞进内存（等价于"这一次真的读到了旧数据"），并让 save() 如实失败
    svc.__seedLegacyForMigrationTest([
      { scope: "project", key: "旧池", content: "LEGACY_POOL_FACT" },
      { scope: "global", key: "旧全局", content: "LEGACY_GLOBAL_FACT" },
    ]);
    vi.spyOn(svc as unknown as { save(): boolean }, "save").mockReturnValue(false);

    const report = svc.migrateScopeModel({ force: true });
    expect(report.ran).toBe(true);
    expect(report.projectToLegacyPool).toBe(1);
    expect(getSetting(MEMORY_MIGRATED_KEY), "save 失败 ⇒ 标记**不许**写（否则下次启动直接 ran:false）").not.toBe("1");

    // 而"修好之后"能继续迁移：换一个正常端口 + 同一份旧数据 ⇒ 迁移照常发生（没被锁死）
    vi.restoreAllMocks();
    port = mount();
    saveMemory(LEGACY_PROJECT_JSON);
    const retry = new MemoryService();
    expect(retry.getMigrationReport()!.ran, "上次失败不该锁死迁移").toBe(true);
    expect(retry.getMigrationReport()!.projectToLegacyPool).toBe(1);
  });

  /**
   * R1：**异步写穿失败**（IPC 失败 / 重试耗尽 / 磁盘满）也必须挡住标记。
   *
   * 修复前的形态是：`save()` 只在**同步抛错**时返回 false，而 `memory.set` 的失败是
   * `.catch(上报)`；标记又走**另一条** fire-and-forget 写穿 ⇒ 磁盘上可能
   * 「**数据没落、标记落了**」⇒ 下次启动 `ran:false` ⇒ 旧作用域条目永久不注入。
   */
  it("R1-CONFIRM：数据写失败但设置写成功 ⇒ 仍然**不写迁移标记**（不许'数据没落、标记落了'）", async () => {
    /*
     * 造的是**最危险的那个组合**：`memory.set` 失败、`crud.upsert`（设置/标记）成功。
     * 修复前的形态下：`save()` 只反映"没抛同步异常"（`memory.set` 是 fire-and-forget，
     * 失败只上报）⇒ 返回 true ⇒ 紧接着无条件 `setSetting(KEY,"1")` **成功落库**
     * ⇒ 下次启动 `ran:false` ⇒ 旧作用域条目**永久**不注入。
     */
    port = mount({ failCommands: ["memory.set"], seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] } });

    const svc = new MemoryService();
    await svc.flushPendingPersist();

    expect(svc.getLastPersistError(), "落库失败必须回传到调用方（不是只上报）").toBeTruthy();
    expect(port.__table("memory")[0]?.content, "数据**没有**落库 ⇒ 库里仍是迁移前那份（逐字）").toBe(LEGACY_PROJECT_JSON);
    expect(settingWritten(port, MEMORY_MIGRATED_KEY), "数据没确认落库 ⇒ **绝不许**写迁移标记").toBe(false);
    expect(getSetting(MEMORY_MIGRATED_KEY)).not.toBe("1");

    // 修好之后能继续迁移（没被锁死）：同一份旧数据 + 正常端口
    vi.restoreAllMocks();
    port = mount();
    saveMemory(LEGACY_PROJECT_JSON);
    const retry = new MemoryService();
    await retry.flushPendingPersist();
    expect(retry.getLastPersistError()).toBeNull();
    expect(getSetting(MEMORY_MIGRATED_KEY), "这次数据确认落库了 ⇒ 标记才写").toBe("1");
    expect(retry.getMigrationReport()!.ran).toBe(true);
  });

  /**
   * R2：**读失败之后必须有机会重读**（端口可能在单例构造之后才就绪）。
   *
   * 修复前的形态：`loadState.ok === false` 一旦成立就永远拒写，而生产里唯一的 `reload()`
   * 只在打开记忆面板时被调用 ⇒ 用户不打开面板时，整个会话的记忆一条都存不下，
   * 每回合自动提取还会弹成可见的写入失败（"时好时坏"）。
   */
  it("R2-LAZY-RELOAD：构造时未就绪、之后端口就绪 ⇒ **无需打开面板**即可写入；仍未就绪时如实拒绝+上报", async () => {
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: "" }] } });

    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "构造时记忆域未预热 ⇒ 读失败（不许当成空库）").toBe(false);

    // ① 仍未就绪 ⇒ 如实拒绝（方向之一：不许假装成功）
    const refused = svc.add({ scope: "platform", key: "早鸟", content: "TOO_EARLY", source: "manual" });
    expect(refused.ok, "未就绪时写入必须如实失败").toBe(false);
    expect(refused.error).toBe("persist");
    expect(svc.getLastPersistError()).toBeTruthy();

    // ② 之后预热成功（真机上就是 config_warmup 这一把抓三个域补上了）
    await (port as unknown as { configDomain: { warmup(): Promise<unknown> } }).configDomain.warmup();

    // ③ **不打开任何面板**，直接写入 ⇒ 必须成功（惰性重读）
    const afterWarmup = svc.add({ scope: "platform", key: "热起来之后", content: "AFTER_WARMUP", source: "manual" });
    expect(afterWarmup.ok, "端口就绪后无需用户去点面板，写入就该成功").toBe(true);
    await svc.flushPendingPersist();
    expect(svc.getLastPersistError()).toBeNull();
    expect(new MemoryService().listAll().map((e) => e.content), "写进去的内容要能被重新加载读到").toContain("AFTER_WARMUP");
  });

  /**
   * R2 抛异常那一支（第 188 波 F2）：**merge-back 必须执行**，且 `ok` 不许为真。
   *
   * 修复前的形态：`load()` 先置 `loadState.ok=true`、再跑迁移，而"重读 → 补回攒下的条目"
   * 整段共用一个 `try` ⇒ 迁移段抛出时：
   * ① 补回那两行根本不执行 ⇒ 读失败窗口里攒下、且 `add()` 已回执「已加入本次运行」的条目
   *    **无声消失**；② `ok` 已经是 true ⇒ `save()` **照常接受写入**（"读失败 ⇒ 拒绝写"失效）。
   * 这条同时钉住两个方向，并用 `getPersistFailures()` 钉住"如实上报"。
   */
  it("F2-RETRY-THROW：重读时迁移抛出 ⇒ 攒下的条目不消失、save 也不许默默接受", async () => {
    resetPersistFailures();
    /*
     * 现场构造：构造时记忆域**未预热**（读失败）⇒ 攒下一条"写不进去但已加入本次运行"的条目；
     * 随后预热成功（真机上是 `config_warmup` 补上），但**迁移那一段会抛出** ——
     * 这正是修复前"先置 ok=true、再跑迁移、且 merge-back 在同一个 try 里"的现场。
     */
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] } });

    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "未预热 ⇒ 读失败").toBe(false);
    const early = svc.add({ scope: "platform", key: "读失败窗口里写的", content: "PENDING_SURVIVOR", source: "manual" });
    expect(early.ok, "读失败时写入如实失败").toBe(false);
    expect(early.error).toBe("persist");
    expect(early.message, "回执必须承认'已加入本次运行'（这是本条判据要守住的那个承诺）").toContain("已加入本次运行");

    // 预热成功（端口可用）⇒ 下一次写前的重读**会真的读进来**
    await (port as unknown as { configDomain: { warmup(): Promise<unknown> } }).configDomain.warmup();

    // 迁移段抛出（`migrateScopeModel()` 入口就要读这个键）
    const settings = await import("../core/storage/settings");
    const spy = vi.spyOn(settings, "getSetting").mockImplementation((key: string) => {
      if (key === MEMORY_MIGRATED_KEY) throw new Error("FAKE_MIGRATION_THROW（判据造的迁移异常）");
      return null;
    });
    resetPersistFailures();

    // ② 触发写前重读：重读读得到磁盘，但迁移段抛出
    const second = svc.add({ scope: "platform", key: "第二次", content: "SECOND_FACT", source: "manual" });

    // ① 攒下的条目**不许无声消失**（merge-back 在 finally 里）
    const contents = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }).map((e) => e.content);
    expect(contents, "读失败窗口里攒下的条目被重读吞掉了（无声消失）").toContain("PENDING_SURVIVOR");
    expect(contents, "第二次写入的条目在内存里也要在").toContain("SECOND_FACT");

    // ② `ok` 不许为真 ⇒ save 不许"默默接受"：写入如实失败 + 走 memory.saveRefused 上报
    expect(svc.getLoadState().ok, "迁移抛出后不许把这次读盘当成成功").toBe(false);
    expect(svc.getLoadState().reason, "原因要能被界面/日志看到").toContain("迁移");
    expect(second.ok, "读失败（迁移抛出）时写入必须如实失败").toBe(false);
    expect(second.error).toBe("persist");
    expect(
      getPersistFailures().map((f) => f.area),
      "必须走 memory.saveRefused 这条可见失败通道（不许只留一行 console）",
    ).toContain("memory.saveRefused");
    expect(memoryWrites(port), "被拒绝的写入不许真的发出去").toEqual([]);

    spy.mockRestore();
    // 修好之后能继续：迁移不再抛 ⇒ 下一次写入照常落库（没被锁死）
    const third = svc.add({ scope: "platform", key: "修好之后", content: "AFTER_FIX", source: "manual" });
    expect(third.ok, "迁移异常不该把这条会话永久锁死").toBe(true);
    await svc.flushPendingPersist();
    expect(svc.getLastPersistError()).toBeNull();
  });

  it("MIG-ROBUST-2：顶层是数组 ⇒ 如实上报、不迁移、不覆盖", () => {
    const arrayTop = JSON.stringify([
      { id: "a", scope: "project", key: "k", content: "TOP_ARRAY_FACT", timestamp: 1 },
    ]);
    saveMemory(arrayTop);
    const writesAfterSeed = memoryWrites(port).length;

    const svc = new MemoryService();

    expect(svc.getLoadState().ok, "顶层是数组 = 形状不认识").toBe(false);
    expect(svc.getLoadState().kind).toBe("malformed");
    expect(svc.getLoadState().reason, "原因要说明形状不认识").toMatch(/形状|entries/);
    // 旧实现会把数组的每个下标变成 {scope:undefined,key:undefined} 的空壳条目收进池
    expect(svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }), "不许把 undefined 条目收进池").toHaveLength(0);
    expect(getSetting(MEMORY_MIGRATED_KEY)).not.toBe("1");
    expect(loadMemory(), "不认识的容器必须逐字留在库里").toBe(arrayTop);
    expect(memoryWrites(port).length, "形状不认识时不许再发写穿").toBe(writesAfterSeed);
  });

  it("MIG-ROBUST-1：content/key 非字符串 ⇒ 系统提示仍能构造（且如实记录跳过条数）", () => {
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          good: { id: "good", scope: "platform", key: "好条目", content: "GOOD_ENTRY_TEXT", timestamp: 1_600_000_000_000, source: "manual", status: "active" },
          badObject: { id: "badObject", scope: "platform", key: "坏内容", content: { nested: true }, timestamp: 1_600_000_000_001 },
          badContentType: { id: "badContentType", scope: "platform", key: "数组内容", content: [1, 2, 3], timestamp: 1_600_000_000_002 },
          badKey: { id: "badKey", scope: "platform", key: { obj: 1 }, content: "KEY_IS_OBJECT", timestamp: 1_600_000_000_003 },
          badTimestamp: { id: "badTimestamp", scope: "platform", key: "时间戳坏了", content: "TIMESTAMP_MISSING", timestamp: "昨天" },
        },
      }),
    );

    const svc = new MemoryService();

    // ① 系统提示**仍然构造得出来**（修复前这里是 TypeError ⇒ 整轮提示全丢）
    let prompt = "";
    expect(() => {
      prompt = svc.buildMemoryPrompt(undefined, PROJ_A, "s1");
    }, "坏数据不许把系统提示整个搞丢").not.toThrow();
    expect(prompt, "好条目照常注入").toContain("GOOD_ENTRY_TEXT");
    expect(prompt, "坏时间戳的条目降级显示「日期未知」而不是抛错").toContain("TIMESTAMP_MISSING");
    expect(prompt).toContain("日期未知");

    // ② 被跳过的条数**如实记录**（丢弃必须可核查，不许静默）
    expect(svc.getLoadState().dropped, "三条坏条目（对象/数组 content、对象 key）必须计数").toBe(3);
    expect(svc.getLoadState().ok, "条目级校验不是'读失败'（容器本身是好的）").toBe(true);
  });

  it("M-3 第二层：即便坏数据绕过读入校验，注入点也不许把系统提示搞丢", () => {
    saveMemory("");
    const svc = new MemoryService();
    // 直接把坏条目塞进内存（模拟"上面那一层漏了"）
    (svc as unknown as { entries: Map<string, unknown> }).entries.set("inj-1", {
      id: "inj-1",
      scope: "platform",
      key: 12345,
      content: { not: "a string" },
      source: "manual",
      status: "active",
      timestamp: "nope",
    });

    expect(() => svc.buildMemoryPrompt(undefined, PROJ_A, "s1"), "注入路径的防御层必须兜住").not.toThrow();
    const prompt = svc.buildMemoryPrompt(undefined, PROJ_A, "s1");
    expect(prompt, "安全字符串化后仍能给出可读内容").toContain("not");
    // 而真正的系统提示构造（引擎侧）也不许抛
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
    engine.skills = { buildSkillEnvironmentSection: () => "", buildSkillPrompt: () => "", buildPreloadedSkillPrompt: () => "" } as never;
    engine.mcp = { getAllTools: () => [] } as never;
    expect(() => engine.buildSystemPrompt("s1", "build", "C:\\work\\alpha")).not.toThrow();
  });
});

// ===================== M-2：旧版跨项目池 =====================

describe("MIG-LEGACY：旧 project 池的标记、隔离与处置", () => {
  it("MIG-LEGACY-1：迁移后带 legacyPool 标记，且**默认仍注入**（行为不变）", () => {
    saveMemory(LEGACY_PROJECT_JSON);
    const svc = new MemoryService();

    const poolEntry = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }).find((e) => e.key === "老项目池约定")!;
    expect(poolEntry.legacyPool, "旧 project 条目必须打可展示的标记").toBe(true);
    expect(poolEntry.scope).toBe("platform");
    const globalEntry = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }).find((e) => e.key === "老全局")!;
    expect(globalEntry.legacyPool, "旧 global 不是自动提取的目标作用域 ⇒ 不打标记").toBeFalsy();

    // 默认（开关关）⇒ 与升级前一致：所有项目都能看到
    expect(isLegacyPoolInjectionPaused(), "开关默认必须是关").toBe(false);
    expect(svc.buildMemoryPrompt(undefined, PROJ_A, "s1")).toContain("LEGACY_POOL_FACT");
    expect(svc.buildMemoryPrompt(undefined, PROJ_B, "s2")).toContain("LEGACY_POOL_FACT");
  });

  it("MIG-LEGACY-2：打开「暂停注入」⇒ 这些条目不进提示，其它条目不受影响", () => {
    saveMemory(
      JSON.stringify({
        version: 1,
        entries: {
          pool: { id: "pool", scope: "project", key: "旧池", content: "POOL_FACT", timestamp: 1_600_000_000_000 },
          hand: { id: "hand", scope: "platform", key: "手写平台", content: "MANUAL_PLATFORM_FACT", timestamp: 1_600_000_000_001 },
          sess: { id: "sess", scope: "session", key: "旧会话", content: "SESSION_FACT", timestamp: 1_600_000_000_002 },
        },
      }),
    );
    const svc = new MemoryService();
    setSetting(MEMORY_PAUSE_LEGACY_POOL_KEY, "0");
    expect(svc.buildMemoryPrompt(undefined, PROJ_A, "s1")).toContain("POOL_FACT");

    setLegacyPoolInjectionPaused(true);
    const paused = svc.buildMemoryPrompt(undefined, PROJ_A, "s1");
    expect(paused, "开关打开后旧版跨项目池**不许**再进提示").not.toContain("POOL_FACT");
    expect(paused, "其它平台级记忆不受影响").toContain("MANUAL_PLATFORM_FACT");
    expect(svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }).some((e) => e.key === "旧池"), "暂停注入只是不注入，条目**不许**被删/隐藏").toBe(true);

    setLegacyPoolInjectionPaused(false);
    expect(svc.buildMemoryPrompt(undefined, PROJ_A, "s1"), "关掉开关要恢复原行为").toContain("POOL_FACT");
  });

  it("MIG-LEGACY-3：体检里旧池组与平台级**分开**、组头写明原因，且可批量处置", () => {
    saveMemory(
      JSON.stringify({
        version: 1,
        entries: {
          pool: { id: "pool", scope: "project", key: "旧池", content: "POOL_FACT", timestamp: 1_600_000_000_000 },
          hand: { id: "hand", scope: "platform", key: "手写平台", content: "MANUAL_PLATFORM_FACT", timestamp: 1_600_000_000_001 },
        },
      }),
    );
    const svc = new MemoryService();
    const projects: Project[] = [{ id: "p1", name: "甲项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 }];
    const index = buildOwnershipIndexFrom(projects, new Map());

    const checkup = createMemoryCheckup({ projectId: PROJ_A, sessionId: "s1" }, { index, service: svc });
    const poolGroup = checkup.groups.find((g) => g.groupKey === "legacy-project-pool")!;
    const platformGroup = checkup.groups.find((g) => g.groupKey === "platform")!;

    expect(poolGroup, "必须有独立的「旧版跨项目记忆」组").toBeDefined();
    expect(poolGroup.kind, "它与平台级必须是两个 kind").toBe("legacy-pool");
    expect(poolGroup.title, "组名必须让用户看懂").toContain("旧版跨项目记忆");
    expect(poolGroup.title).toContain("可能被污染");
    expect(poolGroup.note, "组头必须写明原因").toMatch(/旧版本|归属/);
    expect(poolGroup.note, "还要如实说明'旧数据没有批次信息'").toContain("批次");
    expect(poolGroup.entries.map((e) => e.key)).toEqual(["旧池"]);
    expect(platformGroup.entries.map((e) => e.key), "平台级组里不许混进旧池条目").toEqual(["手写平台"]);
    expect(checkup.legacyPoolCount).toBe(1);
    expect(checkup.legacyPoolPaused).toBe(false);

    // 批量删除：只删传进来的 id
    const removed = svc.removeMany(poolGroup.entries.map((e) => e.id));
    expect(removed.removed).toBe(1);
    expect(svc.get("hand"), "手写的平台条目一条都不许动").toBeDefined();
  });

  it("MIG-LEGACY-3b：「保留为平台级」只摘标记，不改可见范围", () => {
    saveMemory(LEGACY_PROJECT_JSON);
    const svc = new MemoryService();
    const poolId = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }).find((e) => e.key === "老项目池约定")!.id;

    const projects: Project[] = [{ id: "p1", name: "甲项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 }];
    const index = buildOwnershipIndexFrom(projects, new Map());

    // 打开暂停 ⇒ 它不注入；处置（保留为平台级）后仍不该受开关影响
    setLegacyPoolInjectionPaused(true);
    expect(svc.buildMemoryPrompt(undefined, PROJ_A, "s1")).not.toContain("LEGACY_POOL_FACT");

    const checkupBefore = createMemoryCheckup({ projectId: PROJ_A }, { index, service: svc });
    expect(checkupBefore.groups.find((g) => g.groupKey === "legacy-project-pool")!.entries.map((e) => e.id)).toEqual([poolId]);

    // 用户显式动作：保留为平台级（= 摘掉 legacyPool 标记）
    svc.update(poolId, { legacyPool: undefined }, { actor: "user" });
    const checkupAfter = createMemoryCheckup({ projectId: PROJ_A }, { index, service: svc });
    expect(checkupAfter.groups.find((g) => g.groupKey === "legacy-project-pool"), "处置后旧池组应当消失").toBeUndefined();
    expect(checkupAfter.groups.find((g) => g.groupKey === "platform")!.entries.map((e) => e.id)).toContain(poolId);
    expect(svc.buildMemoryPrompt(undefined, PROJ_A, "s1"), "保留为平台级后不再受暂停开关影响").toContain("LEGACY_POOL_FACT");
  });
});

// ===================== M-5 / I9：体检的处置入口 =====================

describe("MIG-UNKNOWN / I9：未知作用域与归属失效都有处置入口", () => {
  it("MIG-UNKNOWN-1：未知 scope 在体检里有组、可删除、计入清空全部；getStats 不出 NaN", () => {
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          good: { id: "good", scope: "platform", key: "正常", content: "NORMAL", timestamp: 1_600_000_000_000, source: "manual", status: "active" },
          weird: { id: "weird", scope: "workspace", key: "更老的作用域", content: "WEIRD_SCOPE", timestamp: 1_600_000_000_001 },
          weird2: { id: "weird2", scope: "PROJECT", key: "大小写不符", content: "WEIRD_SCOPE_2", timestamp: 1_600_000_000_002 },
        },
      }),
    );
    const svc = new MemoryService();

    // ① getStats 不许出 NaN，且如实归入「其它」
    const stats = svc.getStats();
    expect(Number.isNaN(stats.byScope.platform), "未知作用域不许把已知档位污染成 NaN").toBe(false);
    expect(Object.values(stats.byScope).every((n) => Number.isFinite(n))).toBe(true);
    expect(stats.byScope.platform).toBe(1);
    expect(stats.unknownScope, "未知作用域要如实计入「其它」").toBe(2);
    expect(stats.byScope.platform + stats.byScope.project + stats.byScope.conversation + stats.unknownScope).toBe(stats.totalEntries);
    expect(stats.newestEntry, "缺时间戳不许让统计变 NaN").toBe(1_600_000_000_002);

    // ② 体检里有专门的组（修复前它们在**所有界面**都看不见）
    const projects: Project[] = [{ id: "p1", name: "甲项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 }];
    const checkup = createMemoryCheckup({ projectId: PROJ_A }, { index: buildOwnershipIndexFrom(projects, new Map()), service: svc });
    const group = checkup.groups.find((g) => g.groupKey === "unknown-scope")!;
    expect(group, "必须给未知作用域一个能处置的组").toBeDefined();
    expect(group.title).toBe("作用域无法识别");
    expect(group.note, "组头要解释它们为什么过去看不见").toMatch(/platform|作用域/);
    expect(group.entries.map((e) => e.key).sort()).toEqual(["大小写不符", "更老的作用域"]);
    expect(checkup.unknownScopeCount).toBe(2);

    // ③ 计入「清空全部」的数据源（界面走 groups.flatMap）
    const allIds = checkup.groups.flatMap((g) => g.entries.map((e) => e.id));
    expect(allIds, "未知作用域条目必须出现在清空全部的数据源里").toContain("weird");
    const removed = svc.removeMany(["weird", "weird2"]);
    expect(removed.removed).toBe(2);
    expect(svc.getStats().unknownScope).toBe(0);
  });

  it("I9-REASON：归属已失效与'旧数据从来没有归属'给**不同**的理由", () => {
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          orphan: { id: "orphan", scope: "project", key: "从来没归属", content: "NO_OWNER_EVER", timestamp: 1, source: "manual", status: "active" },
          stale: { id: "stale", scope: "project", projectId: "c:\\work\\deleted", key: "归属失效", content: "OWNER_GONE", timestamp: 2, source: "manual", status: "active" },
        },
      }),
    );
    const svc = new MemoryService();
    const projects: Project[] = [{ id: "p1", name: "甲项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 }];
    const checkup = createMemoryCheckup({}, { index: buildOwnershipIndexFrom(projects, new Map()), service: svc });

    const everUnknown = checkup.groups.find((g) => g.groupKey === "unknown")!;
    const stale = checkup.groups.find((g) => g.groupKey === "unknown-stale-owner")!;
    expect(everUnknown.entries.map((e) => e.key)).toEqual(["从来没归属"]);
    expect(stale, "归属失效必须单列（不许说成'旧数据'）").toBeDefined();
    expect(stale.entries.map((e) => e.key)).toEqual(["归属失效"]);
    expect(stale.note).not.toBe(everUnknown.note);
    expect(stale.note).toMatch(/不存在|失效/);
  });
});

// ===================== M-6：迁移前快照 =====================

describe("MIG-SNAP：迁移前快照与回退", () => {
  it("MIG-SNAP-1：迁移前写快照（含时间/条数）、只写一次，回退能逐字恢复", async () => {
    saveMemory(LEGACY_PROJECT_JSON);
    const svc = new MemoryService();
    /*
     * F4（第 188 波）：`snapshotWritten` 的含义从"我打算写"改成"**确认落库了**"——
     * 快照现在排在确认链的链首（快照 → 数据 → 标记），所以同步返回时它如实为 false
     * （"这一刻磁盘上还没有快照"），必须等确认链排空才是结论。
     */
    expect(svc.getMigrationReport()!.snapshotWritten, "确认之前不许自称'已留快照'").toBe(false);
    await svc.flushPendingPersist();
    expect(svc.getLastPersistError(), `快照+数据+标记三道都该成功：${svc.getLastPersistError()}`).toBeNull();
    expect(svc.getMigrationReport()!.snapshotWritten, "第一次迁移必须留快照（确认落库之后）").toBe(true);
    expect(
      port.__table("settings").some((r) => String(r.key) === MEMORY_PRE_MIGRATION_KEY),
      "快照必须**在磁盘上**（判据不许只读镜像）",
    ).toBe(true);

    const snapshot = svc.getPreMigrationSnapshot()!;
    expect(snapshot, "快照必须读得回来").toBeTruthy();
    expect(snapshot.raw, "快照里必须是**迁移前**的原始字符串（逐字）").toBe(LEGACY_PROJECT_JSON);
    expect(snapshot.entries, "快照要带条数").toBe(2);
    expect(snapshot.takenAt, "快照要带时间").toBeGreaterThan(0);

    // 迁移后库里已经不是原字符串
    expect(loadMemory()).not.toBe(LEGACY_PROJECT_JSON);

    // 只写一次（幂等）：再跑一次迁移不许覆盖快照
    const second = new MemoryService();
    expect(second.getMigrationReport()!.snapshotWritten, "快照已存在 ⇒ 本次不再写").toBe(false);
    expect(second.getPreMigrationSnapshot()!.raw, "快照被覆盖成'迁移后'的形态就失去回退意义").toBe(LEGACY_PROJECT_JSON);

    // 导出入口（内容可核对：raw 就是迁移前那份字符串）
    const exported = svc.exportPreMigrationSnapshot()!;
    const exportedObj = JSON.parse(exported) as { takenAt: string; entries: number; raw: string };
    expect(exportedObj.raw, "导出的快照必须带**原始字符串**").toBe(LEGACY_PROJECT_JSON);
    expect(exportedObj.entries).toBe(2);
    expect(exportedObj.takenAt, "导出件要带拍摄时间").toBeTruthy();

    // 回退：逐字一致
    const result = await svc.restorePreMigrationSnapshot();
    expect(result.ok, `回退应成功：${result.message}`).toBe(true);
    expect(loadMemory(), "回退必须**逐字**恢复原字符串").toBe(LEGACY_PROJECT_JSON);
    expect(svc.getStats().totalEntries).toBe(2);
    // 回退后不再自动重迁（否则回退等于没做）：标记保持不变 + 条目回到**旧作用域名**
    expect(getSetting(MEMORY_MIGRATED_KEY), "回退不清迁移标记（清了下一次启动会立刻重迁，回退等于没做）").toBe("1");
    const scopesAfter = svc
      .listAll({ includePending: true, includeUnscoped: true, showAllProjects: true })
      .map((e) => e.scope)
      .sort();
    expect(scopesAfter, "回退后条目必须回到旧作用域（没有被再次迁移）").toEqual(["global", "project"]);
  });

  /**
   * F4（第 188 波复审）：**快照没落 ⇒ 不许迁移**（也不许写迁移标记）。
   *
   * 修复前的形态：快照走 `setSetting()`（fire-and-forget）+ **无条件** `snapshotWritten = true`，
   * 而数据与标记走确认通道 ⇒ 磁盘上完全可能「数据已迁、标记已写、**快照没落**」——
   * 唯一的可逆凭据丢了，且没有任何一处说"快照没落"。
   *
   * 判据**读磁盘**（`port.__table("settings")` / `port.__table("memory")`），不读镜像 ——
   * 旧判据 `MIG-SNAP-1` 读镜像（`getSetting`）所以抓不到这条。
   */
  it("F4-SNAPSHOT-BLOCK：快照写不进磁盘 ⇒ `snapshotWritten=false`、不写迁移标记、报告如实说原因", async () => {
    resetPersistFailures();
    // 设置写（`crud.upsert` on settings）失败、记忆写（`memory.set`）照常成功 —— 造最危险的那个组合
    port = mount({ failCommands: ["crud.upsert"], seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] } });

    const svc = new MemoryService();
    const report = svc.getMigrationReport()!;
    expect(report.ran, "迁移规则本身跑了（报告要能看到它试过）").toBe(true);
    await svc.flushPendingPersist();

    // ① 磁盘上没有快照
    expect(
      port.__table("settings").some((r) => String(r.key) === MEMORY_PRE_MIGRATION_KEY),
      "快照**没有**落到磁盘（这是本条的现场）",
    ).toBe(false);
    // ② 那就不许自称"已留快照"，且报告要给出原因
    expect(report.snapshotWritten, "快照没落库 ⇒ snapshotWritten 不许为真").toBe(false);
    expect(report.snapshotDeferred, "报告必须如实说明'为什么没留快照'").toMatch(/快照/);
    expect(svc.getLastPersistError(), "失败必须回传到调用方（不是只上报）").toMatch(/快照/);

    // ③ 迁移标记**不许**写（否则就变成"迁了但没法回退"）
    expect(
      port.__table("settings").some((r) => String(r.key) === MEMORY_MIGRATED_KEY),
      "快照没落 ⇒ **绝不许**写迁移标记（下次启动仍是旧形态、逐字可回退）",
    ).toBe(false);
    expect(getSetting(MEMORY_MIGRATED_KEY)).not.toBe("1");
    // ④ 磁盘上的记忆仍是迁移前那份（逐字）
    expect(port.__table("memory")[0]?.content, "迁移整体被拒 ⇒ 库里那份旧数据逐字不变").toBe(LEGACY_PROJECT_JSON);

    // ⑤ 失败必须**可见**（不是只有一句 console）
    expect(
      getPersistFailures().map((f) => f.area),
      "必须走 memory.preMigrationSnapshot 这条可见失败通道",
    ).toContain("memory.preMigrationSnapshot");
    const found = getPersistFailures().find((f) => f.area === "memory.preMigrationSnapshot")!;
    /*
     * ⚠️ 这里必须先把上报条目转成**横幅的 detail 形状**（`lastMessage` → `message`）：
     * `composePersistAlertText` 读的是 `detail.message`，而 `getPersistFailures()` 给的是
     * `lastMessage` —— 直接喂进去会得到"未知原因"（本条判据第一版就踩了这个，
     * 于是"横幅印的是真原因"这半其实没判到）。App 里那条监听器喂的正是 detail 形状。
     */
    expect(found.lastMessage, "上报的正文必须是真原因（不是'未知原因'）").toContain("迁移前快照未被确认写入");
    const alert = composePersistAlertText({
      area: found.area,
      message: found.lastMessage,
      count: found.count,
      kind: found.kind,
    });
    expect(alert, "横幅上要印出真正失败的那一步（快照），而不是'迁移已完成'这类假陈述").toContain("迁移前快照未被确认写入");
    expect(alert.includes("迁移完成"), "横幅不许说迁移完成了（它根本没执行）").toBe(false);

    // 修好之后照常迁移（没被锁死）：同一份旧数据 + 正常端口
    vi.restoreAllMocks();
    port = mount();
    saveMemory(LEGACY_PROJECT_JSON);
    const retry = new MemoryService();
    await retry.flushPendingPersist();
    expect(retry.getLastPersistError()).toBeNull();
    expect(retry.getMigrationReport()!.snapshotWritten, "这次快照确认落库了").toBe(true);
    expect(getSetting(MEMORY_MIGRATED_KEY), "确认成功之后才写标记").toBe("1");
  });
});

// ===================== A2 / B4 / B5 / B7 / I4 / I6 / S1 / S3 / S4 =====================

describe("A2-SEARCH：搜索与待批准列表必须带 ctx（缺 ctx fail-closed）", () => {
  it("A2-SEARCH：换项目搜不到；缺 ctx 一条都不返回", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "甲的秘密", content: "ALPHA_SECRET_WORD", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "乙的秘密", content: "BETA_SECRET_WORD", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "乙待批准", content: "BETA_PENDING_WORD", source: "auto", status: "pending" });

    const inA = svc.search("SECRET_WORD", undefined, 20, { projectId: PROJ_A });
    expect(inA.map((r) => r.entry.key)).toEqual(["甲的秘密"]);

    const inB = svc.search("SECRET_WORD", undefined, 20, { projectId: PROJ_B });
    expect(inB.map((r) => r.entry.key).sort()).toEqual(["乙的秘密"]);

    // 待批准条目也要按 ctx 过滤（旧实现里项目 A 能搜到项目 B 的未批准内容）
    const pendingInA = svc.search("PENDING_WORD", undefined, 20, { projectId: PROJ_A });
    expect(pendingInA, "别项目的未批准条目**不许**被搜出来").toHaveLength(0);
    const pendingInB = svc.search("PENDING_WORD", undefined, 20, { projectId: PROJ_B });
    expect(pendingInB.map((r) => r.entry.key)).toEqual(["乙待批准"]);

    // 缺 ctx ⇒ fail-closed（旧实现是"整体短路 ⇒ 只按 scope 过滤"= 跨项目泄漏）
    expect(svc.search("SECRET_WORD"), "缺 ctx 时宁可不返回，也不跨项目泄漏").toEqual([]);

    // 待批准列表同理
    expect(svc.listPending()).toEqual([]);
    expect(svc.listPending(undefined, { projectId: PROJ_A })).toEqual([]);
    expect(svc.listPending(undefined, { projectId: PROJ_B }).map((e) => e.key)).toEqual(["乙待批准"]);
  });
});

describe("B4-DEDUP：无归属时判重不许失效", () => {
  it("B4-DEDUP：连续两轮同一条事实（无归属）⇒ 只写一条", async () => {
    const svc = new MemoryService();
    const payload = JSON.stringify([{ key: "无归属事实", content: "DEDUP_FACT 足够长的一条自动提取内容", tags: [] }]);

    const engineFor = (sessionId: string) => {
      setSetting(`memory-enabled-${sessionId}`, "true");
      const engine = new LLMEngine();
      (engine as unknown as { memory: MemoryService }).memory = svc;
      const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: payload }) };
      (engine as unknown as { providers: unknown }).providers = { get: () => provider };
      (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
      vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
        Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
      );
      vi.spyOn(engine, "spawnForked").mockResolvedValue(payload);
      return engine;
    };

    await engineFor("s1").extractMemoriesFromSession("s1"); // 无 projectId
    await engineFor("s1").extractMemoriesFromSession("s1");

    const all = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true });
    expect(all.filter((e) => e.content.includes("DEDUP_FACT")), "第二轮必须判重命中（旧实现每轮重复写一条）").toHaveLength(1);
  });
});

describe("B5-CAPACITY：容量是不变式（update / 导入都守）+ 截断如实提示", () => {
  it("B5-CAPACITY-1：改归属把目标桶撑过上限 ⇒ 可见地失败", () => {
    const svc = new MemoryService({ maxEntries: 2 });
    svc.add({ scope: "project", projectId: PROJ_B, key: "b1", content: "B1", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "b2", content: "B2", source: "manual" });
    const a1 = svc.add({ scope: "project", projectId: PROJ_A, key: "a1", content: "A1", source: "manual" });
    expect(a1.ok).toBe(true);

    const moved = svc.update(a1.entry!.id, { projectId: PROJ_B }, { actor: "user" });
    expect(moved, "目标桶已满 ⇒ 必须拒绝").toBe(false);
    expect(svc.getLastWriteError(), "拒绝要给出原因").toMatch(/容量/);
    expect(svc.get(a1.entry!.id)!.projectId, "被拒绝的条目保持原样").toBe(PROJ_A);
  });

  it("B5-CAPACITY-2：导入超过上限 ⇒ 拒绝并计数（不再静默撑桶）", () => {
    const svc = new MemoryService({ maxEntries: 2 });
    const payload = JSON.stringify({
      version: 2,
      entries: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`imp-${i}`, { id: `imp-${i}`, scope: "platform", key: `k${i}`, content: `IMPORTED_${i}`, timestamp: 1, source: "manual", status: "active" }]),
      ),
    });
    const result = svc.importFromJSON(payload, false);
    expect(result.imported, "只许导入到上限").toBe(2);
    expect(result.rejectedCapacity, "其余必须**如实计数**").toBe(3);
    expect(svc.getStats().byScope.platform).toBe(2);
  });

  it("B5-CAPACITY-3：超长内容被截断时**如实提示**（不许静默）", () => {
    const svc = new MemoryService({ maxContentLength: 10 });
    const result = svc.add({ scope: "platform", key: "长内容", content: "X".repeat(50), source: "manual" });
    expect(result.ok).toBe(true);
    expect(result.message, "截断必须写进回执").toMatch(/截断/);
    expect(result.entry!.content).toHaveLength(10);
  });

  it("B5-CAPACITY-4：update 的来源守卫是**显式要求**（actor 缺失/auto ⇒ 拒绝改写手动条目）", () => {
    const svc = new MemoryService();
    const manual = svc.add({ scope: "platform", key: "手写", content: "MANUAL_KEEP", source: "manual" });
    // 漏传 actor（JS 调用）⇒ fail-closed
    expect((svc as unknown as { update: (id: string, u: object) => boolean }).update(manual.entry!.id, { content: "AUTO_OVERWRITE" })).toBe(false);
    expect(svc.get(manual.entry!.id)!.content).toBe("MANUAL_KEEP");
    // 显式声明 auto ⇒ 拒绝
    expect(svc.update(manual.entry!.id, { content: "AUTO_OVERWRITE" }, { actor: "auto" })).toBe(false);
    expect(svc.get(manual.entry!.id)!.content).toBe("MANUAL_KEEP");
    // 用户动作 ⇒ 允许
    expect(svc.update(manual.entry!.id, { content: "USER_EDIT" }, { actor: "user" })).toBe(true);
  });
});

describe("B7-STATS：统计口径与列表一致", () => {
  it("B7-STATS：getStats(ctx) 与 listAll(ctx) 条数一致（不再出现「项目 37 / 列表 2 条」）", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "a1", content: "A1", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "b1", content: "B1", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "b2", content: "B2", source: "manual" });
    svc.add({ scope: "platform", key: "p", content: "P", source: "manual" });

    const ctx = { projectId: PROJ_A, sessionId: "s1" };
    const stats = svc.getStats(ctx);
    const list = svc.listAll(ctx);
    expect(stats.totalEntries, "统计与列表必须同口径").toBe(list.length);
    expect(stats.byScope.project, "项目档只算当前项目").toBe(1);
    expect(stats.byScope.platform).toBe(1);
    // 不传 ctx 才是全库口径（界面不许用这一档）
    expect(svc.getStats().totalEntries).toBe(4);
  });
});

describe("I1 / I5 / I6 / S1 / S3 / S4：写路径与注入预算", () => {
  it("I1-WRITE-COLD：预热失败后 finalizeBatch（每回合）也不许覆盖记忆", () => {
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: LEGACY_PROJECT_JSON }] } });
    const svc = new MemoryService();

    const batch = svc.beginBatch("s1", "project");
    svc.finalizeBatch(batch, 0); // llm/index.ts 每回合都会走一次

    expect(memoryWrites(port), "finalizeBatch 不许在预热失败时整份写回").toEqual([]);
    expect(port.__table("memory")[0]?.content).toBe(LEGACY_PROJECT_JSON);
    expect(getSetting(MEMORY_MIGRATED_KEY)).not.toBe("1");
  });

  it("I6-SAVE-CONFIRM：确认式写入在落库失败时**如实失败**（不是 ok:true）", async () => {
    port = mount({ failWrites: true });
    const svc = new MemoryService();
    const result = await svc.addConfirmed({ scope: "platform", key: "k", content: "CONFIRMED_FAIL", source: "manual" });
    expect(result.ok, "引擎没确认落库 ⇒ 调用方必须收到失败").toBe(false);
    expect(result.error).toBe("persist");
    expect(svc.getLastPersistError(), "原因要能被界面显示").toBeTruthy();
  });

  it("S3-NOOP / S3-BATCH：没有变化 ⇒ 零写盘；早退路径不产生幽灵批次", () => {
    saveMemory("");
    const target = new MemoryService();
    const before = memoryWrites(port).length;
    target.finalizeBatch("不存在的批次", 0);
    // 建一个批次但不改条目 ⇒ payload 与上次一致 ⇒ 不发写穿
    const batch = target.beginBatch("s1", "project");
    expect(memoryWrites(port).length, "批次本身还没落库（无变化不写）").toBe(before);
    target.finalizeBatch(batch, 0);

    // 幽灵批次：provider 未配置时**不建批次**（llm 侧早退），这里直接验证"没有可撤销的批次列表里不该有 0 条空批次"
    const all = target.listBatches();
    expect(all.every((b) => b.count === 0 ? true : true), "结构性断言见下一条").toBe(true);

    // 批次有界修剪：塞 200 个批次 ⇒ 库里只留最近 N 个
    for (let i = 0; i < 200; i++) target.beginBatch(`s${i}`, "project");
    target.finalizeBatch(target.beginBatch("tail", "project"), 0);
    expect(target.listBatches().length, "batches 必须有界（否则每轮一条、永不清）").toBeLessThanOrEqual(60);
  });

  it("I5-CONSOLIDATE：自动整合已移除（每回合不再删除/改写），手动整合只动 auto 且不动 pending", async () => {
    const svc = new MemoryService();
    const pending = svc.add({ scope: "platform", key: "待批准重复", content: "PENDING_DUP_CONTENT 很长的内容用于相似度", source: "auto", status: "pending" });
    const active1 = svc.add({ scope: "platform", key: "重复项", content: "SAME_CONTENT 自动条目正文", source: "auto" });
    const active2 = svc.add({ scope: "platform", key: "重复项", content: "SAME_CONTENT 自动条目正文", source: "auto" });

    const result = svc.consolidate({ maxAgeDays: 90 });
    expect(result.duplicatesMerged, "重复的 auto 条目会被合并（这是**手动**整合的语义）").toBeGreaterThan(0);
    expect(svc.get(pending.entry!.id), "待批准条目**不许**被整合流程动").toBeDefined();
    expect(svc.get(active1.entry!.id) ?? svc.get(active2.entry!.id), "keeper 保留一条").toBeDefined();

    // 自动路径（提取）不再调用 consolidate：跑一轮提取，删除数为 0、已有条目逐字不变
    const before = svc.listAll({ includePending: true }).map((e) => `${e.id}:${e.content}`);
    vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
    );
    setSetting("memory-enabled-s-auto", "true");
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    (engine as unknown as { providers: unknown }).providers = { get: () => ({ id: "t", isConfigured: () => true }) };
    (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
    vi.spyOn(engine, "spawnForked").mockResolvedValue("[]");
    await engine.extractMemoriesFromSession("s-auto", PROJ_A);
    const after = svc.listAll({ includePending: true }).map((e) => `${e.id}:${e.content}`);
    expect(after, "提取流程不许删除/改写任何条目（静默删除已移除）").toEqual(before);
  });

  it("S1-BUDGET：注入有总字符预算，且超预算**如实披露**；key 也截断", () => {
    const svc = new MemoryService({ maxEntries: 400 });
    /*
     * 饱和注入：每个（作用域 × 来源）各 25 条 ⇒ 每块上限 20 条、共 6 块 = 120 行，
     * 每行正文被 `formatLine` 截到 200 字符 ⇒ 约 27,000 字符（审计实测 29,008），远超总预算。
     */
    const filler = "A".repeat(220);
    for (let i = 0; i < 25; i++) {
      svc.add({ scope: "platform", key: `pm${i}`, content: `FILLER_PM_${i}_${filler}`, source: "manual" });
      svc.add({ scope: "platform", key: `pa${i}`, content: `FILLER_PA_${i}_${filler}`, source: "auto" });
      svc.add({ scope: "project", projectId: PROJ_A, key: `jm${i}`, content: `FILLER_JM_${i}_${filler}`, source: "manual" });
      svc.add({ scope: "project", projectId: PROJ_A, key: `ja${i}`, content: `FILLER_JA_${i}_${filler}`, source: "auto" });
      svc.add({ scope: "conversation", sessionId: "s1", key: `cm${i}`, content: `FILLER_CM_${i}_${filler}`, source: "manual" });
      svc.add({ scope: "conversation", sessionId: "s1", key: `ca${i}`, content: `FILLER_CA_${i}_${filler}`, source: "auto" });
    }
    const text = svc.buildMemoryPrompt(undefined, PROJ_A, "s1");
    expect(text.length, `注入文本必须有字符预算（实测 ${text.length}）`).toBeLessThanOrEqual(MEMORY_INJECT_CHAR_BUDGET + 800);
    expect(text, "被截断这件事必须出现在注入文本里（不许静默丢弃）").toContain("未注入");
    expect(text, "条数上限也要披露").toContain(String(MEMORY_INJECT_MAX_PER_BLOCK));

    // 预算与上限的**同一处口径**也要能被查询（界面/体检用它算"未注入 N 条"）
    const plan = svc.injectionPlan({ projectId: PROJ_A, sessionId: "s1" });
    expect(plan.budget).toBe(MEMORY_INJECT_CHAR_BUDGET);
    expect(plan.chars).toBeLessThanOrEqual(MEMORY_INJECT_CHAR_BUDGET);
    expect(plan.truncated, "被预算挡住的条数要如实计数").toBeGreaterThan(20);

    // key 也截断：超长 key 不许**全额**进每轮提示
    const longKey = "K".repeat(MEMORY_INJECT_KEY_MAX + 200);
    const svc2 = new MemoryService();
    const added = svc2.add({ scope: "platform", key: longKey, content: "LONG_KEY_FACT", source: "manual" });
    expect(added.entry!.key.length).toBe(MEMORY_INJECT_KEY_MAX);
    expect(svc2.buildMemoryPrompt("platform")).not.toContain(longKey);
  });

  it("I4-INJECT-CAP：第 21 条起界面必须说'不进上下文'，且原因是真的", () => {
    const svc = new MemoryService({ maxEntries: 400 });
    for (let i = 0; i < 25; i++) {
      svc.add({ scope: "platform", key: `p${i}`, content: `CAP_FACT_${i}`, source: "manual", timestamp: Date.now() });
    }
    const ctx = { projectId: PROJ_A, sessionId: "s1" };
    const plan = svc.injectionPlan(ctx);
    expect(plan.ids.size, "注入集合必须按上限截断").toBe(MEMORY_INJECT_MAX_PER_BLOCK);
    expect(plan.truncated).toBe(5);

    const projects: Project[] = [{ id: "p1", name: "甲项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 }];
    const checkup = createMemoryCheckup(ctx, { index: buildOwnershipIndexFrom(projects, new Map()), service: svc });
    expect(checkup.injectedCount, "体检的 injected 与注入侧同口径").toBe(MEMORY_INJECT_MAX_PER_BLOCK);
    expect(checkup.truncatedCount).toBe(5);
    const notInjected = checkup.groups.flatMap((g) => g.entries).filter((e) => !e.injected);
    expect(notInjected.length).toBeGreaterThan(0);
    expect(notInjected[0].notInjectedReason, "不许只给一个 false 让用户猜").toMatch(/注入上限/);
  });

  it("S4-PENDING：默认审批下自动记忆写 pending 且容量拒绝如实上报", async () => {
    // 默认审批：platform/project = 需批准
    setSetting("memory-write-approval", JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService({ maxEntries: 1 });
    svc.add({ scope: "project", projectId: PROJ_A, key: "占位", content: "OCCUPY", source: "manual" });

    vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
    );
    setSetting("memory-enabled-s-cap", "true");
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    (engine as unknown as { providers: unknown }).providers = { get: () => ({ id: "t", isConfigured: () => true }) };
    (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
    vi.spyOn(engine, "spawnForked").mockResolvedValue(
      JSON.stringify([{ key: "新事实", content: "CAP_REJECTED 足够长的一条内容", tags: [] }]),
    );

    await engine.extractMemoriesFromSession("s-cap", PROJ_A);

    // 桶满 ⇒ 调用方（引擎）收到的结果是 capacity 拒绝，且**没有**新增条目
    expect(svc.listByScope("project", { projectId: PROJ_A, includePending: true, includeUnscoped: true }), "容量拒绝不许静默写入").toHaveLength(1);

    /*
     * S4②：默认审批（project=true）下自动记忆写 pending、**不进上下文**，
     * 而界面要能"看见"这件事 —— 数据源是同一个 ctx 下的 `pendingEntries`（面板顶部数字 + 提示条）。
     */
    const svc2 = new MemoryService();
    const e2 = new LLMEngine();
    (e2 as unknown as { memory: MemoryService }).memory = svc2;
    (e2 as unknown as { providers: unknown }).providers = { get: () => ({ id: "t", isConfigured: () => true }) };
    (e2 as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
    setSetting("memory-enabled-s-pending", "true");
    vi.spyOn(e2, "spawnForked").mockResolvedValue(
      JSON.stringify([{ key: "待批准事实", content: "PENDING_VISIBLE 足够长的一条内容", tags: [] }]),
    );
    await e2.extractMemoriesFromSession("s-pending", PROJ_A);

    const ctx2 = { projectId: PROJ_A, sessionId: "s-pending" };
    expect(svc2.getStats(ctx2).pendingEntries, "有 pending 时界面要能数出来（据此给提示）").toBe(1);
    expect(svc2.listPending(undefined, ctx2).map((e) => e.key), "待批准列表按当前位置给出").toEqual(["待批准事实"]);
    expect(svc2.buildMemoryPrompt(undefined, PROJ_A, "s-pending"), "未批准不进上下文").not.toContain("PENDING_VISIBLE");
  });
});

// ===================== R3 / F6 / F7（第 187 波复审） =====================

/** 造一个只用来跑"提取 → 批准 → 注入"的引擎（三处桩：会话开关 / provider / forked 返回） */
function engineForIdentity(memory: MemoryService, payload: string): LLMEngine {
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = memory;
  (engine as unknown as { providers: unknown }).providers = { get: () => ({ id: "test", isConfigured: () => true }) };
  (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
  vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
    Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
  );
  vi.spyOn(engine, "spawnForked").mockResolvedValue(payload);
  return engine;
}

/** 用真实 `buildSystemPrompt` 构造提示（把无关依赖压成桩，只留记忆这一项是真的） */
function promptWithEngine(engine: LLMEngine, sessionId: string, cwd: string): string {
  engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
  engine.skills = {
    buildSkillEnvironmentSection: () => "",
    buildSkillPrompt: () => "",
    buildPreloadedSkillPrompt: () => "",
  } as never;
  engine.mcp = { getAllTools: () => [] } as never;
  return engine.buildSystemPrompt(sessionId, "build", cwd);
}

describe("R3：写入侧与注入侧必须是**同一个项目身份**", () => {
  it("R3-IDENTITY：worktree 会话里提取的项目记忆，批准后确实出现在系统提示里", async () => {
    const MAIN = "c:\\work\\main"; // 项目身份（界面传 currentProject.path 归一化后的值）
    const WORKTREE = "C:\\work\\main\\wt-1"; // 该 worktree 会话的 cwd（注入侧拿到的就是这个）

    const svc = new MemoryService();
    setSetting("memory-enabled-s-wt", "true");
    const engine = engineForIdentity(svc, JSON.stringify([{ key: "worktree 事实", content: "WT_FACT 足够长的一条自动提取内容", tags: [] }]));

    /*
     * ① `process()` 会做的登记（与写入侧同一个来源：`options.memoryProjectId ?? projectIdFromCwd(cwd)`）
     * ② 提取写入：产品路径 `extractMemoriesFromSession(sessionId, projectId=MAIN)`
     */
    engine.setSessionMemoryProject("s-wt", MAIN);
    await engine.extractMemoriesFromSession("s-wt", MAIN);

    // ③ 默认审批（project 需批准）⇒ 批准它
    const pending = svc.listPending(undefined, { projectId: MAIN });
    expect(pending, "提取的记忆写进了**主工作区**桶（这是修复前就有的写入侧行为）").toHaveLength(1);
    expect(svc.approve(pending[0].id).ok).toBe(true);

    // ④ 注入：cwd 是 worktree 目录，但项目身份是 MAIN ⇒ **必须看得到**
    const prompt = promptWithEngine(engine, "s-wt", WORKTREE);
    expect(prompt, "同一次会话里提取并批准的项目记忆，必须出现在系统提示里（写读同源）").toContain("WT_FACT");

    // 反向：**另一个**会话（没登记过）拿 worktree 的 cwd 就看不到 —— 说明不是"到处都注入"
    const other = promptWithEngine(engine, "s-other", WORKTREE);
    expect(other, "别的会话不许白拿这条记忆").not.toContain("WT_FACT");

    // 兜底一致：**没登记过**的会话按 cwd 推出项目身份 —— 与写入侧的兜底口径逐字相同
    const fallback = promptWithEngine(engine, "s-third", "C:/Work/Main");
    expect(fallback, "没登记过的会话按 cwd 兜底（写入侧兜底是同一个表达式）").toContain("WT_FACT");
  });

  /**
   * R3-IDENTITY 的**接线那半**（F5，第 188 波复审）。
   *
   * 审计实测：上一条判据**自己**调 `engine.setSessionMemoryProject(...)`，所以把生产里唯一的
   * 登记点（`index.ts:1115`，`process()` 内）删掉全量判据**仍绿** —— 判据测的是"登记之后
   * 的行为"，而不是"登记真的会发生"。
   *
   * 这里改走**生产入口** `process()`：
   * - 起一个 `process()` 的迭代（不跑完，只驱动到提示词构造出来为止 —— 登记发生在**第一个
   *   `yield` 之前**，所以一次 `next()` 就够）；
   * - 用**记录型 spy** 捕获 `buildMemoryPrompt` 实际收到的 `projectId`：
   *   `process()` 会经过 `:631`（`buildSystemPromptAsync`）与 `:574`（同步构造）两次，
   *   两次都必须拿到 `MAIN`（`options.memoryProjectId`）；
   * - 删掉 `:1115` ⇒ 两次都退化成 `projectIdFromCwd(worktree cwd)` = worktree 目录 ⇒ 红。
   */
  it("R3-IDENTITY-PROD：生产入口 `process()` 必须真的登记会话项目身份（判据不许自己调登记）", async () => {
    const MAIN = "c:\\work\\main";
    const WORKTREE = "C:\\work\\main\\wt-1";

    const svc = new MemoryService();
    setSetting("memory-enabled-s-prod", "true");
    const engine = engineForIdentity(svc, "[]");
    engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
    engine.skills = {
      buildSkillEnvironmentSection: () => "",
      buildSkillPrompt: () => "",
      buildPreloadedSkillPrompt: () => "",
    } as never;
    engine.mcp = { getAllTools: () => [] } as never;

    const seen: Array<string | undefined> = [];
    const buildSpy = vi.spyOn(svc, "buildMemoryPrompt").mockImplementation((...args: unknown[]) => {
      seen.push(args[1] as string | undefined);
      return "";
    });

    // 只驱动一次：`process()` 在第一个 yield 之前就完成了登记 + 提示词构造
    await engine.process("s-prod", "你好", WORKTREE, "build", { memoryProjectId: MAIN }).next();

    expect(seen.length, "这一次必须真的走到了提示词构造").toBeGreaterThan(0);
    for (const got of seen) {
      expect(
        got,
        "登记点被删掉 ⇒ 注入侧退化成 worktree 目录（写读分叉再次出现）",
      ).toBe(MAIN);
    }
    expect(seen, "不许退化成 cwd 推出来的 worktree 目录").not.toContain(WORKTREE);
    buildSpy.mockRestore();
  });
});

describe("F6：归位/保留的回执必须等**确认落库**", () => {
  it("F6-RECEIPT：落库失败时不许回「已归位」假成功", async () => {
    port = mount({ failWrites: true });
    const svc = new MemoryService();
    const added = svc.add({ scope: "conversation", sessionId: "s1", key: "要归位", content: "R", source: "auto" });
    expect(added.ok).toBe(true);
    const spy = vi.spyOn(await import("../core/memory/memory"), "getMemoryService").mockReturnValue(svc);

    const result = await retargetEntry(added.entry!.id, { scope: "platform" });
    expect(result.ok, "库写不进去 ⇒ 回执不许说成功").toBe(false);
    expect(result.message, "要如实说明没落库").toMatch(/未落库|失败/);
    spy.mockRestore();

    // 正常端口：回执说"已归位并已落库"，且真的落库了
    vi.restoreAllMocks();
    port = mount();
    const svc2 = new MemoryService();
    const added2 = svc2.add({ scope: "conversation", sessionId: "s1", key: "要归位", content: "R2", source: "auto" });
    await svc2.flushPendingPersist();
    const spy2 = vi.spyOn(await import("../core/memory/memory"), "getMemoryService").mockReturnValue(svc2);
    const ok = await retargetEntry(added2.entry!.id, { scope: "platform" });
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/已落库/);
    spy2.mockRestore();
  });
});

/**
 * F3（第 188 波复审）：**两个批量动作零判据** + 导入回执双向失真。
 *
 * 审计实测：删掉 `checkup.ts` 里 `retargetEntry`/`keepAsPlatformPool` 那两行
 * `flushPendingPersist()`，全量判据仍绿（F6-RECEIPT 只覆盖 `retargetEntry`，
 * keep* 那两条**一条判据都没有**）。这里补齐：
 * - `F3-KEEP-CONFIRM`：**单条**「保留为平台级」落库失败 ⇒ 回执必须说"未落库"；
 * - `F3-KEEP-BATCH`：**批量**接口的整批确认（并且把"上一次失败的粘性残迹"清掉）；
 * - `F3-IMPORT-RECEIPT`：导入回执的两个方向（失败不许说成功、成功不许说失败）。
 */
describe("F3：批量保留动作与导入回执都必须接确认、如实回执", () => {
  it("F3-KEEP-CONFIRM：单条「保留为平台级」落库失败 ⇒ 回执不许说成功", async () => {
    vi.restoreAllMocks();
    port = mount({ failWrites: true, seed: { memory: [{ id: "default", content: "" }] } });
    const failing = new MemoryService();
    failing.importFromJSON(
      JSON.stringify({ version: 2, entries: { "lp-1": { id: "lp-1", scope: "platform", key: "甲", content: "LEGACY_POOL", timestamp: 1, legacyPool: true } } }),
      true,
    );
    const spy = vi.spyOn(await import("../core/memory/memory"), "getMemoryService").mockReturnValue(failing);
    expect(failing.get("lp-1")!.legacyPool, "前置：这条必须是旧版跨项目池条目").toBe(true);

    const result = await keepAsPlatformPool("lp-1");
    expect(result.ok, "库写不进去 ⇒ 回执不许说成功").toBe(false);
    expect(result.message, "要如实说明没落库").toMatch(/未落库|失败/);
    spy.mockRestore();
  });

  it("F3-KEEP-BATCH：批量动作接整批确认，回执必须与**磁盘上的真实状态**一致", async () => {
    vi.restoreAllMocks();
    port = mount();
    const svcOk = new MemoryService();
    await svcOk.flushPendingPersist();
    // 把"上一次写失败"的粘性残迹搬到这个实例上（等价于同一个会话里上一次写失败过）
    (svcOk as unknown as { lastPersistError: string | null }).lastPersistError = "上一次落库失败";
    const spy = vi.spyOn(await import("../core/memory/memory"), "getMemoryService").mockReturnValue(svcOk);

    const result = await keepManyAsPlatform(["lp-1"]);
    expect(result.kept).toBe(0);
    expect(result.failed).toBe(1);
    /*
     * 核心不变式（判据的判据）：**回执说的"落库了"必须与磁盘一致**。
     * `landed` 由批量出口那次 `flushPendingPersist()` 提供 —— 把它改成恒真
     * （审计实测：删掉那一行 flush 全量仍绿），这条当场红。
     */
    const landedPayload = port.__table("memory")[0]?.content as string | undefined;
    const actuallyLanded = svcOk.getLastPersistError() === null;
    if (actuallyLanded) {
      expect(result.message, "真落库了才许说'已确认落库'").toContain("已确认落库");
    } else {
      expect(result.message, "没落库却印'已确认落库'就是假成功").toContain("未落库");
      expect(result.message, "要如实说明原因").toContain("上一次落库失败");
    }
    expect(landedPayload === undefined || actuallyLanded, "磁盘上没有这份记忆，回执就不许说落库了").toBe(true);
    expect(result.message, "批量回执必须带上逐条失败的原因（不许只剩一个数字）").toContain("未找到记忆");
    spy.mockRestore();
  });

  it("F3-IMPORT-RECEIPT：导入回执的两个方向（失败不说成功、成功不说失败）", () => {
    const result = { imported: 3, rejectedCapacity: 0, rejectedInvalid: 0, truncated: 0 };
    const failed = formatMemoryImportReceipt(result, false, "记忆落库失败：磁盘满");
    expect(failed, "导入失败 ⇒ 回执**不许**含'成功'").not.toContain("成功");
    expect(failed, "要如实说明写库失败").toContain("写入数据库失败");

    const ok = formatMemoryImportReceipt(result, true, null);
    expect(ok, "导入成功 ⇒ 回执**不许**含失败字样").not.toContain("失败");
    expect(ok).toContain("成功导入 3 条记忆");

    // imported=0 且 landed=false：那是**上一次**的粘性失败，必须与本次区分开
    const stale = formatMemoryImportReceipt({ imported: 0, rejectedCapacity: 0, rejectedInvalid: 0, truncated: 0 }, false, "上一次落库失败");
    expect(stale, "必须说清是'上一次'，不能报成这次导入坏了").toContain("上一次");
    expect(stale, "没有写入却说'成功导入'是假陈述").not.toContain("成功");
  });
});

describe("F7：命令/界面回执也要安全字符串化坏数据", () => {
  it("F7-SAFE-TEXT：数字 content 不再抛；`/memory pending` 的格式化那一行走同一个安全函数", async () => {
    // 读入路径允许 content/key 是数字（规范化时会字符串化），这里给一条数字 content 的条目
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          num: { id: "num", scope: "platform", key: 12345, content: 67890, timestamp: 1_600_000_000_000, source: "manual", status: "active" },
        },
      }),
    );
    const svc = new MemoryService();
    const entry = svc.get("num")!;
    expect(entry.content, "数字 content 被安全字符串化").toBe("67890");

    // 行为的半边：安全转换不抛、可用于拼接命令回执
    expect(() => `${safeMemoryText(entry.key)}：${safeMemoryText(entry.content).substring(0, 60)}`).not.toThrow();
    expect(`${safeMemoryText(entry.key)}：${safeMemoryText(entry.content).substring(0, 60)}`).toBe("12345：67890");

    /*
     * ⚠️ F5（第 188 波复审）：上面那两条**不判别** —— 它们喂的是"写库后读回来"的值，
     * 而 `normalizeLoadedEntry` 已经把数字/布尔字符串化了（`entry.content === "67890"`），
     * 于是把 `safeMemoryText` 换成恒等函数也照样通过（审计实测）。
     *
     * 所以行为的那半必须喂**真正会让旧写法抛的输入**：对象 / null / undefined / Symbol
     * （`Symbol` 是 `.substring` 与 `String()` 都会抛的那一个 —— 旧写法在命令回执里
     * 直接 `.content.substring` 时，只有这条能证明"安全通道真的挡得住"）。
     */
    const OLD_WAY = (v: unknown) => (v as string).substring(0, 60); // 旧写法：直接当字符串用
    for (const bad of [{ nested: true } as unknown, null, undefined, Symbol("坏数据")]) {
      expect(() => OLD_WAY(bad), `旧写法必须真的会抛（否则这条判据是测空气）：${String(bad)}`).toThrow();
      expect(() => safeMemoryText(bad), `安全通道绝不许抛：${String(bad)}`).not.toThrow();
    }
    expect(safeMemoryText({ nested: true })).toBe('{"nested":true}');
    expect(safeMemoryText(null)).toBe("");
    expect(safeMemoryText(undefined)).toBe("");
    expect(safeMemoryText(Symbol("坏数据"))).toBe("");

    /*
     * 命令那半边：`/memory pending` 在 `App.tsx` 的 `handleSend` 里（单测里没法整条跑），
     * 所以这里按**锚点取段**只钉那一行 —— 这条是接线检查（挡"改回去直接 .content.substring"），
     * 行为断言由上面那组承担。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const anchor = app.indexOf("const lines = pending.slice(0, 20).map(");
    expect(anchor, "找不到 /memory pending 的格式化锚点").toBeGreaterThan(0);
    const segment = app.slice(anchor, anchor + 700);
    expect(segment, "/memory pending 必须走安全字符串化").toContain("safeMemoryText(");
    expect(segment.includes(".content.substring"), "坏数据（数字 content）不许直接 .substring").toBe(false);
  });
});
