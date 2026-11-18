/**
 * Batch 1A：公共工作区外壳的**结构契约**。
 *
 * ## 这条判据要守住什么
 *
 * 迁移前 `App.tsx` 把同一段主区复制了三份（`app.conversation` 槽位 3 处、`terminal-drawer` 3 处、
 * `app.right-sidebar` 3 处）。这类重复不会报错、也不会挂，只会让"改一处、漏两处"成为常态 ——
 * 事实上右栏入参已经漂过一次（hub 少传三个字段）。所以判据分两层：
 *
 *   1. **运行时结构**：`WorkspaceFrame` 的三个分支各自把 sidebar / main / rightRail 摆到正确位置；
 *      `WorkspaceMainColumn` 的节点顺序与迁移前逐节点一致（压缩横幅 → 笔记本横幅 → 会话 → 终端 → 页签 → 游戏）；
 *   2. **源码约束**：`App.tsx` 里这些块只能各出现一次（防回退到"再复制一份"）。
 *
 * 说明：这里不断言"像素一致"——那由批次账本里的布局指纹负责（2021 元素逐矩形相同）。
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen } from "@testing-library/react";
import { afterEach } from "vitest";

/* 把重组件与布局换成可观察的薄桩：本判据测的是"谁被放在哪"，不是它们各自的内部。
   HubLayout/DreamLayout 的真实实现依赖 skin store 与插件槽位，在单测里跑起来只会测到环境。 */
const hubProps: Array<Record<string, unknown>> = [];
vi.mock("../components/HubLayout", () => ({
  HubLayout: (props: Record<string, unknown>) => {
    hubProps.push(props);
    return (
      <div data-testid="hub-layout">
        <div data-testid="hub-sidebar">{props.sidebar as never}</div>
        <div data-testid="hub-main">{props.mainPanel as never}</div>
        <div data-testid="hub-right">{props.rightRail as never}</div>
      </div>
    );
  },
}));

const dreamProps: Array<Record<string, unknown>> = [];
vi.mock("../components/DreamLayout", () => ({
  DreamLayout: (props: Record<string, unknown>) => {
    dreamProps.push(props);
    return <div data-testid="dream-layout">{props.children as never}</div>;
  },
}));

vi.mock("../components/ChatPanel", () => ({
  ChatPanel: (props: Record<string, unknown>) => (
    <div data-testid="chat-stub" data-session={String(props.sessionId ?? "")} data-connected={String(props.connected ?? "")} />
  ),
}));

vi.mock("../core/slots/SlotBridge", () => ({
  SlotBridge: ({ name, fallback: Fallback, ...rest }: { name: string; fallback?: (p: unknown) => unknown } & Record<string, unknown>) => (
    <div data-testid={`slot-${name}`}>
      {typeof Fallback === "function" ? <Fallback {...rest} /> : null}
    </div>
  ),
  SlotListBridge: () => null,
}));

import { WorkspaceFrame, WorkspaceMainColumn, type WorkspaceMainColumnProps } from "../components/workspace/WorkspaceFrame";

afterEach(() => {
  cleanup();
  hubProps.length = 0;
  dreamProps.length = 0;
});

const node = (label: string) => <div data-testid={label} />;

function mainColumnProps(overrides: Partial<WorkspaceMainColumnProps> = {}): WorkspaceMainColumnProps {
  return {
    lang: "zh",
    compactionStatus: null,
    uiSessionId: null,
    activeNotebookId: null,
    activeNotebookName: "",
    onSaveAIResponseAsNote: () => {},
    setNotebookWorkspaceId: () => {},
    setNotebookWorkspaceName: () => {},
    setActiveNotebookId: () => {},
    setActiveNotebookName: () => {},
    setNotebookSourceFilter: () => {},
    chat: { sessionId: "s-1", connected: true } as WorkspaceMainColumnProps["chat"],
    bottomTab: "chat",
    terminal: node("terminal-node"),
    onCloseTerminal: () => {},
    bottomPanels: null,
    game: null,
    ...overrides,
  };
}

describe("WorkspaceFrame：三套皮肤的布局包裹", () => {
  it("default：顺序是 [汉堡按钮, 侧栏, 主列, 右栏]（与迁移前的 fragment 一致）", () => {
    const { container } = render(
      <WorkspaceFrame
        variant="default"
        sidebar={node("sidebar-node")}
        main={node("main-node")}
        rightRail={node("right-node")}
        mobileSidebarToggle={node("toggle-node")}
      />,
    );
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["toggle-node", "sidebar-node", "main-node", "right-node"]);
  });

  it("hub：把 sidebar / main / rightRail 交给 HubLayout（**右栏必须是 App 构造的那一个**）", () => {
    render(
      <WorkspaceFrame
        variant="hub"
        sidebar={node("sidebar-node")}
        main={node("main-node")}
        rightRail={node("right-node")}
        hub={{ rightRailOpen: true }}
      />,
    );
    expect(hubProps).toHaveLength(1);
    expect(hubProps[0].sidebar).toBeTruthy();
    expect(hubProps[0].mainPanel).toBeTruthy();
    /* 回归点：迁移前 hub 的右栏由 HubLayout 自渲染，App 的右栏节点根本传不进去 */
    expect(hubProps[0].rightRail).toBeTruthy();
    expect(screen.getByTestId("hub-right").querySelector('[data-testid="right-node"]')).toBeTruthy();
  });

  it("dream：sidebar / main / rightRail 按序作为 DreamLayout 的子节点", () => {
    render(
      <WorkspaceFrame variant="dream" sidebar={node("sidebar-node")} main={node("main-node")} rightRail={node("right-node")} />,
    );
    expect(dreamProps).toHaveLength(1);
    const order = Array.from(screen.getByTestId("dream-layout").querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order).toEqual(["sidebar-node", "main-node", "right-node"]);
  });
});

describe("WorkspaceMainColumn：节点顺序与渲染条件", () => {
  it("外层结构是 main-area > panel-right > panel-content", () => {
    const { container } = render(<WorkspaceMainColumn {...mainColumnProps()} />);
    expect(container.querySelector(".main-area > .panel-right > .panel-content")).toBeTruthy();
  });

  it("只有 chat/terminal 页签才渲染会话槽位；终端抽屉只在 terminal 页签", () => {
    const { container, rerender } = render(<WorkspaceMainColumn {...mainColumnProps({ bottomTab: "files" })} />);
    expect(container.querySelector('[data-testid="slot-app.conversation"]')).toBeNull();
    expect(container.querySelector(".terminal-drawer")).toBeNull();

    rerender(<WorkspaceMainColumn {...mainColumnProps({ bottomTab: "terminal" })} />);
    expect(container.querySelector('[data-testid="slot-app.conversation"]')).toBeTruthy();
    expect(container.querySelector(".terminal-drawer")).toBeTruthy();
    expect(screen.getByTestId("terminal-node")).toBeTruthy();
  });

  it("压缩横幅只在 sessionId 与当前会话一致时出现", () => {
    const { container, rerender } = render(
      <WorkspaceMainColumn {...mainColumnProps({ uiSessionId: "s-1", compactionStatus: { sessionId: "s-2", active: true } })} />,
    );
    expect(container.querySelector(".compaction-banner")).toBeNull();

    rerender(
      <WorkspaceMainColumn {...mainColumnProps({ uiSessionId: "s-1", compactionStatus: { sessionId: "s-1", active: true } })} />,
    );
    expect(container.querySelector(".compaction-banner")).toBeTruthy();
    expect(container.querySelector(".compaction-banner")!.textContent).toContain("正在压缩上下文");
  });

  it("笔记本横幅的三颗按钮都在（保存 / 返回工作区 / 关闭），关闭会清空三个状态", () => {
    const calls: string[] = [];
    render(
      <WorkspaceMainColumn
        {...mainColumnProps({
          activeNotebookId: "nb-1",
          activeNotebookName: "笔记 A",
          setActiveNotebookId: () => calls.push("id"),
          setActiveNotebookName: () => calls.push("name"),
          setNotebookSourceFilter: () => calls.push("filter"),
        })}
      />,
    );
    const banner = document.querySelector(".notebook-mode-banner")!;
    expect(banner.textContent).toContain("笔记本模式：笔记 A");
    expect(banner.querySelectorAll("button")).toHaveLength(3);
    (banner.querySelector(".notebook-mode-close") as HTMLButtonElement).click();
    expect(calls).toEqual(["id", "name", "filter"]);
  });
});

describe("App.tsx：三份主区已收成一份（防回退）", () => {
  const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
  /* 收口后这些块分布在两处：App（构造节点）与 WorkspaceFrame（主列实现）。判据按"两处合计"数。 */
  const frame = readFileSync(join(__dirname, "..", "components", "workspace", "WorkspaceFrame.tsx"), "utf8");
  const all = app + frame;
  const count = (needle: string) => all.split(needle).length - 1;

  it("会话槽位 / 终端抽屉 / 右栏槽位在 App 里各只出现一次", () => {
    expect(count('name="app.conversation"'), "会话槽位又被复制了一份").toBe(1);
    expect(count('name="app.terminal"'), "终端槽位又被复制了一份").toBe(1);
    expect(count('name="app.right-sidebar"'), "右栏槽位又被复制了一份").toBe(1);
    expect(count('"terminal-drawer"'), "终端抽屉的 DOM 又出现了一份").toBe(1);
  });

  it("三个皮肤分支都走 WorkspaceFrame（而不是各写一遍布局）", () => {
    expect(app.split("renderWorkspace()").length - 1, "App 里没有调用 renderWorkspace()").toBe(1);
    expect(app.split('variant="hub"').length - 1).toBe(1);
    expect(app.split('variant="dream"').length - 1).toBe(1);
    expect(app.split('variant="default"').length - 1).toBe(1);
    expect(app).toContain("WorkspaceMainColumn");
  });

  it("App 不再自己渲染 RightSidebar / HubLayout / DreamLayout（都收进 WorkspaceFrame）", () => {
    expect(app.split("<RightSidebar").length - 1).toBe(0);
    expect(app.split("<HubLayout").length - 1).toBe(0);
    expect(app.split("<DreamLayout").length - 1).toBe(0);
  });
});
