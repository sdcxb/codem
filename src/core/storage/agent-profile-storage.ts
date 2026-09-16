/**
 * AgentProfileStorage — CRUD for agent_profiles table
 *
 * Profiles are persistent identity/domain/scope records for subagents.
 * Independent from v2_sessions.messages JSON — not affected by compaction.
 */

import { getDatabase, persistDatabase } from "./database";
import { safeJsonParse } from "../utils/safe-json";
import { runGuarded } from "./write-guard";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

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

const TABLE = "agent_profiles";

/** 线协议行（`skills` 是 JSON 文本）→ `AgentProfile` */
function wireToProfile(row: Record<string, unknown>): AgentProfile {
  const skills = row.skills as string | null;
  return {
    id: String(row.id),
    identity: String(row.identity),
    domain: String(row.domain),
    scope: String(row.scope),
    skills: skills ? safeJsonParse(skills, undefined) : undefined,
    experience_summary: (row.experience_summary as string) ?? undefined,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** `AgentProfile` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function profileToWire(p: AgentProfile): Record<string, unknown> {
  return {
    id: p.id,
    identity: p.identity,
    domain: p.domain,
    scope: p.scope,
    skills: p.skills ? JSON.stringify(p.skills) : null,
    experience_summary: p.experience_summary ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export const AgentProfileStorage = {
  create(profile: Omit<AgentProfile, "created_at" | "updated_at">): AgentProfile {
    const now = Date.now();
    const created: AgentProfile = { ...profile, created_at: now, updated_at: now };
    if (domainWrite(TABLE, [profileToWire(created)], { scope: "agentProfile.create", note: "智能体画像未保存" })) {
      return created;
    }
    const db = getDatabase();
    if (!db) throw new Error("Database not loaded");
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
    persistDatabase();
    return created;
  },

  getById(id: string): AgentProfile | null {
    const rust = domainReadOne(TABLE, { id }, wireToProfile);
    if (rust !== undefined) return rust;
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
    const rust = domainReadMany(TABLE, wireToProfile);
    if (rust) return rust.sort((a, b) => b.updated_at - a.updated_at);
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
    // 迁移期：读出整行 → 应用改动 → 整体写回。
    // 旧实现动态拼 `SET`（keys 来自调用方）；镜像路径只认已知列，
    // 未知 key 一律忽略（否则任意字段都会被塞进 upsert 行）。
    const current = domainReadOne(TABLE, { id }, wireToProfile);
    if (current !== undefined) {
      if (current === null) return; // 画像不存在：与旧实现（UPDATE 影响 0 行）一致
      const next: AgentProfile = { ...current, updated_at: Date.now() };
      if (updates.identity !== undefined) next.identity = updates.identity;
      if (updates.domain !== undefined) next.domain = updates.domain;
      if (updates.scope !== undefined) next.scope = updates.scope;
      if (updates.skills !== undefined && Array.isArray(updates.skills)) next.skills = updates.skills;
      if (updates.experience_summary !== undefined) {
        next.experience_summary = updates.experience_summary || undefined;
      }
      domainWrite(TABLE, [profileToWire(next)], {
        mode: "replace",
        scope: "agentProfile.update",
        note: "智能体画像未更新（画像不存在或写入失败）",
      });
      return;
    }
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
    runGuarded(db, `UPDATE agent_profiles SET ${fields.join(", ")} WHERE id = ?`, values,
    { table: "agent_profiles", op: "update", id, from: "updateAgentProfile" });
  },

  delete(id: string): void {
    if (domainDelete(TABLE, { id }, { scope: "agentProfile.delete", note: "智能体画像未删除" })) return;
    const db = getDatabase();
    if (!db) return;
    db.run(`DELETE FROM agent_profiles WHERE id = ?`, [id]);
    persistDatabase();
  },
};