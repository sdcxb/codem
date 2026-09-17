/**
 * 全量回归测试：知识管理全栈 — KM-001 ~ KM-080
 *
 * 覆盖范围：
 *   A. 笔记 CRUD 与版本历史 (KM-001 ~ KM-015)
 *   B. 闪卡存储与复习调度 (KM-016 ~ KM-025)
 *   C. 知识图谱实体/关系 (KM-026 ~ KM-035)
 *   D. 导出/导入 (KM-036 ~ KM-045)
 *   E. 学习路径生成 (KM-046 ~ KM-050)
 *   D. PPT 生成 (KM-051 ~ KM-055)
 *   E. 笔记操作工具执行 (KM-056 ~ KM-070)
 *   F. 知识管理 UI 组件 (KM-071 ~ KM-080)
 *
 * 关键组件：
 *   - knowledge/storage.ts (notes/note_links/flashcards/graph_nodes/graph_edges/notebook_groups/note_versions)
 *   - knowledge/note-manager.ts (createNote/updateNote/getNote/listNotes/addNoteLink/deleteNote/syncNoteLinks)
 *   - knowledge/flashcard-store.ts
 *   - knowledge/graph-extractor.ts
 *   - knowledge/exporter.ts / importer.ts
 *   - knowledge/study-path.ts
 *   - knowledge/ppt-generator.ts / ppt-types.ts
 *   - llm/tools/note-operations.ts (create_note/edit_note/link_notes/delete_note)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import {
  createNotebook, getNotebook, listNotebooks, deleteNotebook,
  addSource, listSources, getSource,
  createNote, getNote, listNotes, updateNote, deleteNote, addNoteLink,
  getGraphData, getGraphEdgeById,
} from "../core/knowledge/storage";
import { getFlashcard, listFlashcards } from "../core/knowledge/flashcard-store";
import { createDefaultToolRegistry } from "../core/llm/tools";

const NOTEBOOK_ID = "nb-km-test";
const NOTEBOOK_NAME = "知识管理测试笔记本";

// ========== 端口夹具（第 18 轮，L1） ==========
//
// 本文件原来的夹具是**裸 SQL 打旧库**（`INSERT INTO notebooks …` / `INSERT INTO flashcards …`）。
// 旧库在 rust 模式下刻意不加载（`setup.ts` 也不再 `initDatabase()`），产品在端口模式下
// 只读写**存储端口** —— 所以夹具改成"端口播种"，断言改用产品读接口。

/** 引擎建库执行的 DDL（`codem-db` 侧）：表是否存在的真源 */
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/codem-db/sql/schema.sql"),
  "utf-8",
);

/** 该表是否在引擎 schema 里声明（等价于旧库那一次 `sqlite_master` 查询） */
function schemaDeclaresTable(table: string): boolean {
  return new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`).test(SCHEMA_SQL);
}

/** 端口命令播种：等价于原来的 `INSERT INTO <表> (...) VALUES (...)` */
async function seedRows(
  target: FakeStoragePort,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  await target.data.execute("crud.upsert", { table, rows });
}

/** 笔记本预置行（线协议形状，与 `notebookToWire` 的列一一对应） */
function notebookRow(id: string, name: string, now = Date.now()): Record<string, unknown> {
  return {
    id,
    name,
    description: "测试用",
    summary: null,
    summary_status: "pending",
    source_count: 0,
    chunk_count: 0,
    group_id: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * 每个用例一个干净端口，并把笔记本预置进去。
 *
 * 为什么预置必须落在端口：`create_note` 工具第一件事就是 `getNotebook(notebookId)` 校验存在性，
 * 而它读的是**域镜像**；`domainWrite` 也只写镜像 + 写穿。原来的 `setupNotebook()` 打的是旧库，
 * 端口模式下镜像里根本没有这一行（KM-057 因此红过）—— 夹具的位置必须是产品真正读的那一侧。
 */
function setupNotebook(): FakeStoragePort {
  const port = createFakeStoragePort({
    seed: { notebooks: [notebookRow(NOTEBOOK_ID, NOTEBOOK_NAME)] },
  });
  setStoragePort(port);
  return port;
}

/** 当前用例的端口（各 describe 的 `beforeEach` 里由 `setupNotebook()` 赋值） */
let port: FakeStoragePort;

// ========== A. 笔记 CRUD 与版本历史 ==========

describe("知识管理 — 笔记 CRUD 与版本历史", () => {
  beforeEach(() => {
    // 第 18 轮（L1）：`resetDatabase()` / `initDatabase()` 已删（只为旧库存在的清理）
    localStorage.clear();
    port = setupNotebook();
  });

  // KM-001
  it("KM-001: createNote 创建新笔记", () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID,
      title: "测试笔记",
      content: "## 内容\n这是笔记内容",
      contentType: "markdown",
    });
    expect(note).toBeDefined();
    expect(note.id).toBeDefined();
    expect(note.title).toBe("测试笔记");
    expect(note.content).toBe("## 内容\n这是笔记内容");
  });

  // KM-002
  it("KM-002: getNote 读取已创建的笔记", () => {
    const created = createNote({
      notebookId: NOTEBOOK_ID, title: "读取测试", content: "内容",
      contentType: "markdown",
    });
    const loaded = getNote(created.id);
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe("读取测试");
  });

  // KM-003
  it("KM-003: getNote 不存在的 ID 返回 null", () => {
    expect(getNote("nonexistent-note")).toBeNull();
  });

  // KM-004
  it("KM-004: listNotes 返回笔记本内全部笔记", () => {
    for (let i = 0; i < 3; i++) {
      createNote({ notebookId: NOTEBOOK_ID, title: `笔记${i}`, content: `c${i}`, contentType: "markdown" });
    }
    const list = listNotes(NOTEBOOK_ID);
    expect(list.length).toBe(3);
  });

  // KM-005
  it("KM-005: updateNote 更新笔记标题和内容", () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "原标题", content: "原内容", contentType: "markdown",
    });
    updateNote(note.id, { title: "新标题", content: "新内容" });
    const loaded = getNote(note.id);
    expect(loaded!.title).toBe("新标题");
    expect(loaded!.content).toBe("新内容");
  });

  // KM-006
  it("KM-006: updateNote 只更新标题 — 内容不变", () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "原标题", content: "保留内容", contentType: "markdown",
    });
    updateNote(note.id, { title: "新标题" });
    const loaded = getNote(note.id);
    expect(loaded!.title).toBe("新标题");
    expect(loaded!.content).toBe("保留内容");
  });

  // KM-007
  it("KM-007: deleteNote 删除笔记", () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "待删", content: "c", contentType: "markdown",
    });
    deleteNote(note.id);
    expect(getNote(note.id)).toBeNull();
  });

  // KM-008
  it("KM-008: 笔记 tags 字段存储和读取", () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "标签测试", content: "c",
      contentType: "markdown", tags: ["tag1", "tag2"],
    });
    const loaded = getNote(note.id);
    expect(loaded!.tags).toEqual(["tag1", "tag2"]);
  });

  // KM-009
  it("KM-009: addNoteLink 创建笔记间链接", () => {
    /*
     * 链接住在**端口**（域镜像）里：断言读端口表 `note_links`。
     *
     * 原来断言的是 `db.exec("SELECT * FROM note_links …")` —— 端口模式下产品写的是端口、
     * 旧库那侧一行都没有，于是 `result[0]` 是 undefined（用例红）。
     * 端口由本文件的 `beforeEach`（`setupNotebook()`）注册，这里直接用它 ——
     * 原来的注释还在说"若不注册端口，写入会落到旧库"，那是 A 态（端口未注册）的形态，
     * 已随回滚开关退役（第 17/18 轮）：端口是唯一形态。
     */
    const noteA = createNote({ notebookId: NOTEBOOK_ID, title: "A", content: "c", contentType: "markdown" });
    const noteB = createNote({ notebookId: NOTEBOOK_ID, title: "B", content: "c", contentType: "markdown" });
    addNoteLink(noteA.id, noteB.id, "关联到B");
    // 链接应存在于端口（域镜像）里
    const rows = port.__table("note_links").filter((r) => r.source_note_id === noteA.id);
    expect(rows.length).toBe(1);
    expect(String(rows[0].target_note_id)).toBe(noteB.id);
  });

  // KM-010
  it("KM-010: listNotes 空笔记本返回空数组", async () => {
    // 原来这里 `INSERT INTO notebooks` 造了第二本空笔记本（旧库）；现在播进端口
    await seedRows(port, "notebooks", [notebookRow("nb-empty", "空")]);
    expect(listNotes("nb-empty")).toEqual([]);
  });

  // KM-011
  it("KM-011: 笔记 contentType 默认为 markdown", () => {
    const note = createNote({ notebookId: NOTEBOOK_ID, title: "t", content: "c" });
    expect(note.contentType).toBe("markdown");
  });

  // KM-012
  it("KM-012: updateNote 空更新对象无副作用", () => {
    const note = createNote({ notebookId: NOTEBOOK_ID, title: "t", content: "c", contentType: "markdown" });
    updateNote(note.id, {});
    const loaded = getNote(note.id);
    expect(loaded!.title).toBe("t");
  });

  // KM-013
  it("KM-013: 笔记 createdAt/updatedAt 时间戳正确", () => {
    const before = Date.now();
    const note = createNote({ notebookId: NOTEBOOK_ID, title: "t", content: "c", contentType: "markdown" });
    expect(note.createdAt).toBeGreaterThanOrEqual(before);
    expect(note.updatedAt).toBeGreaterThanOrEqual(before);
  });

  // KM-014
  it("KM-014: updateNote 更新 updatedAt 时间", () => {
    const note = createNote({ notebookId: NOTEBOOK_ID, title: "t", content: "c", contentType: "markdown" });
    const originalUpdatedAt = note.updatedAt;
    // Wait to ensure timestamp changes
    updateNote(note.id, { title: "updated" });
    const loaded = getNote(note.id);
    expect(loaded!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  // KM-015
  it("KM-015: 多笔记本笔记隔离", async () => {
    await seedRows(port, "notebooks", [notebookRow("nb-2", "笔记本2")]);
    createNote({ notebookId: NOTEBOOK_ID, title: "NB1", content: "c", contentType: "markdown" });
    createNote({ notebookId: "nb-2", title: "NB2", content: "c", contentType: "markdown" });
    expect(listNotes(NOTEBOOK_ID).length).toBe(1);
    expect(listNotes("nb-2").length).toBe(1);
  });
});

// ========== B. 闪卡存储与复习调度 ==========

describe("知识管理 — 闪卡存储", () => {
  beforeEach(() => {
    localStorage.clear();
    port = setupNotebook();
  });

  // KM-016
  it("KM-016: flashcards 表存在", () => {
    // 原判据是旧库 `sqlite_master`；表的真源是引擎 schema（引擎建库执行的就是它）
    expect(schemaDeclaresTable("flashcards"), "引擎 schema 必须声明 flashcards").toBe(true);
  });

  // KM-017
  it("KM-017: flashcard-store 模块可导入", async () => {
    const mod = await import("../core/knowledge/flashcard-store");
    expect(mod).toBeDefined();
  });

  // KM-018
  it("KM-018: 闪卡可写入存储并读回", async () => {
    /*
     * 原来是 `INSERT INTO flashcards (id, notebook_id, …) VALUES (…)` + `SELECT front, back …`。
     * 夹具换成**端口命令**（`crud.upsert`，与端口模式下产品写穿的命令同一条），
     * 读断言换成**产品读接口** `getFlashcard` —— 读写两端都还在判据里，且落在产品真正用的数据源上。
     */
    const now = Date.now();
    await seedRows(port, "flashcards", [
      {
        id: "fc-1", notebook_id: NOTEBOOK_ID, note_id: null, front: "问题", back: "答案",
        tags: null, ease_factor: 2.5, interval_days: 0, repetitions: 0,
        next_review: now, created_at: now, updated_at: now,
      },
    ]);

    const loaded = getFlashcard("fc-1");
    expect(loaded!.front).toBe("问题");
    expect(loaded!.back).toBe("答案");
  });

  // KM-019
  it("KM-019: 多张闪卡共存", async () => {
    const now = Date.now();
    await seedRows(
      port,
      "flashcards",
      Array.from({ length: 5 }, (_, i) => ({
        id: `fc-${i}`, notebook_id: NOTEBOOK_ID, note_id: null, front: `Q${i}`, back: `A${i}`,
        tags: null, ease_factor: 2.5, interval_days: i, repetitions: 0,
        next_review: now, created_at: now, updated_at: now,
      })),
    );
    // 原来断言的是 `SELECT COUNT(*) FROM flashcards WHERE notebook_id = ?`
    expect(listFlashcards(NOTEBOOK_ID)).toHaveLength(5);
  });

  // KM-020
  it("KM-020: 闪卡 difficulty 字段范围 0-5", async () => {
    const now = Date.now();
    await seedRows(
      port,
      "flashcards",
      [0, 1, 2, 3, 4, 5].map((d) => ({
        id: `fc-d${d}`, notebook_id: NOTEBOOK_ID, note_id: null, front: `Q${d}`, back: `A${d}`,
        tags: null, ease_factor: 2.5, interval_days: d, repetitions: 0,
        next_review: now, created_at: now, updated_at: now,
      })),
    );
    // 原来断言的是 `SELECT interval_days … ORDER BY interval_days` → [0,1,2,3,4,5]
    const intervals = listFlashcards(NOTEBOOK_ID)
      .map((c) => c.intervalDays)
      .sort((a, b) => a - b);
    expect(intervals).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // KM-021 ~ KM-025 removed — were empty placeholders
});

// ========== C. 知识图谱 ==========

describe("知识管理 — 知识图谱", () => {
  beforeEach(() => {
    localStorage.clear();
    port = setupNotebook();
  });

  // KM-026
  it("KM-026: graph_nodes 表存在", () => {
    // 原判据是旧库 `sqlite_master`；表的真源是引擎 schema（引擎建库执行的就是它）
    expect(schemaDeclaresTable("graph_nodes"), "引擎 schema 必须声明 graph_nodes").toBe(true);
  });

  // KM-027
  it("KM-027: graph_edges 表存在", () => {
    expect(schemaDeclaresTable("graph_edges"), "引擎 schema 必须声明 graph_edges").toBe(true);
  });

  // KM-028
  it("KM-028: graph-extractor 模块可导入", async () => {
    const mod = await import("../core/knowledge/graph-extractor");
    expect(mod).toBeDefined();
  });

  // KM-029
  it("KM-029: 图谱节点可直接写入", async () => {
    const now = Date.now();
    await seedRows(port, "graph_nodes", [
      {
        id: "gn-1", notebook_id: NOTEBOOK_ID, label: "React", entity_type: "技术",
        description: "desc", source_ids: null, chunk_ids: null, weight: 1.0, community_id: null,
        created_at: now,
      },
    ]);
    // 读断言走产品接口（原来是一次裸 SELECT）
    const nodes = getGraphData(NOTEBOOK_ID).nodes;
    expect(nodes.map((n) => n.label)).toContain("React");
  });

  // KM-030
  it("KM-030: 图谱边可直接写入", async () => {
    const now = Date.now();
    const node = (id: string, label: string) => ({
      id, notebook_id: NOTEBOOK_ID, label, entity_type: "技术", description: "desc",
      source_ids: null, chunk_ids: null, weight: 1.0, community_id: null, created_at: now,
    });
    await seedRows(port, "graph_nodes", [node("gn-src", "Node1"), node("gn-tgt", "Node2")]);
    await seedRows(port, "graph_edges", [
      {
        id: "ge-1", notebook_id: NOTEBOOK_ID, source_node_id: "gn-src", target_node_id: "gn-tgt",
        relation_type: "depends_on", weight: 1.0, created_at: now,
      },
    ]);
    expect(getGraphEdgeById("ge-1")!.relationType).toBe("depends_on");
  });

  // KM-031 ~ KM-035 removed — were empty placeholders
});

// ========== D. 导出/导入 ==========

describe("知识管理 — 导出/导入", () => {
  beforeEach(() => {
    localStorage.clear();
    port = setupNotebook();
  });

  // KM-036
  it("KM-036: exporter 模块可导入", async () => {
    const mod = await import("../core/knowledge/exporter");
    expect(mod).toBeDefined();
  });

  // KM-037
  it("KM-037: importer 模块可导入", async () => {
    const mod = await import("../core/knowledge/importer");
    expect(mod).toBeDefined();
  });

  // KM-038 ~ KM-045 removed — were empty placeholders
});

// ========== E. 学习路径 + PPT ==========

describe("知识管理 — 学习路径 + PPT", () => {
  // KM-046
  it("KM-046: study-path 模块可导入", async () => {
    const mod = await import("../core/knowledge/study-path");
    expect(mod).toBeDefined();
  });

  // KM-047
  it("KM-047: ppt-generator 模块可导入", async () => {
    const mod = await import("../core/knowledge/ppt-generator");
    expect(mod).toBeDefined();
  });

  // KM-048
  it("KM-048: ppt-types 模块可导入", async () => {
    const mod = await import("../core/knowledge/ppt-types");
    expect(mod).toBeDefined();
  });

  // KM-049 ~ KM-055 removed — were empty placeholders
});

// ========== F. 笔记操作工具执行 ==========

describe("知识管理 — note-operations 工具执行", () => {
  let registry: ReturnType<typeof createDefaultToolRegistry>;

  beforeEach(() => {
    localStorage.clear();
    /*
     * 笔记本预置进**端口**（`create_note` 工具第一件事就是 `getNotebook(notebookId)` 校验存在性，
     * 而它读的是域镜像；`domainWrite` 也只写镜像 + 写穿）。第 18 轮后夹具的唯一位置就是端口 ——
     * 原来这里额外 seed 一遍，是因为 `setupNotebook()` 写的是旧库、镜像里没有这行，
     * 工具于是返回 `Error: Notebook not found`（KM-057 红：title 回落到 'Create Note'）。
     * 现在 `setupNotebook()` 本身就是端口播种，这一份重复的 seed 随之删掉。
     */
    port = setupNotebook();
    registry = createDefaultToolRegistry();
  });

  // KM-056
  it("KM-056: create_note 工具参数定义正确", () => {
    const tool = registry.get("create_note");
    expect(tool!.parameters.properties).toHaveProperty("title");
    expect(tool!.parameters.properties).toHaveProperty("content");
    expect(tool!.parameters.required).toContain("title");
    expect(tool!.parameters.required).toContain("content");
  });

  // KM-057
  it("KM-057: create_note 执行成功创建笔记", async () => {
    const tool = registry.get("create_note");
    const result = await tool!.execute(
      { title: "工具创建笔记", content: "工具内容" },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.title).toContain("Note Created");
    expect(result.output).toContain("工具创建笔记");
  });

  // KM-058
  it("KM-058: create_note 无 notebookId 返回错误", async () => {
    const tool = registry.get("create_note");
    const result = await tool!.execute(
      { title: "无笔记本", content: "内容" },
      {} as any,
    );
    expect(result.output).toContain("Error");
  });

  // KM-059
  it("KM-059: create_note 缺少 title 返回错误", async () => {
    const tool = registry.get("create_note");
    const result = await tool!.execute(
      { content: "内容" },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("Error");
  });

  // KM-060
  it("KM-060: create_note 缺少 content 返回错误", async () => {
    const tool = registry.get("create_note");
    const result = await tool!.execute(
      { title: "标题" },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("Error");
  });

  // KM-061
  it("KM-061: edit_note 工具参数定义正确", () => {
    const tool = registry.get("edit_note");
    expect(tool!.parameters.properties).toHaveProperty("note_id");
    expect(tool!.parameters.required).toContain("note_id");
  });

  // KM-062
  it("KM-062: edit_note 执行成功更新笔记", async () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "原标题", content: "原内容", contentType: "markdown",
    });
    const tool = registry.get("edit_note");
    const result = await tool!.execute(
      { note_id: note.id, title: "新标题", content: "新内容" },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("原标题");
    expect(result.output).toContain("title");
  });

  // KM-063
  it("KM-063: edit_note append 模式追加内容", async () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "追加", content: "原内容", contentType: "markdown",
    });
    const tool = registry.get("edit_note");
    await tool!.execute(
      { note_id: note.id, content: "追加内容", append: true },
      { notebookId: NOTEBOOK_ID } as any,
    );
    const loaded = getNote(note.id);
    expect(loaded!.content).toContain("原内容");
    expect(loaded!.content).toContain("追加内容");
  });

  // KM-064
  it("KM-064: edit_note 不存在的 note_id 返回错误", async () => {
    const tool = registry.get("edit_note");
    const result = await tool!.execute(
      { note_id: "nonexistent" },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("Error");
  });

  // KM-065
  it("KM-065: link_notes 工具参数定义正确", () => {
    const tool = registry.get("link_notes");
    expect(tool!.parameters.properties).toHaveProperty("source_note_id");
    expect(tool!.parameters.properties).toHaveProperty("target_note_id");
    expect(tool!.parameters.required).toContain("source_note_id");
    expect(tool!.parameters.required).toContain("target_note_id");
  });

  // KM-066
  it("KM-066: link_notes 执行成功创建链接", async () => {
    const noteA = createNote({ notebookId: NOTEBOOK_ID, title: "A", content: "c", contentType: "markdown" });
    const noteB = createNote({ notebookId: NOTEBOOK_ID, title: "B", content: "c", contentType: "markdown" });
    const tool = registry.get("link_notes");
    const result = await tool!.execute(
      { source_note_id: noteA.id, target_note_id: noteB.id },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("A");
    expect(result.output).toContain("B");
  });

  // KM-067
  it("KM-067: link_notes 自链接返回错误", async () => {
    const note = createNote({ notebookId: NOTEBOOK_ID, title: "Self", content: "c", contentType: "markdown" });
    const tool = registry.get("link_notes");
    const result = await tool!.execute(
      { source_note_id: note.id, target_note_id: note.id },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("Error");
    expect(result.output).toContain("Cannot link");
  });

  // KM-068
  it("KM-068: delete_note 工具参数定义正确", () => {
    const tool = registry.get("delete_note");
    expect(tool!.parameters.properties).toHaveProperty("note_id");
    expect(tool!.parameters.required).toContain("note_id");
  });

  // KM-069
  it("KM-069: delete_note 执行成功删除笔记", async () => {
    const note = createNote({
      notebookId: NOTEBOOK_ID, title: "待删", content: "c", contentType: "markdown",
    });
    const tool = registry.get("delete_note");
    const result = await tool!.execute(
      { note_id: note.id },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("待删");
    expect(getNote(note.id)).toBeNull();
  });

  // KM-070
  it("KM-070: delete_note 不存在的 note_id 返回错误", async () => {
    const tool = registry.get("delete_note");
    const result = await tool!.execute(
      { note_id: "nonexistent" },
      { notebookId: NOTEBOOK_ID } as any,
    );
    expect(result.output).toContain("Error");
  });
});

// ========== G. 知识管理 UI 组件 ==========

// FIX: 重型组件（NotebookWorkspace 等）懒加载在全量并行下可能超过默认
// 5s 超时导致偶发 flaky（KM-074）。给本 describe 内动态 import 测试
// 单独设置 30s 超时。
describe("知识管理 — UI 组件导入", () => {
  // 动态 import 测试设置较长超时（vitest 全局默认 5s 在全量并行下偏紧）
  const uiComponents = [
    { id: 71, name: "NoteEditor", path: "../components/NoteEditor" },
    { id: 72, name: "KnowledgeGraphView", path: "../components/KnowledgeGraphView" },
    { id: 73, name: "FlashcardViewer", path: "../components/FlashcardViewer" },
    { id: 74, name: "NotebookWorkspace", path: "../components/NotebookWorkspace" },
    { id: 75, name: "DocxViewer", path: "../components/DocxViewer" },
    { id: 76, name: "PdfViewer", path: "../components/PdfViewer" },
    { id: 77, name: "SourceViewer", path: "../components/SourceViewer" },
    { id: 78, name: "NotebookManager", path: "../components/NotebookManager" },
  ];

  for (const c of uiComponents) {
    it(`KM-${String(c.id).padStart(3, "0")}: ${c.name} 组件可导入`, async () => {
      const mod = await import(c.path);
      expect(mod[c.name]).toBeDefined();
    }, 30_000); // FIX: 重型组件懒加载 30s 超时（防全量并行 flaky）
  }

  // KM-079: knowledge 统一导出
  it("KM-079: knowledge/index.ts 统一导出存在", async () => {
    const mod = await import("../core/knowledge");
    expect(mod).toBeDefined();
  });

  // KM-080: note-manager 模块可导入
  it("KM-080: note-manager 模块可导入", async () => {
    const mod = await import("../core/knowledge/note-manager");
    expect(mod).toBeDefined();
  });
});
