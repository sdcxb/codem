/**
 * 只追加面镜像契约测试（P3 第 5 段）。
 *
 * ## 这里唯一要守住的性质：**读与写必须在同一处**
 *
 * `EventLog` 的接口是同步的（`append(): SessionEvent`、`readAll(): SessionEvent[]`），
 * 而 Rust 是异步 IPC。所以我用"内存镜像 + 发件箱"来解 —— 但这带来一个**必须避免**的中间态：
 * 事件写进了镜像与 Rust 库，而 `readAll` 还在从旧库读 → 用户看到"记录不再更新"。
 *
 * 因此路由规则是硬性的：**只有该会话的事件已完整加载，才允许它的读写都走镜像**；
 * 否则一律留在旧路径。本文件把这条规则及其配套细节逐条钉住：
 *
 * 1. 未加载完 → `isLoaded` 为 false（判据本身）；
 * 2. 加载完成后 → 读写都走镜像；
 * 3. 加载**不能丢掉**加载期间本地追加的事件；
 * 4. 落库成功后用**真实 seq** 修正占位（seq 是全局 AUTOINCREMENT，本地猜不到水位）；
 * 5. 失败要走统一上报，不静默丢数据。
 *
 * ⚠️ **第 12 轮的修正（EV-11）**：上面第 1 条的后半句"继续走旧路径"**在 rust 引擎下是错的** ——
 * 旧库刻意不存在，"回退"只会变成抛错（真机形态：启动窗口期内事件整段丢失）。
 * 现在写路径（append / appendBatch / deleteAllForSession）在"端口是 rust"时**一律由端口接手**，
 * 与加载状态无关；镜像侧用占位 seq 承接窗口期写入，加载完成后 reconcile 对账成真实水位。
 * "未加载完不路由"这条规则**只对读路径**（以及需要读写同处的语义）继续成立。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";

const reported: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => reported.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => reported.push(note),
}));
/**
 * 假"旧库"（WASM）：**能真的用**，但记录访问次数与写入。
 *
 * 为什么不做成"一访问就抛"：加载窗口期内走旧库是**正确行为**（镜像还没加载完，
 * 两边必须待在同一处）。真正要断言的是"**路由之后**不再访问旧库"，
 * 所以这里要能工作，只是被计数。
 */
const legacyStore: Array<{ seq: number; session_id: string; event_type: string; payload: string; timestamp: number }> = [];
let legacyAccess = 0;
let legacySeq = 1000;

vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    legacyAccess++;
    return {
      run(sql: string, params: unknown[] = []) {
        if (/INSERT INTO session_events/i.test(sql)) {
          legacyStore.push({
            seq: ++legacySeq,
            session_id: String(params[0]),
            event_type: String(params[1]),
            payload: String(params[2]),
            timestamp: Number(params[3]),
          });
        } else if (/DELETE FROM session_events/i.test(sql)) {
          const sid = String(params[0]);
          for (let i = legacyStore.length - 1; i >= 0; i--) {
            if (legacyStore[i].session_id === sid) legacyStore.splice(i, 1);
          }
        } else if (/BEGIN|COMMIT|ROLLBACK/i.test(sql)) {
          /* 事务在假实现里是 no-op */
        }
      },
      exec(sql: string, params: unknown[] = []) {
        if (/last_insert_rowid/i.test(sql)) return [{ values: [[legacySeq]] }];
        if (/MAX\(seq\)/i.test(sql)) {
          const rows = legacyStore.filter((e) => e.session_id === String(params[0]));
          return [{ values: [[rows.length ? Math.max(...rows.map((r) => r.seq)) : 0]] }];
        }
        if (/COUNT\(\*\)/i.test(sql)) {
          const rows = legacyStore.filter((e) => e.session_id === String(params[0]));
          return [{ values: [[rows.length]] }];
        }
        if (/FROM session_events/i.test(sql)) {
          const sid = String(params[0]);
          const rows = legacyStore.filter((e) => e.session_id === sid).sort((a, b) => a.seq - b.seq);
          return [{ values: rows.map((r) => [r.seq, r.session_id, r.event_type, r.payload, r.timestamp]) }];
        }
        return [];
      },
    };
  },
  persistDatabase: () => {
    legacyAccess++;
  },
}));

interface StoredEvent {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  timestamp: number;
}

/** 假 transport：模拟 Rust 引擎的事件表（含全局单调 seq） */
function makeTransport(initial: StoredEvent[] = [], opts: { failAppend?: boolean } = {}) {
  let globalSeq = initial.reduce((m, e) => Math.max(m, e.seq), 0);
  const db: StoredEvent[] = [...initial];
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];

  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      calls.push({ command, params: p });
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") {
        return { ok: true, result: { quick_phrases: [], mcp_servers: [], memory: "" } } as never;
      }
      if (command === "events.list") {
        const sessionId = String(p.session_id ?? "");
        const from = p.from_seq === undefined ? 0 : Number(p.from_seq);
        const limit = Number(p.limit ?? 100);
        const all = db
          .filter((e) => e.session_id === sessionId && e.seq >= from)
          .sort((a, b) => a.seq - b.seq);
        const items = all.slice(0, limit);
        return {
          ok: true,
          result: { items, has_more: all.length > limit, next_cursor: null },
        } as never;
      }
      if (command === "events.append") {
        if (opts.failAppend) {
          return { ok: false, error: { code: "IO", message: "磁盘错误", retryable: true } } as never;
        }
        const seq = ++globalSeq;
        db.push({
          seq,
          session_id: String(p.session_id ?? ""),
          type: String(p.event_type ?? ""),
          payload: JSON.stringify(p.payload ?? {}),
          timestamp: Number(p.timestamp ?? 0),
        });
        return { ok: true, result: { written: 1, seq } } as never;
      }
      if (command === "events.append_batch") {
        const events = (p.events ?? []) as Array<{ type: string; payload: unknown; timestamp: number }>;
        const seqs: number[] = [];
        for (const e of events) {
          const seq = ++globalSeq;
          seqs.push(seq);
          db.push({
            seq,
            session_id: String(p.session_id ?? ""),
            type: e.type,
            payload: JSON.stringify(e.payload ?? {}),
            timestamp: e.timestamp,
          });
        }
        return { ok: true, result: { written: seqs.length, seqs } } as never;
      }
      if (command === "events.delete_session") {
        const sid = String(p.session_id ?? "");
        for (let i = db.length - 1; i >= 0; i--) if (db[i].session_id === sid) db.splice(i, 1);
        return { ok: true, result: { written: 1 } } as never;
      }
      return { ok: true, result: {} } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  return { transport, db, calls, nextSeq: () => globalSeq };
}

async function setupPort(initial: StoredEvent[] = [], opts: { failAppend?: boolean } = {}) {
  const { RustStoragePort } = await import("../core/storage/rust-port");
  const t = makeTransport(initial, opts);
  const port = new RustStoragePort(t.transport as never, (_s, _e, note) => reported.push(note));
  await port.start();
  setStoragePort(port);
  const { EventLog } = await import("../core/storage/event-log");
  return { port, log: EventLog.getInstance(), t };
}

/** 等后台加载/落库完成 */
const settle = async (ms = 30) => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, ms / 20 <= 1 ? 1 : ms / 20));
};

afterEach(() => {
  setStoragePort(null);
  reported.length = 0;
  legacyAccess = 0;
  vi.restoreAllMocks();
});

describe("只追加面 —— 路由规则（读与写必须在同一处）", () => {
  it("EV-1: 未加载完的会话 `isLoaded` 为 false（路由判据本身）", async () => {
    const { port } = await setupPort();
    // 刻意不 warmup：该会话未加载。
    // 注意（第 12 轮改写）：这里**只**断言"加载状态"这条判据本身 ——
    // 从前它同时隐含"未加载完就写旧库"，而那条规则在 rust 引擎下是错的
    // （旧库刻意不存在，写路径直接抛）→ 见 EV-11。
    expect(port.events.isLoaded("s-new"), "未加载就该是 false").toBe(false);
  });

  it("EV-11: 未加载完时 append 也由端口接手（B 态不许回退旧库）", async () => {
    /**
     * 这是 `rustEventPortAny()` 存在的理由：`rustEventPort()` 要求"已加载才路由"，
     * 那条规则的本意是**避免读写分裂**（写进镜像、读还从旧库）。而 rust 引擎下旧库
     * 刻意不存在 —— 没有旧库可分裂，剩下的只有"写路径抛错"：
     * 真机表现为启动窗口期内的事件整段丢失（`append` 第一行 `getDatabase()` 抛）。
     *
     * 镜像侧对窗口期写入是有准备的：占位 seq 会被 `loadSession` 保留（`pendingLocal`），
     * 加载完成后由 `reconcile` 对账成真实水位 —— 所以这里同时验证"加载后不丢"。
     */
    const { port, log } = await setupPort([]);
    // 刻意不 warmup
    expect(port.events.isLoaded("s-new")).toBe(false);

    const ev = log.append("s-new", "user_message", { x: 1 });
    await settle();

    expect(legacyAccess, "B 态**不得**访问旧库（rust 下它刻意不存在）").toBe(0);
    expect(ev.seq, "占位 seq 必须是个正数（加载后会对账成真实水位）").toBeGreaterThan(0);

    // 加载完成后：窗口期写入的事件既在镜像里、也已落库，一条都不丢
    port.events.ensureLoaded("s-new");
    await settle();
    const after = log.readAll("s-new");
    expect(after.map((e) => e.payload)).toContainEqual({ x: 1 });
    expect(after[0].type).toBe("user_message");
    expect(legacyAccess, "加载完成后同样不得访问旧库").toBe(0);
  });

  it("EV-2: ensureLoaded 之后 isLoaded 为真，且能读到库里已有的事件", async () => {
    const { port, log } = await setupPort([
      { seq: 5, session_id: "s1", type: "user_message", payload: '{"a":1}', timestamp: 100 },
      { seq: 9, session_id: "s1", type: "assistant_text", payload: '{"b":2}', timestamp: 200 },
    ]);
    port.events.ensureLoaded("s1");
    await settle();
    expect(port.events.isLoaded("s1")).toBe(true);

    const all = log.readAll("s1");
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(5);
    expect(all[1].seq).toBe(9);
    expect(all[1].payload).toEqual({ b: 2 });
    expect(legacyAccess, "已路由到镜像后不得访问旧库").toBe(0);
  });

  it("EV-3: 加载完成后 append 走镜像与发件箱，且立刻能从镜像读到", async () => {
    const { port, log, t } = await setupPort([]);
    port.events.ensureLoaded("s1");
    await settle();

    log.append("s1", "user_message", { text: "你好" });
    const after = log.readAll("s1");
    expect(after, "写入后必须立刻可读（同一处）").toHaveLength(1);
    expect(after[0].payload).toEqual({ text: "你好" });
    expect(legacyAccess, "不得访问旧库").toBe(0);

    await settle();
    expect(t.calls.some((c) => c.command === "events.append"), "必须真的发起了落库").toBe(true);
    expect(t.db, "发件箱应已落库").toHaveLength(1);
  });

  it("EV-4: 落库成功后用**真实 seq** 修正占位（seq 是全局 AUTOINCREMENT）", async () => {
    const { port, log, t } = await setupPort([
      { seq: 100, session_id: "other", type: "x", payload: "{}", timestamp: 1 },
    ]);
    port.events.ensureLoaded("s1");
    await settle();

    const evt = log.append("s1", "user_message", { n: 1 });
    expect(evt.seq, "返回的是占位值（本地猜不到全局水位）").toBeGreaterThan(1_000_000);

    await settle();
    const mirror = log.readAll("s1");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].seq, "镜像里的 seq 必须被修正为引擎回传的真实值").toBe(101);
    expect(t.db.find((e) => e.session_id === "s1")?.seq).toBe(101);
  });

  it("EV-5: 加载**不能丢掉**加载期间本地追加的事件", async () => {
    const { port, log, t } = await setupPort([
      { seq: 1, session_id: "s1", type: "old", payload: '{"old":true}', timestamp: 1 },
    ]);
    // 触发加载（后台进行），**立刻**在加载完成前追加一条
    port.events.ensureLoaded("s1");
    log.append("s1", "user_message", { during: "load" });
    await settle();

    const all = log.readAll("s1");
    expect(all.some((e) => e.type === "user_message"), "加载期间追加的事件不能丢").toBe(true);
    expect(all.some((e) => e.type === "old"), "库里原有的事件也要在").toBe(true);
    expect(new Set(all.map((e) => e.type)).size, "不得重复计入").toBe(all.length);
    // 最终一致：窗口期的事件被补写进 Rust 库（发件箱），两处都有
    expect(
      t.db.filter((e) => e.session_id === "s1").some((e) => e.type === "user_message"),
      "窗口期事件必须补写进 Rust 库，否则切引擎后会消失",
    ).toBe(true);
  });

  it("EV-6: 批量追加走镜像：seq 占位、落库后用真实 seq 修正，且不重复", async () => {
    const { port, log, t } = await setupPort([]);
    port.events.ensureLoaded("s1");
    await settle();

    const events = log.appendBatch("s1", [
      { type: "a", payload: { i: 0 } },
      { type: "b", payload: { i: 1 } },
      { type: "c", payload: { i: 2 } },
    ]);
    expect(events).toHaveLength(3);
    expect(log.count("s1"), "镜像里就应该是 3 条（不可重复）").toBe(3);

    await settle();
    const seqs = t.db.filter((e) => e.session_id === "s1").map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toHaveLength(3);
    expect(seqs[2] - seqs[0], "同一批次的真实 seq 必须连续").toBe(2);
    expect(log.count("s1")).toBe(3);
  });

  it("EV-7: 落库失败要上报，且镜像仍保留已追加的事件（不静默丢）", async () => {
    const { port, log } = await setupPort([], { failAppend: true });
    port.events.ensureLoaded("s1");
    await settle();

    log.append("s1", "user_message", { text: "会失败" });
    await settle();
    expect(reported.some((n) => n.includes("JSONL")), "必须上报（权威副本是 JSONL）").toBe(true);
    expect(log.readAll("s1"), "本次会话内仍应可读（数据在镜像里）").toHaveLength(1);
  });

  it("EV-8: deleteAllForSession 走镜像时立刻清空并排队落库", async () => {
    const { port, log, t } = await setupPort([
      { seq: 3, session_id: "s1", type: "x", payload: "{}", timestamp: 1 },
    ]);
    port.events.ensureLoaded("s1");
    await settle();
    expect(log.count("s1")).toBe(1);

    log.deleteAllForSession("s1");
    expect(log.count("s1"), "镜像立刻清空").toBe(0);
    await settle();
    expect(t.db.filter((e) => e.session_id === "s1"), "库里也应被删除").toHaveLength(0);
  });

  it("EV-9: readFrom / readRange / getLatestSeq 在镜像上语义正确", async () => {
    const { port, log } = await setupPort([
      { seq: 10, session_id: "s1", type: "a", payload: "{}", timestamp: 1 },
      { seq: 20, session_id: "s1", type: "b", payload: "{}", timestamp: 2 },
      { seq: 30, session_id: "s1", type: "c", payload: "{}", timestamp: 3 },
    ]);
    port.events.ensureLoaded("s1");
    await settle();

    expect(log.getLatestSeq("s1")).toBe(30);
    expect(log.readFrom("s1", 20).map((e) => e.seq)).toEqual([20, 30]);
    expect(log.readRange("s1", 15, 25).map((e) => e.seq)).toEqual([20]);
    expect(log.count("s1")).toBe(3);
  });

  it("EV-10: forkSession 在两端都已加载时走镜像，两侧都拿得到", async () => {
    const { port, log } = await setupPort([
      { seq: 1, session_id: "src", type: "a", payload: '{"i":0}', timestamp: 1 },
      { seq: 2, session_id: "src", type: "b", payload: '{"i":1}', timestamp: 2 },
    ]);
    port.events.ensureLoaded("src");
    port.events.ensureLoaded("dst");
    await settle();

    const n = log.forkSession("src", "dst");
    expect(n).toBe(2);
    expect(log.count("src"), "源会话不受影响").toBe(2);
    expect(log.count("dst"), "目标会话应拿到副本").toBe(2);
    await settle();
    expect(log.readAll("dst").map((e) => e.type)).toEqual(["a", "b"]);
  });
});
