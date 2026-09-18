/**
 * 第 47 轮补：三份只读审计报出的**可复现缺陷**的回归契约
 *
 * 每一组都对应一个"改前会红"的具体缺陷；用例里写清**改前的形态**是什么，
 * 而不是只断言改后的样子。
 *
 * | 组 | 缺陷（改前） | 来源 |
 * | --- | --- | --- |
 * | `AUD47-1` | `slice(-0) === slice(0)`：保留数为 0 时把**整个会话**算进待删集 | 功能上下文审计 P1 |
 * | `AUD47-2` | `latestSeq()` 把**未落库的占位 seq**（≈9.007e15）当水位，增量投影从此读不到真实事件 | 通信链路审计 P1 |
 * | `AUD47-3` | 事件镜像加载的合并判据看 seq 数值，`reconcile` 之后就匹配不上 → **已落库的事件被丢掉** | 通信链路审计 P1 |
 * | `AUD47-4` | `forkSession` 的写入缺省 `mode:"insert"`（裸 INSERT）→ 回退路径先建行、再补谱系时**撞主键，谱系丢失** | 功能上下文审计 P1 |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

type Row = Record<string, unknown>;
let port: FakeStoragePort;

beforeEach(() => {
  setStoragePort(null);
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

// ==========================================================================
// AUD47-1：压缩保留数不许是 0（`slice(-0)` 会清空整个会话）
// ==========================================================================

describe("AUD47-1：压缩的保留数下限（slice(-0) 陷阱）", () => {
  it("标记正好是最后一条消息时，保留数必须是 1（不是 0）", async () => {
    const { foldStaleCompactionMarkers } = await import("../core/llm/compaction-budget");

    /*
     * 造出触发形态：**最后一条就是压缩标记**。
     *
     * 改前：`keep = messages.length - (i + 1)` 取到 `i === len-1` → `keep = 0`，
     * 而调用方写的是 `messages.slice(-keepCount)` —— JS 里 `slice(-0) === slice(0)`，
     * 于是"保留 0 条"变成"保留全部"，`messages.slice(0, len - 0)` 变成"删掉全部"：
     * **一次压缩把整个会话的可见历史全隐藏**，只留一条有损摘要。
     *
     * 触发前提窄但不荒唐：标记判据是"user 行且正文以 `[上下文已自动压缩]` 开头"，
     * 用户把摘要正文粘回对话就会造出来。
     */
    const messages = [
      { id: "u1", role: "user", content: "第一问", timestamp: 1 },
      { id: "a1", role: "assistant", content: "第一答", timestamp: 2 },
      { id: "u2", role: "user", content: "第二问", timestamp: 3 },
      { id: "a2", role: "assistant", content: "第二答", timestamp: 4 },
      { id: "m1", role: "user", content: "[上下文已自动压缩]\n（摘要）", timestamp: 5 },
    ];

    const out = foldStaleCompactionMarkers(messages as any[], 2);

    expect(
      out.keepCount,
      "保留数绝不能是 0 —— 调用方的 slice(-0) 会把整段历史都算进待删集",
    ).toBeGreaterThan(0);

    // 用调用方的算法验证后果：待删集不许等于全部
    const toRemove = messages.slice(0, messages.length - out.keepCount);
    expect(
      toRemove.length,
      "改前这里会是 5（= 全部）—— 一次压缩清空会话",
    ).toBeLessThan(messages.length);
    expect(out.keepCount, "摘要本身必须保留（否则以后没法级联）").toBeGreaterThanOrEqual(1);
  });

  it("正常形态不受影响：标记在中间时仍然按标记之后保留", async () => {
    const { foldStaleCompactionMarkers } = await import("../core/llm/compaction-budget");
    const messages = [
      { id: "u1", role: "user", content: "旧问", timestamp: 1 },
      { id: "m1", role: "user", content: "[上下文已自动压缩]\n（摘要）", timestamp: 2 },
      { id: "u2", role: "user", content: "新问", timestamp: 3 },
      { id: "a2", role: "assistant", content: "新答", timestamp: 4 },
    ];
    const out = foldStaleCompactionMarkers(messages as any[], 2);
    expect(out.keepCount, "标记之后有 2 条 → 保留 2").toBe(2);
    expect(out.existingSummary, "级联摘要要取到").toContain("摘要");
  });
});

// ==========================================================================
// AUD47-2 / AUD47-3：事件镜像的两个"静默丢事件 / 假水位"缺陷
// ==========================================================================

describe("AUD47-2/3：事件镜像的占位与合并", () => {
  async function mirrorForTests() {
    const { __eventMirrorForTests } = await import("../core/storage/rust-port");
    return __eventMirrorForTests();
  }

  it("AUD47-2: 未落库的占位**不许**当水位（latestSeq 不能返回 ~9e15）", async () => {
    const mirror = await mirrorForTests();

    // 一条已落库的真实事件
    mirror.seedReal("s1", 7);
    expect(mirror.latestSeq("s1"), "基线：真实水位 7").toBe(7);

    // 一次**失败**的追加：占位进了镜像，但永远不会被 reconcile
    mirror.appendLocal("s1", "user_message", "{}", 1);

    expect(
      mirror.latestSeq("s1"),
      "改前这里返回约 9.007e15 —— 增量投影（readFrom(last+1)）此后再也读不到任何真实事件",
    ).toBe(7);
    expect(mirror.pendingPlaceholderCount("s1"), "未落库的占位要能被数出来").toBe(1);
  });

  it("AUD47-3: reconcile 之后合并**不许**把那条事件丢掉", async () => {
    const mirror = await mirrorForTests();

    // 本地追加（还没落库）
    const evt = mirror.appendLocal("s1", "assistant_text", '{"messageId":"m9"}', 1);

    /*
     * 制造"reconcile 抢在合并之前"的时序（审计点名的那个竞态）：
     * 引擎回传真实 seq 12，而 `loadSession` 的分页是在这次 INSERT **之前**发出的 ——
     * 所以分页里没有 seq 12。
     */
    mirror.reconcile("s1", evt.seq, 12);

    // 现在跑一次"合并"：分页只有 1..5
    mirror.mergeLoaded("s1", [1, 2, 3, 4, 5]);

    const seqs = mirror.seqs("s1");
    expect(
      seqs,
      "改前 seq=12 那条既不在分页里、又因 pending 判据失效被过滤 → **永久消失**",
    ).toContain(12);
    expect(seqs, "分页内容也要在").toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
    expect(seqs, "顺序必须按 seq 升序").toEqual([...seqs].sort((a, b) => a - b));
  });

  it("AUD47-3b: 仍未落库的占位在合并后必须留着（代表它确实发生过）", async () => {
    const mirror = await mirrorForTests();

    mirror.appendLocal("s1", "user_message", "{}", 1);
    mirror.mergeLoaded("s1", [1, 2, 3]);

    expect(mirror.pendingPlaceholderCount("s1"), "占位留在镜像里").toBe(1);
    expect(mirror.seqs("s1").length, "分页 3 条 + 占位 1 条").toBe(4);
  });
});

// ==========================================================================
// AUD47-6：分叉下标的换算（P0 —— 窗口下标 ≠ 会话内绝对下标）
// ==========================================================================

describe("AUD47-6：分叉下标换算（P0 的核心算术）", () => {
  const msg = (id: string, timestamp: number) => ({ id, timestamp });

  /** 造一个 n 条消息的会话 */
  const session = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${i}`, 1000 + i));

  it("100 条会话只装载了最后 10 条时，窗口下标 9 必须换算成 100（不是 10）", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    const all = session(100);
    const window = all.slice(-10); // loadMessages 的形态：只有最后 10 条

    const r = resolveSessionAbsoluteIndex("s1", 9, window, () => all);

    /*
     * 改前：`store.forkSession(sid, 9)` 直接拿 9 当绝对下标 → 从"第 9 条所在的这一轮"
     * 往回切 = **会话开头那一小段**（约 10 条），而不是分叉点之前的 90 条。
     * 用户拿到内容完全不对的新会话。
     *
     * 换算后的正确值：窗口首条（全量第 90 条）+ 窗口下标 9 = **99**
     * （= 会话最后一条；`forkSession` 会复制 `[0, 99]` 这一整段）。
     */
    expect(
      r.absoluteIndex,
      "必须换算成 99（= 最后一条的绝对位置），改前这里会是 9（会话开头那一小段）",
    ).toBe(99);
    expect(r.offset, "被截断掉的历史条数").toBe(90);
    expect(r.shifted, "确实发生了换算").toBe(true);
  });

  it("短会话（≤10 条）不受影响：偏移为 0、下标不变", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    const all = session(6);
    const r = resolveSessionAbsoluteIndex("s1", 3, all, () => all);
    expect(r.absoluteIndex, "窗口就是全部 → 下标不变（这也是它以前看起来正常的原因）").toBe(3);
    expect(r.offset).toBe(0);
    expect(r.shifted).toBe(false);
  });

  it("前插分页之后仍然算得对（窗口首条往前移了）", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    const all = session(100);
    // 用户向上滚了一次：窗口变成"第 60 条到第 99 条"（40 条）
    const window = all.slice(60);
    expect(resolveSessionAbsoluteIndex("s1", 0, window, () => all).absoluteIndex).toBe(60);
    expect(
      resolveSessionAbsoluteIndex("s1", 39, window, () => all).absoluteIndex,
      "窗口最后一条 = 会话最后一条 → 绝对下标 99（0 基的第 99 条，也是第 100 条的位置）",
    ).toBe(99);
  });

  it("中途删过消息也按'比窗口首条更旧的还有几条'算（不靠总数减窗口长）", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    // 原始 100 条，删掉中间 20 条 → 现存 80 条；窗口是最后 10 条
    const all = session(100).filter((m) => !(m.timestamp >= 1040 && m.timestamp < 1060));
    expect(all.length).toBe(80);
    const window = all.slice(-10);
    const r = resolveSessionAbsoluteIndex("s1", 5, window, () => all);
    expect(r.offset, "比窗口首条更旧的有 70 条").toBe(70);
    expect(r.absoluteIndex).toBe(75);
  });

  it("读不到全量列表（端口未就绪）→ 保持原下标，**不猜**一个更大的数", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    const window = session(10);
    const r = resolveSessionAbsoluteIndex("s1", 9, window, () => {
      throw new Error("端口未注册");
    });
    expect(
      r.absoluteIndex,
      "猜大 = 多复制用户以为已经排除掉的内容；宁可保持旧行为",
    ).toBe(9);
    expect(r.shifted).toBe(false);
  });

  it("空窗口 / 全量为空 → 保持原下标（没有可用锚点）", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    expect(resolveSessionAbsoluteIndex("s1", 4, [], () => session(10)).absoluteIndex).toBe(4);
    expect(resolveSessionAbsoluteIndex("s1", 4, session(10), () => []).absoluteIndex).toBe(4);
  });

  it("下标不许越过全量长度（夹取）", async () => {
    const { resolveSessionAbsoluteIndex } = await import("../core/session/fork-index");
    const all = session(20);
    const r = resolveSessionAbsoluteIndex("s1", 999, all.slice(-10), () => all);
    expect(r.absoluteIndex, "夹到全量长度").toBe(20);
  });
});

// ==========================================================================
// AUD47-5：记录端不许在"恢复还没读到键"之前把它写成 null
// ==========================================================================

describe("AUD47-5：记录端与恢复端的启动竞态", () => {
  const settingRow = (key: string, value: unknown) => ({ key, value: JSON.stringify(value) });
  const sessionRow = (id: string, projectId = "") => ({
    id,
    project_id: projectId,
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
  });

  it("恢复尚未定论时，记录端必须**保留**键（不许写 null）", async () => {
    const prefs = await import("../core/session/preferences");
    prefs.__resetRestoreSettledForTests();

    /*
     * 真机抓到的形态（1.16.70 复核）：
     * 记录端与恢复端**在同一次 commit 里**跑，而恢复端的第一次读是**异步**的。
     * 于是"记录端先跑、`currentSession` 还是 null"时会写 `writeLastSessionId(null)`，
     * 等恢复端真正读键时已经读不到 → 安静返回 `no-key` → **用户的"上次会话"永久丢失**。
     *
     * 判据：恢复没定论之前，记录端应该问 `shouldPreserveLastSessionKey()` 并**跳过写**。
     */
    expect(
      prefs.shouldPreserveLastSessionKey(),
      "刚启动、恢复还没跑 → 必须保留",
    ).toBe(true);

    // 恢复跑完（这里用"没有键"这一支：最明确的结论）
    prefs.resolveRestoreTarget();
    expect(
      prefs.shouldPreserveLastSessionKey(),
      "恢复已有明确结论 → 记录端可以照常工作",
    ).toBe(false);
  });

  it("定论之后**有会话**时照常记录（用户真的打开了一个会话）", async () => {
    const prefs = await import("../core/session/preferences");
    prefs.__resetRestoreSettledForTests();
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const p = createFakeStoragePort({
      seed: {
        settings: [settingRow("codem-last-session", "s1")],
        sessions: [sessionRow("s1")],
      },
    });
    await p.config.warmup();
    setStoragePort(p);

    const target = prefs.resolveRestoreTarget();
    expect(target.session?.id, "恢复真的拿到了目标").toBe("s1");
    expect(prefs.shouldPreserveLastSessionKey(), "定论之后不再保留").toBe(false);

    // 记录端照常写（切换会话的路径）
    prefs.writeLastSessionId("s2");
    expect(prefs.readLastSessionId()).toBe("s2");
    setStoragePort(null);
  });

  it("镜像未就绪那一支同样是**定论**（键保住 + 记录端解锁，允许重试）", async () => {
    const prefs = await import("../core/session/preferences");
    prefs.__resetRestoreSettledForTests();
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const p = createFakeStoragePort({
      seed: { settings: [settingRow("codem-last-session", "s-unavail")] },
      neverReady: ["sessions"],
    });
    await p.config.warmup();
    setStoragePort(p);

    const target = prefs.resolveRestoreTarget();
    expect(target.reason).toBe("storage-unavailable");
    // 键必须还在（这是 PREF-D20-14 守的那条）
    const row = p.__table("settings").find((r) => r.key === "codem-last-session");
    expect(String(row!.value), "读不到 ≠ 已删除：键必须保住").toBe(JSON.stringify("s-unavail"));
    // 而记录端不该被永久锁住（`unavailable` 是可重试的）
    expect(prefs.shouldPreserveLastSessionKey(), "已经读过一次了 → 不再阻塞记录端").toBe(false);
    setStoragePort(null);
  });
});

describe("AUD47-4：forkSession 必须 upsert（不许裸 INSERT）", () => {
  const sessionRow = (id: string, over: Row = {}): Row => ({
    id,
    project_id: "",
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
    ...over,
  });

  it("目标行**已经存在**时也要写成功，且 parent_id 落库（回退路径的真实形态）", async () => {
    port = createFakeStoragePort({
      seed: {
        sessions: [
          sessionRow("src"),
          // 「编辑并回退」会先 createSession 建出这一行 —— 于是后面的 fork 写是"第二次写同一 id"
          sessionRow("child", { title: "Rewind: src" }),
        ],
      },
    });
    await port.config.warmup();
    setStoragePort(port);

    const { forkSession } = await import("../core/storage/session");
    const child = forkSession("src", "child", "", "Rewind: src");

    expect(child, "forkSession 必须有返回值").toBeTruthy();

    /*
     * 改前：写入缺省 `mode:"insert"` → 裸 INSERT 撞主键 → 整笔失败 → `parent_id` 从没写进去。
     * 而它**以假成功呈现**（镜像先更新、失败只走旁路），所以这里必须断言
     * **引擎收到的命令与模式**，而不是只看返回值。
     */
    const write = port
      .__writes()
      .find(
        (w) =>
          w.command === "crud.upsert" &&
          (w.params as any)?.table === "sessions" &&
          Array.isArray((w.params as any)?.rows) &&
          ((w.params as any).rows as Row[]).some((r) => r.id === "child"),
      );
    expect(write, "必须真的发出 sessions 的 upsert").toBeTruthy();
    expect(
      (write!.params as any).mode,
      "必须是 replace（引擎侧才走 UPDATE-命中则更新 / 否则 INSERT）；insert 会撞主键",
    ).toBe("replace");
    expect(
      ((write!.params as any).rows as Row[]).find((r) => r.id === "child")?.parent_id,
      "谱系（session_trace 的唯一数据源）必须带上",
    ).toBe("src");
  });
});
