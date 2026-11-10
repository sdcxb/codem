/**
 * 团队记忆（25:668）：B 收口后不再有独立 Bot 产品层，团队记忆直接长在
 * **现有 agent-teams 团队**与普通会话上。
 *
 * 归属键是 `Team.id`（AgentTeam id），不是群会话：同一团队的多个群/成员会话
 * 读到同一份事实；别的团队、非成员会话拿不到。
 *
 * 这里不新造存储、不新造审批：条目就是 `MemoryEntry { scope: "team", teamId }`，
 * 走现有 MemoryService 的注入顺序 `platform → project → team → conversation`。
 */
import { getMemoryService, type MemoryAddResult } from "./memory";
import { AgentTeamsService } from "../provider/agent-teams-service";

export interface RememberTeamMemoryInput {
  teamId: string;
  key: string;
  content: string;
  projectId?: string;
}

export type RememberTeamMemoryResult =
  | { ok: true; id: string; scope: "team"; teamId: string; status: "active" | "pending"; message?: string }
  | {
      ok: false;
      reason: "invalid_input" | "team_not_found" | "memory_unavailable" | "capacity" | "persist" | "invalid";
      message: string;
    };

/**
 * 会话 → 所属团队。普通会话、agent-teams 队长会话、成员子会话都按这个入口解析；
 * 这是团队记忆自动注入的唯一判据（不再依赖 Bot 身份）。
 */
export function resolveTeamIdForSession(sessionId: string): string | undefined {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return undefined;
  try {
    const teams = AgentTeamsService.getInstance().listAll();
    for (const team of teams) {
      if (team.captainSessionId === id) return team.id;
      const member = team.members.find((item) => item.id === id);
      if (member && member.status !== "removed") return team.id;
    }
  } catch {
    /* 团队服务不可用 ⇒ 本轮没有团队上下文，不注入、不编造 */
  }
  return undefined;
}

/** 团队是否存在且未归档（memory 写入前校验归属，避免把记忆挂到不存在的团队） */
export function activeTeamExists(teamId: string): boolean {
  const id = typeof teamId === "string" ? teamId.trim() : "";
  if (!id) return false;
  try {
    return AgentTeamsService.getInstance().listAll().some((team) => team.id === id);
  } catch {
    return false;
  }
}

/**
 * 写一条团队记忆。**只有用户在 TaskCenter 团队页显式提交时调用**；
 * 成员 Bot/模型没有写入口（B 收口后连 Bot 工具都不存在）。
 */
export function rememberTeamMemory(input: RememberTeamMemoryInput): RememberTeamMemoryResult {
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  if (!teamId) return { ok: false, reason: "invalid_input", message: "teamId 不能为空" };
  const key = typeof input.key === "string" ? input.key.trim() : "";
  const content = typeof input.content === "string" ? input.content : "";
  if (!key || !content.trim()) {
    return { ok: false, reason: "invalid_input", message: "key 与 content 都不能为空" };
  }
  if (!activeTeamExists(teamId)) {
    return { ok: false, reason: "team_not_found", message: `找不到团队 ${teamId}（不存在或已归档）` };
  }

  let service: ReturnType<typeof getMemoryService>;
  try {
    service = getMemoryService();
  } catch (e) {
    return {
      ok: false,
      reason: "memory_unavailable",
      message: `记忆服务不可用：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let result: MemoryAddResult;
  try {
    result = service.add({
      scope: "team",
      teamId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      key,
      content,
      source: "auto",
      status: "active",
    });
  } catch (e) {
    return {
      ok: false,
      reason: "persist",
      message: `团队记忆写入抛错：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!result.ok) {
    const reason = result.error === "capacity" || result.error === "persist" || result.error === "invalid"
      ? result.error
      : "persist";
    return { ok: false, reason, message: result.message ?? "团队记忆写入失败" };
  }
  return {
    ok: true,
    id: result.entry?.id ?? "",
    scope: "team",
    teamId,
    status: "active",
    ...(result.message ? { message: result.message } : {}),
  };
}

/** 团队记忆的只读预览（TaskCenter 团队页用；空串 = 还没有团队记忆） */
export function readTeamMemoryPreview(teamId: string, projectId?: string): string {
  const id = typeof teamId === "string" ? teamId.trim() : "";
  if (!id) return "";
  try {
    const service = getMemoryService();
    return service.buildMemoryPrompt("team", projectId, undefined, { teamId: id });
  } catch {
    return "";
  }
}
