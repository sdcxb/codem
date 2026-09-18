/**
 * 会话谱系（`sessions.parent_id`）：写侧与读侧各守一条（第 54 轮，**含一次自查撤回**）
 *
 * ## 先说清哪条路真的会丢（这一版是对上一版的更正）
 *
 * 上一版的结论是错的，照抄在这里，配它错在哪：
 *
 * > 「`mode: "replace"` 的语义是 `INSERT OR REPLACE` —— 没给出的列会被写成 NULL。
 * >  于是给分叉出来的会话改个名（或置顶、或拖拽排序），谱系就被清空。」
 *
 * 引擎源码、引擎自己的用例、渲染侧镜像**三条都不支持这句话**：
 *
 * - `crud.rs:412-429`：`replace` **不是** `INSERT OR REPLACE`，而是"先 `UPDATE` 只写本次
 *   提供的列，0 行才 `INSERT`"⇒ **未提供的列保持原值**；
 * - `crud.rs::crud_upsert_replace_does_not_cascade_delete_children`（同文件 769 行）断言的
 *   就是这条："只给 `title` 时 `project_id` 不许被清空"；
 * - 渲染侧内存镜像同语义（`rust-port.ts:2063`：`{ ...list[i], ...row }` 合并写）。
 *
 * 当时唯一"会把列清成 NULL"的是**测试基座**：`fake-storage-port.ts` 的 `replace` 写成了
 * 整行替换（比引擎更狠），于是**假端口造出一个产品里不存在的缺陷**。
 * 基座已按引擎改成合并写（那段理由写在 `fake-storage-port.ts` 里），本文件随之重写。
 * 这个教训与"假端口不能比真实现更宽松"是同一条的两面：**也不能更严格**。
 *
 * ## 真正会丢谱系的那条路（这条修复保留）
 *
 * `createSession` 走的是 `domainWrite` 的**默认 `mode: "insert"`** ⇒ 引擎侧是裸
 * `INSERT INTO`，落库的那一行**就是构造器给出的那些列**。于是"构造器漏列"在 insert 路径上
 * 是**静默 NULL**：实体里明明带着 `parentId`，库里却是 NULL，不报错、不告警。
 *
 * 第 45 轮给子智能体补 `sessions` 行时正是这个形态（`ensureSubagentSession` 建行没写谱系）
 * —— 于是子会话在 `session_trace` 里永远报 `Parent: (root)`、队长会话的 `Descendants: []`。
 *
 * ## 判据（每条对应一条真实写入路径）
 *
 * | 操作 | 走哪条模式 | `parent_id` 必须 |
 * | --- | --- | --- |
 * | `forkSession`（建子会话行） | replace（行不存在 → INSERT） | 等于源会话 id |
 * | `createSession`（实体带 `parentId`） | **insert** | 等于实体里的 `parentId`（**靠构造器写**） |
 * | `updateSession` / `togglePinned` / `reorderSessions` | replace | 保持原值（引擎保证；构造器现在也写它） |
 * | 根会话（没有父） | 任意 | 显式 `null` |
 * | `getSession` 读回 | — | 映射出 `parentId`（读侧不漏） |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const PROJECT = "p-lineage";
const SOURCE = "sess-lineage-source";
const CHILD = "sess-lineage-child";

let port: FakeStoragePort;

/** 该会话在**索引行**里的 `parent_id`（null / 字符串 / "缺列" 三种情况要分得开） */
function parentIdOf(id: string): string | null | "(no-row)" {
  const row = port.__table("sessions").find((r) => r.id === id);
  if (!row) return "(no-row)";
  const v = row.parent_id;
  return v === undefined || v === null ? null : String(v);
}

/** 该行里"有没有这个键"（insert 路径上缺键 = 落库就是 NULL，与显式 null 同效但成因不同） */
function hasParentKey(id: string): boolean {
  const row = port.__table("sessions").find((r) => r.id === id);
  return !!row && Object.prototype.hasOwnProperty.call(row, "parent_id");
}

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  port = createFakeStoragePort({
    seed: {
      sessions: [
        {
          id: SOURCE,
          project_id: PROJECT,
          title: "源会话",
          created_at: 1,
          last_message_at: 2,
          message_count: 3,
          pinned: 0,
          sort_order: 0,
        },
      ],
      messages: [],
    },
  });
  // 让域镜像就绪（写路径要它接手，否则会走"如实上报"分支而不是真写）
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("sessions");
  await new Promise((r) => setTimeout(r, 20));
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("LINEAGE：谱系的写侧与读侧", () => {
  it("LINEAGE-1: fork 建子会话行时就写下谱系（行不存在 → insert 那一半）", async () => {
    const { forkSession } = await import("../core/storage/session");

    const child = forkSession(SOURCE, CHILD, PROJECT, "子会话");
    expect(child, "前置：fork 应当成功").toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));

    expect(parentIdOf(CHILD), "fork 必须写 parent_id（谱系的唯一直接来源）").toBe(SOURCE);
    expect(hasParentKey(CHILD), "而且必须是**显式**写下的（不是靠引擎兜底）").toBe(true);
  });

  it("LINEAGE-2: `createSession` 是 insert 模式 —— 实体带着 parentId 就必须落库（构造器漏列 = 静默 NULL）", async () => {
    /**
     * 这条守的是**真正会丢谱系的那条路**：`createSession` → `domainWrite`（默认 insert）
     * → 引擎裸 `INSERT INTO`，落库行 = 构造器给的列。
     * 所以判据落在**构造器**上：`sessionToWire` 不写 `parent_id` ⇒ 这一列永远是 NULL。
     *
     * 有牙的检查方式：把 `sessionToWire` 里的 `parent_id: s.parentId ?? null` 删掉，
     * 本用例必须变红（见本轮实测记录）。
     */
    const { createSession } = await import("../core/storage/session");

    createSession({
      id: CHILD,
      projectId: PROJECT,
      title: "直接建出来的子会话",
      createdAt: 10,
      lastMessageAt: 10,
      messageCount: 0,
      pinned: false,
      parentId: SOURCE,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(
      parentIdOf(CHILD),
      "insert 模式下构造器漏掉 parent_id 就是静默 NULL —— 实体里的谱系必须落库",
    ).toBe(SOURCE);
  });

  it("LINEAGE-3: 改名 / 置顶 / 排序之后谱系保持不变（引擎的 replace 保留未提供的列，构造器也显式写它）", async () => {
    /**
     * ⚠️ 读这个用例的人请注意：**这条保证主要来自引擎**（`replace` = 只写提供的列），
     * 构造器显式写 `parent_id` 是第二重保险。上一版把这条写成了"构造器漏列就会清空"，
     * 那是错的（见文件头）。
     */
    const { forkSession, updateSession, togglePinned, reorderSessions } = await import(
      "../core/storage/session"
    );

    forkSession(SOURCE, CHILD, PROJECT, "子会话");
    await new Promise((r) => setTimeout(r, 20));
    expect(parentIdOf(CHILD), "前置：fork 写下了谱系").toBe(SOURCE);

    updateSession(CHILD, { title: "改过名的子会话" });
    await new Promise((r) => setTimeout(r, 20));
    expect(parentIdOf(CHILD), "改名之后谱系必须还在").toBe(SOURCE);

    togglePinned(CHILD);
    await new Promise((r) => setTimeout(r, 20));
    expect(parentIdOf(CHILD), "置顶之后谱系必须还在").toBe(SOURCE);

    reorderSessions(PROJECT, [CHILD, SOURCE]);
    await new Promise((r) => setTimeout(r, 20));
    expect(parentIdOf(CHILD), "拖拽排序之后谱系必须还在").toBe(SOURCE);
  });

  it("LINEAGE-4: 读侧必须把 `parent_id` 映射出来（写对读不出 = 谱系工具仍只报 root）", async () => {
    const { forkSession, getSession } = await import("../core/storage/session");

    forkSession(SOURCE, CHILD, PROJECT, "子会话");
    await new Promise((r) => setTimeout(r, 20));

    expect(getSession(CHILD)?.parentId, "`wireToSession` 必须读 parent_id").toBe(SOURCE);
    expect(getSession(SOURCE)?.parentId, "根会话读出来是 null（不是 undefined 混在一起）").toBeNull();
  });

  it("LINEAGE-5: 根会话写回时 parent_id 是**显式 null**（不是「漏了键」）", async () => {
    const { updateSession } = await import("../core/storage/session");

    updateSession(SOURCE, { title: "根会话改名" });
    await new Promise((r) => setTimeout(r, 20));

    expect(hasParentKey(SOURCE), "键必须在（显式 null 表示「没有父」，缺键是另一种成因）").toBe(true);
    expect(parentIdOf(SOURCE)).toBeNull();
  });
});
