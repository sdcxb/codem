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
import { createSession, listSessions, forkSession } from "../core/storage/session";
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

  it("SUBCONV-3：判据与生成侧同步（id 形态变了必须一起改）", () => {
    /* 生成侧两个出处：spawn-in-process-provider.ts / runtime.ts，形态都是 sub-<ts>-<rand>。
       这里直接按那个形态造一个，确认被识别为子会话。 */
    mk("sub-1790000000000-abcdefghi", "proj");
    mk("real-session-1", "proj");
    expect(
      listSessions("proj").map((s) => s.id),
      "子智能体 id 形态未被识别",
    ).toEqual(["real-session-1"]);
  });
});
