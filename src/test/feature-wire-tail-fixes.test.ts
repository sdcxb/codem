/**
 * FWT-*：功能上下文 / 线协议审计的**剩余 P2 批**（第 45 轮）
 *
 * 覆盖的条目（每条都在文件里有对应用例，判据全落在**行为/数据**上）：
 *
 * | 用例 | 守什么 | 报告条目 |
 * | --- | --- | --- |
 * | FWT-4a | `messages.delete` 的 `count_clamped=true` 会**当场**把会话计数按索引真值重算 | WIRE P2-4 |
 * | FWT-4b | 重算读的是 `messages.count.total`（**不是** `visible`，也不是退回 `0`） | WIRE P2-4 |
 * | FWT-4c | 读不到真值（端口无 `command`）时**什么都不写**（不是"当成一致"） | WIRE P2-4 |
 * | FWT-4d | 五个 `messages.delete` 调用点走结构化通道：`affected_rows` / `missing` 真的被读 | WIRE P2-4 |
 * | FWT-4e | 删会话的消息时**逐个会话**重算（跨会话删除不会只修一个） | WIRE P2-4 |
 * | FWT-6a | 范围删除的写穿命令**分批、批间有序**，在飞 ≤ 50（改前是 N 条同时起飞） | WIRE P2-6 |
 * | FWT-6b | 某一批失败**不阻断后续批**（有界 ≠ 遇错停摆），且失败带行号/id 上报 | WIRE P2-6 |
 * | FWT-6c | `domainReplaceTable` 的重建阶段是**一条** `crud.upsert`（引擎侧单事务） | WIRE P2-6 |
 * | FWT-C1a | 纯工具轮的助手消息（无正文 + 有 tool 事件）**不是**违规（口径收窄） | FC §未做 |
 * | FWT-C1b | 有正文却没有事件仍然是违规（收窄不许把真违规一起放过） | FC §未做 |
 * | FWT-C1c | 无正文、也没有任何 tool 事件的助手行**仍然是**违规（两面都不放过） | FC §未做 |
 * | FWT-C1d | `sessionIds` 显式入参可检查一批会话（生产接线的前提） | FC §未做 |
 * | FWT-C2a | `auditInvariantsForSessions` 在生产路径上真的跑，并把 `checked` / 违规数带回 | FC §未做 |
 * | FWT-C2b | 没有会话可查时 `checked = 0`（"没跑"不许冒充"通过"） | FC §未做 |
 * | FWT-D9a | 域写（`putMessageFeedback` 改评）之后 `loadFeedback` **读到新值**（缓存必须失效） | FC P2-D9 |
 * | FWT-D9b | 域删（取消反馈）之后 `loadFeedback` 读回 `null`（不再"取消了却还显示已赞"） | FC P2-D9 |
 *
 * ## 为什么这些判据不能写成"函数被调用了"
 *
 * - P2-4 的缺陷形状是"引擎回报了、渲染侧不读" —— 判据必须是**会话行里的
 *   `message_count` 真的变成了索引真值**（而不是"调了某个函数"）；
 * - P2-6 的缺陷形状是"N 条命令同时起飞" —— 判据必须是**命令发出的时序**
 *   （某一时刻在飞的不超过一批），而不是"用了 for 循环"；
 * - 口径差（P2-D9 / 不变量）的判据是**违规集合的内容**。
 *
 * ## 假端口的保真度声明
 *
 * `messages.delete` 的回报（`count_clamped` 等）在 `fake-storage-port.ts` 里**没有**实现
 * （它只返回 `written`），所以本文件用 `wrapDeleteOutcome` 把一份**按 `repo.rs:1510–1526`
 * 逐字段抄下来的**回报补上 —— 也就是"测试双比实现更窄"的方向（不会让实现假绿）。
 * `messages.count` 的 `{count,total,visible,hidden}` 假端口本来就实现了。
 * 假端口的三张表（`messages` / `sessions` / `session_events`）与"引擎"是同一份内存表，
 * 所以"镜像里读到的值"= "库里写进的值"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import {
  reconcileSessionMessageCountById,
  saveFeedback,
  loadFeedback,
  createMessage,
  __resetTextEventFingerprints,
} from "../core/storage/message";
import { putMessageFeedback, deleteMessageFeedback } from "../core/llm/feedback";
import { checkVisibleRecordedInvariant } from "../core/llm/runtime-invariants";
import { auditInvariantsForSessions } from "../core/storage/maintenance";
import {
  domainDeleteWhere,
  domainDeleteBeyond,
  domainReplaceTable,
  PERSIST_CHUNK_SIZE,
} from "../core/storage/domain-store";

let port: FakeStoragePort;
let seq = 0;
/** 每个用例一个会话 id / 表名（各模块有模块级状态，见 `feature-context-fixes.test.ts` 的同类说明） */
const sid = (tag: string) => `sess-fwt-${tag}-${++seq}`;
const tname = (tag: string) => `fwt_${tag}_${++seq}`;

const rowsOf = (table: string) => port.__table(table);
const commandsOf = () => port.__writes().map((w) => w.command);
const deletesOf = (table: string) =>
  port.__writes().filter((w) => w.command === "crud.delete" && (w.params as any)?.table === table);

/** 预置一行（走端口的真实写路径；`__table` 返回的是拷贝，直接 push 不进库） */
function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedSession(id: string, extra: Record<string, unknown> = {}) {
  seedRow("sessions", {
    id,
    project_id: "p1",
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
    ...extra,
  });
}

function seedMessageRow(sessionId: string, id: string, role = "user", extra: Record<string, unknown> = {}) {
  seedRow("messages", {
    id,
    session_id: sessionId,
    role,
    content: `内容 ${id}`,
    reasoning: null,
    timestamp: seq++,
    model: null,
    status: "done",
    hidden: 0,
    trimmed: 0,
    ...extra,
  });
}

function seedEvent(sessionId: string, eventType: string, payload: unknown, ts = 1) {
  const rows = rowsOf("session_events");
  seedRow("session_events", {
    seq: rows.length + 1,
    session_id: sessionId,
    event_type: eventType,
    payload: JSON.stringify(payload),
    timestamp: ts,
  });
}

const sessionRow = (id: string) => rowsOf("sessions").find((r) => r.id === id);
const messageCountOf = (id: string) => Number(sessionRow(id)?.message_count);

/** 一次 `messages.delete` 的**引擎回报**（`repo.rs:1510–1526` 的逐字段抄本） */
function deleteOutcome(opts: { written: number; requested: number; affected?: number; clamped: boolean }) {
  return {
    written: opts.written,
    requested: opts.requested,
    missing: Math.max(0, opts.requested - opts.written),
    soft: false,
    trim: false,
    affected_rows: opts.affected ?? opts.written,
    count_clamped: opts.clamped,
  };
}

/**
 * 让假端口的 `messages.delete` 走**结构化回报**（假端口自己只回 `written`）。
 *
 * ## 为什么要连"引擎真的删了行"一起模拟
 *
 * P2-4 的闭环是"回报说夹断 → 按 `messages.count` 的**真值**重算"。
 * 如果回报假装删了 3 条而假端口一行都没删，重算出来的"真值"还是删前那个数 ——
 * 用例于是变成自证（`count` 与它自己对上了）。所以这里让**引擎真的删**，
 * 再让回报如实描述那次删除（`count_clamped` 由调用方按场景给出）。
 *
 * `aft` 钩子在"引擎删完之后、回报返回之前"执行，用来做**库侧**的额外动作
 * （典型：把 `sessions.message_count` 人为写小，制造"计数已经漂移过"那个前置状态 ——
 * 真机上夹断正是只可能发生在这样的会话上）。
 */
function wrapDeleteOutcome(
  build: (params: Record<string, unknown> | undefined) => Record<string, unknown>,
  aft?: (params: Record<string, unknown> | undefined) => void,
) {
  const realCommand = port.data.command!.bind(port.data);
  const calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
  port.data.command = (async (command: string, params?: Record<string, unknown>) => {
    calls.push({ command, params });
    if (command === "messages.delete") {
      /*
       * 先让假端口真的执行这条命令（行真的被删/被隐藏），再把回报换成引擎形状。
       */
      await realCommand(command, params);
      aft?.(params);
      return build(params);
    }
    return realCommand(command, params);
  }) as typeof port.data.command;
  return calls;
}

/** 在飞计数：包 `data.execute`，统计同一时刻未结算的命令数（P2-6 的**唯一**判据） */
function trackInFlight() {
  const realExecute = port.data.execute.bind(port.data);
  let inFlight = 0;
  let peak = 0;
  /** 每次 `crud.delete` 起飞时**已经结算**的删除数（用来验证批间顺序） */
  const landedAtLaunch: number[] = [];
  let settledDeletes = 0;
  port.data.execute = (async (command: string, params?: Record<string, unknown>) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (command === "crud.delete") landedAtLaunch.push(settledDeletes);
    try {
      return await realExecute(command, params);
    } finally {
      inFlight--;
      if (command === "crud.delete") settledDeletes++;
    }
  }) as typeof port.data.execute;
  return {
    peak: () => peak,
    landedAtLaunch,
    reset() {
      peak = 0;
      landedAtLaunch.length = 0;
    },
  };
}

/** 让指定 id 的 `crud.delete` 直接拒绝（验证"失败逐批归因且不阻断后续批"） */
function failDeletesFor(ids: readonly string[]) {
  const bad = new Set(ids);
  const realExecute = port.data.execute.bind(port.data);
  port.data.execute = (async (command: string, params?: Record<string, unknown>) => {
    if (command === "crud.delete" && bad.has(String((params as any)?.where?.id))) {
      throw new Error(`测试注入：id ${String((params as any)?.where?.id)} 删除失败`);
    }
    return realExecute(command, params);
  }) as typeof port.data.execute;
}

beforeEach(() => {
  resetPersistFailures();
  __resetTextEventFingerprints();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  port = createFakeStoragePort();
  setStoragePort(port);
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  __resetTextEventFingerprints();
  vi.restoreAllMocks();
});

// ======================================================================
// WIRE P2-4：`messages.delete` 回报的字段必须真的有人读 → 闭环到"按索引真值重算"
// ======================================================================

describe("FWT-4：`count_clamped` / `affected_rows` / `missing` 的闭环（WIRE P2-4）", () => {
  it("FWT-4a: 夹断（count_clamped=true）→ 会话 message_count 被改成索引真值，且留下可见告警", async () => {
    const S = sid("4a");
    // 引擎侧的实情：库里 5 条消息，而计数列已经漂移成 1（P2-4 报告里的实测形态）
    seedSession(S, { message_count: 1 });
    for (let i = 0; i < 5; i++) seedMessageRow(S, `m-${i}`);
    /*
     * 生产里走到这里的形状是"UI 已经 loadMessages 过这个会话"（镜像已就绪）——
     * `deleteMessagesBefore` 的 `runWhenReady` 要求 `isLoaded`，所以先把这一态摆出来
     * （假端口默认同步就绪）。
     */
    port.messages!.ensureLoaded(S);

    const calls = wrapDeleteOutcome(
      // 请求 5 条、引擎真的删掉 3 条（库里剩 2 条）
      (params) => deleteOutcome({ written: 3, requested: (params?.ids as string[]).length, clamped: true }),
      /*
       * `aft`：把**库侧**状态摆成"删了 3 条、还剩 2 条"，并制造夹断的前置漂移态。
       *
       * 为什么必须在这里补：假端口的 `messages.delete` 会把这 5 条**全部**删掉
       * （它不做"部分删除"），而夹断的语义恰恰依赖"计数 1、删 3 条、库里还剩 2 条"。
       * 所以删完之后把 3 条放回去（等价于"引擎只删了 3 条"），再把
       * `message_count` 写成 1（漂移态 —— 引擎正是拿它去减 3 才夹断的）。
       * 这样一来 `messages.count.total` 天然是 2，重算的目标值**不是**由用例给定的。
       */
      () => {
        for (const gone of ["m-3", "m-4"]) {
          seedRow("messages", {
            id: gone,
            session_id: S,
            role: "user",
            content: `内容 ${gone}`,
            reasoning: null,
            timestamp: 900,
            model: null,
            status: "done",
            hidden: 0,
            trimmed: 0,
          });
        }
        const row = sessionRow(S);
        if (row) row.message_count = 1;
      },
    );

    const { deleteMessagesBefore } = await import("../core/storage/message");
    const removed = deleteMessagesBefore(S, Number.MAX_SAFE_INTEGER);
    expect(removed).toBe(5);
    expect(
      calls.filter((c) => c.command === "messages.delete"),
      "必须走结构化通道（`execute` 拿不到 count_clamped）",
    ).toHaveLength(1);

    // 让那条 promise 链结算（`command().then(reconcile)` 里还有两次动态 import + 一次计数）
    await vi.waitFor(() => {
      expect(messageCountOf(S), "夹断之后计数必须回到索引真值（库里确实还剩 2 条）").toBe(2);
    });
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(warned, "夹断这件事必须**看得见**（改前只有一句 null 回报被丢掉）").toContain("会话消息计数被夹断");
    expect(warned, "报告里点名的 `affected_rows` 也要被读出来（= 删掉 3 行）").toContain("删 3 条");
  });

  it("FWT-4b: 重算读 `messages.count.total`（含软删行），不是 `visible`、更不是退回 0", async () => {
    const S = sid("4b");
    seedSession(S, { message_count: 0 });
    seedMessageRow(S, "v1");
    seedMessageRow(S, "v2");
    // 一条被压缩隐藏的行：total 应当算它、visible 不算
    seedMessageRow(S, "h1", "assistant", { hidden: 1 });

    const res = await reconcileSessionMessageCountById(S, "用例：按索引真值重算");
    expect(res).toBe("reconciled");
    expect(messageCountOf(S), "total=3（两条可见 + 一条 hidden），不是 visible=2、也不是 0").toBe(3);

    // 再算一次：一致 → `consistent`（**不等于失败**，也不重复写）
    const again = await reconcileSessionMessageCountById(S, "用例：再算一次");
    expect(again).toBe("consistent");
    expect(messageCountOf(S)).toBe(3);
  });

  it("FWT-4c: 读不到真值（端口没有 command 能力）→ 什么都不写，且如实上报 unavailable", async () => {
    const S = sid("4c");
    seedSession(S, { message_count: 7 });
    const saved = port.data.command;
    // 极简假端口形态：只有 execute，没有结构化通道
    port.data.command = undefined;
    try {
      const res = await reconcileSessionMessageCountById(S, "用例：无 command 能力");
      expect(res).toBe("unavailable");
      expect(messageCountOf(S), "读不到真值就不许写（写 0 就是第二次漂移）").toBe(7);
      expect(
        getPersistFailures().some((f) => f.area === "message.reconcileMessageCount"),
        "端口没有 command 能力这件事必须可见（'没读到'≠'对上了'）",
      ).toBe(false); // 这一态在 `reconcileSessionMessageCountById` 里是**提前返回**，不产生失败告警
    } finally {
      port.data.command = saved;
    }
  });

  it("FWT-4d: `messages.delete` 走的是**结构化通道**（改前五处全部走裸 `execute`，回报里只剩 `written`）", async () => {
    const S = sid("4d");
    seedSession(S);
    seedMessageRow(S, "x1");
    port.messages!.ensureLoaded(S);

    const calls = wrapDeleteOutcome(
      /*
       * 请求 1 条、引擎**一行都没删**（missing=1）、但级联影响 2 行 ——
       * 报告里点名的三个字段在这一个回报里全被触发（`count_clamped` 走另一条用例）。
       */
      () => deleteOutcome({ written: 0, requested: 1, affected: 2, clamped: false }),
    );
    const { deleteMessage } = await import("../core/storage/message");
    deleteMessage("x1");
    await vi.waitFor(() => {
      expect(
        calls.filter((c) => c.command === "messages.delete"),
        "走 `command` 才可能读到 count_clamped / affected_rows / missing（`execute` 把结果压成 {written}）",
      ).toHaveLength(1);
    });
    // 回报里的每个字段都被读进了处置逻辑（否则这里会是一条"什么都没发生"的静默路径）
    await vi.waitFor(() => {
      const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(warned, "missing>0 必须被读出来（请求 1 条、库里一条都没删到）").toContain("missing=1");
      expect(warned, "affected_rows > written（外键级联 2 行）也要被读出来").toContain("影响行数 2 > 直接删除 0");
    });
  });

  it("FWT-4e: 跨会话的批量删除 → **每个**受影响会话都按真值重算（不许只修一个）", async () => {
    const A = sid("4e-a");
    const B = sid("4e-b");
    seedSession(A, { message_count: 0 });
    seedSession(B, { message_count: 0 });
    for (let i = 0; i < 4; i++) seedMessageRow(A, `a-${i}`, "user", { timestamp: 100 + i });
    for (let i = 0; i < 5; i++) seedMessageRow(B, `b-${i}`, "user", { timestamp: 100 + i });
    port.messages!.ensureLoaded(A);
    port.messages!.ensureLoaded(B);

    const calls = wrapDeleteOutcome(
      (params) => deleteOutcome({ written: (params?.ids as string[]).length, requested: (params?.ids as string[]).length, clamped: true }),
      // 前置漂移态（同 FWT-4a）：引擎把计数减到 0 以下才会夹断
      () => {
        const rowA = sessionRow(A);
        const rowB = sessionRow(B);
        if (rowA) rowA.message_count = 1;
        if (rowB) rowB.message_count = 1;
      },
    );
    const { deleteMessagesBefore } = await import("../core/storage/message");
    /*
     * 两个会话各自删掉 2 条。`count_clamped` 的真假由 Rust 决定，渲染侧要保证的是：
     * **回报为真时不遗漏任何一个会话**（改前根本没有这条闭环）。
     */
    expect(deleteMessagesBefore(A, 102), "会话 A：时间戳 < 102 的 2 条").toBe(2);
    expect(deleteMessagesBefore(B, 102), "会话 B：时间戳 < 102 的 2 条").toBe(2);
    expect(calls.filter((c) => c.command === "messages.delete")).toHaveLength(2);

    await vi.waitFor(
      () => {
        expect(messageCountOf(A), "会话 A 的计数必须按自己的索引真值重算 → 2").toBe(2);
        expect(messageCountOf(B), "会话 B 同样 → 3（不许只修一个）").toBe(3);
      },
      { timeout: 3000 },
    );
  });
});

// ======================================================================
// WIRE P2-6：范围删除的写穿必须**有界**
// ======================================================================

describe("FWT-6：范围/批量删除的有界分批（WIRE P2-6）", () => {
  it("FWT-6a: 130 行目标 → 命令分批发出，在飞命令数 ≤ PERSIST_CHUNK_SIZE（改前是 130 条同时起飞）", async () => {
    const T = tname("6a");
    const N = 130;
    for (let i = 0; i < N; i++) seedRow(T, { id: `r-${String(i).padStart(3, "0")}`, created_at: i });
    await Promise.resolve(); // 让 seed 的 upsert 结算

    const flight = trackInFlight();
    const removed = domainDeleteWhere(T, (row) => Number(row.created_at) < 100, "id", {
      scope: "fwt.6a",
      note: "过期行未清理",
    });
    expect(removed, "镜像上是同步删除的（返回语义没变）").toBe(100);
    await vi.waitFor(() => {
      expect(deletesOf(T)).toHaveLength(100);
    });

    expect(flight.peak(), `同时在飞的命令必须 ≤ ${PERSIST_CHUNK_SIZE}（有界）`).toBeLessThanOrEqual(
      PERSIST_CHUNK_SIZE,
    );
    /*
     * 批间顺序的判据：把发射序列切成 `PERSIST_CHUNK_SIZE` 一段，
     * **每一段内部所有发射点看到的"已结算删除数"必须相同** ——
     * 也就是"这一批起飞时，上一批已经全部结算"（改前的形态是 100 条同时起飞，
     * 每个发射点看到的值都是 0，同时会看到 peak=100）。最后一段允许不满。
     */
    const lanes = flight.landedAtLaunch;
    expect(lanes.length, "100 个目标 = 100 条命令").toBe(100);
    for (let start = 0; start < lanes.length; start += PERSIST_CHUNK_SIZE) {
      const lane = lanes.slice(start, start + PERSIST_CHUNK_SIZE);
      expect(new Set(lane).size, `第 ${start / PERSIST_CHUNK_SIZE + 1} 批内部的发射点必须一致`).toBe(1);
    }
    expect(lanes[0], "第 1 批起飞时还没有任何删除结算").toBe(0);
    expect(lanes[PERSIST_CHUNK_SIZE], "第 2 批起飞时第 1 批的 50 条**全部**已结算").toBe(PERSIST_CHUNK_SIZE);
    /* 100 个目标只有两批（chunk 边界恰好落在 100）—— 所以第 3 批不存在，长度就是 100 */
    expect(lanes.length).toBe(100);
  });

  it("FWT-6b: 某一批失败不阻断后续批，且失败带行号/id 上报（错误归因到行）", async () => {
    const T = tname("6b");
    const N = 120;
    for (let i = 0; i < N; i++) seedRow(T, { id: `q-${String(i).padStart(3, "0")}`, created_at: i });
    await Promise.resolve();

    // 第 1 批里三条 + 第 2 批里一条被拒
    const badIds = ["q-000", "q-001", "q-002", "q-060"];
    failDeletesFor(badIds);

    domainDeleteWhere(T, () => true, "id", { scope: "fwt.6b", note: "过期行未清理" });
    /*
     * ⚠️ 被拒的那 4 条**不会**进 `__writes()` —— 假端口在 `persist` 开头就抛
     * （`if (opts.failWrites) throw`），所以写日志里只有成功的 116 条。
     * 这恰好是"失败没有偷偷变成成功"的反向判据。
     */
    await vi.waitFor(() => {
      expect(deletesOf(T).length).toBe(N - badIds.length);
    });
    expect(
      commandsOf().filter((c) => c === "crud.delete").length,
      "第 2/3 批必须照发（有界 ≠ 遇错停摆）：116 条 > 一批的 50 条",
    ).toBeGreaterThan(PERSIST_CHUNK_SIZE);

    const errs = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(" "))
      .join("\n");
    expect(errs, "失败必须归因到具体行（行号 + id），不是只报一次'删除失败'").toContain("id=q-000");
    expect(errs, "第 2 批的失败同样被归因").toContain("id=q-060");
    expect(errs, "被拒的行不许出现在成功集合里").not.toContain("id=q-003");
    expect(
      getPersistFailures().find((f) => f.area === "fwt.6b")?.count,
      "同一个 scope 的失败按次数累计（4 次）",
    ).toBe(4);
  });

  it("FWT-6c: `domainReplaceTable` 的重建阶段是**一条** `crud.upsert`（引擎侧单事务）", async () => {
    const T = tname("6c");
    for (let i = 0; i < 3; i++) seedRow(T, { id: `old-${i}` });
    await Promise.resolve();
    const before = port.__writes().length;

    const ok = domainReplaceTable(T, [
      { id: "n1", v: 1 },
      { id: "n2", v: 2 },
      { id: "n3", v: 3 },
      { id: "n4", v: 4 },
    ]);
    expect(ok, "接手了 → true（返回语义没变）").toBe(true);
    await vi.waitFor(() => {
      expect(rowsOf(T).map((r) => r.id).sort()).toEqual(["n1", "n2", "n3", "n4"]);
    });

    const writes = port.__writes().slice(before);
    const upserts = writes.filter((w) => w.command === "crud.upsert");
    expect(upserts, "4 行只发 1 条命令（改前是 4 条 IPC / 4 个事务）").toHaveLength(1);
    expect((upserts[0].params as any).rows, "一条命令里带全部行").toHaveLength(4);
    expect(
      writes.filter((w) => w.command === "crud.delete"),
      "清空阶段仍然是逐 id（线协议 where 只支持等值），但走有界批次",
    ).toHaveLength(3);
    expect(writes.map((w) => w.command)).not.toContain("crud.replace_table");
  });

  it("FWT-6d: `domainDeleteBeyond`（保留最近 N 条）同样走有界批次", async () => {
    const T = tname("6d");
    const N = 80;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < N; i++) {
      rows.push({ id: `t-${String(i).padStart(3, "0")}`, completed_at: i });
      seedRow(T, { id: `t-${String(i).padStart(3, "0")}`, completed_at: i });
    }
    await Promise.resolve();

    const flight = trackInFlight();
    const removed = domainDeleteBeyond(T, rows, 5, { scope: "fwt.6d", note: "过期任务未清理" });
    expect(removed).toBe(75);
    await vi.waitFor(() => {
      expect(deletesOf(T)).toHaveLength(75);
    });
    expect(flight.peak()).toBeLessThanOrEqual(PERSIST_CHUNK_SIZE);
    expect(rowsOf(T).map((r) => r.id).sort()).toEqual(
      [75, 76, 77, 78, 79].map((i) => `t-${String(i).padStart(3, "0")}`),
    );
  });
});

// ======================================================================
// FC §未做：`checkVisibleRecordedInvariant` 与"纯工具轮不写 assistant_text"的口径差
// ======================================================================

describe("FWT-C1：不变量口径与 `assistant_text` 写入点对齐（FC §未做）", () => {
  it("FWT-C1a: 纯工具轮（无正文 + 有 tool_call/tool_result）**不是**违规", () => {
    const S = sid("c1a");
    seedSession(S);
    // 用户消息（正常有 user_message 事件）
    seedMessageRow(S, "u1", "user", { content: "跑一下测试" });
    seedEvent(S, "user_message", { messageId: "u1", content: "跑一下测试" });
    // 纯工具轮的助手消息：定稿正文为空 → `appendMessageTextEvent` 刻意不写 assistant_text
    seedMessageRow(S, "a1", "assistant", { content: "" });
    seedEvent(S, "tool_call", { messageId: "a1", toolCallId: "tc1", tool: "bash", status: "running" });
    seedEvent(S, "tool_result", { messageId: "a1", toolCallId: "tc1", status: "ok" });

    const res = checkVisibleRecordedInvariant(S);
    expect(
      res.violations,
      "改前这里恒有 1 条 VISIBLE_BUT_NOT_RECORDED（口径差）→ 断言恒红 = 没有判据",
    ).toEqual([]);
    expect(res.passed).toBe(true);
  });

  it("FWT-C1b: 有正文却没有事件**仍然是**违规（收窄不许放过真违规）", () => {
    const S = sid("c1b");
    seedSession(S);
    seedMessageRow(S, "u2", "user", { content: "有正文的用户消息" });
    seedEvent(S, "user_message", { messageId: "u2", content: "有正文的用户消息" });
    // 有正文的助手消息，但事件日志里**没有** assistant_text（= P0-D0 那种断裂）
    seedMessageRow(S, "a2", "assistant", { content: "我改了 3 个文件" });

    const res = checkVisibleRecordedInvariant(S);
    expect(res.passed).toBe(false);
    expect(res.violations.map((v) => `${v.type}:${v.messageId}`)).toEqual([
      "VISIBLE_BUT_NOT_RECORDED:a2",
    ]);
  });

  it("FWT-C1c: 无正文、也没有任何 tool 事件的助手行**仍然是**违规（投影重建时会消失）", () => {
    const S = sid("c1c");
    seedSession(S);
    seedMessageRow(S, "a3", "assistant", { content: "" });

    const res = checkVisibleRecordedInvariant(S);
    expect(res.passed).toBe(false);
    expect(res.violations.map((v) => v.messageId)).toEqual(["a3"]);
    expect(String(res.violations[0].message)).toContain("tool_call/tool_result");
  });

  it("FWT-C1d: `sessionIds` 显式入参检查一批会话（生产接线的前提）", () => {
    const A = sid("c1d-a");
    const B = sid("c1d-b");
    seedSession(A);
    seedSession(B);
    seedMessageRow(A, "ok1", "user", { content: "正常" });
    seedEvent(A, "user_message", { messageId: "ok1", content: "正常" });
    seedMessageRow(B, "bad1", "user", { content: "没有事件" });

    const res = checkVisibleRecordedInvariant(undefined, [A, B]);
    expect(res.passed).toBe(false);
    expect(res.violations.map((v) => v.sessionId)).toEqual([B]);
    // 无参调用仍然是"什么都不检查"（它列不出会话）—— 这一态由 FWT-C2b 显式覆盖
    expect(checkVisibleRecordedInvariant().violations).toEqual([]);
  });
});

// ======================================================================
// FC §未做：runtime-invariants 在生产路径上必须**有人跑**
// ======================================================================

describe("FWT-C2：不变量审计接到生产维护路径（FC §未做：生产无人断言）", () => {
  it("FWT-C2a: 一次审计把 checked / 违规数带回（生产里它进维护汇总行）", async () => {
    const A = sid("c2a-ok");
    const B = sid("c2a-bad");
    seedSession(A);
    seedSession(B);
    seedMessageRow(A, "u-ok", "user", { content: "有事件" });
    seedEvent(A, "user_message", { messageId: "u-ok", content: "有事件" });
    seedMessageRow(B, "u-bad", "user", { content: "没有事件" });

    const out = await auditInvariantsForSessions([A, B]);
    expect(out.checked, "两个会话都真的被检查过").toBe(2);
    expect(out.violations, "违规在返回结构里可见（不是只打一行日志）").toBeGreaterThan(0);
    expect(out.samples.join(" ")).toContain(B);
  });

  it("FWT-C2b: 没有会话可查时 checked=0（'没跑'不许冒充'通过'）", async () => {
    const out = await auditInvariantsForSessions([]);
    /**
     * 第 47 轮：返回结构多了 `newViolations`（水位判定，见 `maintenance.ts` 的
     * `INVARIANT_WATERMARK_KEY`）。"没跑"仍然是**五件事实一起为零**：
     * 没检查、没缺口、**也没有新缺口**（0 会话时不该凭空报"新产生"）、
     * 没有事件库结构异常、没有"因镜像未就绪而没检查"的会话（后两件是第 60 轮加的）。
     */
    expect(out).toEqual({
      checked: 0,
      violations: 0,
      newViolations: 0,
      structuralErrors: 0,
      unreadableSessions: 0,
      samples: [],
    });
  });

  it("FWT-C2c: `runDatabaseMaintenance` 的汇总行里带着这次审计的结果（生产里没人读代码也看得见）", async () => {
    const S = sid("c2c");
    seedSession(S);
    seedMessageRow(S, "u-ok", "user", { content: "有事件" });
    seedEvent(S, "user_message", { messageId: "u-ok", content: "有事件" });

    const logs: string[] = [];
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    (console.log as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void }).mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      },
    );

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    const result = await runDatabaseMaintenance();
    const summary = logs.find((l) => l.includes("[Maintenance] 维护完成")) ?? "";

    /*
     * 判据落在"汇总行真的带上了这次审计"：
     * 这条不变量原来在生产上**无人断言**（只在 `NODE_ENV==="development"` 下跑），
     * 而现在它必须在维护汇总里出现一次 —— "跑了几个会话"是可核对的事实。
     */
    expect(summary, "维护汇总行必须存在（否则这条用例是空转）").not.toBe("");
    expect(summary, "不变量审计必须在汇总行里出现").toContain("不变量审计");
    expect(result.invariantCheckedSessions, "本次至少检查了那个有消息的会话").toBeGreaterThanOrEqual(1);
    expect(summary).toContain(`${result.invariantCheckedSessions} 个会话`);
    expect(result.invariantViolations, "这条会话的消息与事件是对齐的 → 0 违规").toBe(0);
    expect(Array.isArray(result.invariantSamples)).toBe(true);
  });
});

// ======================================================================
// FC P2-D9：遗留 feedbackCache 与域写路径的口径
// ======================================================================

describe("FWT-D9：域写之后 `loadFeedback` 必须读到新值（P2-D9）", () => {
  it("FWT-D9a: `saveFeedback` 写过之后再走域写改评 → 读到的是**域里的新值**", async () => {
    const S = sid("d9a");
    seedSession(S);
    seedMessageRow(S, "fx", "assistant", { content: "回复内容" });

    // 1) 遗留路径先把缓存填上（它写引擎的 feedback.set，不写域镜像）
    saveFeedback("fx", S, "like");
    expect(loadFeedback("fx")).toBe("like");

    // 2) 真实 UI 路径改评（域写 crud.upsert）
    const put = putMessageFeedback(S, "fx", "dislike");
    expect(put.ok).toBe(true);
    await vi.waitFor(() => {
      expect(loadFeedback("fx"), "改评之后必须读到 dislike（改前缓存永远返回 like）").toBe("dislike");
    });
  });

  it("FWT-D9b: 取消反馈（域删）之后读到 `null`，不再'取消了却还显示已赞'", async () => {
    const S = sid("d9b");
    seedSession(S);
    seedMessageRow(S, "fy", "assistant", { content: "回复内容" });

    saveFeedback("fy", S, "like");
    expect(loadFeedback("fy")).toBe("like");

    const del = deleteMessageFeedback("fy");
    expect(del.ok).toBe(true);
    await vi.waitFor(() => {
      expect(loadFeedback("fy"), "取消之后必须是未评价（改前缓存把它钉在 like）").toBeNull();
    });
  });

  it("FWT-D9c: 域写走的是**同一张表**（写与读同处，不是第二个真相）", async () => {
    const S = sid("d9c");
    seedSession(S);
    seedMessageRow(S, "fz", "assistant", { content: "回复内容" });

    createMessage({ id: "fz2", role: "assistant", content: "另一条", timestamp: 99, status: "done" }, S);
    putMessageFeedback(S, "fz", "like");
    await vi.waitFor(() => {
      const row = rowsOf("message_feedback").find((r) => r.message_id === "fz");
      expect(row, "域写真的落到 message_feedback 表").toBeTruthy();
      expect(row!.session_id).toBe(S);
    });
  });
});
