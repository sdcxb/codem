/**
 * 场景对位覆盖层（Layout Override）—— 让「内置布局」可以被用户拖动后覆盖。
 *
 * 背景：角色站位、房间框、标签锚点、行走路网都来自内置数据（ClawLibrary 的
 * `map.logic.json`）。用户上传的 AI 场景图里房间位置往往和这套数据对不上，
 * 于是提供「对位模式」：直接在场景上把房间框和路网节点拖到图里的对应位置。
 *
 * 设计要点：
 * - 覆盖层按**场景图片 id** 分开存（`claw` / `ai-library-01` / `custom`），
 *   换图不会互相污染；
 * - 模块级保存一份「当前生效」的覆盖层（`setLayoutOverride`），
 *   引擎（纯函数）通过 `pixel-art.ts` / `pixel-path.ts` 的访问器读取，
 *   因此**不需要改任何引擎签名**；
 * - `version()` 递增用于让路网缓存失效（`pixel-path.ts` 的 BFS 邻接表）。
 *
 * 这里只做数据 + 纯函数，持久化与 UI 在 store / 组件里。
 */

import type { PixelRoom, WalkNode } from "./pixel-art";

/** 单个房间的覆盖项（缺省字段沿用内置值） */
export interface RoomOverride {
  bounds?: [number, number, number, number];
  labelAnchor?: { x: number; y: number };
  work?: { x: number; y: number; radius: number };
}

/** 一个场景图片对应的覆盖层 */
export interface LayoutOverride {
  /** 房间 id → 覆盖项 */
  rooms: Record<string, RoomOverride>;
  /** 路网节点 id → 坐标 */
  nodes: Record<string, { x: number; y: number }>;
  /** 最后修改时间 */
  updatedAt: number;
}

export const EMPTY_LAYOUT: LayoutOverride = { rooms: {}, nodes: {}, updatedAt: 0 };

/** 坐标合法区间（防御非法持久化值 / 拖拽越界） */
export const LAYOUT_LIMITS = {
  x: { min: -400, max: 2400 },
  y: { min: -400, max: 1400 },
  /** 房间最小边长 */
  minSize: 60,
  /** 房间最大边长 */
  maxSize: 1600,
} as const;

export function isLayoutEmpty(override: LayoutOverride | null | undefined): boolean {
  if (!override) return true;
  return Object.keys(override.rooms).length === 0 && Object.keys(override.nodes).length === 0;
}

export function layoutCount(override: LayoutOverride | null | undefined): { rooms: number; nodes: number } {
  return {
    rooms: override ? Object.keys(override.rooms).length : 0,
    nodes: override ? Object.keys(override.nodes).length : 0,
  };
}

function clampNum(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/** 收敛房间覆盖项（非法值直接丢弃该字段） */
export function normalizeRoomOverride(input: RoomOverride | null | undefined): RoomOverride {
  const out: RoomOverride = {};
  if (!input) return out;
  const b = input.bounds;
  if (Array.isArray(b) && b.length === 4) {
    const x = clampNum(b[0], LAYOUT_LIMITS.x.min, LAYOUT_LIMITS.x.max);
    const y = clampNum(b[1], LAYOUT_LIMITS.y.min, LAYOUT_LIMITS.y.max);
    const w = clampNum(b[2], LAYOUT_LIMITS.minSize, LAYOUT_LIMITS.maxSize);
    const h = clampNum(b[3], LAYOUT_LIMITS.minSize, LAYOUT_LIMITS.maxSize);
    if (x !== null && y !== null && w !== null && h !== null) out.bounds = [round(x), round(y), round(w), round(h)];
  }
  if (input.labelAnchor) {
    const x = clampNum(input.labelAnchor.x, LAYOUT_LIMITS.x.min, LAYOUT_LIMITS.x.max);
    const y = clampNum(input.labelAnchor.y, LAYOUT_LIMITS.y.min, LAYOUT_LIMITS.y.max);
    if (x !== null && y !== null) out.labelAnchor = { x: round(x), y: round(y) };
  }
  if (input.work) {
    const x = clampNum(input.work.x, LAYOUT_LIMITS.x.min, LAYOUT_LIMITS.x.max);
    const y = clampNum(input.work.y, LAYOUT_LIMITS.y.min, LAYOUT_LIMITS.y.max);
    const radius = clampNum(input.work.radius, 8, 200);
    if (x !== null && y !== null && radius !== null) out.work = { x: round(x), y: round(y), radius: round(radius) };
  }
  return out;
}

/** 收敛整层覆盖（读取持久化数据时用） */
export function normalizeLayoutOverride(input: unknown): LayoutOverride {
  const raw = (input ?? {}) as Partial<LayoutOverride>;
  const rooms: Record<string, RoomOverride> = {};
  if (raw.rooms && typeof raw.rooms === "object") {
    for (const [id, value] of Object.entries(raw.rooms)) {
      const normalized = normalizeRoomOverride(value as RoomOverride);
      if (Object.keys(normalized).length > 0) rooms[id] = normalized;
    }
  }
  const nodes: Record<string, { x: number; y: number }> = {};
  if (raw.nodes && typeof raw.nodes === "object") {
    for (const [id, value] of Object.entries(raw.nodes)) {
      const v = value as { x?: unknown; y?: unknown };
      const x = clampNum(v?.x, LAYOUT_LIMITS.x.min, LAYOUT_LIMITS.x.max);
      const y = clampNum(v?.y, LAYOUT_LIMITS.y.min, LAYOUT_LIMITS.y.max);
      if (x !== null && y !== null) nodes[id] = { x: round(x), y: round(y) };
    }
  }
  return { rooms, nodes, updatedAt: Number(raw.updatedAt) || 0 };
}

/** 合并两层覆盖（后者优先） */
export function mergeLayoutOverride(base: LayoutOverride, patch: LayoutOverride): LayoutOverride {
  return {
    rooms: { ...base.rooms, ...patch.rooms },
    nodes: { ...base.nodes, ...patch.nodes },
    updatedAt: Math.max(base.updatedAt, patch.updatedAt),
  };
}

// ========== 模块级「当前生效」覆盖层 ==========

let active: LayoutOverride = EMPTY_LAYOUT;
let version = 0;
const listeners = new Set<() => void>();

/** 设置当前生效的覆盖层（传 null 表示回到内置布局） */
export function setLayoutOverride(override: LayoutOverride | null): void {
  const next = override && !isLayoutEmpty(override) ? override : EMPTY_LAYOUT;
  active = next;
  version++;
  for (const fn of listeners) fn();
}

/** 当前生效的覆盖层 */
export function getLayoutOverride(): LayoutOverride {
  return active;
}

/** 覆盖层版本号（路网缓存失效用） */
export function layoutVersion(): number {
  return version;
}

/** 订阅覆盖层变化（测试/调试用） */
export function onLayoutOverrideChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 把覆盖层应用到房间表（返回新数组，不改动入参） */
export function applyRoomOverride(base: PixelRoom[], override: LayoutOverride = active): PixelRoom[] {
  if (isLayoutEmpty(override)) return base;
  return base.map((room) => {
    const o = override.rooms[room.id];
    if (!o) return room;
    return {
      ...room,
      bounds: o.bounds ?? room.bounds,
      labelAnchor: o.labelAnchor ?? room.labelAnchor,
      work: o.work ?? room.work,
    };
  });
}

/** 把覆盖层应用到路网节点（返回新数组） */
export function applyNodeOverride(base: WalkNode[], override: LayoutOverride = active): WalkNode[] {
  if (isLayoutEmpty(override)) return base;
  return base.map((node) => {
    const o = override.nodes[node.id];
    return o ? { ...node, x: o.x, y: o.y } : node;
  });
}

/** 把一个房间整体平移 dx/dy（房间框、标签锚点、工作锚点一起走） */
export function translateRoom(room: PixelRoom, dx: number, dy: number): RoomOverride {
  const [x, y, w, h] = room.bounds;
  const nx = clampNum(x + dx, LAYOUT_LIMITS.x.min, LAYOUT_LIMITS.x.max) ?? x;
  const ny = clampNum(y + dy, LAYOUT_LIMITS.y.min, LAYOUT_LIMITS.y.max) ?? y;
  const ax = nx - x;
  const ay = ny - y;
  return {
    bounds: [round(nx), round(ny), w, h],
    labelAnchor: { x: round(room.labelAnchor.x + ax), y: round(room.labelAnchor.y + ay) },
    work: { x: round(room.work.x + ax), y: round(room.work.y + ay), radius: room.work.radius },
  };
}

/** 调整房间尺寸（左上角固定），并把工作/标签锚点夹回矩形内 */
export function resizeRoom(room: PixelRoom, width: number, height: number): RoomOverride {
  const [x, y] = room.bounds;
  const w = clampNum(width, LAYOUT_LIMITS.minSize, LAYOUT_LIMITS.maxSize) ?? room.bounds[2];
  const h = clampNum(height, LAYOUT_LIMITS.minSize, LAYOUT_LIMITS.maxSize) ?? room.bounds[3];
  const margin = 12;
  const clampX = (v: number) => Math.min(Math.max(v, x + margin), x + w - margin);
  const clampY = (v: number) => Math.min(Math.max(v, y + margin), y + h - margin);
  return {
    bounds: [x, y, round(w), round(h)],
    labelAnchor: { x: round(clampX(room.labelAnchor.x)), y: round(clampY(room.labelAnchor.y)) },
    work: { x: round(clampX(room.work.x)), y: round(clampY(room.work.y)), radius: room.work.radius },
  };
}

function round(v: number): number {
  return Math.round(v);
}
