/**
 * LO-UI — 组件渲染与交互（happy-dom + @testing-library/react）
 *
 * 覆盖：角色组件 11 种动画态渲染、场景渲染角色与岗位、监控面板 9 个页签切换、
 * 入口胶囊点击开面板、角色点击选中、皮肤令牌变量落到 DOM 上。
 *
 * 数据源被替换为固定快照（不触碰宿主服务）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { LibraryActor, LibrarySnapshot } from "../plugins/library-ops/types";
import { generateLook } from "../plugins/library-ops/data/characters";
import { getScenePreset } from "../plugins/library-ops/data/pixel-art";
import { useLibraryOps } from "../plugins/library-ops/store";

const NOW = 1_700_000_000_000;

function actor(id: string, roleLabel: string, activity: LibraryActor["activity"]): LibraryActor {
  return {
    id,
    name: `角色-${id}`,
    roleLabel,
    kind: "member",
    teamId: "team-1",
    teamName: "测试小队",
    model: "deepseek-v4",
    look: generateLook(id, roleLabel),
    activity,
    statusLabel: "执行中",
    focus: `正在处理 ${id}`,
    lastEventAt: NOW - 1000,
    metrics: { tasks: 2, done: 1, failed: 0, tools: 5, tokens: 100, cost: 0.01, errors: 0 },
    preferredZoneId: "code-forge",
  };
}

function snapshot(): LibrarySnapshot {
  const actors = [
    actor("a1", "成员 · 前端编码", "working"),
    actor("a2", "成员 · 研究分析", "reading"),
    actor("a3", "成员 · 检索索引", "searching"),
    actor("a4", "成员 · 文档写作", "writing"),
    actor("a5", "成员 · 运维部署", "error"),
  ];
  return {
    at: NOW,
    actors,
    teams: [
      {
        id: "team-1",
        name: "测试小队",
        captainSessionId: "s1",
        captainName: "队长会话",
        memberCount: actors.length,
        members: actors.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.roleLabel,
          status: "working",
          tasks: 2,
          done: 1,
          currentTask: "实现登录页",
        })),
        tasks: [
          { id: "t1", subject: "实现登录页", status: "in_progress", assignee: actors[0].name, dependencies: [], attempt: 1 },
          { id: "t2", subject: "调研方案", status: "completed", dependencies: [], attempt: 1 },
        ],
        taskCounts: { pending: 0, claimed: 0, in_progress: 1, completed: 1, failed: 0, cancelled: 0 },
        unread: 2,
        createdAt: NOW - 10_000,
        updatedAt: NOW - 500,
        archived: false,
        completion: 0.5,
      },
    ],
    metrics: {
      sessions: 2,
      activeSessions: 1,
      teams: 1,
      tasksTotal: 2,
      tasksDone: 1,
      tasksFailed: 0,
      tasksRunning: 1,
      tasksPending: 0,
      actors: actors.length,
      actorsWorking: 4,
      actorsIdle: 0,
      actorsBlocked: 0,
      actorsError: 1,
      tokensIn: 120_000,
      tokensOut: 30_000,
      tokensCached: 0,
      costTotal: 3.5,
      costToday: 1.25,
      toolCalls: 12,
      toolErrors: 1,
      filesTouched: 3,
      messages: 8,
      health: 0.82,
    },
    events: [
      { id: "e1", at: NOW - 100, kind: "tool", severity: "active", text: "write · App.tsx" },
      { id: "e2", at: NOW - 200, kind: "task", severity: "ok", text: "[测试小队] t2 调研方案", teamId: "team-1" },
      { id: "e3", at: NOW - 300, kind: "tool", severity: "bad", text: "bash · npm test" },
    ],
    activity: {
      perDay: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2023-11-${String(i + 1).padStart(2, "0")}`, i])),
      perHour: new Array(24).fill(0).map((_, h) => (h < 12 ? h : 0)),
      kinds: { chat: 1, captain: 1, worktree: 0 },
    },
    sources: {
      sessions: 2,
      activeSessions: 1,
      teams: 1,
      teamMembers: 5,
      subagents: 0,
      teamTemplates: 0,
      agentProfiles: 3,
      telemetryEvents: 4,
      failed: [],
    },
    sampleMs: 1.2,
  };
}

// 用固定快照替换真实采集（不加载宿主服务）
vi.mock("../plugins/library-ops/core/telemetry-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/library-ops/core/telemetry-adapter")>();
  return { ...actual, collectSnapshot: vi.fn(async () => snapshot()) };
});

async function mountLauncher() {
  const { LibraryOpsLauncher } = await import("../plugins/library-ops/components/LibraryOpsLauncher");
  const { useLibraryOps } = await import("../plugins/library-ops/store");
  useLibraryOps.getState()._reset();
  const utils = render(<LibraryOpsLauncher />);
  // 等面板首次采样落地
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /图书馆运营监控/ }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { utils, useLibraryOps };
}

describe("LO-UI 角色组件", () => {
  it("LO-UI-1: CharacterActor 渲染 11 种动画态且写出 data-anim / 令牌变量", async () => {
    const { CharacterActor } = await import("../plugins/library-ops/components/library/CharacterActor");
    const anims = ["idle", "walking", "thinking", "reading", "writing", "working", "searching", "blocked", "done", "error", "sleeping"] as const;
    for (const anim of anims) {
      const { container, unmount } = render(
        <CharacterActor look={generateLook("seed", "成员 · 前端编码")} anim={anim} phase={0.2} walking={anim === "walking"} />,
      );
      const svg = container.querySelector("svg.lo-actor") as SVGSVGElement;
      expect(svg, `${anim} 应渲染 svg`).toBeTruthy();
      expect(svg.getAttribute("data-anim")).toBe(anim);
      expect(svg.getAttribute("data-walking")).toBe(anim === "walking" ? "1" : "0");
      // 皮肤令牌落到内联变量
      expect(svg.style.getPropertyValue("--lo-uniform")).toContain("var(--");
      expect(svg.style.getPropertyValue("--lo-skin")).toContain("var(");
      // 部件齐全
      expect(container.querySelector(".lo-head")).toBeTruthy();
      expect(container.querySelector(".lo-body")).toBeTruthy();
      expect(container.querySelector(".lo-shadow")).toBeTruthy();
      unmount();
    }
  });

  it("LO-UI-2: 不同角色渲染不同外观（调色板/头饰/道具至少一项不同）", async () => {
    const { CharacterActor } = await import("../plugins/library-ops/components/library/CharacterActor");
    const { container } = render(
      <div>
        <CharacterActor look={generateLook("x1", "成员 · 前端编码")} anim="working" />
        <CharacterActor look={generateLook("x2", "成员 · 研究分析")} anim="reading" />
      </div>,
    );
    const svgs = container.querySelectorAll("svg.lo-actor");
    expect(svgs.length).toBe(2);
    const a = svgs[0] as SVGSVGElement;
    const b = svgs[1] as SVGSVGElement;
    const sig = (s: SVGSVGElement) =>
      [s.style.getPropertyValue("--lo-uniform"), s.style.getPropertyValue("--lo-trim"), s.innerHTML.length].join("|");
    expect(sig(a)).not.toBe(sig(b));
  });
});

describe("LO-UI 监控面板", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("LO-UI-3: 入口胶囊存在，点击后打开面板并渲染标题/状态/导航", async () => {
    await mountLauncher();
    expect(document.querySelector(".lo-shell")).toBeTruthy();
    expect(screen.getByText(/图书馆运营监控/)).toBeTruthy();
    // 9 个导航按钮
    const navButtons = document.querySelectorAll(".lo-nav__btn");
    expect(navButtons.length).toBe(9);
    // 总览 KPI 卡渲染
    expect(document.querySelectorAll(".lo-stat").length).toBeGreaterThanOrEqual(6);
  });

  it("LO-UI-4: 图书馆页签渲染像素场景（默认）与花名册；切换风格后渲染等距场景", async () => {
    await mountLauncher();
    const nav = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes("图书馆"))!;
    await act(async () => {
      fireEvent.click(nav);
    });

    // 默认：像素场景（默认内置场景图，单图层）
    const pixel = document.querySelector('.lo-scene[data-scene="pixel"]')!;
    expect(pixel).toBeTruthy();
    expect(pixel.querySelectorAll(".lo-pixel-room").length).toBe(12);
    const preset = getScenePreset(useLibraryOps.getState().settings.sceneImageId)!;
    expect(pixel.querySelectorAll(".lo-pixel-layer").length).toBe(preset.layers.length);
    expect(pixel.querySelectorAll(".lo-sprite").length).toBe(5);
    // 精灵表接线到 /library-ops/claw-library/actors/**
    const firstSprite = pixel.querySelector(".lo-sprite") as HTMLElement;
    expect(firstSprite.style.backgroundImage).toContain("/library-ops/claw-library/actors/");
    // 花名册列出全部角色
    expect(document.querySelectorAll(".lo-roster__item").length).toBe(5);
    // 岗位分布列出 10 个岗位
    expect(document.querySelectorAll(".lo-zones__item").length).toBe(10);

    // 切换为等距矢量风格 → 渲染等距场景
    await act(async () => {
      useLibraryOps.getState().updateSettings({ sceneStyle: "iso" });
    });
    const iso = document.querySelector('.lo-scene[data-scene="iso"]')!;
    expect(iso).toBeTruthy();
    expect(iso.querySelectorAll(".lo-zone").length).toBe(10);
    expect(iso.querySelectorAll(".lo-actor-wrap").length).toBe(5);
    await act(async () => {
      useLibraryOps.getState().updateSettings({ sceneStyle: "pixel" });
    });
  });

  it("LO-UI-5: 点击花名册角色 → 详情卡展示该角色信息", async () => {
    await mountLauncher();
    const nav = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes("图书馆"))!;
    await act(async () => {
      fireEvent.click(nav);
    });
    const firstRoster = [...document.querySelectorAll(".lo-roster__item")].find((el) =>
      el.textContent?.includes("角色-a1"),
    )!;
    await act(async () => {
      fireEvent.click(firstRoster);
    });
    expect(screen.getAllByText(/正在处理 a1/).length).toBeGreaterThan(0);
  });

  it("LO-UI-6: 团队页渲染成员与任务；成本页渲染 token/成本卡", async () => {
    await mountLauncher();
    const clickNav = async (label: string) => {
      const btn = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes(label))!;
      await act(async () => {
        fireEvent.click(btn);
      });
    };
    await clickNav("团队");
    expect(document.querySelectorAll(".lo-members__item").length).toBe(5);
    expect(document.querySelectorAll(".lo-tasks__item").length).toBe(2);
    expect(screen.getAllByText(/测试小队/).length).toBeGreaterThan(0);

    await clickNav("成本");
    expect(screen.getByText(/150\.0k/)).toBeTruthy(); // 120k + 30k
    expect(screen.getAllByText(/\$3\.50/).length).toBeGreaterThan(0);
  });

  it("LO-UI-7: 错误页渲染失败工具与出错角色；时间线页支持类别过滤", async () => {
    await mountLauncher();
    const clickNav = async (label: string) => {
      const btn = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes(label))!;
      await act(async () => {
        fireEvent.click(btn);
      });
    };
    await clickNav("错误");
    expect(screen.getAllByText(/bash · npm test/).length).toBeGreaterThan(0);

    await clickNav("时间线");
    const items = document.querySelectorAll(".lo-timeline__item");
    expect(items.length).toBeGreaterThanOrEqual(3);
    const toolFilter = [...document.querySelectorAll(".lo-filter__btn")].find((b) => b.textContent === "工具")!;
    await act(async () => {
      fireEvent.click(toolFilter);
    });
    const filtered = document.querySelectorAll(".lo-timeline__item");
    expect(filtered.length).toBe(2); // 两条 tool 事件
  });

  it("LO-UI-8: 设置页可切换开关并持久化到 localStorage", async () => {
    await mountLauncher();
    const btn = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes("设置"))!;
    await act(async () => {
      fireEvent.click(btn);
    });
    const checkbox = document.querySelector('.lo-switch input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    await act(async () => {
      fireEvent.click(checkbox);
    });
    const saved = JSON.parse(localStorage.getItem("codem-library-ops")!);
    expect(typeof saved).toBe("object");
    expect(Object.keys(saved).length).toBeGreaterThan(0);
  });

  it("LO-UI-9: Esc 关闭面板；关闭后入口胶囊重新出现", async () => {
    await mountLauncher();
    expect(document.querySelector(".lo-shell")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(document.querySelector(".lo-shell")).toBeFalsy();
    expect(document.querySelector(".lo-launcher")).toBeTruthy();
  });

  it("LO-UI-10: 入口徽标显示工作中角色数（异常时显示 !）", async () => {
    await mountLauncher();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    const badge = document.querySelector(".lo-launcher__badge");
    expect(badge).toBeTruthy();
    // 快照里 actorsWorking = 4、actorsError = 1 → 异常优先显示 "!"
    expect(badge!.textContent).toBe("!");
    expect(badge!.className).toContain("is-error");
  });

  it("LO-UI-11: 图书馆页签点击岗位 → 详情卡显示岗位职责与在岗角色", async () => {
    await mountLauncher();
    const nav = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes("图书馆"))!;
    await act(async () => {
      fireEvent.click(nav);
    });
    // 像素场景里的房间可点击（12 个）
    const room = document.querySelector(".lo-pixel-room") as HTMLElement;
    expect(room).toBeTruthy();
    await act(async () => {
      fireEvent.click(room);
    });
    // 岗位分布列表项也可点击
    const zoneRow = document.querySelector(".lo-zones__item") as HTMLElement;
    await act(async () => {
      fireEvent.click(zoneRow);
    });
    expect(document.querySelector(".lo-zone-occupants")).toBeTruthy();
    expect(screen.getByText(/取消选中岗位/)).toBeTruthy();
  });

  it("LO-UI-12: 场景 HUD 提供缩放按钮，且画布使用平移+缩放变换", async () => {
    await mountLauncher();
    const nav = [...document.querySelectorAll(".lo-nav__btn")].find((b) => b.textContent?.includes("图书馆"))!;
    await act(async () => {
      fireEvent.click(nav);
    });
    const hud = document.querySelector(".lo-scene__hud")!;
    expect(hud).toBeTruthy();
    expect(hud.querySelectorAll(".lo-hud-btn").length).toBe(3);
    const canvas = document.querySelector(".lo-scene__canvas") as HTMLElement;
    expect(canvas.style.transform).toMatch(/translate\(.*\)\s*scale\(/);
  });
});
