/**
 * 笔记本式知识管理 — SQLite CRUD 存储层
 *
 * 对标 NotebookLM：Notebook → Source → Chunk → Retrieval
 * 笔记 (Note) 功能借鉴 Lumina Note 的笔记 CRUD 设计
 * 知识图谱 CRUD 借鉴 Understand-Anything 的图谱数据管理思路
 *
 * 笔记本、来源、文本块的增删改查操作。
 * 向量以 Float32Array → Base64 BLOB 方式存储。
 */

import { getDatabase, persistDatabase } from '../storage/database';
import { runGuarded } from "../storage/write-guard";
import {
  domainDelete,
  domainDeleteWhere,
  domainReadMany,
  domainReadOne,
  domainWrite,
} from "../storage/domain-store";
import type {
  Notebook,
  NotebookSource,
  NotebookChunk,
  CreateNotebookInput,
  AddSourceInput,
  SummaryStatus,
  SourceStatus,
  SourceType,
  Note,
  CreateNoteInput,
  NoteLink,
  NoteContentType,
  NotebookGroup,
  CreateGroupInput,
  NoteVersion,
  GraphNode,
  GraphEdge,
  GraphData,
  EntityType,
  RelationType,
} from './types';

// ========== 表名与镜像上限 ==========

const T_NOTEBOOKS = "notebooks";
const T_SOURCES = "notebook_sources";
const T_CHUNKS = "notebook_chunks";
const T_NOTES = "notes";
const T_LINKS = "note_links";
const T_NODES = "graph_nodes";
const T_EDGES = "graph_edges";
const T_GROUPS = "notebook_groups";
const T_VERSIONS = "note_versions";

/**
 * `notebook_chunks` 的镜像上限刻意调小。
 *
 * 每行带一个 Base64 编码的 embedding（1536 维 ≈ 8KB 文本），默认上限 5000 行
 * 意味着几十 MB 常驻渲染进程内存 —— 这正是 P6 要消灭的那类占用。
 * 超过 2000 行（约 16MB）就放弃镜像、回退旧路径，而不是把渲染进程压死。
 */
const CHUNK_MIRROR_MAX = 2000;
const CHUNK_OPTS = { maxRows: CHUNK_MIRROR_MAX };

// ========== Utils ==========

function generateId(): string {
  return `nb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateSourceId(): string {
  return `src_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateChunkId(): string {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Float32Array → Base64 for BLOB storage */
export function embeddingToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Base64 BLOB → Float32Array */
export function base64ToEmbedding(b64: string): Float32Array | null {
  if (!b64) return null;
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } catch {
    return null;
  }
}

/** JSON 文本 → 数组（解析失败一律当"没有"，与旧实现的 try/catch 一致） */
function parseJsonArray(json: unknown): string[] | undefined {
  if (typeof json !== "string" || !json) return undefined;
  try {
    return JSON.parse(json) as string[];
  } catch {
    return undefined;
  }
}

// ========== 行 ↔ 线协议行（P3 第 15 段：域镜像路由） ==========
//
// 这一段 9 张表全部走域名镜像。转换函数显式列出每一列：
// 旧实现用 `db.exec` 拿**位置数组**，靠下标取列（`row[9]` 之类），
// 增删一列就会整体错位；具名列 + 显式映射把这类错误变成编译期/测试期可见。

function wireToNotebook(row: Record<string, unknown>): Notebook {
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string) || undefined,
    summary: (row.summary as string) || undefined,
    summaryStatus: row.summary_status as SummaryStatus,
    sourceCount: Number(row.source_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    groupId: (row.group_id as string) || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function notebookToWire(nb: Notebook): Record<string, unknown> {
  return {
    id: nb.id,
    name: nb.name,
    description: nb.description ?? null,
    summary: nb.summary ?? null,
    summary_status: nb.summaryStatus,
    source_count: nb.sourceCount,
    chunk_count: nb.chunkCount,
    group_id: nb.groupId ?? null,
    created_at: nb.createdAt,
    updated_at: nb.updatedAt,
  };
}

function wireToSource(row: Record<string, unknown>): NotebookSource {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    name: String(row.name),
    type: row.type as SourceType,
    content: (row.content as string) || undefined,
    filePath: (row.file_path as string) || undefined,
    url: (row.url as string) || undefined,
    mimeType: (row.mime_type as string) || undefined,
    size: (row.size as number) || undefined,
    status: row.status as SourceStatus,
    chunkCount: Number(row.chunk_count ?? 0),
    errorMessage: (row.error_message as string) || undefined,
    summary: (row.summary as string) || undefined,
    keyTopics: parseJsonArray(row.key_topics),
    createdAt: Number(row.created_at),
  };
}

function sourceToWire(s: NotebookSource): Record<string, unknown> {
  return {
    id: s.id,
    notebook_id: s.notebookId,
    name: s.name,
    type: s.type,
    content: s.content ?? null,
    file_path: s.filePath ?? null,
    url: s.url ?? null,
    mime_type: s.mimeType ?? null,
    size: s.size ?? null,
    status: s.status,
    chunk_count: s.chunkCount,
    error_message: s.errorMessage ?? null,
    summary: s.summary ?? null,
    key_topics: s.keyTopics ? JSON.stringify(s.keyTopics) : null,
    created_at: s.createdAt,
  };
}

function wireToChunk(row: Record<string, unknown>): NotebookChunk {
  const embeddingB64 = row.embedding as string | null;
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    notebookId: String(row.notebook_id),
    content: String(row.content),
    chunkIndex: Number(row.chunk_index),
    embedding: embeddingB64 ? base64ToEmbedding(embeddingB64) : null,
    tokenCount: Number(row.token_count ?? 0),
    createdAt: Number(row.created_at),
  };
}

function chunkToWire(c: NotebookChunk): Record<string, unknown> {
  return {
    id: c.id,
    source_id: c.sourceId,
    notebook_id: c.notebookId,
    content: c.content,
    chunk_index: c.chunkIndex,
    embedding: c.embedding ? embeddingToBase64(c.embedding) : null,
    token_count: c.tokenCount,
    created_at: c.createdAt,
  };
}

function wireToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    sourceId: (row.source_id as string) || undefined,
    title: String(row.title),
    content: (row.content as string) || '',
    contentType: ((row.content_type as string) || 'markdown') as NoteContentType,
    tags: parseJsonArray(row.tags),
    pinOrder: Number(row.pin_order ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function noteToWire(n: Note): Record<string, unknown> {
  return {
    id: n.id,
    notebook_id: n.notebookId,
    source_id: n.sourceId ?? null,
    title: n.title,
    content: n.content ?? '',
    content_type: n.contentType ?? 'markdown',
    tags: n.tags ? JSON.stringify(n.tags) : null,
    pin_order: n.pinOrder ?? 0,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

function wireToNoteLink(row: Record<string, unknown>): NoteLink {
  return {
    id: String(row.id),
    sourceNoteId: String(row.source_note_id),
    targetNoteId: String(row.target_note_id),
    linkText: (row.link_text as string) || undefined,
    createdAt: Number(row.created_at),
  };
}

function wireToNode(row: Record<string, unknown>): GraphNode {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    label: String(row.label),
    entityType: row.entity_type as EntityType,
    description: (row.description as string) || undefined,
    sourceIds: parseJsonArray(row.source_ids) ?? [],
    chunkIds: parseJsonArray(row.chunk_ids) ?? [],
    weight: Number(row.weight ?? 1),
    communityId: (row.community_id as number) ?? undefined,
    createdAt: Number(row.created_at),
  };
}

function nodeToWire(n: GraphNode): Record<string, unknown> {
  return {
    id: n.id,
    notebook_id: n.notebookId,
    label: n.label,
    entity_type: n.entityType,
    description: n.description ?? null,
    source_ids: JSON.stringify(n.sourceIds ?? []),
    chunk_ids: JSON.stringify(n.chunkIds ?? []),
    weight: n.weight,
    community_id: n.communityId ?? null,
    created_at: n.createdAt,
  };
}

function wireToEdge(row: Record<string, unknown>): GraphEdge {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    relationType: row.relation_type as RelationType,
    weight: Number(row.weight ?? 1),
    createdAt: Number(row.created_at),
  };
}

function edgeToWire(e: GraphEdge): Record<string, unknown> {
  return {
    id: e.id,
    notebook_id: e.notebookId,
    source_node_id: e.sourceNodeId,
    target_node_id: e.targetNodeId,
    relation_type: e.relationType,
    weight: e.weight,
    created_at: e.createdAt,
  };
}

function wireToGroup(row: Record<string, unknown>): NotebookGroup {
  return {
    id: String(row.id),
    name: String(row.name),
    parentId: (row.parent_id as string) || undefined,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at),
  };
}

function groupToWire(g: NotebookGroup): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    parent_id: g.parentId ?? null,
    sort_order: g.sortOrder ?? 0,
    created_at: g.createdAt,
  };
}

function wireToVersion(row: Record<string, unknown>): NoteVersion {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    title: String(row.title),
    content: String(row.content),
    tags: parseJsonArray(row.tags),
    versionNote: (row.version_note as string) || undefined,
    createdAt: Number(row.created_at),
  };
}

function versionToWire(v: NoteVersion): Record<string, unknown> {
  return {
    id: v.id,
    note_id: v.noteId,
    title: v.title,
    content: v.content,
    tags: v.tags ? JSON.stringify(v.tags) : null,
    version_note: v.versionNote ?? null,
    created_at: v.createdAt,
  };
}

// ========== Notebook CRUD ==========

export function createNotebook(input: CreateNotebookInput): Notebook {
  const now = Date.now();
  const id = generateId();
  const created: Notebook = {
    id,
    name: input.name,
    description: input.description,
    summary: undefined,
    summaryStatus: 'pending',
    sourceCount: 0,
    chunkCount: 0,
    groupId: input.groupId,
    createdAt: now,
    updatedAt: now,
  };
  if (domainWrite(T_NOTEBOOKS, [notebookToWire(created)], { scope: "notebook.create", note: "笔记本未保存" })) {
    return created;
  }
  const db = getDatabase();
  db.run(
    `INSERT INTO notebooks (id, name, description, summary, summary_status, source_count, chunk_count, group_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'pending', 0, 0, ?, ?, ?)`,
    [id, input.name, input.description ?? null, input.groupId ?? null, now, now],
  );
  persistDatabase();

  return created;
}

export function getNotebook(id: string): Notebook | null {
  const rust = domainReadOne(T_NOTEBOOKS, { id }, wireToNotebook);
  if (rust !== undefined) return rust;
  const db = getDatabase();
  const result = db.exec('SELECT * FROM notebooks WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToNotebook(result[0].values[0]);
}

export function listNotebooks(): Notebook[] {
  const rust = domainReadMany(T_NOTEBOOKS, wireToNotebook);
  if (rust) return rust.sort((a, b) => b.updatedAt - a.updatedAt);
  const db = getDatabase();
  const result = db.exec('SELECT * FROM notebooks ORDER BY updated_at DESC');
  if (result.length === 0) return [];
  return result[0].values.map(rowToNotebook);
}

export function listNotebooksByGroup(groupId: string | null): Notebook[] {
  const rust = domainReadMany(T_NOTEBOOKS, wireToNotebook);
  if (rust) {
    return rust
      // `group_id IS NULL` 与 `group_id = ?`：undefined 表示"未分组"
      .filter((nb) => (groupId === null ? nb.groupId === undefined : nb.groupId === groupId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const db = getDatabase();
  const result = groupId === null
    ? db.exec('SELECT * FROM notebooks WHERE group_id IS NULL ORDER BY updated_at DESC')
    : db.exec('SELECT * FROM notebooks WHERE group_id = ? ORDER BY updated_at DESC', [groupId]);
  if (result.length === 0) return [];
  return result[0].values.map(rowToNotebook);
}

export function updateNotebook(id: string, update: Partial<Pick<Notebook, 'name' | 'description' | 'summary' | 'summaryStatus' | 'groupId'>>): void {
  const fields: string[] = [];
  if (update.name !== undefined) fields.push('name');
  if (update.description !== undefined) fields.push('description');
  if (update.summary !== undefined) fields.push('summary');
  if (update.summaryStatus !== undefined) fields.push('summary_status');
  if (update.groupId !== undefined) fields.push('group_id');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateNotebook 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_NOTEBOOKS, { id }, wireToNotebook);
  if (current !== undefined) {
    if (current === null) return; // 笔记本不存在：旧实现是 UPDATE 影响 0 行
    const next: Notebook = {
      ...current,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description ?? undefined } : {}),
      ...(update.summary !== undefined ? { summary: update.summary } : {}),
      ...(update.summaryStatus !== undefined ? { summaryStatus: update.summaryStatus } : {}),
      ...(update.groupId !== undefined ? { groupId: update.groupId ?? undefined } : {}),
      updatedAt: Date.now(),
    };
    domainWrite(T_NOTEBOOKS, [notebookToWire(next)], {
      mode: "replace",
      scope: "notebook.update",
      note: "笔记本未更新（笔记本不存在或写入失败）",
    });
    return;
  }

  const db = getDatabase();
  const values: (string | number | null)[] = [];
  const columnOf: Record<string, string> = {
    name: 'name = ?',
    description: 'description = ?',
    summary: 'summary = ?',
    summary_status: 'summary_status = ?',
    group_id: 'group_id = ?',
  };
  for (const f of fields) {
    values.push(
      f === 'description' ? (update.description ?? null)
      : f === 'group_id' ? (update.groupId ?? null)
      : f === 'summary' ? (update.summary as string)
      : f === 'summary_status' ? (update.summaryStatus as string)
      : (update.name as string),
    );
  }
  values.push(Date.now());
  values.push(id);

  runGuarded(
    db,
    `UPDATE notebooks SET ${fields.map((f) => columnOf[f]).join(', ')}, updated_at = ? WHERE id = ?`,
    values,
    { table: "notebooks", op: "update", id, from: "updateNotebook" },
  );
  persistDatabase();
}

export function deleteNotebook(id: string): void {
  if (domainDelete(T_NOTEBOOKS, { id }, { scope: "notebook.delete", note: "笔记本未删除" })) return;
  const db = getDatabase();
  db.run('DELETE FROM notebooks WHERE id = ?', [id]);
  persistDatabase();
}

/** Update aggregated counts after source/chunk changes */
export function refreshNotebookCounts(notebookId: string): void {
  const sourceCount = getSourceCount(notebookId);
  const chunkCount = getChunkCount(notebookId);
  const now = Date.now();

  // 迁移期：计数在**同一份数据**（镜像）上算完 → 整体写回 notebooks 行。
  const current = domainReadOne(T_NOTEBOOKS, { id: notebookId }, wireToNotebook);
  if (current !== undefined) {
    if (current === null) return;
    domainWrite(
      T_NOTEBOOKS,
      [notebookToWire({ ...current, sourceCount, chunkCount, updatedAt: now })],
      { mode: "replace", scope: "notebook.refreshCounts", note: "笔记本计数未刷新" },
    );
    return;
  }

  const db = getDatabase();
  db.run(
    'UPDATE notebooks SET source_count = ?, chunk_count = ?, updated_at = ? WHERE id = ?',
    [sourceCount, chunkCount, now, notebookId],
  );
  persistDatabase();
}

function getSourceCount(notebookId: string): number {
  const rust = domainReadMany(T_SOURCES, (r) => r, { notebook_id: notebookId });
  if (rust) return rust.length;
  const db = getDatabase();
  const srcResult = db.exec(
    'SELECT COUNT(*) as cnt FROM notebook_sources WHERE notebook_id = ?',
    [notebookId],
  );
  return srcResult.length > 0 ? (srcResult[0].values[0][0] as number) : 0;
}

function rowToNotebook(row: any[]): Notebook {
  return {
    id: row[0] as string,
    name: row[1] as string,
    description: row[2] as string || undefined,
    summary: row[3] as string || undefined,
    summaryStatus: (row[4] as string) as SummaryStatus,
    sourceCount: row[5] as number,
    chunkCount: row[6] as number,
    groupId: row[9] as string || undefined,
    createdAt: row[7] as number,
    updatedAt: row[8] as number,
  };
}

// ========== Source CRUD ==========

export function addSource(input: AddSourceInput): NotebookSource {
  const now = Date.now();
  const id = generateSourceId();
  const created: NotebookSource = {
    id,
    notebookId: input.notebookId,
    name: input.name,
    type: input.type,
    content: input.content,
    filePath: input.filePath,
    url: input.url,
    mimeType: input.mimeType,
    size: input.size,
    status: 'pending',
    chunkCount: 0,
    createdAt: now,
  };
  if (domainWrite(T_SOURCES, [sourceToWire(created)], { scope: "source.add", note: "来源未保存" })) {
    return created;
  }
  const db = getDatabase();
  db.run(
    `INSERT INTO notebook_sources (id, notebook_id, name, type, content, file_path, url, mime_type, size, status, chunk_count, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?)`,
    [
      id,
      input.notebookId,
      input.name,
      input.type,
      input.content ?? null,
      input.filePath ?? null,
      input.url ?? null,
      input.mimeType ?? null,
      input.size ?? null,
      now,
    ],
  );
  persistDatabase();

  return created;
}

export function getSource(id: string): NotebookSource | null {
  const rust = domainReadOne(T_SOURCES, { id }, wireToSource);
  if (rust !== undefined) return rust;
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, notebook_id, name, type, content, file_path, url, mime_type, size, status, chunk_count, error_message, summary, key_topics, created_at FROM notebook_sources WHERE id = ?',
    [id],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToSource(result[0].values[0]);
}

export function listSources(notebookId: string): NotebookSource[] {
  const rust = domainReadMany(T_SOURCES, wireToSource, { notebook_id: notebookId });
  if (rust) return rust.sort((a, b) => a.createdAt - b.createdAt);
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, notebook_id, name, type, content, file_path, url, mime_type, size, status, chunk_count, error_message, summary, key_topics, created_at FROM notebook_sources WHERE notebook_id = ? ORDER BY created_at ASC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSource);
}

export function updateSource(id: string, update: Partial<Pick<NotebookSource, 'status' | 'chunkCount' | 'errorMessage' | 'summary' | 'keyTopics'>>): void {
  const fields: string[] = [];
  if (update.status !== undefined) fields.push('status');
  if (update.chunkCount !== undefined) fields.push('chunk_count');
  if (update.errorMessage !== undefined) fields.push('error_message');
  if (update.summary !== undefined) fields.push('summary');
  if (update.keyTopics !== undefined) fields.push('key_topics');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateSource 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_SOURCES, { id }, wireToSource);
  if (current !== undefined) {
    if (current === null) return; // 来源不存在：旧实现是 UPDATE 影响 0 行
    const next: NotebookSource = {
      ...current,
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.chunkCount !== undefined ? { chunkCount: update.chunkCount } : {}),
      ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage ?? undefined } : {}),
      ...(update.summary !== undefined ? { summary: update.summary } : {}),
      ...(update.keyTopics !== undefined ? { keyTopics: update.keyTopics ?? undefined } : {}),
    };
    domainWrite(T_SOURCES, [sourceToWire(next)], {
      mode: "replace",
      scope: "source.update",
      note: "来源未更新（来源不存在或写入失败）",
    });
    return;
  }

  const db = getDatabase();
  const values: (string | number | null)[] = [];
  for (const f of fields) {
    if (f === 'status') values.push(update.status as string);
    else if (f === 'chunk_count') values.push(update.chunkCount as number);
    else if (f === 'error_message') values.push(update.errorMessage ?? null);
    else if (f === 'summary') values.push(update.summary as string);
    else values.push(update.keyTopics ? JSON.stringify(update.keyTopics) : null);
  }
  values.push(id);

  runGuarded(
    db,
    `UPDATE notebook_sources SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
    values,
    { table: "notebook_sources", op: "update", id, from: "updateSource" },
  );
  persistDatabase();
}

export function deleteSource(id: string): void {
  if (domainDelete(T_SOURCES, { id }, { scope: "source.delete", note: "来源未删除" })) return;
  const db = getDatabase();
  db.run('DELETE FROM notebook_sources WHERE id = ?', [id]);
  persistDatabase();
}

function rowToSource(row: any[]): NotebookSource {
  let keyTopics: string[] | undefined;
  const keyTopicsJson = row[13] as string;
  if (keyTopicsJson) {
    try { keyTopics = JSON.parse(keyTopicsJson); } catch { keyTopics = undefined; }
  }
  return {
    id: row[0] as string,
    notebookId: row[1] as string,
    name: row[2] as string,
    type: row[3] as SourceType,
    content: row[4] as string || undefined,
    filePath: row[5] as string || undefined,
    url: row[6] as string || undefined,
    mimeType: row[7] as string || undefined,
    size: row[8] as number || undefined,
    status: (row[9] as string) as SourceStatus,
    chunkCount: row[10] as number,
    errorMessage: row[11] as string || undefined,
    summary: row[12] as string || undefined,
    keyTopics,
    createdAt: row[14] as number,
  };
}

// ========== Chunk CRUD ==========

export function addChunk(chunk: Omit<NotebookChunk, 'id' | 'createdAt'>): NotebookChunk {
  const now = Date.now();
  const id = generateChunkId();
  const created: NotebookChunk = { ...chunk, id, createdAt: now };
  // 注意：这一行带 Base64 embedding，体积大。上限由 CHUNK_MIRROR_MAX 把住。
  if (domainWrite(T_CHUNKS, [chunkToWire(created)], { scope: "chunk.add", note: "文本块未保存", ...CHUNK_OPTS })) {
    return created;
  }
  const db = getDatabase();
  const embeddingBlob = chunk.embedding ? embeddingToBase64(chunk.embedding) : null;
  db.run(
    `INSERT INTO notebook_chunks (id, source_id, notebook_id, content, chunk_index, embedding, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, chunk.sourceId, chunk.notebookId, chunk.content, chunk.chunkIndex, embeddingBlob, chunk.tokenCount, now],
  );

  return created;
}

export function addChunksBulk(notebookId: string, sourceId: string, chunks: { content: string; chunkIndex: number; embedding: Float32Array | null; tokenCount: number }[]): void {
  const now = Date.now();
  const rows = chunks.map((chunk) => {
    const row: NotebookChunk = {
      id: generateChunkId(),
      sourceId,
      notebookId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      embedding: chunk.embedding,
      tokenCount: chunk.tokenCount,
      createdAt: now,
    };
    return chunkToWire(row);
  });
  // 批量走**一次** crud.upsert：旧实现是 N 次 db.run（每条一次往返），
  // 这是"大文档批处理"最直接的瓶颈之一。
  if (domainWrite(T_CHUNKS, rows, { scope: "chunk.addBulk", note: "文本块未批量保存", ...CHUNK_OPTS })) {
    return;
  }
  const db = getDatabase();
  for (const chunk of chunks) {
    const id = generateChunkId();
    const embeddingBlob = chunk.embedding ? embeddingToBase64(chunk.embedding) : null;
    db.run(
      `INSERT INTO notebook_chunks (id, source_id, notebook_id, content, chunk_index, embedding, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sourceId, notebookId, chunk.content, chunk.chunkIndex, embeddingBlob, chunk.tokenCount, now],
    );
  }

  persistDatabase();
}

export function getChunks(notebookId: string): NotebookChunk[] {
  const rust = domainReadMany(T_CHUNKS, wireToChunk, { notebook_id: notebookId }, CHUNK_OPTS);
  if (rust) return rust.sort((a, b) => a.chunkIndex - b.chunkIndex);
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, source_id, notebook_id, content, chunk_index, embedding, token_count, created_at FROM notebook_chunks WHERE notebook_id = ? ORDER BY chunk_index ASC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToChunk);
}

export function getChunkCount(notebookId: string): number {
  const rust = domainReadMany(T_CHUNKS, (r) => r, { notebook_id: notebookId }, CHUNK_OPTS);
  if (rust) return rust.length;
  const db = getDatabase();
  const result = db.exec(
    'SELECT COUNT(*) FROM notebook_chunks WHERE notebook_id = ?',
    [notebookId],
  );
  if (result.length === 0) return 0;
  return result[0].values[0][0] as number;
}

export function deleteChunksBySource(sourceId: string): void {
  const removed = domainDeleteWhere(
    T_CHUNKS,
    (row) => row.source_id === sourceId,
    "id",
    { scope: "chunk.deleteBySource", note: "文本块未删除", ...CHUNK_OPTS },
  );
  if (removed !== null) return;
  const db = getDatabase();
  db.run('DELETE FROM notebook_chunks WHERE source_id = ?', [sourceId]);
  persistDatabase();
}

function rowToChunk(row: any[]): NotebookChunk {
  const embeddingB64 = row[5] as string;
  return {
    id: row[0] as string,
    sourceId: row[1] as string,
    notebookId: row[2] as string,
    content: row[3] as string,
    chunkIndex: row[4] as number,
    embedding: embeddingB64 ? base64ToEmbedding(embeddingB64) : null,
    tokenCount: row[6] as number,
    createdAt: row[7] as number,
  };
}

// ========== Note CRUD ==========

function generateNoteId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createNote(input: CreateNoteInput): Note {
  const now = Date.now();
  const id = generateNoteId();
  const created: Note = {
    id,
    notebookId: input.notebookId,
    sourceId: input.sourceId,
    title: input.title,
    content: input.content ?? '',
    contentType: input.contentType ?? 'markdown',
    tags: input.tags,
    pinOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (domainWrite(T_NOTES, [noteToWire(created)], { scope: "note.create", note: "笔记未保存" })) {
    return created;
  }
  const db = getDatabase();
  const tagsJson = input.tags ? JSON.stringify(input.tags) : null;
  db.run(
    `INSERT INTO notes (id, notebook_id, source_id, title, content, content_type, tags, pin_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, input.notebookId, input.sourceId ?? null, input.title, input.content ?? '', input.contentType ?? 'markdown', tagsJson, now, now],
  );
  persistDatabase();

  return created;
}

export function getNote(id: string): Note | null {
  const rust = domainReadOne(T_NOTES, { id }, wireToNote);
  if (rust !== undefined) return rust;
  const db = getDatabase();
  const result = db.exec('SELECT * FROM notes WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToNote(result[0].values[0]);
}

export function listNotes(notebookId: string): Note[] {
  const rust = domainReadMany(T_NOTES, wireToNote, { notebook_id: notebookId });
  if (rust) return rust.sort((a, b) => (b.pinOrder - a.pinOrder) || (b.updatedAt - a.updatedAt));
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM notes WHERE notebook_id = ? ORDER BY pin_order DESC, updated_at DESC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToNote);
}

export function updateNote(id: string, update: Partial<Pick<Note, 'title' | 'content' | 'tags' | 'pinOrder' | 'sourceId'>>): void {
  const fields: string[] = [];
  if (update.title !== undefined) fields.push('title');
  if (update.content !== undefined) fields.push('content');
  if (update.tags !== undefined) fields.push('tags');
  if (update.pinOrder !== undefined) fields.push('pin_order');
  if (update.sourceId !== undefined) fields.push('source_id');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateNote 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_NOTES, { id }, wireToNote);
  if (current !== undefined) {
    if (current === null) return; // 笔记不存在：旧实现是 UPDATE 影响 0 行
    const next: Note = {
      ...current,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.content !== undefined ? { content: update.content } : {}),
      ...(update.tags !== undefined ? { tags: update.tags } : {}),
      ...(update.pinOrder !== undefined ? { pinOrder: update.pinOrder } : {}),
      ...(update.sourceId !== undefined ? { sourceId: update.sourceId ?? undefined } : {}),
      updatedAt: Date.now(),
    };
    domainWrite(T_NOTES, [noteToWire(next)], {
      mode: "replace",
      scope: "note.update",
      note: "笔记未更新（笔记不存在或写入失败）",
    });
    return;
  }

  const db = getDatabase();
  const values: (string | number | null)[] = [];
  for (const f of fields) {
    if (f === 'title') values.push(update.title as string);
    else if (f === 'content') values.push(update.content as string);
    else if (f === 'tags') values.push(JSON.stringify(update.tags));
    else if (f === 'pin_order') values.push(update.pinOrder as number);
    else values.push(update.sourceId ?? null);
  }
  values.push(Date.now());
  values.push(id);

  runGuarded(
    db,
    `UPDATE notes SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    values,
    { table: "notes", op: "update", id, from: "updateNote" },
  );
  persistDatabase();
}

export function deleteNote(id: string): void {
  if (domainDelete(T_NOTES, { id }, { scope: "note.delete", note: "笔记未删除" })) return;
  const db = getDatabase();
  db.run('DELETE FROM notes WHERE id = ?', [id]);
  persistDatabase();
}

export function deleteNotesByNotebook(notebookId: string): void {
  const removed = domainDeleteWhere(
    T_NOTES,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "note.deleteByNotebook", note: "笔记本的笔记未删除" },
  );
  if (removed !== null) return;
  const db = getDatabase();
  db.run('DELETE FROM notes WHERE notebook_id = ?', [notebookId]);
  persistDatabase();
}

function rowToNote(row: any[]): Note {
  let tags: string[] | undefined;
  const tagsJson = row[6] as string;
  if (tagsJson) {
    try { tags = JSON.parse(tagsJson); } catch { tags = undefined; }
  }
  return {
    id: row[0] as string,
    notebookId: row[1] as string,
    sourceId: row[2] as string || undefined,
    title: row[3] as string,
    content: row[4] as string || '',
    contentType: (row[5] as string || 'markdown') as NoteContentType,
    tags,
    pinOrder: row[7] as number || 0,
    createdAt: row[8] as number,
    updatedAt: row[9] as number,
  };
}

// ========== Note Links ==========

/**
 * 新增一条笔记链接。
 *
 * 第 84 波（A 类：静默空写）：原来 `INSERT OR IGNORE` 后无脑返回 void ——
 * 被唯一约束忽略（链接已存在）与"真的插进去了"完全无法区分，调用方却按"已创建"计数。
 *
 * @returns 是否真的插入了新行（false = 该链接已存在，本次没有新增）
 */
export function addNoteLink(sourceNoteId: string, targetNoteId: string, linkText?: string): boolean {
  const id = `link_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  // 迁移期：先在镜像里判断"这条链接是否已存在"，再决定写不写。
  //
  // **旧实现的返回值其实永远是 true**：`note_links` 表上**没有唯一约束**
  // （schema 里只有两个普通索引 idx_note_links_source / _target），
  // 所以 `INSERT OR IGNORE` 从来不会 IGNORE，`getRowsModified()` 也永远 > 0。
  // 已实测确认（同一对节点/链接连插两次都会落库）。
  // 这里保留"是否存在"的判断语义（调用方按它计数），并把重复写入真正挡掉。
  const existing = domainReadMany(T_LINKS, wireToNoteLink, {
    source_note_id: sourceNoteId,
    target_note_id: targetNoteId,
  });
  if (existing) {
    if (existing.length > 0) return false; // 已存在：本次没有新增
    domainWrite(
      T_LINKS,
      [{
        id,
        source_note_id: sourceNoteId,
        target_note_id: targetNoteId,
        link_text: linkText ?? null,
        created_at: now,
      }],
      { scope: "noteLink.add", note: "笔记链接未保存" },
    );
    return true;
  }

  const db = getDatabase();
  db.run(
    'INSERT OR IGNORE INTO note_links (id, source_note_id, target_note_id, link_text, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, sourceNoteId, targetNoteId, linkText ?? null, now],
  );
  let inserted = true;
  try {
    inserted = typeof (db as any).getRowsModified === "function" ? (db as any).getRowsModified() > 0 : true;
  } catch {
    inserted = true;
  }
  persistDatabase();
  return inserted;
}

export function getNoteLinks(noteId: string): NoteLink[] {
  const rust = domainReadMany(T_LINKS, wireToNoteLink);
  if (rust) {
    return rust.filter((l) => l.sourceNoteId === noteId || l.targetNoteId === noteId);
  }
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM note_links WHERE source_note_id = ? OR target_note_id = ?',
    [noteId, noteId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToNoteLink);
}

export function getBacklinks(noteId: string): NoteLink[] {
  const rust = domainReadMany(T_LINKS, wireToNoteLink, { target_note_id: noteId });
  if (rust) return rust;
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM note_links WHERE target_note_id = ?',
    [noteId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToNoteLink);
}

function rowToNoteLink(row: any[]): NoteLink {
  return {
    id: row[0] as string,
    sourceNoteId: row[1] as string,
    targetNoteId: row[2] as string,
    linkText: row[3] as string || undefined,
    createdAt: row[4] as number,
  };
}

// ========== 知识图谱 CRUD ==========
// 借鉴思路来源: Understand-Anything — 使用图谱存储实体关系
// 我们自研实现: SQLite 存储节点和边, 不依赖外部图谱数据库

function generateNodeId(): string {
  return `node_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateEdgeId(): string {
  return `edge_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function addGraphNode(
  notebookId: string,
  label: string,
  entityType: EntityType,
  description?: string,
  sourceIds: string[] = [],
  chunkIds: string[] = [],
  weight: number = 1.0,
): GraphNode {
  const id = generateNodeId();
  const now = Date.now();
  const created: GraphNode = {
    id,
    notebookId,
    label,
    entityType,
    description,
    sourceIds,
    chunkIds,
    weight,
    createdAt: now,
  };
  if (domainWrite(T_NODES, [nodeToWire(created)], { scope: "graph.addNode", note: "图谱节点未保存" })) {
    return created;
  }
  const db = getDatabase();
  db.run(
    `INSERT INTO graph_nodes (id, notebook_id, label, entity_type, description, source_ids, chunk_ids, weight, community_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [id, notebookId, label, entityType, description ?? null, JSON.stringify(sourceIds), JSON.stringify(chunkIds), weight, now],
  );
  persistDatabase();

  return created;
}

export function getGraphData(notebookId: string): GraphData {
  const rustNodes = domainReadMany(T_NODES, wireToNode, { notebook_id: notebookId });
  if (rustNodes) {
    const rustEdges = domainReadMany(T_EDGES, wireToEdge, { notebook_id: notebookId }) ?? [];
    // 旧 SQL：nodes 按 weight DESC，edges 无 ORDER BY
    return { nodes: rustNodes.sort((a, b) => b.weight - a.weight), edges: rustEdges };
  }
  const db = getDatabase();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const nodeResult = db.exec(
    'SELECT id, notebook_id, label, entity_type, description, source_ids, chunk_ids, weight, community_id, created_at FROM graph_nodes WHERE notebook_id = ? ORDER BY weight DESC',
    [notebookId],
  );
  if (nodeResult.length > 0) {
    for (const row of nodeResult[0].values) {
      let sourceIds: string[] = [];
      let chunkIds: string[] = [];
      try { sourceIds = JSON.parse(row[5] as string || '[]'); } catch { sourceIds = []; }
      try { chunkIds = JSON.parse(row[6] as string || '[]'); } catch { chunkIds = []; }
      nodes.push({
        id: row[0] as string,
        notebookId: row[1] as string,
        label: row[2] as string,
        entityType: row[3] as EntityType,
        description: row[4] as string || undefined,
        sourceIds,
        chunkIds,
        weight: row[7] as number,
        communityId: row[8] as number | undefined,
        createdAt: row[9] as number,
      });
    }
  }

  const edgeResult = db.exec(
    'SELECT id, notebook_id, source_node_id, target_node_id, relation_type, weight, created_at FROM graph_edges WHERE notebook_id = ?',
    [notebookId],
  );
  if (edgeResult.length > 0) {
    for (const row of edgeResult[0].values) {
      edges.push({
        id: row[0] as string,
        notebookId: row[1] as string,
        sourceNodeId: row[2] as string,
        targetNodeId: row[3] as string,
        relationType: row[4] as RelationType,
        weight: row[5] as number,
        createdAt: row[6] as number,
      });
    }
  }

  return { nodes, edges };
}

export function addGraphEdge(
  notebookId: string,
  sourceNodeId: string,
  targetNodeId: string,
  relationType: RelationType = 'related',
  weight: number = 1.0,
): GraphEdge | null {
  const id = generateEdgeId();
  const now = Date.now();
  const edge: GraphEdge = { id, notebookId, sourceNodeId, targetNodeId, relationType, weight, createdAt: now };

  // 迁移期：先在镜像里查"同一条边是否已存在"。
  //
  // **注意**：`graph_edges` 表上**没有唯一约束**（只有普通索引），
  // 所以旧实现的 `INSERT OR IGNORE` 永远不会 IGNORE —— 同一条边可以重复落库
  // （已实测：同一对节点连写两次，counts 返回 2）。
  // 这里保留旧实现的返回语义（总是返回构造出的 edge），但把重复写入挡掉，
  // 顺带让原来那个"永远不触发"的 catch→null 分支重新有意义。
  const existing = domainReadMany(T_EDGES, wireToEdge, {
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    relation_type: relationType,
  });
  if (existing) {
    if (existing.length > 0) return existing[0];
    const written = domainWrite(T_EDGES, [edgeToWire(edge)], { scope: "graph.addEdge", note: "图谱边未保存" });
    return written ? edge : null;
  }

  const db = getDatabase();
  try {
    db.run(
      `INSERT OR IGNORE INTO graph_edges (id, notebook_id, source_node_id, target_node_id, relation_type, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, notebookId, sourceNodeId, targetNodeId, relationType, weight, now],
    );
    persistDatabase();
    return edge;
  } catch {
    return null;
  }
}

export function deleteGraphData(notebookId: string): void {
  const removedEdges = domainDeleteWhere(
    T_EDGES,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "graph.deleteEdges", note: "图谱边未删除" },
  );
  const removedNodes = domainDeleteWhere(
    T_NODES,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "graph.deleteNodes", note: "图谱节点未删除" },
  );
  if (removedEdges !== null && removedNodes !== null) return;
  const db = getDatabase();
  db.run('DELETE FROM graph_edges WHERE notebook_id = ?', [notebookId]);
  db.run('DELETE FROM graph_nodes WHERE notebook_id = ?', [notebookId]);
  persistDatabase();
}

export function updateNodeCommunity(nodeId: string, communityId: number): void {
  const current = domainReadOne(T_NODES, { id: nodeId }, wireToNode);
  if (current !== undefined) {
    if (current === null) return; // 节点不存在：旧实现是 UPDATE 影响 0 行
    domainWrite(T_NODES, [nodeToWire({ ...current, communityId })], {
      mode: "replace",
      scope: "graph.updateCommunity",
      note: "节点社区未更新",
    });
    return;
  }
  const db = getDatabase();
  runGuarded(db, 'UPDATE graph_nodes SET community_id = ? WHERE id = ?', [communityId, nodeId],
    { table: "graph_nodes", op: "update-community", id: nodeId, from: "updateNodeCommunity" });
  persistDatabase();
}

/**
 * 查找或创建节点（按 label 匹配）。
 *
 * ## 归一处理（原实现有一处**返回值与落库不一致**）
 *
 * 旧实现在命中已有节点时：
 * - 先把 `weight` 加 1，再把**合并后的** source/chunk ids 写回库；
 * - 但**返回值**却是 `sourceIds: sourceId ? [sourceId] : []`、`weight: 2` —— 也就是
 *   "只有这一个 id、权重恒为 2"的字面量，而不是真实落库的值。
 *
 * 镜像路径如果照抄这个字面量，调用方拿到的节点就会与库里不一致（而且这个不一致
 * 会一路传下去）。这里改为**返回真实状态**：合并后的 ids 与真实的 weight。
 * 这是行为修正，不是行为变更 —— 落库内容与旧实现完全一致。
 */
export function findOrCreateNode(
  notebookId: string,
  label: string,
  entityType: EntityType,
  description?: string,
  sourceId?: string,
  chunkId?: string,
): GraphNode {
  const rust = domainReadMany(T_NODES, (r) => r, { notebook_id: notebookId, label });
  if (rust) {
    if (rust.length > 0) {
      const row = rust[0];
      const existing = wireToNode(row);
      const sourceIds = [...existing.sourceIds];
      const chunkIds = [...existing.chunkIds];
      if (sourceId && !sourceIds.includes(sourceId)) sourceIds.push(sourceId);
      if (chunkId && !chunkIds.includes(chunkId)) chunkIds.push(chunkId);
      const bumped: GraphNode = { ...existing, weight: existing.weight + 1, sourceIds, chunkIds };
      domainWrite(T_NODES, [nodeToWire(bumped)], {
        mode: "replace",
        scope: "graph.findOrCreateNode",
        note: "节点权重/引用未更新",
      });
      return bumped;
    }
    return addGraphNode(notebookId, label, entityType, description, sourceId ? [sourceId] : [], chunkId ? [chunkId] : []);
  }

  const db = getDatabase();
  const result = db.exec(
    'SELECT id FROM graph_nodes WHERE notebook_id = ? AND label = ? LIMIT 1',
    [notebookId, label],
  );
  if (result.length > 0 && result[0].values.length > 0) {
    const existingId = result[0].values[0][0] as string;
    // Update weight and append source/chunk IDs
    runGuarded(db, 'UPDATE graph_nodes SET weight = weight + 1 WHERE id = ?', [existingId],
      { table: "graph_nodes", op: "bump-weight", id: existingId, from: "findOrCreateNode" });
    if (sourceId || chunkId) {
      const nodeResult = db.exec('SELECT source_ids, chunk_ids FROM graph_nodes WHERE id = ?', [existingId]);
      if (nodeResult.length > 0) {
        let sourceIds: string[] = [];
        let chunkIds: string[] = [];
        try { sourceIds = JSON.parse(nodeResult[0].values[0][0] as string || '[]'); } catch { sourceIds = []; }
        try { chunkIds = JSON.parse(nodeResult[0].values[0][1] as string || '[]'); } catch { chunkIds = []; }
        if (sourceId && !sourceIds.includes(sourceId)) sourceIds.push(sourceId);
        if (chunkId && !chunkIds.includes(chunkId)) chunkIds.push(chunkId);
        runGuarded(
          db,
          'UPDATE graph_nodes SET source_ids = ?, chunk_ids = ? WHERE id = ?',
          [JSON.stringify(sourceIds), JSON.stringify(chunkIds), existingId],
          { table: "graph_nodes", op: "update-refs", id: existingId, from: "findOrCreateNode" },
        );
      }
    }
    persistDatabase();
    // Return reconstructed node
    return {
      id: existingId,
      notebookId,
      label,
      entityType,
      description,
      sourceIds: sourceId ? [sourceId] : [],
      chunkIds: chunkId ? [chunkId] : [],
      weight: 2,
      createdAt: Date.now(),
    };
  }
  return addGraphNode(notebookId, label, entityType, description, sourceId ? [sourceId] : [], chunkId ? [chunkId] : []);
}

// ========== Notebook Group CRUD (A14) ==========

function generateGroupId(): string {
  return `grp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createGroup(input: CreateGroupInput): NotebookGroup {
  const now = Date.now();
  const id = generateGroupId();
  const created: NotebookGroup = {
    id,
    name: input.name,
    parentId: input.parentId,
    sortOrder: 0,
    createdAt: now,
  };
  if (domainWrite(T_GROUPS, [groupToWire(created)], { scope: "group.create", note: "分组未保存" })) {
    return created;
  }
  const db = getDatabase();
  db.run(
    `INSERT INTO notebook_groups (id, name, parent_id, sort_order, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    [id, input.name, input.parentId ?? null, now],
  );
  persistDatabase();

  return created;
}

export function listGroups(parentId?: string | null): NotebookGroup[] {
  const rust = domainReadMany(T_GROUPS, wireToGroup);
  if (rust) {
    const filtered = parentId === undefined
      ? rust
      : rust.filter((g) => (parentId === null ? g.parentId === undefined : g.parentId === parentId));
    // 旧 SQL：ORDER BY sort_order ASC, name ASC
    return filtered.sort((a, b) => (a.sortOrder - b.sortOrder) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const db = getDatabase();
  const result = parentId === undefined
    ? db.exec('SELECT * FROM notebook_groups ORDER BY sort_order ASC, name ASC')
    : parentId === null
      ? db.exec('SELECT * FROM notebook_groups WHERE parent_id IS NULL ORDER BY sort_order ASC, name ASC')
      : db.exec('SELECT * FROM notebook_groups WHERE parent_id = ? ORDER BY sort_order ASC, name ASC', [parentId]);
  if (result.length === 0) return [];
  return result[0].values.map(rowToGroup);
}

export function updateGroup(id: string, update: Partial<Pick<NotebookGroup, 'name' | 'parentId' | 'sortOrder'>>): void {
  const fields: string[] = [];
  if (update.name !== undefined) fields.push('name');
  if (update.parentId !== undefined) fields.push('parent_id');
  if (update.sortOrder !== undefined) fields.push('sort_order');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateGroup 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_GROUPS, { id }, wireToGroup);
  if (current !== undefined) {
    if (current === null) return; // 分组不存在：旧实现是 UPDATE 影响 0 行
    const next: NotebookGroup = {
      ...current,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.parentId !== undefined ? { parentId: update.parentId ?? undefined } : {}),
      ...(update.sortOrder !== undefined ? { sortOrder: update.sortOrder } : {}),
    };
    domainWrite(T_GROUPS, [groupToWire(next)], {
      mode: "replace",
      scope: "group.update",
      note: "分组未更新（分组不存在或写入失败）",
    });
    return;
  }

  const db = getDatabase();
  const values: (string | number | null)[] = [];
  for (const f of fields) {
    if (f === 'name') values.push(update.name as string);
    else if (f === 'parent_id') values.push(update.parentId ?? null);
    else values.push(update.sortOrder as number);
  }
  values.push(id);
  runGuarded(
    db,
    `UPDATE notebook_groups SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
    values,
    { table: "notebook_groups", op: "update", id, from: "updateGroup" },
  );
  persistDatabase();
}

export function deleteGroup(id: string): void {
  // 先把该分组下的笔记本移到"未分组"（旧实现是 `UPDATE notebooks SET group_id = NULL WHERE group_id = ?`），
  // 再删分组。两步都必须走域端口：只删旧库的话，下一次整体写回会把 group_id 又写回去。
  const moved = domainReadMany(T_NOTEBOOKS, wireToNotebook);
  let handled = false;
  if (moved) {
    const inGroup = moved.filter((nb) => nb.groupId === id);
    if (inGroup.length > 0) {
      domainWrite(T_NOTEBOOKS, inGroup.map((nb) => notebookToWire({ ...nb, groupId: undefined })), {
        mode: "replace",
        scope: "group.ungroup",
        note: "分组下的笔记本未移到未分组",
      });
    }
    handled = domainDelete(T_GROUPS, { id }, { scope: "group.delete", note: "分组未删除" });
  }
  if (handled) return;

  const db = getDatabase();
  // Move notebooks in this group to ungrouped
  db.run('UPDATE notebooks SET group_id = NULL WHERE group_id = ?', [id]);
  // Delete child groups (cascade)
  db.run('DELETE FROM notebook_groups WHERE id = ?', [id]);
  persistDatabase();
}

function rowToGroup(row: any[]): NotebookGroup {
  return {
    id: row[0] as string,
    name: row[1] as string,
    parentId: row[2] as string || undefined,
    sortOrder: row[3] as number,
    createdAt: row[4] as number,
  };
}

// ========== Note Version History (A17) ==========

function generateVersionId(): string {
  return `ver_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function saveNoteVersion(noteId: string, versionNote?: string): void {
  const note = getNote(noteId);
  if (!note) return;

  const id = generateVersionId();
  const now = Date.now();
  const created: NoteVersion = {
    id,
    noteId,
    title: note.title,
    content: note.content,
    tags: note.tags,
    versionNote,
    createdAt: now,
  };
  if (domainWrite(T_VERSIONS, [versionToWire(created)], { scope: "noteVersion.save", note: "笔记版本未保存" })) {
    return;
  }
  const db = getDatabase();
  const tagsJson = note.tags ? JSON.stringify(note.tags) : null;
  db.run(
    `INSERT INTO note_versions (id, note_id, title, content, tags, version_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, noteId, note.title, note.content, tagsJson, versionNote ?? null, now],
  );
  persistDatabase();
}

export function listNoteVersions(noteId: string): NoteVersion[] {
  const rust = domainReadMany(T_VERSIONS, wireToVersion, { note_id: noteId });
  if (rust) return rust.sort((a, b) => b.createdAt - a.createdAt);
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, note_id, title, content, tags, version_note, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC',
    [noteId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToVersion);
}

export function getNoteVersion(versionId: string): NoteVersion | null {
  const rust = domainReadOne(T_VERSIONS, { id: versionId }, wireToVersion);
  if (rust !== undefined) return rust;
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, note_id, title, content, tags, version_note, created_at FROM note_versions WHERE id = ?',
    [versionId],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToVersion(result[0].values[0]);
}

export function restoreNoteVersion(versionId: string): void {
  const version = getNoteVersion(versionId);
  if (!version) return;

  // Save current state as a new version before restoring
  saveNoteVersion(version.noteId, 'Auto-saved before restore');

  // Restore the note to the version's content
  let tags: string[] | undefined;
  if (version.tags) {
    try { tags = JSON.parse(version.tags as any); } catch { tags = undefined; }
  }
  updateNote(version.noteId, {
    title: version.title,
    content: version.content,
    tags,
  });
}

export function deleteNoteVersion(versionId: string): void {
  if (domainDelete(T_VERSIONS, { id: versionId }, { scope: "noteVersion.delete", note: "笔记版本未删除" })) return;
  const db = getDatabase();
  db.run('DELETE FROM note_versions WHERE id = ?', [versionId]);
  persistDatabase();
}

function rowToVersion(row: any[]): NoteVersion {
  let tags: string[] | undefined;
  const tagsJson = row[4] as string;
  if (tagsJson) {
    try { tags = JSON.parse(tagsJson); } catch { tags = undefined; }
  }
  return {
    id: row[0] as string,
    noteId: row[1] as string,
    title: row[2] as string,
    content: row[3] as string,
    tags,
    versionNote: row[5] as string || undefined,
    createdAt: row[6] as number,
  };
}

// ========== Graph Node/Edge Edit (C3) ==========

export function updateGraphNode(
  nodeId: string,
  update: Partial<Pick<GraphNode, 'label' | 'entityType' | 'description'>>,
): void {
  const current = domainReadOne(T_NODES, { id: nodeId }, wireToNode);
  if (current !== undefined) {
    if (current === null) return; // 节点不存在：旧实现是 UPDATE 影响 0 行
    const next: GraphNode = {
      ...current,
      ...(update.label !== undefined ? { label: update.label } : {}),
      ...(update.entityType !== undefined ? { entityType: update.entityType } : {}),
      ...(update.description !== undefined ? { description: update.description ?? undefined } : {}),
    };
    domainWrite(T_NODES, [nodeToWire(next)], {
      mode: "replace",
      scope: "graph.updateNode",
      note: "图谱节点未更新（节点不存在或写入失败）",
    });
    return;
  }

  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.label !== undefined) { fields.push('label = ?'); values.push(update.label); }
  if (update.entityType !== undefined) { fields.push('entity_type = ?'); values.push(update.entityType); }
  if (update.description !== undefined) { fields.push('description = ?'); values.push(update.description ?? null); }

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateGraphNode 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }
  values.push(nodeId);
  runGuarded(
    db,
    `UPDATE graph_nodes SET ${fields.join(', ')} WHERE id = ?`,
    values,
    { table: "graph_nodes", op: "update", id: nodeId, from: "updateGraphNode" },
  );
  persistDatabase();
}

export function deleteGraphNode(nodeId: string): void {
  // 旧实现是两条 DELETE：先删所有与该节点相连的边，再删节点本身。
  const removedEdges = domainDeleteWhere(
    T_EDGES,
    (row) => row.source_node_id === nodeId || row.target_node_id === nodeId,
    "id",
    { scope: "graph.deleteNodeEdges", note: "节点相连的边未删除" },
  );
  const removedNode = domainDelete(T_NODES, { id: nodeId }, { scope: "graph.deleteNode", note: "节点未删除" });
  if (removedEdges !== null && removedNode) return;
  const db = getDatabase();
  db.run('DELETE FROM graph_edges WHERE source_node_id = ? OR target_node_id = ?', [nodeId, nodeId]);
  db.run('DELETE FROM graph_nodes WHERE id = ?', [nodeId]);
  persistDatabase();
}

export function deleteGraphEdge(edgeId: string): void {
  if (domainDelete(T_EDGES, { id: edgeId }, { scope: "graph.deleteEdge", note: "图谱边未删除" })) return;
  const db = getDatabase();
  db.run('DELETE FROM graph_edges WHERE id = ?', [edgeId]);
  persistDatabase();
}

export function getGraphEdgeById(edgeId: string): GraphEdge | null {
  const rust = domainReadOne(T_EDGES, { id: edgeId }, wireToEdge);
  if (rust !== undefined) return rust;
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, notebook_id, source_node_id, target_node_id, relation_type, weight, created_at FROM graph_edges WHERE id = ?',
    [edgeId],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const row = result[0].values[0];
  return {
    id: row[0] as string,
    notebookId: row[1] as string,
    sourceNodeId: row[2] as string,
    targetNodeId: row[3] as string,
    relationType: row[4] as RelationType,
    weight: row[5] as number,
    createdAt: row[6] as number,
  };
}