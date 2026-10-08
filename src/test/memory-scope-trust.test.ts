/**
 * 记忆系统「作用域 + 信任边界」重构判据（MEM-SCOPE / MEM-TRUST / MEM-APPROVE / MEM-CAP / MEM-UNDO / MEM-MIG / MEM-INJECT）
 *
 * ## 这组判据针对的既有缺陷（修复前必须能变红）
 * 1. `listByScope` 只按 scope 过滤 ⇒ **项目 A 的 project 记忆在项目 B 可见**（跨项目泄漏）；
 * 2. `buildMemoryPrompt("session")` **全仓没有调用点** ⇒ 对话级记忆从不进上下文；
 * 3. 自动提取写入的 project 条目**没有 projectId**，且与手动条目同 key 时会被顶掉；
 * 4. 自动条目在注入文本里**与手动条目混在一起**，看不出哪条可能不准；
 * 5. 容量上限靠 `consolidate` 的 FIFO **静默驱逐**，用户看不到任何动静。
 *
 * ## 判据风格
 * 全部是**行为**断言（调用产品 API → 断言结果/注入文本），外加一条**锚点取段**的源码断言
 * （MEM-INJECT-3 只取 `buildSystemPromptAsync` 内 `buildMemoryPrompt` 那一小段），
 * 不用"文件里含某个字符串"这种伪判据。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { loadMemory, saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_WRITE_APPROVAL_KEY,
  MEMORY_MIGRATED_KEY,
} from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const PROJ_B = "c:\\work\\beta";

/** 内存里的"数据库"（每个用例一个干净端口） */
let store: Record<string, string> = {};

/** 预置 persisted 内容（用于迁移判据：模拟升级前已经在库里的旧条目） */
function seedMemory(entries: Array<Record<string, unknown>>): void {
  saveMemory(JSON.stringify({ version: 1, entries: Object.fromEntries(entries.map((e, i) => [`seed-${i}`, e])) }));
}

/**
 * 迁移判据用：旧作用域名的条目。
 *
 * ⚠️ 旧数据里 `project` / `session` 条目**本来就没有归属键**（这正是"到处生效 / 根本不生效"的根因），
 * 所以这里刻意**不带** `projectId` / `sessionId` —— 带上就不是旧数据了，迁移判据也就失去意义。
 */
function legacy(scope: string, key: string, content: string, timestamp: number) {
  return { id: `legacy-${key}`, scope, key, content, timestamp };
}

/** 取一段注入文本里两个标记的先后关系（顺序断言用） */
function orderIn(text: string, first: string, second: string): boolean {
  const i = text.indexOf(first);
  const j = text.indexOf(second);
  return i >= 0 && j >= 0 && i < j;
}

beforeEach(() => {
  store = {};
  setStoragePort(
    createFakeStoragePort({
      seed: { settings: [{ key: "noop", value: "" }] },
      onWriteThrough: (command: string, params: Record<string, unknown>) => {
        if (command === "memory.set") store.memory = String(params.content ?? "");
      },
    }),
  );
  saveMemory("");
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

/**
 * 造一个只用来喂 `extractMemoriesFromSession` 的引擎。
 *
 * 三处桩缺一不可（这也说明它确实在跑**真实的提取流程**，而不是复述实现）：
 * ① 会话级开关：`memory-enabled-<sessionId>` 必须显式为 true，否则方法第一步就返回；
 * ② provider：`resolveSlot("memory")` 会回落到引擎默认 provider；
 * ③ 真正发 LLM 请求的 `spawnForked` 换成固定 JSON。
 */
function engineForExtraction(memory: MemoryService, sessionId: string, payload: string): LLMEngine {
  setSettingJSON(`memory-enabled-${sessionId}`, true);
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = memory;
  const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: payload }) };
  (engine as unknown as { providers: unknown }).providers = { get: () => provider };
  (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
  vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
    Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
  );
  vi.spyOn(engine, "spawnForked").mockResolvedValue(payload);
  return engine;
}

// ========== 作用域过滤 ==========

describe("MEM-SCOPE：三级作用域各自真的按维度过滤", () => {
  it("MEM-SCOPE-1（修复前红：跨项目泄漏）：项目 A 的 project 记忆在项目 B 不可见", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "A 的约定", content: "ALPHA_ONLY 这条只属于 A", source: "manual" });

    const inA = svc.buildMemoryPrompt("project", PROJ_A);
    const inB = svc.buildMemoryPrompt("project", PROJ_B);

    expect(inA, "项目 A 自己的记忆必须出现在 A 的注入里").toContain("ALPHA_ONLY");
    expect(inB, "项目 A 的记忆**不许**出现在项目 B 的注入里").not.toContain("ALPHA_ONLY");
    expect(svc.listByScope("project", { projectId: PROJ_B })).toHaveLength(0);
    expect(svc.listByScope("project", { projectId: PROJ_A })).toHaveLength(1);
  });

  it("MEM-SCOPE-2：platform 记忆在所有项目都可见", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台约定", content: "PLATFORM_ONLY 处处可见", source: "manual" });

    const inA = svc.buildMemoryPrompt("platform", PROJ_A);
    const inB = svc.buildMemoryPrompt("platform", PROJ_B);

    expect(inA).toContain("PLATFORM_ONLY");
    expect(inB).toContain("PLATFORM_ONLY");
    expect(svc.listByScope("platform", { projectId: PROJ_B })).toHaveLength(1);
  });

  it("MEM-SCOPE-3：conversation 记忆只在该 session 可见（其它会话拿不到）", () => {
    const svc = new MemoryService();
    svc.add({ scope: "conversation", sessionId: "s1", key: "对话约定", content: "CONV_S1 只属于 s1", source: "manual" });

    expect(svc.buildMemoryPrompt("conversation", PROJ_A, "s1")).toContain("CONV_S1");
    expect(svc.buildMemoryPrompt("conversation", PROJ_A, "s2")).not.toContain("CONV_S1");
    // 没有归属对话的条目（迁移后的旧 session 记忆）**任何**对话都不注入
    svc.add({ scope: "conversation", key: "孤儿对话记忆", content: "ORPHAN_CONV", source: "auto" });
    expect(svc.buildMemoryPrompt("conversation", PROJ_A, "s1")).not.toContain("ORPHAN_CONV");
    // 但界面仍然看得到（可编辑）
    expect(svc.listAll({ projectId: PROJ_A, sessionId: "s1" }).some((e) => e.content === "ORPHAN_CONV")).toBe(true);
  });

  it("MEM-SCOPE-4：三块同时注入时的顺序是 platform → project → conversation", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "p", content: "MARK_PLATFORM", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_A, key: "j", content: "MARK_PROJECT", source: "manual" });
    svc.add({ scope: "conversation", sessionId: "s1", key: "c", content: "MARK_CONV", source: "manual" });

    const text = svc.buildMemoryPrompt(undefined, PROJ_A, "s1");
    expect(orderIn(text, "MARK_PLATFORM", "MARK_PROJECT"), "平台块应在项目块之前").toBe(true);
    expect(orderIn(text, "MARK_PROJECT", "MARK_CONV"), "项目块应在对话块之前").toBe(true);
  });
});

// ========== 信任边界：自动不得改写手动 ==========

describe("MEM-TRUST：自动流程不得改写/覆盖/删除手动条目", () => {
  it("MEM-TRUST-1（修复前红：同 key 会被顶掉）：跑一次自动提取，手动条目逐字不变", async () => {
    const svc = new MemoryService();
    const manual = svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "构建方式",
      content: "MANUAL_VERBATIM 用 pnpm 构建",
      source: "manual",
    });
    expect(manual.ok).toBe(true);
    const before = svc.get(manual.entry!.id)!;

    const engine = engineForExtraction(
      svc,
      "s1",
      JSON.stringify([{ key: "构建方式", content: "AUTO_VERSION 用 npm 构建", tags: ["build"] }]),
    );
    await engine.extractMemoriesFromSession("s1", PROJ_A);

    const after = svc.get(manual.entry!.id)!;
    expect(after.key, "手动条目的 key 逐字不变").toBe(before.key);
    expect(after.content, "手动条目的内容逐字不变（自动流程不得覆盖）").toBe("MANUAL_VERBATIM 用 pnpm 构建");
    expect(after.source).toBe("manual");
    expect(after.timestamp, "手动条目连时间戳都不该被自动流程碰").toBe(before.timestamp);

    const sameKey = svc.listByScope("project", { projectId: PROJ_A }).filter((e) => e.key === "构建方式");
    expect(sameKey, "同 key 只应存在那一条手动条目（自动条目被拦下）").toHaveLength(1);
    expect(svc.buildMemoryPrompt("project", PROJ_A)).not.toContain("AUTO_VERSION");

    // 自动清洗同样不许删手动条目
    svc.consolidate({ maxAgeDays: 0 });
    expect(svc.get(manual.entry!.id), "consolidate 不得删除手动条目").toBeDefined();
  });

  it("MEM-TRUST-1b：没有同 key 手动条目时，自动条目正常写入并带 source=auto / batchId", async () => {
    const svc = new MemoryService();
    const engine = engineForExtraction(
      svc,
      "s1",
      JSON.stringify([{ key: "自动事实", content: "AUTO_WRITTEN 这是一条足够长的自动提取内容", tags: [] }]),
    );
    await engine.extractMemoriesFromSession("s1", PROJ_A);

    // 用"携带全部视图开关 + 当前位置"的查询取出（自动条目此时可能带 pending 状态）
    const auto = svc.listAll({ projectId: PROJ_A, sessionId: "s1" })[0];
    expect(auto, "自动条目应写进 project 作用域").toBeDefined();
    expect(auto.source).toBe("auto");
    expect(auto.projectId, "自动条目必须带归属项目（否则就是又一次跨项目泄漏）").toBe(PROJ_A);
    expect(auto.batchId, "自动条目必须带批次号（可整批撤销）").toBeTruthy();
    const batch = svc.listBatches().find((b) => b.id === auto.batchId);
    expect(batch?.sessionId, "批次要记录来源会话").toBe("s1");
    // 归属项目正确 ⇒ 在项目 A 生效、在项目 B 不生效
    const pendingInA = svc.listByScope("project", {
      projectId: PROJ_A,
      sessionId: "s1",
      includePending: true,
      includeUnscoped: true,
    });
    expect(pendingInA, "自动条目归属项目 A").toHaveLength(1);
    expect(
      svc.listByScope("project", {
        projectId: PROJ_B,
        sessionId: "s1",
        includePending: true,
        includeUnscoped: true,
      }),
      "项目 B 看不到 A 的自动条目",
    ).toHaveLength(0);
  });

  it("MEM-TRUST-1c：自动提取**无归属项目**时写入的条目任何项目都不注入（宁可不注入也不猜项目）", async () => {
    const svc = new MemoryService();
    const engine = engineForExtraction(
      svc,
      "s1",
      JSON.stringify([{ key: "无归属", content: "NO_OWNER 没有归属项目的自动提取", tags: [] }]),
    );
    await engine.extractMemoriesFromSession("s1");

    const all = svc.listAll({ projectId: PROJ_A });
    expect(all, "条目仍然写入（可在界面看到）").toHaveLength(1);
    expect(all[0].projectId).toBeUndefined();
    expect(svc.buildMemoryPrompt("project", PROJ_A)).not.toContain("NO_OWNER");
  });
});

// ========== 注入形态：手动块在前、自动块标注在后 ==========

describe("MEM-TRUST-2：自动条目在注入文本里被明确标注并与手动块分开", () => {
  it("MEM-TRUST-2（修复前红：混在一起）：手动块在前，自动块单独标注在后", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "手写", content: "MANUAL_TEXT", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_A, key: "自动", content: "AUTO_TEXT", source: "auto", batchId: "batch-x" });

    const text = svc.buildMemoryPrompt("project", PROJ_A);

    expect(text, "必须有「手动维护」块标题").toContain("手动维护");
    expect(text, "自动块必须有可自证的标注").toContain("自动提取（可能不准，可删）");
    expect(
      orderIn(text, "手动维护", "自动提取（可能不准，可删）"),
      "手动块必须在自动块之前（用户维护的结论优先呈现）",
    ).toBe(true);
    expect(orderIn(text, "MANUAL_TEXT", "AUTO_TEXT"), "手动条目应先于自动条目出现").toBe(true);
    // 标注必须紧邻自动条目（不是"文件里出现过这个词"）：自动块的标题与内容在同一段里
    const autoIdx = text.indexOf("自动提取（可能不准，可删）");
    const autoLineIdx = text.indexOf("AUTO_TEXT");
    expect(autoLineIdx).toBeGreaterThan(autoIdx);
    expect(autoLineIdx - autoIdx, "自动标注与自动条目之间不应隔着整段手动内容").toBeLessThan(200);
  });

  it("MEM-TRUST-2b：只被自动条目占用时，注入里不出现「手动维护」块（空块不占上下文）", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "自动", content: "ONLY_AUTO", source: "auto" });
    const text = svc.buildMemoryPrompt("project", PROJ_A);
    expect(text).toContain("ONLY_AUTO");
    expect(text).not.toContain("手动维护");
  });
});

// ========== 写入审批 ==========

describe("MEM-APPROVE：审批开启时自动条目未批准不进上下文", () => {
  it("MEM-APPROVE-1（修复前红：没有审批概念）：批准前不进上下文，批准后才进", () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();

    const result = svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "待审事实",
      content: "PENDING_FACT 未经批准",
      source: "auto",
      status: "pending",
      batchId: "batch-pending",
    });
    expect(result.ok).toBe(true);

    expect(svc.buildMemoryPrompt("project", PROJ_A), "待批准条目**不许**进上下文").not.toContain("PENDING_FACT");
    /*
     * A2 / F7：`listPending` 现在**必须带 ctx**（缺 ctx ⇒ fail-closed 返回空）——
     * 旧写法不传 ctx 时全量返回，项目 A 就能看到项目 B 的待批准内容。
     */
    expect(svc.listPending(undefined, { projectId: PROJ_A })).toHaveLength(1);

    const approved = svc.approve(result.entry!.id);
    expect(approved.ok, "批准应成功").toBe(true);
    expect(svc.buildMemoryPrompt("project", PROJ_A), "批准后才进上下文").toContain("PENDING_FACT");
    expect(svc.listPending(undefined, { projectId: PROJ_A })).toHaveLength(0);
  });

  it("MEM-APPROVE-1b：关闭审批时自动条目直接生效（默认：conversation 关闭）", () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: false, project: false, conversation: false }));
    const svc = new MemoryService();
    svc.add({ scope: "conversation", sessionId: "s1", key: "临时", content: "DIRECT_ACTIVE", source: "auto", status: "active" });
    expect(svc.buildMemoryPrompt("conversation", PROJ_A, "s1")).toContain("DIRECT_ACTIVE");
  });

  it("MEM-APPROVE-2：拒绝会删除待审条目，且它从未进过上下文", () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: true }));
    const svc = new MemoryService();
    const added = svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "坏事实",
      content: "REJECT_ME 不该被记住",
      source: "auto",
      status: "pending",
      batchId: "batch-reject",
    });
    expect(svc.reject(added.entry!.id)).toBe(true);
    expect(svc.get(added.entry!.id)).toBeUndefined();
    expect(svc.buildMemoryPrompt("project", PROJ_A)).not.toContain("REJECT_ME");
  });

  it("MEM-APPROVE-3：自动提取在审批开启时写 pending，关闭时写 active", async () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svcOn = new MemoryService();
    await engineForExtraction(
      svcOn,
      "s-approve-on",
      JSON.stringify([{ key: "审批开关事实", content: "APPROVAL_MODE 足够长的一条内容", tags: [] }]),
    ).extractMemoriesFromSession("s-approve-on", PROJ_A);
    expect(svcOn.listPending(undefined, { projectId: PROJ_A }), "审批开启 ⇒ 写 pending").toHaveLength(1);
    expect(svcOn.buildMemoryPrompt("project", PROJ_A), "未批准不进上下文").not.toContain("APPROVAL_MODE");

    /*
     * 换一个**干净的数据面**（把上一条持久化内容清掉）再验证"审批关闭"那一侧：
     * 否则第二个服务会把上一条 pending 条目一起加载进来，测的就不是开关而是残留。
     */
    saveMemory("");
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: false, project: false, conversation: false }));
    const svcOff = new MemoryService();
    expect(svcOff.listPending(undefined, { projectId: PROJ_A }), "换干净数据面后应当一条待审都没有").toHaveLength(0);
    await engineForExtraction(
      svcOff,
      "s-approve-off",
      JSON.stringify([{ key: "审批开关事实", content: "APPROVAL_MODE 足够长的一条内容", tags: [] }]),
    ).extractMemoriesFromSession("s-approve-off", PROJ_A);
    expect(svcOff.listPending(undefined, { projectId: PROJ_A }), "审批关闭 ⇒ 不写 pending").toHaveLength(0);
    expect(svcOff.buildMemoryPrompt("project", PROJ_A)).toContain("APPROVAL_MODE");
  });
});

// ========== 容量：可见地失败 ==========

describe("MEM-CAP：达到上限时可见地失败，不静默驱逐", () => {
  it("MEM-CAP-1（修复前红：由 consolidate 静默 FIFO 驱逐）：写入被拒绝且已有条目逐字还在", () => {
    const svc = new MemoryService({ maxEntries: 2 });
    const keep1 = svc.add({ scope: "platform", key: "k1", content: "KEEP_ONE", source: "manual" });
    const keep2 = svc.add({ scope: "platform", key: "k2", content: "KEEP_TWO", source: "manual" });
    expect(keep1.ok && keep2.ok).toBe(true);

    const overflow = svc.add({ scope: "platform", key: "k3", content: "SHOULD_BE_REJECTED", source: "auto" });

    expect(overflow.ok, "容量满时必须如实失败").toBe(false);
    expect(overflow.error).toBe("capacity");
    expect(overflow.message, "失败原因要能被用户读懂").toMatch(/容量|上限/);
    expect(svc.get(keep1.entry!.id)!.content, "已有条目不许被驱逐").toBe("KEEP_ONE");
    expect(svc.get(keep2.entry!.id)!.content, "已有条目不许被驱逐").toBe("KEEP_TWO");
    expect(svc.listAll()).toHaveLength(2);
    expect(svc.buildMemoryPrompt("platform")).toContain("KEEP_TWO");
    expect(svc.buildMemoryPrompt("platform")).not.toContain("SHOULD_BE_REJECTED");
  });

  it("MEM-CAP-2：consolidate 的手动条目超额走「拒绝并上报」，不做静默驱逐", () => {
    const svc = new MemoryService({ maxEntries: 10 });
    svc.add({ scope: "platform", key: "m1", content: "M1", source: "manual" });
    svc.add({ scope: "platform", key: "m2", content: "M2", source: "manual" });
    svc.add({ scope: "platform", key: "m3", content: "M3", source: "manual" });

    const result = svc.consolidate({ maxEntriesPerScope: 2 });

    expect(result.capacityTrimmed, "手动条目不许被自动裁剪").toBe(0);
    expect(result.capacityBlocked, "拒绝必须如实上报").toBeGreaterThan(0);
    expect(svc.listAll({ includePending: true })).toHaveLength(3);
  });

  it("MEM-CAP-3：容量满时自动提取如实报告拒绝（不假装写入成功）", async () => {
    const svc = new MemoryService({ maxEntries: 1 });
    svc.add({ scope: "project", projectId: PROJ_A, key: "已有", content: "EXISTING_MANUAL", source: "manual" });

    await engineForExtraction(
      svc,
      "s-cap",
      JSON.stringify([{ key: "新的", content: "CAP_REJECTED 这条写不进去", tags: [] }]),
    ).extractMemoriesFromSession("s-cap", PROJ_A);

    expect(svc.listByScope("project", { projectId: PROJ_A })).toHaveLength(1);
    expect(svc.buildMemoryPrompt("project", PROJ_A)).toContain("EXISTING_MANUAL");
    expect(svc.buildMemoryPrompt("project", PROJ_A)).not.toContain("CAP_REJECTED");
  });
});

// ========== 批次回滚 ==========

describe("MEM-UNDO：撤销一个批次只删该批次", () => {
  it("MEM-UNDO-1（修复前红：没有批次概念）：同批次全删、其它批次与手动条目逐字不动", () => {
    const svc = new MemoryService();
    const manual = svc.add({ scope: "platform", key: "手动", content: "MANUAL_KEEP", source: "manual" });

    const batchA = svc.beginBatch("s1", "platform");
    const a1 = svc.add({ scope: "platform", key: "a1", content: "BATCH_A_1", source: "auto", batchId: batchA });
    const a2 = svc.add({ scope: "platform", key: "a2", content: "BATCH_A_2", source: "auto", batchId: batchA });
    svc.finalizeBatch(batchA, 2);

    const batchB = svc.beginBatch("s1", "platform");
    const b1 = svc.add({ scope: "platform", key: "b1", content: "BATCH_B_1", source: "auto", batchId: batchB });
    svc.finalizeBatch(batchB, 1);

    const undo = svc.undoBatch(batchA);

    expect(undo.ok).toBe(true);
    expect(undo.removed, "同批次两条都要删").toBe(2);
    expect(svc.get(a1.entry!.id)).toBeUndefined();
    expect(svc.get(a2.entry!.id)).toBeUndefined();
    expect(svc.get(b1.entry!.id)!.content, "其它批次逐字不动").toBe("BATCH_B_1");
    expect(svc.get(manual.entry!.id)!.content, "手动条目逐字不动").toBe("MANUAL_KEEP");
    expect(svc.buildMemoryPrompt("platform")).toContain("BATCH_B_1");
    expect(svc.buildMemoryPrompt("platform")).not.toContain("BATCH_A_1");
    expect(svc.listBatches().find((b) => b.id === batchA)?.undone).toBe(true);

    const again = svc.undoBatch(batchA);
    expect(again.ok, "重复撤销必须如实失败（不许把别的同期条目一起删掉）").toBe(false);
    expect(svc.get(b1.entry!.id)).toBeDefined();
  });

  it("MEM-UNDO-2：未知批次号如实失败", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "k", content: "K", source: "manual" });
    const result = svc.undoBatch("batch-does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.removed).toBe(0);
    expect(svc.listAll()).toHaveLength(1);
  });
});

// ========== 迁移 ==========

describe("MEM-MIG：迁移前后可见范围逐字不变，且幂等", () => {
  it("MEM-MIG-1（修复前红：没有迁移，作用域名仍是旧的）：逐字不变 + 幂等", () => {
    const legacyEntries = [
      legacy("global", "老全局", "LEGACY_GLOBAL 一直到处可见", 1_600_000_000_000),
      legacy("project", "老项目", "LEGACY_PROJECT 今天也是到处可见", 1_600_000_000_001),
      legacy("session", "老会话", "LEGACY_SESSION 今天根本没被注入", 1_600_000_000_002),
    ];
    seedMemory(legacyEntries);

    /*
     * 迁移前：`MemoryService` 是"构造即迁移"的，所以这里用一个刚构造的实例做夹具 ——
     * 把它的内存态重置回"旧数据、还没迁移"，再塞入旧条目，
     * 然后用 `migrateScopeModel({ force: true })` 跑**产品里那条真实的迁移实现**（不是复述规则）。
     */
    const svc = new MemoryService();
    svc.__seedLegacyForMigrationTest(legacyEntries);
    svc.__resetMigrationStateForTest();
    const beforeSnapshot = svc.visibilitySnapshot({ includeUnscoped: true });
    expect(beforeSnapshot, "迁移前的快照要如实反映旧语义（两条 EVERYWHERE + 一条 UNSCOPED）").toEqual([
      "EVERYWHERE|老全局",
      "EVERYWHERE|老项目",
      "UNSCOPED|老会话",
    ].sort());

    // 跑真实的迁移实现
    const report = svc.migrateScopeModel({ force: true });
    expect(report.ran).toBe(true);
    expect(report.globalToPlatform).toBe(1);
    expect(report.projectToPlatform, "旧 project 没有 projectId ⇒ 降为 platform（不猜项目）").toBe(1);
    expect(report.sessionToConversation).toBe(1);

    const migrated = svc;
    const after = migrated.visibilitySnapshot({ includeUnscoped: true });
    expect(after, "迁移前后可见范围必须逐字不变").toEqual(beforeSnapshot);

    // `global` / `project` → `platform`：仍在所有项目可见（**没有**被猜一个 projectId）
    expect(migrated.buildMemoryPrompt("platform", PROJ_B)).toContain("LEGACY_GLOBAL");
    expect(migrated.buildMemoryPrompt("platform", PROJ_B)).toContain("LEGACY_PROJECT");
    expect(
      migrated.listByScope("platform").every((e) => e.projectId === undefined),
      "不许按当前项目猜一个 projectId 塞进去",
    ).toBe(true);

    // `session` → `conversation` 且不带 sessionId：仍不进注入，但界面可见
    expect(migrated.buildMemoryPrompt(undefined, PROJ_A, "any-session")).not.toContain("LEGACY_SESSION");
    expect(migrated.listAll({ projectId: PROJ_A, sessionId: "any-session" }).some((e) => e.content.includes("LEGACY_SESSION"))).toBe(true);
    expect(migrated.getStats().notInjected, "未归属条目数要如实统计").toBe(1);

    // 幂等：再跑一次迁移，报告 ran=false 且结果逐字相同
    const second = migrated.migrateScopeModel();
    expect(second.ran, "第二次迁移 = 无事可做").toBe(false);
    expect(second.visibleAfter).toEqual(beforeSnapshot);

    // 幂等：从持久化重新加载（产品读入口）不改变任何条目
    const reloaded = new MemoryService();
    expect(reloaded.visibilitySnapshot({ includeUnscoped: true }), "重载后可见范围仍然逐字相同").toEqual(beforeSnapshot);
    expect(reloaded.getStats().totalEntries).toBe(3);
    const orphan = reloaded.listAll({ projectId: PROJ_A, sessionId: "any-session" }).find((e) => e.key === "老会话");
    expect(orphan, "旧 session 条目应落在 conversation 作用域").toBeDefined();
    expect(orphan!.scope).toBe("conversation");
    expect(orphan!.sessionId, "迁移不带 sessionId（于是仍然不被注入）").toBeUndefined();
  });

  it("MEM-MIG-2：已迁移标记存在时报告 ran=false（幂等依据）", () => {
    seedMemory([legacy("global", "g", "G", 1)]);
    const first = new MemoryService();
    expect(first.getStats().totalEntries).toBe(1);
    setSetting(MEMORY_MIGRATED_KEY, "1");

    const report = new MemoryService().migrateScopeModel();
    expect(report.ran, "标记键在 ⇒ 不再迁移").toBe(false);
    expect(report.visibleBefore).toEqual(report.visibleAfter);
  });

  it("MEM-MIG-3：迁移后的旧 project 条目仍然在所有项目可见（不改变用户实际体验）", () => {
    seedMemory([legacy("project", "老项目约定", "STILL_EVERYWHERE", 1)]);
    const svc = new MemoryService();
    expect(svc.buildMemoryPrompt("platform", PROJ_A)).toContain("STILL_EVERYWHERE");
    expect(svc.buildMemoryPrompt("platform", PROJ_B)).toContain("STILL_EVERYWHERE");
  });
});

// ========== 引擎注入路径（含对话级记忆首次真正进上下文） ==========

describe("MEM-INJECT：三级记忆真的被拼进系统提示，且按项目/会话过滤", () => {
  /**
   * 捕获引擎实际交给提示词模板的 `memoryInstructions`（把依赖压成桩之后调**真实的**
   * `buildSystemPrompt`，而不是复述它的实现）。
   */
  function buildPromptWithStubs(svc: MemoryService, sessionId: string, cwd: string): string {
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
    engine.skills = {
      buildSkillEnvironmentSection: () => "",
      buildSkillPrompt: () => "",
      buildPreloadedSkillPrompt: () => "",
    } as never;
    engine.mcp = { getAllTools: () => [] } as never;
    return engine.buildSystemPrompt(sessionId, "build", cwd);
  }

  it("MEM-INJECT-1：conversation 记忆确实出现在注入的提示文本里（修复前完全没有注入）", () => {
    const svc = new MemoryService();
    svc.add({ scope: "conversation", sessionId: "s1", key: "对话内约定", content: "CONVERSATION_IN_PROMPT", source: "manual" });
    svc.add({ scope: "platform", key: "平台", content: "PLATFORM_IN_PROMPT", source: "manual" });
    svc.add({ scope: "project", projectId: "c:\\work\\alpha", key: "项目", content: "PROJECT_IN_PROMPT", source: "manual" });
    svc.add({ scope: "project", projectId: "c:\\work\\other", key: "别的项目", content: "OTHER_PROJECT_SECRET", source: "manual" });

    const prompt = buildPromptWithStubs(svc, "s1", "C:\\work\\alpha");

    expect(prompt, "对话级记忆必须真的进系统提示（旧实现没有调用点）").toContain("CONVERSATION_IN_PROMPT");
    expect(prompt).toContain("PLATFORM_IN_PROMPT");
    expect(prompt, "本项目记忆进提示").toContain("PROJECT_IN_PROMPT");
    expect(prompt, "别的项目记忆**不许**进提示").not.toContain("OTHER_PROJECT_SECRET");
    expect(orderIn(prompt, "PLATFORM_IN_PROMPT", "PROJECT_IN_PROMPT")).toBe(true);
    expect(orderIn(prompt, "PROJECT_IN_PROMPT", "CONVERSATION_IN_PROMPT")).toBe(true);
  });

  it("MEM-INJECT-2：换一个项目 / 换一个会话，本项目与本会话的记忆都拿不到", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: "c:\\work\\alpha", key: "A", content: "PROJ_A_SECRET", source: "manual" });
    svc.add({ scope: "conversation", sessionId: "s1", key: "S", content: "SESS_1_SECRET", source: "manual" });
    svc.add({ scope: "platform", key: "P", content: "PLATFORM_ALWAYS", source: "manual" });

    const other = buildPromptWithStubs(svc, "s2", "C:\\work\\beta");

    expect(other).not.toContain("PROJ_A_SECRET");
    expect(other).not.toContain("SESS_1_SECRET");
    expect(other, "平台级记忆仍然要进（这是它与项目级的区别）").toContain("PLATFORM_ALWAYS");
  });

  /**
   * MEM-INJECT-3（D1 重写：从"锚点取源码 + 断言实现里的字面量"改成**行为断言**）。
   *
   * 旧写法用 `indexOf("const memoryPrompt = this.memory.buildMemoryPrompt")` 取一段再正则匹配
   * —— 它能挡住"改名/删行"，但**挡不住"传错值"**（例如把原始 `cwd` 当 projectId 传，
   * 或把 projectId 与 sessionId 传反）。这里改成行为：用**混合大小写的工作目录**
   * （Windows 上真实形态）构造提示，若注入点没有做 `projectIdFromCwd` 归一化，这条必红；
   * 再换一个会话/项目，断言两个维度各自真的过滤。
   */
  it("MEM-INJECT-3（行为）：注入点对 cwd 做了归一化，且 projectId/sessionId 各自生效", () => {
    const svc = new MemoryService();
    // 归属键存的是**归一化后**的形式（产品写入路径与界面都用它）
    svc.add({ scope: "project", projectId: "c:\\work\\alpha", key: "项目", content: "PROJ_OF_ALPHA", source: "manual" });
    svc.add({ scope: "conversation", sessionId: "s1", key: "对话", content: "CONV_OF_S1", source: "manual" });

    // 混合大小写 + 正斜杠 + 尾斜杠的 cwd：只有真的过了一遍归一化才可能相等
    const prompt = buildPromptWithStubs(svc, "s1", "C:/Work/Alpha/");
    expect(prompt, "混合大小写的 cwd 必须归一到同一个项目键（否则这一条永不注入）").toContain("PROJ_OF_ALPHA");
    expect(prompt, "同一个会话的对话级记忆要进").toContain("CONV_OF_S1");

    const otherSession = buildPromptWithStubs(svc, "s2", "C:/Work/Alpha/");
    expect(otherSession, "换一个会话就不该看到 s1 的对话级记忆").not.toContain("CONV_OF_S1");
    expect(otherSession, "同一个项目里仍然看得到项目级记忆").toContain("PROJ_OF_ALPHA");

    const otherProject = buildPromptWithStubs(svc, "s1", "C:/Work/Beta");
    expect(otherProject, "换一个项目就不该看到 alpha 的项目级记忆").not.toContain("PROJ_OF_ALPHA");
    expect(otherProject, "同一个会话里仍然看得到对话级记忆").toContain("CONV_OF_S1");
  });
});
