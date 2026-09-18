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
 *
 * FID-3 还是行构造器门禁（`tools/audit/check-row-builders.mjs`）的**前提**：
 * 那条门禁说"构造器漏列在 insert 路径上是静默 NULL"，这个前提必须能在渲染侧被执行验证，
 * 而不是只写在注释里。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

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
});
