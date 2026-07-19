/**
 * 笔记本式知识管理 — Embedding 索引管道
 *
 * 完整流程：文本提取 → 分块 → 批量 Embedding → SQLite 存储
 * 含进度回调、错误恢复、增量索引。
 */

import { extractText } from './extractor';
import { chunkText } from './chunker';
import { generateEmbeddings, isUsingLocalEmbedding } from '../llm/multimodal';
import {
  addSource,
  updateSource,
  addChunksBulk,
  deleteChunksBySource,
  refreshNotebookCounts,
  updateNotebook,
  getSource,
  listSources,
} from './storage';
import type {
  NotebookSource,
  IndexProgressCallback,
  NotebookConfig,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { getSettingJSON } from '../storage/settings';

/**
 * 检测当前是否使用本地嵌入模式。
 * 包括两种情况：
 * 1. 用户显式选择本地模式
 * 2. 未配置任何 Embedding API，自动回退到本地模式
 * 本地模式下需要更小的批次大小和更频繁的进度回调。
 */
function isLocalMode(): boolean {
  return isUsingLocalEmbedding();
}

// ========== 配置 ==========

const NOTEBOOK_CONFIG_KEY = 'codem-notebook-config';

export function getNotebookConfig(): NotebookConfig {
  return { ...DEFAULT_CONFIG, ...getSettingJSON<Partial<NotebookConfig>>(NOTEBOOK_CONFIG_KEY, {}) };
}

// ========== 索引单个来源 ==========

export async function indexSource(
  source: NotebookSource,
  onProgress?: IndexProgressCallback,
): Promise<void> {
  // Mark as processing
  updateSource(source.id, { status: 'processing', errorMessage: undefined });

  onProgress?.({
    sourceId: source.id,
    sourceName: source.name,
    status: 'processing',
  });

  try {
    // Step 1: Extract text
    const extractResult = await extractText(source);
    if (extractResult.error || !extractResult.text) {
      throw new Error(extractResult.error || 'No text extracted');
    }

    const text = extractResult.text;

    // Step 2: Chunk text
    const config = getNotebookConfig();
    const chunks = chunkText(text, config);

    if (chunks.length === 0) {
      throw new Error('No chunks generated from text');
    }

    // Delete existing chunks for this source (incremental re-index)
    deleteChunksBySource(source.id);

    // Step 3: Generate embeddings in batches
    // 本地模式使用更小的批次：每条文本内部还会进行子分块（≤128 token），
    // 实际推理量 = chunks × sub-chunks，因此需要降低外部批次大小。
    // 风险1缓解：local-embedding.ts 内部自动子分块，这里只需控制并发量。
    const BATCH_SIZE = isLocalMode() ? 10 : 100;
    const allEmbeddings: Float32Array[] = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.content);

      onProgress?.({
        sourceId: source.id,
        sourceName: source.name,
        status: 'processing',
        currentChunk: i,
        totalChunks: chunks.length,
      });

      const results = await generateEmbeddings({ texts, taskType: 'RETRIEVAL_DOCUMENT' });

      for (const result of results) {
        allEmbeddings.push(new Float32Array(result.embedding));
      }
    }

    // Step 4: Store chunks with embeddings
    const chunksWithData = chunks.map((chunk, idx) => ({
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      embedding: allEmbeddings[idx] || null,
      tokenCount: chunk.tokenCount,
    }));

    addChunksBulk(source.notebookId, source.id, chunksWithData);

    // Step 5: Update source status
    updateSource(source.id, {
      status: 'indexed',
      chunkCount: chunks.length,
      errorMessage: undefined,
    });

    onProgress?.({
      sourceId: source.id,
      sourceName: source.name,
      status: 'indexed',
      currentChunk: chunks.length,
      totalChunks: chunks.length,
    });

    // Step 6: Refresh notebook counts
    refreshNotebookCounts(source.notebookId);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Indexer] Failed to index source ${source.id}:`, errMsg);

    updateSource(source.id, {
      status: 'failed',
      errorMessage: errMsg,
    });

    onProgress?.({
      sourceId: source.id,
      sourceName: source.name,
      status: 'failed',
      error: errMsg,
    });
  }
}

// ========== 索引整个笔记本 ==========

export async function indexNotebook(
  notebookId: string,
  onProgress?: IndexProgressCallback,
): Promise<void> {
  const sources = listSources(notebookId);

  for (const source of sources) {
    // Only index pending or failed sources (incremental)
    if (source.status === 'indexed') continue;

    await indexSource(source, onProgress);
  }

  // Generate summary after indexing
  await generateSummary(notebookId);
}

// ========== 生成笔记本摘要 ==========

export async function generateSummary(notebookId: string): Promise<void> {
  const { getNotebook, listSources, getChunks } = await import('./storage');

  const notebook = getNotebook(notebookId);
  if (!notebook) return;

  const sources = listSources(notebookId);
  const indexedSources = sources.filter((s) => s.status === 'indexed');
  if (indexedSources.length === 0) return;

  // Mark as generating
  updateNotebook(notebookId, { summaryStatus: 'generating' });

  try {
    // Gather all chunk contents for summary
    const chunks = getChunks(notebookId);
    const allText = chunks
      .slice(0, 50) // Limit to first 50 chunks to avoid token overflow
      .map((c) => c.content)
      .join('\n\n');

    // Build summary prompt
    const { getSettingJSON } = await import('../storage/settings');
    const settings = getSettingJSON<any>('codem-settings', {});
    const model = settings.model || 'gpt-4o-mini';

    const { createDefaultProviders } = await import('../llm/provider');
    const registry = createDefaultProviders();
    const provider = registry.getConfigured()[0];
    if (!provider) throw new Error('No LLM provider available');

    const summaryPrompt = `Please generate a concise summary (2-3 paragraphs) of the following knowledge base content. The summary should capture the main topics, key information, and potential use cases. Write in ${navigator.language?.startsWith('zh') ? 'Chinese' : 'English'}.\n\n---\n\n${allText.slice(0, 8000)}`;

    const response = await provider.complete({
      model,
      messages: [
        { id: 'summary-sys', role: 'system', content: 'You are a knowledge base summarizer. Generate clear, informative summaries.' },
        { id: 'summary-user', role: 'user', content: summaryPrompt },
      ],
      stream: false,
    });

    const summary = response.content?.trim() || '';

    updateNotebook(notebookId, {
      summary,
      summaryStatus: 'completed',
    });
  } catch (error) {
    console.error('[Indexer] Failed to generate summary:', error);
    updateNotebook(notebookId, { summaryStatus: 'failed' });
  }
}

// ========== 生成建议问题 ==========

export async function generateGuidedQuestions(notebookId: string): Promise<string[]> {
  const { getNotebook, getChunks } = await import('./storage');

  const notebook = getNotebook(notebookId);
  if (!notebook) return [];

  const chunks = getChunks(notebookId);
  if (chunks.length === 0) return [];

  try {
    const sampleText = chunks
      .slice(0, 20)
      .map((c) => c.content)
      .join('\n\n')
      .slice(0, 4000);

    const { getSettingJSON } = await import('../storage/settings');
    const settings = getSettingJSON<any>('codem-settings', {});
    const model = settings.model || 'gpt-4o-mini';

    const { createDefaultProviders } = await import('../llm/provider');
    const registry = createDefaultProviders();
    const provider = registry.getConfigured()[0];
    if (!provider) return [];

    const isZh = navigator.language?.startsWith('zh');
    const prompt = isZh
      ? `基于以下知识库内容，生成5个用户可能会问的问题。每个问题一行，不要编号。问题应该涵盖内容的不同方面，从基础到深入。\n\n---\n\n${sampleText}`
      : `Based on the following knowledge base content, generate 5 questions that users might ask. One question per line, no numbering. Questions should cover different aspects from basic to advanced.\n\n---\n\n${sampleText}`;

    const response = await provider.complete({
      model,
      messages: [
        { id: 'q-sys', role: 'system', content: 'You are a question generator. Generate relevant, diverse questions.' },
        { id: 'q-user', role: 'user', content: prompt },
      ],
      stream: false,
    });

    const text = response.content?.trim() || '';
    const questions = text
      .split('\n')
      .map((q: string) => q.trim())
      .filter((q: string) => q.length > 5 && !q.match(/^\d+\./))
      .slice(0, 5);

    return questions;
  } catch (error) {
    console.error('[Indexer] Failed to generate guided questions:', error);
    return [];
  }
}

// ========== 重新索引来源 ==========

export async function reindexSource(sourceId: string, onProgress?: IndexProgressCallback): Promise<void> {
  const source = getSource(sourceId);
  if (!source) return;

  // Reset to pending and re-index
  updateSource(sourceId, { status: 'pending', chunkCount: 0, errorMessage: undefined });
  await indexSource(source, onProgress);
}

// ========== 删除来源并清理 ==========

export async function deleteSourceAndCleanup(sourceId: string, notebookId: string): Promise<void> {
  deleteChunksBySource(sourceId);

  const { deleteSource } = await import('./storage');
  deleteSource(sourceId);

  refreshNotebookCounts(notebookId);
}
