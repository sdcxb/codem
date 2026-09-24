/**
 * ProjectStorage —— `projects` 表的读写（P5 第 1 段：接入域端口）
 *
 * ## 为什么这一段必须做（真机发现的缺口）
 *
 * P5 真机验证时，在 rust 引擎下调用 `createProject` 直接抛
 * `Wrong API use : tried to bind a value of an unknown type (undefined)`
 * —— 这是 **sql.js** 的报错：说明本模块**从没接过端口**，一直在用 WASM 数据库。
 * 也就是说：默认引擎切到 rust 之后，只要 WASM 数据库那一天被删掉
 * （P5 后半段要做的事），**项目这个核心域会整体失效**。
 * 这是"渲染进程不再持有 WASM 数据库"这个目标上必须补的一块。
 *
 * ## 三条路由规则（与其它域同源）
 *
 * 1. 只有镜像加载完成后才路由（否则"写进 Rust、读到的还是旧值"）；
 * 2. 写 = 先本地镜像、再写穿，失败**如实上报**；
 * 3. `projects` 表里有一行特殊记录：`id = ''` 的全局项目（外键种子），
 *    它**不在** `listProjects()` 的结果里（旧实现用 `id != ''` 过滤）——
 *    镜像路径必须保持同一条过滤，否则"全局对话"会突然出现在项目列表里。
 */

import type { Project } from "../types";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, domainEnsureLoaded, domainPortRegistered, reportWriteNotAccepted } from "./domain-store";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  description: string | null;
  pinned: number;
  created_at: number;
  last_accessed_at: number;
}

const TABLE = "projects";
/** 全局项目（外键种子）：不出现在项目列表里 */
const GLOBAL_PROJECT_ID = "";
/** 虚拟项目前缀：笔记本项目只在笔记本界面显示 */
const NOTEBOOK_PROJECT_PREFIX = "notebook:";

function wireToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    path: String(row.path ?? ""),
    description: (row.description as string) ?? undefined,
    pinned: Number(row.pinned ?? 0) === 1,
    createdAt: Number(row.created_at ?? 0),
    lastAccessedAt: Number(row.last_accessed_at ?? 0),
  };
}

/** `Project` → 线协议行（整体 upsert 必须列全字段，缺列会被写成 NULL） */
function projectToWire(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    path: p.path ?? "",
    description: p.description ?? null,
    pinned: p.pinned ? 1 : 0,
    created_at: p.createdAt,
    last_accessed_at: p.lastAccessedAt,
  };
}

/** 旧实现的可见性过滤：不显示全局项目、不显示笔记本虚拟项目 */
function visible(p: Project): boolean {
  return p.id !== GLOBAL_PROJECT_ID && !p.id.startsWith(NOTEBOOK_PROJECT_PREFIX);
}

/** 旧 SQL：`ORDER BY pinned DESC, last_accessed_at DESC` */
function byPinnedThenAccess(a: Project, b: Project): number {
  const pa = a.pinned ? 1 : 0;
  const pb = b.pinned ? 1 : 0;
  return pa !== pb ? pb - pa : b.lastAccessedAt - a.lastAccessedAt;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description ?? undefined,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

export function listProjects(): Project[] {
  const rust = domainReadMany(TABLE, wireToProject);
  if (rust) return rust.filter(visible).sort(byPinnedThenAccess);
  // 第 17 轮（L4）：旧库回退已删。这里只剩 B 态：端口在 rust，只是镜像还没就绪
  // （启动前几百毫秒）。那时**没有别的数据源**，返回空列表是诚实的答案 ——
  // 端口就绪后调用方会重新加载（`prefetchDomainMirrors` 已把这段窗口挪到首屏前）。
  // 原来的 `tryGetDatabase() → if (!db) return []` 之所以要删：它把"没有旧库"
  // 当成一个**可能的**状态，而那个状态在新架构里不存在（旧库在 rust 模式下刻意不加载）。
  return [];
}

/**
 * 这次列项目**有没有真的拿到数据**（第 47 轮补，UI/UX 审计 P1 的第三处同形）。
 *
 * ## 与"消息列表"那一处完全同源的问题
 *
 * `listProjects()` 返回空有两种完全不同的原因，而界面只看得到"空"：
 * 1. 用户**确实没有项目** → 「暂无项目，新建或导入一个」是对的；
 * 2. **读没有真的发生**（端口未注册 / projects 镜像还没接手）→ 显示「暂无项目」
 *    是**错的**：冷启动或引擎起不来时，用户会以为自己建过的项目全没了。
 *    （`App.tsx` 里那条 `[Store] projects 镜像在 6 秒内未就绪，项目列表可能为空` 的告警
 *     正是这个窗口的物证。）
 *
 * 判据与 `listProjects` 的读路径同源：**问端口/镜像是否处于可用状态**，
 * 而不是看"结果是不是空"。
 */
export function isProjectsReadUnavailable(): boolean {
  let unavailable = false;
  try {
    if (!domainPortRegistered()) {
      unavailable = true; // 端口没注册：这次读根本没有数据源
    } else {
      // 主动催一下加载；随后用 domainReadMany 的**三态**判据
      domainEnsureLoaded(TABLE, () => {});
      /* `domainReadMany` 的契约：`undefined` = **端口/镜像没接手**（读不到），
       * 数组（哪怕是空数组）= 真的读到了。这正是我们要的区分，
       * 而 `listProjects()` 把它压成了 `[]`（那是给"普通调用方"的方便语义）。 */
      unavailable = domainReadMany(TABLE, wireToProject) === undefined;
    }
  } catch {
    // 判据本身出错 → 按"读不到"处理（宁可多显示一句"读不到"，
    // 也不要把"读不到"渲染成"你没有数据"）
    unavailable = true;
  }
  return unavailable;
}

export function getProject(id: string): Project | null {
  const rust = domainReadOne(TABLE, { id }, wireToProject);
  if (rust !== undefined) return rust;
  return null; // 同上：镜像未就绪 → 诚实的"查不到"，端口就绪后会重读
}

export function createProject(project: Project): void {
  const now = Date.now();
  // 旧实现直接绑 `project.createdAt / lastAccessedAt`：调用方漏传时 sql.js 会抛
  // "tried to bind a value of an unknown type (undefined)"（真机上就是这么炸的）。
  // 镜像路径显式补默认值，顺带把这个易碎点去掉 —— 新建项目的时间本来就该是"现在"。
  const row: Project = {
    ...project,
    path: project.path ?? "",
    createdAt: project.createdAt ?? now,
    lastAccessedAt: project.lastAccessedAt ?? now,
  };
  if (domainWrite(TABLE, [projectToWire(row)], { scope: "project.create", note: "项目未保存" })) {
    return;
  }
  // 两态：A 态（端口未注册）才回退旧库；B 态（端口在、镜像未就绪）已如实上报
  reportWriteNotAccepted("project.create", "项目未保存");
  return;
}

export function updateProject(id: string, update: Partial<Project>): void {
  const fields: string[] = [];
  if (update.name !== undefined) fields.push("name");
  if (update.path !== undefined) fields.push("path");
  if (update.description !== undefined) fields.push("description");
  if (update.pinned !== undefined) fields.push("pinned");
  if (update.lastAccessedAt !== undefined) fields.push("last_accessed_at");

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[project.ts] update 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(TABLE, { id }, wireToProject);
  if (current !== undefined) {
    if (current === null) return; // 项目不存在：旧实现是 UPDATE 影响 0 行
    const next: Project = {
      ...current,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.path !== undefined ? { path: update.path } : {}),
      ...(update.description !== undefined ? { description: update.description ?? undefined } : {}),
      ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
      ...(update.lastAccessedAt !== undefined ? { lastAccessedAt: update.lastAccessedAt } : {}),
    };
    domainWrite(TABLE, [projectToWire(next)], {
      mode: "replace",
      scope: "project.update",
      note: "项目未更新（项目不存在或写入失败）",
    });
    return;
  }

  reportWriteNotAccepted("project.update", "项目未更新");
  return;
}

/**
 * 删项目（**会级联**删掉它的全部会话 → 全部消息 / 工具调用 / 事件）。
 *
 * ## `confirmBulk`（第 44 轮）
 *
 * Rust 侧对"一次命令的真实影响规模"有闸门：删项目这一条命令 `written` 只显示 1，
 * 而外键级联会带走该项目的全部语料 —— 这是本系统里单条命令能造成的最大规模删除。
 * 所以超过上限时必须显式声明"我知道这是批量删除"。
 *
 * 用户点"删除项目"并确认是明确的破坏性意图 → UI 路径传 `confirmBulk: true`；
 * **任何非交互路径**（对账、清理、修复）都不该传 —— 那正是闸门要拦的。
 * 缺省不传是刻意的：**安全默认必须是"不确认"**，否则闸门形同不存在。
 */
export function deleteProject(id: string, opts: { confirmBulk?: boolean } = {}): void {
  if (
    domainDelete(TABLE, { id }, {
      scope: "project.delete",
      note: "项目未删除",
      confirmBulk: opts.confirmBulk,
    })
  ) {
    return;
  }
  // 删除路径尤其不能静默：静默失败会让项目"看着在、实际已删"或反之（数据不一致）
  reportWriteNotAccepted("project.delete", "项目未删除");
  return;
}
