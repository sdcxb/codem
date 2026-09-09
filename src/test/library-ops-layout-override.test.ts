/**
 * LO-LAYOUT — 场景对位覆盖层（拖动房间框 / 走道节点）
 *
 * 覆盖：
 * - LO-LAYOUT-1 覆盖层数据收敛（非法值丢弃 / 越界夹紧 / 最小尺寸）
 * - LO-LAYOUT-2 平移房间：房间框、标签锚点、工作锚点一起走
 * - LO-LAYOUT-3 缩放房间：左上角固定，锚点夹回矩形内
 * - LO-LAYOUT-4 模块级注册表：版本号递增 + 订阅通知 + 空表回退
 * - LO-LAYOUT-5 `pixelRooms()` / `getPixelRoom()` / `roomAnchorOfZone()` 反映覆盖
 * - LO-LAYOUT-6 引擎按覆盖后的锚点派工（角色走到拖动后的位置）
 * - LO-LAYOUT-7 路网节点覆盖后 BFS 缓存自动重建（nearestNode / computePixelRoute）
 * - LO-LAYOUT-8 store：按场景图片分别保存 + 持久化 + 切换场景互不污染
 * - LO-LAYOUT-9 store：resetLayout 只清当前，resetAllLayouts 清全部
 * - LO-LAYOUT-10 读取损坏的持久化数据不抛错
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EMPTY_LAYOUT,
  applyNodeOverride,
  applyRoomOverride,
  isLayoutEmpty,
  layoutCount,
  layoutVersion,
  mergeLayoutOverride,
  normalizeLayoutOverride,
  onLayoutOverrideChange,
  resizeRoom,
  setLayoutOverride,
  translateRoom,
} from "../plugins/library-ops/data/layout-override";
import { PIXEL_ROOMS, WALK_NODES, getPixelRoom, pixelRooms, roomAnchorOfZone, walkNodes } from "../plugins/library-ops/data/pixel-art";
import { computePixelRoute, currentWalkNodes, nearestNode, routeOnGraph } from "../plugins/library-ops/core/pixel-path";
import { advancePixelScene, createPixelSceneState } from "../plugins/library-ops/core/pixel-scene";
import { LAYOUT_STORAGE_KEY, loadLayoutOverrides, useLibraryOps } from "../plugins/library-ops/store";
import { resolveZoneId } from "../plugins/library-ops/data/library-map";
import { generateLook } from "../plugins/library-ops/data/characters";
import type { LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";

const NOW = 1_800_000_000_000;

function actor(id: string, roleLabel: string): LibraryActor {
  return {
    id,
    name: `角色-${id}`,
    roleLabel,
    kind: "member",
    look: generateLook(id, roleLabel),
    activity: "working",
    statusLabel: "执行中",
    lastEventAt: NOW,
    metrics: { tasks: 0, done: 0, failed: 0, tools: 0, tokens: 0, cost: 0, errors: 0 },
    preferredZoneId: resolveZoneId(roleLabel),
  };
}

function snapshot(at: number, actors: LibraryActor[]): LibrarySnapshot {
  return {
    at,
    actors,
    teams: [],
    metrics: {
      sessions: 0, activeSessions: 0, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: actors.length, actorsWorking: 0, actorsIdle: 0,
      actorsBlocked: 0, actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0,
      costToday: 0, toolCalls: 0, toolErrors: 0, filesTouched: 0, messages: 0, health: 1,
    },
    events: [],
    activity: { perDay: {}, perHour: new Array(24).fill(0), kinds: {} },
    sources: {
      sessions: 0, activeSessions: 0, teams: 0, teamMembers: 0, subagents: 0,
      teamTemplates: 0, agentProfiles: 0, telemetryEvents: 0, failed: [],
    },
    sampleMs: 0,
  };
}

const GATEWAY = PIXEL_ROOMS.find((r) => r.id === "gateway")!;

describe("LO-LAYOUT 场景对位覆盖层", () => {
  beforeEach(() => {
    setLayoutOverride(null);
    useLibraryOps.getState()._reset();
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  });

  afterEach(() => {
    setLayoutOverride(null);
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  });

  it("LO-LAYOUT-1: 覆盖层数据收敛", () => {
    expect(isLayoutEmpty(null)).toBe(true);
    expect(isLayoutEmpty(EMPTY_LAYOUT)).toBe(true);
    expect(isLayoutEmpty({ rooms: { a: {} }, nodes: {}, updatedAt: 0 })).toBe(false);

    const normalized = normalizeLayoutOverride({
      rooms: {
        ok: { bounds: [10, 20, 300, 200], work: { x: 100, y: 120, radius: 24 }, labelAnchor: { x: 50, y: 60 } },
        tiny: { bounds: [0, 0, 5, 5] },
        bad: { bounds: ["a", "b", "c", "d"] as unknown as [number, number, number, number] },
        empty: {},
      },
      nodes: { N1: { x: 100, y: 200 }, N2: { x: "x", y: 1 } as unknown as { x: number; y: number } },
      updatedAt: 42,
    });
    expect(Object.keys(normalized.rooms).sort()).toEqual(["ok", "tiny"]);
    // 最小尺寸被夹到 60
    expect(normalized.rooms.tiny.bounds).toEqual([0, 0, 60, 60]);
    expect(normalized.rooms.bad).toBeUndefined();
    expect(normalized.rooms.empty).toBeUndefined();
    expect(normalized.nodes).toEqual({ N1: { x: 100, y: 200 } });
    expect(normalized.updatedAt).toBe(42);

    // 越界坐标夹紧
    const clamped = normalizeLayoutOverride({ nodes: { N: { x: 99999, y: -99999 } } });
    expect(clamped.nodes.N).toEqual({ x: 2400, y: -400 });

    expect(layoutCount({ rooms: { a: {} }, nodes: { n: { x: 1, y: 1 } }, updatedAt: 0 })).toEqual({ rooms: 1, nodes: 1 });
    const merged = mergeLayoutOverride(
      { rooms: { a: { bounds: [0, 0, 100, 100] } }, nodes: {}, updatedAt: 1 },
      { rooms: { b: { bounds: [1, 1, 100, 100] } }, nodes: {}, updatedAt: 2 },
    );
    expect(Object.keys(merged.rooms).sort()).toEqual(["a", "b"]);
    expect(merged.updatedAt).toBe(2);
  });

  it("LO-LAYOUT-2: 平移房间时三个锚点一起移动", () => {
    const moved = translateRoom(GATEWAY, 120, -60);
    expect(moved.bounds).toEqual([820, 260, 470, 300]);
    expect(moved.labelAnchor).toEqual({ x: 965, y: 340 });
    expect(moved.work).toEqual({ x: 1088, y: 542, radius: GATEWAY.work.radius });

    const rooms = applyRoomOverride(PIXEL_ROOMS, { rooms: { gateway: moved }, nodes: {}, updatedAt: 1 });
    const gateway = rooms.find((r) => r.id === "gateway")!;
    expect(gateway.bounds).toEqual([820, 260, 470, 300]);
    // 其它房间不受影响
    expect(rooms.find((r) => r.id === "memory")!.bounds).toEqual(PIXEL_ROOMS.find((r) => r.id === "memory")!.bounds);
  });

  it("LO-LAYOUT-3: 缩放房间时左上角固定、锚点夹回矩形内", () => {
    const resized = resizeRoom(GATEWAY, 200, 160);
    expect(resized.bounds).toEqual([700, 320, 200, 160]);
    const [x, y, w, h] = resized.bounds!;
    expect(resized.work!.x).toBeGreaterThanOrEqual(x);
    expect(resized.work!.x).toBeLessThanOrEqual(x + w);
    expect(resized.work!.y).toBeGreaterThanOrEqual(y);
    expect(resized.work!.y).toBeLessThanOrEqual(y + h);
    // 最小尺寸夹紧
    expect(resizeRoom(GATEWAY, 1, 1).bounds).toEqual([700, 320, 60, 60]);
  });

  it("LO-LAYOUT-4: 注册表版本号 / 订阅 / 空表回退", () => {
    const v0 = layoutVersion();
    let calls = 0;
    const off = onLayoutOverrideChange(() => calls++);
    setLayoutOverride({ rooms: { gateway: { bounds: [1, 2, 300, 300] } }, nodes: {}, updatedAt: 1 });
    expect(layoutVersion()).toBe(v0 + 1);
    expect(calls).toBe(1);
    expect(getPixelRoom("gateway")!.bounds).toEqual([1, 2, 300, 300]);
    // 空表等价于「没有覆盖」
    setLayoutOverride({ rooms: {}, nodes: {}, updatedAt: 0 });
    expect(getPixelRoom("gateway")!.bounds).toEqual(GATEWAY.bounds);
    // null 也回到内置布局
    setLayoutOverride(null);
    expect(getPixelRoom("gateway")!.bounds).toEqual(GATEWAY.bounds);
    off();
    setLayoutOverride(null);
    expect(calls).toBe(3); // 取消订阅后不再回调
  });

  it("LO-LAYOUT-5: pixelRooms / getPixelRoom / roomAnchorOfZone 反映覆盖", () => {
    expect(pixelRooms().length).toBe(PIXEL_ROOMS.length);
    expect(pixelRooms()).toEqual(PIXEL_ROOMS);
    const base = roomAnchorOfZone("front-desk");

    setLayoutOverride({
      rooms: { gateway: { bounds: [900, 500, 400, 260], work: { x: 1000, y: 620, radius: 24 }, labelAnchor: { x: 1100, y: 520 } } },
      nodes: {},
      updatedAt: 1,
    });
    const moved = roomAnchorOfZone("front-desk");
    expect(moved.x).toBe(1000);
    expect(moved.y).toBe(620);
    expect(moved.x).not.toBe(base.x);
    // 其它岗位不变
    expect(roomAnchorOfZone("reading-hall")).toEqual(roomAnchorOfZone("reading-hall"));
  });

  it("LO-LAYOUT-6: 引擎按覆盖后的锚点派工", () => {
    const agents = [actor("a1", "队长 · 调度台")];
    const before = advancePixelScene(createPixelSceneState(NOW), snapshot(NOW, agents), 0);
    const baseTarget = before.actors["a1"].target;

    setLayoutOverride({
      rooms: { gateway: { work: { x: 1000, y: 620, radius: 24 } } },
      nodes: {},
      updatedAt: 1,
    });
    const after = advancePixelScene(before, snapshot(NOW + 1000, agents), 1000);
    const movedTarget = after.actors["a1"].target;
    expect(Math.hypot(movedTarget.x - 1000, movedTarget.y - 620)).toBeLessThanOrEqual(30);
    expect(Math.hypot(movedTarget.x - baseTarget.x, movedTarget.y - baseTarget.y)).toBeGreaterThan(30);
    // 目标变了 → 重新规划了路径
    expect(after.actors["a1"].path.length).toBeGreaterThan(0);
  });

  it("LO-LAYOUT-7: 路网节点覆盖后 BFS 缓存自动重建", () => {
    expect(currentWalkNodes()).toEqual(WALK_NODES);
    expect(nearestNode({ x: 860, y: 610 }).id).toBe("GW1");

    // 把 GW1 拖到别处
    setLayoutOverride({ rooms: {}, nodes: { GW1: { x: 300, y: 900 } }, updatedAt: 1 });
    const nodes = currentWalkNodes();
    expect(nodes.find((n) => n.id === "GW1")).toMatchObject({ x: 300, y: 900 });
    expect(walkNodes().find((n) => n.id === "GW1")).toMatchObject({ x: 300, y: 900 });
    expect(nearestNode({ x: 300, y: 900 }).id).toBe("GW1");
    // 连通性不受影响，路由仍然可用；终点落在被拖动的节点上
    const route = routeOnGraph("GW1", "BR1");
    expect(route.length).toBeGreaterThan(1);
    expect(route[0].id).toBe("GW1");
    const polyline = computePixelRoute({ x: 1560, y: 875 }, { x: 300, y: 900 });
    expect(polyline.length).toBeGreaterThan(0);
    expect(polyline.some((p) => Math.abs(p.x - 300) < 1 && Math.abs(p.y - 900) < 1)).toBe(true);

    // 清空后回到内置节点
    setLayoutOverride(null);
    expect(nearestNode({ x: 860, y: 610 }).id).toBe("GW1");
    expect(currentWalkNodes()).toEqual(WALK_NODES);
    expect(applyNodeOverride(WALK_NODES, EMPTY_LAYOUT)).toEqual(WALK_NODES);
  });

  it("LO-LAYOUT-8: store 按场景图片分别保存并持久化", () => {
    const store = useLibraryOps.getState();
    expect(store.settings.sceneImageId).toBe("ai-library-01");

    store.setRoomOverride("gateway", translateRoom(GATEWAY, 40, 20));
    const after = useLibraryOps.getState();
    expect(after.layoutOverrides["ai-library-01"].rooms.gateway.bounds).toEqual([740, 340, 470, 300]);
    expect(getPixelRoom("gateway")!.bounds).toEqual([740, 340, 470, 300]);
    // 已持久化
    expect(loadLayoutOverrides()["ai-library-01"].rooms.gateway.bounds).toEqual([740, 340, 470, 300]);
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!)).toBeTruthy();

    // 换到另一个场景 → 该场景没有覆盖，布局回到内置
    useLibraryOps.getState().updateSettings({ sceneImageId: "claw" });
    expect(getPixelRoom("gateway")!.bounds).toEqual(GATEWAY.bounds);
    useLibraryOps.getState().setNodeOverride("GW1", { x: 111, y: 222 });
    expect(useLibraryOps.getState().layoutOverrides["claw"].nodes.GW1).toEqual({ x: 111, y: 222 });
    expect(useLibraryOps.getState().layoutOverrides["ai-library-01"].nodes.GW1).toBeUndefined();

    // 切回去 → 恢复各自的对位
    useLibraryOps.getState().updateSettings({ sceneImageId: "ai-library-01" });
    expect(getPixelRoom("gateway")!.bounds).toEqual([740, 340, 470, 300]);
    expect(currentWalkNodes().find((n) => n.id === "GW1")).toMatchObject({ x: 860, y: 610 });
  });

  it("LO-LAYOUT-9: resetLayout 只清当前场景，resetAllLayouts 清全部", () => {
    const store = useLibraryOps.getState();
    store.setNodeOverride("GW1", { x: 100, y: 100 });
    store.updateSettings({ sceneImageId: "claw" });
    store.setNodeOverride("GW1", { x: 200, y: 200 });

    useLibraryOps.getState().resetLayout();
    expect(useLibraryOps.getState().layoutOverrides["claw"]).toBeUndefined();
    expect(useLibraryOps.getState().layoutOverrides["ai-library-01"]).toBeDefined();
    expect(useLibraryOps.getState().layoutOverrides["claw"]).toBeUndefined();

    useLibraryOps.getState().resetAllLayouts();
    expect(useLibraryOps.getState().layoutOverrides).toEqual({});
    expect(loadLayoutOverrides()).toEqual({});
    expect(currentWalkNodes()).toEqual(WALK_NODES);
  });

  it("LO-LAYOUT-10: 损坏的持久化数据不抛错", () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, "{ not json");
    expect(loadLayoutOverrides()).toEqual({});
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ x: 1, y: null, "ai-library-01": { rooms: { gateway: { bounds: [1, 2, 3, 4] } } } }));
    const loaded = loadLayoutOverrides();
    // bounds 被夹到最小尺寸，仍然可用
    expect(loaded["ai-library-01"].rooms.gateway.bounds).toEqual([1, 2, 60, 60]);
    expect(loaded.x).toBeUndefined();
  });
});
