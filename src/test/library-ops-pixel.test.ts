/**
 * LO-PIXEL — 像素美术场景（第三方资源集成）的正确性与完整性
 *
 * 覆盖：
 * - LO-PIXEL-1 岗位 → 房间映射完整（10 个岗位都有房间）
 * - LO-PIXEL-2 上游 walkGraph 连通性 + 任意两点可路由
 * - LO-PIXEL-3 路由折线终点 = 目标点
 * - LO-PIXEL-4 精灵表元数据自洽（帧网格能装下 frameCount；显示尺寸比例正确）
 * - LO-PIXEL-5 11 种工作状态全部映射到精灵动作，且动作在每个变体都可解析
 * - LO-PIXEL-6 场景推进：入场 → 行走 → 到岗 → 离场
 * - LO-PIXEL-7 同房间多角色工位不重叠
 * - LO-PIXEL-8 角色变体分配确定且能混合
 * - LO-PIXEL-9 **资源文件真实存在**（清单路径 ↔ public/library-ops 磁盘文件）
 * - LO-PIXEL-10 许可声明文件齐备（SOURCE.md / LICENSE）
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_TO_SPRITE,
  CLAW_SCENE,
  PIXEL_ROOMS,
  SPRITE_SHEETS,
  SPRITE_VARIANTS,
  STAR_SCENE,
  VARIANT_LABELS,
  WALK_EDGES,
  WALK_NODES,
  ZONE_TO_ROOM,
  getPixelRoom,
  pickVariant,
  resolveSprite,
  roomAnchorOfZone,
  roomOfZone,
} from "../plugins/library-ops/data/pixel-art";
import { computePixelRoute, isGraphConnected, nearestNode, pathLength, roomSlot, routeOnGraph } from "../plugins/library-ops/core/pixel-path";
import {
  advancePixelScene,
  createPixelSceneState,
  frameAt,
  frameOffset,
  pixelBubbleVisible,
  pixelSceneStats,
  stepPixelMovement,
  PIXEL_WALK_SPEED,
  type PixelActor,
} from "../plugins/library-ops/core/pixel-scene";
import { LIBRARY_ZONES, resolveZoneId } from "../plugins/library-ops/data/library-map";
import { generateLook } from "../plugins/library-ops/data/characters";
import type { ActorActivity, LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";

const ROOT = join(__dirname, "..", "..");
const ASSET_DIR = join(ROOT, "public", "library-ops");

const ALL_ACTIVITIES: ActorActivity[] = [
  "idle",
  "walking",
  "thinking",
  "reading",
  "writing",
  "working",
  "searching",
  "blocked",
  "done",
  "error",
  "sleeping",
];

function makeActor(id: string, roleLabel: string, activity: ActorActivity = "working"): LibraryActor {
  return {
    id,
    name: `角色-${id}`,
    roleLabel,
    kind: "member",
    look: generateLook(id, roleLabel),
    activity,
    statusLabel: "执行中",
    focus: `任务 ${id}`,
    lastEventAt: 1000,
    metrics: { tasks: 0, done: 0, failed: 0, tools: 0, tokens: 0, cost: 0, errors: 0 },
    preferredZoneId: resolveZoneId(roleLabel),
  };
}

function makeSnapshot(at: number, actors: LibraryActor[]): LibrarySnapshot {
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

describe("LO-PIXEL 像素场景数据", () => {
  it("LO-PIXEL-1: 10 个岗位全部映射到真实房间，房间字段自洽", () => {
    for (const zone of LIBRARY_ZONES) {
      const roomId = roomOfZone(zone.id);
      const room = getPixelRoom(roomId);
      expect(room, `岗位 ${zone.id} → 房间 ${roomId} 不存在`).toBeTruthy();
      expect(ZONE_TO_ROOM[zone.id]).toBe(roomId);
    }
    expect(Object.keys(ZONE_TO_ROOM).length).toBe(LIBRARY_ZONES.length);
    for (const room of PIXEL_ROOMS) {
      const [x, y, w, h] = room.bounds;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(CLAW_SCENE.logicWidth);
      expect(y + h).toBeLessThanOrEqual(CLAW_SCENE.logicHeight);
      expect(room.token.startsWith("--")).toBe(true);
      expect(room.work.radius).toBeGreaterThan(0);
    }
  });

  it("LO-PIXEL-2: 上游 walkGraph 连通，任意节点对可路由", () => {
    expect(WALK_NODES.length).toBe(20);
    expect(WALK_EDGES.length).toBe(19);
    expect(isGraphConnected()).toBe(true);
    for (const a of WALK_NODES) {
      for (const b of WALK_NODES) {
        const route = routeOnGraph(a.id, b.id);
        expect(route.length, `${a.id} → ${b.id} 不可达`).toBeGreaterThan(0);
        expect(route[0].id).toBe(a.id);
        expect(route[route.length - 1].id).toBe(b.id);
      }
    }
  });

  it("LO-PIXEL-3: 路由折线终点 = 目标点，且长度为正", () => {
    const cases: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [{ x: 860, y: 610 }, { x: 362, y: 344 }],
      [{ x: 362, y: 344 }, { x: 1560, y: 875 }],
      [{ x: 1420, y: 225 }, { x: 682, y: 822 }],
    ];
    for (const [from, to] of cases) {
      const path = computePixelRoute(from, to);
      expect(path.length).toBeGreaterThan(0);
      const last = path[path.length - 1];
      expect(last.x).toBeCloseTo(to.x, 5);
      expect(last.y).toBeCloseTo(to.y, 5);
      expect(pathLength(path)).toBeGreaterThan(0);
    }
  });

  it("LO-PIXEL-4: 精灵表元数据自洽（帧网格装得下 frameCount）", () => {
    for (const variant of SPRITE_VARIANTS) {
      const sheets = SPRITE_SHEETS[variant];
      expect(Object.keys(sheets).length).toBeGreaterThan(8);
      for (const [action, sheet] of Object.entries(sheets)) {
        expect(sheet, `${variant}/${action}`).toBeTruthy();
        const s = sheet!;
        expect(s.frameWidth).toBe(128);
        expect(s.frameHeight).toBe(128);
        expect(s.columns).toBeGreaterThan(0);
        expect(s.rows).toBeGreaterThan(0);
        expect(s.frameCount).toBeGreaterThan(0);
        expect(s.columns * s.rows, `${variant}/${action} 网格装不下 ${s.frameCount} 帧`).toBeGreaterThanOrEqual(s.frameCount);
        expect(s.fps).toBeGreaterThan(0);
        expect(s.path.endsWith(".webp")).toBe(true);
      }
    }
    // 帧偏移在网格内
    const sheet = SPRITE_SHEETS.capy.work!;
    for (const f of [0, 5, 6, 30, 31]) {
      const off = frameOffset(sheet, f);
      expect(off.col).toBeGreaterThanOrEqual(0);
      expect(off.col).toBeLessThan(sheet.columns);
      expect(off.row).toBeGreaterThanOrEqual(0);
      expect(off.row).toBeLessThan(sheet.rows);
    }
  });

  it("LO-PIXEL-5: 11 种工作状态全部映射，且每个动作在每个变体都可解析出精灵表", () => {
    for (const activity of ALL_ACTIVITIES) {
      const action = ACTIVITY_TO_SPRITE[activity];
      expect(action, `${activity} 未映射`).toBeTruthy();
      for (const variant of SPRITE_VARIANTS) {
        const resolved = resolveSprite(variant, action);
        expect(resolved.sheet, `${variant}/${action}`).toBeTruthy();
        expect(resolved.sheet.frameCount).toBeGreaterThan(0);
      }
    }
    // 未知动作也能回退
    expect(resolveSprite("cat", "lie_flat").sheet).toBeTruthy();
    // 自制素材常见情况：只画了站立帧 → 任意动作都回退到站立帧（渲染层再用 CSS 补动效）
    expect(resolveSprite("cat", "read").action).not.toBe("read");
    expect(resolveSprite("cat", "read").sheet).toBeTruthy();
  });

  it("LO-PIXEL-6: 场景推进 —— 入场行走 → 到岗 → 离场淡出", () => {
    const actors = [makeActor("p1", "成员 · 前端编码")];
    let state = advancePixelScene(createPixelSceneState(0), makeSnapshot(1000, actors), 0);
    const a = state.actors["p1"];
    expect(a).toBeTruthy();
    expect(a.walking).toBe(true);
    expect(a.action).toBe("walk");
    expect(a.roomId).toBe("mcp"); // code-forge → mcp
    expect(a.path.length).toBeGreaterThan(0);

    // 走到工位
    let t = 1000;
    for (let i = 0; i < 600 && state.actors["p1"].path.length > 0; i++) {
      t += 50;
      state = advancePixelScene(state, makeSnapshot(t, actors), 50);
      stepPixelMovement(state.actors["p1"], 50);
    }
    expect(state.actors["p1"].path.length).toBe(0);
    expect(state.actors["p1"].walking).toBe(false);
    expect(Math.abs(state.actors["p1"].x - state.actors["p1"].target.x)).toBeLessThan(1.5);
    // 到岗后动作切回工作态
    state = advancePixelScene(state, makeSnapshot(t + 50, actors), 50);
    expect(state.actors["p1"].action).toBe("work");

    // 离场
    const empty = (at: number) => makeSnapshot(at, []);
    state = advancePixelScene(state, empty(t + 100), 100);
    expect(state.actors["p1"].leaving).toBe(true);
    let at = t + 100;
    for (let i = 0; i < 20; i++) {
      at += 200;
      state = advancePixelScene(state, empty(at), 200);
    }
    expect(state.actors["p1"]).toBeUndefined();
  });

  it("LO-PIXEL-7: 同房间多角色工位互不重叠", () => {
    const work = roomAnchorOfZone("code-forge");
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const slot = roomSlot(work, i);
      const key = `${slot.x.toFixed(1)},${slot.y.toFixed(1)}`;
      expect(seen.has(key), `槽位 #${i} 与之前重叠`).toBe(false);
      seen.add(key);
      // 在锚点附近（不超过半径的 1.7 倍）
      expect(Math.hypot(slot.x - work.x, slot.y - work.y)).toBeLessThanOrEqual(work.radius * 1.7 + 1);
    }
    // 场景里三个同岗位角色 → 三个不同目标
    const actors = [makeActor("s1", "成员 · 前端编码"), makeActor("s2", "成员 · 后端编码"), makeActor("s3", "成员 · 编码实现")];
    const state = advancePixelScene(createPixelSceneState(0), makeSnapshot(1000, actors), 0);
    const targets = Object.values(state.actors).map((x) => `${x.target.x.toFixed(1)},${x.target.y.toFixed(1)}`);
    expect(new Set(targets).size).toBe(3);
  });

  it("LO-PIXEL-8: 角色变体分配确定且能混合两个变体", () => {
    expect(pickVariant("actor-a", "code-forge")).toBe(pickVariant("actor-a", "code-forge"));
    const picks = new Set(
      Array.from({ length: 40 }, (_, i) => pickVariant(`actor-${i}`, "code-forge")),
    );
    expect(picks.size).toBe(2);
    expect(Object.keys(VARIANT_LABELS).length).toBe(2);
  });

  it("LO-PIXEL-9: 清单里的每个资源路径在磁盘上真实存在", () => {
    const missing: string[] = [];
    const check = (rel: string) => {
      const p = join(ASSET_DIR, rel);
      if (!existsSync(p)) missing.push(rel);
    };
    check(CLAW_SCENE.floor.replace("/library-ops/", ""));
    check(CLAW_SCENE.objects.replace("/library-ops/", ""));
    check(CLAW_SCENE.walkableMask.replace("/library-ops/", ""));
    for (const variant of SPRITE_VARIANTS) {
      for (const sheet of Object.values(SPRITE_SHEETS[variant])) {
        // 精灵路径相对于 claw-library/（组件里拼 `${ASSET_BASE}/claw-library/${path}`）
        if (sheet) check(`claw-library/${sheet.path}`);
      }
    }
    for (const key of ["bg", "bgLow", "cats", "starIdle", "starWorking", "serverroom", "posters", "plants", "flowers", "coffeeMachine", "desk", "sofa"] as const) {
      check(STAR_SCENE[key].replace("/library-ops/", ""));
    }
    expect(missing, `缺失资源文件：\n${missing.join("\n")}`).toEqual([]);
  });

  it("LO-PIXEL-10: 每个资源来源都有 SOURCE.md 与许可原文", () => {
    for (const dir of ["claw-library", "star-office", "lobster-pet"]) {
      const source = join(ASSET_DIR, dir, "SOURCE.md");
      expect(existsSync(source), `${dir}/SOURCE.md 缺失`).toBe(true);
      const text = readFileSync(source, "utf8");
      expect(text).toContain("http");
      // 许可原文
      const licenseFiles = ["LICENSE-ASSETS.md", "LICENSE.txt", "LICENSE-CODE.txt"];
      const hasLicense = licenseFiles.some((f) => existsSync(join(ASSET_DIR, dir, f)));
      expect(hasLicense, `${dir} 缺少许可原文`).toBe(true);
    }
    // 顶层说明
    expect(existsSync(join(ASSET_DIR, "README.md"))).toBe(true);
    const readme = readFileSync(join(ASSET_DIR, "README.md"), "utf8");
    expect(readme).toContain("非商业");
  });

  it("LO-PIXEL-11: 精灵帧随时间推进（frameAt）且气泡按时过期", () => {
    const actor: PixelActor = {
      id: "x",
      x: 100,
      y: 100,
      path: [],
      target: { x: 100, y: 100 },
      roomId: "gateway",
      zoneId: "front-desk",
      variant: "capy",
      action: "work",
      actionSince: 0,
      facing: 1,
      walking: false,
      appear: 1,
      bubble: "读文件",
      bubbleUntil: 5000,
    };
    expect(frameAt(actor, 0)).toBe(0);
    expect(frameAt(actor, 1000)).toBe(6); // 6 fps
    expect(frameAt(actor, 10_000)).toBeLessThan(31); // 循环回绕
    expect(pixelBubbleVisible(actor, 4000)).toBe(true);
    expect(pixelBubbleVisible(actor, 6000)).toBe(false);
  });

  it("LO-PIXEL-12: 场景统计与非法 dt 健壮性", () => {
    const actors = [makeActor("a", "成员 · 前端编码", "working"), makeActor("b", "成员 · 检索索引", "idle")];
    let state = advancePixelScene(createPixelSceneState(0), makeSnapshot(1000, actors), 0);
    expect(pixelSceneStats(state).total).toBe(2);
    expect(pixelSceneStats(state).walking).toBe(2);
    // 到岗后
    for (const a of Object.values(state.actors)) {
      a.path = [];
      a.walking = false;
    }
    state = advancePixelScene(state, makeSnapshot(1100, actors), 100);
    const stats = pixelSceneStats(state);
    expect(stats.walking).toBe(0);
    expect(stats.idle).toBeGreaterThanOrEqual(1);

    // 非法 dt
    const s2 = advancePixelScene(state, makeSnapshot(1200, actors), NaN);
    expect(Number.isFinite(s2.actors["a"].x)).toBe(true);
    const s3 = advancePixelScene(s2, makeSnapshot(1300, actors), -100);
    expect(Number.isFinite(s3.actors["a"].x)).toBe(true);

    // 最近节点
    expect(nearestNode({ x: 0, y: 0 }).id).toBeTruthy();
    expect(PIXEL_WALK_SPEED).toBeGreaterThan(0);
  });
});
