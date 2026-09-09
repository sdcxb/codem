/**
 * 场景引擎 —— 把「快照（角色 + 状态）」推进为「图书馆内的动画运行态」。
 *
 * 纯逻辑：输入上一次场景状态 + 新快照 + 时间增量，输出下一次场景状态。
 * 不触碰 DOM / React / Phaser，因此可以在 node / happy-dom 下完整单测
 * （这是本插件可被审计的关键：动画行为是**可测的状态机**，不是黑盒）。
 *
 * 对标 ClawLibrary `LibraryScene` 的运行时语义：
 *   spawnAgentActor / setAgentActorFocus / setAgentActorStatus / despawnAgentActor
 *   + 沿路径行走 + 到岗停留（linger）+ 头顶名牌/气泡
 * 但把「一个角色」推广为「一支团队」：每个角色有自己的岗位、工位槽位与状态。
 */

import type { ActorActivity, LibraryActor, LibrarySnapshot, LibraryZone, SceneActor, SceneState, TileCoord } from "../types";
import { LIBRARY_MAP, getZone, isTileInZone, resolveZoneId, stationSlot } from "../data/library-map";
import { buildWalkGrid, findPath, isWalkable, nearestWalkable, type WalkGrid } from "./pathfinder";

/** 行走速度（瓦片 / 秒） */
export const WALK_TILES_PER_SEC = 2.4;
/** 入场淡入时长（ms） */
export const APPEAR_MS = 420;
/** 退场淡出时长（ms） */
export const FADE_OUT_MS = 520;
/** 「完成」高亮持续时间（ms） */
export const DONE_HOLD_MS = 4000;
/** 气泡最短展示时长（ms） */
export const BUBBLE_MS = 3200;

const gridCache = new WeakMap<object, WalkGrid>();
function walkGrid(): WalkGrid {
  let g = gridCache.get(LIBRARY_MAP as unknown as object);
  if (!g) {
    g = buildWalkGrid(LIBRARY_MAP);
    gridCache.set(LIBRARY_MAP as unknown as object, g);
  }
  return g;
}

/** 新建空场景状态 */
export function createSceneState(now = Date.now()): SceneState {
  return { tick: 0, at: now, actors: {}, assignments: {}, slots: {} };
}

/** 场景中需要渲染的演员（含正在退场的），按等距深度排序（后画覆盖先画） */
export function orderedActors(state: SceneState): SceneActor[] {
  return Object.values(state.actors).sort((a, b) => {
    const da = a.col + a.row;
    const db = b.col + b.row;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
}

/** 演员当前屏幕位置（等距像素） */
export function actorPixel(a: SceneActor): { x: number; y: number } {
  return {
    x: ((a.col - a.row) * LIBRARY_MAP.tileWidth) / 2,
    y: ((a.col + a.row) * LIBRARY_MAP.tileHeight) / 2,
  };
}

/** 目标动画：行走优先；`done` 只保持 DONE_HOLD_MS，之后回落为待命（否则会永远定格在「完成」） */
function desiredAnim(actor: LibraryActor, at: number, prev?: SceneActor): ActorActivity {
  if (actor.activity === "done") {
    if (prev === undefined) return "done";
    return at - prev.animSince < DONE_HOLD_MS ? "done" : "idle";
  }
  return actor.activity;
}

/**
 * 把工位吸附到「区域内 + 可通行」的瓦片。
 * `stationSlot` 已保证落在区域矩形内；若该格被家具占据，则在本区域内找最近的
 * 可通行格（不会跑到走廊或别的岗位），区域内全被占据时再退回全局最近可通行格。
 */
function walkableStation(raw: TileCoord, zone: LibraryZone | undefined, grid: WalkGrid): TileCoord {
  if (isWalkable(grid, raw)) return raw;
  if (!zone) return nearestWalkable(raw, grid);
  const radius = Math.max(zone.rect.w, zone.rect.h);
  const candidates: TileCoord[] = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const t = { col: raw.col + dc, row: raw.row + dr };
      if (!isTileInZone(t, zone)) continue;
      if (!isWalkable(grid, t)) continue;
      candidates.push(t);
    }
  }
  if (candidates.length === 0) return nearestWalkable(raw, grid);
  candidates.sort((a, b) => {
    const da = Math.abs(a.col - raw.col) + Math.abs(a.row - raw.row);
    const db = Math.abs(b.col - raw.col) + Math.abs(b.row - raw.row);
    if (da !== db) return da - db;
    if (a.col !== b.col) return a.col - b.col;
    return a.row - b.row;
  });
  return candidates[0];
}

/** 计算某区域内的稳定槽位序号（按演员 id 排序，保证不抖动） */
function slotIndexOf(snapshot: LibrarySnapshot, zoneId: string, actorId: string): number {
  const peers = snapshot.actors
    .filter((a) => resolveZoneId(a.roleLabel) === zoneId)
    .map((a) => a.id)
    .sort();
  const idx = peers.indexOf(actorId);
  return idx < 0 ? 0 : idx;
}

/**
 * 推进场景一帧。
 *
 * @param prev 上一次场景状态（首帧传 createSceneState()）
 * @param snapshot 适配层输出的最新快照
 * @param dtMs 距上次推进的毫秒数（负数/NaN 会被归零）
 */
export function advanceScene(
  prev: SceneState,
  snapshot: LibrarySnapshot,
  dtMs: number,
): SceneState {
  const now = snapshot.at;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 1000) : 0;
  const grid = walkGrid();

  const actors: Record<string, SceneActor> = {};
  const assignments: Record<string, string> = {};
  const slots: Record<string, number> = {};

  const present = new Set(snapshot.actors.map((a) => a.id));

  // ---- 1. 同步在场演员 ----
  for (const incoming of snapshot.actors) {
    const zoneId = resolveZoneId(incoming.roleLabel);
    const slotIndex = slotIndexOf(snapshot, zoneId, incoming.id);
    const zone = getZone(zoneId);
    const rawStation = zone ? stationSlot(zone, slotIndex) : { ...LIBRARY_MAP.entrance };
    const station = walkableStation(rawStation, zone, grid);

    assignments[incoming.id] = zoneId;
    slots[incoming.id] = slotIndex;

    const old = prev.actors[incoming.id];
    if (!old) {
      // 新角色：从入口入场，走向工位
      const start = nearestWalkable(LIBRARY_MAP.entrance, grid);
      const path = findPath(start, station, grid);
      actors[incoming.id] = {
        id: incoming.id,
        col: start.col,
        row: start.row,
        path,
        station,
        zoneId,
        facing: 1,
        anim: path.length > 0 ? "walking" : desiredAnim(incoming, now),
        animSince: now,
        walking: path.length > 0,
        appear: 0,
        bubble: undefined,
        bubbleUntil: 0,
      };
      continue;
    }

    const moved = old.station.col !== station.col || old.station.row !== station.row;
    const path = moved ? findPath({ col: old.col, row: old.row }, station, grid) : old.path;

    const focusText = incoming.focus || incoming.statusLabel;
    const focusChanged = focusText && focusText !== old.bubble;
    const anim = path.length > 0 ? "walking" : desiredAnim(incoming, now, old);

    actors[incoming.id] = {
      ...old,
      station,
      zoneId,
      path,
      walking: path.length > 0,
      anim,
      animSince: anim !== old.anim ? now : old.animSince,
      appear: Math.min(1, old.appear + (dt > 0 ? dt / APPEAR_MS : 1)),
      bubble: focusChanged ? focusText : old.bubble,
      bubbleUntil: focusChanged ? now + BUBBLE_MS : old.bubbleUntil,
      leaving: false,
    };
  }

  // ---- 2. 处理离场演员（淡出后移除） ----
  for (const [id, old] of Object.entries(prev.actors)) {
    if (present.has(id)) continue;
    const leaveAt = old.leaveAt ?? now;
    const elapsed = Math.max(0, now - leaveAt);
    const progress = elapsed / FADE_OUT_MS;
    if (progress >= 1) continue; // 淡出完毕，移除
    actors[id] = {
      ...old,
      leaving: true,
      leaveAt,
      appear: Math.max(0, Math.min(1, old.appear) * (1 - progress)),
      walking: false,
      anim: "sleeping",
      path: [],
    };
  }

  return { tick: prev.tick + 1, at: now, actors, assignments, slots };
}

/** 沿路径推进演员位置（在渲染 tick 中调用，返回是否有位移） */
export function stepActorMovement(actor: SceneActor, dtMs: number): boolean {
  if (!actor.walking || actor.path.length === 0) {
    if (actor.walking) actor.walking = false;
    return false;
  }
  let budget = (WALK_TILES_PER_SEC * dtMs) / 1000;
  let moved = false;
  while (budget > 0 && actor.path.length > 0) {
    const next = actor.path[0];
    const dx = next.col - actor.col;
    const dy = next.row - actor.row;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget || dist === 0) {
      actor.col = next.col;
      actor.row = next.row;
      actor.path.shift();
      budget -= dist;
      moved = true;
      if (dx !== 0) actor.facing = dx > 0 ? 1 : -1;
    } else {
      actor.col += (dx / dist) * budget;
      actor.row += (dy / dist) * budget;
      if (dx !== 0) actor.facing = dx > 0 ? 1 : -1;
      budget = 0;
      moved = true;
    }
  }
  if (actor.path.length === 0) actor.walking = false;
  return moved;
}

/** 气泡是否仍应显示 */
export function bubbleVisible(actor: SceneActor, now: number): boolean {
  return Boolean(actor.bubble) && (actor.bubbleUntil ?? 0) > now;
}

/** 场景统计（HUD 展示用） */
export function sceneStats(state: SceneState): {
  total: number;
  walking: number;
  working: number;
  idle: number;
  zones: Array<{ zoneId: string; count: number }>;
} {
  let walking = 0;
  let working = 0;
  let idle = 0;
  const byZone = new Map<string, number>();
  for (const a of Object.values(state.actors)) {
    if (a.leaving) continue;
    if (a.walking) walking++;
    else if (a.anim === "idle" || a.anim === "sleeping") idle++;
    else working++;
    byZone.set(a.zoneId, (byZone.get(a.zoneId) ?? 0) + 1);
  }
  return {
    total: Object.values(state.actors).filter((a) => !a.leaving).length,
    walking,
    working,
    idle,
    zones: [...byZone.entries()].map(([zoneId, count]) => ({ zoneId, count })).sort((a, b) => b.count - a.count),
  };
}
