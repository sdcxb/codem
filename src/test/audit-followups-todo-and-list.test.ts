/**
 * 聊天里的待办面板（`TodoListDisplay`）与 `list_sessions` 的作用域（第 72 轮审计新增）
 *
 * ## 审计结论
 *
 * 1. **待办面板是死代码**：`ChatPanel` 的 `activeTodoId` / `activeTodos` 全仓**没有任何 setter
 *    调用点** ⇒ 渲染条件恒假 ⇒ 组件永不出现；而 `show_todo` 工具一直在往 `todo_lists` 写数据
 *    （本机库里就有两条）—— 又一次"库里有、界面上永远看不到"。
 * 2. **`list_sessions` 只列当前作用域**：从全局会话发起委派时 agent 看不到任何项目里的会话，
 *    在项目里时又看不到全局会话 —— 而委派本身允许跨作用域，于是 agent 只能靠人把 id 手打给它。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | TODO-1 | 取"最近一份"（同一会话多次 `show_todo` 有多行） |
 * | TODO-2 | 确实没有 ⇒ `{status:"ok", list:null}`（与"读不到"分开） |
 * | TODO-3 | 镜像未就绪 ⇒ `{status:"unavailable"}`，**不是**"没有待办"（否则界面会被清空） |
 * | TODO-4 | 接线：ChatPanel 必须真的把待办灌进 state（`setActiveTodos`），并挂"就绪后重读" |
 * | LIST-1 | 有项目 ⇒ 列出本项目会话 **+ 全局会话**，每条标 `scope=` |
 * | LIST-2 | 无项目 ⇒ 列出全局 **+ 各项目**的会话 |
 * | LIST-3 | 同一会话不重复出现 |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetPersistFailures } from "../core/storage/persist-failure";

let port: import("./fake-storage-port").FakeStoragePort;

const TODO_ROW = (id: string, sessionId: string, createdAt: number, todos: unknown[]) => ({
  id,
  session_id: sessionId,
  todos: JSON.stringify(todos),
  created_at: createdAt,
  updated_at: createdAt,
});

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  port = createFakeStoragePort({ seed: {} });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  await new Promise((r) => setTimeout(r, 20));
});

afterEach(async () => {
  const { setStoragePort } = await import("../core/storage/port");
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("聊天里的待办面板（真实数据源）", () => {
  it("TODO-1/2/3: 取最近一份；没有 ⇒ null；读不到 ⇒ unavailable（三态不许混）", async () => {
    const { latestTodoListForSession } = await import("../core/llm/tools/show-todo");

    // ① 确认没有（镜像已就绪、行数为 0）
    port.domains.ensureLoaded("todo_lists");
    await new Promise((r) => setTimeout(r, 20));
    const none = latestTodoListForSession("s-none");
    expect(none).toEqual({ status: "ok", list: null });

    // ② 有两条 ⇒ 取 created_at 更大的那条
    port.domains.applyWrite("todo_lists", TODO_ROW("todo-old", "s1", 100, [{ id: "a", content: "旧", status: "pending", order: 0 }]));
    port.domains.applyWrite("todo_lists", TODO_ROW("todo-new", "s1", 200, [
      { id: "b", content: "新一", status: "pending", order: 0 },
      { id: "c", content: "新二", status: "completed", order: 1 },
    ]));
    const found = latestTodoListForSession("s1");
    expect(found.status).toBe("ok");
    expect(found.status === "ok" && found.list?.id, "必须取最近一份（否则界面显示旧清单）").toBe("todo-new");
    expect(found.status === "ok" && found.list?.todos.length).toBe(2);

    // ③ 另一个会话的行不该串过来
    expect(latestTodoListForSession("s-other")).toEqual({ status: "ok", list: null });
  });

  it("TODO-3b: 镜像没接手 ⇒ unavailable（绝不能报成'没有待办'）", async () => {
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { setStoragePort } = await import("../core/storage/port");
    const never = createFakeStoragePort({ seed: {}, neverReady: ["todo_lists"] });
    await never.config.warmup();
    setStoragePort(never);

    const { latestTodoListForSession } = await import("../core/llm/tools/show-todo");
    const res = latestTodoListForSession("s1");
    expect(
      res,
      "读不到时必须如实说 unavailable：当成'没有待办'会让界面把已有清单清空（C-5 的同一条纪律）",
    ).toEqual({ status: "unavailable" });
  });

  it("TODO-4: 接线 —— ChatPanel 必须真的把待办灌进 state，并挂'就绪后重读'", async () => {
    const src = await vi.importActual<typeof import("fs")>("fs");
    const raw = src.readFileSync("src/components/ChatPanel.tsx", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code, "必须调用真实查询").toContain("latestTodoListForSession(");
    expect(
      code,
      "必须把**查到的待办**写进 state（原来 setActiveTodos 全仓零调用 ⇒ 组件永不出现；" +
        "注意要断言的是那条真实数据路径，只断言 'setActiveTodos(' 会被清空分支里的 setActiveTodos([]) 蒙混过去）",
    ).toContain("setActiveTodos(found.list?.todos");
    expect(code, "必须把 todoId 也写进 state").toContain("setActiveTodoId(");
    expect(code, "读不到时要保持原状（不许当成空清掉界面）").toContain('found.status === "unavailable"');
    expect(code, "todo_lists 故意不预取 ⇒ 必须挂'就绪后重读'").toContain('useDomainReady("todo_lists"');
  });
});

describe("list_sessions 的作用域（agent 要能发现跨作用域的委派目标）", () => {
  async function seedForList(opts: {
    project?: { id: string; name: string } | null;
    scoped?: Array<{ id: string; title: string; messageCount: number }>;
    global?: Array<{ id: string; title: string; messageCount: number }>;
    perProject?: Record<string, Array<{ id: string; title: string; messageCount: number }>>;
  }) {
    const { useProjectStore } = await import("../core/store");
    const SessionStorage = await import("../core/storage/session");
    vi.spyOn(SessionStorage, "listSessions").mockImplementation((pid?: string) => {
      if (pid === "") return (opts.global ?? []) as any;
      return (opts.perProject?.[pid ?? ""] ?? []) as any;
    });
    useProjectStore.setState({
      currentProject: opts.project ? ({ ...opts.project, path: "C:/p", createdAt: 0, lastAccessedAt: 0 } as any) : null,
      projects: Object.keys(opts.perProject ?? {}).map((id) => ({ id, name: id, path: "C:/p", createdAt: 0, lastAccessedAt: 0 })) as any,
      sessions: (opts.scoped ?? []) as any,
      getProjectSessions: ((pid: string) => opts.perProject?.[pid] ?? []) as any,
    });
  }

  it("LIST-1: 有项目 ⇒ 本项目会话 + 全局会话，且每条标出 scope", async () => {
    await seedForList({
      project: { id: "proj-a", name: "项目甲" },
      scoped: [{ id: "s-a1", title: "甲里的会话", messageCount: 3 }],
      global: [{ id: "s-g1", title: "全局会话", messageCount: 7 }],
    });
    const { createListSessionsTool } = await import("../core/session/tools");
    const out = (await createListSessionsTool().execute({}, { sessionId: "s-x" } as any)).output as string;

    expect(out, "本项目会话要在").toContain("s-a1");
    expect(out, "全局会话也要在 —— 否则 agent 发现不了跨作用域的目标（真机核对时只能手打 id）").toContain("s-g1");
    expect(out).toContain("scope=");
    expect(out, "作用域名字要看得懂").toContain("项目甲");
    expect(out, "要说明跨作用域委派是允许的").toMatch(/任意一条|cross-scope/);
  });

  it("LIST-2: 无项目 ⇒ 全局 + 各项目的会话", async () => {
    await seedForList({
      project: null,
      scoped: [{ id: "s-g1", title: "全局会话", messageCount: 1 }],
      global: [{ id: "s-g1", title: "全局会话", messageCount: 1 }],
      perProject: { "proj-a": [{ id: "s-a1", title: "甲的会话", messageCount: 2 }], "proj-b": [{ id: "s-b1", title: "乙的会话", messageCount: 4 }] },
    });
    const { createListSessionsTool } = await import("../core/session/tools");
    const out = (await createListSessionsTool().execute({}, { sessionId: "s-x" } as any)).output as string;

    expect(out).toContain("s-g1");
    expect(out).toContain("s-a1");
    expect(out).toContain("s-b1");
    // 去重：同一 id 只出现一次
    expect(out.split("s-g1").length - 1, "同一个会话不许重复列出").toBe(1);
  });

  it("LIST-3: 一个会话都没有时如实说明（不假装列了东西）", async () => {
    await seedForList({ project: null, scoped: [], global: [], perProject: {} });
    const { createListSessionsTool } = await import("../core/session/tools");
    const out = (await createListSessionsTool().execute({}, { sessionId: "s-x" } as any)).output as string;
    expect(out).toMatch(/没有任何会话|No sessions/);
  });
});
