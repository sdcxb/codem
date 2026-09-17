/**
 * AgentProfileStorage — CRUD for agent_profiles table
 *
 * Profiles are persistent identity/domain/scope records for subagents.
 * Independent from v2_sessions.messages JSON — not affected by compaction.
 */

import { reportPersistFailure } from "./persist-failure";
import { safeJsonParse } from "../utils/safe-json";
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
    /*
     * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，返回已构造的对象。
     *
     * 返回类型声明是具体的 `AgentProfile`（不是 `{ok:false}` 契约），且这里**不抛**
     * —— `getDatabase()` 在 rust 模式下会抛 "Database not initialized"，
     * 而调用方从没预期这个高频路径会抛（原来 B 态就是这么炸的）。
     * 返回 `created` 与旧实现在 A 态下的行为一致（旧实现无论 SQL 成败都返回它），
     * 差别只是失败现在**可见**：一条 persist 失败记录，而不是静默写进一份读不到的库。
     */
    reportPersistFailure(
      "agentProfile.create",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "智能体画像未保存",
    );
    return created;
  },

  getById(id: string): AgentProfile | null {
    const rust = domainReadOne(TABLE, { id }, wireToProfile);
    if (rust !== undefined) return rust;
    // 端口没接手 → 该域读不到这一行（旧库已从渲染进程移除）→ 如实返回 null
    return null;
  },

  listAll(): AgentProfile[] {
    const rust = domainReadMany(TABLE, wireToProfile);
    if (rust) return rust.sort((a, b) => b.updated_at - a.updated_at);
    // 端口没接手 → 该域的合理空结果（空数组）；与原来门控那句 `return [];` 语义一致
    return [];
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
    // B 态：原来静默 return = 调用方以为更新成功（假成功）。L4 收尾后一律如实上报。
    reportPersistFailure(
      "agentProfile.update",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "智能体画像未更新",
    );
  },

  delete(id: string): void {
    if (domainDelete(TABLE, { id }, { scope: "agentProfile.delete", note: "智能体画像未删除" })) return;
    // 删除静默失败 = 数据不一致（画像"看着还在"或"以为删了其实没删"）→ 如实上报
    reportPersistFailure(
      "agentProfile.delete",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "智能体画像未删除",
    );
  },
};