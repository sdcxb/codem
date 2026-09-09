/**
 * 像素场景引擎 —— 把「快照」推进为「图书馆像素场景里的动画运行态」。
 *
 * 与等距场景引擎（`scene-engine.ts`）同构、同契约（纯函数 + 可单测），
 * 但坐标系统是上游 ClawLibrary 的逻辑像素空间（1920×1080）：
 * - 角色在 12 个房间之间沿 walkGraph 行走；
 * - 每个岗位对应一个房间与工作锚点，同岗位多角色按环形错开；
 * - 工作状态映射到上游精灵动作（work/read/idea/error/sleep/…）。
 *
 * 场景美术来自 ClawLibrary / Star-Office-UI（**仅限非商业**，见 docs/ASSET-LICENSES.md）。
 */

import type { ActorActivity, LibraryActor, LibrarySnapshot, ScreenPoint } from "../types";
import {
  ACTIVITY_TO_SPRITE,
  CLAW_SCENE,
  pickVariant,
  resolveSprite,
  roomAnchorOfZone,
  roomOfZone,
  type SpriteAction,
  type SpriteSheet,
  type SpriteVariant,
} from "../data/pixel-art";
import { resolveZoneId } from "../data/library-map";
import { computePixelRoute, roomSlot } from "./pixel-path";

/** 行走速度（逻辑像素 / 秒） */
export const PIXEL_WALK_SPEED = 128;
/** 入场淡入时长（ms） */
export const PIXEL_APPEAR_MS = 420;
/** 退场淡出时长（ms） */
export const PIXEL_FADE_MS = 520;
/** 「完成」动作保持时长（ms） */
export const PIXEL_DONE_HOLD_MS = 4000;
/** 气泡展示时长（ms） */
export const PIXEL_BUBBLE_MS = 3200;

export interface PixelActor {
  id: string;
  /** 逻辑坐标（1920×1080） */
  x: number;
  y: number;
  /** 剩余路径（不含已到达点） */
  path: ScreenPoint[];
  /** 工位目标 */
  target: ScreenPoint;
  /** 所属房间 */
  roomId: string;
  /** 岗位 id */
  zoneId: string;
  /** 精灵变体（角色形象） */
  variant: SpriteVariant;
  /** 当前动作 */
  action: SpriteAction;
  /** 动作开始时间 */
  actionSince: number;
  /** 朝向：1 右 / -1 左 */
  facing: 1 | -1;
  walking: boolean;
  appear: number;
  bubble?: string;
  bubbleUntil: number;
  leaving?: boolean;
  leaveAt?: number;
}

export interface PixelSceneState {
  tick: number;
  at: number;
  actors: Record<string, PixelActor>;
  /** 演员 → 岗位（跨 tick 稳定） */
  assignments: Record<string, string>;
  /** 演员 → 房间 */
  rooms: Record<string, string>;
  /** 演员 → 工位槽位序号 */
  slots: Record<string, number>;
}

export function createPixelSceneState(now = Date.now()): PixelSceneState {
  return { tick: 0, at: now, actors: {}, assignments: {}, rooms: {}, slots: {} };
}

/** 需要渲染的演员（含正在退场），按 y 排序（y 越大越靠前，符合俯视遮挡） */
export function orderedPixelActors(state: PixelSceneState): PixelActor[] {
  return Object.values(state.actors).sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.id.localeCompare(b.id);
  });
}

/** 场景统计（HUD 用） */
export function pixelSceneStats(state: PixelSceneState): {
  total: number;
  walking: number;
  working: number;
  idle: number;
  rooms: Array<{ roomId: string; count: number }>;
} {
  let walking = 0;
  let working = 0;
  let idle = 0;
  const byRoom = new Map<string, number>();
  for (const a of Object.values(state.actors)) {
    if (a.leaving) continue;
    if (a.walking) walking++;
    else if (a.action === "sleep" || a.action === "stand_front" || a.action === "front") idle++;
    else working++;
    byRoom.set(a.roomId, (byRoom.get(a.roomId) ?? 0) + 1);
  }
  return {
    total: Object.values(state.actors).filter((a) => !a.leaving).length,
    walking,
    working,
    idle,
    rooms: [...byRoom.entries()].map(([roomId, count]) => ({ roomId, count })).sort((a, b) => b.count - a.count),
  };
}

/** 动作选择：行走优先；`done` 只保持一段时间 */
export function desiredPixelAction(actor: LibraryActor, at: number, prev?: PixelActor): SpriteAction {
  if (actor.activity === "done") {
    if (prev === undefined) return "coffee";
    return at - prev.actionSince < PIXEL_DONE_HOLD_MS ? "coffee" : "stand_front";
  }
  return ACTIVITY_TO_SPRITE[actor.activity] ?? "stand_front";
}

/** 同岗位稳定槽位序号 */
function slotIndexOf(snapshot: LibrarySnapshot, zoneId: string, actorId: string): number {
  const peers = snapshot.actors
    .filter((a) => resolveZoneId(a.roleLabel) === zoneId)
    .map((a) => a.id)
    .sort();
  const idx = peers.indexOf(actorId);
  return idx < 0 ? 0 : idx;
}

/**
 * 推进像素场景一帧。
 * @param prev 上一次状态
 * @param snapshot 最新快照
 * @param dtMs 距上次推进的毫秒数
 */
export function advancePixelScene(
  prev: PixelSceneState,
  snapshot: LibrarySnapshot,
  dtMs: number,
): PixelSceneState {
  const now = snapshot.at;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 1000) : 0;

  const actors: Record<string, PixelActor> = {};
  const assignments: Record<string, string> = {};
  const rooms: Record<string, string> = {};
  const slots: Record<string, number> = {};
  const present = new Set(snapshot.actors.map((a) => a.id));

  for (const incoming of snapshot.actors) {
    const zoneId = resolveZoneId(incoming.roleLabel);
    const slotIndex = slotIndexOf(snapshot, zoneId, incoming.id);
    const work = roomAnchorOfZone(zoneId);
    const target = roomSlot(work, slotIndex);
    const roomId = roomOfZone(zoneId);
    const variant = pickVariant(incoming.id, zoneId);

    assignments[incoming.id] = zoneId;
    rooms[incoming.id] = roomId;
    slots[incoming.id] = slotIndex;

    const old = prev.actors[incoming.id];
    if (!old) {
      // 新角色：从大厅入口（GW1 附近）入场
      const start = { x: 860, y: 610 };
      const path = computePixelRoute(start, target);
      actors[incoming.id] = {
        id: incoming.id,
        x: start.x,
        y: start.y,
        path,
        target,
        roomId,
        zoneId,
        variant,
        action: path.length > 0 ? "walk" : desiredPixelAction(incoming, now),
        actionSince: now,
        facing: 1,
        walking: path.length > 0,
        appear: 0,
        bubbleUntil: 0,
      };
      continue;
    }

    const moved = Math.abs(old.target.x - target.x) > 1 || Math.abs(old.target.y - target.y) > 1;
    const path = moved ? computePixelRoute({ x: old.x, y: old.y }, target) : old.path;
    const focusText = incoming.focus || incoming.statusLabel;
    const focusChanged = Boolean(focusText) && focusText !== old.bubble;
    const action = path.length > 0 ? "walk" : desiredPixelAction(incoming, now, old);

    actors[incoming.id] = {
      ...old,
      target,
      roomId,
      zoneId,
      variant,
      path,
      walking: path.length > 0,
      action,
      actionSince: action !== old.action ? now : old.actionSince,
      appear: Math.min(1, old.appear + (dt > 0 ? dt / PIXEL_APPEAR_MS : 1)),
      bubble: focusChanged ? focusText : old.bubble,
      bubbleUntil: focusChanged ? now + PIXEL_BUBBLE_MS : old.bubbleUntil,
      leaving: false,
    };
  }

  // 离场演员：淡出后移除
  for (const [id, old] of Object.entries(prev.actors)) {
    if (present.has(id)) continue;
    const leaveAt = old.leaveAt ?? now;
    const progress = Math.max(0, now - leaveAt) / PIXEL_FADE_MS;
    if (progress >= 1) continue;
    actors[id] = {
      ...old,
      leaving: true,
      leaveAt,
      appear: Math.max(0, Math.min(1, old.appear) * (1 - progress)),
      walking: false,
      action: "sleep",
      path: [],
    };
  }

  return { tick: prev.tick + 1, at: now, actors, assignments, rooms, slots };
}

/** 沿路径推进位置（渲染 tick 调用）。返回是否有位移 */
export function stepPixelMovement(actor: PixelActor, dtMs: number): boolean {
  if (!actor.walking || actor.path.length === 0) {
    if (actor.walking) actor.walking = false;
    return false;
  }
  let budget = (PIXEL_WALK_SPEED * dtMs) / 1000;
  let moved = false;
  while (budget > 0 && actor.path.length > 0) {
    const next = actor.path[0];
    const dx = next.x - actor.x;
    const dy = next.y - actor.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget || dist === 0) {
      actor.x = next.x;
      actor.y = next.y;
      actor.path.shift();
      budget -= dist;
      moved = true;
      if (dx !== 0) actor.facing = dx > 0 ? 1 : -1;
    } else {
      actor.x += (dx / dist) * budget;
      actor.y += (dy / dist) * budget;
      if (dx !== 0) actor.facing = dx > 0 ? 1 : -1;
      budget = 0;
      moved = true;
    }
  }
  if (actor.path.length === 0) actor.walking = false;
  return moved;
}

/** 气泡是否仍应显示 */
export function pixelBubbleVisible(actor: PixelActor, now: number): boolean {
  return Boolean(actor.bubble) && (actor.bubbleUntil ?? 0) > now;
}

/** 逻辑坐标 → 场景显示坐标（按 displaySize/logicSize 等比） */
export function logicToDisplay(point: ScreenPoint): ScreenPoint {
  const sx = CLAW_SCENE.displayWidth / CLAW_SCENE.logicWidth;
  const sy = CLAW_SCENE.displayHeight / CLAW_SCENE.logicHeight;
  return { x: point.x * sx, y: point.y * sy };
}

/** 精灵帧位置（第 frame 帧在精灵表里的偏移） */
export function frameOffset(
  sheet: { frameWidth: number; frameHeight: number; columns: number; frameCount: number },
  frame: number,
): { col: number; row: number; x: number; y: number } {
  const total = Math.max(1, sheet.columns * Math.max(1, Math.ceil(sheet.frameCount / sheet.columns)));
  const safe = ((frame % total) + total) % total;
  const col = safe % sheet.columns;
  const row = Math.floor(safe / sheet.columns);
  return { col, row, x: col * sheet.frameWidth, y: row * sheet.frameHeight };
}

/** 取动作对应的精灵表（缺失动作自动回退） */
export function sheetOf(actor: Pick<PixelActor, "variant" | "action">): SpriteSheet {
  return resolveSprite(actor.variant, actor.action).sheet;
}

/** 当前动作应播放到第几帧 */
export function frameAt(actor: PixelActor, now: number): number {
  const sheet = sheetOf(actor);
  const elapsed = Math.max(0, now - actor.actionSince) / 1000;
  return Math.floor(elapsed * sheet.fps) % Math.max(1, sheet.frameCount);
}
