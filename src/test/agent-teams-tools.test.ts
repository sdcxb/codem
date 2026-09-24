/**
 * 第 114 轮（O-23 根因）：agent-teams 工具面的**确定性**用例。
 *
 * ## 为什么加这一份
 *
 * `src/core/llm/index.ts` 注册这些工具用的是 **动态 import + `.then()`，而且不 await**：
 *
 * ```ts
 * import("../agent-teams/tools").then(({ registerAgentTeamsTools }) => { registerAgentTeamsTools(...) });
 * ```
 *
 * 于是这个文件的覆盖率**取决于那次动态 import 有没有在测试结束前跑完**：
 * 跑到了 → 11 个工厂函数算覆盖（第 109 轮实测 44.82%）；
 * 没跑到 → 整批算未覆盖（同一次审计实测 **24.13%**，跌破 35% 地板 ⇒ 那次"假红"）。
 *
 * 这份用例**同步 import** 并逐个调用工厂，把"看运气"变成"每次都一样"；
 * 顺带把 `registerAgentTeamsTools` 的 10 个工具与 shouldDefer 标记钉住。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentTeamsService } from "../core/provider/agent-teams-service";
import type { ToolContext } from "../core/llm/tools";
import {
  createAgentTeamsAddMemberTool,
  createAgentTeamsClaimTool,
  createAgentTeamsCreateTaskTool,
  createAgentTeamsCreateTool,
  createAgentTeamsDeleteTool,
  createAgentTeamsReassignTool,
  createAgentTeamsRemoveMemberTool,
  createAgentTeamsSendMessageTool,
  createAgentTeamsStatusTool,
  createAgentTeamsUpdateTool,
  registerAgentTeamsTools,
} from "../core/agent-teams/tools";

const FACTORIES: Array<[string, () => ReturnType<typeof createAgentTeamsCreateTool>]> = [
  ["agent_teams_create", createAgentTeamsCreateTool],
  ["agent_teams_add_member", createAgentTeamsAddMemberTool],
  ["agent_teams_remove_member", createAgentTeamsRemoveMemberTool],
  ["agent_teams_create_task", createAgentTeamsCreateTaskTool],
  ["agent_teams_reassign_task", createAgentTeamsReassignTool],
  ["agent_teams_claim_task", createAgentTeamsClaimTool],
  ["agent_teams_update_task", createAgentTeamsUpdateTool],
  ["agent_teams_send_message", createAgentTeamsSendMessageTool],
  ["agent_teams_status", createAgentTeamsStatusTool],
  ["agent_teams_delete", createAgentTeamsDeleteTool],
];

const ctx = (sessionId: string) => ({ sessionId } as unknown as ToolContext);

describe("agent-teams 工具面（确定性覆盖）", () => {
  beforeEach(() => {
    AgentTeamsService._reset();
  });

  it.each(FACTORIES)("AT-T1 %s 工厂产出合法工具定义", (id, make) => {
    const tool = make();
    expect(tool.id).toBe(id);
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters?.type).toBe("object");
    expect(String(tool.description ?? "").length).toBeGreaterThan(10);
  });

  it("AT-T2 registerAgentTeamsTools 注册 10 个工具、顺序固定、全部 shouldDefer（省 token 的 deferred schema）", () => {
    const got: Array<{ id: string; shouldDefer?: boolean; searchHint?: string }> = [];
    registerAgentTeamsTools((t) => got.push(t as unknown as { id: string }));
    expect(got).toHaveLength(10);
    expect(got.map((t) => t.id)).toEqual(FACTORIES.map(([id]) => id));
    expect(got.every((t) => t.shouldDefer === true)).toBe(true);
    expect(got.every((t) => typeof t.searchHint === "string" && t.searchHint.length > 0)).toBe(true);
  });

  it("AT-T3 create → 落库 → delete 走通，输出是「标题 + 正文」而不是空对象", async () => {
    const created = await createAgentTeamsCreateTool().execute({ name: "audit-team" }, ctx("sess-captain"));
    expect(created.title).toBe("agent_teams_create");
    expect(created.output).toContain("audit-team");

    const teams = AgentTeamsService.getInstance().listAll();
    expect(teams).toHaveLength(1);
    const teamId = teams[0].id;

    const deleted = await createAgentTeamsDeleteTool().execute({ team_id: teamId }, ctx("sess-captain"));
    expect(deleted.title).toBe("agent_teams_delete");
    expect(deleted.output.length).toBeGreaterThan(0);
    expect(AgentTeamsService.getInstance().listAll()).toHaveLength(0);
  });

  it("AT-T4 非队长调用队长专属工具 → 抛错（不静默失败、不当成功）", async () => {
    await createAgentTeamsCreateTool().execute({ name: "t2" }, ctx("sess-captain"));
    const teamId = AgentTeamsService.getInstance().listAll()[0].id;
    await expect(createAgentTeamsDeleteTool().execute({ team_id: teamId }, ctx("sess-intruder"))).rejects.toThrow();
    // 团队还在（失败的调用没有产生副作用）
    expect(AgentTeamsService.getInstance().listAll()).toHaveLength(1);
  });
});
