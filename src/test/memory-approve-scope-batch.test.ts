/**
 * 第 196 波（用户要求的两个改动）的判据：
 * ① 自动提取**按条目判作用域** ⇒ 对话级默认直接生效（不提示）、项目级默认待批准；
 * ② 待批准支持**勾选 + 批量同意/拒绝（含全选）** —— 服务层这一半（界面那一半在
 *    `memory-pending-batch.test.tsx`）。
 *
 * ## 为什么把这批判据单独立一个文件
 *
 * `memory-scope-trust.test.ts` 已经很大（作用域 / 信任边界 / 容量 / 撤销 / 迁移 / 注入），
 * 而这一波是**一条新规则 + 一个新操作**（默认策略按作用域分档 + 批量处置），
 * 有自己的反向对照（"用户手动改过开关时不许被默认值盖掉"、"平台级不许被自动提取写进来"、
 * "批量必须只落库一次"）。放在自己文件里，变异锚点也更清晰。
 *
 * ## 判据清单
 *
 * - `MAS-1`：三档默认值 = 平台需批准 / 项目需批准 / **对话直接生效**；显式改过的值优先（反向对照）。
 * - `MAS-2`：提取里 `scope:"conversation"` ⇒ 对话级 + active（不进待批准、立刻进该对话上下文）。
 * - `MAS-3`：提取里 `scope:"project"` ⇒ 项目级 + pending（未批准不进上下文）。
 * - `MAS-4`（兜底方向）：**没有 `scope` 字段**（老提示词产物）或写了别的词 ⇒
 *   **对话级 + 直接生效** —— 拿不准时先只在这次对话里生效（用户 2026-10-10 选定的方向：
 *   少弹批准，且爆炸半径比"归项目级"更小）；模型**明说** project 的那一半由 `MAS-3` 钉着。
 * - `MAS-5`：模型写了 `"platform"` ⇒ 落成**项目级**（自动提取不许写平台级；内容一条不丢）。
 * - `MAS-6`（反向对照）：用户把「对话」开关改成"需批准"后，对话级提取必须回到 pending。
 * - `MAS-7`（作用域隔离）：对话级自动记忆只进**那个对话**的上下文，别的对话看不到。
 * - `MB-1`：`approveMany` 一次批准多条，且**只落库一次**（写放大：N 条 ≠ N 次整份写）。
 * - `MB-2`：`rejectMany` 一次删除多条，也只落库一次。
 * - `MB-3`（反向对照）：不在待批准状态的 id（不存在 / 已生效 / 手动条目）**被跳过并计数**，不许被改动。
 * - `MB-4`：空数组 ⇒ 不落库（空操作不该写库）。
 * - `MB-5`：容量已满时 `approveMany` **逐条拒绝并计数**，其余照常批准。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_WRITE_APPROVAL_KEY,
  getWriteApprovalSetting,
  memoryScopeFromExtraction,
  setWriteApprovalSetting,
} from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const SESSION = "s-196-a";
const OTHER_SESSION = "s-196-b";

let port: FakeStoragePort;

beforeEach(() => {
  saveMemory("");
  port = createFakeStoragePort({
    seed: { settings: [{ key: "noop", value: "" }] },
  });
  setStoragePort(port);
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

/** 落库次数（`memory.set` 是记忆整份写的落点；用它量"写放大"） */
function memoryWrites(): number {
  return port.__writes().filter((w) => w.command === "memory.set").length;
}

/** 造一个只用来喂 `extractMemoriesFromSession` 的引擎（与既有判据同一套桩） */
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

describe("MEM-APPROVE-SCOPE：自动提取按条目判作用域（对话级默认直接生效）", () => {
  it("MAS-1：默认 = 平台需批准 / 项目需批准 / **对话直接生效**；显式改过的值优先", () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, ""); // 空值 ⇒ 用默认
    expect(
      getWriteApprovalSetting(),
      "默认档：平台/项目需批准，对话直接生效（用户要求 2026-10）",
    ).toEqual({ platform: true, project: true, conversation: false });

    // 反向对照：显式改过就照改过的（默认值不许把用户的选择盖掉）
    setWriteApprovalSetting({ conversation: true });
    expect(getWriteApprovalSetting(), "用户手动改成「对话也需批准」之后必须生效").toEqual({
      platform: true,
      project: true,
      conversation: true,
    });
  });

  it("MAS-2：`scope: conversation` ⇒ 对话级 + 直接生效（不进待批准，立刻进该对话上下文）", async () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "这次先给方案", content: "这次先给方案再改代码（本次对话内的要求）", scope: "conversation" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.listPending(undefined, { projectId: PROJ_A, sessionId: SESSION }), "对话级不该进待批准区").toHaveLength(0);
    const all = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION });
    expect(all, "必须有一条记忆被写进来").toHaveLength(1);
    expect(all[0].scope, "落成对话级").toBe("conversation");
    expect(all[0].sessionId, "归属当前会话").toBe(SESSION);
    expect(
      svc.buildMemoryPrompt("conversation", PROJ_A, SESSION),
      "直接生效 ⇒ 立刻进这个对话的上下文",
    ).toContain("这次先给方案再改代码");
  });

  it("MAS-3：`scope: project` ⇒ 项目级 + 待批准（未批准不进上下文）", async () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "测试入口", content: "跑测试用 npx vitest run（项目级事实）", scope: "project" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    const pending = svc.listPending(undefined, { projectId: PROJ_A, sessionId: SESSION });
    expect(pending, "项目级必须进待批准区").toHaveLength(1);
    expect(pending[0].scope).toBe("project");
    expect(pending[0].projectId).toBe(PROJ_A);
    expect(
      svc.buildMemoryPrompt("project", PROJ_A, SESSION),
      "未批准 ⇒ 不进上下文",
    ).not.toContain("跑测试用 npx vitest run");
  });

  it("MAS-4：没有 scope 字段（老提示词产物）/ 写了别的词 ⇒ **对话级 + 直接生效**（兜底方向）", async () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([
        { key: "没说作用域", content: "老提示词的产物，没有 scope 字段（拿不准 ⇒ 对话级）" },
        { key: "说了个新词", content: "scope 写成了别的词（同样拿不准 ⇒ 对话级）", scope: "workspace" },
      ]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    /*
     * 兜底方向是**用户 2026-10-10 选定**的：拿不准 ⇒ 对话级（少弹批准）。
     * 与"fail-closed 归项目级"相比，它的爆炸半径更小（只在那一个对话里注入），
     * 且模型**明说** project 时仍然进待批准区（MAS-3 钉着那一半）。
     */
    expect(
      svc.listPending(undefined, { projectId: PROJ_A, sessionId: SESSION }),
      "拿不准的一律归对话级 ⇒ 不进待批准区",
    ).toHaveLength(0);
    const all = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION });
    expect(all.map((e) => e.scope).sort(), "两条都应当落成对话级").toEqual(["conversation", "conversation"]);
    expect(all.every((e) => e.sessionId === SESSION), "归属当前会话").toBe(true);
    expect(
      svc.buildMemoryPrompt("conversation", PROJ_A, SESSION),
      "直接生效 ⇒ 立刻进这个对话的上下文",
    ).toContain("拿不准 ⇒ 对话级");
  });

  it("MAS-5：模型写了 `platform` ⇒ 落成项目级；其余拿不准的一律对话级", async () => {
    expect(memoryScopeFromExtraction("platform"), "平台级只能手写：自动提取即便说了 platform 也按项目级落").toBe(
      "project",
    );
    expect(memoryScopeFromExtraction("project"), "模型明说跨对话仍成立 ⇒ 项目级（需批准）").toBe("project");
    expect(memoryScopeFromExtraction("conversation")).toBe("conversation");
    /* 兜底：拿不准的一律对话级（用户选定；与"明说 project"那一半互为反向对照） */
    expect(memoryScopeFromExtraction(undefined), "没给 scope ⇒ 对话级").toBe("conversation");
    expect(memoryScopeFromExtraction(42), "不是字符串 ⇒ 对话级").toBe("conversation");
    expect(memoryScopeFromExtraction("Platform"), "大小写不同（不是我们认的那个字面量）⇒ 对话级").toBe("conversation");

    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "全局约定", content: "模型说这是平台级事实（内容一条不丢，只是作用域更窄）", scope: "platform" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    const all = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION });
    expect(all, "内容不许丢").toHaveLength(1);
    expect(all[0].scope, "必须落成项目级").toBe("project");
    expect(all[0].projectId, "归属当前项目").toBe(PROJ_A);
    expect(
      svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION }).some((e) => e.scope === "platform"),
      "全库都不该因此多出一条平台级自动记忆",
    ).toBe(false);
  });

  it("MAS-6（反向对照）：用户把「对话」也改成需批准之后，**连拿不准的那些**也要回到待批准区", async () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: true }));
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([
        { key: "这次先给方案", content: "用户关掉了对话级的免审批（必须问我一次）", scope: "conversation" },
        { key: "没说作用域", content: "拿不准 ⇒ 对话级（也要按对话档的开关走）" },
      ]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    const pending = svc.listPending(undefined, { projectId: PROJ_A, sessionId: SESSION });
    expect(pending.map((p) => p.key).sort(), "开关是用户手动打开的 ⇒ 必须尊重（两条都进待批准）").toEqual([
      "没说作用域",
      "这次先给方案",
    ]);
    expect(pending.every((p) => p.scope === "conversation")).toBe(true);
    expect(svc.buildMemoryPrompt("conversation", PROJ_A, SESSION), "未批准不进上下文").not.toContain("必须问我一次");
  });

  it("MAS-7（反向对照）：对话级自动记忆只进那个对话的上下文，别的对话看不到", async () => {
    setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "只属于本次对话", content: "这条只该在当前对话里出现", scope: "conversation" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.buildMemoryPrompt("conversation", PROJ_A, SESSION)).toContain("只该在当前对话里出现");
    expect(
      svc.buildMemoryPrompt("conversation", PROJ_A, OTHER_SESSION),
      "别的对话不许看到（否则「对话级」就是一句空话）",
    ).not.toContain("只该在当前对话里出现");
    expect(svc.buildMemoryPrompt("project", PROJ_A), "也不许混进项目级注入").not.toContain("只该在当前对话里出现");
  });
});

describe("MEM-BATCH：批量同意 / 批量拒绝（服务层）", () => {
  /** 造 n 条项目级待批准条目 */
  function seedPending(svc: MemoryService, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = svc.add({
        scope: "project",
        projectId: PROJ_A,
        key: `待审 ${i}`,
        content: `待批准内容 ${i}（长度足够以便入库）`,
        source: "auto",
        status: "pending",
        batchId: "batch-196",
      });
      if (r.entry) ids.push(r.entry.id);
    }
    return ids;
  }

  it("MB-1：批量批准多条，且**只落库一次**（写放大：N 条 ≠ N 次整份写）", async () => {
    const svc = new MemoryService();
    const ids = seedPending(svc, 3);
    /* 落库是**排队异步**的（`save()` 只同步改镜像，写穿在确认链上）⇒ 必须等它落地再数 */
    await svc.flushPendingPersist();
    const before = memoryWrites();
    const r = svc.approveMany(ids);
    await svc.flushPendingPersist();

    expect(r.changed, "三条都要被批准").toBe(3);
    expect(r.persisted, "落库必须成功").toBe(true);
    expect(
      memoryWrites() - before,
      "批量操作只许落库一次（逐条 approve 会是 3 次整份写 —— 这正是要避免的放大）",
    ).toBe(1);
    expect(svc.listPending(undefined, { projectId: PROJ_A }), "批准后待批准区应为空").toHaveLength(0);
    expect(
      svc.buildMemoryPrompt("project", PROJ_A, SESSION),
      "批准后才进上下文",
    ).toContain("待批准内容 0");
    expect(r.message, "回执要说清做了几件事").toContain("3");
  });

  it("MB-2：批量拒绝多条，也只落库一次；条目真的被删掉", async () => {
    const svc = new MemoryService();
    const ids = seedPending(svc, 4);
    await svc.flushPendingPersist();
    const before = memoryWrites();
    const r = svc.rejectMany(ids);
    await svc.flushPendingPersist();

    expect(r.changed).toBe(4);
    expect(memoryWrites() - before, "同样只落库一次").toBe(1);
    expect(svc.get(ids[0]), "条目必须真的没了").toBeUndefined();
    expect(svc.listPending(undefined, { projectId: PROJ_A })).toHaveLength(0);
    expect(svc.buildMemoryPrompt("project", PROJ_A, SESSION), "被拒绝的内容永不进上下文").not.toContain("待批准内容 3");
  });

  it("MB-3（反向对照）：不在待批准状态的 id 被跳过并计数，不许被改动", () => {
    const svc = new MemoryService();
    const pendingIds = seedPending(svc, 2);
    // 一条已生效的自动条目 + 一条手动条目：都不该被"批量批准"动到（也不需要批准）
    const active = svc.add({ scope: "project", projectId: PROJ_A, key: "已生效", content: "已生效的自动条目内容", source: "auto" });
    const manual = svc.add({ scope: "project", projectId: PROJ_A, key: "手写", content: "手动条目内容（永远不需要批准）", source: "manual" });

    const approve = svc.approveMany([...pendingIds, active.entry!.id, manual.entry!.id, "不存在的-id"]);
    expect(approve.changed, "只批准那两条待审的").toBe(2);
    expect(approve.skipped, "已生效 / 手动 / 不存在：共 3 条被跳过").toBe(3);
    expect(svc.get(manual.entry!.id)!.status ?? "active", "手动条目一个字都不许动").toBe("active");
    expect(svc.get(manual.entry!.id)!.content).toBe("手动条目内容（永远不需要批准）");

    // 反向对照的另一半：拒绝也不许碰非待批准条目
    const reject = svc.rejectMany([active.entry!.id, manual.entry!.id]);
    expect(reject.changed, "已生效的自动条目不属于待批准 ⇒ 不许被批量拒删除掉").toBe(0);
    expect(reject.skipped).toBe(2);
    expect(svc.get(active.entry!.id), "它必须还在").toBeTruthy();
    expect(svc.get(manual.entry!.id), "手动条目必须还在").toBeTruthy();
  });

  it("MB-4：空数组 ⇒ 不落库、不改动（空操作不许写库）", () => {
    const svc = new MemoryService();
    seedPending(svc, 1);
    const before = memoryWrites();
    const a = svc.approveMany([]);
    const r = svc.rejectMany([]);
    expect(a.changed).toBe(0);
    expect(r.changed).toBe(0);
    expect(memoryWrites() - before, "什么都没动就不该写库").toBe(0);
    expect(svc.listPending(undefined, { projectId: PROJ_A }), "待批准条目必须原样还在").toHaveLength(1);
  });

  it("MB-5：容量已满的桶 ⇒ 逐条拒绝并计数，其余照常批准", async () => {
    /*
     * 「桶已满」怎么造：`add` 在桶满时**根本写不进去**（它按 `>=` 拒），
     * 所以只能先按大上限写进去，再用**更小的上限**重新加载同一份数据 ——
     * 这正是生产里"上限被调小 / 导入进来的条目超过上限"的形态（`approve` 的判据是 `>`）。
     */
    const wide = new MemoryService({ maxEntries: 10 });
    wide.add({ scope: "project", projectId: PROJ_A, key: "占位", content: "把桶占满的那一条（已生效）", source: "manual" });
    const p1 = wide.add({
      scope: "project",
      projectId: PROJ_A,
      key: "待审 1",
      content: "待批准 1（桶已满，批准会被拒）",
      source: "auto",
      status: "pending",
    });
    const p2 = wide.add({
      scope: "project",
      projectId: PROJ_A,
      key: "待审 2",
      content: "待批准 2（同样会被拒）",
      source: "auto",
      status: "pending",
    });
    expect(p1.ok && p2.ok, "前提：先按足够大的上限把它们写进去").toBe(true);
    await wide.flushPendingPersist();

    const svc = new MemoryService({ maxEntries: 1 }); // 同一份数据、更小的上限 ⇒ 桶超限
    expect(
      svc.listPending(undefined, { projectId: PROJ_A }),
      "前提：新实例必须读到了那两条待批准",
    ).toHaveLength(2);

    const r = svc.approveMany([p1.entry!.id, p2.entry!.id]);
    expect(r.changed, "桶已满 ⇒ 一条都不该被批准").toBe(0);
    expect(r.capacityBlocked, "两条都要如实计入容量拒绝").toBe(2);
    expect(r.message, "回执要能读懂（点名容量）").toMatch(/容量/);
  });
});
