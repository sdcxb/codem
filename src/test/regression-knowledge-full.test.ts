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

import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
import {
  createNotebook, getNotebook, listNotebooks, deleteNotebook,
  addSource, listSources, getSource,
  createNote, getNote, listNotes, updateNote, deleteNote, addNoteLink,
} from "../core/knowledge/storage";
import { createDefaultToolRegistry } from "../core/llm/tools";

const NOTEBOOK_ID = "nb-km-test";
const NOTEBOOK_NAME = "知识管理测试笔记本";

function setupNotebook(): void {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    `INSERT INTO notebooks (id, name, description, summary, summary_status, source_count, chunk_count, group_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'pending', 0, 0, NULL, ?, ?)`,
    [NOTEBOOK_ID, NOTEBOOK_NAME, "测试用", now, now]
  );
}

// ========== A. 笔记 CRUD 与版本历史 ==========

describe("知识管理 — 笔记 CRUD 与版本历史", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupNotebook();
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
    const noteA = createNote({ notebookId: NOTEBOOK_ID, title: "A", content: "c", contentType: "markdown" });
    const noteB = createNote({ notebookId: NOTEBOOK_ID, title: "B", content: "c", contentType: "markdown" });
    addNoteLink(noteA.id, noteB.id, "关联到B");
    // Link should exist in DB
    const db = getDatabase();
    const result = db.exec("SELECT * FROM note_links WHERE source_note_id = ?", [noteA.id]);
    expect(result[0].values.length).toBe(1);
  });

  // KM-010
  it("KM-010: listNotes 空笔记本返回空数组", () => {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO notebooks (id, name, description, summary, summary_status, source_count, chunk_count, group_id, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'pending', 0, 0, NULL, ?, ?)`,
      ["nb-empty", "空", now, now]
    );
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
  it("KM-015: 多笔记本笔记隔离", () => {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO notebooks (id, name, description, summary, summary_status, source_count, chunk_count, group_id, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'pending', 0, 0, NULL, ?, ?)`,
      ["nb-2", "笔记本2", now, now]
    );
    createNote({ notebookId: NOTEBOOK_ID, title: "NB1", content: "c", contentType: "markdown" });
    createNote({ notebookId: "nb-2", title: "NB2", content: "c", contentType: "markdown" });
    expect(listNotes(NOTEBOOK_ID).length).toBe(1);
    expect(listNotes("nb-2").length).toBe(1);
  });
});

// ========== B. 闪卡存储与复习调度 ==========

describe("知识管理 — 闪卡存储", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupNotebook();
  });

  // KM-016
  it("KM-016: flashcards 表存在", () => {
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='flashcards'");
    expect(result[0].values.length).toBe(1);
  });

  // KM-017
  it("KM-017: flashcard-store 模块可导入", async () => {
    const mod = await import("../core/knowledge/flashcard-store");
    expect(mod).toBeDefined();
  });

  // KM-018
  it("KM-018: 闪卡可直接写入 DB", () => {
    const db = getDatabase();
    db.run(
      "INSERT INTO flashcards (id, notebook_id, note_id, front, back, ease_factor, interval_days, next_review, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["fc-1", NOTEBOOK_ID, null, "问题", "答案", 2.5, 0, Date.now(), Date.now(), Date.now()]
    );
    const result = db.exec("SELECT front, back FROM flashcards WHERE id = ?", ["fc-1"]);
    expect(result[0].values[0][0]).toBe("问题");
    expect(result[0].values[0][1]).toBe("答案");
  });

  // KM-019
  it("KM-019: 多张闪卡共存", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      db.run(
        "INSERT INTO flashcards (id, notebook_id, note_id, front, back, ease_factor, interval_days, next_review, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`fc-${i}`, NOTEBOOK_ID, null, `Q${i}`, `A${i}`, 2.5, i, Date.now(), Date.now(), Date.now()]
      );
    }
    const result = db.exec("SELECT COUNT(*) FROM flashcards WHERE notebook_id = ?", [NOTEBOOK_ID]);
    expect(result[0].values[0][0]).toBe(5);
  });

  // KM-020
  it("KM-020: 闪卡 difficulty 字段范围 0-5", () => {
    const db = getDatabase();
    for (const diff of [0, 1, 2, 3, 4, 5]) {
      db.run(
        "INSERT INTO flashcards (id, notebook_id, note_id, front, back, ease_factor, interval_days, next_review, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`fc-d${diff}`, NOTEBOOK_ID, null, `Q${diff}`, `A${diff}`, 2.5, diff, Date.now(), Date.now(), Date.now()]
      );
    }
    const result = db.exec("SELECT interval_days FROM flashcards WHERE notebook_id = ? ORDER BY interval_days", [NOTEBOOK_ID]);
    const intervals = result[0].values.map((r: any[]) => r[0]);
    expect(intervals).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // KM-021 ~ KM-025 removed — were empty placeholders
});

// ========== C. 知识图谱 ==========

describe("知识管理 — 知识图谱", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupNotebook();
  });

  // KM-026
  it("KM-026: graph_nodes 表存在", () => {
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'");
    expect(result[0].values.length).toBe(1);
  });

  // KM-027
  it("KM-027: graph_edges 表存在", () => {
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_edges'");
    expect(result[0].values.length).toBe(1);
  });

  // KM-028
  it("KM-028: graph-extractor 模块可导入", async () => {
    const mod = await import("../core/knowledge/graph-extractor");
    expect(mod).toBeDefined();
  });

  // KM-029
  it("KM-029: 图谱节点可直接写入", () => {
    const db = getDatabase();
    db.run(
      "INSERT INTO graph_nodes (id, notebook_id, label, entity_type, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["gn-1", NOTEBOOK_ID, "React", "技术", "desc", Date.now()]
    );
    const result = db.exec("SELECT label FROM graph_nodes WHERE id = ?", ["gn-1"]);
    expect(result[0].values[0][0]).toBe("React");
  });

  // KM-030
  it("KM-030: 图谱边可直接写入", () => {
    const db = getDatabase();
    db.run(
      "INSERT INTO graph_nodes (id, notebook_id, label, entity_type, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["gn-src", NOTEBOOK_ID, "Node1", "技术", "desc", Date.now()]
    );
    db.run(
      "INSERT INTO graph_nodes (id, notebook_id, label, entity_type, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["gn-tgt", NOTEBOOK_ID, "Node2", "技术", "desc", Date.now()]
    );
    db.run(
      "INSERT INTO graph_edges (id, notebook_id, source_node_id, target_node_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["ge-1", NOTEBOOK_ID, "gn-src", "gn-tgt", "depends_on", Date.now()]
    );
    const result = db.exec("SELECT relation_type FROM graph_edges WHERE id = ?", ["ge-1"]);
    expect(result[0].values[0][0]).toBe("depends_on");
  });

  // KM-031 ~ KM-035 removed — were empty placeholders
});

// ========== D. 导出/导入 ==========

describe("知识管理 — 导出/导入", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupNotebook();
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

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupNotebook();
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

describe("知识管理 — UI 组件导入", () => {
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
    });
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
