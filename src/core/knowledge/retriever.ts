/**
 * 笔记本式知识管理 — 语义检索引擎
 *
 * 流程：query embedding → 加载所有 chunk embedding → cosine 相似度排序 → top-K
 */

import { generateEmbeddings, cosineSimilarity } from '../llm/multimodal';
import { getChunks, listSources } from './storage';
import type { RetrievalResult, NotebookConfig } from './types';
import { DEFAULT_CONFIG } from './types';
import { getSettingJSON } from '../storage/settings';

const NOTEBOOK_CONFIG_KEY = 'codem-notebook-config';

function getConfig(): NotebookConfig {
  return { ...DEFAULT_CONFIG, ...getSettingJSON<Partial<NotebookConfig>>(NOTEBOOK_CONFIG_KEY, {}) };
}

// ========== 检索缓存 ==========

const queryEmbeddingCache = new Map<string, Float32Array>();
const CACHE_MAX_SIZE = 50;

function cacheQuery(query: string, embedding: Float32Array): void {
  if (queryEmbeddingCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry
    const firstKey = queryEmbeddingCache.keys().next().value;
    if (firstKey) queryEmbeddingCache.delete(firstKey);
  }
  queryEmbeddingCache.set(query, embedding);
}

function getCachedQuery(query: string): Float32Array | null {
  const cached = queryEmbeddingCache.get(query);
  if (cached) {
    // Move to end (most recently used)
    queryEmbeddingCache.delete(query);
    queryEmbeddingCache.set(query, cached);
  }
  return cached || null;
}

// ========== 主检索函数 ==========

export async function retrieve(
  query: string,
  notebookId: string,
  config?: Partial<NotebookConfig>,
): Promise<RetrievalResult[]> {
  const cfg = { ...getConfig(), ...config };

  // Load all chunks for this notebook
  const chunks = getChunks(notebookId);
  if (chunks.length === 0) return [];

  // Filter chunks with embeddings
  const indexedChunks = chunks.filter((c) => c.embedding !== null);
  if (indexedChunks.length === 0) return [];

  // Get or generate query embedding
  let queryEmbedding = getCachedQuery(query);
  if (!queryEmbedding) {
    const results = await generateEmbeddings({ texts: [query], taskType: 'RETRIEVAL_QUERY' });
    queryEmbedding = new Float32Array(results[0].embedding);
    cacheQuery(query, queryEmbedding);
  }

  // 维度不匹配保护：当用户切换嵌入模型后，旧 chunk 向量维度可能与新 query 不匹配。
  // 例如从 OpenAI (1536维) 切换到本地 BGE (512维)。
  // 此时跳过不匹配的 chunk，只检索维度一致的。
  const queryDim = queryEmbedding.length;
  const dimCompatibleChunks = indexedChunks.filter(
    (c) => c.embedding !== null && c.embedding.length === queryDim,
  );

  if (dimCompatibleChunks.length === 0) {
    console.warn(
      `[Retriever] No chunks with matching embedding dimension (${queryDim}). ` +
      'Stored embeddings may be from a different model. Please re-index the notebook.',
    );
    return [];
  }

  if (dimCompatibleChunks.length < indexedChunks.length) {
    console.warn(
      `[Retriever] ${indexedChunks.length - dimCompatibleChunks.length} chunks skipped due to dimension mismatch.`,
    );
  }

  // Build source name lookup
  const sources = listSources(notebookId);
  const sourceMap = new Map(sources.map((s) => [s.id, s.name]));

  // Compute similarities
  const scored = dimCompatibleChunks.map((chunk) => ({
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    sourceName: sourceMap.get(chunk.sourceId) || 'Unknown',
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    score: cosineSimilarity(
      Array.from(queryEmbedding),
      Array.from(chunk.embedding!),
    ),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Filter by threshold and take top-K
  const filtered = scored
    .filter((s) => s.score >= cfg.similarityThreshold)
    .slice(0, cfg.topK);

  return filtered;
}

// ========== 带上下文的检索 ==========

export async function retrieveWithContext(
  query: string,
  notebookId: string,
  config?: Partial<NotebookConfig>,
): Promise<{ context: string; sources: RetrievalResult[] }> {
  const results = await retrieve(query, notebookId, config);

  if (results.length === 0) {
    return { context: '', sources: [] };
  }

  // Build context string with source citations
  const contextParts = results.map((r, i) => {
    return `[Source ${i + 1}: ${r.sourceName}]\n${r.content}`;
  });

  const context = contextParts.join('\n\n---\n\n');

  return { context, sources: results };
}

// ========== 清除缓存 ==========

export function clearRetrievalCache(): void {
  queryEmbeddingCache.clear();
}
