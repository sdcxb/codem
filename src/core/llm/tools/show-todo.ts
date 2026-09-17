/**
 * show_todo 工具 — 展示 Todo 列表给用户，支持完成/进行中/待办状态。
 *
 * 用途：AI 可以创建 Todo 列表来跟踪任务进度，用户可以勾选完成。
 *       Todo 状态会持久化到数据库。
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";
import type { TodoItem } from "../agentic-loop";
import { domainReadOne, domainWrite, reportWriteNotAccepted } from "../../storage/domain-store";

/**
 * `todo_lists` 表与行转换（P5 第 2 段：接入域端口）
 *
 * 这个文件原来**自己拥有** `todo_lists` 表的读写（`INSERT` / `SELECT` / `UPDATE`），
 * 是 D 类（存储边界）违例里比较隐蔽的一处：它藏在"工具实现"里，不在 storage 目录下。
 * 切到 Rust 之后这些语句打的是旧库，待办列表会"看起来保存了、重启就没了"。
 */
const TODO_TABLE = "todo_lists";

interface TodoListRow {
  id: string;
  session_id: string;
  todos: string;
  created_at: number;
  updated_at: number;
}

function wireToTodoRow(row: Record<string, unknown>): TodoListRow {
  return {
    id: String(row.id ?? ""),
    session_id: String(row.session_id ?? ""),
    todos: String(row.todos ?? "[]"),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

/** 解析待办 JSON（解析失败当"没有"，不让坏数据把工具整条链路拖死） */
function parseTodos(json: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : null;
  } catch {
    return null;
  }
}

interface ShowTodoInput {
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

/**
 * Show todo tool — display a todo list for the user
 */
export function createShowTodoTool(): ToolDef {
  return {
    id: "show_todo",
    guidance: "Use show_todo to display the current task list to the user. Use this when the user asks what tasks are pending or to review progress.",
    description: "展示 Todo 列表给用户，支持待办/进行中/已完成状态。用户可以勾选完成。",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "任务内容",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "任务状态",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const input = args as unknown as ShowTodoInput;
      const { todos: inputTodos } = input;

      if (!inputTodos || inputTodos.length === 0) {
        return {
          title: "Error",
          output: "Todo 列表不能为空",
        };
      }

      try {
        // Convert input to TodoItem format with IDs
        const todoId = `todo-${ctx.sessionId}-${Date.now()}`;
        const todos: TodoItem[] = inputTodos.map((todo, index) => ({
          id: `${todoId}-${index}`,
          content: todo.content,
          status: todo.status,
          order: index,
        }));

        // Save to database
        saveTodoList(ctx.sessionId, todoId, todos);

        // P1-8: Calculate completion statistics
        const completed = todos.filter(t => t.status === "completed").length;
        const inProgress = todos.filter(t => t.status === "in_progress").length;
        const pending = todos.filter(t => t.status === "pending").length;
        const allCompleted = completed === todos.length && todos.length > 0;

        // P1-8: Verification nudge — when all tasks are completed,
        // remind the LLM to verify its work before declaring completion
        let output = `已创建 Todo 列表（${todos.length} 项任务）\n` +
          `✅ 已完成: ${completed} | 🔄 进行中: ${inProgress} | ⏳ 待办: ${pending}`;

        if (allCompleted) {
          output += `\n\n⚠️ 所有任务已标记为完成。在向用户报告完成之前，请验证：\n` +
            `1. 所有修改的文件是否已保存且无语法错误\n` +
            `2. 是否有遗漏的测试或验证步骤\n` +
            `3. 改动是否完整实现了用户的需求\n` +
            `如果验证通过，可以向用户报告完成。如果发现问题，请更新 Todo 状态并继续修复。`;
        }

        return {
          title: allCompleted ? "Todo List — All Completed" : "Todo List Created",
          output,
          metadata: {
            totalTasks: todos.length,
            completed,
            inProgress,
            pending,
            verificationNudgeNeeded: allCompleted,
          },
        };
      } catch (error) {
        return {
          title: "Error",
          output: `保存 Todo 列表失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Save todo list to database
 */
function saveTodoList(sessionId: string, todoId: string, todos: TodoItem[]): void {
  const now = Date.now();
  const row: TodoListRow = {
    id: todoId,
    session_id: sessionId,
    todos: JSON.stringify(todos),
    created_at: now,
    updated_at: now,
  };
  if (domainWrite(TODO_TABLE, [{ ...row }], { scope: "todo.save", note: "待办列表未保存" })) {
    return;
  }
  // 两态：A 态才回退旧库；B 态由 writeShouldFallBackToLegacy 如实上报
  reportWriteNotAccepted("todo.save", "待办列表未保存");
  return;
}

/**
 * Load todo list from database
 */
export function loadTodoList(todoId: string): TodoItem[] | null {
  const rust = domainReadOne(TODO_TABLE, { id: todoId }, wireToTodoRow);
  if (rust !== undefined) return rust ? parseTodos(rust.todos) : null;
  // 两态：B 态（端口在、镜像未就绪）不碰旧库，如实返回"现在读不到"
  return null;
}

/**
 * Update todo item status
 */
export function updateTodoStatus(todoId: string, itemId: string, status: TodoItem["status"]): void {
  const applyStatus = (todos: TodoItem[]): TodoItem[] =>
    todos.map((todo) => (todo.id === itemId ? { ...todo, status } : todo));

  // 迁移期：读出整行 → 改状态 → 整体写回（旧实现是读出 JSON、改、再 UPDATE 回去）
  const rustCurrent = domainReadOne(TODO_TABLE, { id: todoId }, wireToTodoRow);
  if (rustCurrent !== undefined) {
    if (!rustCurrent) return; // 待办列表不存在：旧实现是直接 return
    const todos = parseTodos(rustCurrent.todos);
    if (!todos) return;
    domainWrite(
      TODO_TABLE,
      [{ ...rustCurrent, todos: JSON.stringify(applyStatus(todos)), updated_at: Date.now() }],
      { mode: "replace", scope: "todo.updateStatus", note: "待办状态未更新" },
    );
    return;
  }

  // 两态：B 态不碰旧库（该域由端口负责，镜像未就绪时本次变更不落地）
  return;
}