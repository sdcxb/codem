/**
 * LO-HITAREA —— 像素场景「命中归属」回归（**判据分层，别把弱判据当强判据**）
 *
 * 背景（真机 1.16.112 实测，任务中心 → 子智能体 → 场景）：12 个 `.lo-pixel-room` 热区
 * 各取 9×9+中心 = 82 点网格采样，「命中自己」占比**全是 0**，全部落在整块画布大小的
 * `div.lo-pixel-actors` 上 —— 那一层 `background-color: rgba(0,0,0,0)`、`background-image: none`、
 * 自己也没有 onClick（真正的 onClick 在 `.lo-pixel-actor` 上），却把房间热区整块吃掉；
 * 同时因为 `.lo-actor-wrap` 是 0×0 锚点、精灵/名牌都 `pointer-events: none`，
 * 「点角色选中该智能体」这条已接线的交互在真机上也是**死的**。
 *
 * 判据分层：
 *  - **强判据（几何 / 命中归属）**：真机 CDP 脚本
 *    `.preview-shot/audit-loroom-01-measure.mjs`（改前）与 `.preview-shot/audit-loroom-02-after.mjs`
 *    （改后：把同一份 CSS 规则注入运行中的页面后复量）。它们量 `getBoundingClientRect` +
 *    `elementFromPoint` + `document.elementsFromPoint`（完整命中栈 + 逐层背景不透明度）+
 *    有效可见矩形（overflow≠visible 祖先 ∩ 视口）。**happy-dom 不做布局、也没有真实命中测试**
 *    （`elementFromPoint` 不可用），所以这一层在单测里根本测不了，只能由真机脚本承担。
 *  - **弱判据（本文件）**：① 声明判据 —— 那两条 pointer-events 声明在不在样式表里；
 *    ② 结构判据 —— 「可点的是精灵本体，不是整块角色层容器」的接线位置；
 *    ③ 行为判据 —— 房间点击是否真的接到了岗位选择（这层 happy-dom 能真测）。
 *    ①② 只能证明"声明/接线在"，**不能**证明真机上命中归属正确。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PixelLibraryScene } from "../plugins/library-ops/components/library/PixelLibraryScene";
import { LibraryPanel } from "../plugins/library-ops/components/monitor/LibraryPanel";
import { advancePixelScene, createPixelSceneState, stepPixelMovement } from "../plugins/library-ops/core/pixel-scene";
import { PIXEL_ROOMS, ZONE_TO_ROOM } from "../plugins/library-ops/data/pixel-art";
import { LIBRARY_MAP, resolveZoneId } from "../plugins/library-ops/data/library-map";
import { generateLook } from "../plugins/library-ops/data/characters";
import { useLibraryOps } from "../plugins/library-ops/store";
import type { ActorActivity, LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";

const root = join(__dirname, "..");
const cssText = readFileSync(join(root, "plugins/library-ops/styles/library-ops.css"), "utf8");

/** 抽出某个选择器**独立规则块**的声明（行首锚定：避免命中 `.lo-pixel-actor .lo-actor-name` 这类后代规则） */
function declsOf(selector: string): string[] | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("^" + esc + "\\s*\\{([^}]*)\\}", "m").exec(cssText);
  if (!m) return null;
  return m[1].split(";").map((s) => s.trim()).filter(Boolean);
}

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
  actor("p2", "成员 · 前端实现"),
  actor("p3", "成员 · 研究分析", "reading"),
];

function snapshot(at: number): LibrarySnapshot {
  return {
    at,
    actors: ACTORS,
    teams: [],
    metrics: {
      sessions: 1, activeSessions: 1, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: ACTORS.length, actorsWorking: 2, actorsIdle: 0,
      actorsBlocked: 0, actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0,
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

describe("LO-HITAREA 像素房间命中归属", () => {
  beforeEach(() => {
    cleanup();
    useLibraryOps.getState()._reset();
  });

  it("LO-HITAREA-1（弱判据·声明）：角色层容器不接收命中，可点的是精灵本体", () => {
    const layer = declsOf(".lo-pixel-actors");
    expect(layer, "样式表里必须能找到 .lo-pixel-actors 规则").toBeTruthy();
    expect(layer!.join(";")).toContain("pointer-events: none");

    const sprite = declsOf(".lo-pixel-actor .lo-sprite");
    expect(sprite, "样式表里必须能找到 .lo-pixel-actor .lo-sprite 规则").toBeTruthy();
    expect(sprite!.join(";")).toContain("pointer-events: auto");

    // 反向守卫：任何一条再声明 .lo-pixel-actors 的规则都不得把命中重新打开
    const all = [...cssText.matchAll(/\.lo-pixel-actors[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(all.length).toBeGreaterThan(0);
    for (const body of all) expect(body).not.toMatch(/pointer-events:\s*(auto|all)/);
    // 命中区只有"精灵方块"这一块：外层包裹（0×0 锚点）与名牌/气泡都保持不可点，
    // 免得把命中区从"精灵"扩成"整块容器"（那又会反过来吃掉房间热区）。
    expect((declsOf(".lo-sprite-wrap") ?? []).join(";")).toContain("pointer-events: none");
    expect((declsOf(".lo-actor-name") ?? []).join(";")).toContain("pointer-events: none");
    expect((declsOf(".lo-actor-bubble") ?? []).join(";")).toContain("pointer-events: none");
  });

  it("LO-HITAREA-2（弱判据·结构）：容器没有行为、精灵才接到 onSelectActor", async () => {
    const picked: string[] = [];
    const zones: string[] = [];
    const { container, unmount } = render(
      <PixelLibraryScene
        snapshot={snapshot(NOW + 100_000)}
        initialScene={settled()}
        onSelectActor={(id) => picked.push(id)}
        onSelectZone={(id) => zones.push(id)}
      />,
    );
    const layer = container.querySelector(".lo-pixel-actors") as HTMLElement;
    expect(layer).toBeTruthy();
    // 点容器本身：不该有任何行为（它只是定位层）
    await act(async () => {
      fireEvent.click(layer);
    });
    expect(picked).toEqual([]);
    expect(zones).toEqual([]);

    // 点精灵本体：冒泡到 .lo-actor-wrap 的 onClick → 选中该角色
    const sprite = container.querySelector(".lo-sprite") as HTMLElement;
    const actorId = sprite.closest(".lo-pixel-actor")!.getAttribute("data-actor-id")!;
    await act(async () => {
      fireEvent.click(sprite);
    });
    expect(picked).toEqual([actorId]);
    // 精灵不是房间的后代 → 选中角色不会顺带选中岗位，也不会冒泡给别的层
    expect(zones).toEqual([]);
    unmount();
  });

  it("LO-HITAREA-3（行为判据）：房间热区真的接到岗位选择；角色点击接到角色选择", async () => {
    const { container, unmount } = render(<LibraryPanel snapshot={snapshot(NOW + 100_000)} zh />);
    // 空态文案声明了「点击场景中的角色或岗位查看详情」——这条交互必须真的成立
    expect(container.textContent).toContain("点击场景中的角色或岗位查看详情");

    const room = container.querySelector(".lo-pixel-room") as HTMLElement;
    expect(room, "场景必须渲染房间热区").toBeTruthy();
    expect(room.getAttribute("role")).toBe("button");
    await act(async () => {
      fireEvent.click(room);
    });
    // 第一个房间是 gateway → 岗位 front-desk；侧栏「角色详情」卡切到岗位信息
    expect(useLibraryOps.getState().selectedZoneId).toBe("front-desk");
    expect(container.textContent).not.toContain("点击场景中的角色或岗位查看详情");
    expect(container.textContent).toContain("取消选中岗位");

    // 角色：点精灵本体 → 选中该角色
    const sprite = container.querySelector(".lo-sprite") as HTMLElement;
    const actorId = sprite.closest(".lo-pixel-actor")!.getAttribute("data-actor-id")!;
    await act(async () => {
      fireEvent.click(sprite);
    });
    expect(useLibraryOps.getState().selectedActorId).toBe(actorId);
    unmount();
  });

  it("LO-HITAREA-4（行为判据）：岗位侧栏列表是场景热区的兜底入口（同房间多岗位也能选中）", async () => {
    const { container, unmount } = render(<LibraryPanel snapshot={snapshot(NOW + 100_000)} zh />);
    const items = [...container.querySelectorAll(".lo-zones__item")];
    expect(items.length).toBe(LIBRARY_MAP.zones.length);

    // gateway / task_queues 共用同一块 bounds（同一个房间、两个岗位），场景里靠后的那个
    // 热区永远在上层 → 另一个岗位在场景里点不到；侧栏列表必须仍是它的入口。
    const gateway = PIXEL_ROOMS.find((r) => r.id === "gateway")!;
    const checkout = PIXEL_ROOMS.find((r) => r.id === "task_queues")!;
    expect(checkout.bounds).toEqual(gateway.bounds);

    const frontDesk = LIBRARY_MAP.zones.find((z) => z.id === "front-desk")!;
    const target = items.find((el) => (el.textContent ?? "").includes(frontDesk.name))!;
    expect(target, "岗位分布列表里应有「前台 · 调度台」").toBeTruthy();
    await act(async () => {
      fireEvent.click(target);
    });
    expect(useLibraryOps.getState().selectedZoneId).toBe("front-desk");
    unmount();
  });

  it("LO-HITAREA-5（弱判据·声明）：同 bounds 的两个岗位热区靠「外层关命中 + 内层条带接管」分开", () => {
    // 外层关掉命中（否则 DOM 靠后的那个把整块吃掉），内层重新打开（祖先 none 不挡后代自取）
    const split = declsOf(".lo-pixel-room.is-hit-split");
    expect(split, "样式表里必须能找到 .lo-pixel-room.is-hit-split 规则").toBeTruthy();
    expect(split!.join(";")).toContain("pointer-events: none");

    const hit = declsOf(".lo-pixel-room__hit");
    expect(hit, "样式表里必须能找到 .lo-pixel-room__hit 规则").toBeTruthy();
    expect(hit!.join(";")).toContain("pointer-events: auto");
    expect(hit!.join(";")).toContain("position: absolute");

    // 反向守卫：① 房间框自身的规则不许声明 pointer-events（否则会盖过 .is-hit-split 的 none）；
    // ② 全项目里"给 lo-pixel-room 重新打开命中"的规则**只有** __hit 这一条。
    expect((declsOf(".lo-pixel-room") ?? []).join(";")).not.toContain("pointer-events");
    const reopen = [...cssText.matchAll(/\.lo-pixel-room[^{]*\{[^}]*pointer-events:\s*(?:auto|all)/g)].map((m) =>
      m[0].split("{")[0].trim(),
    );
    expect(reopen).toEqual([".lo-pixel-room__hit"]);
  });

  it("LO-HITAREA-6（结构判据）：共用 bounds 的两间各自渲染出**互不重叠**的命中条带，且都接到岗位选择", async () => {
    const zones: string[] = [];
    const { container, unmount } = render(
      <PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={settled()} onSelectZone={(id) => zones.push(id)} />,
    );
    const room = (id: string) => container.querySelector(`.lo-pixel-room[data-room-id="${id}"]`) as HTMLElement;
    const gw = room("gateway");
    const tq = room("task_queues");
    expect(gw && tq, "两间都必须渲染").toBeTruthy();
    expect(gw.className).toContain("is-hit-split");
    expect(tq.className).toContain("is-hit-split");
    // 视觉（房间框本身）不变：两间的 bounds 仍然逐像素相同 → 内联 left/top/width/height 一致
    expect([gw.style.left, gw.style.top, gw.style.width, gw.style.height]).toEqual([
      tq.style.left,
      tq.style.top,
      tq.style.width,
      tq.style.height,
    ]);

    const gh = gw.querySelector(".lo-pixel-room__hit") as HTMLElement;
    const th = tq.querySelector(".lo-pixel-room__hit") as HTMLElement;
    expect(gh && th, "两间各有一个命中条带子层").toBeTruthy();
    // 条带在房间内的位置：gateway 占上半（top 偏移 0），task_queues 从分界线开始（>0）
    expect(parseFloat(gh.style.top)).toBeCloseTo(0, 6);
    expect(parseFloat(th.style.top)).toBeGreaterThan(0);
    // 两块拼回整块房间高度（happy-dom 不做布局，这里只能比"模型给的几何"；
    // style 值经 logicToDisplay 换算后被序列化成字符串，容差按 1e-3 给）
    expect(parseFloat(gh.style.height) + parseFloat(th.style.height)).toBeCloseTo(parseFloat(gw.style.height), 2);
    // data-hit-band = 条带在逻辑坐标里的 [y, h]，供真机脚本核对注入/DOM 与源码一致
    // （原框 y=320 h=300，分界线取两锚点 400/434 的中点 417 → 上条 97、下条 203）
    expect(gw.dataset.hitBand).toBe("320,97");
    expect(tq.dataset.hitBand).toBe("417,203");

    // 点条带 → 冒泡到房间自己的 onClick → 选中**各自的**岗位（改前 gateway 这条永远走不到）
    await act(async () => {
      fireEvent.click(th);
    });
    expect(zones).toEqual(["checkout"]);
    await act(async () => {
      fireEvent.click(gh);
    });
    expect(zones).toEqual(["checkout", "front-desk"]);

    // 点整块房间（DOM 直接派发，与真机无关）仍然是"这间自己的岗位"—— 既有行为不回退
    await act(async () => {
      fireEvent.click(tq);
    });
    expect(zones).toEqual(["checkout", "front-desk", "checkout"]);
    unmount();
  });

  it("LO-HITAREA-7（结构判据）：对位模式下不切分（房间框要整块可拖）", async () => {
    const { container, unmount } = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={settled()} />);
    await act(async () => {
      useLibraryOps.getState().setEditingLayout(true);
    });
    expect(container.querySelectorAll(".lo-pixel-room__hit").length).toBe(0);
    for (const el of container.querySelectorAll(".lo-pixel-room")) expect(el.className).not.toContain("is-hit-split");
    await act(async () => {
      useLibraryOps.getState().setEditingLayout(false);
    });
    expect(container.querySelectorAll(".lo-pixel-room__hit").length).toBe(2); // 只有共用 bounds 的那两间
    unmount();
  });

  /**
   * LO-HITAREA-8（行为判据·指针捕获时机）：真机上"点房间没反应"的直接机制是
   * `.lo-scene` 在 **pointerdown 里就 setPointerCapture**，于是同一次手势的 pointerup/mouseup/click
   * 被改派到 `.lo-scene`（真机事件链：pointerdown→room → gotpointercapture→.lo-scene → click→.lo-scene）。
   * 这条在 happy-dom 里**测不到"改派"本身**（它不做真实命中/捕获重定向），只能测到
   * "只在真正开始拖拽（移动 > 2px）时才取捕获"这个**结构性时机**；
   * 真机上的命中归属与点击结果由 `.preview-shot/audit-loroom2-00-clickpath.mjs` 承担。
   */
  /**
   * LO-HITAREA-9（行为判据·高亮归属）：选中岗位后，场景里高亮的必须是**该岗位所属的房间**。
   * 原实现是 `roomOfZone(room.id)`（把房间 id 当岗位 id 传），`roomOfZone` 未知回退 gateway ⇒
   * 只有渲染 gateway 那一间时才自等，于是"选中任何岗位都只高亮 gateway"。
   * 真机实测（1.16.113，任务中心 → 子智能体 → 场景，点 task_queues 条带选中「借还台 · 交付」后）：
   * `.lo-pixel-room.is-selected` = `gateway`，而侧栏选中项是「借还台 · 交付」—— 见
   * `.preview-shot/audit-loroom2-after.json` 的 `clicks.patchedTaskQueuesBand`。
   */
  it("LO-HITAREA-9（行为判据）：高亮跟着选中岗位走，不再永远落在 gateway 上", async () => {
    const { container, unmount } = render(
      <PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={settled()} onSelectZone={() => {}} />,
    );
    const selected = () => [...container.querySelectorAll(".lo-pixel-room.is-selected")].map((e) => e.dataset.roomId);
    const selectZone = (id: string | null) =>
      act(async () => {
        useLibraryOps.getState().selectZone(id);
      });
    await selectZone("checkout");
    expect(selected()).toEqual(["task_queues"]);
    await selectZone("front-desk");
    expect(selected()).toEqual(["gateway"]);
    await selectZone("reading-hall");
    expect(selected()).toEqual(["memory"]);
    await selectZone(null);
    expect(selected()).toEqual([]);
    unmount();
  });

  /**
   * LO-HITAREA-10（行为判据·装饰性房间）：**没有岗位的房间不许可点**。
   *
   * ## 真机背景（1.16.114 装机版复量抓到的缺陷）
   *
   * `PIXEL_ROOMS` 有 **12** 间房，`ZONE_TO_ROOM` 只有 **10** 个岗位 ——
   * `alarm`（报警台）与 `schedule`（调度台）是上游地图里有、本插件**不承载岗位**的房间。
   * 原实现里 12 间房一律 `onClick={() => onSelectZone?.(zoneOfRoom(room.id))}`，
   * 而 `zoneOfRoom` 对未知房间回退成**房间 id 本身** ⇒ 点「报警台」把 `selectedZoneId`
   * 设成不存在的 `"alarm"`，再经 `roomOfZone("alarm")` 的未知回退 gateway
   * 高亮成「前台 · 调度台」—— 真机表现就是**点报警台、亮前台**；
   * 同时它们带着 `role="button" + tabIndex=0 + cursor:pointer`，看起来可点。
   *
   * 判据（行为层，happy-dom 能真测）：
   *  ① 有岗位的房间：`data-has-zone="1"` + `role=button`，点了 store 里就是**它那个岗位**；
   *  ② 没有岗位的房间：没有 `role`、没有 `tabIndex`、点了 store **什么都不该变**；
   *  ③ 控制组：先确认"确实存在没有岗位的房间"（否则本用例测了个空）。
   */
  it("LO-HITAREA-10（行为判据）：装饰性房间（报警台/调度台）不可点，也不许注入不存在的岗位 id", async () => {
    const zoneRoomIds = new Set(Object.values(ZONE_TO_ROOM));
    const decorRooms = PIXEL_ROOMS.filter((r) => !zoneRoomIds.has(r.id));
    // ③ 控制组：这条判据必须真的有对象（环境变了要立刻知道）
    expect(decorRooms.map((r) => r.id).sort(), "本用例的前提是存在没有岗位的房间").toEqual(["alarm", "schedule"]);
    expect(zoneRoomIds.size, "有岗位的房间数").toBe(10);

    const { container, unmount } = render(<LibraryPanel snapshot={snapshot(NOW + 100_000)} zh />);
    act(() => {
      useLibraryOps.getState().selectZone(null);
    });

    for (const r of decorRooms) {
      const el = container.querySelector(`.lo-pixel-room[data-room-id="${r.id}"]`) as HTMLElement;
      expect(el, `${r.id} 必须渲染`).toBeTruthy();
      expect(el.dataset.hasZone, `${r.id} 没有岗位，必须标成 is-decor`).toBe("0");
      expect(el.className).toContain("is-decor");
      expect(el.getAttribute("role"), "没有行为的房间不该有 button 语义").toBeNull();
      expect(el.tabIndex, "没有行为的房间不该进 Tab 序").toBe(-1);
      await act(async () => {
        fireEvent.click(el);
      });
      expect(useLibraryOps.getState().selectedZoneId, `点 ${r.id} 不该选中任何岗位（改动前会选中 "alarm"）`).toBeNull();
      expect(container.querySelectorAll(".lo-pixel-room.is-selected").length, "也不该高亮任何房间").toBe(0);
    }

    // ① 反向守卫：有岗位的房间仍然必须可点、且点谁选谁（别把修法做成"全部关掉"）
    for (const roomId of ["gateway", "task_queues", "memory", "break_room"]) {
      const el = container.querySelector(`.lo-pixel-room[data-room-id="${roomId}"]`) as HTMLElement;
      expect(el.dataset.hasZone, `${roomId} 有岗位`).toBe("1");
      expect(el.getAttribute("role")).toBe("button");
      await act(async () => {
        fireEvent.click(el);
      });
      const expectedZone = Object.entries(ZONE_TO_ROOM).find(([, rid]) => rid === roomId)![0];
      expect(useLibraryOps.getState().selectedZoneId, `点 ${roomId} 应选中 ${expectedZone}`).toBe(expectedZone);
    }
    unmount();
  });

  it("LO-HITAREA-8（弱判据·时机）：pointerdown 不再取指针捕获，移动超阈值才取、松手释放", async () => {
    const { container, unmount } = render(<PixelLibraryScene snapshot={snapshot(NOW + 100_000)} initialScene={settled()} />);
    const scene = container.querySelector(".lo-scene") as HTMLElement;
    const captures: number[] = [];
    const releases: number[] = [];
    const origSet = Element.prototype.setPointerCapture;
    const origHas = Element.prototype.hasPointerCapture;
    const origRel = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture = function (id: number) {
      captures.push(id);
    };
    Element.prototype.hasPointerCapture = function () {
      return true;
    };
    Element.prototype.releasePointerCapture = function (id: number) {
      releases.push(id);
    };
    try {
      await act(async () => {
        fireEvent.pointerDown(scene, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
      });
      expect(captures, "只按不拖不该取捕获（否则 click 会被改派到 .lo-scene）").toEqual([]);
      await act(async () => {
        fireEvent.pointerMove(scene, { pointerId: 7, clientX: 101, clientY: 101 }); // 仍在 2px 阈值内
      });
      expect(captures, "2px 阈值内的抖动不算拖拽").toEqual([]);
      await act(async () => {
        fireEvent.pointerMove(scene, { pointerId: 7, clientX: 120, clientY: 130 });
      });
      expect(captures, "开始拖拽才取捕获（拖出场景外仍跟手）").toEqual([7]);
      await act(async () => {
        fireEvent.pointerUp(scene, { pointerId: 7, clientX: 120, clientY: 130 });
      });
      expect(releases, "松手释放捕获").toEqual([7]);
      // 捕获后不再重复取
      await act(async () => {
        fireEvent.pointerDown(scene, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(scene, { pointerId: 9, clientX: 40, clientY: 40 });
        fireEvent.pointerMove(scene, { pointerId: 9, clientX: 60, clientY: 60 });
      });
      expect(captures).toEqual([7, 9]);
    } finally {
      Element.prototype.setPointerCapture = origSet;
      Element.prototype.hasPointerCapture = origHas;
      Element.prototype.releasePointerCapture = origRel;
    }
    unmount();
  });
});
