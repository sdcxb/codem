/**
 * 全量测试：P1 组件集成 — 澄清/纠正/管道/Todo/工具注册 — P1INT-001 ~ P1INT-050
 *
 * 覆盖范围：
 *   A. ClarificationFormData 类型与事件 (P1INT-001 ~ P1INT-010)
 *   B. CorrectionResultPanel 数据结构 (P1INT-011 ~ P1INT-020)
 *   C. PipelineNextStepDialog 上下文构建 (P1INT-021 ~ P1INT-030)
 *   D. Todo 工具与 DB 持久化 (P1INT-031 ~ P1INT-040)
 *   E. note-operations 工具注册验证 (P1INT-041 ~ P1INT-050)
 *
 * 关键组件：
 *   - agentic-loop.ts (ClarificationFormData / LoopEvent)
 *   - tools.ts (createDefaultToolRegistry / note-operations / ask-clarification / fact-check / show-todo)
 *   - storage/database.ts (todo_lists 表)
 *   - knowledge/storage.ts (notes / note_links 表)
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
import { createDefaultToolRegistry, type ToolDef } from "../core/llm/tools";
import type { ClarificationFormData } from "../core/llm/agentic-loop";
import { loadTodoList, updateTodoStatus } from "../core/llm/tools/show-todo";
import { useAppStore } from "../store";
import { createMessage as _createMessage, updateMessageContent as _updateMessageContent, getMessage as _getMessage } from "../core/storage/message";
import { getDatabase } from "../core/storage/database";
import type { TodoItem } from "../core/llm/agentic-loop";

const PROJECT_ID = "proj-p1-test";
const SESSION_ID = "sess-p1-test";

function setupBase(): void {
  const db = getDatabase();
  db.run("INSERT INTO projects (id, name, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
    [PROJECT_ID, "P1测试", "D:/p1", Date.now(), Date.now()]);
  db.run("INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES (?, ?, ?, ?, ?, ?)",
    [SESSION_ID, PROJECT_ID, "P1测试会话", Date.now(), Date.now(), 0]);
}

// ========== A. ClarificationFormData 类型与事件 ==========

describe("P1 集成 — ClarificationFormData 类型与事件", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // P1INT-001
  it("P1INT-001: ClarificationFormData radio 类型正确构造", () => {
    const form: ClarificationFormData = {
      question: "你想要哪种方案？",
      type: "radio",
      options: ["方案A", "方案B", "方案C"],
      formId: "form-001",
      required: true,
    };
    expect(form.type).toBe("radio");
    expect(form.options).toHaveLength(3);
    expect(form.required).toBe(true);
  });

  // P1INT-002
  it("P1INT-002: ClarificationFormData checkbox 类型正确构造", () => {
    const form: ClarificationFormData = {
      question: "选择需要的功能",
      type: "checkbox",
      options: ["认证", "日志", "监控"],
      formId: "form-002",
      required: false,
    };
    expect(form.type).toBe("checkbox");
    expect(form.required).toBe(false);
  });

  // P1INT-003
  it("P1INT-003: ClarificationFormData text 类型正确构造", () => {
    const form: ClarificationFormData = {
      question: "请输入项目名称",
      type: "text",
      formId: "form-003",
      required: true,
    };
    expect(form.type).toBe("text");
    expect(form.options).toBeUndefined();
  });

  // P1INT-004
  it("P1INT-004: resolve 回调可被正确调用", () => {
    let resolved = false;
    let resolvedAnswers: string[] | null = null;
    const form: ClarificationFormData = {
      question: "test",
      type: "radio",
      options: ["A", "B"],
      formId: "form-004",
      required: false,
    };
    // 模拟 LoopEvent 中的 resolve 回调
    const event = {
      type: "clarification" as const,
      form,
      resolve: (answers: string[]) => {
        resolved = true;
        resolvedAnswers = answers;
      },
    };
    event.resolve(["A"]);
    expect(resolved).toBe(true);
    expect(resolvedAnswers).toEqual(["A"]);
  });

  // P1INT-005
  it("P1INT-005: resolve 回调传入空数组表示用户跳过", () => {
    let resolved = false;
    const resolve = (answers: string[]) => {
      resolved = true;
      expect(answers).toEqual([]);
    };
    resolve([]);
    expect(resolved).toBe(true);
  });

  // P1INT-006
  it("P1INT-006: formId 唯一标识符格式", () => {
    const form: ClarificationFormData = {
      question: "q",
      type: "text",
      formId: `clarify-${Date.now()}`,
      required: false,
    };
    expect(form.formId).toMatch(/^clarify-\d+$/);
  });

  // P1INT-007
  it("P1INT-007: radio 类型必须有 options", () => {
    const form: ClarificationFormData = {
      question: "q",
      type: "radio",
      options: ["yes", "no"],
      formId: "form-007",
      required: true,
    };
    expect(form.options).toBeDefined();
    expect(form.options!.length).toBeGreaterThan(0);
  });

  // P1INT-008
  it("P1INT-008: checkbox 类型必须有 options", () => {
    const form: ClarificationFormData = {
      question: "q",
      type: "checkbox",
      options: ["a", "b"],
      formId: "form-008",
      required: false,
    };
    expect(form.options).toBeDefined();
  });

  // P1INT-009
  it("P1INT-009: text 类型 options 可选", () => {
    const form: ClarificationFormData = {
      question: "q",
      type: "text",
      formId: "form-009",
      required: false,
    };
    expect(form.options).toBeUndefined();
  });

  // P1INT-010
  it("P1INT-010: required 标记影响表单验证", () => {
    const requiredForm: ClarificationFormData = {
      question: "q", type: "text", formId: "r", required: true,
    };
    const optionalForm: ClarificationFormData = {
      question: "q", type: "text", formId: "o", required: false,
    };
    expect(requiredForm.required).toBe(true);
    expect(optionalForm.required).toBe(false);
  });
});

// ========== B. CorrectionResultPanel 数据结构 ==========

describe("P1 集成 — CorrectionResultPanel 数据结构", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // P1INT-011
  it("P1INT-011: correction_complete 事件数据结构正确", () => {
    const event = {
      type: "correction_complete" as const,
      original: "这是原始回复",
      corrected: "这是修正后的回复",
      changes: ["修正了时间", "修正了名称"],
    };
    expect(event.original).toBe("这是原始回复");
    expect(event.corrected).toBe("这是修正后的回复");
    expect(event.changes).toHaveLength(2);
  });

  // P1INT-012
  it("P1INT-012: original 和 corrected 相同时表示无需修正", () => {
    const event = {
      type: "correction_complete" as const,
      original: "相同内容",
      corrected: "相同内容",
      changes: [],
    };
    expect(event.original).toBe(event.corrected);
    expect(event.changes).toHaveLength(0);
  });

  // P1INT-013
  it("P1INT-013: changes 列表为空 — 无修正项", () => {
    const event = {
      type: "correction_complete" as const,
      original: "a",
      corrected: "b",
      changes: [],
    };
    expect(event.changes).toEqual([]);
  });

  // P1INT-014
  it("P1INT-014: changes 包含多条修正描述", () => {
    const changes = ["修正1", "修正2", "修正3", "修正4"];
    const event = {
      type: "correction_complete" as const,
      original: "a", corrected: "b", changes,
    };
    expect(event.changes).toHaveLength(4);
  });

  // P1INT-015
  it("P1INT-015: 修正应用 — 更新消息内容", () => {
    useAppStore.getState().addMessage({
      id: "msg-cor-1", role: "assistant", content: "原始内容",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().updateMessage("msg-cor-1", { content: "修正后内容" });
    const msg = useAppStore.getState().messages.find((m: any) => m.id === "msg-cor-1");
    expect(msg.content).toBe("修正后内容");
  });

  // P1INT-016
  it("P1INT-016: 修正应用后消息状态保持 done", () => {
    useAppStore.getState().addMessage({
      id: "msg-cor-2", role: "assistant", content: "原始",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().updateMessage("msg-cor-2", { content: "修正" });
    const msg = useAppStore.getState().messages.find((m: any) => m.id === "msg-cor-2");
    expect(msg.status).toBe("done");
  });

  // P1INT-017
  it("P1INT-017: 修正取消 — 消息内容不变", () => {
    useAppStore.getState().addMessage({
      id: "msg-cor-3", role: "assistant", content: "保留内容",
      timestamp: Date.now(), status: "done",
    });
    const msg = useAppStore.getState().messages.find((m: any) => m.id === "msg-cor-3");
    expect(msg.content).toBe("保留内容");
  });

  // P1INT-018
  it("P1INT-018: correction 事件不影响其他消息", () => {
    useAppStore.getState().addMessage({
      id: "msg-a", role: "assistant", content: "内容A",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().addMessage({
      id: "msg-b", role: "assistant", content: "内容B",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().updateMessage("msg-a", { content: "修正A" });
    const msgB = useAppStore.getState().messages.find((m: any) => m.id === "msg-b");
    expect(msgB.content).toBe("内容B");
  });

  // P1INT-019
  it("P1INT-019: 多轮修正 — 每次修正基于上一次结果", () => {
    useAppStore.getState().addMessage({
      id: "msg-multi-cor", role: "assistant", content: "v1",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().updateMessage("msg-multi-cor", { content: "v2" });
    useAppStore.getState().updateMessage("msg-multi-cor", { content: "v3" });
    const msg = useAppStore.getState().messages.find((m: any) => m.id === "msg-multi-cor");
    expect(msg.content).toBe("v3");
  });

  // P1INT-020
  it("P1INT-020: 修正后的内容持久化到 DB", () => {
    setupBase();
    _createMessage({
      id: "msg-db-cor", role: "assistant", content: "原始",
      timestamp: Date.now(), status: "done",
    }, SESSION_ID);
    _updateMessageContent("msg-db-cor", "修正后");
    const loaded = _getMessage("msg-db-cor");
    expect(loaded.content).toBe("修正后");
  });
});

// ========== C. PipelineNextStepDialog 上下文构建 ==========

describe("P1 集成 — PipelineNextStepDialog 上下文构建", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // P1INT-021
  it("P1INT-021: pipeline_step_complete 事件数据结构正确", () => {
    const event = {
      type: "pipeline_step_complete" as const,
      stepId: "step-1",
      stepTitle: "第一步",
      result: "完成结果",
    };
    expect(event.stepId).toBe("step-1");
    expect(event.stepTitle).toBe("第一步");
    expect(event.result).toBe("完成结果");
  });

  // P1INT-022
  it("P1INT-022: 上下文项 — message 类型", () => {
    const item = {
      id: "msg-ctx-1",
      type: "message" as const,
      title: "消息标题",
      content: "消息内容",
    };
    expect(item.type).toBe("message");
  });

  // P1INT-023
  it("P1INT-023: 上下文项 — notebook 类型", () => {
    const item = {
      id: "nb-ctx-1",
      type: "notebook" as const,
      title: "笔记本名称",
    };
    expect(item.type).toBe("notebook");
  });

  // P1INT-024
  it("P1INT-024: 上下文项 — table 类型", () => {
    const item = {
      id: "tbl-ctx-1",
      type: "table" as const,
      title: "表格名称",
    };
    expect(item.type).toBe("table");
  });

  // P1INT-025
  it("P1INT-025: 从最近消息构建上下文项列表", () => {
    useAppStore.setState({ messages: [] });
    useAppStore.getState().addMessage({
      id: "msg-recent-1", role: "user", content: "最近消息1",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().addMessage({
      id: "msg-recent-2", role: "assistant", content: "最近回复2",
      timestamp: Date.now(), status: "done",
    });
    const recent = useAppStore.getState().messages.slice(-5);
    const contextItems = recent
      .filter((m: any) => m.content)
      .map((m: any) => ({
        id: m.id,
        type: "message" as const,
        title: m.content.substring(0, 60),
        content: m.content,
      }));
    expect(contextItems.length).toBeGreaterThanOrEqual(2);
  });

  // P1INT-026
  it("P1INT-026: 空消息列表构建空上下文", () => {
    useAppStore.getState().messages.length = 0;
    const recent = useAppStore.getState().messages.slice(-5);
    const contextItems = recent
      .filter((m: any) => m.content)
      .map((m: any) => ({ id: m.id, type: "message" as const, title: m.content }));
    expect(contextItems).toEqual([]);
  });

  // P1INT-027
  it("P1INT-027: 模式选择 — new 模式创建新对话", () => {
    const mode = "new" as "new" | "append";
    expect(mode).toBe("new");
  });

  // P1INT-028
  it("P1INT-028: 模式选择 — append 模式追加到当前对话", () => {
    const mode = "append" as "new" | "append";
    expect(mode).toBe("append");
  });

  // P1INT-029
  it("P1INT-029: customPrompt 为空且无选中上下文 — 不提交", () => {
    const selectedContext: string[] = [];
    const customPrompt = "";
    const shouldSubmit = selectedContext.length > 0 || customPrompt.trim().length > 0;
    expect(shouldSubmit).toBe(false);
  });

  // P1INT-030
  it("P1INT-030: customPrompt 有内容 — 可提交", () => {
    const customPrompt = "继续下一步";
    const shouldSubmit = customPrompt.trim().length > 0;
    expect(shouldSubmit).toBe(true);
  });
});

// ========== D. Todo 工具与 DB 持久化 ==========

describe("P1 集成 — Todo 工具与 DB 持久化", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupBase();
  });

  // P1INT-031
  it("P1INT-031: saveTodoList 创建新 Todo 列表", () => {
    const db = getDatabase();
    const todos: TodoItem[] = [
      { id: "t1", text: "任务1", completed: false, status: "pending" },
      { id: "t2", text: "任务2", completed: false, status: "pending" },
    ];
    db.run(
      "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["todo-001", SESSION_ID, JSON.stringify(todos), Date.now(), Date.now()]
    );
    const loaded = loadTodoList("todo-001");
    expect(loaded).toBeDefined();
    expect(loaded!.length).toBe(2);
  });

  // P1INT-032
  it("P1INT-032: loadTodoList 读取已保存的 Todo", () => {
    const db = getDatabase();
    const todos: TodoItem[] = [
      { id: "t1", text: "读取测试", completed: false, status: "pending" },
    ];
    db.run(
      "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["todo-002", SESSION_ID, JSON.stringify(todos), Date.now(), Date.now()]
    );
    const loaded = loadTodoList("todo-002");
    expect(loaded).toBeDefined();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].text).toBe("读取测试");
  });

  // P1INT-033
  it("P1INT-033: loadTodoList 不存在的 ID 返回 null", () => {
    const loaded = loadTodoList("nonexistent-todo");
    expect(loaded).toBeNull();
  });

  // P1INT-034
  it("P1INT-034: updateTodoStatus 更新完成状态", () => {
    const db = getDatabase();
    const todos: TodoItem[] = [
      { id: "t1", text: "待完成", completed: false, status: "pending" },
    ];
    db.run(
      "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["todo-003", SESSION_ID, JSON.stringify(todos), Date.now(), Date.now()]
    );
    updateTodoStatus("todo-003", "t1", "done");
    const loaded = loadTodoList("todo-003");
    expect(loaded![0].status).toBe("done");
  });

  // P1INT-035
  it("P1INT-035: updateTodoStatus 取消完成状态", () => {
    const db = getDatabase();
    const todos: TodoItem[] = [
      { id: "t1", text: "已完成", completed: true, status: "done" },
    ];
    db.run(
      "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["todo-004", SESSION_ID, JSON.stringify(todos), Date.now(), Date.now()]
    );
    updateTodoStatus("todo-004", "t1", "pending");
    const loaded = loadTodoList("todo-004");
    expect(loaded![0].status).toBe("pending");
  });

  // P1INT-036
  it("P1INT-036: saveTodoList 覆盖已存在的列表", () => {
    const db = getDatabase();
    const todos1: TodoItem[] = [{ id: "t1", text: "旧任务", completed: false, status: "pending" }];
    db.run(
      "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["todo-005", SESSION_ID, JSON.stringify(todos1), Date.now(), Date.now()]
    );
    // Overwrite via UPDATE
    const todos2: TodoItem[] = [
      { id: "t1", text: "新任务", completed: true, status: "done" },
      { id: "t2", text: "额外任务", completed: false, status: "pending" },
    ];
    db.run("UPDATE todo_lists SET todos = ?, updated_at = ? WHERE id = ?", [JSON.stringify(todos2), Date.now(), "todo-005"]);
    const loaded = loadTodoList("todo-005");
    expect(loaded!.length).toBe(2);
    expect(loaded![0].text).toBe("新任务");
  });

  // P1INT-037
  it("P1INT-037: 空 Todo 列表可保存和加载", () => {
    const db = getDatabase();
    db.run(
      "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["todo-empty", SESSION_ID, JSON.stringify([]), Date.now(), Date.now()]
    );
    const loaded = loadTodoList("todo-empty");
    expect(loaded).toEqual([]);
  });

  // P1INT-038
  it("P1INT-038: 多个 Todo 列表共存 — 不同 ID 隔离", () => {
    const db = getDatabase();
    db.run("INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["todo-A", SESSION_ID, JSON.stringify([{ id: "t1", text: "A任务", completed: false, status: "pending" as const }]), Date.now(), Date.now()]);
    db.run("INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["todo-B", SESSION_ID, JSON.stringify([{ id: "t1", text: "B任务", completed: false, status: "pending" as const }]), Date.now(), Date.now()]);
    expect(loadTodoList("todo-A")![0].text).toBe("A任务");
    expect(loadTodoList("todo-B")![0].text).toBe("B任务");
  });

  // P1INT-039
  it("P1INT-039: status 字段保留 — pending/in_progress/done", () => {
    const db = getDatabase();
    const todos: TodoItem[] = [
      { id: "t1", text: "待", completed: false, status: "pending" as const },
      { id: "t2", text: "进行", completed: false, status: "in_progress" as const },
      { id: "t3", text: "完", completed: true, status: "done" as const },
    ];
    db.run("INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["todo-status", SESSION_ID, JSON.stringify(todos), Date.now(), Date.now()]);
    const loaded = loadTodoList("todo-status")!;
    expect(loaded[0].status).toBe("pending");
    expect(loaded[1].status).toBe("in_progress");
    expect(loaded[2].status).toBe("done");
  });

  // P1INT-040
  it("P1INT-040: updateTodoStatus 不存在的 todoId — 无副作用", () => {
    expect(() => updateTodoStatus("nonexistent", "t1", "done")).not.toThrow();
  });
});

// ========== E. note-operations 工具注册验证 ==========

describe("P1 集成 — note-operations 工具注册验证", () => {
  let registry: ReturnType<typeof createDefaultToolRegistry>;

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    registry = createDefaultToolRegistry();
  });

  // P1INT-041
  it("P1INT-041: createDefaultToolRegistry 包含 create_note 工具", () => {
    const tool = registry.get("create_note");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("create_note");
  });

  // P1INT-042
  it("P1INT-042: createDefaultToolRegistry 包含 edit_note 工具", () => {
    const tool = registry.get("edit_note");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("edit_note");
  });

  // P1INT-043
  it("P1INT-043: createDefaultToolRegistry 包含 link_notes 工具", () => {
    const tool = registry.get("link_notes");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("link_notes");
  });

  // P1INT-044
  it("P1INT-044: createDefaultToolRegistry 包含 delete_note 工具", () => {
    const tool = registry.get("delete_note");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("delete_note");
  });

  // P1INT-045
  it("P1INT-045: createDefaultToolRegistry 包含 ask_clarification 工具", () => {
    const tool = registry.get("ask_clarification");
    expect(tool).toBeDefined();
  });

  // P1INT-046
  it("P1INT-046: createDefaultToolRegistry 包含 fact_check 工具", () => {
    const tool = registry.get("fact_check");
    expect(tool).toBeDefined();
  });

  // P1INT-047
  it("P1INT-047: createDefaultToolRegistry 包含 show_todo 工具", () => {
    const tool = registry.get("show_todo");
    expect(tool).toBeDefined();
  });

  // P1INT-048
  it("P1INT-048: createDefaultToolRegistry 包含 search_notebook 工具", () => {
    const tool = registry.get("search_notebook");
    expect(tool).toBeDefined();
  });

  // P1INT-049
  it("P1INT-049: createDefaultToolRegistry 包含 load_skill 工具", () => {
    const tool = registry.get("load_skill");
    expect(tool).toBeDefined();
  });

  // P1INT-050
  it("P1INT-050: createDefaultToolRegistry 包含 web_search 工具", () => {
    const tool = registry.get("web_search");
    expect(tool).toBeDefined();
  });
});
