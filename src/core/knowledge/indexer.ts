/**
 * 笔记本式知识管理 — Embedding 索引管道
 *
 * 对标 NotebookLM：索引流程 (提取→分块→Embedding→存储)
 * Studio 内容生成功能借鉴 NotebookLM 的 Studio 菜单设计
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
import { extractJSON, extractList, extractMermaid } from '../llm/output-parser';

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

    // Step 5.5: Generate per-source summary (对标 NotebookLM 来源摘要卡片)
    generateSourceSummary(source.id, chunks).catch((e) => {
      console.warn(`[Indexer] Failed to generate source summary for ${source.id}:`, e);
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

    // 统一走 LLMEngine.getConfiguredProvider
    const { getLLMEngine } = await import('../llm/index');
    const engine = getLLMEngine();
    const { provider, model } = engine.getConfiguredProvider('memory');

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

const { getLLMEngine } = await import('../llm/index');
const engine = getLLMEngine();
const { provider, model } = engine.getConfiguredProvider('subagent');

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
    const questions = extractList(text).slice(0, 5);

    return questions;
  } catch (error) {
    console.error('[Indexer] Failed to generate guided questions:', error);
    return [];
  }
}

// ========== 来源摘要生成 (对标 NotebookLM 来源摘要卡片) ==========
// 每个来源索引后自动生成独立摘要和关键话题

export async function generateSourceSummary(
  sourceId: string,
  chunks?: { content: string }[],
): Promise<void> {
  const { getSource, updateSource, getChunks } = await import('./storage');

  const source = getSource(sourceId);
  if (!source) return;

  // Use provided chunks or load from storage
  const sourceChunks = chunks ?? getChunks(source.notebookId).filter(c => c.sourceId === sourceId);
  if (sourceChunks.length === 0) return;

try {
const { getLLMEngine } = await import('../llm/index');
const engine = getLLMEngine();
const resolved = engine.resolveSlot('subagent');
const provider = engine.providers.get(resolved.providerId);
if (!provider || !provider.isConfigured()) return;
const model = resolved.modelId;

    const isZh = navigator.language?.startsWith('zh');
    const sampleText = sourceChunks
      .slice(0, 15)
      .map(c => c.content)
      .join('\n\n')
      .slice(0, 4000);

    const prompt = isZh
      ? `请分析以下来源内容，生成：\n1. 一段简短摘要（100-200字，概括主要内容）\n2. 5-8个关键话题标签\n\n返回严格 JSON 格式：\n{"summary":"摘要内容","keyTopics":["话题1","话题2","话题3"]}\n\n来源内容：\n${sampleText}`
      : `Analyze the following source content and generate:\n1. A brief summary (100-200 words, summarizing the main content)\n2. 5-8 key topic tags\n\nReturn strict JSON format:\n{"summary":"summary text","keyTopics":["topic1","topic2","topic3"]}\n\nSource content:\n${sampleText}`;

    const response = await provider.complete({
      model,
      messages: [
        { id: 'src-sum-sys', role: 'system', content: 'You are a content summarizer. Return only valid JSON.' },
        { id: 'src-sum-user', role: 'user', content: prompt },
      ],
      stream: false,
    });

    const content = response.content?.trim() || '';
    const result = extractJSON<{ summary?: string; keyTopics?: string[] }>(content);
    if (result) {
      updateSource(sourceId, {
        summary: result.summary || undefined,
        keyTopics: Array.isArray(result.keyTopics) ? result.keyTopics : undefined,
      });
    } else {
      // 模型未返回严格 JSON（常见：直接回文本/带解释/截断）——降级为文本摘要：
      // 去掉 markdown 代码块与"以下是摘要"引导词后取前 200 字，保证笔记本卡片
      // 有内容可读；不再仅 warn 后留空。
      console.warn('[Indexer] Source summary not JSON, falling back to text preview:', content.slice(0, 120));
      const plain = content
        .replace(/```[\s\S]*?```/g, '')
        .replace(/^(以下是|以下为|下面|Here is|Below|The (following )?summary)/i, '')
        .replace(/^[#>*\-\s]+/, '')
        .trim();
      if (plain.length > 0) {
        updateSource(sourceId, {
          summary: plain.slice(0, 200),
          keyTopics: undefined,
        });
      }
    }
  } catch (error) {
    console.warn(`[Indexer] Source summary generation failed for ${sourceId}:`, error);
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

// ========== Studio 内容生成 ==========
// 借鉴 NotebookLM 的 Studio 菜单设计: 摘要/大纲/学习指南/FAQ/时间线/简报/洞察
// 我们自研实现: 使用现有 LLM provider 生成 Markdown 内容, 不照搬 NotebookLM 代码

export type StudioContentType =
  | 'summary'
  | 'outline'
  | 'study_guide'
  | 'faq'
  | 'timeline'
  | 'brief'
  | 'key_insights'
  | 'mindmap'; // 思维导图 (对标 NotebookLM Mind Map)

export interface StudioContentResult {
  title: string;
  content: string;
}

const STUDIO_PROMPTS: Record<StudioContentType, { zh: string; en: string; titleZh: string; titleEn: string }> = {
  summary: {
    zh: '请对以下知识库内容生成一份详细的摘要报告。包括主要主题、关键信息、核心观点和潜在应用场景。使用 Markdown 格式输出。',
    en: 'Generate a detailed summary report of the following knowledge base content. Include main topics, key information, core viewpoints, and potential use cases. Output in Markdown format.',
    titleZh: '内容摘要',
    titleEn: 'Content Summary',
  },
  outline: {
    zh: '请基于以下知识库内容生成一份结构化大纲。按主题和子主题层次组织，使用 Markdown 标题格式。大纲应该逻辑清晰、层次分明。',
    en: 'Generate a structured outline based on the following knowledge base content. Organize by topics and subtopics using Markdown heading format. The outline should be logical and well-structured.',
    titleZh: '内容大纲',
    titleEn: 'Content Outline',
  },
  study_guide: {
    zh: '请基于以下知识库内容创建一份学习指南。包括：1) 核心概念列表及解释 2) 重要知识点 3) 常见误区 4) 练习问题（含答案）。使用 Markdown 格式。',
    en: 'Create a study guide based on the following knowledge base content. Include: 1) Core concepts list with explanations 2) Key knowledge points 3) Common misconceptions 4) Practice questions with answers. Use Markdown format.',
    titleZh: '学习指南',
    titleEn: 'Study Guide',
  },
  faq: {
    zh: '请基于以下知识库内容生成一份常见问题解答（FAQ）。列出 8-10 个重要问题并给出详细回答。使用 Markdown 格式，问题用 ### 标题。',
    en: 'Generate a FAQ (Frequently Asked Questions) based on the following knowledge base content. List 8-10 important questions with detailed answers. Use Markdown format, questions as ### headings.',
    titleZh: '常见问题解答',
    titleEn: 'FAQ',
  },
  timeline: {
    zh: '请基于以下知识库内容提取所有时间相关的事件，按时间顺序排列生成一份时间线。每个事件包括日期、事件名称和简短描述。使用 Markdown 格式。',
    en: 'Extract all time-related events from the following knowledge base content and generate a timeline in chronological order. Each event should include date, event name, and brief description. Use Markdown format.',
    titleZh: '事件时间线',
    titleEn: 'Event Timeline',
  },
  brief: {
    zh: '请基于以下知识库内容生成一份简要简报（一页纸）。包括：背景概述、关键发现、结论建议。语言精练，总字数控制在 500 字以内。使用 Markdown 格式。',
    en: 'Generate a one-page brief based on the following knowledge base content. Include: background overview, key findings, conclusions and recommendations. Keep it concise, under 500 words. Use Markdown format.',
    titleZh: '简要简报',
    titleEn: 'Brief',
  },
  key_insights: {
    zh: '请分析以下知识库内容，提取 5-8 条关键洞察。每条洞察包括：洞察标题、详细解释、支持证据。使用 Markdown 格式。',
    en: 'Analyze the following knowledge base content and extract 5-8 key insights. Each insight should include: insight title, detailed explanation, supporting evidence. Use Markdown format.',
    titleZh: '关键洞察',
    titleEn: 'Key Insights',
  },
  mindmap: {
    zh: '请基于以下知识库内容生成一份思维导图。使用 Mermaid mindmap 语法。从核心主题出发，逐层展开子主题和细节。返回纯 Mermaid 代码，不要其他内容。\n\n格式示例:\n```mermaid\nmindmap\n  root((核心主题))\n    子主题1\n      细节1\n      细节2\n    子主题2\n      细节3\n```\n\n知识库内容:\n',
    en: 'Generate a mind map based on the following knowledge base content. Use Mermaid mindmap syntax. Start from the core topic and expand subtopics and details layer by layer. Return only Mermaid code, no other content.\n\nFormat example:\n```mermaid\nmindmap\n  root((Core Topic))\n    Subtopic1\n      Detail1\n      Detail2\n    Subtopic2\n      Detail3\n```\n\nKnowledge base content:\n',
    titleZh: '思维导图',
    titleEn: 'Mind Map',
  },
};

export async function generateStudioContent(
  notebookId: string,
  contentType: StudioContentType,
): Promise<StudioContentResult> {
  const { getNotebook, getChunks } = await import('./storage');

  const notebook = getNotebook(notebookId);
  if (!notebook) throw new Error('Notebook not found');

  const chunks = getChunks(notebookId);
  if (chunks.length === 0) throw new Error('No indexed content available');

  const isZh = navigator.language?.startsWith('zh');
  const promptConfig = STUDIO_PROMPTS[contentType];

  // Gather text content (limit to avoid token overflow)
  const allText = chunks
    .slice(0, 60)
    .map((c) => c.content)
    .join('\n\n')
    .slice(0, 12000);

  const { getLLMEngine } = await import('../llm/index');
  const engine = getLLMEngine();
  const { provider, model } = engine.getConfiguredProvider('chat');

  const prompt = isZh ? promptConfig.zh : promptConfig.en;
  const fullPrompt = `${prompt}\n\n---\n\n${allText}`;

  const response = await provider.complete({
    model,
    messages: [
      {
        id: 'studio-sys',
        role: 'system',
        content: isZh
          ? '你是一个知识库内容生成助手。根据用户要求生成高质量、结构化的 Markdown 内容。'
          : 'You are a knowledge base content generation assistant. Generate high-quality, structured Markdown content based on user requests.',
      },
      { id: 'studio-user', role: 'user', content: fullPrompt },
    ],
    stream: false,
  });

  let content = response.content?.trim() || '';
  const title = isZh ? promptConfig.titleZh : promptConfig.titleEn;

  // 思维导图: 健壮化后处理 — 不依赖模型"只返回 Mermaid 代码"
  if (contentType === 'mindmap') {
    const mermaidCode = extractMermaid(content);
    if (mermaidCode) {
      content = mermaidCode;
    }
  }

  return { title, content };
}

// ========== 闪卡生成 (借鉴 Lumina Note, 自研实现) ==========
// 不复用 FAQ prompt + 正则解析的脆弱方案，而是用专用 prompt + extractJSON 健壮解析

export interface GeneratedFlashcard {
  front: string;
  back: string;
}

/**
 * AI 生成闪卡 — 结构化 JSON 输出，不依赖文本格式解析
 *
 * 核心改进:
 * 1. 专用 prompt 要求返回 JSON 数组格式
 * 2. 使用 extractJSON 健壮解析，处理 markdown 包裹、中文标点等
 * 3. 如果 JSON 解析失败，回退到 extractList + 启发式分割
 */
export async function generateFlashcards(
  notebookId: string,
  count: number = 10,
  noteId?: string,
): Promise<GeneratedFlashcard[]> {
  const { getNotebook, getChunks, getNote } = await import('./storage');

  const notebook = getNotebook(notebookId);
  if (!notebook) throw new Error('Notebook not found');

  const isZh = navigator.language?.startsWith('zh');

  // C5: 如果提供了 noteId，优先使用笔记内容生成闪卡
  let allText: string;
  if (noteId) {
    const note = getNote(noteId);
    if (!note) throw new Error('Note not found');
    if (!note.content || note.content.trim().length === 0) throw new Error(isZh ? '笔记内容为空' : 'Note content is empty');
    allText = note.content.slice(0, 8000);
  } else {
    const chunks = getChunks(notebookId);
    if (chunks.length === 0) throw new Error('No indexed content available');
    allText = chunks
      .slice(0, 40)
      .map((c) => c.content)
      .join('\n\n')
      .slice(0, 8000);
  }

  const { getLLMEngine } = await import('../llm/index');
  const engine = getLLMEngine();
  const { provider, model } = engine.getConfiguredProvider('chat');

  const systemPrompt = isZh
    ? '你是一个闪卡生成助手。根据知识库内容生成适合间隔重复学习的问题-答案对。'
    : 'You are a flashcard generator. Create question-answer pairs suitable for spaced repetition learning.';

  const userPrompt = isZh
    ? `基于以下知识库内容，生成 ${count} 张闪卡。

要求：
1. 每张闪卡有一个明确的问题（front）和简洁的答案（back）
2. 答案不超过 200 字
3. 涵盖内容的不同方面和难度层次
4. 问题应该具体、可验证，避免过于宽泛

返回 JSON 数组格式：
[{"front":"问题1","back":"答案1"},{"front":"问题2","back":"答案2"}]

知识库内容：
${allText}`
    : `Based on the following knowledge base content, generate ${count} flashcards.

Requirements:
1. Each flashcard has a clear question (front) and concise answer (back)
2. Answer should be under 200 words
3. Cover different aspects and difficulty levels
4. Questions should be specific and verifiable

Return JSON array format:
[{"front":"Question 1","back":"Answer 1"},{"front":"Question 2","back":"Answer 2"}]

Knowledge base content:
${allText}`;

  const response = await provider.complete({
    model,
    messages: [
      { id: 'flashcard-sys', role: 'system', content: systemPrompt },
      { id: 'flashcard-user', role: 'user', content: userPrompt },
    ],
    stream: false,
  });

  const content = response.content?.trim() || '';

  // 健壮的 JSON 解析
  const cards = extractJSON<GeneratedFlashcard[]>(content);
  if (Array.isArray(cards) && cards.length > 0) {
    return cards
      .filter(c => c && typeof c.front === 'string' && typeof c.back === 'string')
      .filter(c => c.front.trim().length > 0 && c.back.trim().length > 0)
      .slice(0, count);
  }

  // 回退: 尝试从文本中启发式提取 Q&A
  console.warn('[Indexer] Flashcard JSON parsing failed, falling back to heuristic parsing');
  const lines = content.split('\n');
  const fallback: GeneratedFlashcard[] = [];
  let currentQ = '';
  let currentA = '';

  for (const line of lines) {
    const qMatch = line.match(/^\s*(?:\d+[\.\)]|Q[:\)]|[-*]|#{1,3}\s+)\s*(.+)/i);
    const aMatch = line.match(/^\s*(?:A[:\)]|→|答[:：]|>\s+)\s*(.+)/i);
    if (qMatch) {
      if (currentQ && currentA) fallback.push({ front: currentQ, back: currentA });
      currentQ = qMatch[1].trim();
      currentA = '';
    } else if (aMatch) {
      currentA = aMatch[1].trim();
    } else if (currentQ && line.trim() && !line.startsWith('#') && !line.startsWith('```')) {
      currentA += (currentA ? ' ' : '') + line.trim();
    }
  }
  if (currentQ && currentA) fallback.push({ front: currentQ, back: currentA });

  return fallback.slice(0, count);
}
