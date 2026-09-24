/**
 * Prompt Draft Storage — Prompt 草稿版本管理
 *
 * 用于保存、加载、删除 Prompt 草稿，支持版本对比
 */

import { reportPersistFailure } from "./persist-failure";
import { domainDelete, domainReadMany, domainReadOne, domainWrite } from "./domain-store";

// ========== 迁移期分流（P3 第 13 段） ==========
//
// 骨架在 `domain-store.ts`（加载判定 / 写穿上报 / 超限回退），本文件只管行 shape 与语义。
// 注意 `version` 这一列：旧实现用 `MAX(version)+1` 在**数据库里**算，
// 走镜像时要在**镜像里**算同样的东西（见 maxVersion），语义保持一致。

const TABLE = "prompt_drafts";

/**
 * 旧库入口 —— **已整体删除**（L4 收尾）。
 *
 * 这里原来有个 `legacyDb()` = `tryGetDatabase()` 的小包装，本文件的 6 处旧库读写
 * 全都挂在它后面。回滚开关退役、旧库在 rust 模式下刻意不加载之后，
 * 它**只可能返回 null**（真机上表现为 `Database not initialized` → `app.conversation` 整体崩溃，
 * 见下面 P5 第 10 段那段历史）。现在"端口没接手"一律直接表达为
 * **如实回绝 / 该域的合理空结果**，不再去碰一份不存在的库。
 *
 * 历史（保留作为"为什么不再回退"的记录）：
 *
 * 真机验收（打包版）实测：`app.conversation` 面板**整体崩溃**，
 * 控制台是 `Database not initialized. Call initDatabase() first.`，
 * 会话区一条消息都不渲染。堆栈落到本文件的 `listPromptDrafts`（渲染期同步调用）：
 *
 * - 端口分支用的是 `domainReadMany(...)`，而它在**镜像尚未加载完**时返回 `undefined`
 *   （这是设计：未加载完不路由，避免读写分裂）；
 * - 于是落到 `const db = getDatabase()` 这条回退；
 * - 而 rust 模式下旧库是**刻意不加载**的（省内存的前提），`getDatabase()` 按设计抛错；
 * - 渲染期抛出 = React 组件崩 → 面板变"此面板不可用"。
 *
 * 根因是**把"旧库不存在"当成了异常**。在新架构下它是正常状态，正确表达是
 * `tryGetDatabase()` 返回 null，由调用方给出"该域在 rust 模式下的合理结果"。
 */

/** 线协议行 → PromptDraft（tags 是 JSON 文本） */
function wireToDraft(row: Record<string, unknown>): PromptDraft {
  let tags: string[] = [];
  const rawTags = row.tags;
  if (typeof rawTags === "string" && rawTags.length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) tags = parsed as string[];
    } catch {
      tags = [];
    }
  }
  return {
    id: String(row.id ?? ""),
    sessionId: String(row.session_id ?? ""),
    version: Number(row.version ?? 0),
    content: String(row.content ?? ""),
    tags,
    createdAt: Number(row.created_at ?? 0),
  };
}

/** Draft → 线协议行 */
function draftToWire(d: PromptDraft): Record<string, unknown> {
  return {
    id: d.id,
    session_id: d.sessionId,
    version: d.version,
    content: d.content,
    tags: JSON.stringify(d.tags ?? []),
    created_at: d.createdAt,
  };
}

export interface PromptDraft {
  id: string;
  sessionId: string;
  version: number;
  content: string;
  tags: string[];
  createdAt: number;
}

/**
 * Save a new prompt draft
 */
export function savePromptDraft(
  sessionId: string,
  content: string,
  tags?: string[]
): string {
  const id = `draft-${sessionId}-${Date.now()}`;
  const now = Date.now();

  // 迁移期：版本号在**同一份数据**上算（镜像里算 = 旧实现的 MAX(version) 等价物）
  const existing = domainReadMany(TABLE, wireToDraft, { session_id: sessionId });
  if (existing) {
    const version = existing.reduce((m, d) => Math.max(m, d.version), 0) + 1;
    const draft: PromptDraft = { id, sessionId, version, content, tags: tags ?? [], createdAt: now };
    domainWrite(TABLE, [draftToWire(draft)], { scope: "promptDraft.save", note: "草稿未保存" });
    return id;
  }

  /**
   * **旧库写入已删除**（L4 收尾）：端口没接手时**如实上报为"未保存"**。
   *
   * 写路径：不能静默，也不能抛（调用方多为 UI 动作）。返回 `id` 与原来
   * `if (!db) { report…; return id; }` 那条**完全一致** —— 这是既有契约
   * （`savePromptDraft` 只回一个 id，没有 `{ok:false}` 形状），而不是新造的假成功：
   * 失败会走 `reportPersistFailure`（error 日志 + `codem:persist-failed` 事件）变得可见。
   * 唯一的改动是**不再去碰一份不存在的旧库**（原来 `getDatabase()` 在这里会抛）。
   */
  reportPersistFailure(
    "promptDraft.save",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "草稿未保存（查询索引不可用）",
  );
  return id;
}

/**
 * Load all prompt drafts for a session
 */
export function loadPromptDrafts(sessionId: string): PromptDraft[] {
  const rust = domainReadMany(TABLE, wireToDraft, { session_id: sessionId });
  if (rust) {
    // 与旧实现一致：version DESC
    return rust.sort((a, b) => b.version - a.version);
  }
  /**
   * **旧库读取已删除**（L4 收尾）：端口没接手 → 该域的合理空结果（空数组）。
   * 与原来 `if (!db) return [];` 语义一致：rust 模式且镜像未就绪时给空结果，
   * **绝不在渲染期抛**（那正是 `app.conversation` 整体崩溃的根因）。
   */
  return [];
}

/**
 * Delete a prompt draft
 */
export function deletePromptDraft(draftId: string): void {
  if (domainDelete(TABLE, { id: draftId }, { scope: "promptDraft.delete", note: "草稿未删除" })) return;
  /**
   * **旧库删除已删除**（L4 收尾）：端口没接手时如实上报为"未删除"（与原来
   * `if (!db) { report…; return; }` 那条**完全一致**，只是不再去碰不存在的旧库）。
   */
  reportPersistFailure(
    "promptDraft.delete",
    new Error("端口未接手（该域镜像未注册或未就绪）"),
    "草稿未删除",
  );
}

/**
 * Compare two prompt drafts and return diff
 */
function comparePromptDrafts(
  draftId1: string,
  draftId2: string
): { draft1: PromptDraft; draft2: PromptDraft; diff: string } {
  // 迁移期：两次按 id 读（旧实现用 `WHERE id IN (?, ?)`，语义等价）
  const d1 = domainReadOne(TABLE, { id: draftId1 }, wireToDraft);
  const d2 = domainReadOne(TABLE, { id: draftId2 }, wireToDraft);
  let draft1: PromptDraft;
  let draft2: PromptDraft;
  if (d1 !== undefined && d2 !== undefined) {
    if (!d1 || !d2) throw new Error("Drafts not found");
    // 与旧实现一致：按 version 升序排列
    [draft1, draft2] = d1.version <= d2.version ? [d1, d2] : [d2, d1];
  } else {
    /**
     * **旧库读取已删除**（L4 收尾）：端口没接手 → 与"查不到这两份草稿"是同一件事。
     *
     * 原来这里是 `const db = legacyDb(); const result = db ? db.exec(...) : [];` +
     * 紧接着的同一个 `throw` —— 也就是**旧库不存在时结果与被删掉的语义完全一样**。
     * 所以直接走到同一句 `throw` 才是诚实的等价替换（抛的是业务语义
     * "Drafts not found"，不是基础设施语义"数据库没初始化"，这点刻意保持不变）。
     */
    throw new Error("Drafts not found");
  }

  // Simple line-by-line diff
  const lines1 = draft1.content.split("\n");
  const lines2 = draft2.content.split("\n");
  const diff: string[] = [];

  const maxLen = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLen; i++) {
    const line1 = lines1[i];
    const line2 = lines2[i];

    if (line1 === line2) {
      diff.push(`  ${line1 || ""}`);
    } else {
      if (line1 !== undefined) diff.push(`- ${line1}`);
      if (line2 !== undefined) diff.push(`+ ${line2}`);
    }
  }

  return {
    draft1,
    draft2,
    diff: diff.join("\n"),
  };
}