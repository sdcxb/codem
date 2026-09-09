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
 */

import type { ScreenPoint } from "../types";
import { WALK_EDGES, WALK_NODES, type WalkNode } from "../data/pixel-art";

/** 路网节点索引（模块级缓存） */
const NODE_BY_ID = new Map<string, WalkNode>(WALK_NODES.map((n) => [n.id, n]));

/** 邻接表（无向图） */
const ADJACENCY: Map<string, string[]> = (() => {
  const adj = new Map<string, string[]>();
  for (const n of WALK_NODES) adj.set(n.id, []);
  for (const [a, b] of WALK_EDGES) {
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  return adj;
})();

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 最近的路网节点 */
export function nearestNode(point: { x: number; y: number }): WalkNode {
  let best = WALK_NODES[0];
  let bestD = dist2(best, point);
  for (let i = 1; i < WALK_NODES.length; i++) {
    const d = dist2(WALK_NODES[i], point);
    if (d < bestD) {
      best = WALK_NODES[i];
      bestD = d;
    }
  }
  return best;
}

/**
 * 图最短路（BFS）。返回节点序列（含起点与终点节点）；不可达时返回 [start]。
 */
export function routeOnGraph(fromId: string, toId: string): WalkNode[] {
  const start = NODE_BY_ID.get(fromId);
  const goal = NODE_BY_ID.get(toId);
  if (!start || !goal) return start ? [start] : [];
  if (start.id === goal.id) return [start];

  const queue: string[] = [start.id];
  const visited = new Set<string>([start.id]);
  const parent = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === goal.id) break;
    for (const next of ADJACENCY.get(current) ?? []) {
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
  return ids.map((id) => NODE_BY_ID.get(id)!).filter(Boolean);
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
  if (WALK_NODES.length === 0) return false;
  const seen = new Set<string>([WALK_NODES[0].id]);
  const queue = [WALK_NODES[0].id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of ADJACENCY.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen.size === WALK_NODES.length;
}
