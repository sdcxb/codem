/**
 * 笔记本式知识管理 — 模块导出
 */

// Types
export type {
  Notebook,
  NotebookSource,
  NotebookChunk,
  RetrievalResult,
  IndexProgress,
  IndexProgressCallback,
  NotebookConfig,
  CreateNotebookInput,
  AddSourceInput,
  SourceType,
  SourceStatus,
  SummaryStatus,
} from './types';

export { DEFAULT_CONFIG } from './types';

// Storage (CRUD)
export {
  createNotebook,
  getNotebook,
  listNotebooks,
  updateNotebook,
  deleteNotebook,
  refreshNotebookCounts,
  addSource,
  getSource,
  listSources,
  updateSource,
  deleteSource,
  addChunk,
  addChunksBulk,
  getChunks,
  getChunkCount,
  deleteChunksBySource,
  embeddingToBase64,
  base64ToEmbedding,
} from './storage';

// Extractor
export { extractText, extractFromUrl, stripHtml } from './extractor';
export { extractPdfText, isPdfFile } from './pdf-extractor';

// Chunker
export { chunkText, estimateTokens } from './chunker';

// Indexer
export { indexSource, indexNotebook, generateSummary, generateGuidedQuestions, reindexSource, deleteSourceAndCleanup, getNotebookConfig } from './indexer';

// Retriever
export { retrieve } from './retriever';
