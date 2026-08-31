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

// ========== Notebook CRUD ==========

export function createNotebook(input: CreateNotebookInput): Notebook {
  const db = getDatabase();
  const now = Date.now();
  const id = generateId();

  db.run(
    `INSERT INTO notebooks (id, name, description, summary, summary_status, source_count, chunk_count, group_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'pending', 0, 0, ?, ?, ?)`,
    [id, input.name, input.description ?? null, input.groupId ?? null, now, now],
  );
  persistDatabase();

  return {
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
}

export function getNotebook(id: string): Notebook | null {
  const db = getDatabase();
  const result = db.exec('SELECT * FROM notebooks WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToNotebook(result[0].values[0]);
}

export function listNotebooks(): Notebook[] {
  const db = getDatabase();
  const result = db.exec('SELECT * FROM notebooks ORDER BY updated_at DESC');
  if (result.length === 0) return [];
  return result[0].values.map(rowToNotebook);
}

export function listNotebooksByGroup(groupId: string | null): Notebook[] {
  const db = getDatabase();
  const result = groupId === null
    ? db.exec('SELECT * FROM notebooks WHERE group_id IS NULL ORDER BY updated_at DESC')
    : db.exec('SELECT * FROM notebooks WHERE group_id = ? ORDER BY updated_at DESC', [groupId]);
  if (result.length === 0) return [];
  return result[0].values.map(rowToNotebook);
}

export function updateNotebook(id: string, update: Partial<Pick<Notebook, 'name' | 'description' | 'summary' | 'summaryStatus' | 'groupId'>>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.name !== undefined) { fields.push('name = ?'); values.push(update.name); }
  if (update.description !== undefined) { fields.push('description = ?'); values.push(update.description ?? null); }
  if (update.summary !== undefined) { fields.push('summary = ?'); values.push(update.summary); }
  if (update.summaryStatus !== undefined) { fields.push('summary_status = ?'); values.push(update.summaryStatus); }
  if (update.groupId !== undefined) { fields.push('group_id = ?'); values.push(update.groupId ?? null); }

  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.run(`UPDATE notebooks SET ${fields.join(', ')} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteNotebook(id: string): void {
  const db = getDatabase();
  db.run('DELETE FROM notebooks WHERE id = ?', [id]);
  persistDatabase();
}

/** Update aggregated counts after source/chunk changes */
export function refreshNotebookCounts(notebookId: string): void {
  const db = getDatabase();

  const srcResult = db.exec(
    'SELECT COUNT(*) as cnt FROM notebook_sources WHERE notebook_id = ?',
    [notebookId],
  );
  const sourceCount = srcResult.length > 0 ? (srcResult[0].values[0][0] as number) : 0;

  const chunkResult = db.exec(
    'SELECT COUNT(*) as cnt FROM notebook_chunks WHERE notebook_id = ?',
    [notebookId],
  );
  const chunkCount = chunkResult.length > 0 ? (chunkResult[0].values[0][0] as number) : 0;

  db.run(
    'UPDATE notebooks SET source_count = ?, chunk_count = ?, updated_at = ? WHERE id = ?',
    [sourceCount, chunkCount, Date.now(), notebookId],
  );
  persistDatabase();
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
  const db = getDatabase();
  const now = Date.now();
  const id = generateSourceId();

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

  return {
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
}

export function getSource(id: string): NotebookSource | null {
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, notebook_id, name, type, content, file_path, url, mime_type, size, status, chunk_count, error_message, summary, key_topics, created_at FROM notebook_sources WHERE id = ?',
    [id],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToSource(result[0].values[0]);
}

export function listSources(notebookId: string): NotebookSource[] {
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, notebook_id, name, type, content, file_path, url, mime_type, size, status, chunk_count, error_message, summary, key_topics, created_at FROM notebook_sources WHERE notebook_id = ? ORDER BY created_at ASC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSource);
}

export function updateSource(id: string, update: Partial<Pick<NotebookSource, 'status' | 'chunkCount' | 'errorMessage' | 'summary' | 'keyTopics'>>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.status !== undefined) { fields.push('status = ?'); values.push(update.status); }
  if (update.chunkCount !== undefined) { fields.push('chunk_count = ?'); values.push(update.chunkCount); }
  if (update.errorMessage !== undefined) { fields.push('error_message = ?'); values.push(update.errorMessage ?? null); }
  if (update.summary !== undefined) { fields.push('summary = ?'); values.push(update.summary); }
  if (update.keyTopics !== undefined) { fields.push('key_topics = ?'); values.push(update.keyTopics ? JSON.stringify(update.keyTopics) : null); }

  if (fields.length === 0) return;
  values.push(id);

  db.run(`UPDATE notebook_sources SET ${fields.join(', ')} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteSource(id: string): void {
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
  const db = getDatabase();
  const now = Date.now();
  const id = generateChunkId();
  const embeddingBlob = chunk.embedding ? embeddingToBase64(chunk.embedding) : null;

  db.run(
    `INSERT INTO notebook_chunks (id, source_id, notebook_id, content, chunk_index, embedding, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, chunk.sourceId, chunk.notebookId, chunk.content, chunk.chunkIndex, embeddingBlob, chunk.tokenCount, now],
  );

  return {
    ...chunk,
    id,
    createdAt: now,
  };
}

export function addChunksBulk(notebookId: string, sourceId: string, chunks: { content: string; chunkIndex: number; embedding: Float32Array | null; tokenCount: number }[]): void {
  const db = getDatabase();
  const now = Date.now();

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
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, source_id, notebook_id, content, chunk_index, embedding, token_count, created_at FROM notebook_chunks WHERE notebook_id = ? ORDER BY chunk_index ASC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToChunk);
}

export function getChunkCount(notebookId: string): number {
  const db = getDatabase();
  const result = db.exec(
    'SELECT COUNT(*) FROM notebook_chunks WHERE notebook_id = ?',
    [notebookId],
  );
  if (result.length === 0) return 0;
  return result[0].values[0][0] as number;
}

export function deleteChunksBySource(sourceId: string): void {
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
  const db = getDatabase();
  const now = Date.now();
  const id = generateNoteId();
  const tagsJson = input.tags ? JSON.stringify(input.tags) : null;

  db.run(
    `INSERT INTO notes (id, notebook_id, source_id, title, content, content_type, tags, pin_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, input.notebookId, input.sourceId ?? null, input.title, input.content ?? '', input.contentType ?? 'markdown', tagsJson, now, now],
  );
  persistDatabase();

  return {
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
}

export function getNote(id: string): Note | null {
  const db = getDatabase();
  const result = db.exec('SELECT * FROM notes WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToNote(result[0].values[0]);
}

export function listNotes(notebookId: string): Note[] {
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM notes WHERE notebook_id = ? ORDER BY pin_order DESC, updated_at DESC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToNote);
}

export function updateNote(id: string, update: Partial<Pick<Note, 'title' | 'content' | 'tags' | 'pinOrder' | 'sourceId'>>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.title !== undefined) { fields.push('title = ?'); values.push(update.title); }
  if (update.content !== undefined) { fields.push('content = ?'); values.push(update.content); }
  if (update.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(update.tags)); }
  if (update.pinOrder !== undefined) { fields.push('pin_order = ?'); values.push(update.pinOrder); }
  if (update.sourceId !== undefined) { fields.push('source_id = ?'); values.push(update.sourceId ?? null); }

  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.run(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteNote(id: string): void {
  const db = getDatabase();
  db.run('DELETE FROM notes WHERE id = ?', [id]);
  persistDatabase();
}

export function deleteNotesByNotebook(notebookId: string): void {
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

export function addNoteLink(sourceNoteId: string, targetNoteId: string, linkText?: string): void {
  const db = getDatabase();
  const id = `link_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    'INSERT OR IGNORE INTO note_links (id, source_note_id, target_note_id, link_text, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, sourceNoteId, targetNoteId, linkText ?? null, Date.now()],
  );
  persistDatabase();
}

export function getNoteLinks(noteId: string): NoteLink[] {
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM note_links WHERE source_note_id = ? OR target_note_id = ?',
    [noteId, noteId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToNoteLink);
}

export function getBacklinks(noteId: string): NoteLink[] {
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
  const db = getDatabase();
  const id = generateNodeId();
  const now = Date.now();

  db.run(
    `INSERT INTO graph_nodes (id, notebook_id, label, entity_type, description, source_ids, chunk_ids, weight, community_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [id, notebookId, label, entityType, description ?? null, JSON.stringify(sourceIds), JSON.stringify(chunkIds), weight, now],
  );
  persistDatabase();

  return {
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
}

export function getGraphData(notebookId: string): GraphData {
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
  const db = getDatabase();
  const id = generateEdgeId();
  const now = Date.now();

  try {
    db.run(
      `INSERT OR IGNORE INTO graph_edges (id, notebook_id, source_node_id, target_node_id, relation_type, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, notebookId, sourceNodeId, targetNodeId, relationType, weight, now],
    );
    persistDatabase();
    return {
      id,
      notebookId,
      sourceNodeId,
      targetNodeId,
      relationType,
      weight,
      createdAt: now,
    };
  } catch {
    return null;
  }
}

export function deleteGraphData(notebookId: string): void {
  const db = getDatabase();
  db.run('DELETE FROM graph_edges WHERE notebook_id = ?', [notebookId]);
  db.run('DELETE FROM graph_nodes WHERE notebook_id = ?', [notebookId]);
  persistDatabase();
}

export function updateNodeCommunity(nodeId: string, communityId: number): void {
  const db = getDatabase();
  db.run('UPDATE graph_nodes SET community_id = ? WHERE id = ?', [communityId, nodeId]);
  persistDatabase();
}

/** 查找或创建节点（按 label 匹配） */
export function findOrCreateNode(
  notebookId: string,
  label: string,
  entityType: EntityType,
  description?: string,
  sourceId?: string,
  chunkId?: string,
): GraphNode {
  const db = getDatabase();
  const result = db.exec(
    'SELECT id FROM graph_nodes WHERE notebook_id = ? AND label = ? LIMIT 1',
    [notebookId, label],
  );
  if (result.length > 0 && result[0].values.length > 0) {
    const existingId = result[0].values[0][0] as string;
    // Update weight and append source/chunk IDs
    db.run('UPDATE graph_nodes SET weight = weight + 1 WHERE id = ?', [existingId]);
    if (sourceId || chunkId) {
      const nodeResult = db.exec('SELECT source_ids, chunk_ids FROM graph_nodes WHERE id = ?', [existingId]);
      if (nodeResult.length > 0) {
        let sourceIds: string[] = [];
        let chunkIds: string[] = [];
        try { sourceIds = JSON.parse(nodeResult[0].values[0][0] as string || '[]'); } catch { sourceIds = []; }
        try { chunkIds = JSON.parse(nodeResult[0].values[0][1] as string || '[]'); } catch { chunkIds = []; }
        if (sourceId && !sourceIds.includes(sourceId)) sourceIds.push(sourceId);
        if (chunkId && !chunkIds.includes(chunkId)) chunkIds.push(chunkId);
        db.run('UPDATE graph_nodes SET source_ids = ?, chunk_ids = ? WHERE id = ?', [
          JSON.stringify(sourceIds), JSON.stringify(chunkIds), existingId,
        ]);
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
  const db = getDatabase();
  const now = Date.now();
  const id = generateGroupId();

  db.run(
    `INSERT INTO notebook_groups (id, name, parent_id, sort_order, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    [id, input.name, input.parentId ?? null, now],
  );
  persistDatabase();

  return {
    id,
    name: input.name,
    parentId: input.parentId,
    sortOrder: 0,
    createdAt: now,
  };
}

export function listGroups(parentId?: string | null): NotebookGroup[] {
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
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.name !== undefined) { fields.push('name = ?'); values.push(update.name); }
  if (update.parentId !== undefined) { fields.push('parent_id = ?'); values.push(update.parentId ?? null); }
  if (update.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(update.sortOrder); }

  if (fields.length === 0) return;
  values.push(id);
  db.run(`UPDATE notebook_groups SET ${fields.join(', ')} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteGroup(id: string): void {
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
  const db = getDatabase();
  const note = getNote(noteId);
  if (!note) return;

  const id = generateVersionId();
  const now = Date.now();
  const tagsJson = note.tags ? JSON.stringify(note.tags) : null;

  db.run(
    `INSERT INTO note_versions (id, note_id, title, content, tags, version_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, noteId, note.title, note.content, tagsJson, versionNote ?? null, now],
  );
  persistDatabase();
}

export function listNoteVersions(noteId: string): NoteVersion[] {
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, note_id, title, content, tags, version_note, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC',
    [noteId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToVersion);
}

export function getNoteVersion(versionId: string): NoteVersion | null {
  const db = getDatabase();
  const result = db.exec(
    'SELECT id, note_id, title, content, tags, version_note, created_at FROM note_versions WHERE id = ?',
    [versionId],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToVersion(result[0].values[0]);
}

export function restoreNoteVersion(versionId: string): void {
  const db = getDatabase();
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
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.label !== undefined) { fields.push('label = ?'); values.push(update.label); }
  if (update.entityType !== undefined) { fields.push('entity_type = ?'); values.push(update.entityType); }
  if (update.description !== undefined) { fields.push('description = ?'); values.push(update.description ?? null); }

  if (fields.length === 0) return;
  values.push(nodeId);
  db.run(`UPDATE graph_nodes SET ${fields.join(', ')} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteGraphNode(nodeId: string): void {
  const db = getDatabase();
  db.run('DELETE FROM graph_edges WHERE source_node_id = ? OR target_node_id = ?', [nodeId, nodeId]);
  db.run('DELETE FROM graph_nodes WHERE id = ?', [nodeId]);
  persistDatabase();
}

export function deleteGraphEdge(edgeId: string): void {
  const db = getDatabase();
  db.run('DELETE FROM graph_edges WHERE id = ?', [edgeId]);
  persistDatabase();
}

export function getGraphEdgeById(edgeId: string): GraphEdge | null {
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
