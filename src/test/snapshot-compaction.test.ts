/**
 * 事件日志的快照式压缩（第 77 波）
 *
 * 为什么需要：本地 SQLite 整库常驻内存 + 只能整库导出，表只增不减 → 库越大，
 * 每次保存的峰值越大 → 渲染进程 out of memory。`session_events` 是"只增不减"的典型
 * （本机实测 2130 行 / 3.8 MB）。
 *
 * 但**不能直接按 seq 截断**：上一波审计发现事件日志被投影当状态读取
 * （`event-projection` 4 处重建投影、`runtime-invariants` 靠回放查不变量、
 * preset-discovery / feedback / postmortem / time-context / session-search /
 * ui-trajectory / sync-engine 都在 readAll）。所以正确做法是：
 *   **先把投影状态固化成 `session_snapshot` 事件，再丢掉它之前的事件** ——
 *   回放 = 快照 + 其后事件，必须与完整回放**等价**。
 *
 * 本文件的核心就是那条等价性（SNAP-2）：它一旦不成立，"裁剪"就变成"悄悄改数据"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function installTauriStub(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { runDatabaseMaintenance } from "../core/storage/maintenance";
import { getEventLog } from "../core/storage/event-log";
import { getEventProjection } from "../core/storage/event-projection";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

/**
 * 夹具（第 18 轮，L1）：**端口播种**，不再初始化旧库。
 *
 * 原来是 `await initDatabase()` + 两条裸 SQL（`DELETE FROM session_events` 清表、
 * `INSERT OR REPLACE INTO sessions` 补 s1 父行）。
 *
 * - 清表：A 态（旧库是唯一数据源）已删 = 不存在了。`setup.ts` 每例注册一个**全新**端口，
 *   事件在里面本来就是空的；而且端口模式下事件写的是**端口**（`events.appendLocal`），
 *   清旧库那张表从来就没清到"读的那一份"。
 * - 父行：按端口语义播种（`seed.sessions`），并把 SNAP-5 需要的 `s2` 一并种上
 *   （原来它是在用例中途再插一条裸 SQL —— 那只是"让维护枚举得到两个会话"，
 *   现在两个父行都在端口上，语义等价）。
 */
beforeEach(() => {
  installTauriStub();
  setStoragePort(
    createFakeStoragePort({
      seed: {
        sessions: [
          { id: "s1", project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
          { id: "s2", project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
      },
    }),
  );
});

afterEach(() => {
  delete (window as any).__TAURI__;
});

/** 造一段有代表性的会话事件流：多轮 user → assistant(文本+工具调用) → tool_result */
function seedSession(sessionId: string, turns: number): void {
  const log = getEventLog();
  log.append(sessionId, "session_meta", { preset: "standard" });
  for (let i = 0; i < turns; i++) {
    log.append(sessionId, "user_message", { messageId: `u${i}`, content: `问题 ${i}` });
    log.append(sessionId, "assistant_text", { messageId: `a${i}`, content: `回答 ${i}` });
    log.append(sessionId, "tool_call", {
      messageId: `a${i}`,
      toolCallId: `tc${i}`,
      toolName: "bash",
      args: { command: `echo ${i}` },
    });
    log.append(sessionId, "tool_result", { toolCallId: `tc${i}`, content: `输出 ${i}` });
  }
}

describe("事件日志快照式压缩", () => {
  it("SNAP-1: 压缩会写入快照事件并删掉它之前的事件（session_meta 保留）", () => {
    seedSession("s1", 20);
    const log = getEventLog();
    const before = log.readAll("s1").length;
    expect(before).toBe(1 + 20 * 4);

    const projection = getEventProjection();
    const result = log.compactWithSnapshot("s1", (events) => ({ messages: projection.projectFromEvents(events) }));

    expect(result.snapshotSeq).toBeGreaterThan(0);
    expect(result.removedEvents).toBeGreaterThan(0);
    const after = log.readAll("s1");
    expect(after.length).toBeLessThan(before);
    expect(after.some((e) => e.type === "session_snapshot")).toBe(true);
    // 预设归属/反馈状态依赖这条，永不能删
    expect(after.filter((e) => e.type === "session_meta")).toHaveLength(1);
  });

  it("SNAP-2: **回放等价性** —— 压缩后投影与压缩前逐条一致（这条不成立，裁剪就是改数据）", () => {
    seedSession("s1", 25);
    const projection = getEventProjection();
    const beforeMessages = projection.projectAll("s1");
    expect(beforeMessages.length).toBeGreaterThan(0);

    getEventLog().compactWithSnapshot("s1", (events) => ({ messages: projection.projectFromEvents(events) }));
    const afterMessages = projection.projectAll("s1");

    expect(afterMessages.length).toBe(beforeMessages.length);
    expect(afterMessages.map((m) => [m.id, m.role, m.content])).toEqual(
      beforeMessages.map((m) => [m.id, m.role, m.content]),
    );
  });

  it("SNAP-3: 压缩后**新增事件照样能接上**（快照不会吞掉后续消息）", () => {
    seedSession("s1", 10);
    const projection = getEventProjection();
    const before = projection.projectAll("s1");

    getEventLog().compactWithSnapshot("s1", (events) => ({ messages: projection.projectFromEvents(events) }));

    // 压缩之后继续对话
    const log = getEventLog();
    log.append("s1", "user_message", { messageId: "u-new", content: "压缩之后的问题" });
    log.append("s1", "assistant_text", { messageId: "a-new", content: "压缩之后的回答" });

    const after = projection.projectAll("s1");
    expect(after.length).toBe(before.length + 2);
    expect(after[after.length - 2].content).toBe("压缩之后的问题");
    expect(after[after.length - 1].content).toBe("压缩之后的回答");
  });

  it("SNAP-4: keepEvents 可以保留最近若干条事件（细节与压缩兼顾）", () => {
    seedSession("s1", 30);
    const log = getEventLog();
    const projection = getEventProjection();

    const result = log.compactWithSnapshot(
      "s1",
      (events) => ({ messages: projection.projectFromEvents(events) }),
      { keepEvents: 8 },
    );

    expect(result.removedEvents).toBeGreaterThan(0);
    // 快照 + 保留的尾部事件（+ session_meta）
    const remaining = log.readAll("s1").filter((e) => e.type !== "session_meta");
    expect(remaining.length).toBe(9); // 8 条保留 + 1 条快照
  });

  /**
   * 这一段守的是 **B-2**：`cutoff_seq` 必须让"引擎侧真实删除"与"镜像侧乐观更新"**逐条一致**，
   * 而且**快照必须活下来**（它是这次压缩的全部意义）。
   *
   * ## 真引擎取证（第 20 轮，`codem-db-cli` 直跑，事件 seq 1..8、锚点 8、`snapshot_seq=8`）
   *
   * | `cutoff_seq` | 引擎返回 | 库内 `events.list` | 结论 |
   * | --- | --- | --- | --- |
   * | **9**（= 锚点+1，**原代码**） | `{"removed_events":7}` | `[session_meta@1]` | **快照被自己的删除命中，整段历史归零** |
   * | **8**（= 锚点，**修好之后**） | `{"removed_events":6}` | `[session_meta@1, session_snapshot@8]` | 快照活着 ✓ |
   * | 9007199254740991 | **报错**（`req_i64` 的 `as_i64()` 拿不到 f64） | 未执行 | "取个很大的数"这条路是死的 |
   *
   * 即：`cutoff_seq` 是 `seq < cutoff` 的**排他**上界，快照占着锚点的 seq，所以
   * `cutoff_seq = anchorSeq + 1` 会把它删掉，正确值是 `cutoff_seq = anchorSeq`。
   * 原注释正好记反了（"取锚点自己 → 快照被删"），所以这个 bug 才长期活着 ——
   * 加上假端口当时多两条豁免（比真引擎宽松），测试里根本看不见。
   */

  describe("SNAP-7/8（B-2）: cutoff_seq 与事件保留集合逐条对齐", () => {
    const makePort = (events: Array<Record<string, unknown>>) =>
      createFakeStoragePort({
        seed: {
          sessions: [
            { id: "s1", project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
          ],
          session_events: events,
        },
      });

    /**
     * 按 `repo.rs::events_compact` 的两条 SQL 推演"引擎侧会剩下什么"：
     * 1. `INSERT OR REPLACE` 快照到 `snapshotSeq`；
     * 2. `DELETE … WHERE seq < cutoffSeq AND event_type <> 'session_meta'`。
     */
    const engineKeptAfterCompact = (
      seeded: Array<Record<string, unknown>>,
      snapshotSeq: number,
      cutoffSeq: number,
    ): number[] =>
      Array.from(
        new Set(
          seeded
            .filter((r) => Number(r.seq) >= cutoffSeq || String(r.event_type) === "session_meta")
            .map((r) => Number(r.seq))
            .concat(snapshotSeq),
        ),
      ).sort((a, b) => a - b);

    it("SNAP-7: 无尾部事件（keepEvents 缺省）—— cutoff_seq 必须等于锚点，快照才活下来", () => {
      const seeded = [
        { seq: 1, session_id: "s1", event_type: "session_meta", payload: '{"preset":"std"}', timestamp: 1 },
        { seq: 2, session_id: "s1", event_type: "user_message", payload: '{"messageId":"u1"}', timestamp: 2 },
        { seq: 9, session_id: "s1", event_type: "assistant_text", payload: '{"messageId":"a1"}', timestamp: 9 },
      ];
      const port = makePort(seeded);
      setStoragePort(port);

      const log = getEventLog();
      const projection = getEventProjection();
      const result = log.compactWithSnapshot("s1", (evs) => ({ messages: projection.projectFromEvents(evs) }));

      const sent = (port as { __writes(): Array<{ command: string; params?: Record<string, unknown> }> })
        .__writes()
        .filter((w) => w.command === "events.compact");
      expect(sent.length, "这条形状下命令必须发出去").toBe(1);
      const snapshotSeq = Number(sent[0].params?.snapshot_seq);
      const cutoffSeq = Number(sent[0].params?.cutoff_seq);
      expect(snapshotSeq, "快照必须占锚点自己的 seq（最后一条事件）").toBe(9);
      expect(result.snapshotSeq).toBe(9);

      /**
       * 核心判据 ①：**不得命中快照**。
       *
       * 真引擎上 `seq < cutoff_seq` 是排他的，快照在 `seq = snapshotSeq`，
       * 所以 `cutoff_seq > snapshotSeq` 就等于"把快照自己删掉"（实测库内只剩 `session_meta`）。
       */
      expect(
        cutoffSeq,
        `cutoff_seq=${cutoffSeq} 不得 > 快照 seq=${snapshotSeq}` +
          "（真引擎实测：锚点+1 会让 DELETE 命中刚写的快照，库内只剩 session_meta）",
      ).toBe(snapshotSeq);

      const kept = log.readAll("s1").map((e) => Number(e.seq));
      expect(kept, "快照必须留在事件流里").toContain(snapshotSeq);

      const engineKept = engineKeptAfterCompact(seeded, snapshotSeq, cutoffSeq);
      expect(
        kept,
        `镜像留下的 [${kept.join(",")}] 与引擎会留下的 [${engineKept.join(",")}] 必须一致 ——` +
          " 不一致时 `readAll` 重新加载后读到的集合会突然变化（多出/少掉事件）",
      ).toEqual(engineKept);
    });

    it("SNAP-8: 有尾部事件时 cutoff_seq = 第一条被保留尾部事件的 seq（与引擎逐字等价）", () => {
      const seeded = [
        { seq: 1, session_id: "s1", event_type: "session_meta", payload: '{"preset":"std"}', timestamp: 1 },
        { seq: 2, session_id: "s1", event_type: "user_message", payload: '{"messageId":"u1"}', timestamp: 2 },
        { seq: 3, session_id: "s1", event_type: "assistant_text", payload: '{"messageId":"a1"}', timestamp: 3 },
        { seq: 4, session_id: "s1", event_type: "user_message", payload: '{"messageId":"u2"}', timestamp: 4 },
        { seq: 5, session_id: "s1", event_type: "assistant_text", payload: '{"messageId":"a2"}', timestamp: 5 },
      ];
      const port = makePort(seeded);
      setStoragePort(port);
      const log = getEventLog();
      const projection = getEventProjection();

      /** 保留最近 2 条尾部 → 锚点 = seq 3，第一条被保留的尾部事件是 seq 4 */
      const result = log.compactWithSnapshot(
        "s1",
        (evs) => ({ messages: projection.projectFromEvents(evs) }),
        { keepEvents: 2 },
      );
      const sent = (port as { __writes(): Array<{ command: string; params?: Record<string, unknown> }> })
        .__writes()
        .filter((w) => w.command === "events.compact");
      expect(sent.length).toBe(1);
      const snapshotSeq = Number(sent[0].params?.snapshot_seq);
      const cutoffSeq = Number(sent[0].params?.cutoff_seq);
      expect(snapshotSeq, "锚点 = 第 cutoffIndex 条之前的那条（seq 3）").toBe(3);
      expect(cutoffSeq, "上界 = 第一条被保留尾部事件的 seq（seq 4）").toBe(4);
      expect(result.snapshotSeq).toBe(3);

      const kept = log.readAll("s1").map((e) => Number(e.seq));
      const engineKept = engineKeptAfterCompact(seeded, snapshotSeq, cutoffSeq);
      expect(
        kept,
        `镜像留下的 [${kept.join(",")}] 与引擎会留下的 [${engineKept.join(",")}] 必须一致`,
      ).toEqual(engineKept);
      expect(kept, "快照必须留在事件流里（锚点位置换成快照）").toContain(snapshotSeq);
      expect(kept, "尾部事件原样保留").toEqual(expect.arrayContaining([4, 5]));
    });

    /**
     * ## 关于"锚点不是最高位"那条守卫（`event-log.ts` 里的 `anchorIsTop`）
     *
     * 它**在当前产品路径下不可达**，这一点如实记在这里，不要当成"已验证的保护"：
     *
     * - `readAll` 的两种实现都按 seq 排序返回（`rust-port.ts::RustEventMirror.readAll`、
     *   假端口的 `eventsSorted`），所以锚点（`events[cutoffIndex - 1]`）天然是最高位；
     * - `appendViaMirror` 用 `appendLocal` 给的本地占位 seq 也**大于**已加载的水位
     *   （`RustEventMirror` 的 `nextSeq` = 已加载最大值 + 1），所以"本地新追加"同样不会
     *   让锚点掉到非最高位。
     *
     * 之所以仍然留着这条守卫：它拦的正是 B-2 那一类**会毁数据**的线
     * （`cutoff_seq <= snapshot_seq` → 真引擎把快照自己删掉，库内 `items: []`）。
     * 一旦将来"读回来的 seq 不单调"（本地占位没对账、导入/迁移写进稀疏 seq、
     * 换一个有缺口的引擎实现），这条守卫会把命令拦住并如实上报，而不是静默删库。
     * 要让它变成"活代码"，得先有一条**非单调 seq** 的真实来源 —— 现在没有。
     */
  });

  /**
   * ⚠️ **第 18 轮（L1）改判据 —— 这一条原来依赖"产品读旧库"，那个语义已经删了。**
   *
   * 原用例断言："维护只在事件超阈值时才压缩（`compactedSessions` 从 0 变正）"。
   * 而维护里那一步是 `database.ts::compactOversizedSessionLogs`，它的实现是
   * `if (!db) return 0` + `SELECT session_id, count(*) FROM session_events … HAVING n > ?`
   * —— 也就是**只有旧库能枚举**：它读的是旧库索引，而端口模式下事件全在端口里。
   * 原用例为了让这条断言成立，必须先把事件"再登记进旧库索引"
   * （`mirrorEventsIntoLegacyIndex`：往一张没人读的表里插行，只是为了喂给枚举）。
   *
   * A 态（旧库是唯一数据源）删除之后，端口模式下 `legacy` 恒为 `null` → 这一步**永不执行**
   * （代码里那半边的注释自己写着"端口模式下的等价物是引擎侧的快照压缩 `events.compact`，
   * 由事件端口在写入时维持水位"）。所以"维护按阈值压缩事件"这条判据已经**没有实现可指**。
   *
   * 换成的判据是端口模式下的**同一件事的另一面**，强度不减：
   * 维护**不得越权改事件日志** —— 阈值高于、低于事件数两种情况都跑一遍，
   * 事件条数与可回放性都必须原样。真正的压缩契约由 SNAP-1~4（`compactWithSnapshot`
   * → `events.replaceSession` / `events.compact`）与去重写入侧的端口契约守着。
   */
  it("SNAP-5（第 18 轮改判据）: 端口模式下维护**不**在启动路径上压缩事件，且不破坏事件日志", async () => {
    seedSession("s1", 5); // 21 条事件
    const log = getEventLog();
    const before1 = log.readAll("s1").length;

    // 阈值远低于事件数：旧实现（读旧库索引枚举）在这里会压缩
    const over = await runDatabaseMaintenance({ compactEventsOver: 10 });
    expect(over.compactedSessions, "端口模式下维护不做事件压缩（枚举那一步只存在于旧库路径）").toBe(0);
    expect(log.readAll("s1").length, "维护不得动事件日志").toBe(before1);

    seedSession("s2", 5);
    const before2 = log.readAll("s2").length;
    // 阈值远高于事件数：这条守的是"不越权"，与阈值判定无关
    const under = await runDatabaseMaintenance({ compactEventsOver: 500 });
    expect(under.compactedSessions).toBe(0);
    expect(log.readAll("s2").length).toBe(before2);
    // 维护之后投影依然可用（不破坏会话）
    expect(getEventProjection().projectAll("s2").length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **第 18 轮（L1）改判据**：原用例是 `const db = getDatabase(); db.run = () => { throw }`
   * —— 用**旧库句柄**模拟"压缩失败"，验证"维护永远不能让应用不可用"。
   * A 态已删、旧库刻意不存在，这个手法连构造都构造不出来（`getDatabase()` 会抛）。
   *
   * 被守的东西没变（"维护失败不影响使用：吞掉异常 + 记日志"），换的是**失败的载体**：
   * 端口是端口模式下唯一会失败的落库通道，所以让它 `failWrites`。
   * 断言强度不变：仍要求维护**resolve 成功**且**留下了告警**（不静默）。
   */
  it("SNAP-6（第 18 轮改判据）: 落库失败时维护仍不抛，并如实告警（不静默）", async () => {
    /**
     * 判据必须**钉在"端口落库失败"这一条**上，不能只写 `expect(warn).toHaveBeenCalled()`。
     *
     * 实测：端口正常时维护**也会**打 warn（本文件里是
     * `[Attachment] 外置附件预热/清理失败（跳过）`，来自 FS 桩）。所以"维护打过 warn"
     * 这个断言在成功与失败两种情况下都成立 —— 它什么都没守（写成那样就是假绿）。
     * 这里改成认领那条**只可能由端口失败产生**的告警（`database.ts::pruneTelemetryViaPort`），
     * 并用一次对照组证明它确实只因失败才出现。
     */
    const PORT_FAIL_WARN = "遥测裁剪（端口）失败";
    const warnsWith = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.some((c) => String(c[0] ?? "").includes(PORT_FAIL_WARN));

    // 对照组：端口正常 → 绝不出现"端口落库失败"的告警
    seedSession("s1", 5);
    const warnControl = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runDatabaseMaintenance({ compactEventsOver: 1 });
    expect(warnsWith(warnControl), "对照：端口正常时不该报「端口落库失败」").toBe(false);
    warnControl.mockRestore();

    // 让端口的每一条落库命令都失败（遥测裁剪 `telemetry.prune` 是维护里唯一无条件走端口的写）
    setStoragePort(
      createFakeStoragePort({
        failWrites: true,
        seed: { sessions: [{ id: "s1", project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
      }),
    );
    seedSession("s1", 5);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runDatabaseMaintenance({ compactEventsOver: 1 })).resolves.toBeTruthy();
    expect(warnsWith(warn), "端口落库失败必须留下告警（静默吞掉就是假成功）").toBe(true);
    warn.mockRestore();

    // 维护之后事件仍可读（失败不影响使用）
    expect(getEventLog().readAll("s1").length).toBeGreaterThan(0);
  });
});
