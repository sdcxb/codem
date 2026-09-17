/**
 * 任务 C（第 91 波）：功能域接线的回归测试。
 *
 * 每条用例对应任务书里的一个缺陷编号（C-1 … C-10），并且**都能在改动前失败**：
 * 每段用例的注释里写明了"改前的行为是什么、这条断言为什么会红"。
 *
 * 缺陷的**真 CLI 取证**（真 Rust 引擎、真外键、真 CHECK）在 `.preview-shot/_probe-c*.mjs`
 * 里跑过（一次性探针，用完删除），关键输出抄录在本文件相关用例的注释中。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageError, setStoragePort, type StoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import {
  createFakeStoragePort,
  type FakeStoragePort,
  type FakeStoragePortOptions,
} from "./fake-storage-port";

const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

/**
 * 上报过失败的区域列表（`persist-failure.ts` 是**唯一**的失败通道）。
 *
 * ⚠️ 为什么不用假端口的 `__writeFailures()`：那个计数只在**假端口自己**抛错时增加
 * （`failWrites` 模式），而产品代码里的"如实上报"走的是 `reportPersistFailure`
 * —— 两者是不同的东西。用错判据会让一批"其实已经上报了"的用例假红（这里踩过一次）。
 */
const persistFailureAreas = (): string[] => getPersistFailures().map((f) => f.area);

let port: FakeStoragePort | null = null;

beforeEach(() => {
  port = null;
  resetPersistFailures();
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
  resetPersistFailures();
});

/**
 * 装一个假端口，并且**让指定的 session_id 触发外键类拒绝**（模拟真 Rust 的
 * `FOREIGN KEY constraint failed`）。
 *
 * 真实引擎的语义（探针实测）：
 * ```
 * crud.upsert({table:"telemetry_events", rows:[{session_id:"s1"}, {session_id:"sub-123-abc"}]})
 *   → {"error":{"code":"CONSTRAINT","message":"FOREIGN KEY constraint failed"}}
 * crud.count(telemetry_events) → 0        ← 好行也一起回滚（单事务）
 * ```
 * 这里逐条复刻"哪个 session 会被拒、拒绝时的错误码与形状"。
 */
/**
 * 装一个假端口，并且**让指定的 session_id 触发外键类拒绝**（模拟真 Rust 的
 * `FOREIGN KEY constraint failed`）。
 *
 * 真实引擎的语义（探针实测）：
 * ```
 * crud.upsert({table:"telemetry_events", rows:[{session_id:"s1"}, {session_id:"sub-123-abc"}]})
 *   → {"error":{"code":"CONSTRAINT","message":"FOREIGN KEY constraint failed"}}
 * crud.count(telemetry_events) → 0        ← 好行也一起回滚（单事务）
 * ```
 * 这里逐条复刻"哪个 session 会被拒、拒绝时的错误码与形状"，
 * 并且**记录每一次 upsert 尝试的 session_id 集合** —— C-1 的核心断言就是
 * "坏会话与好会话被拆成了两次独立的写"（改前它们在同一次里）。
 *
 * ⚠️ 注意一个**假端口与真引擎的固有偏差**：产品的 `domainWrite` 是"先改镜像、再写穿"，
 * 所以即使写穿失败，假端口里也已经能看到那些行了（真引擎里没有）。
 * 因此本文件的断言一律基于 `attempts`（谁被尝试写了）与 `__writes()`
 * （谁真的被写穿了），**不**基于 `__table()` 的行数 —— 那会验到假端口的乐观镜像上去。
 */
function portRejectingSessions(rejected: Set<string>, opts: FakeStoragePortOptions = {}) {
  const attempts: string[][] = [];
  const p = createFakeStoragePort({
    seed: {
      sessions: [{ id: "s1", project_id: "p1", title: "父会话", created_at: 1, last_message_at: 1, message_count: 0 }],
      projects: [{ id: "p1", name: "P", path: "C:/x", created_at: 1, last_accessed_at: 1 }],
    },
    ...opts,
  });
  const origExecute = p.data.execute.bind(p.data);
  const origWrite = p.data.write.bind(p.data);
  const sessionIdsIn = (rows: unknown): string[] =>
    [...new Set(((rows as Array<Record<string, unknown>>) ?? []).map((row) => String(row.session_id ?? "")))].sort();
  const rejectedIn = (rows: unknown): string[] =>
    sessionIdsIn(rows).filter((sid) => rejected.has(sid));

  p.data.execute = async (cmd: string, params?: Record<string, unknown>) => {
    if (cmd === "crud.upsert") {
      attempts.push(sessionIdsIn(params?.rows));
      if (rejectedIn(params?.rows).length > 0) {
        throw new StorageError("CONSTRAINT", "FOREIGN KEY constraint failed");
      }
    }
    return origExecute(cmd, params);
  };
  p.data.write = async (commands) => {
    for (const c of commands) {
      if (c.command === "crud.upsert" && rejectedIn(c.params?.rows).length > 0) {
        throw new StorageError("CONSTRAINT", "FOREIGN KEY constraint failed");
      }
    }
    return origWrite(commands);
  };
  return Object.assign(p, { __upsertAttempts: () => attempts.map((a) => [...a]) });
}

// ============================================================
// C-1 遥测：按 session_id 分片 + 外键行剔除 + 落库确认后才清缓冲
// ============================================================

describe("C-1 遥测 flush —— 一条坏行不能毒化整批", () => {
  it("C1-1: 坏 session 与好 session 被拆成两次独立的写（改前：合成一次、整批回滚）", async () => {
    /**
     * 改前：`flush()` 把所有会话的事件合成**一次** `domainWrite`。真 CLI 实测：
     * ```
     * crud.upsert(1 行 s1 + 1 行 sub-123-abc) → FOREIGN KEY constraint failed
     * crud.count(telemetry_events)            → 0        # 好行也一起被回滚
     * ```
     * 于是"某一个子会话没有 sessions 行"这一个局部问题，会连带**所有会话**的遥测。
     *
     * 这条用例的判据是**写尝试的粒度**：改前只有一次尝试（且含坏 id），
     * 改后必须是"好会话一次 + 坏会话一次"。
     */
    const bad = "sub-123-abc";
    const p = portRejectingSessions(new Set([bad]));
    port = p;
    setStoragePort(p as unknown as StoragePort);

    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel = getTelemetry();
    tel.record("s1", "llm_call", { ms: 1 });
    tel.record(bad, "llm_call", { ms: 2 });
    tel.record("s1", "tool_call", { ms: 3 });
    tel.flush();
    await settle();

    const attempts = (p as unknown as { __upsertAttempts(): string[][] }).__upsertAttempts();
    const telemetryAttempts = attempts.filter((a) => a.includes("s1") || a.includes(bad));
    // 好会话与坏会话**不曾在同一次写里**（这就是"分片"的定义）
    expect(
      telemetryAttempts.some((a) => a.includes("s1") && a.includes(bad)),
      "坏会话不能与好会话同批（那样一个坏 id 会带走所有会话）",
    ).toBe(false);
    expect(telemetryAttempts, "好会话必须有自己的写").toContainEqual(["s1"]);
    expect(telemetryAttempts, "坏会话也只该被单独试一次").toContainEqual([bad]);

    // 好会话的写**成功落库**（真写穿，不是只改了镜像）
    const upserts = p.__writes().filter((w) => w.command === "crud.upsert");
    const goodRowWrite = upserts.find((w) =>
      (w.params?.rows as Array<Record<string, unknown>>).some((r) => r.session_id === "s1"),
    );
    expect(goodRowWrite, "好会话的写穿确实发出去了").toBeDefined();
    // 汇总：2 条写好、1 条因外键剔除
    expect(tel.flushSummary()).toMatchObject({ written: 2, rejectedForeignKey: 1 });
  });

  it("C1-2: 被外键剔除的事件**不再重试**（避免无限重试风暴），且缓冲已清空", async () => {
    const bad = "sub-123-abc";
    const p = portRejectingSessions(new Set([bad]));
    port = p;
    setStoragePort(p as unknown as StoragePort);

    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel = getTelemetry();
    tel.record(bad, "llm_call", { ms: 1 });
    tel.flush();
    await settle();

    // 确定性拒绝 → 从缓冲里剔除（不是留着等下一次永远失败的重试）
    expect(tel.bufferedCount()).toBe(0);

    // 再来一次 flush 不会把同一条再发一遍
    const before = (p as unknown as { __upsertAttempts(): string[][] }).__upsertAttempts().length;
    tel.flush();
    await settle();
    const after = (p as unknown as { __upsertAttempts(): string[][] }).__upsertAttempts().length;
    expect(after).toBe(before);
  });

  it("C1-3: 可重试失败（非外键）**保留在缓冲里**等下次 flush", async () => {
    /**
     * 与 C1-2 相对的另一半：`BUSY`/`IO` 这类瞬时错误**不能**剔除 ——
     * 那会把"引擎刚好忙"变成"永久丢掉用户的遥测"。改前这两种情形无法区分
     * （都会被 `this.events = []` 一起丢掉）。
     */
    const p = createFakeStoragePort();
    port = p;
    setStoragePort(p as unknown as StoragePort);
    const origExecute = p.data.execute.bind(p.data);
    /**
     * 只让**第 2 次** `crud.upsert` 失败。调用顺序是有意义的：
     * 1. `domainWrite` 自己的写穿；
     * 2. `trackShard` 的**结账探测**（这里失败 = 判定为可重试失败）；
     * 3. 下一次 `flush()` 的写穿（成功）。
     */
    let upsertCalls = 0;
    p.data.execute = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "crud.upsert") {
        upsertCalls += 1;
        if (upsertCalls === 2) throw new StorageError("BUSY", "database is locked");
      }
      return origExecute(cmd, params);
    };

    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel = getTelemetry();
    tel.record("s1", "llm_call", { ms: 1 });
    tel.flush();
    await settle();

    // 事件仍在缓冲里（会由 5s 定时器重试）
    expect(tel.bufferedCount(), "可重试失败不能丢事件").toBe(1);
    expect(tel.flushSummary()?.retried, "必须记为「待重试」而不是「已写入」").toBe(1);

    // 再 flush 一次（这次端口正常）→ 落库成功、缓冲清空
    tel.flush();
    await settle();
    expect(tel.bufferedCount()).toBe(0);
    expect(tel.flushSummary()).toMatchObject({ written: 1, rejectedForeignKey: 0 });
  });

  it("C1-4: 汇总区分「写入成功 N 条」与「因外键剔除 M 条」", async () => {
    const bad = "sub-123-abc";
    port = portRejectingSessions(new Set([bad]));
    setStoragePort(port as unknown as StoragePort);

    const { getTelemetry } = await import("../core/telemetry/telemetry");
    const tel = getTelemetry();
    tel.record("s1", "a");
    tel.record("s1", "b");
    tel.record(bad, "c");
    tel.flush();
    await settle();

    const summary = tel.flushSummary();
    expect(summary).not.toBeNull();
    expect(summary!.written).toBe(2);
    expect(summary!.rejectedForeignKey).toBe(1);
  });
});

// ============================================================
// C-2 子会话必须有 sessions 行
// ============================================================

describe("C-2 子智能体会话行补齐", () => {
  it("C2-1: 补行后归属与父会话一致（不凭空造 project_id）", async () => {
    port = createFakeStoragePort({
      seed: {
        sessions: [{ id: "parent-1", project_id: "p9", title: "父", created_at: 1, last_message_at: 1, message_count: 0 }],
      },
    });
    setStoragePort(port as unknown as StoragePort);

    const { ensureSubagentSession } = await import("../core/subagent/subagent-session");
    expect(ensureSubagentSession("sub-1-abc", "parent-1")).toBe(true);

    const child = port.__table("sessions").find((r) => r.id === "sub-1-abc");
    expect(child).toBeDefined();
    expect(child!.project_id, "必须与父会话同项目").toBe("p9");
  });

  it("C2-2: 父会话读不到时**不补行**（宁可不写，也不编一个错误的归属）", async () => {
    /**
     * 改前：全仓从未为子会话建 `sessions` 行（`grep createSession src/core/subagent` = 0），
     * 而 `messages.session_id` / `session_events.session_id` / `telemetry_events.session_id`
     * 都有外键 → 子智能体的消息、事件、遥测**全部写不进去**。
     *
     * 这条用例守的是修法的边界：**不确定归属就不写**（而不是退回"不写"这个旧行为）。
     */
    port = createFakeStoragePort({ seed: { sessions: [] } });
    setStoragePort(port as unknown as StoragePort);

    const { ensureSubagentSession } = await import("../core/subagent/subagent-session");
    expect(ensureSubagentSession("sub-orphan", "no-such-parent")).toBe(false);
    expect(port.__table("sessions")).toHaveLength(0);
  });

  it("C2-3: 幂等 —— 已有行时不会覆盖标题/归属", async () => {
    port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "parent-1", project_id: "p9", title: "父", created_at: 1, last_message_at: 1, message_count: 0 },
          { id: "sub-1-abc", project_id: "p9", title: "已有标题", created_at: 5, last_message_at: 5, message_count: 7 },
        ],
      },
    });
    setStoragePort(port as unknown as StoragePort);

    const { ensureSubagentSession } = await import("../core/subagent/subagent-session");
    expect(ensureSubagentSession("sub-1-abc", "parent-1")).toBe(true);
    const row = port.__table("sessions").find((r) => r.id === "sub-1-abc");
    expect(row!.title).toBe("已有标题");
    expect(row!.message_count).toBe(7);
  });

  it("C2-4: 建行失败只上报，**不让子智能体启动失败**", async () => {
    /**
     * 用"让所有写穿都失败"的方式造出"这条 `sessions` 行没落地"。
     *
     * ⚠️ 为什么还要额外挡掉**镜像**写（`domains.applyWriteMany`）：
     * 产品的 `domainWrite` 是"先改镜像、再写穿"，所以写穿失败之后**镜像里已经有那一行**了
     * —— 于是 `ensureSubagentSession` 的回读校验会看到它，返回 `true`。
     * 真引擎那边这行**根本没进库**（写穿就是那次失败的调用）；假端口里镜像与落库是同一份内存，
     * 表达不出这个差异，所以这里显式让它也失败 —— 模拟"这一行确实没落地"。
     */
    resetPersistFailures();
    port = createFakeStoragePort({
      seed: {
        sessions: [{ id: "parent-1", project_id: "p9", title: "父", created_at: 1, last_message_at: 1, message_count: 0 }],
      },
    });
    setStoragePort(port as unknown as StoragePort);
    const origExecute = port.data.execute.bind(port.data);
    const origWrite = port.data.write.bind(port.data);
    const boom = (cmd: string) => {
      if (cmd !== "crud.upsert") throw new Error(`fake-port: 会话行未落地`);
    };
    port.data.execute = async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === "crud.upsert") {
        const rows = (params?.rows as Array<Record<string, unknown>>) ?? [];
        if (rows.some((r) => String(r.id ?? "").startsWith("sub-"))) {
          throw new StorageError("IO", "磁盘写入失败（模拟）");
        }
      }
      return origExecute(cmd, params);
    };
    port.data.write = async (commands) => {
      for (const c of commands) {
        if (c.command === "crud.upsert") {
          const rows = (c.params?.rows as Array<Record<string, unknown>>) ?? [];
          if (rows.some((r) => String(r.id ?? "").startsWith("sub-"))) {
            throw new StorageError("IO", "磁盘写入失败（模拟）");
          }
        }
        void boom;
      }
      return origWrite(commands);
    };
    // 镜像也拒绝这次写 → 复刻"这一行确实没落地"
    const origApply = port.domains.applyWriteMany.bind(port.domains);
    port.domains.applyWriteMany = (name: string, rows: Array<Record<string, unknown>>) => {
      if (rows.some((r) => String(r.id ?? "").startsWith("sub-"))) return;
      origApply(name, rows);
    };

    const { ensureSubagentSession } = await import("../core/subagent/subagent-session");
    const { getSession } = await import("../core/storage/session");
    /**
     * 两条硬要求一起守：
     * 1. **不抛** —— 否则 `start()`/`startContinuable()` 会连带失败，子智能体根本起不来；
     * 2. **如实上报** —— 不然"这条轨迹入不了库"没有任何痕迹。
     */
    expect(() => ensureSubagentSession("sub-2-xyz", "parent-1"), "绝不能抛（否则子智能体启动失败）").not.toThrow();
    expect(getSession("sub-2-xyz"), "行确实没落地（测试前提）").toBeNull();
    expect(persistFailureAreas(), "失败必须走上报通道，不能静默").toContain("subagent.ensureSession");
  });
});

// ============================================================
// C-3 知识库块镜像
// ============================================================

/**
 * 一个"块表镜像恒不接手"的端口：复刻 `RustDomainMirror` 被拒后的两个关键事实 ——
 * 1. `isReady("notebook_chunks")` 恒 false（于是 `domainReadMany` 返回 `undefined`）；
 * 2. 按需读（`crud.list`）**仍然能读到数据**（真引擎当然是能读的，只是没进镜像）。
 *
 * 这正是 C-3 的现场：镜像读不到、但数据在库里。
 */
function portWithRefusedChunks(seed: Record<string, Array<Record<string, unknown>>>) {
  const p = createFakeStoragePort({ seed, neverReady: ["notebook_chunks"] });
  const origExecute = p.data.execute.bind(p.data);
  const origCommand = p.data.command.bind(p.data);
  // 按需读：真端口走 crud.list + where，这里按同一语义从内存表取
  const crudList = (params?: Record<string, unknown>) => {
    const table = String(params?.table ?? "");
    const where = (params?.where as Record<string, unknown>) ?? {};
    const items = (p.__table(table) as Array<Record<string, unknown>>).filter((row) =>
      Object.entries(where).every(([k, v]) => row[k] === v),
    );
    return { items, has_more: false, next_cursor: null };
  };
  p.data.execute = async (cmd, params) => {
    if (cmd === "crud.list") return crudList(params as Record<string, unknown>) as never;
    return origExecute(cmd, params);
  };
  (p.data as unknown as { command: typeof origCommand }).command = (async (cmd: string, params?: Record<string, unknown>) => {
    if (cmd === "crud.list") return crudList(params);
    return origCommand(cmd, params);
  }) as typeof origCommand;
  return p;
}

describe("C-3 知识库块索引：镜像被拒后不得冒充「没有内容」", () => {
  const chunkRow = (id: string, notebookId: string, sourceId: string, index: number) => ({
    id,
    source_id: sourceId,
    notebook_id: notebookId,
    content: `内容-${id}`,
    chunk_index: index,
    embedding: null,
    token_count: 1,
    created_at: 1,
  });

  it("C3-1: 镜像被拒 → getChunks **不再返回空数组**，改走按需读并把真实块给出来", async () => {
    port = portWithRefusedChunks({
      notebooks: [{ id: "nb1", name: "N", summary_status: "pending", source_count: 1, chunk_count: 0, created_at: 1, updated_at: 1 }],
      notebook_sources: [{ id: "src1", notebook_id: "nb1", name: "S", type: "text", status: "indexed", chunk_count: 2, created_at: 1 }],
      notebook_chunks: [chunkRow("c1", "nb1", "src1", 0), chunkRow("c2", "nb1", "src1", 1)],
    });
    setStoragePort(port as unknown as StoragePort);

    const k = await import("../core/knowledge/storage");
    /**
     * 第一次同步读拿不到（按需读是异步的，与 `attachments.content` 同一套做法）——
     * 但**不是返回 `[]` 冒充"没有内容"**，而是抛一个可区分的错误。
     * 改前这里返回 `[]`，调用方（检索）于是告诉 LLM"没有相关内容"。
     */
    expect(() => k.getChunks("nb1")).toThrowError(k.ChunkIndexUnavailableError);

    // 等按需读回来 → 第二次同步读拿到真实数据
    await settle();
    expect(k.chunkIndexState()).toBe("on-demand");
    expect(k.getChunks("nb1").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("C3-2: getChunksOrStatus 把「未就绪」与「确实没有内容」分成两种结果", async () => {
    port = portWithRefusedChunks({ notebook_chunks: [] });
    setStoragePort(port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");

    // 空笔记本（库里确实没有块）：第一次读仍是"未就绪"（拿不到 ≠ 没有）
    const first = k.getChunksOrStatus("nb-empty");
    expect(first.ok).toBe(false);
    await settle();
    // 按需读完（且确实为空）之后，才允许报"确实没有"
    const second = k.getChunksOrStatus("nb-empty");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.chunks).toEqual([]);
  });

  it("C3-3: refreshNotebookCounts **永不写回 0**，最终收敛到真实值", async () => {
    /**
     * 改前的连锁反应：`getChunkCount` 恒 0 → `refreshNotebookCounts` 把
     * `notebooks.chunk_count` **持久**写回 0 → 重启后仍是 0（越修越坏）。
     *
     * 修法允许两种中间结果，这条用例两条都钉住：
     * - **按需读还没回来** → 计数读不到 → **跳过写回**（保留旧值）；
     * - **按需读回来了** → 写**真实值**（库里确实有 1 块）。
     *
     * 唯一不允许的是 **0**，以及任何"编出来"的数。改前必然是 0。
     * （两种中间结果都合法是因为按需读是异步的；所以这里**不**钉死第一次调用的
     * 结果，而是钉死"永远不是 0" + "最终收敛到真值"。）
     */
    port = portWithRefusedChunks({
      notebooks: [{ id: "nb1", name: "N", summary_status: "pending", source_count: 1, chunk_count: 7, created_at: 1, updated_at: 1 }],
      notebook_sources: [{ id: "src1", notebook_id: "nb1", name: "S", type: "text", status: "indexed", chunk_count: 2, created_at: 1 }],
      notebook_chunks: [chunkRow("c1", "nb1", "src1", 0)],
    });
    setStoragePort(port as unknown as StoragePort);

    const k = await import("../core/knowledge/storage");
    k.refreshNotebookCounts("nb1");
    const afterFirst = port.__table("notebooks").find((r) => r.id === "nb1")!;
    expect(afterFirst.chunk_count, "绝不能写回 0（那是改前的表现：计数被写坏且重启后仍是 0）").not.toBe(0);
    expect([1, 7], "要么写真实值 1、要么保留旧值 7，不能是别的").toContain(afterFirst.chunk_count);
    expect(afterFirst.source_count).toBe(1);

    // 按需读一定已经回来 → 再刷一次必须收敛到真实值（这就是"可恢复"）
    await settle();
    k.refreshNotebookCounts("nb1");
    const afterSecond = port.__table("notebooks").find((r) => r.id === "nb1")!;
    expect(afterSecond.chunk_count, "镜像被拒之后计数也必须能修回真值").toBe(1);
    expect(afterSecond.source_count).toBe(1);
  });

  it("C3-3b: 按需读**也**拿不到时（端口没有该能力）→ 跳过写回，保留旧值", async () => {
    /**
     * 这是"读不到就绝不能写 0"的直接证据：把按需读能力也堵死之后，
     * `refreshNotebookCounts` 应当**什么都不写**（而不是把 7 改成 0）。
     */
    const p = createFakeStoragePort({
      neverReady: ["notebook_chunks", "notebooks", "notebook_sources"],
      seed: { notebooks: [{ id: "nb1", chunk_count: 7, source_count: 5, updated_at: 1 }] },
    });
    // 干掉按需读能力：command / execute 对 crud.list 一律报不支持
    const origExecute = p.data.execute.bind(p.data);
    p.data.execute = async (cmd: string) => {
      if (cmd === "crud.list") throw new StorageError("UNAVAILABLE", "该域未就绪");
      return origExecute(cmd);
    };
    (p.data as unknown as { command: unknown }).command = async () => {
      throw new StorageError("UNAVAILABLE", "该域未就绪");
    };
    port = p;
    setStoragePort(p as unknown as StoragePort);

    const k = await import("../core/knowledge/storage");
    k.refreshNotebookCounts("nb1");
    await settle();
    k.refreshNotebookCounts("nb1");

    const nb = p.__table("notebooks").find((r) => r.id === "nb1")!;
    expect(nb.chunk_count, "读不到就不能写回 0（旧值必须保留）").toBe(7);
    expect(nb.source_count).toBe(5);
  });

  it("C3-4: 镜像正常时快路径不变（行为一个字没改）", async () => {
    port = createFakeStoragePort({
      seed: {
        notebook_chunks: [chunkRow("c1", "nb1", "src1", 1), chunkRow("c2", "nb1", "src1", 0)],
      },
    });
    setStoragePort(port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");
    /*
     * 先把镜像拉起来：`domainPort()` 只在"该表加载完成"之后才路由过来
     * （真端口是异步加载，这与 `domain-mirror.test.ts` 的处理方式一致）。
     */
    port.domains.ensureLoaded("notebook_chunks");
    await settle();

    expect(k.chunkIndexState(), "镜像可用时必须报 mirror（这是检索的快路径）").toBe("mirror");
    expect(k.getChunks("nb1").map((c) => c.id), "仍按 chunk_index ASC").toEqual(["c2", "c1"]);
    expect(() => k.getChunks("nb1")).not.toThrow();
  });
});

// ============================================================
// C-4 反馈
// ============================================================

describe("C-4 消息反馈", () => {
  const seedForFeedback = () => ({
    messages: [{ id: "m1", session_id: "s1", role: "user", content: "hi", timestamp: 1, status: "done" }],
  });

  it("C4-1: `ifVersion` 未提供（undefined）**不是**版本冲突 —— 写入必须发生", async () => {
    /**
     * 改前：`if (ifVersion !== currentVersion)` 里 `currentVersion = existing?.version ?? null`，
     * 而 UI（`store.ts` 的 `setFeedback`）**不传版本** → `undefined !== null` 恒真 →
     * 直接返回 `version-conflict`、**任何写入都没发生**，返回值还被 `catch {}` 吞掉。
     * 这条用例改前拿到的 `ok` 是 false、`message_feedback` 里 0 行。
     */
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    const res = fb.putMessageFeedback("s1", "m1", "like", "写得不错"); // 不传 ifVersion
    expect(res.ok, "未提供版本 = 不校验版本，不是冲突").toBe(true);
    expect(port.__table("message_feedback")).toHaveLength(1);
    expect(port.__table("message_feedback")[0].feedback).toBe("like");
  });

  it("C4-2: 域写是**9 列超集**（note / version / created_at / updated_at 都在）", async () => {
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    fb.putMessageFeedback("s1", "m1", "like", "备注一");
    const row = port.__table("message_feedback")[0];
    expect(row.note).toBe("备注一");
    expect(typeof row.version).toBe("string");
    expect(row.version).not.toBe("");
    expect(row.created_at).toBeTypeOf("number");
    expect(row.updated_at).toBeTypeOf("number");
  });

  it("C4-3: 版本不匹配才算冲突", async () => {
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    const first = fb.putMessageFeedback("s1", "m1", "like");
    expect(first.ok).toBe(true);
    const v = first.ok ? first.item.version : "";

    const conflict = fb.putMessageFeedback("s1", "m1", "dislike", undefined, "wrong-version");
    expect(conflict.ok).toBe(false);

    const okAgain = fb.putMessageFeedback("s1", "m1", "dislike", undefined, v);
    expect(okAgain.ok, "带上正确版本应当成功").toBe(true);

    // 显式 null = 要求"当前没有反馈行" → 已有行时是冲突
    const nullExpectation = fb.putMessageFeedback("s1", "m1", "like", undefined, null);
    expect(nullExpectation.ok).toBe(false);
  });

  it("C4-4: `neutral` = 取消反馈（归一成删除），**不是**写一个 neutral 值", async () => {
    /**
     * 改前：`neutral` 被直接传给引擎，而表上有
     * `CHECK (feedback IN ('like','dislike'))` → 真 CLI 实测报
     * `参数 feedback 不合法：只允许 like / dislike（或 null 取消），收到 neutral`。
     * 界面上"取消反馈"于是永远失败（而 `store.ts` 是 `catch {}`，连日志都没有）。
     */
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    fb.putMessageFeedback("s1", "m1", "like");
    expect(port.__table("message_feedback")).toHaveLength(1);

    const cancelled = fb.putMessageFeedback("s1", "m1", "neutral");
    expect(cancelled.ok, "取消必须成功").toBe(true);
    expect(port.__table("message_feedback"), "取消 = 那一行被删掉").toHaveLength(0);
    expect(fb.getMessageFeedback("m1")).toBeNull();
  });

  it("C4-5: 域写（9 列）与轻量路径（5 列）的**列集合**关系：域写是超集", async () => {
    /**
     * ## 这条用例守什么、**不**守什么（请连同"需要他人配合"一起读）
     *
     * 守：**域写自己**写出来的是 9 列超集（note/version/created_at/updated_at 都在），
     * 也就是"统一到一个写者"时应当保留的那一份数据完整语义。
     *
     * **不**守（重要）：`store.ts` 里 `saveFeedback`（5 列，先删后插）与
     * `putMessageFeedback`（9 列）的**执行顺序**。真 CLI 实测那个顺序问题是真的：
     * ```
     * ① 写 9 列 → {note:"备注一", version:"v1", created_at:50, updated_at:100}
     * ② feedback.set（5 列）→ {note:null, version:null, created_at:null, updated_at:null}
     * ```
     * 也就是说"先 9 列、后 5 列"会把 note/version **抹掉**。
     * 当前 `store.ts` 是"先 5 列、后 9 列"，所以最终结果恰好是对的 ——
     * 但这个正确性**依赖调用顺序**，没有任何东西守着它。
     *
     * 为什么这条用例没有直接验证那个顺序：假端口（`src/test/fake-storage-port.ts`）
     * 目前对 `feedback.set` 命令**什么都不做**（落到末尾 `return 0`），
     * 所以"5 列写抹掉 4 列"这个真机行为在测试基座里**看不见**。
     * 那个文件在本次修复期间**正被另一位工作者编辑**（任务书划定的所有权边界），
     * 因此我**不改它** —— 需要补的实现与最小改法写在报告的"需要他人配合"里。
     */
    port = createFakeStoragePort({ seed: seedForFeedback() });
    setStoragePort(port as unknown as StoragePort);
    const fb = await import("../core/llm/feedback");

    fb.putMessageFeedback("s1", "m1", "like", "备注一");
    const row = port.__table("message_feedback")[0];
    // 9 列超集：轻量路径（feedback.set）只会写其中 5 列
    expect(Object.keys(row).sort()).toEqual(
      ["created_at", "feedback", "id", "message_id", "note", "session_id", "timestamp", "updated_at", "version"].sort(),
    );
    expect(row.note).toBe("备注一");
    expect(row.version).not.toBe("");
  });
});

// ============================================================
// C-5 待办勾选
// ============================================================

describe("C-5 待办状态更新不再静默", () => {
  it("C5-1: 镜像未就绪时勾选**如实上报**（改前：静默 return，连上报都没有）", async () => {
    port = createFakeStoragePort({ neverReady: ["todo_lists"] });
    setStoragePort(port as unknown as StoragePort);
    const { updateTodoStatus } = await import("../core/llm/tools/show-todo");

    updateTodoStatus("todo-1", "todo-1-0", "completed");
    /**
     * 改前这里既没有写入、也没有上报（函数末尾直接 `return;`）——
     * 用户勾选看起来生效、库里一行没写、日志里一行没有。
     */
    expect(persistFailureAreas(), "勾选未能落地必须可见").toContain("todo.updateStatus");
  });

  it("C5-2: 待办**不存在**与**镜像未就绪**给出不同结论", async () => {
    port = createFakeStoragePort({
      seed: { todo_lists: [{ id: "todo-1", session_id: "s1", todos: "[]", created_at: 1, updated_at: 1 }] },
    });
    setStoragePort(port as unknown as StoragePort);
    const { updateTodoStatus, loadTodoList } = await import("../core/llm/tools/show-todo");

    resetPersistFailures();
    updateTodoStatus("todo-does-not-exist", "x", "completed");
    const missingNotes = getPersistFailures().map((f) => f.lastMessage).join(" ");
    expect(missingNotes, "行不存在也要如实上报（不能静默空写）").toContain("不存在");

    // 镜像正常时能读到空列表（与"读不到"区分开）
    expect(loadTodoList("todo-1")).toEqual([]);
    expect(loadTodoList("todo-does-not-exist")).toBeNull();
  });

  it("C5-3: 勾选不存在的条目 → 上报为动作失败，且不产生无意义的覆盖写", async () => {
    port = createFakeStoragePort({
      seed: { todo_lists: [{ id: "todo-1", session_id: "s1", todos: JSON.stringify([{ id: "t0", content: "a", status: "pending", order: 0 }]), created_at: 1, updated_at: 1 }] },
    });
    setStoragePort(port as unknown as StoragePort);
    const { updateTodoStatus, loadTodoList } = await import("../core/llm/tools/show-todo");

    resetPersistFailures();
    updateTodoStatus("todo-1", "ghost-item", "completed");
    const entry = getPersistFailures().find((f) => f.area === "todo.updateStatus");
    expect(entry, "勾选不存在的条目必须可见").toBeDefined();
    expect(entry!.kind, "这不是落盘失败，是动作没生效").toBe("action");
    // 原内容未被无意义地改写
    expect(loadTodoList("todo-1")![0].status).toBe("pending");
  });
});

// ============================================================
// C-6 归档可逆
// ============================================================

describe("C-6 取消归档 + 列出已归档", () => {
  it("C6-1: squad 归档后可恢复，且 includeArchived 能把它列出来", async () => {
    port = createFakeStoragePort({
      seed: {
        squads: [
          { id: "s1", name: "A", leader_agent_id: "ag", instructions: null, project_id: "p1", archived: 0, created_at: 1, updated_at: 1 },
          { id: "s2", name: "B", leader_agent_id: "ag", instructions: null, project_id: "p1", archived: 1, created_at: 2, updated_at: 2 },
        ],
      },
    });
    setStoragePort(port as unknown as StoragePort);
    const { SquadStorage } = await import("../core/squad/squad-storage");

    // 默认行为不变：仍然只列未归档
    expect(SquadStorage.listAll().map((s) => s.id)).toEqual(["s1"]);
    expect(SquadStorage.listByProject("p1").map((s) => s.id)).toEqual(["s1"]);
    // 新增的"看归档"出口
    expect(SquadStorage.listByProject("p1", { includeArchived: true }).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(SquadStorage.listAll(true).map((s) => s.id).sort()).toEqual(["s1", "s2"]);

    // 恢复
    expect(SquadStorage.unarchive("s2")).toBe(true);
    expect(SquadStorage.listAll().map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(SquadStorage.getById("s2")!.archived).toBe(0);
  });

  it("C6-2: squad unarchive 的边界（不存在 → false，未归档 → 幂等 true）", async () => {
    port = createFakeStoragePort({
      seed: { squads: [{ id: "s1", name: "A", leader_agent_id: "ag", instructions: null, project_id: "p1", archived: 0, created_at: 1, updated_at: 1 }] },
    });
    setStoragePort(port as unknown as StoragePort);
    const { SquadStorage } = await import("../core/squad/squad-storage");

    expect(SquadStorage.unarchive("nope"), "不存在的团队不能 upsert 出幽灵行").toBe(false);
    expect(port.__table("squads")).toHaveLength(1);
    expect(SquadStorage.unarchive("s1"), "本来就没归档 = 幂等成功").toBe(true);
  });

  it("C6-3: inbox 归档后可恢复，且 includeArchived 生效", async () => {
    const base = { category: "system", title: "t", body: null, source_type: null, source_id: null, project_id: null, squad_id: null, issue_id: null, priority: "normal", read: 0, created_at: 1 };
    port = createFakeStoragePort({
      seed: {
        inbox: [
          { ...base, id: "i1", archived: 0 },
          { ...base, id: "i2", archived: 1 },
        ],
      },
    });
    setStoragePort(port as unknown as StoragePort);
    const { InboxStorage } = await import("../core/inbox/inbox-storage");

    expect(InboxStorage.listAll().map((r) => r.id)).toEqual(["i1"]);
    expect(InboxStorage.listAll({ includeArchived: true }).map((r) => r.id).sort()).toEqual(["i1", "i2"]);

    expect(InboxStorage.unarchive("i2")).toBe(true);
    expect(InboxStorage.listAll().map((r) => r.id).sort()).toEqual(["i1", "i2"]);
    expect(InboxStorage.unarchive("ghost")).toBe(false);
  });
});

// ============================================================
// C-7 轮次文件变更的 patch 按需取
// ============================================================

/**
 * 用**真端口**（`RustStoragePort`）+ 脚本化 transport 驱动 C-7。
 *
 * ## 为什么这里不能用 `createFakeStoragePort`
 *
 * C-7 的修法是"按 id 用 `crud.list` + `columns:["patch"]` 取正文"，
 * 而假端口的 `data.command` **没有实现 `crud.list`**（会抛
 * `fake-port: 未实现的命令 crud.list（测试双不得比实现更宽松）`）——
 * 于是"按需取"这条路在测试基座里根本走不通。
 * 假端口正被另一位工作者编辑（所有权边界），所以这里改用**真端口 + 脚本 transport**：
 * 它本来就是为了"在没有 Tauri 运行时的情况下验证端口语义"而存在的
 * （见 `rust-port.ts` 的 `StorageTransport` 注释）。
 */
function realPortWithScriptedCrudList(seed: Record<string, Array<Record<string, unknown>>>, chunkRows: Array<Record<string, unknown>>) {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      calls.push({ command, params: p });
      const table = String(p.table ?? "");
      if (command === "crud.list") {
        // 复刻引擎的**列投影**：按 `columns` 只回那些列（不传就回全列）
        const cols = (p.columns as string[] | undefined) ?? null;
        const where = (p.where as Record<string, unknown> | undefined) ?? {};
        let items = [...(seed[table] ?? [])].filter((row) =>
          Object.entries(where).every(([k, v]) => row[k] === v),
        );
        if (cols) items = items.map((row) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
        return { ok: true, result: { items, has_more: false, next_cursor: null } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      void chunkRows;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  const real = new RustStoragePort(transport as never, () => { /* 失败上报不影响本用例 */ });
  return { real, calls };
}

/** 让真端口的域镜像真的把 `turn_file_changes` 加载起来（否则 `getById` 恒为 null） */
async function loadTurnFileChangesMirror(real: RustStoragePort) {
  real.domains.ensureLoaded("turn_file_changes");
  for (let i = 0; i < 32; i++) await Promise.resolve();
  expect(real.domains.isReady("turn_file_changes"), "镜像必须已加载（测试前提）").toBe(true);
}

/**
 * 把镜像里的 `patch` 抹掉 —— 复刻 `DOMAIN_COLUMN_PROJECTION` 若把
 * `turn_file_changes.patch` 排除之后该表的真实形态（**记录在、正文不在**）。
 *
 * 为什么用"打桩镜像读取"而不是真去改投影：投影清单在 `rust-port.ts`
 * （**别人的文件**，见报告"需要他人配合"）。
 * 本条用例守的是 `file-change-tracker.ts` 自己那一半 ——
 * 这种形态下必须**按 id 去取正文**，而不是像改前那样放弃回滚。
 */
function stripPatchFromMirror(real: RustStoragePort) {
  const domains = real.domains as unknown as {
    findOne<R>(t: string, w: Record<string, unknown>): R | null;
  };
  const origFindOne = domains.findOne.bind(real.domains);
  domains.findOne = <R>(name: string, where: Record<string, unknown>): R | null => {
    const hit = origFindOne<Record<string, unknown>>(name, where);
    if (name === "turn_file_changes" && hit) return { ...hit, patch: null } as unknown as R;
    return hit as R | null;
  };
}

describe("C-7 turn_file_changes 的 patch 按需取", () => {
  /**
   * 真 CLI 取证：一张 12 列表、只有 1 行 500KB patch 时，
   * 一次 `crud.list`（**不传 columns**）的返回体是 **500,275 字节** ——
   * 即"整表连同 patch 正文被拉进渲染进程"。
   * 传 `columns: ["patch"]` 时就只回那一列。
   */
  it("C7-1: 记录里没有 patch 时，按 id **只取 patch 列**（不整表装载）", async () => {
    const { real, calls } = realPortWithScriptedCrudList(
      {
        turn_file_changes: [
          {
            id: "tfc1", session_id: "s1", message_id: "m1", turn_index: 0,
            before_tree: "b", after_tree: "a", patch: "PATCH-BODY", changed_files: "[]",
            patch_sha256: "h", current_brief: "b", status: "completed", created_at: 1,
          },
        ],
      },
      [],
    );
    setStoragePort(real as unknown as StoragePort);
    await real.start();
    await loadTurnFileChangesMirror(real);

    /**
     * 让**镜像**只带元数据、不带 patch 正文 —— 那就是列投影生效后的形态
     * （投影清单在 `rust-port.ts`，**别人的文件**，见报告"需要他人配合"）。
     * 本用例守的是 `file-change-tracker.ts` 自己那一半：
     * "记录在、正文不在"时必须**按 id 去取**，而不是像改前那样直接
     * `no patch found` 然后放弃回滚。
     */
    stripPatchFromMirror(real);

    const { FileChangeStorage } = await import("../core/storage/file-change-storage");
    const mirrored = FileChangeStorage.getById("tfc1")!;
    expect(mirrored, "镜像里记录在").not.toBeNull();
    expect(mirrored.patch, "但正文不在（这就是按需取要解决的形态）").toBeNull();

    let writeFileArgs: any = null;
    (window as any).__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd: string, args: any) => {
          if (cmd === "write_file") { writeFileArgs = args; return null; }
          if (cmd === "execute_command") return { stdout: "", stderr: "", exitCode: 0 };
          return null;
        }),
      },
    };

    const { FileChangeTracker } = await import("../core/environment/file-change-tracker");
    resetPersistFailures();
    const ok = await FileChangeTracker.revert("tfc1", "/fake/repo");
    expect(ok, "按需取到 patch 之后必须能继续回滚").toBe(true);
    expect(writeFileArgs?.content, "写进临时补丁文件的必须是按需取回的正文").toBe("PATCH-BODY");

    // 按需读确实发出了带 columns 的 crud.list（不是整表装载）
    const listCalls = calls.filter((c) => c.command === "crud.list" && c.params.table === "turn_file_changes");
    expect(listCalls.length, "必须真的发出了按需读").toBeGreaterThan(0);
    /*
     * 挑出**按需读那一次**：`file-change-tracker.ts` 的 `fetchPatchById` 发的是
     * `columns: ["patch"]`（只那一列）。镜像装载（`RustDomainMirror.loadTable`）也会发
     * `crud.list`，但它要么不传 columns、要么传的是**投影清单里的多列**
     * （`DOMAIN_COLUMN_PROJECTION` 在 `rust-port.ts` —— 别人的文件，
     * 正在被另一位工作者修改，所以这里**不假设**它长什么样，
     * 只按"恰好一列且是 patch"来定位按需读）。
     */
    const onDemandCall = listCalls.find(
      (c) => Array.isArray(c.params.columns) && (c.params.columns as string[]).length === 1,
    );
    expect(onDemandCall, "按需读必须带 columns 投影且只取一列").toBeDefined();
    expect(onDemandCall!.params.columns, "只取 patch 一列").toEqual(["patch"]);
    expect(onDemandCall!.params.where, "按 id 精确取那一行").toEqual({ id: "tfc1" });
  });

  it("C7-1b: 记录在但补丁正文缺失 → 如实区分（不是含糊的 no patch found）", async () => {
    const { real } = realPortWithScriptedCrudList(
      {
        turn_file_changes: [
          {
            id: "tfc2", session_id: "s1", message_id: "m1", turn_index: 0,
            before_tree: "b", after_tree: "a", patch: null, changed_files: "[]",
            patch_sha256: null, current_brief: "b", status: "completed", created_at: 1,
          },
        ],
      },
      [],
    );
    setStoragePort(real as unknown as StoragePort);
    await real.start();
    await loadTurnFileChangesMirror(real);
    (window as any).__TAURI__ = { core: { invoke: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) } };

    const { FileChangeTracker } = await import("../core/environment/file-change-tracker");
    resetPersistFailures();
    expect(await FileChangeTracker.revert("tfc2", "/fake/repo")).toBe(false);
    /**
     * ⚠️ 断言要看 **`reportActionFailure` 的 `extra`（"回滚未执行：…"）**，
     * 而不是 `lastMessage`：`reportFailure` 把 `lastMessage` 填成**错误对象**的 message
     * （即 `"turn_file_changes id=tfc2 的 patch 为空"`，是给日志/排查看的），
     * 而给用户看的那句话在 `extra` 里。两条都该说清"补丁缺失"而不是"记录不存在"。
     */
    const all = getPersistFailures();
    expect(all.map((f) => f.area)).toContain("fileChange.revert");
    expect(all[0].lastMessage, "错误本身要说清是补丁为空").toContain("patch 为空");
    // 关键区分：**不能**被说成"记录不存在"
    expect(all[0].lastMessage).not.toContain("里没有 id");
    expect(all[0].kind, "这是动作失败（记录在、只是没补丁），不是落盘失败").toBe("action");
  });

  it("C7-2: 记录不存在 → 业务失败（如实上报），且不去打补丁", async () => {
    const { real } = realPortWithScriptedCrudList({ turn_file_changes: [] }, []);
    setStoragePort(real as unknown as StoragePort);
    await real.start();
    await loadTurnFileChangesMirror(real);
    const { FileChangeTracker } = await import("../core/environment/file-change-tracker");
    resetPersistFailures();
    expect(await FileChangeTracker.revert("missing-id", "/fake/repo")).toBe(false);
    expect(persistFailureAreas(), "缺记录必须如实上报").toContain("fileChange.revert");
    const msg = getPersistFailures().map((f) => f.lastMessage).join(" | ");
    expect(msg, "缺记录要说清是哪一条").toContain("missing-id");
  });

  it("C7-3: start() 必须取到工作区快照，否则 finalize() 恒为 null（文件变更域整体失效）", async () => {
    /**
     * 第 84 波引入 `beforeSnapshot`，但 `start()` **从未赋值**，
     * 而 `finalize()` 的第一句是 `if (!this.active || !this.beforeTree || !this.beforeSnapshot) return null;`
     * → **`finalize()` 恒返回 null** → `turn_file_changes` 里永远没有行 → 回滚功能无从谈起。
     * 这条用例改前必然失败（`result` 是 null）。
     */
    const commands: string[] = [];
    (window as any).__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd: string, args: any) => {
          if (cmd !== "execute_command") return null;
          const c = String(args.command);
          commands.push(c);
          if (c.includes("rev-parse --is-inside-work-tree")) return { stdout: "true", stderr: "", exitCode: 0 };
          if (c.includes("HEAD^{tree}")) return { stdout: "tree-abc", stderr: "", exitCode: 0 };
          if (c.includes("stash create")) return { stdout: "stash-abc", stderr: "", exitCode: 0 };
          if (c.includes("ls-files")) return { stdout: "new-file.ts", stderr: "", exitCode: 0 };
          // diff --name-status / --stat / --binary
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    };

    port = createFakeStoragePort({
      seed: { sessions: [{ id: "s1", project_id: "p1", title: "t", created_at: 1, last_message_at: 1, message_count: 0 }] },
    });
    setStoragePort(port as unknown as StoragePort);

    const { FileChangeTracker } = await import("../core/environment/file-change-tracker");
    const tracker = new FileChangeTracker("/fake/repo", "s1", "m1", 1);
    expect(await tracker.start()).toBe(true);
    expect(commands.some((c) => c.includes("stash create")), "start() 必须取工作区快照").toBe(true);

    // 有未跟踪新文件 → finalize 必须产出记录（而不是恒 null）
    const result = await tracker.finalize();
    expect(result, "start() 取过快照之后 finalize 才能产出记录").not.toBeNull();
    expect(port.__table("turn_file_changes")).toHaveLength(1);
  });
});

// ============================================================
// C-8 知识域"先读后写"不再静默丢弃
// ============================================================

describe("C-8 知识域先读后写不得静默丢弃", () => {
  it("C8-1: 笔记版本保存 —— 镜像未就绪时如实上报（改前静默 return）", async () => {
    port = createFakeStoragePort({ neverReady: ["notes"] });
    setStoragePort(port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");

    resetPersistFailures();
    k.saveNoteVersion("note-1", "自动版本");
    expect(persistFailureAreas(), "读不到笔记必须上报，不能静默丢弃版本").toContain("noteVersion.save");
  });

  it("C8-2: 恢复版本 —— 版本读不到时如实上报（改前静默 return）", async () => {
    port = createFakeStoragePort({ neverReady: ["note_versions"] });
    setStoragePort(port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");

    resetPersistFailures();
    k.restoreNoteVersion("ver-1");
    expect(persistFailureAreas()).toContain("noteVersion.restore");
  });

  it("C8-3: 闪卡复习 —— 卡片读不到时如实上报（改前静默丢弃复习进度）", async () => {
    port = createFakeStoragePort({ neverReady: ["flashcards"] });
    setStoragePort(port as unknown as StoragePort);
    const f = await import("../core/knowledge/flashcard-store");

    resetPersistFailures();
    f.reviewFlashcard("fc-1", "good");
    expect(persistFailureAreas()).toContain("flashcard.review");
  });

  it("C8-4: 镜像正常时行为不变（版本真的被保存）", async () => {
    port = createFakeStoragePort({
      seed: { notes: [{ id: "note-1", notebook_id: "nb1", title: "T", content: "C", content_type: "markdown", tags: null, pin_order: 0, created_at: 1, updated_at: 1 }] },
    });
    setStoragePort(port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");

    k.saveNoteVersion("note-1", "第一版");
    const rows = port.__table("note_versions");
    expect(rows).toHaveLength(1);
    expect(rows[0].note_id).toBe("note-1");
    expect(rows[0].version_note).toBe("第一版");
  });
});

// ============================================================
// C-9 notebook_groups 置空 parent_id
// ============================================================

describe("C-9 notebook_groups 能真正移出分组", () => {
  it("C9-1: `parentId: null` = 显式置空；`undefined` = 未提供", async () => {
    /**
     * 改前：签名是 `Pick<NotebookGroup, 'parentId'>`（`string | undefined`），
     * 传 `null` 是**类型错误** —— 也就是说"移出分组"这条路在类型层面就堵死了
     * （生产代码里 `updateGroup` 的调用点 = 0）。
     * 这条用例直接验证新契约的两态语义。
     */
    port = createFakeStoragePort({
      seed: {
        notebook_groups: [
          { id: "g1", name: "子分组", parent_id: "p0", sort_order: 0, created_at: 1 },
          { id: "g2", name: "另一个", parent_id: "p0", sort_order: 1, created_at: 1 },
        ],
      },
    });
    setStoragePort(port as unknown as StoragePort);
    const k = await import("../core/knowledge/storage");

    // 未提供 → 不动这一列
    k.updateGroup("g1", { name: "改名" });
    let row = port.__table("notebook_groups").find((r) => r.id === "g1")!;
    expect(row.name).toBe("改名");
    expect(row.parent_id, "undefined = 未提供，不能顺手清空").toBe("p0");

    // 显式 null → 真正移出分组（写 NULL）
    k.updateGroup("g1", { parentId: null });
    row = port.__table("notebook_groups").find((r) => r.id === "g1")!;
    expect(row.parent_id, "null = 显式置空").toBeNull();

    // 读回也把 NULL 当成"未分组"
    expect(k.listGroups(null).map((g) => g.id)).toContain("g1");

    // 反向：再挂回去
    k.updateGroup("g1", { parentId: "p0" });
    row = port.__table("notebook_groups").find((r) => r.id === "g1")!;
    expect(row.parent_id).toBe("p0");
    // 另一个分组没被牵连
    expect(port.__table("notebook_groups").find((r) => r.id === "g2")!.parent_id).toBe("p0");
  });
});
