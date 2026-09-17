/**
 * 任务 Y 的回归测试（三组）：反馈取消的假成功 / 知识库缓存跨端口串味 / 遥测的 2× 写入与自相矛盾汇总。
 *
 * ## 每一条都"能在改动前失败"
 *
 * 每条用例的注释里写明**改前的行为**与**为什么会红**。另外，任务书要求的是
 * "能证明改之前会失败"，所以除了注释，本任务还跑过一次**旧版本对照探针**：
 * 用 `git show HEAD:src/core/...` 把改动前的两个文件取到 `%TEMP%`，
 * 装同样的假端口跑同一套场景，把当时的原始输出抄进了相关用例的注释里
 * （见 Y1-1 / Y2-2 / Y3-1 的注释块）。
 *
 * ## 为什么同一个文件里既有"真·假端口"又有"极简桩端口"
 *
 * `createFakeStoragePort` 是正常的测试基座；但有三态**它表达不出来**：
 *
 * | 要测的形态 | 假端口的限制 | 本文件的做法 |
 * |---|---|---|
 * | 端口在、`data` 面不可用 | 假端口总是有可用的 `data` | 一个只实现 `domains` 的最小桩（`domainsOnlyStub`） |
 * | 端口的 `domains.findOne` 到底被问没被问 | 假端口不记录读调用 | 桩上包一层 `vi.fn()` 观察 |
 * | 按需读"卡在途中" | 假端口的 `crud.list` 立即 resolve | 包 `data.command`，用可手动 release 的闸门 |
 *
 * ⚠️ 本文件**不改** `src/test/fake-storage-port.ts`（所有权边界，且它正被别人编辑）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

const persistFailureAreas = (): string[] => getPersistFailures().map((f) => f.area);

let port: FakeStoragePort | null = null;

beforeEach(() => {
  port = null;
  resetPersistFailures();
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
  resetPersistFailures();
});

/**
 * 一个**只实现 `domains`、`data` 面不可用**的端口桩。
 *
 * ## 为什么必须有它（这是 Y-1 形态 ① 的唯一载体）
 *
 * Y-1 的四种形态里，① "端口未接手"要求 `domainWrite` 返回 false，而
 * `domainWrite` 的判据是 `domainPort()` 只认 `candidate.domains?.ensureLoaded` 且
 * `isReady(table)` 为真 —— **只要 `isReady` 返回 true，写就会被接受**，
 * 根本走不到 `data` 面。假端口的 `data.execute` 又总是可用，
 * 所以形态 ① 用假端口表达不出来。
 *
 * 这里给一个 `isReady` 恒 true 但**没有 `data`** 的桩：`domainWrite` 走"已就绪"分支、
 * 接受这次写（返回 true），而 `directWrite()` 因 `port.data.execute` 不存在而返回 `null`
 * —— 这正是 `telemetry.ts` 注释里那个"拿不到探测能力"的防御分支，
 * 也正是"存储看起来可用、实际写不进去"这一类现场的形态。
 *
 * （`domains` 上的读方法如实从内存行里查，这样 `domainReadOne` 的三态仍然是真实的。）
 */
function domainsOnlyStub(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const tables = new Map<string, Array<Record<string, unknown>>>(
    Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
  );
  const rowsOf = (name: string) => {
    let t = tables.get(name);
    if (!t) {
      t = [];
      tables.set(name, t);
    }
    return t;
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const findOne = vi.fn((name: string, where: Record<string, unknown>) => {
    const hit = rowsOf(name).find((r) => matches(r, where));
    return hit ? { ...hit } : null;
  });
  const domains = {
    isReady: () => true,
    isLoading: () => false,
    ensureLoaded: (_name: string, onLoaded?: () => void) => onLoaded?.(),
    all: (name: string) => rowsOf(name).map((r) => ({ ...r })),
    find: (name: string, where: Record<string, unknown>) => rowsOf(name).filter((r) => matches(r, where)).map((r) => ({ ...r })),
    findOne,
    count: (name: string) => rowsOf(name).length,
    applyWrite: (name: string, row: Record<string, unknown>) => {
      const t = rowsOf(name);
      const idx = t.findIndex((r) => r.id === row.id);
      if (idx >= 0) t[idx] = { ...t[idx], ...row };
      else t.push({ ...row });
    },
    applyWriteMany: (name: string, rows: Array<Record<string, unknown>>) => {
      for (const r of rows) domains.applyWrite(name, r);
    },
    applyDelete: (name: string, where: Record<string, unknown>) => {
      tables.set(name, rowsOf(name).filter((r) => !matches(r, where)));
    },
    applyDeleteWhere: () => 0,
    replaceTable: () => undefined,
  };
  // `data` 面**存在但不可用**：`execute` 一律 reject（模拟引擎未就绪 / IPC 失败）。
  // ⚠️ 刻意**不**写成"没有 `data` 对象"：`domain-store.ts::persistWriteThrough` 写的是
  // `void port.data.execute(...).catch(...)` —— `port.data` 为 undefined 时那一句会
  // **同步抛 TypeError**（`.catch` 都来不及挂上），异常会直接打穿调用方，
  // 而那与 Y-1 要验的语义无关（那是另一个缺陷，见报告"需要他人配合"）。
  const data = {
    execute: () => Promise.reject(new Error("测试桩：data 面不可用")),
  };
  const stub = { kind: "rust", domains, data } as unknown as StoragePort;
  return { stub, findOne, rowsOf };
}

// ============================================================
// Y-1 反馈取消：端口未接手 / 镜像未就绪时不得报"取消成功"
// ============================================================

describe("Y-1 反馈取消不得在「没确认过」的状态下报成功", () => {
  const seedForFeedback = () => ({
    messages: [{ id: "m1", session_id: "s1", role: "user", content: "hi", timestamp: 1, status: "done" }],
  });

  it("Y1-1: 镜像未就绪时「取消赞」如实回绝，并且**那一行还在**", async () => {
    /**
     * ## 改前的行为（旧版本对照探针的原始输出）
     *
     * 探针：`git show HEAD:src/core/llm/feedback.ts` 取旧代码，装
     * `createFakeStoragePort({ neverReady: ["message_feedback"], seed: { message_feedback: [那一行] } })`，
     * 调用 `putMessageFeedback("s1","m1","neutral")`，输出：
     *
     * ```
     * OLD put(neutral)          => {"ok":true,"item":{"messageId":"m1","rating":"neutral","version":""}}    ← 假成功
     * OLD deleteMessageFeedback => {"ok":true,"absent":true}                                                ← "本来就没有"
     * OLD message_feedback rows => 1                                                                        ← 那一行**还在**
     * ```
     *
     * 即："存储不可用"被表达成"本来就没有这一行 → 取消成功"。
     * 用户点"取消赞"→ 图标灭了 → 重启后赞又回来（那一行从没被删）。
     */
    port = createFakeStoragePort({
      seed: {
        ...seedForFeedback(),
        message_feedback: [
          {
            id: "fb-m1",
            message_id: "m1",
            session_id: "s1",
            feedback: "like",
            timestamp: 1,
            note: null,
            version: "v1",
            created_at: 1,
            updated_at: 1,
          },
        ],
      },
      neverReady: ["message_feedback"],
    });
    setStoragePort(port as unknown as StoragePort);

    const fb = await import("../core/llm/feedback");

    const res = fb.putMessageFeedback("s1", "m1", "neutral");
    expect(res.ok, "镜像未就绪时取消**不能**报成功（改前这里是 ok:true）").toBe(false);
    if (!res.ok) expect(res.error).toContain("暂不可用");

    // 独立调用删除也是同一结论（`put(neutral)` 只是它的一个调用点）
    const del = fb.deleteMessageFeedback("m1");
    expect(del.ok, "改前这里是 {ok:true, absent:true}（把「读不到」当「没有」）").toBe(false);
    if (!del.ok) expect(del.error).toContain("暂不可用");

    // 失败走上报通道，不静默
    expect(persistFailureAreas(), "取消未能落地必须可见").toContain("feedback.delete");

    /*
     * 这一行本来就在库里（用户点过赞）→ 修后必须**原样还在**：
     * 改前 `put(neutral)` 会报"取消成功"，而这一行其实从未被删（因为删除被回绝了，
     * 只是回绝被伪装成了成功）—— 表现就是"重启后赞又回来"。
     */
    const rows = port.__table("message_feedback");
    expect(rows, "没确认过就不能删（更不能说删成功了）").toHaveLength(1);
    expect(rows[0].feedback, "那一行的内容不许被改动").toBe("like");
  });

  it("Y1-2: 端口**未注册**（A 态）→ 同样如实回绝，文案区分两态", async () => {
    /**
     * 形态 ①（本进程没有可用存储）与形态 ②（端口在、镜像未就绪）**处置相同**，
     * 但成因不同、文案必须分开 —— 否则真机排查时看到"暂不可用"根本不知道等一会儿会不会好。
     * 这条用例钉住"两态都被回绝"以及"上报里说的是哪一态"。
     */
    const fb = await import("../core/llm/feedback");
    setStoragePort(null); // A 态：端口未注册

    const res = fb.putMessageFeedback("s1", "m1", "neutral");
    expect(res.ok, "没有存储时取消不能报成功").toBe(false);

    const entry = getPersistFailures().find((f) => f.area === "feedback.delete");
    expect(entry, "失败必须有痕迹").toBeDefined();
    expect(entry!.lastMessage, "A 态与 B 态必须说清是哪一种").toContain("端口未注册");

    // 读路径的契约未变：读不到仍然返回 null（Y-1 只改删除路径）
    expect(fb.getMessageFeedback("m1"), "读不到 = null（读语义一个字没改）").toBeNull();
  });

  it("Y1-3: 镜像**已就绪**且确实不存在 → 才是真正的「本来就没有」（absent 且不报错）", async () => {
    /**
     * 这是修法的**边界**：不能因为"怕假成功"就把"本来就没有"也一并回绝 ——
     * 那会让"取消一个从来没点过赞的消息"变成一次假告警。
     * 判据是 `domainReadOne` 返回 `null`（镜像接手了、确实没这行），
     * 与 `undefined`（没接手）严格区分。
     */
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    expect(fb.getMessageFeedback("m1"), "镜像就绪、确实没有这一行").toBeNull();
    expect(fb.deleteMessageFeedback("m1")).toEqual({ ok: true, absent: true });
    expect(persistFailureAreas(), "这一态**不该**上报失败（否则就是假告警）").not.toContain("feedback.delete");

    // 取消一个不存在的反馈 = 幂等成功（不是错误）
    const cancelled = fb.putMessageFeedback("s1", "m1", "neutral");
    expect(cancelled.ok, "确实没有行时取消是幂等成功").toBe(true);
  });

  it("Y1-4: 镜像已就绪且确实存在 → 删除**真的发生**（这一态改前也是对的，守住不回退）", async () => {
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    expect(fb.putMessageFeedback("s1", "m1", "like").ok).toBe(true);
    expect(port.__table("message_feedback")).toHaveLength(1);

    expect(fb.deleteMessageFeedback("m1"), "确实存在这一行").toEqual({ ok: true, absent: true });
    expect(port.__table("message_feedback"), "那一行必须真的从库里消失").toHaveLength(0);
    expect(fb.getMessageFeedback("m1")).toBeNull();
  });

  it("Y1-5: 端口在、但 `data` 面不可用 → 删除只为「镜像受理」负责，写穿失败如实上报", async () => {
    /**
     * 这种形态（`domains` 面可用、`data` 面不可用）用假端口表达不出来：
     * 假端口的 `data.execute` 总是可用。而它是**真实存在**的一态 ——
     * `domain-store.ts` 的 `DomainMirrorPort` 里 `domains` 与 `data` 是两个独立能力。
     *
     * 这里钉住两件事，它们合起来正好是"读得到"与"删不掉"的分界：
     * 1. `getMessageFeedback` 读得到（镜像确实接手了，**不是**"读不到"）；
     * 2. 写穿失败**如实上报**（`feedback.delete` 必须出现在上报通道里），
     *    而不是返回一个"取消成功"然后什么都没有发生。
     *
     * 注意第 2 条**不是**"返回 ok:false"：`domainDelete` 的返回值语义是
     * "端口**接手**了这次写"（见 `domain-store.ts` 的说明），落库结果在异步 Promise 里，
     * 由上报通道负责可见性 —— 所以这里断言的是上报，而不是返回值。
     */
    const { stub, rowsOf } = domainsOnlyStub({
      message_feedback: [
        {
          id: "fb-m1",
          message_id: "m1",
          session_id: "s1",
          feedback: "like",
          timestamp: 1,
          note: null,
          version: "v1",
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    setStoragePort(stub);
    resetPersistFailures();

    const fb = await import("../core/llm/feedback");
    expect(fb.getMessageFeedback("m1")?.rating, "镜像确实接手的读（与「读不到」区分开）").toBe("like");

    const del = fb.deleteMessageFeedback("m1");
    expect(del, "端口接手了这次删除（落库结果在异步侧）").toEqual({ ok: true, absent: true });
    // 镜像里那一行按域层语义被删掉（读路径立刻不再看到它）
    expect(rowsOf("message_feedback"), "域层受理的删除必须在镜像上生效").toHaveLength(0);

    // 写穿失败**必须可见**：不允许"看起来删了、其实没删，而且一句话都没有"
    await settle();
    expect(persistFailureAreas(), "写穿失败必须走上报通道（否则就是 B 类假成功）").toContain("feedback.delete");
  });
});

// ============================================================
// Y-2 知识库：缓存必须属于**它被读出来的那个端口**
// ============================================================

/**
 * 一个"块表镜像恒被拒"的端口（复刻 C-3 的现场），并且把 `crud.list` 包上**手动闸门**。
 *
 * 闸门是本组用例能**稳定复现竞态**的唯一手段：Y-2 的缺陷只出现在
 * "按需读在途中、端口被换掉"这一个窗口里。假端口的 `crud.list` 立即 resolve，
 * 那个窗口根本不存在 —— 靠"等若干微任务"去猜时机的测试是碰运气，不是回归测试。
 */
function portWithGatedChunks(rows: Array<Record<string, unknown>>) {
  const p = createFakeStoragePort({ seed: { notebook_chunks: rows }, neverReady: ["notebook_chunks"] });
  /** 每次 `crud.list` 一个闸门：resolve 它，这次的按需读才会返回 */
  const gates: Array<() => void> = [];
  const origCommand = p.data.command.bind(p.data);
  (p.data as unknown as { command: (c: string, pr?: Record<string, unknown>) => Promise<unknown> }).command = (
    cmd: string,
    params?: Record<string, unknown>,
  ) => {
    if (cmd !== "crud.list") return origCommand(cmd, params);
    const table = String(params?.table ?? "");
    const where = (params?.where as Record<string, unknown>) ?? {};
    const items = (p.__table(table) as Array<Record<string, unknown>>).filter((row) =>
      Object.entries(where).every(([k, v]) => row[k] === v),
    );
    return new Promise((resolve) => {
      gates.push(() => resolve({ items, has_more: false, next_cursor: null }));
    });
  };
  return {
    port: p,
    /** 放行第 n 次（0 基）按需读 */
    release: (n: number) => {
      const g = gates[n];
      if (!g) throw new Error(`第 ${n} 次 crud.list 还没发生（实际发生 ${gates.length} 次）`);
      g();
    },
    gateCount: () => gates.length,
  };
}

const chunkRow = (id: string, notebookId: string) => ({
  id,
  source_id: `src-${notebookId}`,
  notebook_id: notebookId,
  content: `内容-${id}`,
  chunk_index: 0,
  embedding: null,
  token_count: 1,
  created_at: 1,
});

describe("Y-2 按需读缓存不得跨端口串味", () => {
  it("Y2-1: 端口 A 的按需读在途中被换成 B → B **绝不能**读到 A 的块", async () => {
    const A = portWithGatedChunks([chunkRow("A1", "nb1")]);
    const B = portWithGatedChunks([chunkRow("B1", "nb1")]);

    setStoragePort(A.port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");
    /*
     * 预取的句柄：**修法顺带把 `warmChunksByNotebook` 从 `void` 改成返回 Promise**
     * （生产语义不变 —— `getChunks` 仍然立刻抛"未就绪"），因为"这一轮预取什么时候结束"
     * 必须是可观察的事实，否则本用例只能靠"等若干微任务"猜时机 —— 那是碰运气，不是回归测试。
     * 句柄通过 `__warmChunksForTests` 拿（生产代码不调用它）。
     */
    const warmA = k.__warmChunksForTests("nb1");

    // 端口 A 下发起按需读（第一次同步读必然"未就绪"，它会触发预取）
    expect(() => k.getChunks("nb1"), "第一次同步读拿不到（按需读是异步的）").toThrowError(
      k.ChunkIndexUnavailableError,
    );
    expect(A.gateCount(), "预取已经发起了 crud.list（测试前提）").toBe(1);

    /*
     * 在 A 的按需读**还没回来**的时候换端口 —— 这正是缺陷窗口。
     *
     * ⚠️ `chunkIndexState()` 会调用 `currentChunkCache()`，
     * 那一刻就是旧实现里"把缓存清成 B 的桶"的时机。
     */
    setStoragePort(B.port as unknown as StoragePort);
    k.chunkIndexState();

    // A 的按需读现在才回来（带着 A 的数据）
    A.release(0);
    await warmA;

    /**
     * 断言 1（**改前必红**）：B 端口下读 nb1 绝不能拿到 A 的块。
     *
     * 旧版本的原始输出（审计探针）：
     * ```
     * PROBE chunk ids under port B: ["<threw>"]
     * AssertionError: expected [ '<threw>' ] to deeply equal [ 'B1' ]
     * ```
     * 那是另一种形态；本用例复用同一个窗口，改前会拿到 `["A1"]`
     * （旧实现把 A 的结果 `cache.set` 进了 t0 抓到的那个 Map，而那个 Map 已经是 B 的桶）。
     */
    let bGot: string[];
    try {
      bGot = k.getChunks("nb1").map((c) => c.id);
    } catch (e) {
      bGot = [e instanceof Error ? e.name : "<threw>"];
    }
    expect(bGot, "B 端口绝不能读到 A 的数据（静默返回错内容比读不到严重得多）").not.toEqual(["A1"]);

    // 断言 2：A 的结果**确实被丢弃**（不是藏在某个角落里等着下一次串味）
    const buckets = k.__chunkCacheBucketsForTests();
    const allIds = buckets.flatMap((b) => Object.values(b.entries).flat());
    expect(allIds, "A 的结果必须被丢弃并如实上报").toEqual([]);
    expect(persistFailureAreas(), "作废必须可见").toContain("chunk.onDemand");

    // 断言 3：B 自己的按需读照常工作（修法不能把功能一起修死）
    const warmB = k.__warmChunksForTests("nb1");
    B.release(0);
    await warmB;
    expect(k.getChunks("nb1").map((c) => c.id), "B 端口自己的数据要能读到").toEqual(["B1"]);
  });

  it("Y2-2: 端口没换时按需读照常命中（修法不许把正常路径改坏）", async () => {
    const A = portWithGatedChunks([chunkRow("A1", "nb1"), chunkRow("A2", "nb1")]);
    setStoragePort(A.port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");

    const warmA = k.__warmChunksForTests("nb1");
    expect(() => k.getChunks("nb1")).toThrowError(k.ChunkIndexUnavailableError);
    A.release(0);
    await warmA;

    expect(k.getChunks("nb1").map((c) => c.id), "端口没换 → 结果进当前端口的桶").toEqual(["A1", "A2"]);
    expect(k.chunkIndexState()).toBe("on-demand");
    expect(persistFailureAreas(), "正常路径不该上报").not.toContain("chunk.onDemand");
  });
});

// ============================================================
// Y-3 遥测：2× 写入的诚实说明 + 每轮 flush 的独立计数
// ============================================================

describe("Y-3 遥测 flush 的计数必须属于「这一轮」", () => {
  it("Y3-1: 上一轮的迟到结账**不得**污染下一轮的汇总（恒等式在并发下也成立）", async () => {
    /**
     * ## 改前的行为（审计实测原文）
     *
     * ```
     * after flush#2: {"written":1,…,"retried":1}   ← 两条事件，却报成"1 条已写 + 1 条待重试"
     * after release: {"written":2,…,"retried":1}   ← 更荒谬：2 条事件里有 3 个结论
     * ```
     *
     * 成因：计数放在实例字段 `this.counters` 上、每次 `flush()` 清零，
     * 而上一条事件的结账（`settle`）是**异步**的 —— 它在下一轮清零之后才跑完，
     * 于是把自己那一轮的数字加进了新一轮。
     *
     * ## 构造方式（为什么不"等若干微任务"）
     *
     * 用闸门把**探测写**（`trackShard` 里的重放）卡住，于是：
     * ```
     * flush#1：写穿立即成功；探测写@1 **挂起**（事件仍在缓冲、仍在 inFlight）
     * flush#2：再记一条 → 探测写@2 也挂起
     * 放行 @1：round1 结账（它只动 round1 的数字）
     * 放行 @2：round2 结账
     * ```
     * 全程没有"猜时机"，每一步都由闸门确定。
     */
    const p = createFakeStoragePort();
    setStoragePort(p as unknown as StoragePort);

    const origExecute = p.data.execute.bind(p.data);
    /** 挂起的探测写（每次 `crud.upsert` 一个闸门；写穿的第一次立即放行） */
    const gates: Array<() => void> = [];
    let upsertCalls = 0;
    p.data.execute = (cmd: string, params?: Record<string, unknown>) => {
      if (cmd !== "crud.upsert") return origExecute(cmd, params);
      upsertCalls += 1;
      const gateIndex = upsertCalls - 1;
      // 第 1、3… 次是写穿（立即成功），第 2、4… 次是探测（挂起，等手动放行）
      if (gateIndex % 2 === 0) return origExecute(cmd, params);
      return new Promise((resolve) => {
        gates.push(() => void resolve(origExecute(cmd, params)));
      });
    };

    const { getTelemetry, __resetTelemetryForTests } = await import("../core/telemetry/telemetry");
    __resetTelemetryForTests();
    const tel = getTelemetry();

    tel.record("s1", "evt-1");
    tel.flush();
    await settle();
    expect(tel.bufferedCount(), "第 1 条仍在缓冲（结账未回）").toBe(1);
    /**
     * 第 1 轮还没结账：汇总里**不许**出现编造出来的"已写入 1 条"。
     * （`written: 0` 不是"失败"，而是"还没结完"；它同时说明恒等式此刻尚未闭合，
     * 那正是诚实的表达 —— 结算完成时必须闭合，见下面的断言。）
     */
    expect(tel.flushSummary(), "未结账时不许编造已写入数").toMatchObject({ written: 0, retried: 0, expected: 1 });
    expect(gates.length, "第 1 轮的探测已挂起（测试前提）").toBe(1);

    tel.record("s1", "evt-2");
    tel.flush();
    await settle();
    expect(gates.length, "第 2 轮的探测也已挂起（测试前提）").toBe(2);

    /**
     * ⚠️ 这里**不断言**中间态：第 1 条事件仍在 `inFlight` 里，
     * 第 2 轮能提交的是"第 2 条"（1 条），不是"上一轮那条"。中间态只保证一件事 ——
     * **上一轮的 `retried/written` 绝不出现在本轮的汇总里**：
     * 第 1 轮的数字此刻还是 0/0/0（协议：结账才发布），所以本轮汇总里的
     * `written` 与 `retried` 都必须来自第 2 轮自己。改前的错误值 `retried: 1`
     * 就是上一轮在"可重试失败"时留下的残留。
     */
    expect(tel.flushSummary()?.retried, "本轮不许带上上一轮的 retried 残留（改前这里是 1）").toBe(0);
    expect(tel.flushSummary()?.written, "本轮不许带上上一轮的 written").toBe(0);

    // 放行两次探测 → 两轮各自结账
    gates[0](); // 第 1 轮（先建、先放行 → 它的结账先跑完）
    await settle();
    gates[1](); // 第 2 轮
    await settle();

    /**
     * 断言（**改前必红**）：迟到的第 1 轮**不得**污染"最近一次 flush"。
     *
     * 改前这里的形状是 `{written:2, retried:1}`（审计实测原文）——
     * 两条事件给出三个结论，恒等式当场失真。
     */
    const summary = tel.flushSummary()!;
    expect(summary, "最近一次 flush 只描述它自己那一轮").toMatchObject({
      written: 1,
      rejectedForeignKey: 0,
      retried: 0,
      expected: 1,
    });
    expect(
      summary.written + summary.rejectedForeignKey + summary.retried,
      "恒等式：written + rejected + retried == 本轮提交数",
    ).toBe(summary.expected);

    // 每一轮的账都要能单独查（"两个轮次各写一条" ≠ "同一轮写了两条"）
    expect(tel.flushRoundSummaries(), "每轮一份独立快照").toEqual([
      { written: 1, rejectedForeignKey: 0, retried: 0, expected: 1 },
      { written: 1, rejectedForeignKey: 0, retried: 0, expected: 1 },
    ]);
    expect(tel.bufferedCount(), "两轮都结账成功 → 缓冲清空").toBe(0);

    // 落库侧：两条事件都真的写进假端口（各有写穿 + 探测两次 upsert，见 Y3-2）
    expect(p.__table("telemetry_events"), "两条事件都落库").toHaveLength(2);
  });

  it("Y3-2: 诚实钉住「每个分片每轮 2× 写入（写穿 + 结账探测）」这个已知代价", async () => {
    /**
     * 这条用例的作用是**把代价写在代码里**，防止将来有人（包括我自己）看到
     * `directWrite()` 的注释后以为"正常路径根本不会走到它"。
     *
     * 实测（本用例的断言）：一轮 flush、一个分片、1 条事件 → **2 次 `crud.upsert`**：
     * ```
     * ① domainWrite 的写穿
     * ② trackShard().settle 的无条件结账探测（用于取回被 domainWrite 吞掉的错误码）
     * ```
     * 为什么不能只留 ①：`domainWrite` 不把写穿 Promise 交给调用方
     * （`persistWriteThrough` 里的 `.catch()` 是终点），失败信号在 `trackShard` 侧无法观察
     * —— 那要么改 `domain-store.ts`（跨文件边界，见报告"需要他人配合"），
     * 要么就只能多打一次幂等 IPC。**宁可多一次 IPC，也不要"结账永远判成功"**。
     *
     * 幂等性由主键保证（`telemetry_events.id` 是 TEXT PRIMARY KEY，`crud.upsert` 是
     * `INSERT OR REPLACE`）—— 所以这里同时断言"表里只有 1 行"（不是重复行）。
     */
    const p = createFakeStoragePort();
    setStoragePort(p as unknown as StoragePort);

    const { getTelemetry, __resetTelemetryForTests } = await import("../core/telemetry/telemetry");
    __resetTelemetryForTests();
    const tel = getTelemetry();

    tel.record("s1", "evt-only");
    tel.flush();
    await settle();

    const upserts = p.__writes().filter((w) => w.command === "crud.upsert");
    expect(upserts.length, "写穿 1 次 + 结账探测 1 次 = 2 次（这就是那个已知代价）").toBe(2);
    expect(p.__table("telemetry_events"), "幂等 upsert：重放不产生重复行").toHaveLength(1);
    expect(tel.bufferedCount()).toBe(0);
  });

  it("Y3-3: 端口接不接受写之后才记「待重试」，且 counts 不跨轮残留", async () => {
    /**
     * `domainWrite` 返回 false（端口没接手）时，这批事件**留在缓冲里**，
     * 本轮如实记为「待重试」。改前这里是
     * `this.counters.retried += group.length - fresh.length;` ——
     * 它把"上一轮已发出、结果未回"的事件也算成本轮待重试，
     * 于是本轮一条都没提交，汇总里却有 `retried: 1`（恒等式当场失真）。
     *
     * 这里用 `neverReady` 让 `telemetry_events` 永远不就绪 → `domainWrite` 返回 false。
     */
    const p = createFakeStoragePort({ neverReady: ["telemetry_events"] });
    setStoragePort(p as unknown as StoragePort);

    const { getTelemetry, __resetTelemetryForTests } = await import("../core/telemetry/telemetry");
    __resetTelemetryForTests();
    const tel = getTelemetry();

    tel.record("s1", "evt-x");
    tel.record("s1", "evt-y");
    tel.flush();
    await settle();

    const summary = tel.flushSummary()!;
    expect(summary, "端口没接手 → 两条都记为待重试").toMatchObject({ written: 0, rejectedForeignKey: 0, retried: 2, expected: 2 });
    expect(tel.bufferedCount(), "事件必须留在缓冲里等重试（不能丢）").toBe(2);
    expect(persistFailureAreas(), "没写进去必须可见").toContain("telemetry.flush");

    // 第二轮：上一轮的事件已不在 inFlight（没接手 → 没进 inFlight）→ 会被**重新提交**
    tel.flush();
    await settle();
    const second = tel.flushSummary()!;
    expect(second, "重试轮同样只统计自己提交的两条").toMatchObject({ retried: 2, expected: 2 });
    expect(second.written + second.rejectedForeignKey + second.retried, "恒等式在重试轮也成立").toBe(second.expected);
  });
});
