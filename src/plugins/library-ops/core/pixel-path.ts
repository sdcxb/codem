/**
 * 像素场景寻路 —— 基于 ClawLibrary 的 walkGraph（20 节点 / 19 边）做 BFS 路由。
 *
 * 采用「图上最短路 + 末端直连」策略：
 * 1. 起点/终点各自吸附到最近的路网节点；
 * 2. 在路网图上 BFS 求最短节点序列；
 * 3. 首尾补上真实起点/终点，形成完整折线。
 *
 * 这样既复用了上游手工标注的可行走主干（贴合美术里的走廊），
 * 又是纯函数、可在 node/happy-dom 下单测（不依赖 canvas 采样掩码）。
 *
 * 路网可以被用户在对位模式里拖动（见 `data/layout-override.ts`），
 * 因此节点索引与邻接表按覆盖层版本号缓存，拖动后自动失效重建。
 */

import type { ScreenPoint } from "../types";
import { walkEdges, walkNodes, type WalkNode } from "../data/pixel-art";
import { layoutVersion } from "../data/layout-override";

/** 路网缓存（按覆盖层版本号失效） */
interface GraphCache {
  version: number;
  nodes: WalkNode[];
  byId: Map<string, WalkNode>;
  adjacency: Map<string, string[]>;
}

let cache: GraphCache | null = null;

function graph(): GraphCache {
  const version = layoutVersion();
  if (cache && cache.version === version) return cache;
  const nodes = walkNodes();
  const byId = new Map<string, WalkNode>(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const [a, b] of walkEdges()) {
    if (!adjacency.has(a) || !adjacency.has(b)) continue;
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  }
  cache = { version, nodes, byId, adjacency };
  return cache;
}

/** 当前生效的路网节点（已应用对位覆盖） */
export function currentWalkNodes(): WalkNode[] {
  return graph().nodes;
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 最近的路网节点 */
export function nearestNode(point: { x: number; y: number }): WalkNode {
  const { nodes } = graph();
  let best = nodes[0];
  let bestD = dist2(best, point);
  for (let i = 1; i < nodes.length; i++) {
    const d = dist2(nodes[i], point);
    if (d < bestD) {
      best = nodes[i];
      bestD = d;
    }
  }
  return best;
}

/**
 * 图最短路（BFS）。返回节点序列（含起点与终点节点）；不可达时返回 [start]。
 */
export function routeOnGraph(fromId: string, toId: string): WalkNode[] {
  const { byId, adjacency } = graph();
  const start = byId.get(fromId);
  const goal = byId.get(toId);
  if (!start || !goal) return start ? [start] : [];
  if (start.id === goal.id) return [start];

  const queue: string[] = [start.id];
  const visited = new Set<string>([start.id]);
  const parent = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === goal.id) break;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      queue.push(next);
    }
  }
  if (!visited.has(goal.id)) return [start];

  const ids: string[] = [];
  let cursor: string | undefined = goal.id;
  while (cursor) {
    ids.push(cursor);
    cursor = parent.get(cursor);
  }
  ids.reverse();
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * 计算从 from 到 to 的完整折线（逻辑坐标，1920×1080）。
 * 返回**不含起点**的路径点序列。
 */
export function computePixelRoute(from: ScreenPoint, to: ScreenPoint): ScreenPoint[] {
  const startNode = nearestNode(from);
  const endNode = nearestNode(to);
  const nodes = routeOnGraph(startNode.id, endNode.id);
  const path: ScreenPoint[] = [];

  // 起点 → 第一个节点（若起点不在节点上）
  if (dist2(from, startNode) > 1) path.push({ x: startNode.x, y: startNode.y });
  for (let i = 1; i < nodes.length; i++) path.push({ x: nodes[i].x, y: nodes[i].y });
  // 最后一个节点 → 终点
  if (nodes.length === 0 || dist2(to, nodes[nodes.length - 1]) > 1) path.push({ x: to.x, y: to.y });
  return path;
}

/** 路径总长度（像素） */
export function pathLength(path: ScreenPoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return total;
}

/** 房间内第 n 个工位点（在 work 锚点周围按环形排布，避免叠人） */
export function roomSlot(
  work: { x: number; y: number; radius: number },
  index: number,
): { x: number; y: number } {
  if (index <= 0) return { x: work.x, y: work.y };
  const ring = Math.max(1, Math.ceil(Math.sqrt(index + 1)));
  const angle = (index * 2.399963) % (Math.PI * 2); // 黄金角，分布均匀
  const r = Math.min(work.radius * 1.6, 18 + ring * 16);
  return { x: work.x + Math.cos(angle) * r, y: work.y + Math.sin(angle) * r * 0.7 };
}

/** 路网健康检查（测试用）：所有节点连通 */
export function isGraphConnected(): boolean {
  const { nodes, adjacency } = graph();
  if (nodes.length === 0) return false;
  const seen = new Set<string>([nodes[0].id]);
  const queue = [nodes[0].id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adjacency.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen.size === nodes.length;
}
