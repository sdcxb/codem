/**
 * show_todo 工具 — 展示 Todo 列表给用户，支持完成/进行中/待办状态。
 *
 * 用途：AI 可以创建 Todo 列表来跟踪任务进度，用户可以勾选完成。
 *       Todo 状态会持久化到数据库。
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";
import type { TodoItem } from "../agentic-loop";
import { domainReadMany, domainReadOne, domainWrite, reportWriteNotAccepted } from "../../storage/domain-store";
import { reportActionFailure, reportPersistFailure } from "../../storage/persist-failure";

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
 *
 * ## 任务 C-5：`null` 有两种含义，调用方必须能分开
 *
 * 返回 `null` 原本同时表示"这条待办不存在"与"镜像未接手、这次读不到"。
 * 对勾选功能来说这两者的处置**完全不同**：前者是"你点的那条已经没了"，
 * 后者是"稍后再点一次就行"。所以读不到时**如实上报**（不再静默），
 * 并给出**明确**的失败结果 —— 而不是让调用方以为"没有这条待办"。
 */
export function loadTodoList(todoId: string): TodoItem[] | null {
  const rust = domainReadOne(TODO_TABLE, { id: todoId }, wireToTodoRow);
  if (rust !== undefined) return rust ? parseTodos(rust.todos) : null;
  /*
   * 两态：B 态（端口在、镜像未就绪）不碰旧库。
   *
   * 但**不能静默**：C-5 的现场就是"勾选全部无效且无任何提示"。
   * 这里补上上报，让"这个进程此刻读不到待办列表"可见（调用方据此提示"稍后重试"）。
   */
  reportPersistFailure(
    "todo.load",
    new Error("端口已注册但 todo_lists 镜像未接手（未就绪 / 未镜像）"),
    `待办列表 ${todoId} 本次读不到 —— 这**不是**"该待办不存在"，请稍后重试`,
  );
  return null;
}

/**
 * 某会话**最近一份**待办清单（第 72 轮审计新增）。
 *
 * ## 为什么需要它
 *
 * 审计发现聊天里的待办面板（`TodoListDisplay`）是**死代码**：它由 `ChatPanel` 的
 * `activeTodoId` / `activeTodos` 驱动，而那两个 state **全仓没有任何 setter 调用点**
 * ⇒ 渲染条件 `activeTodoId && activeTodos.length > 0` 恒假 ⇒ 组件永不出现。
 * 而 `show_todo` 工具明明一直在往 `todo_lists` 写数据（本机库里就有两条）——
 * 也就是说"库里有、界面上永远看不到"，与本次审计的其它几处同一类。
 *
 * ## 返回值的三态（沿用本文件 C-5 的纪律：不许把"读不到"说成"没有"）
 *
 * - `{ status: "ok", list: {...} }` —— 读到了，这是最近一份；
 * - `{ status: "ok", list: null }`  —— 确实没有待办清单（该会话从没用过 `show_todo`）；
 * - `{ status: "unavailable" }`     —— **这次读不到**（镜像未就绪/未接手）⇒ 调用方应当
 *   保持原状并等"就绪后重读"，**绝不能**当成"没有待办"把界面清空。
 */
export type TodoLookup =
  | { status: "ok"; list: { id: string; todos: TodoItem[]; createdAt: number } | null }
  | { status: "unavailable" };

export function latestTodoListForSession(sessionId: string): TodoLookup {
  if (!sessionId) return { status: "ok", list: null };
  const rust = domainReadMany(TODO_TABLE, wireToTodoRow, { session_id: sessionId });
  if (rust === undefined) return { status: "unavailable" };
  if (rust.length === 0) return { status: "ok", list: null };
  // 最近一份：created_at 最大的那条（同一会话多次 show_todo 会留下多行）
  const newest = rust.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return {
    status: "ok",
    // `parseTodos` 对坏 JSON 返回 null（行坏了不等于"没有待办"）—— 这里如实落成空数组，
    // 由上层决定怎么表达；不编造条目。
    list: { id: newest.id, todos: parseTodos(newest.todos) ?? [], createdAt: newest.created_at },
  };
}

/**
 * Update todo item status
 *
 * ## 任务 C-5：勾选分支原来**静默 return，连上报都没有**
 *
 * 原实现（`domainReadOne` 返回 `undefined` 时）在函数末尾直接 `return;` ——
 * 与同仓 `goal.ts` / `inbox-storage.ts` 的写法冲突（它们都走 `reportPersistFailure`）。
 * 现场表现：用户在待办面板上勾选，界面动了一下（前端本地状态），
 * 库里没有任何写入、日志里没有任何痕迹 —— 一次"看起来成功了"的假成功。
 */
export function updateTodoStatus(todoId: string, itemId: string, status: TodoItem["status"]): void {
  const applyStatus = (todos: TodoItem[]): TodoItem[] =>
    todos.map((todo) => (todo.id === itemId ? { ...todo, status } : todo));

  // 迁移期：读出整行 → 改状态 → 整体写回（旧实现是读出 JSON、改、再 UPDATE 回去）
  const rustCurrent = domainReadOne(TODO_TABLE, { id: todoId }, wireToTodoRow);
  if (rustCurrent !== undefined) {
    /*
     * "未就绪"与"不存在"必须分开：
     * - `null` = 这条待办确实不在库里（例如会话已删除、列表被清掉）→ 业务失败，如实上报；
     * - `undefined` = 端口没接手（下面那条分支）。
     * 原实现把两者都写成 `return`，所以用户根本不知道勾选为什么没生效。
     */
    if (rustCurrent === null) {
      reportPersistFailure(
        "todo.updateStatus",
        new Error(`待办列表 ${todoId} 不存在`),
        `勾选未生效：这条待办列表已经不在库里（可能随会话一起被删除）`,
      );
      return;
    }
    const todos = parseTodos(rustCurrent.todos);
    if (!todos) {
      // 坏 JSON：待办行在、但内容解析不出来 —— 这是**数据**问题，必须可见
      reportPersistFailure(
        "todo.updateStatus",
        new Error(`待办列表 ${todoId} 的 todos 字段不是合法 JSON 数组`),
        `勾选未生效：待办内容已损坏（没有覆盖写，避免把坏数据写回去）`,
      );
      return;
    }
    if (!todos.some((t) => t.id === itemId)) {
      // 勾选了一个不存在的条目：旧实现会写回一份"没有任何变化"的 JSON（静默空写）
      reportActionFailure(
        "todo.updateStatus",
        new Error(`待办 ${itemId} 不在列表 ${todoId} 中`),
        "勾选未生效：这条待办已不在列表里（界面显示的是旧快照）",
      );
      return;
    }
    domainWrite(
      TODO_TABLE,
      [{ ...rustCurrent, todos: JSON.stringify(applyStatus(todos)), updated_at: Date.now() }],
      { mode: "replace", scope: "todo.updateStatus", note: "待办状态未更新" },
    );
    return;
  }

  // 两态：B 态不碰旧库（该域由端口负责，镜像未就绪时本次变更不落地）——
  // 但**必须如实上报**，否则就是"勾选静默无效"（C-5 的现场）。
  reportPersistFailure(
    "todo.updateStatus",
    new Error("端口已注册但 todo_lists 镜像未接手（未就绪 / 未镜像）"),
    `勾选未生效：本次读不到待办列表 ${todoId}，请稍后重试`,
  );
  return;
}