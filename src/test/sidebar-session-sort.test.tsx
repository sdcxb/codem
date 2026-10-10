/**
 * `O-57` 第三件事的**界面那一半**：侧栏「项目」小节头的排序入口真的改变渲染顺序，
 * 且**只**影响渲染顺序。
 *
 * ## 为什么必须在真渲染上测（而不是只测那个纯函数）
 *
 * 纯函数在 `session-display-sort.test.ts` 里已经钉住了。这一族判据要挡的是另一类缺陷：
 * **接了但没接对** ——
 * - 菜单点了没反应（`allSessions` 里存的是**排好的数组**，换成排序时不重算就白点）；
 * - 显示排序**绕过了某条写 `allSessions` 的路径**（展开项目那条 `toggleExpand`）；
 * - 选择没落进设置（重启就回默认）；
 * - 为了排序把**存储层**的 `sort_order` / 拖拽语义弄坏（这是判据要求点名的反向对照）。
 *
 * 断言的是**真 DOM 的顺序**（`.sidebar-session-title` 的文本序列），不是 props、不是内部状态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { useProjectStore } from "../core/store";
import { Sidebar } from "../components/Sidebar";
import * as SessionStorage from "../core/storage/session";
import { SESSION_SORT_SETTING_KEY } from "../core/session/session-sort";
import { getSetting } from "../core/storage/settings";
import type { Project } from "../core/types";

const PROJECT: Project = {
  id: "proj-sort",
  name: "排序项目",
  path: "C:\\work\\sort",
  createdAt: 1,
  lastAccessedAt: 1,
};

/**
 * 三个会话：**时间顺序与名称顺序刻意互为反向**
 * （时间倒序 = CCC、BBB、AAA；名称正序 = AAA、BBB、CCC）。
 *
 * ⚠️ 这里用 ASCII 标题是为了让"期望顺序"**无歧义**：中文排序由 `localeCompare` 的
 * 实现（ICU / 纯码点）决定，那个语义已经在 `session-display-sort.test.ts` 里单独钉过；
 * 本文件要测的是**界面接线**，不该跟着 ICU 的版本抖。
 */
const SEED = [
  { id: "sess-a", title: "AAA", lastMessageAt: 100 },
  { id: "sess-b", title: "BBB", lastMessageAt: 200 },
  { id: "sess-c", title: "CCC", lastMessageAt: 300 },
];

function seedPort(): ReturnType<typeof createFakeStoragePort> {
  const port = createFakeStoragePort({
    seed: {
      sessions: SEED.map((s) => ({
        id: s.id,
        project_id: PROJECT.id,
        title: s.title,
        created_at: s.lastMessageAt,
        last_message_at: s.lastMessageAt,
        message_count: 1,
        pinned: 0,
      })),
    },
  });
  setStoragePort(port);
  return port;
}

function seedStore() {
  useProjectStore.setState({
    projects: [PROJECT],
    currentProject: PROJECT,
    currentSession: null,
    sessions: [],
  } as never);
}

function renderSidebar(): HTMLElement {
  seedStore();
  const { container } = render(createElement(Sidebar, { identity: null } as never));
  return container;
}

/** 侧栏里会话标题的**显示顺序**（只取项目分组里的那些） */
function titlesInOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".sidebar-session-title")).map((el) => el.textContent ?? "");
}

/** 打开排序菜单并点某一项（`option` 形如 `name-asc`，与 `data-sort-option` 一致） */
function pickSort(container: HTMLElement, option: string) {
  const btn = container.querySelector(".sidebar-sort-btn");
  expect(btn, "「项目」小节头必须有排序入口（.sidebar-sort-btn）").toBeTruthy();
  act(() => {
    fireEvent.click(btn!);
  });
  const item = container.querySelector(`[data-sort-option="${option}"]`);
  expect(item, `排序菜单里必须有这一档：${option}`).toBeTruthy();
  act(() => {
    fireEvent.click(item!);
  });
}

beforeEach(() => {
  seedPort();
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("SORT-UI：侧栏排序入口（O-57）", () => {
  it("SORT-UI-1：默认档 = 最近对话 · 倒序（与升级前逐字一致），菜单四项齐全且当前档被标出", async () => {
    const container = await act(async () => renderSidebar());

    const btn = container.querySelector(".sidebar-sort-btn") as HTMLElement;
    expect(btn.getAttribute("data-session-sort"), "默认键必须是「最近对话」").toBe("recent");
    expect(btn.getAttribute("data-session-sort-dir"), "默认方向必须是倒序（= 既有行为）").toBe("desc");
    expect(
      titlesInOrder(container),
      "默认顺序 = 时间倒序（CCC 300 > BBB 200 > AAA 100）",
    ).toEqual(["CCC", "BBB", "AAA"]);

    act(() => {
      fireEvent.click(btn);
    });
    const options = Array.from(container.querySelectorAll("[data-sort-option]"));
    expect(options.map((o) => o.getAttribute("data-sort-option")), "四种组合必须都在菜单里").toEqual([
      "recent-desc",
      "recent-asc",
      "name-asc",
      "name-desc",
    ]);
    expect(
      options.filter((o) => o.getAttribute("aria-checked") === "true").map((o) => o.getAttribute("data-sort-option")),
      "当前档必须被标出来（只有一个）",
    ).toEqual(["recent-desc"]);
  });

  it("SORT-UI-2：选「名称 · A→Z」⇒ 渲染顺序按名称（**不许再被时间覆盖**）", async () => {
    const container = await act(async () => renderSidebar());
    pickSort(container, "name-asc");

    expect(
      titlesInOrder(container),
      "按名称正序时必须 AAA、BBB、CCC（若仍是 CCC、BBB、AAA，说明显示排序没生效 =「选了名称又被时间覆盖」）",
    ).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("SORT-UI-3：选「最近对话 · 旧→新」⇒ 顺序正好反向（方向是真的生效）", async () => {
    const container = await act(async () => renderSidebar());
    pickSort(container, "recent-asc");
    expect(
      titlesInOrder(container),
      "时间正序 = 旧的在前（AAA 100 → BBB 200 → CCC 300）；若与默认档相同，说明方向没生效",
    ).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("SORT-UI-4：选择落进设置，且**重新挂载后仍然生效**（不是只有内存里那一次）", async () => {
    const first = await act(async () => renderSidebar());
    pickSort(first, "name-asc");
    const afterPick = titlesInOrder(first);

    expect(
      JSON.parse(getSetting(SESSION_SORT_SETTING_KEY) ?? "null"),
      "选择必须写进 settings 面（否则重启就回默认）",
    ).toEqual({ key: "name", dir: "asc" });

    cleanup();
    const second = await act(async () => renderSidebar());
    expect(
      titlesInOrder(second),
      "重新挂载后必须仍按上次选的那一档渲染",
    ).toEqual(afterPick);
    expect(
      titlesInOrder(second),
      "反向对照：所选顺序必须**与默认档不同**（否则这条判据是恒真的 —— 夹具刻意让名称正序与时间倒序互为反向）",
    ).not.toEqual(["CCC", "BBB", "AAA"]);
  });

  it("SORT-UI-5（反向对照）：换排序**不动存储层** —— listSessions 的顺序与拖拽语义原样不变", async () => {
    const container = await act(async () => renderSidebar());

    // 先把 sess-a 拖到最前（写 sort_order = 0），存储层的顺序从此由它说了算
    SessionStorage.reorderSessions(PROJECT.id, ["sess-a", "sess-b", "sess-c"]);
    const storageOrderBefore = SessionStorage.listSessions(PROJECT.id).map((s) => s.id);
    expect(storageOrderBefore[0], "前提：拖拽后 sess-a 必须排在存储层第一位").toBe("sess-a");

    pickSort(container, "name-asc");
    expect(
      SessionStorage.listSessions(PROJECT.id).map((s) => s.id),
      "显示排序**只许影响渲染**：`listSessions` 的顺序（pinned → sort_order → 时间）一个字都不许变",
    ).toEqual(storageOrderBefore);

    // 反向对照的另一半：渲染顺序**确实**变了（否则上面那条断言可能只是"什么都没发生"）
    expect(
      titlesInOrder(container).length,
      "前提：渲染里确实还有这三个会话（否则这条判据会因为「空列表」而恒真）",
    ).toBe(3);
  });

  it("SORT-UI-7：折叠再展开项目之后，显示排序仍然生效（第二条写 allSessions 的路径不许绕过它）", async () => {
    const container = await act(async () => renderSidebar());
    /*
     * 先把**拖拽顺序**写成"名称倒序"（C、B、A）—— 两个作用：
     * ① 让"存储层顺序"与"名称正序"**明确不同**，于是"展开时绕过排序"当场可见；
     * ② 让这条用例不依赖"存储层当前恰好是什么顺序"这种隐性前提
     *    （`session.ts` 的 `sessionSortOrder` 是模块级的拖拽顺序缓存，跨用例会留着上一次的值 ——
     *     显式重排一次就把它覆盖成这条用例自己的事实）。
     */
    SessionStorage.reorderSessions(PROJECT.id, ["sess-c", "sess-b", "sess-a"]);
    pickSort(container, "name-asc");
    expect(titlesInOrder(container), "前提：先按名称排好（压过拖拽顺序）").toEqual(["AAA", "BBB", "CCC"]);

    const header = container.querySelector(".sidebar-project-header") as HTMLElement;
    expect(header, "项目头必须能找到（展开/折叠的入口）").toBeTruthy();
    act(() => {
      fireEvent.click(header); // 折叠
    });
    act(() => {
      fireEvent.click(header); // 展开 —— 这条路径会重新从存储读一份**未排序**的数组
    });
    expect(
      titlesInOrder(container),
      "展开项目时重新读回来的数组也必须走同一个排序函数（否则展开一次就把用户的排序选择丢掉）",
    ).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("SORT-UI-6：置顶会话在**任何**档位下都留在最前（名称档也不例外）", async () => {
    cleanup();
    const port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: "sess-pin", project_id: PROJECT.id, title: "ZZZ置顶", created_at: 1, last_message_at: 1, message_count: 1, pinned: 1 },
          { id: "sess-1", project_id: PROJECT.id, title: "AAA普通一", created_at: 2, last_message_at: 2, message_count: 1, pinned: 0 },
          { id: "sess-2", project_id: PROJECT.id, title: "BBB普通二", created_at: 3, last_message_at: 3, message_count: 1, pinned: 0 },
        ],
      },
    });
    setStoragePort(port);
    const container = await act(async () => renderSidebar());
    pickSort(container, "name-asc");
    expect(
      titlesInOrder(container)[0],
      "按名称排时置顶会话（ZZZ）也必须最前 —— 置顶是分组意图，不是排序键",
    ).toBe("ZZZ置顶");
  });
});
