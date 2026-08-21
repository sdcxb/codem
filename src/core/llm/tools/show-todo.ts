/**
 * show_todo 工具 — 展示 Todo 列表给用户，支持完成/进行中/待办状态。
 *
 * 用途：AI 可以创建 Todo 列表来跟踪任务进度，用户可以勾选完成。
 *       Todo 状态会持久化到数据库。
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";
import type { TodoItem } from "../agentic-loop";
import { getDatabase, persistDatabase } from "../../storage/database";

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
  const db = getDatabase();
  const now = Date.now();

  // Insert todo list
  db.run(
    "INSERT INTO todo_lists (id, session_id, todos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [todoId, sessionId, JSON.stringify(todos), now, now]
  );

  persistDatabase();
}

/**
 * Load todo list from database
 */
export function loadTodoList(todoId: string): TodoItem[] | null {
  const db = getDatabase();
  const result = db.exec("SELECT todos FROM todo_lists WHERE id = ?", [todoId]);

  if (result.length === 0 || result[0].values.length === 0) {
    return null;
  }

  const todosJson = result[0].values[0][0] as string;
  return JSON.parse(todosJson) as TodoItem[];
}

/**
 * Update todo item status
 */
export function updateTodoStatus(todoId: string, itemId: string, status: TodoItem["status"]): void {
  const db = getDatabase();
  const result = db.exec("SELECT todos FROM todo_lists WHERE id = ?", [todoId]);

  if (result.length === 0 || result[0].values.length === 0) {
    return;
  }

  const todosJson = result[0].values[0][0] as string;
  const todos: TodoItem[] = JSON.parse(todosJson);

  const updatedTodos = todos.map((todo) =>
    todo.id === itemId ? { ...todo, status } : todo
  );

  db.run(
    "UPDATE todo_lists SET todos = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(updatedTodos), Date.now(), todoId]
  );

  persistDatabase();
}