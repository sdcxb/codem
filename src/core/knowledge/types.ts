/**
 * 笔记本式知识管理 — 类型定义
 *
 * 对标 NotebookLM：Notebook → Source → Chunk → Retrieval
 * 知识图谱功能借鉴思路来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
 * PPT 生成功能借鉴思路来源: oh-my-ppt (https://github.com/arcsin1/oh-my-ppt)
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
  groupId?: string;
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
  summary?: string;       // 来源独立摘要 (对标 NotebookLM)
  keyTopics?: string[];   // 来源关键话题 (对标 NotebookLM)
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

// ========== Notebook Groups (A14) ==========

export interface NotebookGroup {
  id: string;
  name: string;
  parentId?: string;
  sortOrder: number;
  createdAt: number;
}

export interface CreateGroupInput {
  name: string;
  parentId?: string;
}

// ========== Note Version History (A17) ==========

export interface NoteVersion {
  id: string;
  noteId: string;
  title: string;
  content: string;
  tags?: string[];
  versionNote?: string;
  createdAt: number;
}

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
  groupId?: string;
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

// ========== Note ==========

export type NoteContentType = 'markdown' | 'text' | 'ppt';

export interface Note {
  id: string;
  notebookId: string;
  sourceId?: string;
  title: string;
  content: string;
  contentType: NoteContentType;
  tags?: string[];
  pinOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNoteInput {
  notebookId: string;
  title: string;
  content?: string;
  sourceId?: string;
  contentType?: NoteContentType;
  tags?: string[];
}

export interface NoteLink {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  linkText?: string;
  createdAt: number;
}

// ========== 知识图谱 ==========
// 借鉴思路来源: Understand-Anything — 交互式知识图谱
// 该项目使用 LLM Agent 管道提取实体和关系;
// 我们自研实现: 使用现有 LLM provider 提取, SQLite 存储, Canvas 渲染

/** 实体类型 */
export type EntityType = 'concept' | 'entity' | 'event' | 'person' | 'place' | 'organization' | 'technology';

/** 关系类型 */
export type RelationType = 'related' | 'part_of' | 'depends_on' | 'derived_from' | 'contradicts' | 'supports' | 'precedes';

/** 图谱节点 */
export interface GraphNode {
  id: string;
  notebookId: string;
  label: string;
  entityType: EntityType;
  description?: string;
  sourceIds: string[];
  chunkIds: string[];
  weight: number;
  communityId?: number;
  createdAt: number;
}

/** 图谱边 */
export interface GraphEdge {
  id: string;
  notebookId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: RelationType;
  weight: number;
  createdAt: number;
}

/** 完整图谱数据 */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** LLM 提取的原始实体 */
export interface ExtractedEntity {
  label: string;
  entityType: EntityType;
  description?: string;
  sourceChunkId: string;
}

/** LLM 提取的原始关系 */
export interface ExtractedRelation {
  sourceLabel: string;
  targetLabel: string;
  relationType: RelationType;
}

// ========== PPT 幻灯片 (旧格式, 已迁移到 ppt-types.ts) ==========
// 保留导出用于向后兼容
import type { V2SlideDeck, PPTTheme } from './ppt-types';
export type { V2SlideDeck as SlideDeck, PPTTheme };

/** PPT 笔记内容类型 */
export type SlideContentType = 'ppt';

/** 旧格式兼容类型 */
export interface Slide {
  id: string;
  index: number;
  html: string;
  layout: string;
  notes?: string;
}

export type SlideLayout = 'title' | 'title_content' | 'two_column' | 'image_text' | 'section' | 'conclusion';
