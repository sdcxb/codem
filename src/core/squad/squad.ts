/**
 * Squad Manager — Leader-Member 多智能体协同编排
 *
 * 核心职责：
 * 1. 管理 Squad 生命周期（创建/编辑/归档）
 * 2. 管理 Squad 成员（添加/移除/角色描述）
 * 3. Leader 路由：接收任务 → 触发 Leader agent → Leader @mention member → member 执行
 * 4. 成员执行复用 executeSessionTurn + WorktreeManager
 *
 * 与现有系统的关系：
 * - SubagentManager：管理临时子智能体（sub-xxx 会话），Squad 管理持久化 leader-member 关系
 * - DelegationOrchestrator：管理跨会话委派，Squad 内部委派走 DelegationOrchestrator
 * - AgentRegistry：Squad leader/member 都是 AgentRegistry 中注册的 agent
 */

import { SquadStorage, type SquadRow, type SquadMemberRow } from "./squad-storage";
import { getAgentRegistry, type AgentDefinition } from "../agent/agent";

// ========== Types ==========

export interface Squad {
  id: string;
  name: string;
  leaderAgentId: string;
  instructions: string | null;
  projectId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SquadMember {
  id: string;
  squadId: string;
  memberType: "agent" | "human";
  memberId: string;
  memberName: string;
  roleDescription: string | null;
  createdAt: number;
}

export interface SquadWithMembers extends Squad {
  members: SquadMember[];
  leader?: AgentDefinition;
}

export interface SquadDispatchResult {
  squadId: string;
  leaderSessionId: string;
  status: "dispatched" | "failed";
  error?: string;
}

export type SquadListener = (squadId: string) => void;

// ========== SquadManager ==========

class SquadManagerClass {
  private listeners: Set<SquadListener> = new Set();

  // ========== Squad CRUD ==========

  createSquad(params: {
    name: string;
    leaderAgentId: string;
    instructions?: string;
    projectId?: string;
  }): Squad {
    const id = `squad-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const row = SquadStorage.create({
      id,
      name: params.name,
      leader_agent_id: params.leaderAgentId,
      instructions: params.instructions ?? null,
      project_id: params.projectId ?? null,
    });
    // Leader is automatically a member
    const leader = getAgentRegistry().get(params.leaderAgentId);
    SquadStorage.addMember({
      id: `member-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      squad_id: id,
      member_type: "agent",
      member_id: params.leaderAgentId,
      member_name: leader?.name || params.leaderAgentId,
      role_description: "Squad Leader — receives work and routes to members",
    });
    this.notify(id);
    return rowToSquad(row);
  }

  getSquad(id: string): SquadWithMembers | null {
    const row = SquadStorage.getById(id);
    if (!row) return null;
    const members = SquadStorage.getMembers(id).map(rowToMember);
    const leader = getAgentRegistry().get(row.leader_agent_id);
    return { ...rowToSquad(row), members, leader };
  }

  listSquads(projectId?: string): SquadWithMembers[] {
    const rows = projectId
      ? SquadStorage.listByProject(projectId)
      : SquadStorage.listAll();
    return rows.map((row) => {
      const members = SquadStorage.getMembers(row.id).map(rowToMember);
      const leader = getAgentRegistry().get(row.leader_agent_id);
      return { ...rowToSquad(row), members, leader };
    });
  }

  updateSquad(id: string, updates: Partial<Pick<Squad, "name" | "instructions" | "leaderAgentId" | "projectId">>): void {
    SquadStorage.update(id, {
      name: updates.name,
      instructions: updates.instructions,
      leader_agent_id: updates.leaderAgentId,
      project_id: updates.projectId,
    });
    this.notify(id);
  }

  archiveSquad(id: string): void {
    SquadStorage.archive(id);
    this.notify(id);
  }

  deleteSquad(id: string): void {
    SquadStorage.delete(id);
    this.notify(id);
  }

  // ========== Member Management ==========

  addMember(squadId: string, params: {
    memberType: "agent" | "human";
    memberId: string;
    memberName: string;
    roleDescription?: string;
  }): SquadMember {
    const id = `member-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const row = SquadStorage.addMember({
      id,
      squad_id: squadId,
      member_type: params.memberType,
      member_id: params.memberId,
      member_name: params.memberName,
      role_description: params.roleDescription ?? null,
    });
    this.notify(squadId);
    return rowToMember(row);
  }

  removeMember(memberId: string, squadId: string): void {
    SquadStorage.removeMember(memberId);
    this.notify(squadId);
  }

  updateMemberRole(memberId: string, roleDescription: string, squadId: string): void {
    SquadStorage.updateMemberRole(memberId, roleDescription);
    this.notify(squadId);
  }

  // ========== Leader Roster Generation ==========

  /**
   * 生成 Leader 的 Squad Roster 系统提示词片段。
   * 包含：操作协议 + 成员名单 + 自定义指令。
   */
  generateSquadRoster(squadId: string): string | null {
    const squad = this.getSquad(squadId);
    if (!squad) return null;

    const lines: string[] = [];

    // Squad Operating Protocol
    lines.push("# Squad Operating Protocol");
    lines.push("You are the leader of this squad. Follow these rules:");
    lines.push("1. Read the issue/task description carefully.");
    lines.push("2. Decide which member should handle this work based on their role.");
    lines.push("3. Delegate by mentioning the member: `[@MemberName](mention://agent/<memberId>)`.");
    lines.push("4. Do NOT do the implementation yourself — delegate to the right member.");
    lines.push("5. After a member reports back, evaluate the result and decide the next step.");
    lines.push("6. Only mark the task as complete when the overall goal is met.");
    lines.push("7. Be terse — don't restate the issue body, the member can read it.");
    lines.push("");

    // Squad Roster
    lines.push("# Squad Roster");
    lines.push("| Member | Type | Role | Mention |");
    lines.push("|--------|------|------|---------|");
    for (const m of squad.members) {
      const mention = m.memberType === "agent"
        ? `[@${m.memberName}](mention://agent/${m.memberId})`
        : `[@${m.memberName}](mention://human/${m.memberId})`;
      const role = m.roleDescription || "—";
      lines.push(`| ${m.memberName} | ${m.memberType} | ${role} | ${mention} |`);
    }
    lines.push("");

    // Squad Instructions
    if (squad.instructions) {
      lines.push("# Squad Instructions");
      lines.push(squad.instructions);
      lines.push("");
    }

    return lines.join("\n");
  }

  // ========== Listeners ==========

  onSquadChange(listener: SquadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(squadId: string): void {
    this.listeners.forEach((l) => l(squadId));
  }
}

// ========== Singleton ==========

let instance: SquadManagerClass | null = null;

export function getSquadManager(): SquadManagerClass {
  if (!instance) instance = new SquadManagerClass();
  return instance;
}

// ========== Helpers ==========

function rowToSquad(row: SquadRow): Squad {
  return {
    id: row.id,
    name: row.name,
    leaderAgentId: row.leader_agent_id,
    instructions: row.instructions,
    projectId: row.project_id,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMember(row: SquadMemberRow): SquadMember {
  return {
    id: row.id,
    squadId: row.squad_id,
    memberType: row.member_type as "agent" | "human",
    memberId: row.member_id,
    memberName: row.member_name,
    roleDescription: row.role_description,
    createdAt: row.created_at,
  };
}
