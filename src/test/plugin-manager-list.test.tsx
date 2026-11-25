/**
 * 插件管理「已安装」区：198 个插件的 emoji 卡片墙 → 可扫描的密集列表行。
 *
 * ## 这一组判据守什么
 *
 * | # | 判据 | 变异（必须红） |
 * | --- | --- | --- |
 * | PML-1 | 已安装区渲染 `[data-plugin-row]` 行，列齐（图标/名称+版本/描述/类型/依赖/开关） | 退回 `market-skill-card` 卡片 |
 * | PML-2 | manifest 的 emoji `icon` 不进 DOM；图标位恰好一个 lucide `<svg>` | 恢复 `plugin.icon` 直出 |
 * | PML-3 | 核心插件的开关 `disabled`，点它不会调用 disable | 去掉 `isCore` 判断 |
 * | PML-4 | 普通开关仍调原 handler（`manager.disable`），且不会误开详情 | 开关不再接线 / 行点击吞掉开关 |
 * | PML-5 | 4 个分组筛选仍生效（核心 / 能力 / 界面） | 过滤函数失效 |
 * | PML-6 | 风险文字只出现在「danger 且非核心」的行 | 每行挂风险徽标 |
 * | PML-7 | 顶部统计是一行 mono meta 文本，不再是两个 Badge | 恢复两个 pill |
 * | PML-8 | 加载更多文案是「加载更多（剩余 N）」，原「再显示…还有…」绝迹 | 恢复二次计数文案 |
 * | PML-10 | 依赖数为 0 的行**不留「—」占位**，但依赖列仍占位（六列不错位） | 恢复 '—' 或省掉 deps 单元格 |
 * | PML-11 | 「全部」且未搜索时按类别插入分组标题（核心 → 服务 → 界面），组内行连续 | 不分组 / 标题出现在筛选或搜索下 |
 * | PML-12 | 搜索或切换筛选时分组标题消失（平铺），清空后恢复 | 分组条件写成「总是显示」 |
 *
 * ## 口径说明
 *
 * - 断言落在**用户看得到的东西**（行结构、开关状态、筛选结果、文案）上，
 *   不测组件内部 state；`aria-label` 仍沿用原契约 `<name>: enable/disable plugin`，
 *   因为 `plugin-ui-state-refresh.test.tsx` 已经把它当作用户可感知的状态名。
 * - 图标只断言 `svg` 数量，不锁具体 lucide 名称：分类 → 图标的映射允许换图，
 *   但「一行最多一个图标、且绝不是 emoji」是硬约束。
 * - 行高 56–64px 由集成样式落地（组件里不写死尺寸），所以这里不读 computed style。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

/** `vi.mock` 会被提升，manager 桩只能走 `vi.hoisted`。 */
const h = vi.hoisted(() => ({ manager: null as any }));

vi.mock("../core/plugin-loader/plugin-manager-service", () => ({
  initPluginManager: async () => h.manager,
  getPluginManager: () => h.manager,
  resetPluginManagerSingletonForTest: () => {},
  PluginManagerService: class {},
}));

interface FakePlugin {
  name: string;
  version?: string;
  description: string;
  category: string;
  tags: string[];
  icon?: string;
  status: "enabled" | "disabled" | "loading" | "error";
  core?: boolean;
  locked?: boolean;
  hot?: boolean;
  riskLevel?: "safe" | "caution" | "danger";
  riskDescription?: string;
  dependencies: string[];
  dependents: string[];
  canSafelyDisable: boolean;
}

function makePlugin(overrides: Partial<FakePlugin> & { name: string }): FakePlugin {
  return {
    version: "1.0.0",
    description: "",
    category: "provider",
    tags: [],
    status: "disabled",
    dependencies: [],
    dependents: [],
    canSafelyDisable: true,
    ...overrides,
  };
}

const DEFAULT_PLUGINS: FakePlugin[] = [
  makePlugin({
    name: "@codem/ui-game",
    version: "1.2.3",
    description: "小游戏面板",
    category: "ui",
    tags: ["ui"],
    icon: "🧩",
    status: "disabled",
  }),
  makePlugin({
    name: "@codem/llm",
    version: "1.0.0",
    description: "LLM 推理服务",
    category: "core",
    tags: ["service", "agent"],
    icon: "🤖",
    status: "enabled",
    core: true,
    locked: true,
    riskLevel: "danger",
    riskDescription: "关闭后 Agent 无法推理",
  }),
  makePlugin({
    name: "@codem/shell-local",
    version: "1.0.0",
    description: "本地命令行执行（如果描述很长，行内应当单行截断而不是把行撑成两行）",
    category: "provider",
    tags: ["provider", "runtime"],
    icon: "🖥️",
    status: "enabled",
    riskLevel: "danger",
    riskDescription: "关闭后无法执行命令",
    dependencies: ["@codem/llm"],
  }),
];

/**
 * 假 manager —— 只实现 `PluginManager` 用到的接口。
 *
 * `disable` / `enable` / `restart` 用 `vi.fn` 包住，便于断言「开关仍调用原 handler」。
 */
function makeFakeManager(plugins: FakePlugin[]) {
  const states = new Map(plugins.map((p) => [p.name, { ...p }]));
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of [...listeners]) fn(); };

  const disable = vi.fn(async (name: string) => {
    const s = states.get(name);
    if (s) s.status = "disabled";
    notify();
    return { success: true, disabledList: [name], unloadedList: [name], needsConfirmation: false };
  });
  const enable = vi.fn(async (name: string) => {
    const s = states.get(name);
    if (s) s.status = "enabled";
    notify();
    return { success: true, enabledList: [name] };
  });
  const restart = vi.fn(async () => ({ success: true }));

  return {
    getPluginStates: () => [...states.values()].map((s) => ({ ...s })),
    getPluginState: (name: string) => states.get(name),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    enable,
    disable,
    restart,
    getDependencyGraph: () => ({
      list: () => [],
      get: () => ({ riskLevel: "safe" }),
      canSafelyDisable: () => true,
      getDependencyInfo: () => ({ dependencies: [], dependents: [], dependencyDescription: "" }),
      getCascadeDisable: () => ({ toDisable: [], needsConfirmation: false, lockedReason: null }),
      getCascadeEnable: () => ({ toEnable: [], missingDependencies: [] }),
    }),
  };
}

beforeEach(() => {
  h.manager = makeFakeManager(DEFAULT_PLUGINS.map((p) => ({ ...p })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderManager() {
  const { PluginManager } = await import("../components/PluginManager");
  const view = render(<PluginManager onClose={() => {}} />);
  await waitFor(() => {
    expect(view.container.querySelectorAll("[data-plugin-row]").length).toBeGreaterThanOrEqual(4);
  });
  return view;
}

function rowOf(container: HTMLElement, name: string): HTMLElement | null {
  return container.querySelector(`[data-plugin-row="${name}"]`);
}

describe("插件管理：已安装插件用密集列表行", () => {
  it("PML-1: 每个已安装插件是一行，六列齐全（不再是 market-skill-card）", async () => {
    const { container } = await renderManager();

    expect(container.querySelectorAll(".market-skill-card").length, "已安装区不应再出现卡片墙").toBe(0);
    expect(container.querySelectorAll("[data-plugin-row]").length, "3 个 cordis 插件 + 免费模型入口 = 4 行").toBe(4);

    const game = rowOf(container, "@codem/ui-game");
    expect(game, "缺少 @codem/ui-game 的行").not.toBeNull();
    expect(game!.querySelector(".plugin-row-icon svg"), "图标位应渲染 lucide").toBeTruthy();
    expect(game!.querySelector(".plugin-row-name")?.textContent).toContain("@codem/ui-game");
    expect(game!.querySelector(".plugin-row-version")?.textContent).toBe("v1.2.3");
    expect(game!.querySelector(".plugin-row-desc")?.textContent).toContain("小游戏面板");
    expect(game!.querySelector(".plugin-row-type")?.textContent).toBe("界面组件");
    expect(
      game!.querySelector(".plugin-row-deps")?.textContent,
      "依赖数为 0 的行不留「—」占位（列本身仍在，见 PML-10）",
    ).toBe("");
    expect(game!.querySelector('[role="switch"]'), "每行要有状态开关").toBeTruthy();
  });

  it("PML-2: manifest 的 emoji icon 不进 DOM；图标位恰好一个 lucide（没有第二个 emoji）", async () => {
    const { container } = await renderManager();
    const game = rowOf(container, "@codem/ui-game")!;

    expect(container.textContent, "manifest 的 🧩 不许出现在界面里").not.toContain("🧩");
    expect(container.textContent, "manifest 的 🤖 不许出现在界面里").not.toContain("🤖");
    expect(game.textContent, "这一行里也不许有 emoji").not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
    expect(game.querySelectorAll(".plugin-row-icon svg").length, "图标列最多一个 lucide").toBe(1);
    expect(game.querySelectorAll("svg").length, "整行最多一个 lucide（状态靠开关，不挂第二枚图标）").toBe(1);

    /* 详情弹层头部的图标位也必须走 lucide（旧实现这里也直出 plugin.icon） */
    fireEvent.click(game);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain("🧩");
    expect(dialog.querySelector(".plugin-detail-head svg"), "详情头部应渲染 lucide").toBeTruthy();
  });

  it("PML-3: 核心插件仍不可关闭（开关 disabled，点它不调 disable）", async () => {
    const { container } = await renderManager();
    const llm = rowOf(container, "@codem/llm")!;

    expect(llm.textContent, "核心插件行要有「核心」文字标记").toContain("核心");
    const sw = llm.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled, "核心插件的开关必须禁用").toBe(true);
    expect(sw.getAttribute("aria-label")).toBe("@codem/llm: disable plugin");

    fireEvent.click(sw);
    expect(h.manager.disable, "禁用的开关不许触发关闭逻辑").not.toHaveBeenCalled();
  });

  it("PML-4: 普通开关仍调用原 handler，且不会误开详情", async () => {
    const { container } = await renderManager();
    const shell = rowOf(container, "@codem/shell-local")!;
    const sw = shell.querySelector('[role="switch"]') as HTMLButtonElement;

    fireEvent.click(sw);

    await waitFor(() => {
      expect(h.manager.disable, "开关必须调用原来的 manager.disable").toHaveBeenCalledWith("@codem/shell-local");
    });
    expect(screen.queryByRole("dialog"), "点开关不应冒泡到行点击（详情弹层不该打开）").toBeNull();
  });

  it("PML-5: 4 个分组筛选仍生效（核心 / 能力 / 界面）", async () => {
    const { container } = await renderManager();

    fireEvent.click(screen.getByTestId("plugin-filter-core"));
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-plugin-row]");
      expect(rows.length).toBe(1);
      expect(rowOf(container, "@codem/llm")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("plugin-filter-interface"));
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-plugin-row]");
      expect(rows.length).toBe(1);
      expect(rowOf(container, "@codem/ui-game")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("plugin-filter-capability"));
    await waitFor(() => {
      /* provider（shell）+ 免费模型（provider stub）= 2 */
      expect(container.querySelectorAll("[data-plugin-row]").length).toBe(2);
      expect(rowOf(container, "@codem/shell-local")).not.toBeNull();
      expect(container.querySelector('.ofm-compact-card[data-plugin-row]'), "免费模型入口也归在能力分组").not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("plugin-filter-all"));
    await waitFor(() => {
      expect(container.querySelectorAll("[data-plugin-row]").length).toBe(4);
    });
  });

  it("PML-6: 风险文字只出现在「danger 且非核心」的行（不铺满每一行）", async () => {
    const { container } = await renderManager();

    expect(rowOf(container, "@codem/ui-game")!.querySelector(".plugin-row-risk"), "安全插件不挂风险").toBeNull();
    expect(rowOf(container, "@codem/llm")!.querySelector(".plugin-row-risk"), "核心插件锁定且无决策，不挂风险").toBeNull();
    expect(
      rowOf(container, "@codem/shell-local")!.querySelector(".plugin-row-risk"),
      "危险且可关闭的插件才显示安静的「高风险」文字",
    ).not.toBeNull();
  });

  it("PML-7: 顶部统计是一行 mono meta，不再是两个 Badge", async () => {
    await renderManager();
    const stats = screen.getByTestId("plugin-mgr-stats");

    expect(stats.textContent).toContain("4 个插件");
    expect(stats.textContent).toContain("3 个已启用");
    expect(stats.className).toContain("plugin-mgr-stats");
    expect(stats.closest(".badge"), "统计不许再被包成 pill").toBeNull();
  });

  it("PML-8: 加载更多文案是「加载更多（剩余 N）」，保留原有分片加载逻辑", async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      makePlugin({
        name: `@codem/provider-${i}`,
        description: `第 ${i} 个插件`,
        category: "provider",
        tags: ["provider"],
        status: "disabled",
      }),
    );
    h.manager = makeFakeManager(many);

    const { container } = await renderManager();
    await waitFor(() => {
      expect(container.querySelectorAll("[data-plugin-row]").length).toBe(40);
    });

    const btn = container.querySelector(".incremental-more-btn") as HTMLButtonElement;
    expect(btn, "超过首屏 40 项时必须保留加载更多按钮").toBeTruthy();
    expect(btn.textContent).toBe("加载更多（剩余 6）");
    expect(btn.textContent).not.toContain("再显示");

    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.querySelectorAll("[data-plugin-row]").length).toBe(46);
    });
    expect(container.querySelector(".incremental-more-btn"), "全部加载完就收起按钮").toBeNull();
  });

  it("PML-9: DSH Ops 外部运行时区块保留，但不再套 market-skill-card 大卡片", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "components", "plugin-market", "DshExternalPluginsCard.tsx"),
      "utf8",
    );
    expect(src, "外部运行时区块必须还在").toContain('data-testid="dsh-external-plugins"');
    expect(src, "检查更新行为必须还在").toContain("void check()");
    expect(src, "不再使用卡片外壳").not.toMatch(/className="[^"]*market-skill-card/);
  });

  it("PML-10: 依赖数为 0 不留「—」占位；依赖列仍在，六列不错位", async () => {
    const { container } = await renderManager();

    /* 免费模型入口是合成卡片（不在本组件的行结构里），只看 cordis 插件的行 */
    const rows = [...container.querySelectorAll<HTMLElement>("[data-plugin-row]:not(.ofm-compact-card)")];
    expect(rows.length, "3 个 cordis 插件行").toBe(3);

    for (const row of rows) {
      const deps = row.querySelector<HTMLElement>(".plugin-row-deps");
      expect(deps, `${row.dataset.pluginRow}: 依赖列必须仍然渲染（网格第五格）`).toBeTruthy();
      expect(row.textContent, `${row.dataset.pluginRow}: 行内不许出现「—」占位`).not.toContain("—");
    }

    /* 六格顺序固定：图标 / 名称 / 描述 / 类型 / 依赖 / 操作 —— 缺一格就会错列 */
    const shell = rowOf(container, "@codem/shell-local")!;
    const cells = [...shell.children].map((el) => (el as HTMLElement).className.split(" ")[0]);
    expect(cells).toEqual([
      "plugin-row-icon",
      "plugin-row-name",
      "plugin-row-desc",
      "plugin-row-type",
      "plugin-row-deps",
      "plugin-row-actions",
    ]);
    expect(shell.querySelector(".plugin-row-deps")!.textContent, "有依赖时如实显示数量").toBe("1 依赖");
    expect(rowOf(container, "@codem/ui-game")!.querySelector(".plugin-row-deps")!.textContent).toBe("");
  });

  it("PML-11: 「全部」未搜索时按类别分组；组内行连续，标题带计数", async () => {
    const { container } = await renderManager();

    const headers = [...container.querySelectorAll<HTMLElement>(".plugin-list [data-plugin-group]")];
    expect(headers.map((h) => h.dataset.pluginGroup), "核心 → 服务 → 界面（无 tool/compat 数据）").toEqual([
      "core",
      "provider",
      "ui",
    ]);
    expect(headers.map((h) => h.querySelector(".plugin-list-group__label")!.textContent)).toEqual([
      "核心",
      "服务",
      "界面",
    ]);
    expect(
      headers.map((h) => h.querySelector(".plugin-list-group__count")!.textContent),
      "计数 = 该组插件数（服务组含免费模型入口）",
    ).toEqual(["1", "2", "1"]);

    /* 标题是行的兄弟节点：同一组的行必须连续排列在标题之后 */
    const sequence = [...container.querySelectorAll(".plugin-list [data-plugin-group], .plugin-list [data-plugin-row]")]
      .map((el) => {
        const group = el.getAttribute("data-plugin-group");
        if (group) return `group:${group}`;
        return (el as HTMLElement).classList.contains("ofm-compact-card") ? "row:ofm" : `row:${el.getAttribute("data-plugin-row")}`;
      });
    expect(sequence).toEqual([
      "group:core", "row:@codem/llm",
      "group:provider", "row:ofm", "row:@codem/shell-local",
      "group:ui", "row:@codem/ui-game",
    ]);
  });

  it("PML-12: 搜索 / 筛选时分组标题消失（平铺），清空搜索后分组恢复", async () => {
    const { container } = await renderManager();
    const search = container.querySelector<HTMLInputElement>(".skill-search-input")!;
    expect(container.querySelectorAll("[data-plugin-group]").length).toBe(3);

    fireEvent.change(search, { target: { value: "game" } });
    await waitFor(() => {
      expect(container.querySelectorAll("[data-plugin-row]").length, "搜索只留命中行").toBe(1);
    });
    expect(container.querySelectorAll("[data-plugin-group]").length, "搜索时保持平铺").toBe(0);

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => {
      expect(container.querySelectorAll("[data-plugin-group]").length, "清空搜索后恢复分组").toBe(3);
    });

    fireEvent.click(screen.getByTestId("plugin-filter-core"));
    await waitFor(() => {
      expect(container.querySelectorAll("[data-plugin-row]").length).toBe(1);
    });
    expect(container.querySelectorAll("[data-plugin-group]").length, "筛选时保持平铺").toBe(0);
  });
});
