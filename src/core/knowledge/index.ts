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
  ExtractedEntity,
  ExtractedRelation,
  Slide,
  SlideLayout,
} from './types';

export { DEFAULT_CONFIG } from './types';

// Storage (CRUD)
export {
  createNotebook,
  getNotebook,
  listNotebooks,
  listNotebooksByGroup,
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
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
  deleteNotesByNotebook,
  addNoteLink,
  getNoteLinks,
  getBacklinks,
  // 知识图谱 CRUD (借鉴 Understand-Anything 思路)
  addGraphNode,
  getGraphData,
  addGraphEdge,
  deleteGraphData,
  updateNodeCommunity,
  findOrCreateNode,
  updateGraphNode,
  deleteGraphNode,
  deleteGraphEdge,
  getGraphEdgeById,
  // A14: 笔记本分组
  createGroup,
  listGroups,
  updateGroup,
  deleteGroup,
  // A17: 笔记版本历史
  saveNoteVersion,
  listNoteVersions,
  getNoteVersion,
  restoreNoteVersion,
  deleteNoteVersion,
} from './storage';

// Extractor
export { extractText, extractFromUrl, stripHtml } from './extractor';
export { extractPdfText, isPdfFile } from './pdf-extractor';

// Chunker
export { chunkText, estimateTokens } from './chunker';

// Indexer
export { indexSource, indexNotebook, generateSummary, generateGuidedQuestions, reindexSource, deleteSourceAndCleanup, getNotebookConfig, generateStudioContent, generateSourceSummary, generateFlashcards } from './indexer';
export type { StudioContentType, StudioContentResult, GeneratedFlashcard } from './indexer';

// Retriever
export { retrieve, retrieveWithContext, clearRetrievalCache, setActiveSourceFilter, getActiveSourceFilter } from './retriever';

// 知识图谱实体提取 (借鉴 Understand-Anything 思路, 自研实现)
export { extractKnowledgeGraph } from './graph-extractor';

// 笔记链接管理 (借鉴 Lumina Note 的 WikiLinks 思路, 自研实现)
export {
  parseWikiLinks,
  wikilinksToMarkdown,
  findNoteByTitle,
  syncNoteLinks,
  getOutgoingLinks,
  getIncomingLinks,
  getLinkStats,
} from './note-manager';
export type { ParsedWikiLink } from './note-manager';

// PPT 幻灯片生成 (自研可视化编辑器, 元素模型 V2)
export { generatePPTContent, serializeSlideDeck, deserializeSlideDeck, migrateOldDeck } from './ppt-generator';
export { PPT_THEMES } from './ppt-types';
export type { V2SlideDeck, V2Slide, SlideElement, PPTTheme } from './ppt-types';

// 笔记本导出 (对标 NotebookLM 导出功能)
export { exportNotebookAsMarkdown, exportNoteAsMarkdown, downloadMarkdown } from './exporter';

// 笔记本导入 (A15: 从导出的 Markdown 重建结构)
export { importNotebookFromMarkdown, importNotebookFromFile } from './importer';
export type { ImportResult } from './importer';

// 学习路径生成 (借鉴 Understand-Anything Guided Tours 思路, 自研拓扑排序实现)
export { generateStudyPath } from './study-path';
export type { StudyPathItem, StudyPath } from './study-path';
