/**
 * AgentProfileStorage — CRUD for agent_profiles table
 *
 * Profiles are persistent identity/domain/scope records for subagents.
 * Independent from v2_sessions.messages JSON — not affected by compaction.
 */

import { getDatabase } from "./database";
import { safeJsonParse } from "../utils/safe-json";

export interface AgentProfile {
  id: string;
  identity: string;
  domain: string;
  scope: string;
  skills?: string[];
  experience_summary?: string;
  created_at: number;
  updated_at: number;
}

function rowToProfile(row: any): AgentProfile {
  return {
    id: row.id,
    identity: row.identity,
    domain: row.domain,
    scope: row.scope,
    skills: row.skills ? safeJsonParse(row.skills, undefined) : undefined,
    experience_summary: row.experience_summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const AgentProfileStorage = {
  create(profile: Omit<AgentProfile, "created_at" | "updated_at">): AgentProfile {
    const db = getDatabase();
    if (!db) throw new Error("Database not loaded");
    const now = Date.now();
    db.run(
      `INSERT INTO agent_profiles (id, identity, domain, scope, skills, experience_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.id,
        profile.identity,
        profile.domain,
        profile.scope,
        profile.skills ? JSON.stringify(profile.skills) : null,
        profile.experience_summary || null,
        now,
        now,
      ],
    );
    return { ...profile, created_at: now, updated_at: now };
  },

  getById(id: string): AgentProfile | null {
    const db = getDatabase();
    if (!db) return null;
    const result = db.exec(`SELECT * FROM agent_profiles WHERE id = ?`, [id]);
    if (!result.length || !result[0].values.length) return null;
    const columns = result[0].columns;
    const row = result[0].values[0];
    const obj: any = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return rowToProfile(obj);
  },

  listAll(): AgentProfile[] {
    const db = getDatabase();
    if (!db) return [];
    const result = db.exec(`SELECT * FROM agent_profiles ORDER BY updated_at DESC`);
    if (!result.length || !result[0].values.length) return [];
    const columns = result[0].columns;
    return result[0].values.map((row) => {
      const obj: any = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return rowToProfile(obj);
    });
  },

  update(id: string, updates: Partial<Omit<AgentProfile, "id" | "created_at">>): void {
    const db = getDatabase();
    if (!db) return;
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "skills" && Array.isArray(value)) {
        fields.push("skills = ?");
        values.push(JSON.stringify(value));
      } else if (key !== "updated_at") {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    db.run(`UPDATE agent_profiles SET ${fields.join(", ")} WHERE id = ?`, values);
  },

  delete(id: string): void {
    const db = getDatabase();
    if (!db) return;
    db.run(`DELETE FROM agent_profiles WHERE id = ?`, [id]);
  },
};
