/**
 * TodoListDisplay — Todo 列表可视化组件
 *
 * 展示 AI 创建的 Todo 列表，支持待办/进行中/已完成分组
 * 用户可以勾选完成，状态同步到数据库
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";
import type { TodoItem } from "../core/llm/agentic-loop";
import { updateTodoStatus, loadTodoList } from "../core/llm/tools/show-todo";

interface TodoListDisplayProps {
  /** Todo list ID */
  todoId: string;
  /** Todo items */
  todos: TodoItem[];
}

export const TodoListDisplay = memo(function TodoListDisplay({
  todoId,
  todos: initialTodos,
}: TodoListDisplayProps) {
  const lang = useLang();
  const [todos, setTodos] = useState<TodoItem[]>(initialTodos);

  const handleToggle = async (itemId: string) => {
    const todo = todos.find((t) => t.id === itemId);
    if (!todo) return;

    const newStatus: TodoItem["status"] =
      todo.status === "completed" ? "pending" : "completed";

    // Update local state
    setTodos((prev) =>
      prev.map((t) => (t.id === itemId ? { ...t, status: newStatus } : t))
    );

    // Update database
    updateTodoStatus(todoId, itemId, newStatus);
  };

  const groupedTodos = {
    pending: todos.filter((t) => t.status === "pending").sort((a, b) => a.order - b.order),
    in_progress: todos.filter((t) => t.status === "in_progress").sort((a, b) => a.order - b.order),
    completed: todos.filter((t) => t.status === "completed").sort((a, b) => a.order - b.order),
  };

  const renderGroup = (title: string, items: TodoItem[], count: number) => {
    if (items.length === 0) return null;
    return (
      <div className="todo-group">
        <div className="todo-group-header">
          <span className="todo-group-title">{title}</span>
          <span className="todo-group-count">{count}</span>
        </div>
        {items.map((todo) => (
          <label key={todo.id} className="todo-item">
            <input
              type="checkbox"
              checked={todo.status === "completed"}
              onChange={() => handleToggle(todo.id)}
            />
            <span className={`todo-content ${todo.status === "completed" ? "completed" : ""}`}>
              {todo.content}
            </span>
          </label>
        ))}
      </div>
    );
  };

  return (
    <div className="todo-list-display">
      <div className="todo-header">{S.todoList.title[lang]}</div>
      {renderGroup(S.todoList.pending[lang], groupedTodos.pending, groupedTodos.pending.length)}
      {renderGroup(S.todoList.inProgress[lang], groupedTodos.in_progress, groupedTodos.in_progress.length)}
      {renderGroup(S.todoList.completed[lang], groupedTodos.completed, groupedTodos.completed.length)}
    </div>
  );
});