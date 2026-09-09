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
import { CLAW_SCENE, PIXEL_ROOMS, SCENE_PRESETS, SPRITE_SHEETS, getPixelRoom, getScenePreset } from "../plugins/library-ops/data/pixel-art";
import { currentWalkNodes } from "../plugins/library-ops/core/pixel-path";
import { resolveZoneId } from "../plugins/library-ops/data/library-map";
import { generateLook } from "../plugins/library-ops/data/characters";
import { useLibraryOps } from "../plugins/library-ops/store";
import { DEFAULT_SETTINGS } from "../plugins/library-ops/types";
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

  it("LO-PIXEL-RENDER-1: 渲染默认场景图层 + 12 个房间 + 角色精灵", () => {
    const { container, unmount } = renderScene();
    const preset = getScenePreset(DEFAULT_SETTINGS.sceneImageId)!;
    const layers = container.querySelectorAll("img.lo-pixel-layer");
    expect(layers.length).toBe(preset.layers.length);
    expect([...layers].map((l) => l.getAttribute("src"))).toEqual(preset.layers);
    expect(container.querySelector(".lo-scene")!.getAttribute("data-scene-image")).toBe(preset.id);

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
    expect(utils.container.querySelectorAll(".lo-scene__hud .lo-hud-btn").length).toBe(4);
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
    // rAF 同步了动作
    expect(wrap.getAttribute("data-action")).toBe(scene.actors["p2"].action);
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-7: 缺少动作精灵表时用 CSS 程序化动效兜底（data-fallback）", async () => {
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const sprites = [...utils.container.querySelectorAll<HTMLElement>(".lo-sprite")];
    expect(sprites.length).toBe(ACTORS.length);
    const withFallback = sprites.filter((s) => s.dataset.fallback);
    // 夹具里「检索索引」角色落在 catalog-room（cat 变体），cat 没有 read 精灵表 → 回退
    expect(withFallback.length, "应存在回退帧（cat 无 read）").toBeGreaterThan(0);
    expect(withFallback.map((s) => s.dataset.fallback)).toContain("read");
    // 有专属精灵表的动作不应带 fallback
    expect(sprites.some((s) => !s.dataset.fallback)).toBe(true);
    // 朝向镜像在外层，动效在内层（互不覆盖）
    expect(utils.container.querySelector(".lo-sprite-wrap")).toBeTruthy();
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-8: 切到内置像素画 → 地板 + 家具两层，且用最近邻缩放", () => {
    useLibraryOps.getState().updateSettings({ sceneImageId: "claw" });
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const layers = [...utils.container.querySelectorAll<HTMLImageElement>("img.lo-pixel-layer")];
    expect(layers.length).toBe(2);
    expect(layers[0].getAttribute("src")).toBe(CLAW_SCENE.floor);
    expect(layers[1].getAttribute("src")).toBe(CLAW_SCENE.objects);
    expect(layers[0].className).toContain("lo-pixel-layer--pixelated");
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-9: 用户上传的图片 → 单图层渲染 + 应用微调变换", () => {
    useLibraryOps.setState({
      customScene: { url: "blob:my-scene", name: "我的图.png", width: 2752, height: 1536, size: 1234, addedAt: 1 },
    });
    useLibraryOps.getState().updateSettings({ sceneImageId: "custom", sceneImageAdjust: { scale: 1.2, x: 40, y: -20 } });
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const layers = [...utils.container.querySelectorAll<HTMLImageElement>("img.lo-pixel-layer")];
    expect(layers.length).toBe(1);
    expect(layers[0].getAttribute("src")).toBe("blob:my-scene");
    expect(layers[0].className).not.toContain("lo-pixel-layer--pixelated");
    expect(layers[0].className).toContain("lo-pixel-layer--adjusted");
    expect(layers[0].style.transform).toBe("translate(40px, -20px) scale(1.2)");
    expect(utils.container.querySelector(".lo-scene")!.getAttribute("data-scene-image")).toBe("custom");
    // 房间与角色仍在（换图不影响布局）
    expect(utils.container.querySelectorAll(".lo-pixel-room").length).toBe(12);
    expect(utils.container.querySelectorAll(".lo-sprite").length).toBe(ACTORS.length);
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-10: 把图片拖到场景上 → 交给 store 处理并显示落点提示", async () => {
    const original = useLibraryOps.getState().setCustomSceneImage;
    let dropped: File | null = null;
    useLibraryOps.setState({
      setCustomSceneImage: async (file: File) => {
        dropped = file;
        return true;
      },
    });
    try {
      const scene = settled();
      const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
      const root = utils.container.querySelector(".lo-scene") as HTMLElement;

      expect(utils.container.querySelector(".lo-scene__drop")).toBeNull();
      await act(async () => {
        fireEvent.dragOver(root, { dataTransfer: { types: ["Files"], files: [] } });
      });
      expect(root.className).toContain("is-dropping");
      expect(utils.container.querySelector(".lo-scene__drop")).toBeTruthy();
      expect(utils.container.textContent).toContain("替换场景");

      const file = new File([new Uint8Array([1, 2, 3])], "新场景.png", { type: "image/png" });
      await act(async () => {
        fireEvent.drop(root, { dataTransfer: { types: ["Files"], files: [file] } });
      });
      expect(dropped).toBe(file);
      expect(root.className).not.toContain("is-dropping");
      utils.unmount();
    } finally {
      useLibraryOps.setState({ setCustomSceneImage: original });
    }
  });

  it("LO-PIXEL-RENDER-11: 对位参考线（房间框 + 行走图）按开关渲染", () => {
    const scene = settled();
    const off = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    expect(off.container.querySelector(".lo-scene__guides")).toBeNull();
    off.unmount();

    useLibraryOps.getState().updateSettings({ showAlignGuides: true });
    const on = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const guides = on.container.querySelector(".lo-scene__guides")!;
    expect(guides).toBeTruthy();
    expect(guides.querySelectorAll("line").length).toBe(19);
    expect(guides.querySelectorAll("circle").length).toBe(20);
    on.unmount();
  });

  it("LO-PIXEL-RENDER-12: 预设清单与选择项一一对应（画廊可渲染）", () => {
    expect(SCENE_PRESETS.length).toBeGreaterThanOrEqual(2);
    for (const preset of SCENE_PRESETS) {
      expect(preset.thumb.length).toBeGreaterThan(0);
      expect(preset.layers.length).toBeGreaterThan(0);
      expect(typeof preset.commercial).toBe("boolean");
    }
    // custom 不在预设表里（它来自用户上传）
    expect(SCENE_PRESETS.some((p) => (p.id as string) === "custom")).toBe(false);
  });

  it("LO-PIXEL-RENDER-13: 对位模式渲染拖拽手柄与路网节点，HUD 按钮可切换", async () => {
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const root = utils.container.querySelector(".lo-scene") as HTMLElement;
    expect(utils.container.querySelectorAll(".lo-pixel-room__handle").length).toBe(0);
    expect(utils.container.querySelectorAll(".lo-edit-node").length).toBe(0);

    const alignBtn = utils.container.querySelector<HTMLButtonElement>('[aria-label="对位模式"]')!;
    expect(alignBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(alignBtn);
    });
    expect(useLibraryOps.getState().editingLayout).toBe(true);
    expect(root.className).toContain("is-editing-layout");
    expect(utils.container.querySelectorAll(".lo-pixel-room__handle").length).toBe(12);
    expect(utils.container.querySelectorAll(".lo-edit-node").length).toBe(20);
    expect(utils.container.querySelector(".lo-scene__edit-hint")).toBeTruthy();
    expect(utils.container.querySelector(".lo-scene__guides")).toBeTruthy();

    await act(async () => {
      fireEvent.click(alignBtn);
    });
    expect(useLibraryOps.getState().editingLayout).toBe(false);
    expect(utils.container.querySelectorAll(".lo-edit-node").length).toBe(0);
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-14: 拖动房间框 → 提交对位覆盖（房间/标签/工位一起移动）", async () => {
    useLibraryOps.getState().setEditingLayout(true);
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const room = utils.container.querySelector<HTMLElement>('[data-room-id="gateway"]')!;
    expect(room).toBeTruthy();
    const before = getPixelRoom("gateway")!;

    await act(async () => {
      fireEvent.pointerDown(room, { clientX: 0, clientY: 0 });
    });
    // 视图缩放 0.5（happy-dom 无尺寸 → 未自适应）→ 100px 客户端位移 = 200 逻辑像素
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 100, clientY: 50 });
    });
    expect(room.className).toContain("is-dragging");
    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 100, clientY: 50 });
    });

    const override = useLibraryOps.getState().layoutOverrides["ai-library-01"].rooms.gateway;
    // 100px 客户端 → 200 逻辑像素；50px → 100 × (1080/1072) ≈ 100.75
    expect(override.bounds![0]).toBe(before.bounds[0] + 200);
    expect(override.bounds![1]).toBe(before.bounds[1] + 101);
    expect(override.work!.x).toBe(before.work.x + 200);
    expect(getPixelRoom("gateway")!.bounds[0]).toBe(before.bounds[0] + 200);
    // DOM 上的房间框也跟着走了（显示坐标 = 逻辑坐标 × 1072/1080）
    const moved = utils.container.querySelector<HTMLElement>('[data-room-id="gateway"]')!;
    expect(Number.parseFloat(moved.style.left)).toBeCloseTo(before.bounds[0] + 200, 0);
    expect(Number.parseFloat(moved.style.top)).toBeCloseTo((before.bounds[1] + 101) * (1072 / 1080), 0);
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-15: 拖动路网节点 → 提交节点覆盖并重建路网", async () => {
    useLibraryOps.getState().setEditingLayout(true);
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    const node = utils.container.querySelector<HTMLElement>('[data-node-id="GW1"]')!;
    expect(node).toBeTruthy();

    await act(async () => {
      fireEvent.pointerDown(node, { clientX: 10, clientY: 10 });
    });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 10, clientY: 60 });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 10, clientY: 60 });
    });

    const moved = useLibraryOps.getState().layoutOverrides["ai-library-01"].nodes.GW1;
    expect(moved.x).toBe(860);
    expect(moved.y).toBe(711); // 50px 客户端 → 100 × (1080/1072) ≈ 100.75 → 四舍五入
    expect(currentWalkNodes().find((n) => n.id === "GW1")).toMatchObject(moved);
    utils.unmount();
  });

  it("LO-PIXEL-RENDER-16: Esc 退出对位模式，重置按钮清除对位覆盖", async () => {
    useLibraryOps.getState().setEditingLayout(true);
    useLibraryOps.getState().setNodeOverride("GW1", { x: 500, y: 500 });
    const scene = settled();
    const utils = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={scene} />);
    expect(utils.container.querySelector(".lo-edit-node")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useLibraryOps.getState().editingLayout).toBe(false);
    expect(utils.container.querySelector(".lo-edit-node")).toBeNull();

    // 重置对位（HUD 上的 ↺ 只在编辑模式出现）
    await act(async () => {
      fireEvent.click(utils.container.querySelector<HTMLButtonElement>('[aria-label="对位模式"]')!);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector<HTMLButtonElement>('[aria-label="重置对位"]')!);
    });
    expect(useLibraryOps.getState().layoutOverrides["ai-library-01"]).toBeUndefined();
    expect(currentWalkNodes().find((n) => n.id === "GW1")).toMatchObject({ x: 860, y: 610 });
    utils.unmount();
  });
});
