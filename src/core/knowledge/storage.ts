/**
 * 笔记本式知识管理 — SQLite CRUD 存储层
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
    `INSERT INTO notebooks (id, name, description, summary, summary_status, source_count, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'pending', 0, 0, ?, ?)`,
    [id, input.name, input.description ?? null, now, now],
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

export function updateNotebook(id: string, update: Partial<Pick<Notebook, 'name' | 'description' | 'summary' | 'summaryStatus'>>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.name !== undefined) { fields.push('name = ?'); values.push(update.name); }
  if (update.description !== undefined) { fields.push('description = ?'); values.push(update.description ?? null); }
  if (update.summary !== undefined) { fields.push('summary = ?'); values.push(update.summary); }
  if (update.summaryStatus !== undefined) { fields.push('summary_status = ?'); values.push(update.summaryStatus); }

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
  const result = db.exec('SELECT * FROM notebook_sources WHERE id = ?', [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return rowToSource(result[0].values[0]);
}

export function listSources(notebookId: string): NotebookSource[] {
  const db = getDatabase();
  const result = db.exec(
    'SELECT * FROM notebook_sources WHERE notebook_id = ? ORDER BY created_at ASC',
    [notebookId],
  );
  if (result.length === 0) return [];
  return result[0].values.map(rowToSource);
}

export function updateSource(id: string, update: Partial<Pick<NotebookSource, 'status' | 'chunkCount' | 'errorMessage'>>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.status !== undefined) { fields.push('status = ?'); values.push(update.status); }
  if (update.chunkCount !== undefined) { fields.push('chunk_count = ?'); values.push(update.chunkCount); }
  if (update.errorMessage !== undefined) { fields.push('error_message = ?'); values.push(update.errorMessage ?? null); }

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
    createdAt: row[12] as number,
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


