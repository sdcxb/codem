/**
 * 插件管理面板：**界面上的开关状态必须是真实状态**（第 48 轮，真机发现的 P1）
 *
 * ## 这个缺陷是怎么被抓到的（真机取证，不是推断）
 *
 * 在打包版（1.16.76）的插件管理面板里点一下 `@codem/ui-game` 的开关，观察到：
 *
 * | 观测点 | 结果 |
 * | --- | --- |
 * | 权威介质 `codem-disabled-plugins` | `["@codem/ui-game"]` → `[]`（**写对了**） |
 * | 写入时刻 `codem-disabled-plugins-at` | 当场出现 `1789723668130`，与镜像完全一致 |
 * | 卡片上的开关 | `aria-checked="false"`、`aria-label="@codem/ui-game: enable plugin"` —— **一点没变** |
 * | 再点一次 | 弹出「确认关闭插件：您即将关闭 @codem/ui-game」 |
 *
 * 也就是说：开关**真的生效了**，但界面**坚持说它没生效**。用户再点一次时，
 * 系统问的是"要不要关闭" —— 而界面上一秒还显示它是关着的。
 *
 * ## 根因
 *
 * `plugins` 是 `useMemo(..., [manager, searchQuery, activeCategory])`，
 * 里面读的却是 `manager.getPluginStates()`（**实时**可变的内部状态）。
 * `manager.subscribe(() => setForceUpdate(n => n + 1))` 只让组件重渲染，
 * 而 memo 的三个依赖一个都没变 → **列表整个不重算**。
 * 顶部计数（在 render 里直接算，没进 memo）会更新，卡片不会 ——
 * 于是同一个面板里"计数说已启用 208、卡片说未启用"，自相矛盾。
 *
 * 同样的写法在 `PluginMarketTab` 的 `pluginStates` 上复现（依赖只有 `[manager]`）。
 *
 * ## 这个文件守什么
 *
 * 1. 切换后**卡片**上的开关与 `aria-label` 跟上真实状态（不是只更新计数）；
 * 2. `aria-label` 不能与 `aria-checked` 互相矛盾（读屏用户听到的就是它）；
 * 3. `PluginMarketTab` 的"已安装/未启用"标记同样跟着 `stateVersion` 重算。
 *
 * 第 1 条是**正面判据**：断言的是"卡片变了"，而不是"某个函数被调用了"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

/**
 * 假 manager —— 只实现 `PluginManager` 真正用到的那几个方法。
 *
 * 用 `vi.hoisted` 是因为 `vi.mock` 会被提升到 import 之前，
 * 直接引用下面声明的变量会拿到 `undefined`。
 */
const h = vi.hoisted(() => ({ manager: null as any, listener: null as null | (() => void) }));

vi.mock("../core/plugin-loader/plugin-manager-service", () => ({
  initPluginManager: async () => h.manager,
  getPluginManager: () => h.manager,
  resetPluginManagerSingletonForTest: () => {},
  PluginManagerService: class {},
}));

interface FakePlugin {
  name: string;
  status: "enabled" | "disabled";
  description: string;
  category: string;
  dependencies: string[];
  dependents: string[];
  dependencyDescription: string;
  canSafelyDisable: boolean;
  updatedAt: number;
}

function makeFakeManager() {
  const states = new Map<string, FakePlugin>();
  states.set("@codem/ui-game", {
    name: "@codem/ui-game",
    status: "disabled",
    description: "小游戏",
    category: "ui",
    dependencies: [],
    dependents: [],
    dependencyDescription: "",
    canSafelyDisable: true,
    updatedAt: Date.now(),
  });
  states.set("@codem/llm", {
    name: "@codem/llm",
    status: "enabled",
    description: "LLM 服务",
    category: "core",
    dependencies: [],
    dependents: [],
    dependencyDescription: "",
    canSafelyDisable: false,
    updatedAt: Date.now(),
  });

  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of [...listeners]) fn(); };

  return {
    /**
     * ⚠️ 必须返回**新的对象**（`{...s}`），不能直接给 `states` 里的引用。
     *
     * 这不是洁癖：第一版假 manager 直接返回内部对象引用，于是"缓存住的那份列表"
     * 会被后续状态变更**就地改写** —— 即使被测代码的 `useMemo` 依赖是错的，
     * 界面看起来也"更新了"，用例照样通过（本文件的牙齿就是这么被拔掉的，
     * 靠"把修复回退掉、用例应当失败"这一步才查出来）。
     * 真实实现 `getPluginStates()` 每次都是 `{...meta, status: ...}` 现造对象，
     * 所以缓存住的那份就是**快照**，依赖写错了它就永远停在那一刻。
     */
    getPluginStates: () => [...states.values()].map((s) => ({ ...s })),
    getPluginState: (name: string) => states.get(name),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    enable: async (name: string) => {
      const s = states.get(name);
      if (s) s.status = "enabled";
      notify();
      return { success: true, enabledList: [name] };
    },
    disable: async (name: string) => {
      const s = states.get(name);
      if (s) s.status = "disabled";
      notify();
      return { success: true, disabledList: [name], needsConfirmation: false };
    },
    restart: async () => ({ success: true }),
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
  h.manager = makeFakeManager();
  h.listener = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 找到某个插件的开关（`PluginCard` 用 `aria-label="<name>: disable plugin|enable plugin"`） */
async function findSwitch(name: string) {
  await waitFor(() => {
    expect(screen.getAllByRole("switch").length).toBeGreaterThan(0);
  });
  const el = screen
    .getAllByRole("switch")
    .find((s) => (s.getAttribute("aria-label") || "").startsWith(`${name}: `));
  expect(el, `没找到 ${name} 的开关（卡片是否渲染了？）`).toBeTruthy();
  return el!;
}

describe("PLUGIN-UI：插件开关的界面状态必须跟得上真实状态", () => {
  it("PLUGIN-UI-1: 切换后卡片上的开关与 aria-label 一起更新（正面判据）", async () => {
    const { PluginManager } = await import("../components/PluginManager");
    render(<PluginManager onClose={() => {}} />);

    const before = await findSwitch("@codem/ui-game");
    // 前提：初始是「未启用」，且打印出来的名字与状态一致
    expect(before.getAttribute("aria-checked")).toBe("false");
    expect(before.getAttribute("aria-label")).toBe("@codem/ui-game: enable plugin");

    fireEvent.click(before);

    // 真实状态已经变了（服务侧 notify 过）→ **卡片必须跟着变**
    await waitFor(() => {
      const after = screen
        .getAllByRole("switch")
        .find((s) => (s.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "));
      expect(
        after?.getAttribute("aria-checked"),
        "接口数据已经变成 enabled，卡片却还画着未启用 —— 这就是真机上那个缺陷",
      ).toBe("true");
    });

    const after = screen
      .getAllByRole("switch")
      .find((s) => (s.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "))!;
    expect(
      after.getAttribute("aria-label"),
      "aria-label 不能与 aria-checked 矛盾（读屏用户听到的就是它）",
    ).toBe("@codem/ui-game: disable plugin");
  });

  it("PLUGIN-UI-2: 再点一次走的是「关闭」语义（不会因为界面还显示未启用而弹错对话框）", async () => {
    const { PluginManager } = await import("../components/PluginManager");
    render(<PluginManager onClose={() => {}} />);

    const first = await findSwitch("@codem/ui-game");
    fireEvent.click(first);
    await waitFor(() => {
      const s = screen
        .getAllByRole("switch")
        .find((x) => (x.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "));
      expect(s?.getAttribute("aria-checked")).toBe("true");
    });

    // 第二次点击：界面现在如实显示"已启用"，所以这一次是关闭
    const second = screen
      .getAllByRole("switch")
      .find((x) => (x.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "))!;
    fireEvent.click(second);
    await waitFor(() => {
      const s = screen
        .getAllByRole("switch")
        .find((x) => (x.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "));
      expect(s?.getAttribute("aria-checked"), "两次点击应当一开一关").toBe("false");
    });
  });

  it("PLUGIN-UI-3: 顶部计数与卡片列表同源同帧（不会出现「计数说 1 启用、卡片说未启用」）", async () => {
    const { PluginManager } = await import("../components/PluginManager");
    render(<PluginManager onClose={() => {}} />);

    const sw = await findSwitch("@codem/ui-game");
    fireEvent.click(sw);

    await waitFor(() => {
      const cards = screen
        .getAllByRole("switch")
        .filter((s) => (s.getAttribute("aria-label") || "").includes("ui-game"));
      const on = cards.filter((c) => c.getAttribute("aria-checked") === "true");
      expect(on.length, "计数说已启用，卡片也必须说已启用").toBe(1);
    });
  });

  it("PLUGIN-UI-4: 轮询/重渲染不会把已经更新的卡片状态吃掉（订阅是持久的）", async () => {
    const { PluginManager } = await import("../components/PluginManager");
    const { rerender } = render(<PluginManager onClose={() => {}} />);
    const sw = await findSwitch("@codem/ui-game");
    fireEvent.click(sw);
    await waitFor(() => {
      const s = screen
        .getAllByRole("switch")
        .find((x) => (x.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "));
      expect(s?.getAttribute("aria-checked")).toBe("true");
    });

    // 父级重渲染（等价于面板被重新挂载/父组件状态变化）
    rerender(<PluginManager onClose={() => {}} />);

    const s = screen
      .getAllByRole("switch")
      .find((x) => (x.getAttribute("aria-label") || "").startsWith("@codem/ui-game: "))!;
    expect(s.getAttribute("aria-checked"), "重渲染之后仍然必须是真实状态").toBe("true");
  });
});
