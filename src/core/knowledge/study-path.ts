/**
 * 学习路径生成器 — 基于知识图谱的拓扑排序
 *
 * 借鉴思路来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
 * 该项目使用 Guided Tours 功能按依赖顺序自动生成架构走查路径;
 * 我们自研实现: 对知识图谱的边进行拓扑排序, 生成学习顺序
 *
 * 核心算法:
 * 1. 从 graph_nodes 和 graph_edges 加载图谱数据
 * 2. 基于 depends_on / derived_from / precedes 关系构建 DAG
 * 3. 对 DAG 进行拓扑排序 (Kahn's algorithm)
 * 4. 返回有序的学习路径
 */

import { getGraphData } from './storage';
import type { GraphNode, GraphData } from './types';

/** 学习路径项 */
export interface StudyPathItem {
  node: GraphNode;
  order: number;
  reason: string;  // 为什么这个节点在这个位置
  prerequisites: string[];  // 前置知识节点的 label
}

/** 学习路径结果 */
export interface StudyPath {
  items: StudyPathItem[];
  totalNodes: number;
  hasCycles: boolean;  // 图谱中是否有环 (导致部分节点无法排序)
}

/** 具有依赖关系的边类型 */
const DEPENDENCY_RELATIONS = new Set(['depends_on', 'derived_from', 'precedes']);

/**
 * 生成学习路径
 *
 * 算法: Kahn's 拓扑排序
 * 1. 统计每个节点的入度 (有多少前置依赖)
 * 2. 从入度为 0 的节点开始
 * 3. 依次移除已排序节点, 降低后继节点入度
 * 4. 入度变 0 的节点加入排序队列
 */
export function generateStudyPath(notebookId: string): StudyPath {
  const graphData = getGraphData(notebookId);

  if (graphData.nodes.length === 0) {
    return { items: [], totalNodes: 0, hasCycles: false };
  }

  // 只考虑依赖类型的边
  const dependencyEdges = graphData.edges.filter(e =>
    DEPENDENCY_RELATIONS.has(e.relationType),
  );

  // 构建邻接表和入度表
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const prerequisites = new Map<string, Set<string>>();

  for (const node of graphData.nodes) {
    adjacency.set(node.id, []);
    inDegree.set(node.id, 0);
    prerequisites.set(node.id, new Set());
  }

  for (const edge of dependencyEdges) {
    // edge: sourceNodeId depends_on/derived_from/precedes targetNodeId
    // 含义: source 依赖 target, target 应该先学
    // 所以边方向: target → source (target 是 source 的前置)
    const sourceNode = graphData.nodes.find(n => n.id === edge.sourceNodeId);
    const targetNode = graphData.nodes.find(n => n.id === edge.targetNodeId);
    if (!sourceNode || !targetNode) continue;

    adjacency.get(edge.targetNodeId)?.push(edge.sourceNodeId);
    inDegree.set(edge.sourceNodeId, (inDegree.get(edge.sourceNodeId) || 0) + 1);
    prerequisites.get(edge.sourceNodeId)?.add(edge.targetNodeId);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(nodeId);
  }

  // 按权重排序初始队列 (权重高的优先)
  queue.sort((a, b) => {
    const nodeA = graphData.nodes.find(n => n.id === a);
    const nodeB = graphData.nodes.find(n => n.id === b);
    return (nodeB?.weight || 0) - (nodeA?.weight || 0);
  });

  const sorted: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    sorted.push(currentId);

    const neighbors = adjacency.get(currentId) || [];
    for (const neighborId of neighbors) {
      const newDegree = (inDegree.get(neighborId) || 0) - 1;
      inDegree.set(neighborId, newDegree);
      if (newDegree === 0 && !visited.has(neighborId)) {
        queue.push(neighborId);
      }
    }

    // 保持队列按权重排序
    queue.sort((a, b) => {
      const nodeA = graphData.nodes.find(n => n.id === a);
      const nodeB = graphData.nodes.find(n => n.id === b);
      return (nodeB?.weight || 0) - (nodeA?.weight || 0);
    });
  }

  // 处理环中的节点 (未访问的节点)
  const hasCycles = visited.size < graphData.nodes.length;
  const remaining = graphData.nodes.filter(n => !visited.has(n.id));
  // 按权重排序剩余节点
  remaining.sort((a, b) => b.weight - a.weight);
  for (const node of remaining) {
    sorted.push(node.id);
  }

  // 构建结果
  const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));
  const items: StudyPathItem[] = sorted.map((nodeId, index) => {
    const node = nodeMap.get(nodeId);
    if (!node) return null;

    const prereqIds = prerequisites.get(nodeId) || new Set<string>();
    const prereqLabels = Array.from(prereqIds)
      .map(id => nodeMap.get(id)?.label || '')
      .filter(l => l.length > 0);

    let reason = '';
    if (index === 0) {
      reason = '基础概念，无需前置知识';
    } else if (prereqLabels.length > 0) {
      reason = `需要先理解: ${prereqLabels.join(', ')}`;
    } else if (index >= sorted.length - remaining.length) {
      reason = '与其他概念有循环依赖，建议在理解整体框架后学习';
    } else {
      reason = '在已有知识基础上进一步深入';
    }

    return {
      node,
      order: index + 1,
      reason,
      prerequisites: prereqLabels,
    };
  }).filter((item): item is StudyPathItem => item !== null);

  return {
    items,
    totalNodes: graphData.nodes.length,
    hasCycles,
  };
}
