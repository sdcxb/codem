/**
 * Squad Storage — DB CRUD for squads + squad_members tables
 *
 * All operations use the shared db instance from database.ts.
 * Tables are created in the SCHEMA constant (database.ts).
 */

import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "../storage/domain-store";
import { reportPersistFailure } from "../storage/persist-failure";

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
    /**
     * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，返回内存里那份已构造好的对象。
     * 与原来 B 态（端口在、镜像未就绪）的行为完全一致 —— 差别只是失败现在**可见**。
     */
    reportPersistFailure(
      "squad.create",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "团队未保存",
    );
    return created;
  },

  getById(id: string): SquadRow | null {
    const rust = domainReadOne(SQUADS, { id }, wireToSquad);
    if (rust !== undefined) return rust;
    // 端口没接手 → 该域读不到这一行（旧库已从渲染进程移除）→ 如实返回 null
    return null;
  },

  listAll(includeArchived = false): SquadRow[] {
    const rust = domainReadMany(SQUADS, wireToSquad, includeArchived ? undefined : { archived: 0 });
    if (rust) return rust.sort((a, b) => b.updated_at - a.updated_at);
    /**
     * **旧库读取已删除**（L4 收尾）：端口没接手 → 该域的合理空结果（空数组）。
     * 与原来门控里那句 `if (!shouldFallbackToLegacy()) return [];` **语义一致**。
     */
    return [];
  },

  /**
   * 按项目列团队。
   *
   * ## 任务 C-6：原来把 `{ archived: 0 }` **硬编码**在 where 里，没有"看归档"的出口
   *
   * 归档是这个域在 UI 上**唯一的移除入口**（`SquadStorage.delete` 也在，
   * 但界面把它叫"删除"），而读取侧永远过滤归档 → 误点一次"归档"就等于永久删除：
   * 数据还在库里，但看不到、派发不了、也**没有任何恢复入口**
   * （全仓 `grep unarchive|取消归档` 在修复前 = 0 命中）。
   *
   * 现在给出 `includeArchived` 开关（**默认行为一个字没变**：仍然只列未归档），
   * UI 侧据此做一个"显示已归档 + 恢复"的开关即可闭合这个不可逆路径（见报告）。
   */
  listByProject(projectId: string, options: { includeArchived?: boolean } = {}): SquadRow[] {
    const where: Record<string, unknown> = { project_id: projectId };
    if (!options.includeArchived) where.archived = 0;
    const rust = domainReadMany(SQUADS, wireToSquad, where);
    if (rust) return rust.sort((a, b) => b.updated_at - a.updated_at);
    // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致）
    return [];
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

    /**
     * **旧库更新已删除**（L4 收尾）：端口没接手时**如实上报为"未更新"**。
     * `update` 的契约是 void，静默 return 就是 B 类假成功。
     */
    reportPersistFailure(
      "squad.update",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "团队未更新",
    );
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
    // 旧库更新已删除（L4）：端口没接手 → 如实上报为"归档状态未更新"
    reportPersistFailure(
      "squad.archive",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "团队归档状态未更新",
    );
  },

  delete(id: string): void {
    if (domainDelete(SQUADS, { id }, { scope: "squad.delete", note: "团队未删除" })) return;
    // 旧库删除已删除（L4）：端口没接手 → 如实上报为"未删除"（不静默当成删成功）
    reportPersistFailure(
      "squad.delete",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "团队未删除",
    );
  },

  /**
   * **取消归档**（任务 C-6）。
   *
   * ## 为什么必须有它
   *
   * `archive()` 一直是这个域 UI 上唯一的移除入口，而所有生产读都过滤归档
   * （`listByProject` 甚至硬编码 `{ archived: 0 }`）—— 于是"归档"事实上等于
   * **不可逆删除**：行还在库里，但列表里没有、无法派发、没有恢复入口。
   * 修复前全仓 `grep unarchive|取消归档` = 0 命中，这就是证据。
   *
   * ## 语义
   *
   * - 行不存在 → **什么都不写**（旧实现的 `UPDATE … 影响 0 行`；不能 upsert 出幽灵行）；
   * - 已经是 `archived = 0` → 什么都不写（幂等，"恢复一个没归档的团队"不是写操作）；
   * - 否则写回 `archived = 0` 并顶 `updated_at`（与 `archive()` 对称）。
   *
   * 返回值刻意是 `boolean`：调用方（UI 的"恢复"按钮）需要知道**这次到底恢复没有**
   * —— `archive()` 的 void 契约在有"恢复"这个动作之后就表达不了"操作没生效"了。
   */
  unarchive(id: string): boolean {
    const current = domainReadOne(SQUADS, { id }, wireToSquad);
    if (current === undefined) {
      // B 态：端口在、镜像未接手 → 如实上报（绝不静默当成"已恢复"）
      reportPersistFailure(
        "squad.unarchive",
        new Error("端口未接手（该域镜像未注册或未就绪）"),
        "团队未取消归档",
      );
      return false;
    }
    if (current === null) return false; // 团队不存在：旧实现是 UPDATE 影响 0 行
    if (current.archived === 0) return true; // 本来就没归档：幂等成功

    return domainWrite(SQUADS, [squadToWire({ ...current, archived: 0, updated_at: Date.now() })], {
      mode: "replace",
      scope: "squad.unarchive",
      note: "团队未取消归档",
    });
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
    /**
     * **旧库写入已删除**（L4 收尾）：端口没接手时如实上报，返回内存里那份已构造好的对象。
     * 与原来 B 态（端口在、镜像未就绪）的行为完全一致 —— 差别只是失败现在**可见**。
     */
    reportPersistFailure(
      "squad.addMember",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "团队成员未添加",
    );
    return created;
  },

  getMembers(squadId: string): SquadMemberRow[] {
    const rust = domainReadMany(MEMBERS, wireToSquadMember, { squad_id: squadId });
    if (rust) return rust.sort((a, b) => a.created_at - b.created_at);
    // 端口没接手 → 该域的合理空结果（与原来门控那句 `return []` 语义一致）
    return [];
  },

  removeMember(memberId: string): void {
    if (domainDelete(MEMBERS, { id: memberId }, { scope: "squad.removeMember", note: "团队成员未移除" })) return;
    // 旧库删除已删除（L4）：端口没接手 → 如实上报为"未移除"
    reportPersistFailure(
      "squad.removeMember",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "团队成员未移除",
    );
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
    // 旧库更新已删除（L4）：端口没接手 → 如实上报为"角色未更新"
    reportPersistFailure(
      "squad.updateMemberRole",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "成员角色未更新",
    );
  },
};

// ========== Helpers ==========
//
// `rowToSquad` / `rowToMember`（按 `db.exec` 的 `values` + `columns` 拼行的解码器）
// 在 L4 收尾时随旧库读取分支一并删除：端口侧的行是**线协议行**（对象），
// 由 `wireToSquad` / `wireToSquadMember` 解码，不再有"按列数组还原"这条路。