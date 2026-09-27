/**
 * SUBCONV —— **子智能体不作为单独的对话目录**（第 188 轮，用户报的 bug）。
 *
 * 用户原话：「项目对话里调用子智能体的时候，会在左侧边栏的项目对话目录，增加子智能体的条目，
 * 这个逻辑不对。**子智能体不作为单独的对话目录**。」
 *
 * ## 成因
 *
 * C-2 那轮给子智能体补了 `sessions` 行（否则它的消息/事件/成本全被外键拒掉），
 * 并按"不凭空造项目归属"的原则**照抄了父会话的 `project_id`**。
 * 而侧栏正是按 `project_id` 列会话 ⇒ 子会话和真会话一样出现在项目目录里。
 *
 * ## 本文件的判据（两条，必须同时成立）
 *
 * - SUBCONV-1：子智能体会话**不进** `listSessions()`；
 * - SUBCONV-2：**分叉会话必须仍在**列表里 —— 分叉是一个真会话（用户要能切回去继续聊），
 *   与子智能体轨迹不是一回事。第一版按 `parentId` 一刀切，正是被这条当场纠正的。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { createSession, listSessions, forkSession, getSession } from "../core/storage/session";
import { ensureSubagentSession } from "../core/subagent/subagent-session";

const mk = (id: string, projectId = "proj", parentId: string | null = null) =>
  createSession({ id, projectId, title: id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, parentId });

describe("SUBCONV：子智能体不作为单独的对话目录", () => {
  beforeEach(() => {
    setStoragePort(createFakeStoragePort());
  });

  it("SUBCONV-1：调用子智能体后，父会话的对话列表里**不许**出现子智能体条目", () => {
    mk("p1", "proj");
    expect(listSessions("proj").map((s) => s.id), "前提：父会话应当在列表里").toEqual(["p1"]);

    /* 复刻真实调用：子智能体 spawn → 补 sessions 行（与父会话同项目、parent_id 指向父） */
    const childId = `sub-${Date.now()}-abc123456`;
    const ok = ensureSubagentSession(childId, "p1");
    expect(ok, "子会话行应当建成功（否则消息/事件写不进库）").toBe(true);

    const ids = listSessions("proj").map((s) => s.id);
    expect(
      ids,
      `子智能体会话 ${childId} 出现在对话目录里了 —— 用户明确要求「子智能体不作为单独的对话目录」。\n` +
        `它仍然留在 sessions 表里（消息/事件/成本需要那行过外键），只是不作为目录出现。`,
    ).toEqual(["p1"]);
  });

  it("SUBCONV-2：分叉会话**必须仍在**列表里（它是真会话，不是轨迹）", () => {
    mk("p1", "proj");
    const child = forkSession("p1", "p2", "proj", "P2");
    expect(child?.id, "前提：分叉应当成功").toBe("p2");

    expect(
      listSessions("proj").map((s) => s.id).sort(),
      "分叉会话被一起过滤掉了 —— 分叉是一个用户可以切回去继续聊的真会话，" +
        "不能和子智能体轨迹用同一条判据（第一版按 parentId 一刀切就是这么错的）",
    ).toEqual(["p1", "p2"]);
  });

  it("SUBCONV-3：显式列**优先**（置了标志就必须挡掉，不管 id 长什么样）", () => {
    /* ⚠️ 第 191 轮起判据是**两条**：显式列 `is_internal`（新数据）+ 旧形态兜底（老数据）。
       所以本用例只钉"显式列这一半"：换一个**不像** sub- 的 id、但置了标志，也必须被挡掉。
       （"长得像 sub- 但没置标志"那半 **不再** 要求放行 —— 191 轮的老数据兜底会认它，
         那是刻意的：用户机器上老数据就是那个形态。见下面 SUBCONV-5。） */
    createSession({
      id: "internal-trace-1",
      projectId: "proj",
      title: "内部轨迹",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      isInternal: true,
    });
    createSession({
      id: "real-session-1",
      projectId: "proj",
      title: "对话 1",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    expect(
      listSessions("proj").map((s) => s.id).sort(),
      "置了 is_internal 的必须挡掉（不管 id 是什么形态），没置且形态不像的必须留下",
    ).toEqual(["real-session-1"]);
  });

  /**
   * SUBCONV-5：**老数据兜底**要认旧代码写下的两种形态（第 191 轮补）。
   *
   * 这一条的存在本身要记一笔：第 190 轮我在**自己这台机器**上查库、看到 `sub-%` 是 0 行，
   * 就断言「老数据里没有子智能体会话条目，这个前提不成立」；
   * **用户当场纠正：「我是再另一个电脑里安装后测试的，你不要这么机械！」**
   * 他那台机器上旧版本确实把子智能体会话写进了 `sessions` 表、也确实显示在侧栏，
   * 而 `is_internal` 是后来才加的列、老行是 0 ⇒ 光靠显式列**盖不住**老数据。
   */
  it("SUBCONV-5：老形态（id `sub-…` / 标题 `子智能体 …`）也要被挡掉", () => {
    createSession({
      id: "sub-1790000000000-oldstyle1",
      projectId: "proj",
      title: "子智能体 sub-1790000000000-oldstyle1",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      // 刻意不置 isInternal —— 模拟 189 之前建的行
    });
    createSession({
      id: "1790000000001-oldstyle2",
      projectId: "proj",
      title: "子智能体 1790000000001-oldstyle2", // id 不是 sub- 形态，但标题是 childTitle 写的
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
    createSession({
      id: "1790000000002-real",
      projectId: "proj",
      title: "对话 1",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    expect(
      listSessions("proj").map((s) => s.id),
      "两种旧形态都该被挡掉；普通标题/id 的真对话必须留下 ——" +
        "误判（藏掉真对话）比漏判严重，所以判据只认旧代码**写死的形态**，不做推测",
    ).toEqual(["1790000000002-real"]);
  });

  it("SUBCONV-4：`is_internal` 必须真的落库、真的读回来（不是只存在于内存）", () => {
    mk("p1", "proj"); // 父会话必须先存在，否则 ensureSubagentSession 按约定不建行
    const childId = `sub-${Date.now()}-abc654321`;
    expect(ensureSubagentSession(childId, "p1"), "子会话行应当建成功").toBe(true);
    const row = listSessions("proj");
    expect(row.map((s) => s.id), "子会话不该进列表").not.toContain(childId);
    /* 直接查那一行：标志必须写进去了（建行走 insert，构造器漏列 = 静默丢值） */
    const one = getSession(childId);
    expect(one, "子会话行应当存在（消息/事件/成本依赖它过外键）").toBeTruthy();
    expect(one!.isInternal, "`is_internal` 没落到库里 —— `sessionToWire` 漏了这一列").toBe(true);
  });
});
