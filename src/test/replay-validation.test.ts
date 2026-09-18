/**
 * 事件回放的结构自检 —— `validateReplay` 从**死代码**变成每次维护都跑的判据（第 60 轮）
 *
 * ## 为什么单独为它写一个文件
 *
 * `validateReplay` 之前**全仓零调用**（它自己写着"每会话校验"，但没有任何调用点），
 * 于是它内部两处缺陷在真机上完全不可见：
 *
 * 1. **类型判据是硬编码 `case` 清单，且已经漂了** —— 清单里没有 `session_snapshot`
 *    （引擎字面把它写进 `repo.rs::events_compact`，投影 `applySnapshot` 也真的消费它）。
 *    这条校验一旦被调用，就会把**合法快照报成未知类型**。修法是判据改走
 *    `isValidEventType()`（唯一真源）；真源自身的一致性由
 *    `event-type-set-consistency.test.ts` 守着。
 * 2. **快照边界上的工具配对是错的** —— 快照意味着"它之前的事件已被删除、状态固化在这条里"，
 *    所以待配对集合必须**按快照重建**（与 `applySnapshot` 重建 `toolCallIndex` 同一个道理）。
 *    不重建的话：`tool_call` 在快照里、`tool_result` 在快照之后的**正常日志**
 *    会被判成 `references unknown toolCallId`。
 *
 * 这两条都是"**判据自己造假警报**"的类型 —— 比没有判据更糟（第 47 轮水位漂移吃过同样的亏：
 * 一个会自己报警的判据会让人不再看告警）。所以这里逐条钉住"该报的报、不该报的绝不报"。
 *
 * ## 夹具：真端口形状的事件通道（假存储端口）
 *
 * 事件从 `getEventLog().append(...)` 写进去，`validateReplay` 再从
 * `getEventLog().readAll(...)` 读回来 —— 走的是与生产同一条读路由
 * （`rustEventPort` → 事件镜像 → `toSessionEvent`），不是把事件数组直接喂给被测函数。
 * 唯一直接摆出来的状态是**重复 seq**：引擎的 `seq` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`，
 * 真机上**造不出来**（见 RV-4 的说明），只能按行播种。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEventLog } from "../core/storage/event-log";
import { getEventProjection } from "../core/storage/event-projection";
import { runDatabaseMaintenance } from "../core/storage/maintenance";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SID = "rv-session";

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

/** 建端口 → 播种 → 确保事件镜像"已加载"（`readAll` 的读路由要求它） */
function installPort(seed: Record<string, Array<Record<string, unknown>>> = {}): FakeStoragePort {
  const port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SID, project_id: "", title: "rv", created_at: 0, last_message_at: 0, message_count: 0 },
      ],
      ...seed,
    },
  });
  setStoragePort(port);
  port.events.ensureLoaded(SID);
  return port;
}

/** 一段**结构完好**的会话：user → assistant(带 tool_call) → tool_result */
function seedHealthySession(sessionId = SID): void {
  const log = getEventLog();
  log.append(sessionId, "session_meta", { preset: "standard" });
  log.append(sessionId, "user_message", { messageId: "u1", content: "问题" });
  log.append(sessionId, "assistant_text", { messageId: "a1", content: "回答" });
  log.append(sessionId, "tool_call", { messageId: "a1", toolCallId: "tc1", tool: "bash", args: {} });
  log.append(sessionId, "tool_result", { toolCallId: "tc1", status: "completed", result: "输出" });
}

const validate = (sessionId = SID) => getEventProjection().validateReplay(sessionId);

beforeEach(() => {
  installTauriStub();
  // 测试环境固有噪音：没有真 Tauri 命令通道，JSONL 那条腿必然告警
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("RV：事件回放结构自检（该报的报）", () => {
  it("RV-1: 完好的日志 → 0 条结构错误（判据不能自己对正常库报警）", () => {
    installPort();
    seedHealthySession();
    expect(validate(), "正常会话被判成有结构错误 = 假报警").toEqual([]);
  });

  it("RV-2: 未知事件类型 → 报出来（带上 seq，便于定位）", () => {
    installPort();
    seedHealthySession();
    const bogus = getEventLog().append(SID, "totally_bogus_type_zz", { x: 1 });

    const errs = validate();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Unknown event type");
    expect(errs[0]).toContain("totally_bogus_type_zz");
    expect(errs[0], "报错要带 seq").toContain(String(bogus.seq));
  });

  it("RV-3: `tool_result` 找不到对应的 `tool_call` → 报出来", () => {
    installPort();
    seedHealthySession();
    getEventLog().append(SID, "tool_result", { toolCallId: "never-called", status: "completed" });

    const errs = validate();
    expect(errs.some((e) => e.includes("unknown toolCallId") && e.includes("never-called"))).toBe(true);
  });

  it("RV-4: 重复 seq → 报出来（真引擎造不出该状态，是**合并/分页**的防御判据）", () => {
    /*
     * 说清这条判据的边界：`session_events.seq` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`，
     * 真引擎里**不可能**有两条同 seq 的行。它防的是"读侧把同一行读回来两次"
     * （分页游标重复、镜像合并重复）。所以这里**直接把行摆出来**复现该状态，
     * 而不是声称"引擎会写出重复 seq"。
     */
    installPort({
      session_events: [
        { seq: 7, session_id: SID, event_type: "user_message", payload: '{"messageId":"u1","content":"x"}', timestamp: 1 },
        { seq: 7, session_id: SID, event_type: "user_message", payload: '{"messageId":"u1","content":"x"}', timestamp: 1 },
      ],
    });
    expect(getEventLog().readAll(SID), "夹具前提：镜像里真的是两行同 seq").toHaveLength(2);

    const errs = validate();
    expect(errs.filter((e) => e.includes("Duplicate seq"))).toHaveLength(1);
    expect(errs.join("；")).toContain("Duplicate seq: 7");
  });

  it("RV-11: `readAll(\"\")` **永远读不到事件**（事件按会话 id 路由）—— 死读不许再被当成消费者", () => {
    /*
     * ## 这条钉的是一个刚刚删掉的死读
     *
     * `project/files.ts` 里那段"会话级指令"（v1.1.0 加的 R3-2.4 Layer 4）读的是
     * `getEventLog().readAll("")`，注释写着 "session-agnostic global event log"。
     * 但事件镜像**按会话 id 路由**（`event-log.ts::readAll` → `rustEventPort(sessionId)`），
     * 空会话 id 永远走"该域没有"这一支 → 永远返回空数组 → 那个 `for` 循环一次都没进过。
     *
     * 它更坏的一面：`maintenance.ts` 里"不能压缩事件"的论证曾把它举为
     * **真实存在的消费者**（"这些内容不在消息表里，删了永久消失"）——
     * 用一段不可能命中的读当论据，就是第 45 轮已经撤回过一次的同一类假论据。
     *
     * 所以这里把"为什么它不可能命中"变成判据：**同一个会话有事件，`readAll(sid)` 读得到，
     * 而 `readAll("")` 读不到**。谁再写一次这种读，这条会告诉他这条路是死的。
     */
    installPort();
    seedHealthySession();
    expect(getEventLog().readAll(SID).length, "夹具前提：这个会话的事件真的读得到").toBeGreaterThan(0);
    expect(getEventLog().readAll(""), "空会话 id 不是'全局日志'，而是一条读不到任何东西的路由").toEqual([]);
  });

  it("RV-12: 生产代码里不许再出现空会话 id 的事件读（源码判据，带齿）", async () => {
    /*
     * 上一条钉的是"这条路为什么是死的"，这一条钉的是"别再写一次"。
     *
     * 判据取的是**字面形状** `readAll("")` / `readAll('')` —— 窄到不会误伤
     * （变量形式的空 id 这里抓不到，那是**有意的取舍**：宽泛的匹配会开始误报，
     * 而误报会让真信号贬值，这条纪律本仓库反复吃过）。
     * 下面同时证明匹配器**真的会咬**（拿一段合成的源码试它）。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "test" || entry.name === "__mocks__") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, "utf8");
        // 注释里的历史说明不算（这条判据管的是**代码**）
        const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
        if (/readAll\(\s*["'`]["'`]\s*\)/.test(code)) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders, "空会话 id 的事件读是死路（见 RV-11），别再写").toEqual([]);

    // 齿：同一个匹配器必须抓得住合成的样本（否则"0 处"可能只是没匹配上）
    const synthetic = `const events = getEventLog().readAll("");`;
    expect(/readAll\(\s*["'`]["'`]\s*\)/.test(synthetic), "匹配器不咬 = 这条判据是假绿").toBe(true);
  });
});

describe("RV：事件回放结构自检（不该报的绝不报 —— 这一轮修的两处假报警）", () => {
  it("RV-5: 合法的 `session_snapshot` **不是**未知类型（引擎把它字面写在 events_compact 里）", () => {
    installPort();
    seedHealthySession();
    getEventLog().append(SID, "session_snapshot", {
      messages: [{ id: "a1", role: "assistant", content: "固化下来的状态" }],
      compactionSummary: null,
      removedMessageIds: [],
      atSeq: 1,
    });

    const errs = validate();
    expect(
      errs.filter((e) => e.includes("Unknown event type")),
      "把引擎真实写入的快照类型报成未知 = 判据自己在造假警报（这正是修之前的行为）",
    ).toEqual([]);
  });

  it("RV-6: `tool_call` 在快照里、`tool_result` 在快照之后 → 不算结构错误", () => {
    /*
     * 快照的语义是"它之前的事件已被删除、状态固化在这条事件里"。
     * 所以这个日志形状**完全正常**：配对信息在快照的 messages 里。
     * 修之前：待配对集合不按快照重建 → 这条 `tool_result` 被判成孤儿。
     */
    installPort();
    const log = getEventLog();
    log.append(SID, "session_snapshot", {
      messages: [
        {
          id: "a-snap",
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc-in-snapshot", type: "function", function: { name: "bash", arguments: "{}" } }],
        },
      ],
      compactionSummary: null,
      removedMessageIds: [],
      atSeq: 1,
    });
    log.append(SID, "tool_result", { toolCallId: "tc-in-snapshot", status: "completed", result: "ok" });

    expect(
      validate(),
      "快照之后的 tool_result 是合法日志；报成孤儿就等于对任何做过压缩的会话永远报警",
    ).toEqual([]);
  });

  it("RV-7: `compaction` 引用的消息 id 在日志里找不到 → **不算**错误（那是压缩的语义）", () => {
    /*
     * 这一点原注释说得比实现多（注释写着"Compaction events don't reference non-existent
     * messages"，实现里没有这条）。第 60 轮**刻意不补成错误判据**，理由是：
     * 被压缩掉的消息，其事件本来就已被删除；维护删行还会留下永久 seq 空洞
     * （真机实测 3112 条事件、364 个空洞）。把它当错误 = 把正常库判成坏库。
     */
    installPort();
    seedHealthySession();
    getEventLog().append(SID, "compaction", {
      removedMessageIds: ["m-早已被压缩掉", "m-也在历史里"],
      summary: "摘要",
      messagesBefore: 10,
      messagesAfter: 2,
    });

    expect(validate(), "把压缩语义判成结构错误就是假报警").toEqual([]);
  });

  it("RV-8: 但 `compaction` 载荷形状不对（removedMessageIds 不是数组）→ 必须报", () => {
    installPort();
    seedHealthySession();
    // 刻意给一个非数组值：这是"写入侧写坏了"的真实信号
    getEventLog().append(SID, "compaction", { removedMessageIds: "不是数组", summary: "x" });

    const errs = validate();
    expect(errs.some((e) => e.includes("invalid removedMessageIds"))).toBe(true);
  });

  it("RV-13: 形状不对的 `compaction` 会让**投影整个抛错** → 已改成按「不删任何消息」处理（真机数据逼出来的）", () => {
    /*
     * ## 这条来自真机（第 60 轮的结构自检第一次真的读到了事件之后）
     *
     * 打包版扫用户真实库，报出：
     *
     * ```text
     * 1788268497135-31x6vdt97: compaction at seq 2230 has invalid removedMessageIds
     * ```
     *
     * 读那一行：`{"markerId":"compact-…-repair47","reason":"…","summary":"…"}`
     * —— 第 47 轮审计修复脚本补写的汇总 marker（生产写入方 `agentic-loop.ts:3417`
     * 写的是规范形状）。而 `applyCompaction` 原来直接 `for (const id of payload.removedMessageIds)`，
     * 对 `undefined` 做 `for…of` 会 **TypeError**，这条投影又接在
     * `agentic-loop.ts:1279`（每轮拼 surface notice）、`surface-manager`、`validateReplay` 上，
     * **外面没有 try/catch** —— 也就是"那个会话一开口就抛"。
     *
     * 处置：投影按"这条压缩不删除任何消息"处理（记忆 `summary` 仍然照做），
     * 同时经 `[PersistFailure]` 如实上报；**结构自检照旧报出这一行**（判据不放宽）。
     */
    installPort();
    seedHealthySession();
    getEventLog().append(SID, "compaction", {
      markerId: "compact-1788283968702-repair47",
      reason: "44 条隐藏消息当时没有生成汇总 marker",
      summary: "（真机那条修复 marker 的形状）",
    });

    const projection = getEventProjection();
    expect(() => projection.projectAll(SID), "投影不许因为一条历史遗留形状而整体抛错").not.toThrow();
    expect(() => projection.getActiveGenerations(SID), "同一形状在 generations 里也要容错").not.toThrow();
    // 消息一条都不该被误删（形状不认识 → 按"没删除任何消息"处理）
    expect(projection.projectAll(SID).length).toBeGreaterThan(0);
    // 但**判据不放宽**：这一行仍然要被报出来
    expect(validate().some((e) => e.includes("invalid removedMessageIds"))).toBe(true);
  });
});

describe("RV：结构自检接进维护（数字必须出现在汇总行里）", () => {
  it("RV-9: 结构异常会进 `invariantStructuralErrors`，并出现在维护汇总行里（不静默）", async () => {
    installPort();
    seedHealthySession();
    getEventLog().append(SID, "tool_result", { toolCallId: "orphan-1", status: "completed" });
    getEventLog().append(SID, "totally_bogus_type_zz", {});

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await runDatabaseMaintenance({});
    const line = log.mock.calls.map((c) => String(c[0] ?? "")).find((s) => s.includes("维护完成"));

    expect(res.invariantStructuralErrors, "两处缺陷（孤儿 tool_result + 未知类型）都要数进去").toBeGreaterThanOrEqual(2);
    expect(line, "维护汇总行必须带上结构自检的数字（没打印出来 = 与没跑分不开）").toBeTruthy();
    expect(String(line)).toContain("事件库结构异常");
  });

  it("RV-10: 结构干净时数字为 0，汇总行说「含事件库结构自检」（对照：证明 RV-9 的差异来自缺陷本身）", async () => {
    installPort();
    seedHealthySession();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await runDatabaseMaintenance({});
    const line = log.mock.calls.map((c) => String(c[0] ?? "")).find((s) => s.includes("维护完成"));

    expect(res.invariantStructuralErrors).toBe(0);
    expect(String(line)).not.toContain("事件库结构异常");
  });
});
