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
import { PIXEL_ROOMS } from "../plugins/library-ops/data/pixel-art";
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
});
