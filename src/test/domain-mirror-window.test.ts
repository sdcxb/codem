/**
 * 域镜像的「就绪态 / 上限 / 投影」—— A 类缺陷的回归测试（FIX-A，第 20 轮）
 *
 * ## 为什么单独一个文件
 *
 * 这些用例守的是**加载窗口**（`ensureLoaded` 已发起、`isReady` 还没真）
 * 这个瞬时态上的行为。而 `fake-storage-port.ts` **默认是同步就绪**的
 * （见那个文件头：为了不动 5194 个既有用例），所以既有套件在结构上
 * **看不见**这一类缺陷 —— `domainWrite` 的"首触必丢"就是这么活到今天的。
 *
 * 因此本文件**显式**切到异步端口（`__setAsyncLoad(true)` 或 `asyncLoad: true`）：
 * 加载窗口必须真实存在，这一组断言才有意义。
 *
 * | 用例 | 守什么 | 缺陷编号 |
 * | --- | --- | --- |
 * | WIN-1~4 | 首次写（加载窗口内）必须入队并在就绪后落库 | A-1 |
 * | WIN-5~7 | 删除/谓词删除的入队、超限、上报次数 | A-1 |
 * | WIN-8~9 | 队列上限与"永不就绪"不许排队 | A-1 |
 * | LIMIT-1~4 | `refused` 可重试（退避 + 显式重试），不再是永久空 | A-2 |
 * | CAP-1~4 | `rustCapabilities` 按真实线协议（裸 Value）解析 | A-5 |
 * | RETRY-1~5 | 有界写重试：只重试幂等写，耗尽后仍如实失败 | A-6 |
 * | FAKE-1~3 | 假端口与真端口语义一致（hidden 保留 / 异步开关） | A-7 |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import {
  __resetDeferredWritesForTests,
  deferredWriteStats,
  domainDelete,
  domainDeleteWhere,
  domainEnsureLoaded,
  domainPort,
  domainReplaceTable,
  domainWrite,
} from "../core/storage/domain-store";
import { RustStoragePort, rustCapabilities, type StorageTransport } from "../core/storage/rust-port";
import { StorageError } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const TABLE = "todo_lists";
const opts = { scope: "test.scope", note: "测试用（应上报）" };

/**
 * 让**微任务**跑完。
 *
 * 假端口的异步就绪是"下一个微任务"，所以 `await Promise.resolve()` 串几次就够；
 * 但端口的写穿是 `void …catch(…)` 形态（不阻塞调用方），失败上报落在更靠后的
 * 微任务里，所以用 `setTimeout(0)` 把它们一起排空 —— 比猜"要 await 几次"可靠。
 */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let failures: string[];
let errors: string[];

beforeEach(() => {
  failures = [];
  errors = [];
  __resetDeferredWritesForTests();
  /*
   * 丢弃**必须可见**：统一上报通道 `reportPersistFailure` 走的是 `console.error`
   * （见 `persist-failure.ts`）+ 一次窗口事件。所以这里接住 error 流，
   * 断言"排不进队列的写"确实被如实报出来了 —— 而不是悄悄消失。
   */
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  setStoragePort(null);
  __resetDeferredWritesForTests();
  vi.restoreAllMocks();
});

// ========== A-1：首触必丢 ==========

describe("A-1 加载窗口里的写：必须入队 + 就绪后落库（而不是静默丢弃）", () => {
  it("WIN-1: 首触写在**同一 tick** 里返回 true（已接手），且就绪后确实落到库里", async () => {
    const port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);

    /*
     * 关键：不先 `ensureLoaded`+等待 —— 直接写。
     * 这正是"每次启动后第一次写"的真实形状：`domainWrite` 自己会触发加载，
     * 而加载是异步的，所以这一刻 `isReady` 是 false。
     */
    const accepted = domainWrite(TABLE, [{ id: "t1", title: "首触" }], opts);
    expect(accepted, "入队即算已接手（否则调用方会立刻上报一次假失败）").toBe(true);
    expect(deferredWriteStats().pending, "这一笔必须真的进了队列").toBe(1);

    await flush();

    expect(port.__table(TABLE).map((r) => r.id), "就绪后必须真的落库").toEqual(["t1"]);
    expect(deferredWriteStats().pending, "重放之后队列必须排空").toBe(0);
    const writes = port.__writes().filter((w) => w.command === "crud.upsert");
    expect(writes.length, "crud.upsert 必须发出（而不是只改了内存）").toBe(1);
    expect((writes[0].params?.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "t1",
      title: "首触",
    });
  });

  it("WIN-2: **修之前会失败**的对照 —— 未切异步时是当场写穿（所以旧用例看不见这个窗口）", () => {
    const port = createFakeStoragePort(); // 默认同步就绪
    setStoragePort(port);
    const accepted = domainWrite(TABLE, [{ id: "t1" }], opts);
    expect(accepted).toBe(true);
    expect(deferredWriteStats().pending, "同步就绪下不该排队（当场写穿）").toBe(0);
    expect(port.__table(TABLE).map((r) => r.id)).toEqual(["t1"]);
  });

  it("WIN-3: 队列按**入队顺序**重放（顺序错了就是数据错）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);

    domainWrite(TABLE, [{ id: "a", order: 1 }], opts);
    domainWrite(TABLE, [{ id: "b", order: 2 }], opts);
    domainWrite(TABLE, [{ id: "c", order: 3 }], opts);
    expect(deferredWriteStats().pending).toBe(3);

    await flush();

    const batchSizes = port
      .__writes()
      .filter((w) => w.command === "crud.upsert")
      .map((w) => (w.params?.rows as Array<Record<string, unknown>>)[0].id);
    expect(batchSizes, "重放顺序必须与入队顺序一致").toEqual(["a", "b", "c"]);
  });

  it("WIN-4: 重放**同时更新镜像** —— 就绪后紧接着的同步读能看到刚写的行", async () => {
    const port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);
    domainWrite(TABLE, [{ id: "t1", title: "镜像也要有" }], opts);
    await flush();

    const mirror = domainPort(TABLE);
    expect(mirror, "重放之后镜像应当已就绪").not.toBeNull();
    expect(mirror!.domains.all<Record<string, unknown>>(TABLE).map((r) => r.id)).toEqual(["t1"]);
  });

  it("WIN-5: 加载窗口里的**删除**同样入队（不是只修了写）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, seed: { [TABLE]: [{ id: "x" }] } });
    setStoragePort(port);

    // 先触发加载，但不等它完成 —— 这一刻就在窗口里
    expect(domainDelete(TABLE, { id: "x" }, opts), "入队即算已接手").toBe(true);
    expect(deferredWriteStats().pending).toBe(1);

    await flush();
    expect(port.__table(TABLE), "删除必须真的落到库里").toEqual([]);
    expect(port.__writes().some((w) => w.command === "crud.delete")).toBe(true);
  });

  it("WIN-6: `domainDeleteWhere` 在窗口里**如实返回 null**（不许把'没接手'说成'删了 0 行'）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, seed: { [TABLE]: [{ id: "x", n: 1 }] } });
    setStoragePort(port);

    const removed = domainDeleteWhere(TABLE, () => true, "id", opts);
    /*
     * `null` 的语义是"未接手"，`0` 的语义是"接手了、确实没有要删的行"。
     * 这两者被压成同一个值时，调用方的清理逻辑会把"什么都没做"读成"清理完成"。
     */
    expect(removed, "未接手必须是 null，不能是 0").toBeNull();
    expect(deferredWriteStats().pending, "但这次删除必须被排队，不能丢").toBe(1);
    await flush();
  });

  it("WIN-7: **永不就绪**的表不排队、不上报丢弃、如实返回未接手", () => {
    const port = createFakeStoragePort({ neverReady: [TABLE] });
    setStoragePort(port);
    expect(domainWrite(TABLE, [{ id: "a" }], opts), "永远不成的写不该说成'已接手'").toBe(false);
    expect(domainDelete(TABLE, { id: "a" }, opts)).toBe(false);
    expect(domainDeleteWhere(TABLE, () => true, "id", opts)).toBeNull();
    expect(deferredWriteStats().pending, "永不就绪的表不许进队列（会只涨不消）").toBe(0);
  });

  it("WIN-8: 队列满时**显式上报丢弃**（绝不静默丢数据）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);

    // 第一笔触发加载（占据窗口），随后把队列灌到上限
    const accepted: boolean[] = [];
    for (let i = 0; i < 520; i++) {
      accepted.push(domainWrite(TABLE, [{ id: `t${i}` }], opts));
    }
    const stats = deferredWriteStats();
    expect(stats.dropped, "超过上限的写必须被计数并上报").toBeGreaterThan(0);
    expect(stats.pending).toBeLessThanOrEqual(500);
    expect(accepted.filter((a) => !a).length, "被拒的写必须如实返回 false").toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("域写队列已满");
    await flush();
  });

  it("WIN-9: 重放失败**如实上报一次**（不留假成功）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true, failWrites: true });
    setStoragePort(port);
    domainWrite(TABLE, [{ id: "t1" }], { scope: "win9.scope", note: "WIN-9 应上报" });
    await flush();
    expect(port.__writeFailures(), "落库失败必须被记账").toBeGreaterThan(0);
    expect(deferredWriteStats().pending, "无论成败队列都要排空").toBe(0);
  });
});

// ========== A-2：refused 必须可重试 ==========

/**
 * 造一个"第一次列表就超上限、之后恢复正常"的传输层。
 *
 * 用它复现真机形态：`turn_file_changes` 本来 5001 行（被拒），
 * 用户删掉旧会话之后只剩 1 行 —— 旧代码里这张表**永远不会**再被尝试。
 */
function overflowThenNormalTransport(rowsWhenOversized: number) {
  const executed: Array<{ command: string; params?: Record<string, unknown> }> = [];
  let oversized = true;
  const transport: StorageTransport = {
    async invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      executed.push({ command, params });
      if (command === "crud.list") {
        const limit = Number(params?.limit ?? 1000);
        const offset = Number(params?.offset ?? 0);
        const count = oversized ? rowsWhenOversized : 1;
        const items = Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => ({
          id: `r${offset + i}`,
        }));
        return { ok: true, result: { items, has_more: offset + items.length < count, next_cursor: null } } as T;
      }
      if (command === "settings.get_all" || command === "config_warmup") {
        return { ok: true, result: {} } as T;
      }
      return { ok: true, result: { written: 1 } } as T;
    },
    async invokeBatch<T>(): Promise<T> {
      return { ok: true, result: { count: 0, results: [] } } as T;
    },
    async health<T>(): Promise<T> {
      return { ok: true, result: { ready: true, engine: "rust" } } as T;
    },
    async integrityCheck<T>(): Promise<T> {
      return { ok: true, result: { ok: true } } as T;
    },
    async checkpoint<T>(): Promise<T> {
      return { ok: true, result: { ok: true } } as T;
    },
    async capabilities<T>(): Promise<T> {
      return { commands: [] } as T;
    },
  };
  return {
    transport,
    executed,
    shrink: () => {
      oversized = false;
    },
  };
}

describe("A-2 镜像超限之后必须能恢复（不再是'进程内永久空'）", () => {
  it("LIMIT-1: 超限被拒后，**退避窗口一过**的下一次访问会重新尝试并成功", async () => {
    const t = overflowThenNormalTransport(5001);
    const port = new RustStoragePort(t.transport, () => {});
    const domains = port.domains;

    domains.ensureLoaded(TABLE);
    await flush();
    expect(domains.isReady(TABLE), "超限必须放弃镜像").toBe(false);
    expect(domains.stats().refused).toContain(TABLE);

    // 库变小了（用户删了旧会话 / 维护清理跑过）
    t.shrink();
    // 把"上次尝试时间"推回退避窗口之前：用假时钟比等 30 秒现实
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    domains.ensureLoaded(TABLE);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await flush();

    expect(domains.isReady(TABLE), "退避之后必须重新尝试，而不是永久拒绝").toBe(true);
    expect(domains.stats().refused, "重试成功必须把它从被拒集合里移除").not.toContain(TABLE);
  });

  it("LIMIT-2: `retryRefusedTables()` 提供**立即**重试（重建时机不必等退避）", async () => {
    const t = overflowThenNormalTransport(5001);
    const port = new RustStoragePort(t.transport, () => {});
    port.domains.ensureLoaded(TABLE);
    await flush();
    expect(port.domains.isReady(TABLE)).toBe(false);

    t.shrink();
    const retried = port.domains.retryRefusedTables();
    expect(retried, "必须把被拒的表列出来（供日志与断言）").toEqual([TABLE]);
    await flush();

    expect(port.domains.isReady(TABLE), "立即重试必须真的重新发起加载").toBe(true);
  });

  it("LIMIT-3: 重试**仍然超限**时保持被拒（不会退化成'每次访问都白拉一遍'）", async () => {
    const t = overflowThenNormalTransport(5001);
    const port = new RustStoragePort(t.transport, () => {});
    port.domains.ensureLoaded(TABLE);
    await flush();
    const listCallsAfterFirst = t.executed.filter((e) => e.command === "crud.list").length;

    // 连续多次访问：退避窗口内不该再拉整表
    for (let i = 0; i < 5; i++) port.domains.ensureLoaded(TABLE);
    await flush();
    expect(
      t.executed.filter((e) => e.command === "crud.list").length,
      "窗口内重复访问不得反复白拉几千行",
    ).toBe(listCallsAfterFirst);
    expect(port.domains.isReady(TABLE)).toBe(false);
  });

  it("LIMIT-4: 被拒表的**读路径仍然给空结果**（不是抛错、也不是旧库）", async () => {
    const t = overflowThenNormalTransport(5001);
    const port = new RustStoragePort(t.transport, () => {});
    setStoragePort(port);
    port.domains.ensureLoaded(TABLE);
    await flush();
    const { domainReadMany } = await import("../core/storage/domain-store");
    expect(domainReadMany(TABLE, (r) => r), "未接手 → undefined（调用方给该域的合理空结果）").toBeUndefined();
  });
});

// ========== A-5：能力自省的真实线协议 ==========

describe("A-5 `rustCapabilities` 必须按真实线协议（裸 Value）解析", () => {
  function transportReturning(payload: unknown): StorageTransport {
    return {
      async invokeCommand<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async invokeBatch<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async health<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async integrityCheck<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async checkpoint<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async capabilities<T>(): Promise<T> {
        return payload as T;
      },
    };
  }

  /**
   * **线协议夹具**：逐字取自 `src-tauri/codem-db/src/lib.rs::capabilities()`
   * （`storage_capabilities` 直接返回它，**没有** `{ok, result}` 包装）。
   */
  const REAL_WIRE_FIXTURE = {
    engine: "rust",
    commands: ["settings.get_all", "crud.upsert", "crud.list", "messages.upsert_index"],
    max_rows_per_query: 5000,
    max_bytes_per_query: 8_388_608,
    no_whole_file_export: true,
    migration_primitives: {
      note: "import.table 是受控的结构化通道",
      tables: 40,
      fts_shadow_excluded: true,
    },
  };

  it("CAP-1: 真实形状（裸 Value）必须解析出**非空**命令清单与架构承诺", async () => {
    const caps = await rustCapabilities(transportReturning(REAL_WIRE_FIXTURE));
    expect(caps.commands, "能力集恒空就是缺陷本身（原来按扁平字段读是错的）").not.toEqual([]);
    expect(caps.commands).toContain("crud.upsert");
    expect(caps.commands).toContain("messages.upsert_index");
    expect(caps.max_rows_per_query, "硬上限必须解出来（分页判据用它）").toBe(5000);
    expect(caps.no_whole_file_export, "架构承诺必须解出来（契约测试的判据）").toBe(true);
  });

  it("CAP-2: 兼容 `{ok, result}` 包装（同一份数据包起来也给同样的答案）", async () => {
    const caps = await rustCapabilities(transportReturning({ ok: true, result: REAL_WIRE_FIXTURE }));
    expect(caps.commands).toEqual(REAL_WIRE_FIXTURE.commands);
    expect(caps.no_whole_file_export).toBe(true);
  });

  it("CAP-3: 失败响应**抛错**，不许静默变成'没有能力'", async () => {
    const transport = transportReturning({
      ok: false,
      error: { code: "UNAVAILABLE", message: "存储引擎未就绪", retryable: true },
    });
    const err = await rustCapabilities(transport).catch((e) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe("UNAVAILABLE");
  });

  it("CAP-4: 形状完全认不出来时抛错（而不是返回一个看起来合法的空能力集）", async () => {
    await expect(rustCapabilities(transportReturning(null))).rejects.toBeInstanceOf(StorageError);
    await expect(rustCapabilities(transportReturning("WAT"))).rejects.toBeInstanceOf(StorageError);
  });
});

// ========== A-6：有界写重试 ==========

describe("A-6 有界写重试（幂等写才重试，耗尽后仍如实失败）", () => {
  /** 造一个"前 N 次 BUSY、之后成功"的传输层 */
  /**
   * ## 第 45 轮修正：`retryable` 必须**与 code 自洽**（原来恒为 `true`）
   *
   * 这个夹具原来无论什么 `code` 都回 `retryable: true` —— 对 `BUSY` 是对的，对 `NOMEM`
   * 就与引擎矛盾了（`error.rs` 里 NOMEM 不可重试）。在"渲染侧只按 `code` 重算"的旧实现下，
   * 这个矛盾字段被丢掉、看不出来；第 45 轮把**引擎的 `retryable` 提升为权威**
   * （见 `rust-port.ts::toStorageError` 的说明）之后，RETRY-4 立刻红了 ——
   * 红的是**夹具的不自洽**，不是判据：一个真实的引擎绝不会说"NOMEM 可重试"。
   *
   * 所以这里按引擎的策略生成：只有 BUSY / LOCKED / IO / UNAVAILABLE 才是可重试的。
   */
  function busyThenOk(failTimes: number, code = "BUSY") {
    const retryable = ["BUSY", "LOCKED", "IO", "UNAVAILABLE"].includes(code);
    let attempts = 0;
    const transport: StorageTransport = {
      async invokeCommand<T>(): Promise<T> {
        attempts++;
        if (attempts <= failTimes) {
          return {
            ok: false,
            error: { code, message: "database is locked", retryable, hint: "稍后重试" },
          } as T;
        }
        return { ok: true, result: { written: 1 } } as T;
      },
      async invokeBatch<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async health<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async integrityCheck<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async checkpoint<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async capabilities<T>(): Promise<T> {
        return { commands: [] } as T;
      },
    };
    return {
      transport,
      attempts: () => attempts,
    };
  }

  it("RETRY-1: `crud.upsert` 前两次 BUSY、第三次成功 → **最终成功**（调用方不会看到失败）", async () => {
    const t = busyThenOk(2);
    const port = new RustStoragePort(t.transport, () => {});
    const r = await port.data.execute("crud.upsert", { table: TABLE, rows: [{ id: "a" }] });
    expect(r.written).toBe(1);
    expect(t.attempts(), "必须真的重试到第三次").toBe(3);
    expect(port.retryStats().count, "重试次数必须可观测（诊断不能靠猜）").toBe(2);
  });

  it("RETRY-2: `messages.upsert_index`（幂等）同样会重试；`settings.set` 也是", async () => {
    const a = busyThenOk(1);
    const portA = new RustStoragePort(a.transport, () => {});
    await expect(portA.data.execute("messages.upsert_index", { id: "m1", session_id: "s1" })).resolves.toBeTruthy();
    expect(a.attempts()).toBe(2);

    const b = busyThenOk(1);
    const portB = new RustStoragePort(b.transport, () => {});
    const res = await (portB.data as unknown as { execute: (c: string, p: Record<string, unknown>) => Promise<unknown> }).execute(
      "settings.set",
      { key: "k", value: "v" },
    );
    expect(res).toBeTruthy();
    expect(b.attempts()).toBe(2);
  });

  it("RETRY-3: **非幂等写绝不重试** —— `crud.delete` 只发一次", async () => {
    const t = busyThenOk(99);
    const port = new RustStoragePort(t.transport, () => {});
    const err = await port.data.execute("crud.delete", { table: TABLE, where: { id: "a" } }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(t.attempts(), "删除重试 = 语义不明的重复破坏性操作，只许发一次").toBe(1);
    expect(port.retryStats().count).toBe(0);
  });

  it("RETRY-4: **不可重试的错误只发一次**（NOMEM / CONSTRAINT 不是瞬时的）", async () => {
    const t = busyThenOk(99, "NOMEM");
    const port = new RustStoragePort(t.transport, () => {});
    const err = await port.data.execute("crud.upsert", { table: TABLE, rows: [] }).catch((e) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code, "码必须原样保留给调用方").toBe("NOMEM");
    expect(t.attempts(), "不可重试的错误重试只是浪费一次往返").toBe(1);
  });

  it("RETRY-5: 重试**耗尽**后仍然如实失败（不吞掉最终错误）", async () => {
    const t = busyThenOk(99);
    const port = new RustStoragePort(t.transport, () => {});
    const err = await port.data.execute("crud.upsert", { table: TABLE, rows: [] }).catch((e) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code, "耗尽之后必须把引擎的错原样抛给调用方").toBe("BUSY");
    expect(t.attempts(), "上限 3 次尝试（1 次原始 + 2 次重试）").toBe(3);
  });
});

// ========== A-7：假端口与真端口语义一致 ==========

describe("A-7 假端口必须呈现真端口语义", () => {
  it("FAKE-1: `__setAsyncLoad(true)` 打开加载窗口，`isLoading` 随之可见", async () => {
    const port = createFakeStoragePort({ seed: { [TABLE]: [{ id: "a" }] } });
    port.__setAsyncLoad(true);
    setStoragePort(port);

    port.domains.ensureLoaded(TABLE);
    expect(port.domains.isReady(TABLE), "切到异步后**不能**同步就绪（真端口要过一次 IPC）").toBe(false);
    expect(port.domains.isLoading(TABLE), "窗口期内必须如实回答'正在加载'").toBe(true);
    await flush();
    expect(port.domains.isReady(TABLE)).toBe(true);
    expect(port.domains.isLoading(TABLE)).toBe(false);
  });

  it("FAKE-2: `applyWrite` 未提供 `hidden` 时**保留已有值**（与真镜像一致，A-3）", () => {
    const port = createFakeStoragePort({
      seed: { messages: [{ id: "m1", session_id: "s1", role: "user", content: "x", hidden: 1 }] },
    });
    setStoragePort(port);
    port.messages.ensureLoaded("s1");
    port.messages.__markLoaded("s1");

    // 与 `writeIndexViaRust` 的真实形状一致：**不传 hidden**
    port.applyMessageWrite({ id: "m1", session_id: "s1", content: "更新后的内容" });

    const row = port.__table("messages").find((r) => r.id === "m1")!;
    expect(row.content, "正文必须更新").toBe("更新后的内容");
    expect(row.hidden, "「未提供」不等于「置 0」—— 否则被压缩的消息会复活").toBe(1);
  });

  it("FAKE-3: `domains.applyWrite` 未提供的列不会把已有值抹掉", () => {
    const port = createFakeStoragePort({ seed: { [TABLE]: [{ id: "a", title: "旧标题", n: 7 }] } });
    setStoragePort(port);
    port.domains.ensureLoaded(TABLE);
    port.domains.applyWrite(TABLE, { id: "a", title: "新标题", n: undefined });
    const row = port.__table(TABLE).find((r) => r.id === "a")!;
    expect(row.title).toBe("新标题");
    expect(row.n, "undefined 不得覆盖已有值").toBe(7);
  });
});

// ========== A-3：RustMessageMirror.applyWrite ==========

describe("A-3 消息索引镜像的写入必须保住 hidden 与 generated_files", () => {
  /** 造一个"messages.list 返回给定行"的传输层 */
  function transportWithRows(rows: Array<Record<string, unknown>>) {
    const transport: StorageTransport = {
      async invokeCommand<T>(command: string): Promise<T> {
        if (command === "messages.list") {
          return { ok: true, result: { items: rows, has_more: false, next_cursor: null } } as T;
        }
        if (command === "settings.get_all" || command === "config_warmup") {
          return { ok: true, result: {} } as T;
        }
        return { ok: true, result: { written: 1 } } as T;
      },
      async invokeBatch<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async health<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async integrityCheck<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async checkpoint<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async capabilities<T>(): Promise<T> {
        return { commands: [] } as T;
      },
    };
    return transport;
  }

  it("MSG-MIRROR-1: 未提供 `hidden` 时保留镜像里的值（不是当 0 打回）", async () => {
    const port = new RustStoragePort(
      transportWithRows([
        {
          id: "m1",
          session_id: "s1",
          role: "assistant",
          content: "旧",
          timestamp: 1,
          status: "done",
          hidden: 1, // 被压缩（软删除）过的消息
          generated_files: null,
        },
      ]),
      () => {},
    );
    setStoragePort(port);
    port.warmupMessages("s1");
    await flush();

    /*
     * 与 `writeIndexViaRust`（message.ts）的**真实调用形状**一致：不传 hidden。
     * 流式 `updateMessage` 每次都走这条路，所以"未提供 = 置 0"等于
     * 每次流式更新都把已压缩的消息复活 —— 上下文再也缩不小。
     */
    port.applyMessageWrite({
      id: "m1",
      session_id: "s1",
      content: "新",
      role: "user",
      timestamp: 1,
    } as never);

    const after = port.messages.byIdLookup("m1");
    expect(after?.content, "正文必须更新").toBe("新");
    expect(after?.hidden, "hidden 必须保住（否则读路径会把已压缩的行加回来）").toBe(1);
  });

  it("MSG-MIRROR-2: `generated_files` 必须在写入时被维护（写后读不能丢）", async () => {
    const port = new RustStoragePort(
      transportWithRows([
        {
          id: "m1",
          session_id: "s1",
          role: "assistant",
          content: "旧",
          timestamp: 1,
          status: "done",
          hidden: 0,
          generated_files: null,
        },
      ]),
      () => {},
    );
    setStoragePort(port);
    port.warmupMessages("s1");
    await flush();

    port.applyMessageWrite({
      id: "m1",
      session_id: "s1",
      content: "新",
      role: "assistant",
      timestamp: 1,
      generated_files: JSON.stringify(["a.ts"]),
    } as never);

    expect(
      port.messages.byIdLookup("m1")?.generated_files,
      "`upsert_index` 每次都带这一列，镜像就必须跟着更新 —— 否则要等下次整会话重载",
    ).toBe(JSON.stringify(["a.ts"]));
  });
});

// ========== A-2：turn_file_changes 列投影 ==========

describe("A-2 `turn_file_changes` 的 `patch` 正文不进镜像（列投影）", () => {
  /** 造一个对 `crud.list` 响应投影的分页传输层（真引擎同样按 `columns` 裁剪） */
  function projectionTransport(rows: Array<Record<string, unknown>>) {
    const seen: Array<Record<string, unknown>> = [];
    const transport: StorageTransport = {
      async invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
        if (command === "crud.list") {
          seen.push({ ...(params ?? {}) });
          const cols = params?.columns as string[] | undefined;
          const picked = cols
            ? rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])))
            : rows;
          return { ok: true, result: { items: picked, has_more: false, next_cursor: null } } as T;
        }
        if (command === "settings.get_all" || command === "config_warmup") {
          return { ok: true, result: {} } as T;
        }
        return { ok: true, result: { written: 1 } } as T;
      },
      async invokeBatch<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async health<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async integrityCheck<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async checkpoint<T>(): Promise<T> {
        return { ok: true, result: {} } as T;
      },
      async capabilities<T>(): Promise<T> {
        return { commands: [] } as T;
      },
    };
    return { transport, seen };
  }

  it("PROJ-1: 加载 `turn_file_changes` 时请求的列里**没有 `patch`**，但元数据列一个不少", async () => {
    const t = projectionTransport([
      {
        id: "tfc1",
        session_id: "s1",
        message_id: "m1",
        turn_index: 1,
        before_tree: "b",
        after_tree: "a",
        patch: "P".repeat(1000), // 真实量级是单行 500,000 字符
        changed_files: "[]",
        patch_sha256: "h",
        current_brief: "brief",
        status: "completed",
        created_at: 1,
      },
    ]);
    const port = new RustStoragePort(t.transport, () => {});
    port.domains.ensureLoaded("turn_file_changes");
    await flush();

    const cols = (t.seen[0]?.columns as string[] | undefined) ?? [];
    expect(cols.length, "必须显式给出列清单（不给就等于整行装载）").toBeGreaterThan(0);
    expect(cols, "`patch` 正文是 500KB/行的大列，绝不能进渲染进程镜像").not.toContain("patch");
    // 其余列必须都在：列表 / 状态更新 / 回滚时的 changed_files 都依赖它们
    for (const c of [
      "id",
      "session_id",
      "message_id",
      "turn_index",
      "before_tree",
      "after_tree",
      "changed_files",
      "patch_sha256",
      "current_brief",
      "status",
      "created_at",
    ]) {
      expect(cols, `元数据列 ${c} 不能丢`).toContain(c);
    }

    const row = port.domains.findOne<Record<string, unknown>>("turn_file_changes", { id: "tfc1" });
    expect(row, "行本身必须读得到（投影不是'读不到'）").not.toBeNull();
    expect(row?.patch, "镜像里没有 patch —— 这是契约，不是缺失").toBeUndefined();
    expect(row?.changed_files, "回滚要用的文件清单必须在").toBe("[]");
  });

  it("PROJ-2: 投影不改变「行不存在」与「没接手」的区别（读路径不能把缺失当没有）", async () => {
    const t = projectionTransport([]);
    const port = new RustStoragePort(t.transport, () => {});
    setStoragePort(port);
    const { domainReadOne } = await import("../core/storage/domain-store");

    // 未就绪 → undefined（没接手）
    expect(domainReadOne("turn_file_changes", { id: "x" }, (r) => r)).toBeUndefined();

    port.domains.ensureLoaded("turn_file_changes");
    await flush();
    // 就绪但确实没有这行 → null（有接手，行不存在）
    expect(domainReadOne("turn_file_changes", { id: "x" }, (r) => r)).toBeNull();
  });
});

// ========== A-4：domainReplaceTable 必须诚实 ==========

describe("A-4 `domainReplaceTable` 不许再记不存在的命令名 / 假装成功", () => {
  it("REPL-1: 未接手时返回 false，且**不产生任何审计记录**", () => {
    const port = createFakeStoragePort({ neverReady: [TABLE] });
    setStoragePort(port);
    expect(domainReplaceTable(TABLE, [{ id: "a" }])).toBe(false);
    expect(port.__writes(), "没接手就不该发出任何命令").toEqual([]);
  });

  it("REPL-2: 接手时真的写穿（逐行 delete + upsert），且**不出现** `crud.replace_table`", async () => {
    const port = createFakeStoragePort({ seed: { [TABLE]: [{ id: "old", title: "旧" }] } });
    setStoragePort(port);
    expect(domainReplaceTable(TABLE, [{ id: "new", title: "新" }])).toBe(true);
    await flush();

    const commands = port.__writes().map((w) => w.command);
    expect(commands, "清空阶段必须逐行删").toContain("crud.delete");
    expect(commands, "重建阶段必须逐行写").toContain("crud.upsert");
    expect(commands, "Rust `COMMANDS` 白名单里没有 crud.replace_table（真引擎会回 UNSUPPORTED）").not.toContain(
      "crud.replace_table",
    );
    expect(port.__table(TABLE).map((r) => r.id).sort()).toEqual(["new"]);
  });

  it("REPL-3: `domainEnsureLoaded` 就绪时先重放队列、再执行调用方回调（顺序不能反）", async () => {
    const port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);
    domainWrite(TABLE, [{ id: "queued" }], opts);

    const seenAtCallback: string[][] = [];
    domainEnsureLoaded(TABLE, () => {
      seenAtCallback.push(port.__table(TABLE).map((r) => String(r.id)));
    });
    await flush();

    expect(seenAtCallback, "回调里应当已经能看到重放后的行").toEqual([["queued"]]);
  });
});
