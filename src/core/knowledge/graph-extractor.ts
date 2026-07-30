/**
 * 知识图谱实体提取管道
 *
 * 借鉴思路来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
 * 该项目使用多 Agent 管道 (file-analyzer, architecture-analyzer, graph-reviewer) 提取实体关系;
 * 我们自研实现: 使用现有 LLM provider 从笔记本 chunks 中提取实体和关系, 存入 SQLite
 *
 * 核心差异:
 * - 不使用 Agent 管道, 而是单次 LLM 调用批量提取
 * - 不依赖 tree-sitter 解析代码结构, 而是面向通用知识库内容
 * - 实体去重和关系合并在前端完成, 不依赖外部图数据库
 */

import { getChunks, listSources, findOrCreateNode, addGraphEdge, deleteGraphData, getGraphData, updateNodeCommunity } from './storage';
import type { EntityType, RelationType, GraphData } from './types';
import { extractJSON } from '../llm/output-parser';

/** LLM 提取的实体 (JSON 格式) */
interface LLMEntity {
  label: string;
  type: string;
  description?: string;
}

/** LLM 提取的关系 (JSON 格式) */
interface LLMRelation {
  source: string;
  target: string;
  relation: string;
}

/** LLM 返回的提取结果 */
interface LLMExtractionResult {
  entities: LLMEntity[];
  relations: LLMRelation[];
}

/** 将字符串映射为 EntityType 枚举 */
function parseEntityType(typeStr: string): EntityType {
  const lower = typeStr.toLowerCase().trim();
  if (lower.includes('person') || lower.includes('人')) return 'person';
  if (lower.includes('place') || lower.includes('地点') || lower.includes('location')) return 'place';
  if (lower.includes('org') || lower.includes('组织') || lower.includes('company')) return 'organization';
  if (lower.includes('tech') || lower.includes('技术') || lower.includes('tool')) return 'technology';
  if (lower.includes('event') || lower.includes('事件')) return 'event';
  if (lower.includes('concept') || lower.includes('概念')) return 'concept';
  return 'entity';
}

/** 将字符串映射为 RelationType 枚举 */
function parseRelationType(relStr: string): RelationType {
  const lower = relStr.toLowerCase().trim();
  if (lower.includes('part') || lower.includes('属于') || lower.includes('包含')) return 'part_of';
  if (lower.includes('depend') || lower.includes('依赖')) return 'depends_on';
  if (lower.includes('deriv') || lower.includes('派生') || lower.includes('源于')) return 'derived_from';
  if (lower.includes('contradict') || lower.includes('矛盾') || lower.includes('反对')) return 'contradicts';
  if (lower.includes('support') || lower.includes('支持')) return 'supports';
  if (lower.includes('precede') || lower.includes('先于') || lower.includes('导致')) return 'precedes';
  return 'related';
}

/**
 * 从笔记本内容中提取知识图谱
 *
 * 借鉴 Understand-Anything 的知识库分析思路:
 * 1. 收集 chunks 内容
 * 2. LLM 提取实体和关系
 * 3. 去重并存储到 SQLite
 *
 * 我们的自研改进:
 * - 批量处理 chunks 减少 LLM 调用次数
 * - 前端去重 (findOrCreateNode 按 label 匹配)
 * - 简单社区发现算法 (基于连通分量)
 */
export async function extractKnowledgeGraph(notebookId: string): Promise<GraphData> {
  const chunks = getChunks(notebookId);
  if (chunks.length === 0) {
    return { nodes: [], edges: [] };
  }

  const sources = listSources(notebookId);

  // Clear existing graph data
  deleteGraphData(notebookId);

  // Process chunks in batches to avoid token overflow
  const BATCH_SIZE = 10;
  const MAX_BATCHES = 6; // Limit to 60 chunks max

  for (let batchIdx = 0; batchIdx < Math.min(Math.ceil(chunks.length / BATCH_SIZE), MAX_BATCHES); batchIdx++) {
    const batchChunks = chunks.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
    const batchText = batchChunks
      .map((c, i) => `[Chunk ${batchIdx * BATCH_SIZE + i + 1}]\n${c.content.slice(0, 800)}`)
      .join('\n\n');

    try {
      const extraction = await callLLMForExtraction(batchText, sources.length > 0);

      // Process entities
      for (const entity of extraction.entities) {
        const chunk = batchChunks[0]; // Associate with first chunk of batch
        const sourceId = chunk?.sourceId;
        findOrCreateNode(
          notebookId,
          entity.label,
          parseEntityType(entity.type),
          entity.description,
          sourceId,
          chunk?.id,
        );
      }

      // Process relations
      for (const rel of extraction.relations) {
        const sourceNode = findNodeByLabel(notebookId, rel.source);
        const targetNode = findNodeByLabel(notebookId, rel.target);
        if (sourceNode && targetNode) {
          addGraphEdge(notebookId, sourceNode, targetNode, parseRelationType(rel.relation));
        }
      }
    } catch (error) {
      console.error(`[GraphExtractor] Batch ${batchIdx} failed:`, error);
    }
  }

  // Run community detection
  const graphData = getGraphData(notebookId);
  assignCommunities(graphData);

  // Re-fetch with community IDs
  return getGraphData(notebookId);
}

/** 查找节点 ID by label (内部辅助) */
function findNodeByLabel(notebookId: string, label: string): string | null {
  const data = getGraphData(notebookId);
  const node = data.nodes.find(n => n.label.toLowerCase() === label.toLowerCase());
  return node?.id ?? null;
}

/**
 * 调用 LLM 提取实体和关系
 *
 * 自研 Prompt 设计, 不照搬 Understand-Anything 的 Agent prompt
 */
async function callLLMForExtraction(text: string, _hasSources: boolean): Promise<LLMExtractionResult> {
  // 使用场景模板解析模型（subagent slot）
  const { resolveModelForTask } = await import('../llm/model-resolver');
  const resolved = await resolveModelForTask('subagent');
  if (!resolved) throw new Error('No LLM provider available');
  const provider = resolved.provider;
  const model = resolved.model;

  const isZh = navigator.language?.startsWith('zh');
  const systemPrompt = isZh
    ? '你是一个知识图谱提取助手。从给定的文本中提取关键实体和它们之间的关系。只返回 JSON 格式，不要其他内容。'
    : 'You are a knowledge graph extraction assistant. Extract key entities and their relationships from the given text. Return only JSON format, no other content.';

  const userPrompt = isZh
    ? `从以下文本中提取知识图谱的实体和关系。

要求：
1. 提取 5-15 个关键实体（概念、技术、人物、组织、事件等）
2. 提取实体之间的关系（最多 20 条）
3. 每个实体必须有 label 和 type 字段
4. type 可选值: concept, entity, event, person, place, organization, technology

返回严格 JSON 格式:
{"entities":[{"label":"实体名","type":"类型","description":"简短描述"}],"relations":[{"source":"实体A","target":"实体B","relation":"关系描述"}]}

文本内容:
${text.slice(0, 6000)}`
    : `Extract knowledge graph entities and relationships from the following text.

Requirements:
1. Extract 5-15 key entities (concepts, technologies, people, organizations, events, etc.)
2. Extract relationships between entities (max 20)
3. Each entity must have label and type fields
4. type options: concept, entity, event, person, place, organization, technology

Return strict JSON format:
{"entities":[{"label":"Entity Name","type":"type","description":"brief description"}],"relations":[{"source":"Entity A","target":"Entity B","relation":"relationship description"}]}

Text content:
${text.slice(0, 6000)}`;

  const response = await provider.complete({
    model,
    messages: [
      { id: 'graph-sys', role: 'system', content: systemPrompt },
      { id: 'graph-user', role: 'user', content: userPrompt },
    ],
    stream: false,
  });

  const content = response.content?.trim() || '';

  // 健壮的 JSON 解析 — 不依赖模型输出格式
  const result = extractJSON<LLMExtractionResult>(content);
  if (result) {
    return {
      entities: Array.isArray(result.entities) ? result.entities : [],
      relations: Array.isArray(result.relations) ? result.relations : [],
    };
  }

  console.error('[GraphExtractor] Failed to parse LLM response:', content.slice(0, 200));
  return { entities: [], relations: [] };
}

/**
 * 简单社区发现算法 — 基于连通分量
 *
 * 借鉴 Understand-Anything 的社区聚类思路,
 * 但使用自研的简化连通分量算法而非复杂的社区发现算法
 */
function assignCommunities(graphData: GraphData): void {
  if (graphData.nodes.length === 0) return;

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const node of graphData.nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of graphData.edges) {
    adjacency.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adjacency.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  // BFS to find connected components
  const visited = new Set<string>();
  let communityId = 0;

  for (const node of graphData.nodes) {
    if (visited.has(node.id)) continue;

    const component: string[] = [];
    const queue = [node.id];
    visited.add(node.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    // Assign community ID to all nodes in this component
    for (const nodeId of component) {
      updateNodeCommunity(nodeId, communityId);
    }
    communityId++;
  }
}
