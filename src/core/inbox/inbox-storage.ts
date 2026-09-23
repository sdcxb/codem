/**
 * Inbox Storage — DB CRUD for inbox table
 */

import { reportPersistFailure } from "../storage/persist-failure";
import {
  domainDelete,
  domainDeleteWhere,
  domainReadMany,
  domainReadOne,
  domainWrite,
} from "../storage/domain-store";

// ========== Types ==========

export type InboxCategory = "issue" | "squad" | "delegation" | "automation" | "system" | "agent";
export type InboxPriority = "low" | "normal" | "high" | "urgent";

export interface InboxRow {
  id: string;
  category: string;
  title: string;
  body: string | null;
  source_type: string | null;
  source_id: string | null;
  project_id: string | null;
  squad_id: string | null;
  issue_id: string | null;
  priority: string;
  read: number;
  archived: number;
  created_at: number;
}

// ========== CRUD ==========

const TABLE = "inbox";
/** 通知保留期：只增不减会让数据库持续膨胀（自动化触发器每次触发都插一行） */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 这一行的 `project_id` 算不算"全局通知"？
 *
 * 三种写法都要算（第 72 轮真机核对时三种都见到了）：
 *   - `null`：列可空，正常写入路径（`projectId ?? null`）落的就是它；
 *   - `undefined`：端口镜像里字段缺失时读出来就是 undefined；
 *   - `""`：`??` **不会**把空串换成 null（空串不是 null），所以调用方传
 *     `projectId: ""` 时会原样落库 —— 委派那条链路上 `projectId` 正是空串
 *     （全局会话没有项目）。
 *
 * 只认 `null` 的写法会让 `""` 的行变成"既不属于任何项目、又不算全局"的幽灵行：
 * 徽标数得到（不带边界），列表里永远看不到（被当成"别的项目"过滤掉）。
 */
function isGlobalProjectId(pid: string | null | undefined): boolean {
  return pid === null || pid === undefined || pid === "";
}

/** 线协议行就是 snake_case，直接用（字段显式列出，避免多余列混进返回值） */
function wireToInbox(row: Record<string, unknown>): InboxRow {
  return {
    id: String(row.id),
    category: String(row.category),
    title: String(row.title),
    body: (row.body as string) ?? null,
    source_type: (row.source_type as string) ?? null,
    source_id: (row.source_id as string) ?? null,
    project_id: (row.project_id as string) ?? null,
    squad_id: (row.squad_id as string) ?? null,
    issue_id: (row.issue_id as string) ?? null,
    priority: String(row.priority ?? "normal"),
    read: Number(row.read ?? 0),
    archived: Number(row.archived ?? 0),
    created_at: Number(row.created_at),
  };
}

/** `InboxRow` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function inboxToWire(row: InboxRow): Record<string, unknown> {
  return { ...row };
}

export const InboxStorage = {
  create(item: Omit<InboxRow, "read" | "archived" | "created_at">): InboxRow {
    const now = Date.now();
    const created: InboxRow = {
      ...item,
      body: item.body ?? null,
      source_type: item.source_type ?? null,
      source_id: item.source_id ?? null,
      project_id: item.project_id ?? null,
      squad_id: item.squad_id ?? null,
      issue_id: item.issue_id ?? null,
      priority: item.priority || "normal",
      read: 0,
      archived: 0,
      created_at: now,
    };

    if (domainWrite(TABLE, [inboxToWire(created)], { scope: "inbox.create", note: "通知未保存" })) {
      // 顺带清掉过期通知。**必须走域端口**：镜像已接手时若只删旧库，
      // 下一次整行写回会把旧库里"其实早已被清掉"的行重新插回 Rust（复活已删除数据）。
      const removed = domainDeleteWhere(
        TABLE,
        (row) => Number(row.created_at) < now - RETENTION_MS,
        "id",
        { scope: "inbox.sweep", note: "过期通知未清理" },
      );
      if (removed !== null) return created;
      // 写入已接手、但清理没接手（两者用同一个端口判据，理论上不可达）：
      // 如实上报"清理没做"，**不要**掉进下面那句"通知未保存"（那会把一次成功的写入说成失败）。
      reportPersistFailure(
        "inbox.sweep",
        new Error("端口未接手（该域镜像未注册或未就绪）"),
        "过期通知未清理",
      );
      return created;
    }

    /**
     * **旧库写入已删除**（L4 第 18 轮）：端口没接手时**如实上报**，不再写旧库。
     *
     * 返回值形状（`InboxRow`）保持不变 —— 调用方拿它去更新界面，但这次上报会通过
     * `codem:persist-failed` 让"没保存成功"可见，绝不静默当成写入成功。
     */
    reportPersistFailure(
      "inbox.create",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知未保存",
    );
    return created;
  },

  /**
   * 列出通知。
   *
   * ## 任务 C-6：`{ archived: 0 }` 原来是**恒传**的，没有"看归档"的出口
   *
   * `archive()` 是这个域 UI 上唯一的移除入口，而读取永远过滤归档
   * → 误点一次"归档"就等于永久删除（行还在库里，但看不到、数不到、无恢复入口）。
   * 现在加 `includeArchived`（**默认行为不变**：仍然只列未归档）。
   *
   * ## 第 72 轮：`projectId` 三态（用户报的"徽标有 4 条、收件箱空的"就是这个）
   *
   * 真机现场：任务交接（委派）完成后侧栏徽标显示「任务管理（4 条未读）」，
   * 点进收件箱**一条都没有**，界面还写着"尚未选择项目，通知按项目聚合"。
   * 查库确认：那 4 条通知的 `project_id` 是 **NULL（全局通知）**，
   * 而界面层在"没有当前项目"时**直接清空列表**（`InboxTab` 的早退分支）——
   * 于是同一个事实在徽标（不带过滤 → 数到 4）和列表（无项目 → 0 条）上完全相反。
   *
   * 现在把边界写成**显式三态**，不再用"假值"表达三件不同的事：
   *   - `undefined`：**不设边界**，返回所有项目的通知（徽标的口径，保持不变）；
   *   - `null`：**只返回全局通知**（`project_id IS NULL`）—— "没打开项目"时的正确口径；
   *   - 字符串：该项目的通知 **+ 全局通知**（全局通知与项目无关，任何项目下都该看得见）。
   */
  listAll(filters?: {
    projectId?: string | null;
    unreadOnly?: boolean;
    category?: InboxCategory;
    includeArchived?: boolean;
  }): InboxRow[] {
    const rust = domainReadMany(TABLE, wireToInbox, filters?.includeArchived ? undefined : { archived: 0 });
    if (rust) {
      const pid = filters?.projectId;
      const filtered = rust.filter((r) => {
        if (pid === undefined) {
          // 不设边界
        } else if (pid === null) {
          if (!isGlobalProjectId(r.project_id)) return false; // 只要全局通知
        } else if (r.project_id !== pid && !isGlobalProjectId(r.project_id)) {
          return false; // 本项目 + 全局
        }
        if (filters?.unreadOnly && r.read !== 0) return false;
        if (filters?.category && r.category !== filters.category) return false;
        return true;
      });
      // 与旧 SQL 一致：created_at DESC + LIMIT 100
      return filtered.sort((a, b) => b.created_at - a.created_at).slice(0, 100);
    }
    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果
    return [];
  },

  markRead(id: string): void {
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current !== undefined) {
      // 行不存在时用 `current === null` 判断，**不要**写成 `!current`：
      // 那是"假值"判断，行不存在与"字段为空"会被混为一谈（这里踩过一次）。
      if (current === null || current.read === 1) return;
      domainWrite(TABLE, [inboxToWire({ ...current, read: 1 })], {
        mode: "replace",
        scope: "inbox.markRead",
        note: "通知未标记为已读",
      });
      return;
    }
    // **旧库更新已删除**（L4 第 18 轮）：端口没接手时如实上报，绝不静默当成标记成功
    reportPersistFailure(
      "inbox.markRead",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知已读状态未更新",
    );
  },

  /**
   * 全部已读。`projectId` 与 `listAll` **同一套三态语义**。
   *
   * ⚠️ 第 72 轮修正：原来写的是 `!projectId || row.project_id === projectId || row.project_id === null`，
   * 传 `null`（"没打开项目"）时 `!projectId` 为真 ⇒ **会把别的项目的通知也一并标成已读** ——
   * 用户在无项目状态下点一次"全部已读"，别的项目的未读就静默消失了。
   */
  markAllRead(projectId?: string | null): void {
    const rust = domainReadMany(TABLE, wireToInbox, { read: 0 });
    if (rust) {
      const targets = rust.filter((row) => {
        if (projectId === undefined) return true; // 不设边界（调用方要清全部）
        if (projectId === null) return isGlobalProjectId(row.project_id); // 只清全局
        return row.project_id === projectId || isGlobalProjectId(row.project_id);
      });
      if (targets.length === 0) return;
      domainWrite(TABLE, targets.map((row) => inboxToWire({ ...row, read: 1 })), {
        mode: "replace",
        scope: "inbox.markAllRead",
        note: "通知未批量标记为已读",
      });
      return;
    }
    // **旧库更新已删除**（L4 第 18 轮）：端口没接手时如实上报
    reportPersistFailure(
      "inbox.markAllRead",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知已读状态未更新",
    );
  },

  archive(id: string): void {
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current !== undefined) {
      if (current === null || current.archived === 1) return;
      domainWrite(TABLE, [inboxToWire({ ...current, archived: 1 })], {
        mode: "replace",
        scope: "inbox.archive",
        note: "通知未归档",
      });
      return;
    }
    // **旧库更新已删除**（L4 第 18 轮）：端口没接手时如实上报
    reportPersistFailure(
      "inbox.archive",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知归档状态未更新",
    );
  },

  delete(id: string): void {
    if (domainDelete(TABLE, { id }, { scope: "inbox.delete", note: "通知未删除" })) return;
    // **旧库删除已删除**（L4 第 18 轮）：端口没接手时如实上报，绝不静默当成删成功
    reportPersistFailure(
      "inbox.delete",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "通知未删除",
    );
  },

  /**
   * **取消归档**（任务 C-6）。
   *
   * `archive()` 是通知在 UI 上唯一的移除入口，而 `listAll` 原来恒传 `{ archived: 0 }`
   * → "归档"事实上是不可逆删除。这个方法是那条恢复路径的另一半。
   *
   * 语义与 `squad-storage.unarchive` 对称：行不存在 → 不写（`UPDATE 影响 0 行`）；
   * 本来就未归档 → 幂等返回 true；否则写回 `archived = 0`。
   *
   * @returns 这次调用结束后该通知是否**处于未归档状态**（含"本来就没归档"）
   */
  unarchive(id: string): boolean {
    const current = domainReadOne(TABLE, { id }, wireToInbox);
    if (current === undefined) {
      // B 态：端口在、镜像未接手 → 如实上报（不静默当成"已恢复"）
      reportPersistFailure(
        "inbox.unarchive",
        new Error("端口未接手（该域镜像未注册或未就绪）"),
        "通知未取消归档",
      );
      return false;
    }
    if (current === null) return false; // 通知不存在：旧实现是 UPDATE 影响 0 行
    if (current.archived === 0) return true; // 幂等

    return domainWrite(TABLE, [inboxToWire({ ...current, archived: 0 })], {
      mode: "replace",
      scope: "inbox.unarchive",
      note: "通知未取消归档",
    });
  },

  /**
   * 未读数。`projectId` 与 `listAll` **同一套三态语义**（见那里的长注释）——
   * 两者必须口径一致，否则又会出现"徽标 4 条、列表 0 条"这种自相矛盾的界面。
   */
  getUnreadCount(projectId?: string | null): number {
    const rust = domainReadMany(TABLE, wireToInbox, { read: 0, archived: 0 });
    if (rust) {
      return rust.filter((r) => {
        if (projectId === undefined) return true; // 不设边界（侧栏徽标的口径）
        if (projectId === null) return isGlobalProjectId(r.project_id); // 只看全局
        return r.project_id === projectId || isGlobalProjectId(r.project_id);
      }).length;
    }
    // **旧库回退已删除**（L4 第 18 轮）：端口没接手时返回该域的合理空结果（0 条未读）
    return 0;
  },

  deleteOlderThan(timestamp: number): void {
    const removed = domainDeleteWhere(
      TABLE,
      (row) => Number(row.created_at) < timestamp,
      "id",
      { scope: "inbox.deleteOlderThan", note: "过期通知未删除" },
    );
    if (removed !== null) return;
    // **旧库删除已删除**（L4 第 18 轮）：端口没接手时如实上报
    reportPersistFailure(
      "inbox.deleteOlderThan",
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      "过期通知未清理",
    );
  },
};
