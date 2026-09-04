/**
 * 插件市场 Tab 渲染/行为测试
 *
 * MT-1 无 manager（Cordis 未就绪）时：目录可浏览、bundled 不出现安装按钮
 * MT-2 bundled 条目显示兼容徽标与 Codem 等价插件名；状态来自 manager
 * MT-3 点击"安装并启用"调用 manager.enable(codemAnchor) 并提示
 * MT-4 非核心已启用条目 → 点击"禁用"走统一 onToggle（卸载语义）
 * MT-5 核心内置锚点（如 @codem/llm）已启用时只显示只读"已启用（核心）"，不提供禁用卸载
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PluginMarketTab } from "../components/plugin-market/PluginMarketTab";
import { DSH_MARKET_CATALOG } from "../core/plugin-market/dsh-market-catalog";

/** 与运行时 core 插件清单一致的锚（安装目标恒启、不可卸载） */
const CORE_ANCHORS = new Set([
  "@codem/llm",
  "@codem/fs-local",
  "@codem/session",
  "@codem/shell-local",
  "@codem/tools",
  "@codem/credentials",
]);

function makeManagerMock(extraStatus: Record<string, "loading" | "error"> = {}) {
  const enabled: string[] = [];
  const anchors = DSH_MARKET_CATALOG.filter(
    (e) => e.status === "bundled" && e.codemAnchor
  ).map((e) => e.codemAnchor as string);
  return {
    enable: vi.fn(async (name: string) => {
      if (!enabled.includes(name)) enabled.push(name);
      return { success: true, enabledList: [name] };
    }),
    disable: vi.fn(async () => ({ success: true, disabledList: ["x"] })),
    getPluginStates: vi.fn(() =>
      anchors.map((name) => ({
        name,
        status: extraStatus[name] ?? (enabled.includes(name) ? ("enabled" as const) : ("disabled" as const)),
        canSafelyDisable: !CORE_ANCHORS.has(name),
        updatedAt: Date.now(),
      }))
    ),
    subscribe: vi.fn(() => () => {}),
  };
}

describe("插件市场 Tab", () => {
  beforeEach(() => cleanup());

  it("MT-1: 无 manager 时目录可浏览且不出现安装按钮", () => {
    render(
      <PluginMarketTab manager={null} zh notify={() => {}} onToggle={() => {}} />
    );
    expect(screen.getAllByText(/@deepseek-ai\/dsh-llm/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/@codem\/llm/).length).toBeGreaterThan(0);
    // 无安装按钮（bundled 项显示"初始化中…"）
    expect(screen.queryByText("安装并启用")).toBeNull();
    expect(screen.getAllByText("初始化中…").length).toBeGreaterThan(0);
  });

  it("MT-2: bundled 卡片显示兼容徽标与等价插件", () => {
    const mgr = makeManagerMock() as any;
    render(<PluginMarketTab manager={mgr} zh notify={() => {}} onToggle={() => {}} />);
    expect(screen.getAllByText("内置等价").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/未启用/).length).toBeGreaterThan(0);
  });

  it("MT-3: 点击安装 → manager.enable(codemAnchor)", async () => {
    const mgr = makeManagerMock() as any;
    const notify = vi.fn();
    render(<PluginMarketTab manager={mgr} zh notify={notify} onToggle={() => {}} />);
    const buttons = screen.getAllByText("安装并启用");
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.enable).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已安装并启用"), "success");
  });

  it("MT-4: 非核心已启用条目 → 点击禁用走 onToggle（卸载语义）", async () => {
    const mgr = makeManagerMock() as any;
    // 预启用一个非核心 anchored 插件（可安全卸载）
    await mgr.enable("@codem/tool-fs-search");
    const onToggle = vi.fn();
    render(<PluginMarketTab manager={mgr} zh notify={() => {}} onToggle={onToggle} />);
    const disableButtons = screen.getAllByText("禁用");
    expect(disableButtons.length).toBeGreaterThan(0);
    fireEvent.click(disableButtons[0]);
    expect(onToggle).toHaveBeenCalled();
  });

  it("MT-5: 核心内置锚点已启用时只读显示，不提供禁用卸载", async () => {
    const mgr = makeManagerMock() as any;
    await mgr.enable("@codem/llm");
    render(<PluginMarketTab manager={mgr} zh notify={() => {}} onToggle={() => {}} />);
    expect(screen.getAllByText("已启用（核心）").length).toBeGreaterThan(0);
    // 全列表此时不应出现任何"禁用"按钮（唯一 enabled 的是核心锚）
    expect(screen.queryByText("禁用")).toBeNull();
    // 核心锚卡片锚点行标注已启用
    expect(screen.getAllByText(/已启用/).length).toBeGreaterThan(0);
  });

  it("MT-6: 安装中（loading）条目显示只读'启用中…'，无安装/禁用按钮", () => {
    const mgr = makeManagerMock({ "@codem/tool-fs-search": "loading" }) as any;
    render(<PluginMarketTab manager={mgr} zh notify={() => {}} onToggle={() => {}} />);
    expect(screen.getAllByText("启用中…").length).toBeGreaterThan(0);
    // loading 条目不提供"安装并启用"或"禁用"动作
    expect(screen.queryByText("禁用")).toBeNull();
  });
});
