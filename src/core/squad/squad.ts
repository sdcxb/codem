/**
 * Squad Manager — Leader-Member 多智能体协同编排
 *
 * 【B 深合并（2026-09-07）语义升级】Squad 记录现作为「团队模板」使用：
 * agent-teams 运行时团队（docs/TEAM-CONSOLIDATION-PLAN.md）由模板实例化——
 * 模板的 leaderAgentId 即队长角色（captain），成员即角色集；squad_dispatch
 * 按模板 create 运行时团队并派发带依赖任务（确定性调度，替代旧的"开 Leader
 * 会话自行编排"路径）。存储/CRUD/监听保持兼容（模板管理 UI 与旧代码可用）。
 *
 * 核心职责：
 * 1. 管理 Squad（团队模板）生命周期（创建/编辑/归档）
 * 2. 管理模板成员（角色）（添加/移除/角色描述）
 * 3. 导出 TeamTemplate 供 agent-teams 建队
 * 4. （遗留）Leader roster 生成——仅兼容引用保留
 *
 * 与现有系统的关系：
 * - SubagentRuntime：agent-teams 成员 = 可续聊子 agent（spawn 于 service 层）
 * - DelegationOrchestrator：跨会话委派（独立于团队模板体系）
 * - AgentRegistry：模板 leader/member 角色名映射（角色描述为主，agentId 兼容保留）
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

export type SquadListener = (squadId: string) => void;

// ========== 团队模板（B 深合并：Squad → agent-teams 模板） ==========

/** 模板中的一个角色（对应运行时团队的一个成员）。 */
export interface TeamTemplateRole {
  name: string;
  description?: string | null;
  memberType: "agent" | "human";
}

/** 供 agent-teams 建队使用的模板视图。 */
export interface TeamTemplate {
  id: string;
  name: string;
  /** 队长角色名（原 leader 的显示名；agentId 兼容保留在 roles 中） */
  captainRole?: string | null;
  /** 角色集（human 角色运行时无法 spawn，由调用方决定是否跳过） */
  roles: TeamTemplateRole[];
  instructions?: string | null;
  projectId?: string | null;
}

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

  // ========== 团队模板导出（B 深合并） ==========

  /**
   * 把 Squad 导出为 agent-teams 团队模板（供 squad_dispatch / Phase2 UI 建队）。
   * 仅导出 agent 型成员为角色（human 成员保留在 roles 供 UI 展示，运行时跳过）。
   */
  toTeamTemplate(squadId: string): TeamTemplate | null {
    const squad = this.getSquad(squadId);
    if (!squad) return null;
    return {
      id: squad.id,
      name: squad.name,
      captainRole: squad.leader?.name ?? squad.leaderAgentId,
      roles: squad.members.map((m) => ({
        name: m.memberName,
        description: m.roleDescription,
        memberType: m.memberType,
      })),
      instructions: squad.instructions,
      projectId: squad.projectId,
    };
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
