/**
 * 假端口与**真引擎**的语义必须逐条对齐（第 54 轮立）
 *
 * ## 为什么值得单独一个文件
 *
 * 测试基座比真实现**宽松**会漏掉缺陷（"测试里永远成功、真机上必然报错"），
 * 比真实现**严格**则会**造出产品里不存在的缺陷** —— 后者在第 54 轮真的发生过：
 * `fake-storage-port.ts` 把 `mode: "replace"` 写成了整行替换，而引擎是
 * "先 UPDATE 只写本次提供的列，0 行才 INSERT"（`crud.rs:412-429`），
 * 于是"改名会把 `sessions.parent_id` 清成 NULL"这个结论、用例与注释
 * 全部建立在基座的偏差上（自查发现后撤回，见 `session-lineage-preserved.test.ts` 文件头）。
 *
 * 所以这里把三条**基座必须复刻**的引擎语义写成断言：
 *
 * | 语义 | 引擎真源 | 本文件 |
 * | --- | --- | --- |
 * | `replace` 只写提供的列，未提供的列**保持原值** | `crud.rs:412-429` + 引擎用例 `crud_upsert_replace_does_not_cascade_delete_children` | FID-1 |
 * | `insert` 是裸 INSERT：**同一行写第二次撞主键** | `crud.rs:518-527` | FID-2 |
 * | `insert` 建的新行 = **构造器给出的列**（漏列即 NULL） | 同上（`crud.rs` 的 `INSERT INTO … VALUES`） | FID-3 |
 * | 设置面**未预热**时 `get` 返回兜底值（不是"键不存在"） | `rust-port.ts:762-771`（`UNAVAILABLE: 配置面尚未预热`） | FID-4 |
 *
 * FID-3 还是行构造器门禁（`tools/audit/check-row-builders.mjs`）的**前提**：
 * 那条门禁说"构造器漏列在 insert 路径上是静默 NULL"，这个前提必须能在渲染侧被执行验证，
 * 而不是只写在注释里。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { RustStoragePort, type StorageTransport } from "../core/storage/rust-port";

/**
 * 记录型 transport：`RustStoragePort` 的这一半是**真实现**（真端口代码），
 * 只是把 IPC 换成一个记账函数 —— 于是"替身 vs 真端口"可以在同一个进程里逐条对比。
 */
function recordingTransport(calls: string[]): StorageTransport {
  return {
    invokeCommand: async (command: string) => {
      calls.push(command);
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
}

let port: FakeStoragePort;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  port = createFakeStoragePort({
    seed: {
      sessions: [
        {
          id: "s1",
          project_id: "p1",
          title: "原标题",
          created_at: 1,
          last_message_at: 1,
          message_count: 0,
          pinned: 0,
          sort_order: 0,
          parent_id: "ancestor-1",
        },
      ],
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FID：假端口 = 引擎语义（双向都不许偏）", () => {
  it("FID-1: `replace` 只写提供的列 —— 未提供的列保持原值（引擎两段式 UPDATE）", async () => {
    await port.data.execute("crud.upsert", {
      table: "sessions",
      mode: "replace",
      rows: [{ id: "s1", title: "改过的标题" }],
    });

    const row = port.__table("sessions").find((r) => r.id === "s1")!;
    expect(row.title, "提供的列要写进去").toBe("改过的标题");
    expect(
      row.parent_id,
      "未提供的列必须保持原值（假端口原来整行替换 → 凭空造出「改名清空谱系」的假缺陷）",
    ).toBe("ancestor-1");
    expect(row.project_id, "这条与引擎用例的判据同形：project_id 也不许被清空").toBe("p1");
    expect(row.sort_order, "NULL 是有含义的值，同样不许被清掉").toBe(0);
  });

  it("FID-2: `insert` 是裸 INSERT —— 同一行写第二次必须撞主键（不是幂等 upsert）", async () => {
    const write = () =>
      port.data.execute("crud.upsert", {
        table: "sessions",
        mode: "insert",
        rows: [{ id: "s-new", project_id: "p1", title: "新会话", created_at: 1, last_message_at: 1 }],
      });

    await write();
    await expect(write(), "第二次必须报 CONSTRAINT（真机形态：UNIQUE constraint failed）").rejects.toThrow(
      /UNIQUE|CONSTRAINT/i,
    );
  });

  it("FID-3: `insert` 建出来的行 = 构造器给出的列（漏列即 NULL —— 行构造器门禁的前提）", async () => {
    await port.data.execute("crud.upsert", {
      table: "sessions",
      mode: "insert",
      rows: [{ id: "s-child", project_id: "p1", title: "子会话", created_at: 1, last_message_at: 1 }],
    });

    const row = port.__table("sessions").find((r) => r.id === "s-child")!;
    expect(row.id).toBe("s-child");
    expect(
      row.parent_id ?? null,
      "构造器没给 parent_id ⇒ 这一列就是 NULL（实体里带没带都进不了库）—— " +
        "`ensureSubagentSession` 丢谱系走的就是这条路",
    ).toBeNull();
  });

  it("FID-4: 设置面未预热 ⇒ `get` 返回兜底值并留痕（不许当成「这个键不存在」）", () => {
    const cold = createFakeStoragePort({
      seed: { settings: [{ key: "codem-settings", value: '{"providers":[{"id":"deepseek"}]}' }] },
      settingsWarmed: false,
    });

    expect(cold.config.get("codem-settings", null), "未预热就该拿兜底值（与实现一致）").toBeNull();
    expect(cold.config.stats().warmed, "顺序也要能查出来").toBe(false);
    expect(
      cold.config.stats().failures,
      "必须留痕：返回兜底值的原因是 UNAVAILABLE，不是「没有这个键」",
    ).toBeGreaterThan(0);

    // 预热之后同一份数据要读得到（这一条是 SEAL-12 的前提）
    return cold.config.warmup().then(() => {
      expect(cold.config.get("codem-settings", null)).toContain("deepseek");
      expect(cold.config.stats().warmed).toBe(true);
    });
  });

  /**
   * ★ 第 185 波（复审 I-5）：**写侧**的 warmed 护栏两个端口必须同形。
   *
   * 改前替身 `set` / `setConfirmed` **不看 warmed** 就写并返回 true，而真端口
   * （`rust-port.ts:859-865` / `:926-934`）未预热拒写、`setConfirmed` 返回 false
   * ⇒ `settingsWarmed:false` 时迁移（`migration.ts` 的「复制成功 → 才删源键」）
   * 在替身上**删源键**、在真机上**保留源键**：CI 跑的是与生产**相反**的行为，
   * S4 那条数据丢失防线等于没被钉住。
   *
   * 这条判据把**两个端口**放进同一个用例里逐条对比（不是只断言替身自己）。
   */
  it("FID-5: 设置面未预热 ⇒ 两个端口都拒写、都留痕；预热后都能写", async () => {
    // ---- 真端口（真实现 + 记录型 transport）----
    const calls: string[] = [];
    const real = new RustStoragePort(recordingTransport(calls) as never, () => {});
    real.config.set("k", { a: 1 });
    expect(calls.filter((c) => c === "settings.set"), "真端口未预热不写库").toHaveLength(0);
    expect(await real.config.setConfirmed("k", { a: 1 }), "真端口未预热返回 false（调用方据此不删源键）").toBe(
      false,
    );
    expect(real.config.stats().warmed).toBe(false);
    expect(real.config.stats().failures, "真端口要留痕（不是静默忽略）").toBeGreaterThan(0);

    // ---- 替身：同一批操作必须给出同一组结论 ----
    const cold = createFakeStoragePort({
      seed: { settings: [{ key: "k", value: "old" }] },
      settingsWarmed: false,
    });
    cold.config.set("k2", { a: 1 });
    expect(
      cold.__table("settings").filter((r) => r.key === "k2"),
      "替身未预热同样不许写库（改前无条件写 + 发 crud.upsert）",
    ).toHaveLength(0);
    expect(await cold.config.setConfirmed("k2", { a: 1 }), "替身未预热必须返回 false（改前恒 true）").toBe(false);
    expect(cold.config.stats().warmed).toBe(false);
    expect(cold.config.stats().failures, "替身也要留痕").toBeGreaterThan(0);

    // ---- 反向对照：预热之后两条路径都要能写（不是"永远拒写"）----
    await real.config.warmup();
    expect(await real.config.setConfirmed("k", "v")).toBe(true);
    await cold.config.warmup();
    expect(await cold.config.setConfirmed("k", "v")).toBe(true);
    expect(
      cold.__table("settings").some((r) => r.key === "k"),
      "预热后替身必须真的写进去",
    ).toBe(true);
  });

  /**
   * ★ 第 195 波（GAP-LIST `O-57`）：**消息写入要维护会话的活动时间**，替身必须与引擎同形。
   *
   * 引擎真源：`repo.rs::touch_session_on_message_write`（判据是 Rust 侧的 `LMA-1..4`）——
   * 消息写入的**同一个事务**里 `sessions.last_message_at = MAX(旧值, 这条消息的 timestamp)`，
   * 只增不减。假端口原来**完全不碰**这一列：那是"替身比实现更狭窄"，
   * 后果正是第 192 波记下的那类 —— "写完消息 ⇒ 侧栏顺序跟着走"在 CI 里**结构上不可见**
   * （真机上才会出现"昨天建的会话不排最上面"，因为引擎写入的消息有一大类不经过渲染侧）。
   *
   * 反向对照也在这条里：**更早的 timestamp 不许把它拉回去**（单调性）。
   */
  it("FID-6: 替身与引擎同形 —— `messages.upsert_index` 也要把会话活动时间抬到 `MAX`", async () => {
    const p = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "s-lma", project_id: "p1", title: "t", created_at: 1, last_message_at: 1, message_count: 0, pinned: 0 },
        ],
      },
    });
    const activity = () => Number(p.__table("sessions").find((r) => r.id === "s-lma")?.last_message_at);

    await p.data.execute("messages.upsert_index", {
      id: "m1", session_id: "s-lma", role: "user", content: "a", timestamp: 500,
    });
    expect(activity(), "写一条新消息必须把活动时间抬到它的 timestamp").toBe(500);

    await p.data.execute("messages.upsert_index", {
      id: "m1", session_id: "s-lma", role: "user", content: "a2", timestamp: 300,
    });
    expect(
      activity(),
      "更早的 timestamp（覆盖写）不许把它拉回去 —— 引擎那边是 `MAX(旧值, 消息 timestamp)`",
    ).toBe(500);
  });
});
