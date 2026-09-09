/**
 * LO-SCENE — 场景引擎（纯逻辑状态机）
 *
 * 覆盖：角色入场/到岗/离场、跨 tick 稳定分配、同岗位多角色工位分离、
 * 行走插值、朝向翻转、动画态映射、深度排序、统计。
 */
import { describe, it, expect } from "vitest";
import {
  advanceScene,
  actorPixel,
  bubbleVisible,
  createSceneState,
  DONE_HOLD_MS,
  orderedActors,
  sceneStats,
  stepActorMovement,
  WALK_TILES_PER_SEC,
} from "../plugins/library-ops/core/scene-engine";
import { getZone, isTileInZone, stationSlot } from "../plugins/library-ops/data/library-map";
import type { LibraryActor, LibrarySnapshot, SceneActor } from "../plugins/library-ops/types";
import { generateLook } from "../plugins/library-ops/data/characters";
import { buildWalkGrid } from "../plugins/library-ops/core/pathfinder";
import { ENTRANCE, LIBRARY_MAP } from "../plugins/library-ops/data/library-map";

function makeActor(id: string, roleLabel: string, activity: LibraryActor["activity"] = "working"): LibraryActor {
  return {
    id,
    name: id,
    roleLabel,
    kind: "member",
    look: generateLook(id, roleLabel),
    activity,
    statusLabel: "执行中",
    focus: `任务 ${id}`,
    lastEventAt: 1000,
    metrics: { tasks: 0, done: 0, failed: 0, tools: 0, tokens: 0, cost: 0, errors: 0 },
    preferredZoneId: "code-forge",
  };
}

function makeSnapshot(at: number, actors: LibraryActor[]): LibrarySnapshot {
  return {
    at,
    actors,
    teams: [],
    metrics: {
      sessions: 0,
      activeSessions: 0,
      teams: 0,
      tasksTotal: 0,
      tasksDone: 0,
      tasksFailed: 0,
      tasksRunning: 0,
      tasksPending: 0,
      actors: actors.length,
      actorsWorking: 0,
      actorsIdle: 0,
      actorsBlocked: 0,
      actorsError: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      costTotal: 0,
      costToday: 0,
      toolCalls: 0,
      toolErrors: 0,
      filesTouched: 0,
      messages: 0,
      health: 1,
    },
    events: [],
    activity: { perDay: {}, perHour: new Array(24).fill(0), kinds: {} },
    sources: {
      sessions: 0,
      activeSessions: 0,
      teams: 0,
      teamMembers: 0,
      subagents: 0,
      teamTemplates: 0,
      agentProfiles: 0,
      telemetryEvents: 0,
      failed: [],
    },
    sampleMs: 0,
  };
}

describe("LO-SCENE 场景推进", () => {
  it("LO-SCENE-1: 新角色从入口入场并走向岗位（walking + 路径非空）", () => {
    const snap = makeSnapshot(1000, [makeActor("a", "成员 · 前端编码")]);
    const state = advanceScene(createSceneState(0), snap, 0);
    const a = state.actors["a"];
    expect(a).toBeTruthy();
    expect(a.walking).toBe(true);
    expect(a.anim).toBe("walking");
    expect(a.path.length).toBeGreaterThan(0);
    expect(a.col).toBe(ENTRANCE.col);
    expect(a.row).toBe(ENTRANCE.row);
    expect(a.zoneId).toBe("code-forge");
  });

  it("LO-SCENE-2: 逐帧行走后抵达工位，动画切回工作态", () => {
    const snap = makeSnapshot(1000, [makeActor("a", "成员 · 前端编码")]);
    let state = advanceScene(createSceneState(0), snap, 0);
    const station = stationSlot(getZone("code-forge"), 0);
    for (let i = 0; i < 200 && state.actors["a"].path.length > 0; i++) {
      stepActorMovement(state.actors["a"], 100);
      state = { ...state, actors: { ...state.actors, a: { ...state.actors["a"] } } };
    }
    expect(state.actors["a"].path.length).toBe(0);
    expect(state.actors["a"].walking).toBe(false);
    expect(state.actors["a"].col).toBeCloseTo(station.col, 1);
    expect(state.actors["a"].row).toBeCloseTo(station.row, 1);
    // 下一帧动画应回到工作态
    const next = advanceScene(state, makeSnapshot(2000, [makeActor("a", "成员 · 前端编码")]), 1000);
    expect(next.actors["a"].anim).toBe("working");
  });

  it("LO-SCENE-3: 角色从快照消失 → 先标记 leaving，淡出后移除", () => {
    const withActor = makeSnapshot(1000, [makeActor("a", "成员 · 前端编码")]);
    let state = advanceScene(createSceneState(0), withActor, 0);
    // 让入场进度先走满，便于观察淡出
    state = advanceScene(state, makeSnapshot(1200, [makeActor("a", "成员 · 前端编码")]), 200);
    expect(state.actors["a"].appear).toBeGreaterThan(0);

    const empty = (at: number) => makeSnapshot(at, []);
    state = advanceScene(state, empty(2000), 100);
    expect(state.actors["a"]).toBeTruthy();
    expect(state.actors["a"].leaving).toBe(true);
    expect(state.actors["a"].appear).toBeLessThan(1);
    // 反复淡出直至移除（时间必须推进）
    let at = 2000;
    for (let i = 0; i < 20; i++) {
      at += 200;
      state = advanceScene(state, empty(at), 200);
    }
    expect(state.actors["a"]).toBeUndefined();
  });

  it("LO-SCENE-4: 岗位分配跨 tick 稳定，角色位置不重置", () => {
    const snap = makeSnapshot(1000, [makeActor("a", "成员 · 检索索引")]);
    const s1 = advanceScene(createSceneState(0), snap, 0);
    stepActorMovement(s1.actors["a"], 400);
    const moved = { ...s1.actors["a"] };
    const s2 = advanceScene(s1, makeSnapshot(2000, [makeActor("a", "成员 · 检索索引")]), 1000);
    expect(s2.actors["a"].zoneId).toBe("catalog-room");
    expect(s2.actors["a"].col).toBeCloseTo(moved.col, 3);
    expect(s2.actors["a"].row).toBeCloseTo(moved.row, 3);
  });

  it("LO-SCENE-5: 同岗位多角色分配到不同工位（不叠格）", () => {
    const actors = [
      makeActor("a1", "成员 · 前端编码"),
      makeActor("a2", "成员 · 后端编码"),
      makeActor("a3", "成员 · 编码实现"),
    ];
    const state = advanceScene(createSceneState(0), makeSnapshot(1000, actors), 0);
    const stations = Object.values(state.actors).map((a) => `${a.station.col},${a.station.row}`);
    expect(new Set(stations).size).toBe(3);
    const slots = Object.values(state.slots);
    expect(slots.sort()).toEqual([0, 1, 2]);
  });

  it("LO-SCENE-6: 行走速度受时间增量控制，朝向随水平位移翻转", () => {
    const grid = buildWalkGrid();
    const actor: SceneActor = {
      id: "t",
      col: 12,
      row: 17,
      path: [
        { col: 12, row: 16 },
        { col: 12, row: 15 },
      ],
      station: { col: 12, row: 15 },
      zoneId: "server-room",
      facing: 1,
      anim: "walking",
      animSince: 0,
      walking: true,
      appear: 1,
    };
    // 1 秒最多走 WALK_TILES_PER_SEC 格
    const moved = stepActorMovement(actor, 1000);
    expect(moved).toBe(true);
    const travelled = Math.abs(actor.row - 17);
    expect(travelled).toBeLessThanOrEqual(WALK_TILES_PER_SEC + 0.001);
    expect(actor.walking).toBe(false);
    expect(actor.path.length).toBe(0);
    void grid;

    // 横向位移决定朝向
    const left: SceneActor = { ...actor, col: 10, row: 10, path: [{ col: 9, row: 10 }], walking: true, facing: 1 };
    stepActorMovement(left, 200);
    expect(left.facing).toBe(-1);
    const right: SceneActor = { ...actor, col: 10, row: 10, path: [{ col: 11, row: 10 }], walking: true, facing: -1 };
    stepActorMovement(right, 200);
    expect(right.facing).toBe(1);
  });

  it("LO-SCENE-7: 动画态映射 —— error / blocked / done 透传，idle 保持", () => {
    const at = 5000;
    const cases: Array<[LibraryActor["activity"], LibraryActor["activity"]]> = [
      ["error", "error"],
      ["blocked", "blocked"],
      ["idle", "idle"],
      ["reading", "reading"],
      ["writing", "writing"],
    ];
    for (const [input, expected] of cases) {
      // 首帧：角色已在工位（用两帧推进让路径走完）
      let state = advanceScene(createSceneState(0), makeSnapshot(at, [makeActor("x", "成员 · 研究分析", input)]), 0);
      state = advanceScene(state, makeSnapshot(at + 10, [makeActor("x", "成员 · 研究分析", input)]), 10);
      // 直接清空路径模拟已到岗
      state.actors["x"].path = [];
      state.actors["x"].walking = false;
      const next = advanceScene(state, makeSnapshot(at + 20, [makeActor("x", "成员 · 研究分析", input)]), 10);
      expect(next.actors["x"].anim, `${input} → ${expected}`).toBe(expected);
    }
  });

  it("LO-SCENE-8: orderedActors 按等距深度（col+row）升序，同深度按 id", () => {
    const actors = [makeActor("z", "成员 · 前端编码"), makeActor("a", "成员 · 检索索引")];
    const state = advanceScene(createSceneState(0), makeSnapshot(1000, actors), 0);
    const order = orderedActors(state);
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1];
      const cur = order[i];
      const dPrev = prev.col + prev.row;
      const dCur = cur.col + cur.row;
      expect(dCur).toBeGreaterThanOrEqual(dPrev);
      if (dCur === dPrev) expect(cur.id.localeCompare(prev.id)).toBeGreaterThanOrEqual(0);
    }
  });

  it("LO-SCENE-9: sceneStats 统计总数/行走/工作/待命与岗位分布", () => {
    const actors = [
      makeActor("a", "成员 · 前端编码", "working"),
      makeActor("b", "成员 · 检索索引", "idle"),
      makeActor("c", "成员 · 文档写作", "error"),
    ];
    const state = advanceScene(createSceneState(0), makeSnapshot(1000, actors), 0);
    const stats = sceneStats(state);
    expect(stats.total).toBe(3);
    expect(stats.walking).toBe(3); // 全部刚入场
    expect(stats.zones.length).toBeGreaterThanOrEqual(3);
    // 到岗后分类统计
    for (const a of Object.values(state.actors)) a.path = [];
    for (const a of Object.values(state.actors)) a.walking = false;
    const settled = advanceScene(state, makeSnapshot(2000, actors), 10);
    const s2 = sceneStats(settled);
    expect(s2.walking).toBe(0);
    expect(s2.idle).toBe(1);
    expect(s2.working).toBe(2);
  });

  it("LO-SCENE-10: actorPixel 与等距投影一致；气泡按时间过期", () => {
    const px = actorPixel({
      id: "p",
      col: 4,
      row: 2,
      path: [],
      station: { col: 4, row: 2 },
      zoneId: "reading-hall",
      facing: 1,
      anim: "idle",
      animSince: 0,
      walking: false,
      appear: 1,
    });
    expect(px.x).toBe(((4 - 2) * LIBRARY_MAP.tileWidth) / 2);
    expect(px.y).toBe(((4 + 2) * LIBRARY_MAP.tileHeight) / 2);

    const bubble: SceneActor = {
      id: "b",
      col: 0,
      row: 0,
      path: [],
      station: { col: 0, row: 0 },
      zoneId: "reading-hall",
      facing: 1,
      anim: "working",
      animSince: 0,
      walking: false,
      appear: 1,
      bubble: "读文件",
      bubbleUntil: 5000,
    };
    expect(bubbleVisible(bubble, 4000)).toBe(true);
    expect(bubbleVisible(bubble, 6000)).toBe(false);
    expect(bubbleVisible({ ...bubble, bubble: undefined }, 4000)).toBe(false);
  });

  it("LO-SCENE-11: 非法 dt（NaN / 负数）不破坏状态", () => {
    const snap = makeSnapshot(1000, [makeActor("a", "成员 · 前端编码")]);
    const s1 = advanceScene(createSceneState(0), snap, 0);
    const s2 = advanceScene(s1, makeSnapshot(1100, [makeActor("a", "成员 · 前端编码")]), NaN);
    expect(s2.actors["a"]).toBeTruthy();
    const s3 = advanceScene(s2, makeSnapshot(1200, [makeActor("a", "成员 · 前端编码")]), -500);
    expect(s3.actors["a"]).toBeTruthy();
    expect(Number.isFinite(s3.actors["a"].col)).toBe(true);
  });

  it("LO-SCENE-12: done 动画只保持 DONE_HOLD_MS，之后回落 idle（不再永久定格「完成」）", () => {
    const at = 10_000;
    const doneActor = () => makeActor("d", "成员 · 前端编码", "done");
    let state = advanceScene(createSceneState(0), makeSnapshot(at, [doneActor()]), 0);
    // 手动结束入场行走，让角色进入「到岗」状态
    state.actors["d"].path = [];
    state.actors["d"].walking = false;
    state = advanceScene(state, makeSnapshot(at + 10, [doneActor()]), 10);
    expect(state.actors["d"].anim).toBe("done");

    // 保持期内仍是 done
    const held = advanceScene(state, makeSnapshot(at + 10 + DONE_HOLD_MS - 100, [doneActor()]), 100);
    expect(held.actors["d"].anim).toBe("done");

    // 超过保持期 → idle
    const decayed = advanceScene(held, makeSnapshot(at + 10 + DONE_HOLD_MS + 100, [doneActor()]), 200);
    expect(decayed.actors["d"].anim).toBe("idle");
  });

  it("LO-SCENE-13: 工位落点始终在本区域内（家具占位也不会跑到走廊）", () => {
    const actors = ["a", "b", "c", "d", "e"].map((id) => makeActor(id, "成员 · 前端编码"));
    const state = advanceScene(createSceneState(0), makeSnapshot(1000, actors), 0);
    const zone = getZone("code-forge")!;
    for (const a of Object.values(state.actors)) {
      expect(a.zoneId).toBe("code-forge");
      expect(isTileInZone(a.station, zone), `${a.id} 工位越界`).toBe(true);
    }
  });
});
