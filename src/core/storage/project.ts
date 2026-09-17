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

import { getDatabase, persistDatabase, tryGetDatabase } from "./database";
import type { Project } from "../types";
import { runGuarded } from "./write-guard";
import { domainDelete, domainReadMany, domainReadOne, domainWrite, reportWriteNotAccepted } from "./domain-store";

export interface ProjectRow {
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

export function deleteProject(id: string): void {
  if (domainDelete(TABLE, { id }, { scope: "project.delete", note: "项目未删除" })) return;
  // 删除路径尤其不能静默：静默失败会让项目"看着在、实际已删"或反之（数据不一致）
  reportWriteNotAccepted("project.delete", "项目未删除");
  return;
}
