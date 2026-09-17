/**
 * 内存端口 + **真引擎的两条语义**（只为直接验证"引擎语义"的用例服务）
 *
 * ## 为什么需要这个文件
 *
 * `fake-storage-port.ts` 是"表即内存行"的替身，它实现了端口**命令层**的语义
 * （`messages.upsert_index` / `messages.delete {soft}` / `crud.upsert` …），
 * 但**没有实现引擎层（SQLite 自己）的两条语义**：
 *
 * 1. `messages_list` 的排序：Rust 侧 `repo.rs:942` 是
 *    `... ORDER BY timestamp ASC, id ASC`；假端口按**插入顺序**返回。
 *    于是"消息按 timestamp 升序"（MSGC-020）这类用例在端口模式下**假红** ——
 *    产品读的是端口给的行，真端口给的本来就是时间序。
 * 2. `PRAGMA foreign_keys=ON`（`engine.rs:87`）下的 `ON DELETE CASCADE`
 *    （`sql/schema.sql`：`sessions.project_id → projects.id`、
 *    `messages.session_id → sessions.id`、`tool_calls.message_id → messages.id` …）。
 *    删父行时子行由**引擎**带走 —— 这正是 `session.ts` 的注释写的
 *    "删 1 个会话会**级联**删掉它的全部消息 / 工具调用 / 事件"。假端口不级联，
 *    于是"项目/会话删除级联清理"（MSGC-014 / STOR-015）在端口模式下**假红**。
 *
 * 这里不发明语义：两条都逐字照抄真实现（上面标了出处），只是把替身补到**与实现等强**。
 * 这符合本项目的一贯判据 —— "测试双不得比实现更宽松"；反过来同样成立：
 * 替身比实现**更严格**也会让用例假红，把人引到不存在的问题上。
 *
 * ## 它不是什么
 *
 * - 不改产品代码：只是换一个更贴近真引擎的测试替身；
 * - 不做"让测试变绿"的兜底：排序与级联都是 SQLite 真会做的事，凡是不该发生的
 *   （例如产品根本没发出 `crud.delete`）这里一行都不会补。
 */

import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort, FakeStoragePortOptions } from "./fake-storage-port";

type Row = Record<string, unknown>;

/**
 * 级联表：`父表 → [子表, 指向父行主键的列]`。
 *
 * 只列出本批用例真正会碰到的链（消息/会话/项目），以及顺着 `sql/schema.sql` 一眼可证的部分。
 * 需要新链时按那里的 `ON DELETE CASCADE` 补即可。
 */
const CASCADE_CHILDREN: Record<string, Array<[string, string]>> = {
  projects: [["sessions", "project_id"]],
  sessions: [
    ["messages", "session_id"],
    ["session_events", "session_id"],
    ["attachments", "session_id"],
    ["message_feedback", "session_id"],
    ["prompt_drafts", "session_id"],
    ["turn_file_changes", "session_id"],
    ["todo_lists", "session_id"],
  ],
  messages: [
    ["tool_calls", "message_id"],
    ["message_feedback", "message_id"],
  ],
  notebooks: [["notes", "notebook_id"]],
  notes: [
    ["note_links", "source_note_id"],
    ["note_links", "target_note_id"],
    ["note_versions", "note_id"],
  ],
};

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

/**
 * 取这一层要级联的父行 id。
 *
 * ⚠️ 不能只扫表：`domain-store` 的删除是**先删本地镜像、再写穿**（`applyDelete` → `execute`），
 * 所以轮到写穿时父行**已经从表里没了**（实测：`projects` 表此时为空，靠扫表只能拿到 0 行，
 * 级联于是静默不发生）。表里查不到时退回用 `where` 里的键值 —— 删除命令本来就是按它定位的。
 */
function resolveParentIds(port: FakeStoragePort, table: string, where: Row): string[] {
  const rows = port.__table(table).filter((row) => matchesWhere(row, where));
  if (rows.length > 0) return rows.map((r) => String(r.id ?? "")).filter((id) => id.length > 0);
  return Object.values(where)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map((v) => String(v))
    .filter((v) => v.length > 0);
}

/**
 * 按 SQLite 的 `ON DELETE CASCADE` 递归带走子行（父行由调用方自己删）。
 *
 * @param writeThrough 假端口**原始**的 `execute`（不经过本文件的包装，避免重复递归）
 */
function cascadeDelete(
  port: FakeStoragePort,
  writeThrough: (command: string, params?: Row) => Promise<{ written: number }>,
  table: string,
  where: Row,
): void {
  const children = CASCADE_CHILDREN[table];
  if (!children) return;
  for (const parentId of resolveParentIds(port, table, where)) {
    for (const [childTable, column] of children) {
      const childWhere: Row = { [column]: parentId };
      // 先处理孙表（此时子行还在，递归能拿到它们的 id），再删子行本身。
      cascadeDelete(port, writeThrough, childTable, childWhere);
      if (port.__table(childTable).some((row) => matchesWhere(row, childWhere))) {
        void writeThrough("crud.delete", { table: childTable, where: childWhere });
      }
    }
  }
}

/**
 * 创建一个"带真引擎语义"的假端口（其余行为与 `createFakeStoragePort` 完全一致）。
 *
 * @param opts 与 `createFakeStoragePort` 相同（`seed` / `neverReady` / `failWrites` …）
 */
export function createRustEngineSemanticsPort(opts: FakeStoragePortOptions = {}): FakeStoragePort {
  const port = createFakeStoragePort(opts);

  // ===== ① 消息列表按 `timestamp ASC, id ASC`（repo.rs:942）=====
  const mirror = (port as unknown as { messages?: { list(sid: string): Row[] } }).messages;
  if (mirror) {
    const insertionOrder = mirror.list.bind(mirror);
    mirror.list = (sessionId: string): Row[] =>
      [...insertionOrder(sessionId)].sort((a, b) => {
        const dt = Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0);
        if (dt !== 0) return dt;
        const ai = String(a.id ?? "");
        const bi = String(b.id ?? "");
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });
  }

  // ===== ② `crud.delete` 走外键级联（engine.rs:87 + schema.sql）=====
  const writeThrough = port.data.execute.bind(port.data);
  port.data.execute = (command: string, params?: Row) => {
    if (command === "crud.delete") {
      cascadeDelete(port, writeThrough, String(params?.table ?? ""), (params?.where as Row | undefined) ?? {});
    }
    return writeThrough(command, params);
  };

  return port;
}
