/**
 * LO-RENDER — 场景渲染的几何正确性（在 happy-dom 里真实渲染 + 结构断言）
 *
 * 这是「场景到底画对了没有」的门禁：用与运行时完全相同的推进循环
 * （advanceScene + stepActorMovement）得到「已到岗」的确定性场景，渲染后断言：
 * - LO-RENDER-1 区域多边形 = 区域矩形角点投影（数量/顶点数/包围盒）
 * - LO-RENDER-2 每个角色都落在**自己岗位**的等距包围盒内（不越界到走廊/别岗位）
 * - LO-RENDER-3 家具按类型全部渲染（8 类）
 * - LO-RENDER-4 网格线数量 = (cols+1)+(rows+1)，窗户/墙存在
 * - LO-RENDER-5 样式无 NaN / undefined 泄漏
 * - LO-RENDER-6 角色动画属性由 rAF 同步（data-anim 与场景态一致）
 */
import { describe, it, expect } from "vitest";
import { render, act } from "@testing-library/react";
import { LibraryScene } from "../plugins/library-ops/components/library/LibraryScene";
import { blockPoints, CANVAS_H, CANVAS_W, tileCenter } from "../plugins/library-ops/components/library/iso";
import { LIBRARY_MAP } from "../plugins/library-ops/data/library-map";
import { advanceScene, createSceneState, stepActorMovement } from "../plugins/library-ops/core/scene-engine";
import { generateLook } from "../plugins/library-ops/data/characters";
import { resolveZoneId } from "../plugins/library-ops/data/library-map";
import { useLibraryOps } from "../plugins/library-ops/store";
import type { LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";

const NOW = 1_800_000_000_000;

function makeActor(id: string, roleLabel: string): LibraryActor {
  return {
    id,
    name: `角色-${id}`,
    roleLabel,
    kind: "member",
    look: generateLook(id, roleLabel),
    activity: "working",
    statusLabel: "执行中",
    focus: `任务 ${id}`,
    lastEventAt: NOW,
    metrics: { tasks: 1, done: 0, failed: 0, tools: 1, tokens: 0, cost: 0, errors: 0 },
    preferredZoneId: resolveZoneId(roleLabel),
  };
}

const ACTORS: LibraryActor[] = [
  makeActor("a1", "队长 · 调度台"),
  makeActor("a2", "成员 · 前端实现"),
  makeActor("a3", "成员 · 研究分析"),
  makeActor("a4", "成员 · 检索索引"),
  makeActor("a5", "成员 · 文档写作"),
  makeActor("a6", "成员 · 记忆归档"),
  makeActor("a7", "成员 · 运维部署"),
  makeActor("a8", "成员 · 协作沟通"),
  makeActor("a9", "成员 · 交付汇总"),
  makeActor("a10", "成员 · 空闲待命"),
];

function makeSnapshot(at: number): LibrarySnapshot {
  return {
    at,
    actors: ACTORS,
    teams: [],
    metrics: {
      sessions: 1, activeSessions: 1, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: ACTORS.length, actorsWorking: ACTORS.length,
      actorsIdle: 0, actorsBlocked: 0, actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0,
      costTotal: 0, costToday: 0, toolCalls: 0, toolErrors: 0, filesTouched: 0, messages: 0, health: 1,
    },
    events: [],
    activity: { perDay: {}, perHour: new Array(24).fill(0), kinds: {} },
    sources: {
      sessions: 1, activeSessions: 1, teams: 0, teamMembers: 0, subagents: 0,
      teamTemplates: 0, agentProfiles: 0, telemetryEvents: 0, failed: [],
    },
    sampleMs: 0,
  };
}

/** 跑与运行时相同的循环，得到「角色已到岗」的确定性场景态 */
function settledScene() {
  let state = createSceneState(NOW);
  let t = NOW;
  for (let i = 0; i < 600; i++) {
    t += 100;
    state = advanceScene(state, makeSnapshot(t), 100);
    for (const a of Object.values(state.actors)) stepActorMovement(a, 100);
  }
  return state;
}

function parsePoints(s: string): Array<{ x: number; y: number }> {
  return s.trim().split(/\s+/).map((p) => {
    const [x, y] = p.split(",").map(Number);
    return { x, y };
  });
}

function renderScene() {
  const scene = settledScene();
  const utils = render(<LibraryScene snapshot={makeSnapshot(NOW + 100_000)} initialScene={scene} />);
  return { ...utils, scene };
}

describe("LO-RENDER 场景渲染几何", () => {
  it("LO-RENDER-1: 渲染 10 个区域，每个多边形 4 个顶点且与区域矩形角点一致", () => {
    const { container, unmount } = renderScene();
    const zones = container.querySelectorAll("g.lo-zone[data-zone-id]");
    expect(zones.length).toBe(LIBRARY_MAP.zones.length);

    for (const g of zones) {
      const id = g.getAttribute("data-zone-id")!;
      const zone = LIBRARY_MAP.zones.find((z) => z.id === id)!;
      const poly = g.querySelector("polygon")!;
      const pts = parsePoints(poly.getAttribute("points")!);
      expect(pts.length, `${id} 顶点数`).toBe(4);
      const expected = parsePoints(blockPoints(zone.rect));
      for (let i = 0; i < 4; i++) {
        expect(pts[i].x, `${id} 顶点${i}.x`).toBeCloseTo(expected[i].x, 0);
        expect(pts[i].y, `${id} 顶点${i}.y`).toBeCloseTo(expected[i].y, 0);
      }
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(-2);
        expect(p.x).toBeLessThanOrEqual(CANVAS_W + 2);
        expect(p.y).toBeGreaterThanOrEqual(-2);
        expect(p.y).toBeLessThanOrEqual(CANVAS_H + 2);
      }
    }
    unmount();
  });

  it("LO-RENDER-2: 每个角色都落在自己岗位的等距包围盒内（已到岗状态）", () => {
    const { container, unmount, scene } = renderScene();
    const wraps = [...container.querySelectorAll<HTMLElement>(".lo-actor-wrap")];
    expect(wraps.length).toBe(ACTORS.length);

    const boxes = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (const zone of LIBRARY_MAP.zones) {
      const pts = parsePoints(blockPoints(zone.rect));
      boxes.set(zone.id, {
        minX: Math.min(...pts.map((p) => p.x)),
        maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)),
        maxY: Math.max(...pts.map((p) => p.y)),
      });
    }

    for (const wrap of wraps) {
      const id = wrap.getAttribute("data-actor-id")!;
      const actor = ACTORS.find((a) => a.id === id)!;
      const sceneActor = scene.actors[id];
      expect(sceneActor, `${id} 应在场景态中`).toBeTruthy();
      const expected = tileCenter(sceneActor.col, sceneActor.row);
      const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(wrap.style.transform)!;
      const x = Number(m[1]);
      const y = Number(m[2]);
      expect(Number.isFinite(x) && Number.isFinite(y), `${id} 坐标应为有限数`).toBe(true);
      expect(x).toBeCloseTo(expected.x, 0);
      expect(y).toBeCloseTo(expected.y, 0);

      const box = boxes.get(actor.preferredZoneId)!;
      expect(x, `${id} x 在 ${actor.preferredZoneId} 内`).toBeGreaterThanOrEqual(box.minX - 2);
      expect(x, `${id} x 在 ${actor.preferredZoneId} 内`).toBeLessThanOrEqual(box.maxX + 2);
      expect(y, `${id} y 在 ${actor.preferredZoneId} 内`).toBeGreaterThanOrEqual(box.minY - 2);
      expect(y, `${id} y 在 ${actor.preferredZoneId} 内`).toBeLessThanOrEqual(box.maxY + 2);
    }
    unmount();
  });

  it("LO-RENDER-3: 家具按 8 种类型全部渲染，且每个家具三面齐全", () => {
    const { container, unmount } = renderScene();
    const fx = [...container.querySelectorAll(".lo-fx")];
    expect(fx.length).toBe(LIBRARY_MAP.decor.length);
    const kinds = new Set(fx.map((el) => [...el.classList].find((c) => c.startsWith("lo-fx--"))));
    expect([...kinds].sort()).toEqual(
      ["lo-fx--bookshelf", "lo-fx--carpet", "lo-fx--counter", "lo-fx--lamp", "lo-fx--plant", "lo-fx--stairs", "lo-fx--table", "lo-fx--terminal"].sort(),
    );
    // 有体积的家具（非地毯/台灯）必须有 top/east/south 三面
    const volumetric = fx.filter((el) => !el.classList.contains("lo-fx--carpet") && !el.classList.contains("lo-fx--lamp"));
    expect(volumetric.length).toBeGreaterThan(20);
    for (const el of volumetric) {
      expect(el.querySelectorAll(".lo-fx-face--top").length, "顶面").toBe(1);
      expect(el.querySelectorAll(".lo-fx-face--east").length, "东面").toBe(1);
      expect(el.querySelectorAll(".lo-fx-face--south").length, "南面").toBe(1);
    }
    unmount();
  });

  it("LO-RENDER-4: 网格线数量正确，墙与窗渲染，HUD 三个按钮", () => {
    const { container, unmount } = renderScene();
    const lines = container.querySelectorAll(".lo-grid line");
    expect(lines.length).toBe(LIBRARY_MAP.cols + 1 + LIBRARY_MAP.rows + 1);
    expect(container.querySelectorAll(".lo-wall").length).toBe(2);
    expect(container.querySelectorAll(".lo-wall-window").length).toBe(5);
    expect(container.querySelectorAll(".lo-scene__hud .lo-hud-btn").length).toBe(3);
    expect(container.querySelectorAll(".lo-zone__label").length).toBe(LIBRARY_MAP.zones.length);
    unmount();
  });

  it("LO-RENDER-5: 渲染结果无 NaN / undefined 泄漏", () => {
    const { container, unmount } = renderScene();
    const html = container.innerHTML;
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
    unmount();
  });

  it("LO-RENDER-6: rAF 把场景动画态同步到角色 SVG（data-anim 与场景态一致）", async () => {
    const scene = settledScene();
    const utils = render(<LibraryScene snapshot={makeSnapshot(NOW + 100_000)} initialScene={scene} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const wraps = [...utils.container.querySelectorAll<HTMLElement>(".lo-actor-wrap")];
    expect(wraps.length).toBeGreaterThan(0);
    for (const wrap of wraps) {
      const id = wrap.getAttribute("data-actor-id")!;
      const svg = wrap.querySelector("svg.lo-actor")!;
      expect(svg.getAttribute("data-anim"), `${id} data-anim`).toBe(scene.actors[id].anim);
      expect(wrap.getAttribute("data-bubble")).toMatch(/^[01]$/);
      expect(wrap.style.getPropertyValue("--lo-facing")).toMatch(/^-?1$/);
    }
    utils.unmount();
  });

  it("LO-RENDER-7: 选中角色 / 岗位时高亮类正确落位", () => {
    const scene = settledScene();
    useLibraryOps.getState().selectActor("a2");
    useLibraryOps.getState().selectZone("code-forge");
    const utils = render(<LibraryScene snapshot={makeSnapshot(NOW + 100_000)} initialScene={scene} />);
    expect(utils.container.querySelector('[data-actor-id="a2"]')!.className).toContain("is-selected");
    expect(utils.container.querySelector('[data-zone-id="code-forge"]')!.className).toContain("is-selected");
    useLibraryOps.getState().selectActor(null);
    useLibraryOps.getState().selectZone(null);
    utils.unmount();
  });
});
