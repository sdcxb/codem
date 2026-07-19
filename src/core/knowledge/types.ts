/**
 * 笔记本式知识管理 — 类型定义
 *
 * 对标 NotebookLM：Notebook → Source → Chunk → Retrieval
 */

// ========== Notebook ==========

export interface Notebook {
  id: string;
  name: string;
  description?: string;
  summary?: string;
  summaryStatus: SummaryStatus;
  sourceCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export type SummaryStatus = 'pending' | 'generating' | 'completed' | 'failed';

// ========== Source ==========

export type SourceType = 'file' | 'text' | 'url';
export type SourceStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface NotebookSource {
  id: string;
  notebookId: string;
  name: string;
  type: SourceType;
  content?: string;
  filePath?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  status: SourceStatus;
  chunkCount: number;
  errorMessage?: string;
  createdAt: number;
}

// ========== Chunk ==========

export interface NotebookChunk {
  id: string;
  sourceId: string;
  notebookId: string;
  content: string;
  chunkIndex: number;
  embedding: Float32Array | null;
  tokenCount: number;
  createdAt: number;
}

// ========== Retrieval ==========

export interface RetrievalResult {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  content: string;
  score: number;
  chunkIndex: number;
}

// ========== Indexing Progress ==========

export interface IndexProgress {
  sourceId: string;
  sourceName: string;
  status: SourceStatus;
  currentChunk?: number;
  totalChunks?: number;
  error?: string;
}

export type IndexProgressCallback = (progress: IndexProgress) => void;

// ========== Config ==========

export interface NotebookConfig {
  maxChunkSize: number;   // characters, default 2000
  overlapSize: number;    // characters, default 200
  topK: number;           // default 5
  similarityThreshold: number; // default 0.3
}

export const DEFAULT_CONFIG: NotebookConfig = {
  maxChunkSize: 2000,
  overlapSize: 200,
  topK: 5,
  similarityThreshold: 0.3,
};

// ========== Create Input ==========

export interface CreateNotebookInput {
  name: string;
  description?: string;
}

export interface AddSourceInput {
  notebookId: string;
  name: string;
  type: SourceType;
  content?: string;
  filePath?: string;
  url?: string;
  mimeType?: string;
  size?: number;
}
