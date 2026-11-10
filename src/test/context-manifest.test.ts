/**
 * C03 / C04：Context Manifest —— 每次请求的上下文清单、两次请求的差异、按 id 还原。
 *
 * 守什么：
 * 1. 清单里**有** messageIds（顺序保持）、四类来源字符、预算与段信息；
 * 2. 两次请求能算出 added / removed / 段变化 / cutoff 变化 / 来源与 token 差；
 * 3. 还原时**缺失的 id 必须如实列出**（不假装还原完整）；
 * 4. 真循环里真的会留下清单（内存环 + settings），且**不写事件**（反向断言）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildContextManifest,
  diffManifests,
  flushManifests,
  forgetManifests,
  listManifests,
  loadManifests,
  recordManifest,
  replayManifest,
} from "../core/context/manifest";
import { getSetting, getSettingJSON, setSetting, setSettingJSON } from "../core/storage/settings";

describe("context manifest（C03/C04）", () => {
  const messages = [
    { id: "s1", role: "system", content: "system prompt" },
    { id: "m1", role: "user", content: "你好" },
    { id: "t1", role: "tool", content: "tool result" },
    { id: "m2", role: "assistant", content: "回答" },
  ];

  it("CM-1: 记录消息 id 顺序、四类来源字符、预算与段", () => {
    const manifest = buildContextManifest({
      sessionId: "s",
      at: 1000,
      segmentSeq: 2,
      epochId: "compact-1",
      cutoffMessageId: "m1",
      pressure: 0.75,
      budgetTokens: 128000,
      estimatedTokens: 32000,
      messages,
    });
    expect(manifest.messageIds).toEqual(["s1", "m1", "t1", "m2"]);
    expect(manifest.sources.system).toBe("system prompt".length);
    expect(manifest.sources.tool).toBe("tool result".length);
    expect(manifest.sources.chat).toBe("你好".length + "回答".length);
    expect(manifest).toMatchObject({ segmentSeq: 2, epochId: "compact-1", cutoffMessageId: "m1", budgetTokens: 128000 });
  });

  it("CM-2: 两次请求的差异（新增/移除/段/cutoff/来源/token）", () => {
    const before = buildContextManifest({ sessionId: "s", at: 1, segmentSeq: 1, messages: messages.slice(0, 2), estimatedTokens: 10 });
    const after = buildContextManifest({
      sessionId: "s",
      at: 2,
      segmentSeq: 2,
      cutoffMessageId: "m2",
      messages: messages.slice(2),
      estimatedTokens: 30,
    });
    const diff = diffManifests(before, after);
    expect(diff.removedIds).toEqual(["s1", "m1"]);
    expect(diff.addedIds).toEqual(["t1", "m2"]);
    expect(diff.segmentChanged).toBe(true);
    expect(diff.cutoffChanged).toBe(true);
    expect(diff.tokenDelta).toBe(20);
    expect(diff.sourcesDelta.tool).toBe("tool result".length);
  });

  it("CM-3: 按 id 还原时，缺失的 id 如实列出（不假装完整）", () => {
    const manifest = buildContextManifest({ sessionId: "s", messages });
    const store = new Map(messages.map((m) => [m.id, m]));
    const replay = replayManifest(manifest, (id) => store.get(id) ?? null);
    expect(replay.messages.map((m) => m.id)).toEqual(["s1", "m1", "t1", "m2"]);
    expect(replay.missingIds).toEqual([]);

    store.delete("t1");
    const partial = replayManifest(manifest, (id) => store.get(id) ?? null);
    expect(partial.messages).toHaveLength(3);
    expect(partial.missingIds, "被删/被裁剪的消息必须报缺失").toEqual(["t1"]);
  });

  it("CM-4: 非法输入收敛（段号归 1、token 归 0、缺 id 不计入）", () => {
    const manifest = buildContextManifest({
      sessionId: "s",
      segmentSeq: -3,
      pressure: Number.NaN,
      budgetTokens: Number.NaN,
      messages: [{ role: "user", content: "x" }, { id: "", role: "user", content: "y" }],
    });
    expect(manifest.segmentSeq).toBe(1);
    expect(manifest.pressure).toBe(0);
    expect(manifest.budgetTokens).toBe(0);
    expect(manifest.messageIds).toEqual([]);
  });
});

describe("manifest 事件接线（C04）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("CM-5: 真循环会留下请求清单（内存环形 + 不写事件）", async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    const { getEventLog } = await import("../core/storage/event-log");

    const S = "s-manifest";
    const port = createFakeStoragePort({
      seed: { sessions: [{ id: S, project_id: "p1", title: "t", created_at: 1, last_message_at: 2, message_count: 0 }] },
    });
    setStoragePort(port as never);
    getTokenTracker().setContextWindow(24_000);
    try {
      port.data.execute("crud.upsert", {
        table: "messages",
        rows: [
          { id: "mf-1", session_id: S, role: "user", content: "你好", timestamp: 1, status: "done", hidden: 0 },
          { id: "mf-2", session_id: S, role: "assistant", content: "在", timestamp: 2, status: "done", hidden: 0 },
        ],
        mode: "replace",
      });
      const provider = {
        id: "p", name: "p", isConfigured: () => true,
        async *stream() { yield { type: "text_delta", text: "好" }; yield { type: "end", finishReason: "stop" }; },
        async complete() { return { content: "" }; },
        async listModels() { return []; }, async fetchModelsFromServer() { return []; },
      };
      const loop = new AgenticLoop(provider as never, createDefaultToolRegistry(), {
        maxIterations: 1, model: "m", securityMode: "full", contextWindow: 24_000, enableCompaction: false,
      });
      for await (const _event of loop.run(S, "测试", "C:\\repo", "sys")) void _event;

      const { listManifests } = await import("../core/context/manifest");
      const manifests = listManifests(S);
      expect(manifests.length, "至少一次请求要留下清单").toBeGreaterThan(0);
      const payload = manifests[manifests.length - 1];
      expect(Array.isArray(payload.messageIds)).toBe(true);
      expect(payload.messageIds.length).toBeGreaterThan(0);
      expect(payload.sources, "四类来源必须记录").toBeTruthy();
      expect(payload.budgetTokens).toBe(24_000);
      /* 关键回归：清单**不许**写成事件（事件总数会进模型可见前缀，D5 实测） */
      expect(getEventLog().readRange(S, 1, 500).some((e) => e.type === "context_manifest"), "清单不能写事件").toBe(false);
    } finally {
      setStoragePort(null);
      vi.restoreAllMocks();
    }
  });
});

/**
 * C03：**工作集数字**进清单（WS-6）。
 *
 * 守两件事：
 * 1. 传了 `workingSet` 就原样记录（并收敛成非负整数），没传就**不写这个字段**
 *    —— 「没走工作集」与「走了但移出 0 条」是不同的事实，清单必须能区分；
 * 2. 旧数据（该字段还不存在）仍能读回；字段存在但结构坏了 ⇒ 整批按坏数据拒绝
 *    （与清单其它字段同一条纪律：宁可没有数据，也不给会导出相反结论的半成品）。
 */
describe("C03：工作集数字进清单（WS-6）", () => {
  const S = "s-manifest-ws";
  const SETTING_KEY = `codem-context-manifests:${S}`;

  beforeEach(() => {
    forgetManifests(S);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    forgetManifests(S);
    vi.restoreAllMocks();
  });

  it("WS-6a: 传了就记录（非负整数）；没传就不写字段；坏值收敛不写 NaN", () => {
    const withWs = buildContextManifest({
      sessionId: S,
      at: 1,
      messages: [{ id: "m1", role: "user", content: "x" }],
      workingSet: { budgetTokens: 1234.9, selected: 3, evicted: 2, indexLines: 4 },
    });
    expect(withWs.workingSet).toEqual({ budgetTokens: 1234, selected: 3, evicted: 2, indexLines: 4 });

    const without = buildContextManifest({ sessionId: S, at: 2, messages: [] });
    expect("workingSet" in without, "没走工作集 ⇒ 字段必须不存在（不是 0）").toBe(false);

    const bad = buildContextManifest({
      sessionId: S,
      messages: [],
      workingSet: {
        budgetTokens: Number.NaN,
        selected: -1,
        evicted: Number.POSITIVE_INFINITY,
        indexLines: 1.7,
      },
    });
    expect(bad.workingSet, "NaN / 负数 / Infinity 一律收敛，不许写进 settings").toEqual({
      budgetTokens: 0,
      selected: 0,
      evicted: 0,
      indexLines: 1,
    });
  });

  it("WS-6b: 旧数据（没有该字段）能读回；字段存在但结构坏了 ⇒ 整批拒绝", async () => {
    recordManifest(
      buildContextManifest({
        sessionId: S,
        at: 10,
        messages: [{ id: "m1", role: "user", content: "hi" }],
        workingSet: { budgetTokens: 100, selected: 1, evicted: 0, indexLines: 0 },
      }),
    );
    await flushManifests(S);
    const persisted = getSettingJSON<any[]>(SETTING_KEY, []);
    expect(persisted[0]?.workingSet).toEqual({ budgetTokens: 100, selected: 1, evicted: 0, indexLines: 0 });

    /* 模拟重启：内存环清空、持久化还在 */
    forgetManifests(S);
    setSettingJSON(SETTING_KEY, persisted);
    expect(loadManifests(S)[0]?.workingSet).toEqual({
      budgetTokens: 100,
      selected: 1,
      evicted: 0,
      indexLines: 0,
    });

    /* ★ 旧数据（C03 之前的清单没有这个字段）⇒ 仍然读得回来 */
    forgetManifests(S);
    const legacy = persisted.map(({ workingSet: _dropped, ...rest }: any) => rest);
    setSettingJSON(SETTING_KEY, legacy);
    const loadedLegacy = loadManifests(S);
    expect(loadedLegacy, "旧清单不许因为缺新字段被整批丢掉").toHaveLength(1);
    expect(loadedLegacy[0].workingSet).toBeUndefined();
    expect(loadedLegacy[0].messageIds).toEqual(["m1"]);

    /* ★ 字段存在但结构坏了 ⇒ 整批 []（不允许「能用的先用」） */
    forgetManifests(S);
    setSettingJSON(SETTING_KEY, [{ ...persisted[0], workingSet: { budgetTokens: "很多" } }]);
    expect(loadManifests(S), "坏 workingSet 必须整批拒绝").toEqual([]);

    /* 负数同样算坏数据（非负是写入侧的不变量） */
    forgetManifests(S);
    setSettingJSON(SETTING_KEY, [
      { ...persisted[0], workingSet: { budgetTokens: 1, selected: 1, evicted: -1, indexLines: 0 } },
    ]);
    expect(loadManifests(S), "负数同样按坏数据拒绝").toEqual([]);
  });
});

/**
 * C04 补全：version / prefixHash / evictedIds / loadManifests / 删除清理。
 *
 * 这一组**走真循环**（不是只测纯函数）：`evictedIds` 由 `recordContextManifest`
 * 计算，纯函数测试抓不住「恒置 []」的变异。
 */
describe("manifest 记录补全（C04）：版本 / 前缀 / 淘汰 / 回读 / 删除清理", () => {
  const S = "s-manifest-c04";
  const SETTING_KEY = `codem-context-manifests:${S}`;
  let port: any;
  let loop: any;

  function fakeProvider() {
    return {
      id: "p",
      name: "p",
      isConfigured: () => true,
      async *stream() {
        yield { type: "text_delta", text: "好" };
        yield { type: "end", finishReason: "stop" };
      },
      async complete() {
        return { content: "" };
      },
      async listModels() {
        return [];
      },
      async fetchModelsFromServer() {
        return [];
      },
    };
  }

  async function runTurn(prompt: string): Promise<void> {
    for await (const _event of loop.run(S, prompt, "C:\\repo", "sys")) void _event;
  }

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { setStoragePort } = await import("../core/storage/port");
    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const { getTokenTracker } = await import("../core/llm/token-tracker");

    port = createFakeStoragePort({
      seed: { sessions: [{ id: S, project_id: "p1", title: "t", created_at: 1, last_message_at: 2, message_count: 0 }] },
    });
    setStoragePort(port as never);
    /* 清掉上一个用例可能留下的内存环与防抖定时器（settings 键此时也不存在） */
    forgetManifests(S);
    getTokenTracker().setContextWindow(24_000);
    port.data.execute("crud.upsert", {
      table: "messages",
      rows: [
        { id: "cm-1", session_id: S, role: "user", content: "你好", timestamp: 1, status: "done", hidden: 0 },
        { id: "cm-2", session_id: S, role: "assistant", content: "在", timestamp: 2, status: "done", hidden: 0 },
      ],
      mode: "replace",
    });
    loop = new AgenticLoop(fakeProvider() as never, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "m",
      securityMode: "full",
      contextWindow: 24_000,
      enableCompaction: false,
    });
  });

  afterEach(async () => {
    forgetManifests(S);
    const { setStoragePort } = await import("../core/storage/port");
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("CM-6: 第二份移除了某条 ⇒ evictedIds 正确；version=1；prefixHash 非空且同前缀稳定", async () => {
    await runTurn("第一轮");
    const firstList = listManifests(S);
    expect(firstList.length, "第一轮至少一份").toBeGreaterThan(0);
    const first = firstList[firstList.length - 1];
    expect(first.version, "schema 版本必须写入记录").toBe(1);
    expect(first.prefixHash, "system + 第一条 user 拿得到 ⇒ hash 非空").not.toBe("");
    expect(first.messageIds).toContain("cm-2");
    expect(first.evictedIds, "首份没有上一份可差 ⇒ 空数组").toEqual([]);
    /* 变异自证点：把首份 prefixHash 恒置 "" ⇒ 上一行红；把版本写错 ⇒ 版本断言红 */

    /**
     * 模拟「压缩把某条移出模型视图」：走消息软删（hidden=1，时间线仍保留）。
     * 第二份 manifest 不含 cm-2 ⇒ 相对第一份的淘汰集合必须含它。
     */
    port.data.execute("messages.delete", { ids: ["cm-2"], soft: true });
    await runTurn("第二轮");

    const secondList = listManifests(S);
    const second = secondList[secondList.length - 1];
    expect(second.version).toBe(1);
    expect(second.messageIds, "被移出视图的 id 不许再出现在第二份").not.toContain("cm-2");
    expect(second.evictedIds, "相对上一份被移出的 id 必须如实记录").toContain("cm-2");
    expect(second.prefixHash, "system + 第一条 user 没变 ⇒ 前缀摘要稳定").toBe(first.prefixHash);
  });

  it("CM-7: flushManifests 后清内存，loadManifests 能读回；坏 JSON / 旧版本返回 []", async () => {
    await runTurn("第一轮");
    await flushManifests(S);

    const persistedRaw = getSetting(SETTING_KEY);
    expect(persistedRaw, "落库必须真的写进 settings 键").not.toBeNull();
    const persisted = getSettingJSON<unknown[]>(SETTING_KEY, []);
    expect(Array.isArray(persisted) && persisted.length > 0).toBe(true);

    /* 清内存（与删会话同一入口；此时持久化键也会被删） */
    forgetManifests(S);
    expect(listManifests(S), "内存环必须被清掉").toHaveLength(0);
    expect(getSetting(SETTING_KEY), "forget 会删键（下一条模拟「另一个进程读回」）").toBeNull();

    /* 模拟重启：持久化还在，内存环为空 */
    setSetting(SETTING_KEY, JSON.stringify(persisted));
    const loaded = loadManifests(S);
    expect(loaded.length, "回读数量必须一致").toBe(persisted.length);
    expect(loaded[0]).toMatchObject({ version: 1, sessionId: S, prefixHash: expect.any(String) });
    expect(Array.isArray(loaded[0].messageIds)).toBe(true);
    expect(Array.isArray(loaded[0].evictedIds)).toBe(true);

    /* 坏 JSON ⇒ []（不猜、不部分恢复） */
    setSetting(SETTING_KEY, "{not-json");
    expect(loadManifests(S), "坏 JSON 必须返回空数组").toEqual([]);

    /* 版本不符 ⇒ []（旧结构不许被当成新数据） */
    setSettingJSON(SETTING_KEY, [{ ...loaded[0], version: 999 }]);
    expect(loadManifests(S), "版本不符必须返回空数组").toEqual([]);

    /* 结构不全 ⇒ 整批 []（不允许「能用的先用」） */
    setSettingJSON(SETTING_KEY, [loaded[0], { version: 1, sessionId: S }]);
    expect(loadManifests(S), "结构不全必须返回空数组").toEqual([]);
  });

  it("CM-8: 删会话后 settings 键消失、loadManifests 为空", async () => {
    await runTurn("第一轮");
    await flushManifests(S);
    expect(getSetting(SETTING_KEY), "删除前键必须存在（否则下面恒真）").not.toBeNull();

    const { deleteSession } = await import("../core/storage/session");
    deleteSession(S, { confirmBulk: true });

    expect(
      port.__table("settings").some((row) => row.key === SETTING_KEY),
      "settings 表里不许残留清单键",
    ).toBe(false);
    expect(getSetting(SETTING_KEY), "读口也必须是 null").toBeNull();
    expect(listManifests(S), "内存环必须一起清").toHaveLength(0);
    expect(loadManifests(S), "删后 loadManifests 必须为空").toEqual([]);
  });
});
