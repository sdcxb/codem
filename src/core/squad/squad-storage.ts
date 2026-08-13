/**
 * Squad Storage — DB CRUD for squads + squad_members tables
 *
 * All operations use the shared db instance from database.ts.
 * Tables are created in the SCHEMA constant (database.ts).
 */

import { getDatabase } from "../storage/database";

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

export const SquadStorage = {
  create(squad: Omit<SquadRow, "archived" | "created_at" | "updated_at">): SquadRow {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO squads (id, name, leader_agent_id, instructions, project_id, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [squad.id, squad.name, squad.leader_agent_id, squad.instructions ?? null, squad.project_id ?? null, now, now],
    );
    return { ...squad, archived: 0, created_at: now, updated_at: now };
  },

  getById(id: string): SquadRow | null {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM squads WHERE id = ?", [id]);
    if (result.length === 0) return null;
    return rowToSquad(result[0].values[0], result[0].columns);
  },

  listAll(includeArchived = false): SquadRow[] {
    const db = getDatabase();
    const sql = includeArchived
      ? "SELECT * FROM squads ORDER BY updated_at DESC"
      : "SELECT * FROM squads WHERE archived = 0 ORDER BY updated_at DESC";
    const result = db.exec(sql);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToSquad(row, result[0].columns));
  },

  listByProject(projectId: string): SquadRow[] {
    const db = getDatabase();
    const result = db.exec(
      "SELECT * FROM squads WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC",
      [projectId],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToSquad(row, result[0].columns));
  },

  update(id: string, updates: Partial<Pick<SquadRow, "name" | "instructions" | "leader_agent_id" | "project_id">>): void {
    const db = getDatabase();
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.instructions !== undefined) { fields.push("instructions = ?"); values.push(updates.instructions); }
    if (updates.leader_agent_id !== undefined) { fields.push("leader_agent_id = ?"); values.push(updates.leader_agent_id); }
    if (updates.project_id !== undefined) { fields.push("project_id = ?"); values.push(updates.project_id); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    db.run(`UPDATE squads SET ${fields.join(", ")} WHERE id = ?`, values);
  },

  archive(id: string): void {
    const db = getDatabase();
    db.run("UPDATE squads SET archived = 1, updated_at = ? WHERE id = ?", [Date.now(), id]);
  },

  delete(id: string): void {
    const db = getDatabase();
    db.run("DELETE FROM squads WHERE id = ?", [id]);
  },

  // ========== Member CRUD ==========

  addMember(member: Omit<SquadMemberRow, "created_at">): SquadMemberRow {
    const db = getDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO squad_members (id, squad_id, member_type, member_id, member_name, role_description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [member.id, member.squad_id, member.member_type, member.member_id, member.member_name, member.role_description ?? null, now],
    );
    return { ...member, created_at: now };
  },

  getMembers(squadId: string): SquadMemberRow[] {
    const db = getDatabase();
    const result = db.exec("SELECT * FROM squad_members WHERE squad_id = ? ORDER BY created_at ASC", [squadId]);
    if (result.length === 0) return [];
    return result[0].values.map((row) => rowToMember(row, result[0].columns));
  },

  removeMember(memberId: string): void {
    const db = getDatabase();
    db.run("DELETE FROM squad_members WHERE id = ?", [memberId]);
  },

  updateMemberRole(memberId: string, roleDescription: string): void {
    const db = getDatabase();
    db.run("UPDATE squad_members SET role_description = ? WHERE id = ?", [roleDescription, memberId]);
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
