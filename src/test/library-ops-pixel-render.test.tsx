/**
 * LO-PIXEL-RENDER — 像素场景渲染（happy-dom 真实渲染）
 *
 * 覆盖：图层接线、12 房间、精灵表 URL / 帧偏移、角色锚点在画布内、
 * 岗位点击、HUD、资源缺失降级提示。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { PixelLibraryScene } from "../plugins/library-ops/components/library/PixelLibraryScene";
import { advancePixelScene, createPixelSceneState, stepPixelMovement } from "../plugins/library-ops/core/pixel-scene";
import { CLAW_SCENE, PIXEL_ROOMS, SPRITE_SHEETS } from "../plugins/library-ops/data/pixel-art";
import { resolveZoneId } from "../plugins/library-ops/data/library-map";
import { generateLook } from "../plugins/library-ops/data/characters";
import { useLibraryOps } from "../plugins/library-ops/store";
import type { ActorActivity, LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";

const NOW = 1_800_000_000_000;

function actor(id: string, roleLabel: string, activity: ActorActivity = "working"): LibraryActor {
  return {
    id,
    name: `角色-${id}`,
    roleLabel,
    kind: "member",
    look: generateLook(id, roleLabel),
    activity,
    statusLabel: "执行中",
    focus: `任务 ${id}`,
    lastEventAt: NOW,
    metrics: { tasks: 1, done: 0, failed: 0, tools: 1, tokens: 0, cost: 0, errors: 0 },
    preferredZoneId: resolveZoneId(roleLabel),
  };
}

const ACTORS = [
  actor("p1", "队长 · 调度台", "thinking"),
  actor("p2", "成员 · 前端实现", "working"),
  actor("p3", "成员 · 研究分析", "reading"),
  actor("p4", "成员 · 检索索引", "searching"),
  actor("p5", "成员 · 文档写作", "writing"),
  actor("p6", "成员 · 运维部署", "error"),
];

function snapshot(at: number): LibrarySnapshot {
  return {
    at,
    actors: ACTORS,
    teams: [],
    metrics: {
      sessions: 1, activeSessions: 1, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: ACTORS.length, actorsWorking: 4, actorsIdle: 0,
      actorsBlocked: 0, actorsError: 1, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0,
      costToday: 0, toolCalls: 0, toolErrors: 0, filesTouched: 0, messages: 0, health: 1,
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

/** 确定性「已到岗」场景 */
function settled() {
  let state = createPixelSceneState(NOW);
  let t = NOW;
  for (let i = 0; i < 900; i++) {
    t += 100;
    state = advancePixelScene(state, snapshot(t), 100);
    for (const a of Object.values(state.actors)) stepPixelMovement(a, 100);
  }
  return state;
}

function renderScene() {
  const scene = settled();
  const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
  return { ...utils, scene };
}

describe("LO-PIXEL-RENDER 像素场景渲染", () => {
  beforeEach(() => {
    cleanup();
    useLibraryOps.getState()._reset();
  });

  it("LO-PIXEL-RENDER-1: 渲染 2 个图层 + 12 个房间 + 角色精灵", () => {
    const { container, unmount } = renderScene();
    const layers = container.querySelectorAll("img.lo-pixel-layer");
    expect(layers.length).toBe(2);
    expect((layers[0] as HTMLImageElement).getAttribute("src")).toBe(CLAW_SCENE.floor);
    expect((layers[1] as HTMLImageElement).getAttribute("src")).toBe(CLAW_SCENE.objects);

    const rooms = container.querySelectorAll(".lo-pixel-room");
    expect(rooms.length).toBe(PIXEL_ROOMS.length);
    expect(rooms.length).toBe(12);

    expect(container.querySelectorAll(".lo-sprite").length).toBe(ACTORS.length);
    unmount();
  });

  it("LO-PIXEL-RENDER-2: 每个精灵接线到正确的角色变体/动作精灵表，且帧偏移在表内", () => {
    const { container, unmount, scene } = renderScene();
    const wraps = [...container.querySelectorAll<HTMLElement>(".lo-pixel-actor")];
    expect(wraps.length).toBe(ACTORS.length);
    for (const wrap of wraps) {
      const id = wrap.getAttribute("data-actor-id")!;
      const a = scene.actors[id];
      const sprite = wrap.querySelector<HTMLElement>(".lo-sprite")!;
      const url = sprite.style.backgroundImage;
      expect(url, `${id} 无精灵表`).toContain("/library-ops/claw-library/actors/");
      expect(url).toContain(`/actors/${a.variant}/`);
      // background-size = 列数 × 帧宽 × 缩放；background-position 必须落在表内
      const bgSize = /background-size:\s*([\d.]+)px\s+([\d.]+)px/.exec(sprite.getAttribute("style") ?? "");
      expect(bgSize, `${id} 缺少 background-size`).toBeTruthy();
      const sheet = SPRITE_SHEETS[a.variant][a.action] ?? SPRITE_SHEETS[a.variant].stand_front!;
      const scale = 118 / sheet.frameWidth;
      expect(Number(bgSize![1])).toBeCloseTo(sheet.columns * sheet.frameWidth * scale, 1);
      const pos = /background-position:\s*(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(sprite.getAttribute("style") ?? "");
      if (pos) {
        expect(Math.abs(Number(pos[1]))).toBeLessThanOrEqual(Number(bgSize![1]) + 1);
        expect(Math.abs(Number(pos[2]))).toBeLessThanOrEqual(Number(bgSize![2]) + 1);
      }
    }
    unmount();
  });

  it("LO-PIXEL-RENDER-3: 角色锚点在画布范围内，且落在自己房间的包围盒内", () => {
    const { container, unmount, scene } = renderScene();
    const boxes = new Map(PIXEL_ROOMS.map((r) => [r.id, r.bounds]));
    const wraps = [...container.querySelectorAll<HTMLElement>(".lo-pixel-actor")];
    for (const wrap of wraps) {
      const id = wrap.getAttribute("data-actor-id")!;
      const a = scene.actors[id];
      const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(wrap.style.transform)!;
      const x = Number(m[1]);
      const y = Number(m[2]);
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(CLAW_SCENE.displayWidth);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(CLAW_SCENE.displayHeight);
      const box = boxes.get(a.roomId)!;
      expect(x, `${id} x 在房间 ${a.roomId} 内`).toBeGreaterThanOrEqual(box[0] - 8);
      expect(x, `${id} x 在房间 ${a.roomId} 内`).toBeLessThanOrEqual(box[0] + box[2] + 8);
      expect(y, `${id} y 在房间 ${a.roomId} 内`).toBeGreaterThanOrEqual(box[1] - 8);
      expect(y, `${id} y 在房间 ${a.roomId} 内`).toBeLessThanOrEqual(box[1] + box[3] + 8);
    }
    unmount();
  });

  it("LO-PIXEL-RENDER-4: 点击房间 → 选中对应岗位；HUD 三个按钮", async () => {
    const selectZone = (id: string) => useLibraryOps.getState().selectZone(id);
    const scene = settled();
    const utils = render(
      <PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} onSelectZone={selectZone} />,
    );
    const room = utils.container.querySelector(".lo-pixel-room") as HTMLElement;
    await act(async () => {
      fireEvent.click(room);
    });
    // 点击第一个房间（gateway）→ 选中 front-desk
    expect(useLibraryOps.getState().selectedZoneId).toBe("front-desk");
    expect(utils.container.querySelectorAll(".lo-scene__hud .lo-hud-btn").length).toBe(3);
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-5: 资源加载失败 → 显示降级提示（提示切到等距风格）", () => {
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const img = utils.container.querySelector("img.lo-pixel-layer") as HTMLImageElement;
    expect(img).toBeTruthy();
    act(() => {
      fireEvent.error(img);
    });
    expect(utils.container.querySelector(".lo-scene--asset-error")).toBeTruthy();
    expect(utils.container.textContent).toContain("等距矢量");
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-6: 选中角色时高亮类落位，气泡按 data-bubble 控制", async () => {
    useLibraryOps.getState().selectActor("p2");
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const wrap = utils.container.querySelector('[data-actor-id="p2"]')!;
    expect(wrap.className).toContain("is-selected");
    expect(wrap.getAttribute("data-bubble")).toMatch(/^[01]$/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    // rAF 同步了动作与帧
    expect(wrap.getAttribute("data-action")).toBe(scene.actors["p2"].action);
    utils.unmount();
  });
});
