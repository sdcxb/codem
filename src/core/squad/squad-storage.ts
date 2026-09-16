/**
 * Squad Storage — DB CRUD for squads + squad_members tables
 *
 * All operations use the shared db instance from database.ts.
 * Tables are created in the SCHEMA constant (database.ts).
 */

import { getDatabase, persistDatabase } from "../storage/database";
import { runGuarded } from "../storage/write-guard";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "../storage/domain-store";

// ========== Types ==========

export interface SquadRow {
  id: string;
  name: string;
  leader_agent_id: string;
  instructions: string | null;
  project_id: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface SquadMemberRow {
  id: string;
  squad_id: string;
  member_type: string;
  member_id: string;
  member_name: string;
  role_description: string | null;
  created_at: number;
}

// ========== Squad CRUD ==========

const SQUADS = "squads";
const MEMBERS = "squad_members";

function wireToSquad(row: Record<string, unknown>): SquadRow {
  return {
    id: String(row.id),
    name: String(row.name),
    leader_agent_id: String(row.leader_agent_id),
    instructions: (row.instructions as string) ?? null,
    project_id: (row.project_id as string) ?? null,
    archived: Number(row.archived ?? 0),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function squadToWire(row: SquadRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    leader_agent_id: row.leader_agent_id,
    instructions: row.instructions ?? null,
    project_id: row.project_id ?? null,
    archived: row.archived,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function wireToSquadMember(row: Record<string, unknown>): SquadMemberRow {
  return {
    id: String(row.id),
    squad_id: String(row.squad_id),
    member_type: String(row.member_type),
    member_id: String(row.member_id),
    member_name: String(row.member_name),
    role_description: (row.role_description as string) ?? null,
    created_at: Number(row.created_at),
  };
}

function memberToWire(row: SquadMemberRow): Record<string, unknown> {
  return {
    id: row.id,
    squad_id: row.squad_id,
    member_type: row.member_type,
    member_id: row.member_id,
    member_name: row.member_name,
    role_description: row.role_description ?? null,
    created_at: row.created_at,
  };
}

export const SquadStorage = {
  create(squad: Omit<SquadRow, "archived" | "created_at" | "updated_at">): SquadRow {
    const now = Date.now();
    const created: SquadRow = {
      ...squad,
      instructions: squad.instructions ?? null,
      project_id: squad.project_id ?? null,
      archived: 0,
      created_at: now,
      updated_at: now,
    };
    if (domainWrite(SQUADS, [squadToWire(created)], { scope: "squad.create", note: "团队未保存" })) {
      return created;
    }
    const db = getDatabase();
    db.run(
      `INSERT INTO squads (id, name, leader_agent_id, instructions, project_id, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [created.id, created.name, created.leader_agent_id, created.instructions, created.project_id, now, now],
    );
    persistDatabase();
    return created;
  },

  getById(id: string): SquadRow | null {
    const rust = domainReadOne(SQUADS, { id }, wireToSquad);
    if (rust !== undefined) return rust;
    const db = getDatabase();
    const result = db.exec("SELECT * FROM squads WHERE id = ?", [id]);
    if (result.length === 0) return null;
    return rowToSquad(result[0].values[0], result[0].columns);
  },

  listAll(includeArchived = false): SquadRow[] {
    const rust = domainReadMany(SQUADS, wireToSquad, includeArchived ? undefined : { archived: 0 });
    if (rust) return rust.sort((a, b) => b.updated_at - a.updated_at);
    const db = getDatabase();
    const sql = includeArchived
      ? "SELECT * FROM squads ORDER BY updated_at DESC"
      : "SELECT * FROM squads WHERE archived = 0 ORDER BY updated_at DESC";
    const result = db.exec(sql);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToSquad(row, result[0].columns));
  },

  listByProject(projectId: string): SquadRow[] {
    const rust = domainReadMany(SQUADS, wireToSquad, { project_id: projectId, archived: 0 });
    if (rust) return rust.sort((a, b) => b.updated_at - a.updated_at);
    const db = getDatabase();
    const result = db.exec(
      "SELECT * FROM squads WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC",
      [projectId],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToSquad(row, result[0].columns));
  },

  update(id: string, updates: Partial<Pick<SquadRow, "name" | "instructions" | "leader_agent_id" | "project_id">>): void {
    const fields: string[] = [];
    if (updates.name !== undefined) fields.push("name");
    if (updates.instructions !== undefined) fields.push("instructions");
    if (updates.leader_agent_id !== undefined) fields.push("leader_agent_id");
    if (updates.project_id !== undefined) fields.push("project_id");
    if (fields.length === 0) {
        // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
        console.warn(`[squad-storage.ts] update 调用未提供任何可更新字段 —— 本次没有任何写入`);
        return;
      }

    const rustCurrent = domainReadOne(SQUADS, { id }, wireToSquad);
    if (rustCurrent !== undefined) {
      if (rustCurrent === null) return; // 团队不存在：旧实现是 UPDATE 影响 0 行
      const next: SquadRow = {
        ...rustCurrent,
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.instructions !== undefined ? { instructions: updates.instructions } : {}),
        ...(updates.leader_agent_id !== undefined ? { leader_agent_id: updates.leader_agent_id } : {}),
        ...(updates.project_id !== undefined ? { project_id: updates.project_id } : {}),
        updated_at: Date.now(),
      };
      domainWrite(SQUADS, [squadToWire(next)], {
        mode: "replace",
        scope: "squad.update",
        note: "团队未更新（团队不存在或写入失败）",
      });
      return;
    }

    const db = getDatabase();
    const values: any[] = [];
    for (const key of fields) values.push((updates as Record<string, unknown>)[key]);
    values.push(Date.now());
    values.push(id);
    runGuarded(
      db,
      `UPDATE squads SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      values,
      { table: "squads", op: "update", id, from: "update" },
    );
    persistDatabase();
  },

  archive(id: string): void {
    const current = domainReadOne(SQUADS, { id }, wireToSquad);
    if (current !== undefined) {
      if (current === null || current.archived === 1) return;
      domainWrite(SQUADS, [squadToWire({ ...current, archived: 1, updated_at: Date.now() })], {
        mode: "replace",
        scope: "squad.archive",
        note: "团队未归档",
      });
      return;
    }
    const db = getDatabase();
    runGuarded(db, "UPDATE squads SET archived = 1, updated_at = ? WHERE id = ?", [Date.now(), id],
      { table: "squads", op: "archive", id, from: "archiveSquad" });
    persistDatabase();
  },

  delete(id: string): void {
    if (domainDelete(SQUADS, { id }, { scope: "squad.delete", note: "团队未删除" })) return;
    const db = getDatabase();
    db.run("DELETE FROM squads WHERE id = ?", [id]);
    persistDatabase();
  },

  // ========== Member CRUD ==========

  addMember(member: Omit<SquadMemberRow, "created_at">): SquadMemberRow {
    const now = Date.now();
    const created: SquadMemberRow = {
      ...member,
      role_description: member.role_description ?? null,
      created_at: now,
    };
    if (domainWrite(MEMBERS, [memberToWire(created)], { scope: "squad.addMember", note: "团队成员未保存" })) {
      return created;
    }
    const db = getDatabase();
    db.run(
      `INSERT INTO squad_members (id, squad_id, member_type, member_id, member_name, role_description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [created.id, created.squad_id, created.member_type, created.member_id, created.member_name, created.role_description, now],
    );
    persistDatabase();
    return created;
  },

  getMembers(squadId: string): SquadMemberRow[] {
    const rust = domainReadMany(MEMBERS, wireToSquadMember, { squad_id: squadId });
    if (rust) return rust.sort((a, b) => a.created_at - b.created_at);
    const db = getDatabase();
    const result = db.exec("SELECT * FROM squad_members WHERE squad_id = ? ORDER BY created_at ASC", [squadId]);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToMember(row, result[0].columns));
  },

  removeMember(memberId: string): void {
    if (domainDelete(MEMBERS, { id: memberId }, { scope: "squad.removeMember", note: "团队成员未移除" })) return;
    const db = getDatabase();
    db.run("DELETE FROM squad_members WHERE id = ?", [memberId]);
    persistDatabase();
  },

  updateMemberRole(memberId: string, roleDescription: string): void {
    const current = domainReadOne(MEMBERS, { id: memberId }, wireToSquadMember);
    if (current !== undefined) {
      if (current === null) return; // 成员不存在：旧实现是 UPDATE 影响 0 行
      domainWrite(MEMBERS, [memberToWire({ ...current, role_description: roleDescription })], {
        mode: "replace",
        scope: "squad.updateMemberRole",
        note: "成员角色未更新",
      });
      return;
    }
    const db = getDatabase();
    runGuarded(db, "UPDATE squad_members SET role_description = ? WHERE id = ?", [roleDescription, memberId],
      { table: "squad_members", op: "update-role", id: memberId, from: "updateMemberRole" });
    persistDatabase();
  },
};

// ========== Helpers ==========

function rowToSquad(row: any[], columns: string[]): SquadRow {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj as SquadRow;
}

function rowToMember(row: any[], columns: string[]): SquadMemberRow {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj as SquadMemberRow;
}