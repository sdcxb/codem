/**
 * 第 269 波：`turn_file_changes` —— **不再进镜像** ✗→✓，改走**按需查询 + 有界"一屏"投影** ✓
 *
 * ## 这条判据守的是什么缺陷（用户第二次报障 ✓）
 *
 * > 【操作没有生效（`storage.bootstrap.domain.turn_file_changes.too-large`）：
 * >   表 `turn_file_changes` 超过镜像上限 5000 行。该功能本次不可用，请重试或检查日志。】
 *
 * 量清的机制（`docs/HANDOFF-NEXT-SESSION.md` §3 ✓）：
 * `bootstrap.ts` 把它列进**启动预取清单** ⇒ 启动就整表镜像 ✗ ⇒ 拉满一页发现
 * `rows.length > cap` ⇒ `RustDomainMirror.loadTable` **拒载**✗（不是截断 ✗）
 * ⇒ `refused.add(table)` + 上报 `domain.turn_file_changes.too-large` ✗
 * ⇒ 该域这一段时间读给空结果 ✗。
 *
 * 三条硬结论（决定了修法方向 ✓）：
 * 1. 是**拒载**不是截断 ⇒ 把 cap 调**低**只会更早拒载 ✗（方向反了）；
 * 2. 它是**追加型热表** ⇒ 任何固定 cap ✗ 迟早复发 ✗；
 * 3. "稍后自动重试"✗ 是**设计行为** ✓，不是修法 ✓。
 *
 * ## 判据表（先写判据，再写/改实现 ✓）
 *
 * | 判据 | 钉什么 | 变异（改坏哪里 ⇒ 它红 ✓） |
 * |---|---|---|
 * | `TFC-1` | **>5000 行时该域读不得给空结果** ✓（本波的主判据 ✓） | 把窗口查询换回 `domainReadMany`（走镜像）⇒ 恒空 ⇒ 红 |
 * | `TFC-2` | 反向对照：**正常规模时行为逐字不变** ✓ | —— |
 * | `TFC-3` | 一屏查询必须**带投影列** + `order_by/desc/limit` ✓ | 去掉 `order_by` / 去掉 `limit` ⇒ 红 |
 * | `TFC-4` | 引擎回整行（含 `patch`）时，**正文不得进一屏** ✓ | 把行原样 `push` 进缓存（不过投影）⇒ 红 |
 * | `TFC-5` | **写后读得到自己** ✓ + 删除后缓存同步摘除 ✓（陈旧数据不许复活 ✗） | 删掉 `create` 里的并入 / 删掉 `deleteBySession` 里的摘除 ⇒ 红 |
 * | `TFC-6` | 驻留**有界** ✓（≤3 个会话 × ≤200 行 ✓） | 去掉 LRU 淘汰 ⇒ 红 |
 * | `TFC-7` | **结构性**：`turn_file_changes` 不进预取清单 ✓ + 两份"按需表"清单一致 ✓ + 投影列一致 ✓ | 把表加回 `HOT_DOMAIN_TABLES` / 只改一份清单 ⇒ 红 |
 * | `TFC-8` | **不再有"超过镜像上限"这条报障** ✓（机制上不可能 ✓） | 去掉 `DOMAIN_QUERY_ONLY_TABLES` 的拦截 ⇒ 红 |
 *
 * ⚠️ **不许"测试空转"** ✗：本文件的一屏查询一律经**真端口**（`RustStoragePort`）+
 * **引擎形状**的 transport（`where` 过滤 ✓、`columns` 投影 ✓、`order_by/desc` 排序 ✓、
 * `limit` 切片 ✓），断言的是**发出去的参数**与**读回来的行** ✓ ——
 * 不是"函数被调用过" ✓。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { RustStoragePort, DOMAIN_QUERY_ONLY_TABLES, type StorageTransport } from "../core/storage/rust-port";

const TABLE = "turn_file_changes";

/** 上报留痕（与 `domain-mirror.test.ts` 同一种做法：把 note 收进数组 ✓） */
const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s: unknown, finding: unknown) =>
    failures.push(typeof finding === "string" ? finding : String(finding)),
}));

/** 把在途的异步链排空（宏任务会把它之前排队的微任务全部排完 ✓，与链深无关 ✓） */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/**
 * **引擎形状**的 transport ✓ —— 逐条对齐 `codem-db/src/crud.rs::crud_list`：
 * `where` 只支持等值 ✓、`columns` 裁剪（缺省整行 ✓）、`order_by` 单列 + `desc` ✓、
 * `limit`/`offset` 切片并给 `has_more` ✓。
 *
 * ⚠️ 它刻意**比产品更宽松**一点：`keepPatch` 打开时**无视列投影**、整行返回 ✓
 * —— 这正是 `TFC-4` 需要的形态（引擎侧若有列缺失也必须由客户端投影兜住 ✓）。
 */
function engineTransport(seed: Record<string, Array<Record<string, unknown>>>, opts: { keepPatch?: boolean } = {}) {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const transport: StorageTransport = {
    async invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      const p = params ?? {};
      calls.push({ command, params: p });
      if (command === "crud.list") {
        const table = String(p.table ?? "");
        const where = (p.where as Record<string, unknown> | undefined) ?? {};
        let rows = [...(seed[table] ?? [])].filter((row) =>
          Object.entries(where).every(([k, v]) => row[k] === v),
        );
        if (typeof p.order_by === "string") {
          const key = p.order_by;
          const desc = p.desc === true;
          rows = [...rows].sort((a, b) => {
            const av = a[key] as number;
            const bv = b[key] as number;
            const cmp = av === bv ? 0 : av < bv ? -1 : 1;
            return desc ? -cmp : cmp;
          });
        }
        const cols = p.columns as string[] | undefined;
        if (Array.isArray(cols) && cols.length > 0 && !opts.keepPatch) {
          rows = rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
        }
        const limit = Number(p.limit ?? rows.length);
        const offset = Number(p.offset ?? 0);
        const items = rows.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < rows.length, next_cursor: null } } as T;
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
  return { transport, calls };
}

/** 造一行（默认带一段"大正文" ✓，用来验证投影真的把它挡住了 ✓） */
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `tfc-${over.id ?? "x"}`,
    session_id: "s1",
    message_id: "m1",
    turn_index: 0,
    before_tree: "b",
    after_tree: "a",
    patch: "P".repeat(200),
    changed_files: "[]",
    patch_sha256: "h",
    current_brief: "brief",
    status: "completed",
    created_at: 1,
    ...over,
  };
}

async function withPort(
  seed: Record<string, Array<Record<string, unknown>>>,
  opts: { keepPatch?: boolean } = {},
) {
  const t = engineTransport(seed, opts);
  const port = new RustStoragePort(t.transport, () => {});
  setStoragePort(port as unknown as StoragePort);
  await port.start();
  return { port, calls: t.calls };
}

/** 每次用例都从干净的"一屏"开始（模块级状态不许串味 ✓） */
async function freshStorage() {
  const mod = await import("../core/storage/file-change-storage");
  mod.__resetFileChangeWindow();
  failures.length = 0;
  return mod;
}

beforeEach(() => {
  failures.length = 0;
});

afterEach(() => {
  setStoragePort(null);
});

// ========== 主判据 ==========

describe("TFC-1 真机形态：表 **远超**镜像上限时，该域读**不得**给空结果", () => {
  it("TFC-1: 5001 行 ⇒ 会话读到最近 200 行（不为空、不含 patch），且没有 too-large 报障", async () => {
    const { FileChangeStorage, TURN_FILE_CHANGE_WINDOW_ROWS } = await freshStorage();
    /**
     * 真机形态：**5001 行**（原来就是这一个数字把整域打成"拒绝镜像"✗）。
     * turn_index 递增 ⇒ "最近 200 行"就是 turn_index 4801..5000 ✓（可精确断言 ✓）。
     */
    const rows = Array.from({ length: 5001 }, (_, i) => row({ id: `r${i}`, turn_index: i }));
    const { calls } = await withPort({ [TABLE]: rows });

    const list = await FileChangeStorage.loadBySession("s1");

    expect(list.length, "一屏就是 200 行（有界 ✓）").toBe(TURN_FILE_CHANGE_WINDOW_ROWS);
    expect(list[0].turn_index, "必须是**最新**那一端（turn_index DESC ✓）").toBe(5000);
    expect(list[list.length - 1].turn_index).toBe(5001 - TURN_FILE_CHANGE_WINDOW_ROWS);
    expect(
      list.some((r) => r.patch),
      "`patch` 正文（单行上限 500,000 字符）绝不许进一屏 ✓",
    ).toBe(false);

    /**
     * **不许**再出现"超过镜像上限"这条报障 ✓ —— 这是本波要治的那条用户可见告警 ✓。
     * 注意它不是"这次没超"✗，而是**机制上不可能** ✓（`TFC-8` 钉的就是这一层 ✓）。
     */
    expect(
      failures.filter((n) => n.includes("超过镜像上限")),
      "这张表已结构性不进镜像 ⇒ 这条报障不该再存在",
    ).toEqual([]);
    /** 顺带：一次按需读 = **一次**查询 ✓（不搞"分页拉好几页"✗ —— 那样又变成整表扫描 ✗） */
    const listCalls = calls.filter((c) => c.command === "crud.list" && c.params.table === TABLE);
    expect(listCalls.length, "一屏读只发一次查询（limit 已经是有界窗口 ✓）").toBe(1);
  });

  it("TFC-1b: 别的会话仍然读得到自己的行（`where` 真的生效，不是把整表搬回来）", async () => {
    const { FileChangeStorage } = await freshStorage();
    await withPort({
      [TABLE]: [
        ...Array.from({ length: 5001 }, (_, i) => row({ id: `r${i}`, session_id: "s1", turn_index: i })),
        row({ id: "other", session_id: "s2", turn_index: 7 }),
      ],
    });

    const mine = await FileChangeStorage.loadBySession("s2");
    expect(mine.map((r) => r.id)).toEqual(["other"]);
  });
});

describe("TFC-2 反向对照：正常规模时行为**逐字不变**", () => {
  it("TFC-2: 3 行的会话按 `turn_index` DESC 读出 3 行，字段一个不少", async () => {
    const { FileChangeStorage } = await freshStorage();
    await withPort({
      [TABLE]: [
        row({ id: "a", turn_index: 1, changed_files: '[{"path":"a.ts","status":"M"}]' }),
        row({ id: "b", turn_index: 3, current_brief: "Turn 3" }),
        row({ id: "c", turn_index: 2 }),
      ],
    });

    const list = await FileChangeStorage.loadBySession("s1");
    expect(list.map((r) => r.id), "turn_index DESC").toEqual(["b", "c", "a"]);
    expect(FileChangeStorage.parseChangedFiles(list[2]), "`changed_files` 必须能解析").toEqual([
      { path: "a.ts", status: "M" },
    ]);
    expect(list[0].current_brief).toBe("Turn 3");
    expect(list[0].status).toBe("completed");
    expect(list[0].before_tree).toBe("b");
    expect(list[0].after_tree).toBe("a");
    expect(list[0].patch_sha256).toBe("h");
    expect(typeof list[0].created_at).toBe("number");
  });
});

// ========== 查询参数与投影 ==========

describe("TFC-3 一屏查询的**参数**（投影 + 排序 + 有界）", () => {
  it("TFC-3: 必须带投影列、`order_by: turn_index` + `desc` + 有界 `limit`，且列里没有 `patch`", async () => {
    const { FileChangeStorage, TURN_FILE_CHANGE_WINDOW_COLUMNS, TURN_FILE_CHANGE_WINDOW_ROWS } = await freshStorage();
    const { calls } = await withPort({ [TABLE]: [row({ id: "a", turn_index: 1 })] });

    await FileChangeStorage.loadBySession("s1");

    const q = calls.find((c) => c.command === "crud.list" && c.params.table === TABLE);
    expect(q, "必须真的发出按需查询").toBeDefined();
    expect(q!.params.where, "按会话精确取").toEqual({ session_id: "s1" });
    expect(q!.params.order_by, "排序必须在**引擎侧**（不是把整表拉回来自己排）").toBe("turn_index");
    expect(q!.params.desc, "要的是**最新**那一端").toBe(true);
    expect(q!.params.limit, "必须有界").toBe(TURN_FILE_CHANGE_WINDOW_ROWS);
    const cols = q!.params.columns as string[];
    expect(cols, "`patch` 正文不进一屏").not.toContain("patch");
    expect(cols, "投影列清单必须逐字一致").toEqual([...TURN_FILE_CHANGE_WINDOW_COLUMNS]);
  });

  it("TFC-3b: `getByIdAsync` 按 id 只取一行，列同样是投影（不带 patch）", async () => {
    const { FileChangeStorage } = await freshStorage();
    const { calls } = await withPort({ [TABLE]: [row({ id: "a", turn_index: 1 })] });

    const rec = await FileChangeStorage.getByIdAsync("a");
    expect(rec?.id).toBe("a");
    expect(rec?.patch, "一屏投影不含 patch（正文按 id 单独取 ✓）").toBeUndefined();

    const q = calls.find((c) => c.command === "crud.list" && c.params.table === TABLE);
    expect(q!.params.where).toEqual({ id: "a" });
    expect(q!.params.limit).toBe(1);
    expect(q!.params.columns as string[]).not.toContain("patch");
  });
});

describe("TFC-4 引擎回整行时，正文**不得**进一屏（客户端投影是最后一道）", () => {
  it("TFC-4: 引擎无视列投影、整行（含 patch）返回 ⇒ 一屏里依然没有正文", async () => {
    const { FileChangeStorage } = await freshStorage();
    /**
     * `keepPatch: true` = 引擎**不**按 `columns` 裁剪 ✓（这正是最需要兜住的形态：
     * "列投影"这条能力一旦在引擎侧缺失/退化，客户端不能把 500KB 正文留在内存里 ✗）。
     */
    await withPort({ [TABLE]: [row({ id: "a", turn_index: 1, patch: "X".repeat(5000) })] }, { keepPatch: true });

    const list = await FileChangeStorage.loadBySession("s1");
    expect(list).toHaveLength(1);
    expect(list[0].patch, "正文不许驻留（一屏是**投影**，不是整行 ✗）").toBeUndefined();
    /** 但**别的列一个都不能少** ✓（不许"顺手多砍"✗ —— 判据 TFC-2 也钉了这条 ✓） */
    expect(list[0].changed_files).toBe("[]");
    expect(list[0].current_brief).toBe("brief");
  });
});

// ========== 写 / 删 / 驻留 ==========

describe("TFC-5 写后读得到自己；删除后不许复活", () => {
  it("TFC-5: 写进一屏的会话 ⇒ `listBySession()` 立刻能看到刚写的行", async () => {
    const { FileChangeStorage } = await freshStorage();
    await withPort({ [TABLE]: [] });
    // 先按需读一次（= 这个会话被"打开"过 ✓）
    expect(await FileChangeStorage.loadBySession("s1")).toEqual([]);

    FileChangeStorage.create({
      id: "new-1",
      session_id: "s1",
      message_id: "m9",
      turn_index: 9,
      before_tree: null,
      after_tree: null,
      patch: null,
      changed_files: "[]",
      patch_sha256: null,
      current_brief: "Turn 9",
      status: "completed",
      created_at: 9,
    });

    expect(
      FileChangeStorage.listBySession("s1").map((r) => r.id),
      "写完读不到自己 = 最难查的时序缺陷（不许 ✗）",
    ).toEqual(["new-1"]);
  });

  it("TFC-5b: 没按需读过的会话，同步读返回 `[]`（不假装、也不凭空驻留）", async () => {
    const { FileChangeStorage, __windowSessionCount } = await freshStorage();
    await withPort({ [TABLE]: [row({ id: "a", session_id: "s1" })] });

    expect(FileChangeStorage.listBySession("s1"), "没读过 ⇒ 空（诚实 ✓，不是假数据 ✗）").toEqual([]);
    expect(__windowSessionCount(), "没人按需读过 ⇒ 一个会话都不驻留（这才是'只许变小' ✓）").toBe(0);
  });

  it("TFC-5c: `deleteBySession` 之后缓存里那份必须同步摘掉（陈旧数据不许复活）", async () => {
    const { FileChangeStorage } = await freshStorage();
    const { calls } = await withPort({
      [TABLE]: [
        row({ id: "a", session_id: "s1", turn_index: 1 }),
        row({ id: "b", session_id: "s2", turn_index: 1 }),
      ],
    });
    await FileChangeStorage.loadBySession("s1");
    await FileChangeStorage.loadBySession("s2");
    expect(FileChangeStorage.listBySession("s1")).toHaveLength(1);

    FileChangeStorage.deleteBySession("s1");

    expect(FileChangeStorage.listBySession("s1"), "删完还读得出来 = 数据复活").toEqual([]);
    expect(FileChangeStorage.listBySession("s2"), "别的会话不许被牵连").toHaveLength(1);
    /** 删除必须**直达引擎** ✓（不是"等镜像就绪再排队"✗ —— 它永远不会就绪 ✗） */
    const del = calls.find((c) => c.command === "crud.delete");
    expect(del, "删除必须当场发出去").toBeDefined();
    expect(del!.params.where).toEqual({ session_id: "s1" });
  });

  it("TFC-5d: `updateStatus` 语义不变（存在 ⇒ 1，不存在 ⇒ 0），且同步读能看到新状态", async () => {
    const { FileChangeStorage } = await freshStorage();
    await withPort({ [TABLE]: [row({ id: "a", session_id: "s1", turn_index: 1 })] });
    await FileChangeStorage.loadBySession("s1");

    expect(await FileChangeStorage.updateStatus("a", "reverted")).toBe(1);
    expect(FileChangeStorage.listBySession("s1")[0].status, "缓存里那行也要改（否则同步读是旧状态）").toBe("reverted");
    expect(await FileChangeStorage.updateStatus("ghost", "reverted"), "不存在必须如实返回 0").toBe(0);
  });
});

describe("TFC-6 驻留**有界**（不是「再引入一个无界镜像」）", () => {
  it("TFC-6: 打开 5 个会话 ⇒ 最多只驻留 3 个，且每屏 ≤200 行", async () => {
    const { FileChangeStorage, __windowSessionCount, TURN_FILE_CHANGE_WINDOW_SESSIONS, TURN_FILE_CHANGE_WINDOW_ROWS } =
      await freshStorage();
    const seed = Array.from({ length: 5 }, (_, s) =>
      Array.from({ length: 400 }, (_, i) => row({ id: `s${s}-${i}`, session_id: `s${s}`, turn_index: i })),
    ).flat();
    await withPort({ [TABLE]: seed });

    for (let s = 0; s < 5; s++) {
      const list = await FileChangeStorage.loadBySession(`s${s}`);
      expect(list.length, "每屏都有界").toBeLessThanOrEqual(TURN_FILE_CHANGE_WINDOW_ROWS);
    }

    expect(__windowSessionCount(), "驻留会话数必须有界（LRU ✓）").toBe(TURN_FILE_CHANGE_WINDOW_SESSIONS);
    /** 最近读的那个会话**必须还在** ✓（LRU 淘汰的是最久未用的 ✓，不是刚读的 ✗） */
    expect(FileChangeStorage.listBySession("s4")).toHaveLength(TURN_FILE_CHANGE_WINDOW_ROWS);
  });
});

// ========== 结构性与"报障不可能再出现" ==========

describe("TFC-7 结构性：这张表**永远**不会被镜像", () => {
  it("TFC-7a: 不在启动预取清单里（删掉它才是本波的第一层）", async () => {
    const { HOT_DOMAIN_TABLES } = await import("../core/storage/bootstrap");
    expect(
      HOT_DOMAIN_TABLES,
      "它在清单里 ⇒ 启动就整表镜像 ⇒ 真机 5001 行拒载 ⇒ 用户报障",
    ).not.toContain(TABLE);
  });

  it("TFC-7b: 两份『按需表』清单必须**逐字一致**（不一致 = 一边挡、一边还去拉）", async () => {
    const store = await import("../core/storage/domain-store");
    /** 从源码里取（它是模块私有常量 ✓）—— 用"读字面代码"而不是再导出一份影子清单 ✓ */
    const src = (await import("node:fs")).readFileSync("src/core/storage/domain-store.ts", "utf8");
    const m = src.match(/const ON_DEMAND_TABLES = new Set<string>\(\[([^\]]*)\]\)/);
    expect(m, "`ON_DEMAND_TABLES` 必须还是那个字面形状（否则本判据要一起改）").not.toBeNull();
    const onDemand = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect(onDemand, "`domain-store.ON_DEMAND_TABLES` 必须与 `rust-port.DOMAIN_QUERY_ONLY_TABLES` 一致").toEqual(
      [...DOMAIN_QUERY_ONLY_TABLES].sort(),
    );
    expect(onDemand, "本波的表必须在里面（写/删要直达引擎）").toContain(TABLE);
    void store;
  });

  it("TFC-7c: 一屏投影列与 port 侧声明的**列契约**一致（同一条 `patch` 例外）", async () => {
    const { TURN_FILE_CHANGE_WINDOW_COLUMNS } = await freshStorage();
    const src = (await import("node:fs")).readFileSync("src/core/storage/rust-port.ts", "utf8");
    const block = src.match(/turn_file_changes: \[([\s\S]*?)\]/);
    expect(block, "`DOMAIN_COLUMN_PROJECTION.turn_file_changes` 必须还在（它是列契约的唯一声明）").not.toBeNull();
    const portCols = [...block![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect([...TURN_FILE_CHANGE_WINDOW_COLUMNS], "两处必须逐字一致").toEqual(portCols);
    expect(portCols, "两处都必须排除 patch 正文").not.toContain("patch");
  });

  it("TFC-8: **显式**要求加载它也不会进镜像（结构结论，不是「这次没超」）", async () => {
    const { FileChangeStorage } = await freshStorage();
    const { port, calls } = await withPort({ [TABLE]: [row({ id: "a", turn_index: 1 })] });

    /** 任何调用点（预取 ✓ / `domainMirror` 的惰性加载 ✓ / 将来新写的 ✓）都只能到这里 ✓ */
    port.domains.ensureLoaded(TABLE);
    await settle();

    expect(port.domains.isReady(TABLE), "结构性排除 ⇒ 永远不就绪").toBe(false);
    expect(
      calls.filter((c) => c.command === "crud.list" && c.params.table === TABLE),
      "连一页都不许拉（拉了就是又回到「整表镜像」那条路 ✗）",
    ).toEqual([]);
    /**
     * 而**按需读照样能读到** ✓ —— 这一条是「排除镜像」与「功能不可用」的分界 ✓：
     * 前者是本波的目的 ✓，后者正是用户报的那个 bug ✗。
     */
    expect((await FileChangeStorage.loadBySession("s1")).map((r) => r.id)).toEqual(["a"]);
    expect(
      failures.filter((n) => n.includes("超过镜像上限")),
      "结构上不可能再产生这条报障",
    ).toEqual([]);
  });
});
