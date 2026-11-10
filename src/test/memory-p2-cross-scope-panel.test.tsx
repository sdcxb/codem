/**
 * 任务 B：**跨作用域检索的面板入口**（24 §P2 残余子集）—— `MemoryManager` 的只读「跨项目搜索」。
 *
 * ## 被守的形态（改前）
 *
 * 跨项目检索只在工具面存在（`memory_search` + `scopeMode=all`）：面板里既没有开关，也没有
 * 项目选择与查询入口，用户无法回答"上周在另一个项目里定过的那条约定还能不能找回来"。
 *
 * 这一组判据钉住：
 * 1. **默认关闭**：一进面板不显示跨项目输入，不会自动跨项目查询；
 * 2. **开关 + 现有项目列表**：打开后出现项目 id 输入（带现有项目 datalist）与查询框；
 * 3. **必填校验**：没有 projectId 时搜索按钮禁用、并给出可读提示（不把缺参查询渲染成"没有记忆"）；
 * 4. **结果归属**：只返回 platform + 选定项目；每条命中自带 scope / project / session；
 * 5. **空态 / 错误可见**：0 条与失败是两种不同的事实，都必须在界面上说清楚；
 * 6. **只读**：整块没有任何编辑/删除动作，检索期间不写任何数据（`__writes()` 不增长）。
 *
 * ## 变异自证
 *
 * 把 `handleCrossScopeSearch` 里的目标项目换成面板自己的 `projectId`（= 忽略用户选的项目）
 * ⇒ 第 4 条红（alpha 的条目出现、beta 的条目消失）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getMemoryService } from "../core/memory/memory";

const PROJ_A = "c:\\work\\panel-alpha";
const PROJ_B = "c:\\work\\panel-beta";
const SESSION = "s-panel-cross";

let port: FakeStoragePort;

function byTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function enableCrossScope(container: HTMLElement): void {
  const toggle = byTestId(container, "memory-cross-scope-toggle") as HTMLInputElement | null;
  expect(toggle, "跨项目搜索开关必须存在").not.toBeNull();
  fireEvent.click(toggle!);
}

describe("任务 B：记忆面板的跨项目搜索入口（只读）", () => {
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 强制走 settings 回退：镜像路径由既有 P2-A/P2-C 判据覆盖，这里只关心面板接线
    port = createFakeStoragePort({ failCommands: ["memories.search"] });
    setStoragePort(port);
    const svc = getMemoryService();
    await svc.reload();
    svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "alpha 构建约定",
      content: "alpha 项目跑 build-a",
      source: "manual",
    });
    svc.add({
      scope: "project",
      projectId: PROJ_B,
      key: "beta 构建约定",
      content: "beta 项目跑 build-b",
      source: "manual",
    });
    svc.add({ scope: "platform", key: "全局构建约定", content: "所有项目统一用中文（平台级）", source: "manual" });
  });

  afterEach(() => {
    cleanup();
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  async function renderPanel() {
    const { MemoryManager } = await import("../components/MemoryManager");
    return render(
      createElement(MemoryManager, {
        onClose: () => {},
        projectId: PROJ_A,
        sessionId: SESSION,
        projects: [
          { id: PROJ_A, name: "Alpha" },
          { id: PROJ_B, name: "Beta" },
        ],
      } as never),
    );
  }

  /*
   * 计时口径：B1 是文件里**第一个**动态 import `MemoryManager` 的用例（冷启动要现场编译
   * 整棵组件图）。实测 4.3–5.1s 抖动 ⇒ 默认 5s 在满载/冷缓存时假红。这里只放宽**计时**，
   * 断言一条不减。
   */
  it("B1 默认关闭；打开后有现有项目可选，无 projectId 时禁用搜索并提示", async () => {
    const { container } = await renderPanel();

    const toggle = byTestId(container, "memory-cross-scope-toggle") as HTMLInputElement;
    expect(toggle, "开关必须存在于面板").not.toBeNull();
    expect(toggle.checked, "跨项目检索默认关闭（不许一进面板就跨项目查询）").toBe(false);
    expect(byTestId(container, "memory-cross-scope-project"), "关闭时不显示项目输入").toBeNull();

    enableCrossScope(container);
    expect(byTestId(container, "memory-cross-scope-project"), "打开后出现项目 id 输入").not.toBeNull();
    expect(byTestId(container, "memory-cross-scope-query"), "打开后出现查询框").not.toBeNull();

    const searchBtn = byTestId(container, "memory-cross-scope-search") as HTMLButtonElement;
    expect(searchBtn.disabled, "没有 projectId ⇒ 搜索按钮禁用").toBe(true);
    expect(byTestId(container, "memory-cross-scope-hint")?.textContent ?? "").toContain("必须显式给出范围");

    // 现有项目列表（由 App 从项目 store 传入）应出现在 datalist 里
    const options = Array.from(container.querySelectorAll("#memory-cross-scope-projects option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toContain(PROJ_B);
    expect(options).toContain(PROJ_A);
  }, 15_000);

  it("B2 结果只属于 platform + 选定项目，且每条带 scope/project/session；空结果是可见空态", async () => {
    const { container } = await renderPanel();
    enableCrossScope(container);

    fireEvent.change(byTestId(container, "memory-cross-scope-project")!, { target: { value: PROJ_B } });
    fireEvent.change(byTestId(container, "memory-cross-scope-query")!, { target: { value: "构建约定" } });
    const searchBtn = byTestId(container, "memory-cross-scope-search") as HTMLButtonElement;
    expect(searchBtn.disabled, "填了 projectId ⇒ 按钮可用").toBe(false);
    fireEvent.click(searchBtn);

    await waitFor(() => {
      expect(byTestId(container, "memory-cross-scope-result"), "检索结果必须渲染").not.toBeNull();
    });
    const rows = Array.from(container.querySelectorAll('[data-testid="memory-cross-scope-result"]'));
    expect(rows.map((r) => r.textContent ?? "").join("\n")).toContain("beta 构建约定");
    // 关键：不许把本面板所在项目（alpha）的结果混进跨项目检索
    for (const row of rows) {
      expect(row.textContent ?? "", "别的项目（面板所在项目）的条目不许出现").not.toContain("alpha 构建约定");
    }
    // 归属必须逐条写在行上（scope 只有三个值，分不清是哪个项目）
    const betaRow = rows.find((r) => (r.textContent ?? "").includes("beta 构建约定"))!;
    expect(betaRow.getAttribute("data-scope")).toBe("project");
    expect(betaRow.getAttribute("data-project")).toBe(PROJ_B);
    expect(betaRow.getAttribute("data-session")).toBe("");
    const platformRow = rows.find((r) => (r.textContent ?? "").includes("全局构建约定"))!;
    expect(platformRow.getAttribute("data-scope")).toBe("platform");
    expect(platformRow.getAttribute("data-project")).toBe("");

    // 空态：换成查不到的词 ⇒ 必须说"没有匹配"（不是一片空白）
    fireEvent.change(byTestId(container, "memory-cross-scope-query")!, { target: { value: "绝不存在的词" } });
    fireEvent.click(byTestId(container, "memory-cross-scope-search")!);
    await waitFor(() => {
      expect(byTestId(container, "memory-cross-scope-empty"), "0 条要显示空态").not.toBeNull();
    });
    expect(container.querySelectorAll('[data-testid="memory-cross-scope-result"]').length).toBe(0);
  });

  it("B3 错误可见：空查询 / 服务失败都不会被吞掉", async () => {
    const { container } = await renderPanel();
    enableCrossScope(container);

    fireEvent.change(byTestId(container, "memory-cross-scope-project")!, { target: { value: PROJ_B } });
    fireEvent.click(byTestId(container, "memory-cross-scope-search")!);
    await waitFor(() => {
      expect(byTestId(container, "memory-cross-scope-error")?.textContent ?? "").toContain("请输入查询词");
    });

    const svc = getMemoryService();
    const spy = vi.spyOn(svc, "searchAcrossScopes").mockRejectedValueOnce(new Error("引擎不可用"));
    fireEvent.change(byTestId(container, "memory-cross-scope-query")!, { target: { value: "构建约定" } });
    fireEvent.click(byTestId(container, "memory-cross-scope-search")!);
    await waitFor(() => {
      const text = byTestId(container, "memory-cross-scope-error")?.textContent ?? "";
      expect(text, "失败必须如实显示，不许当成空结果").toContain("跨项目检索失败");
      expect(text).toContain("引擎不可用");
    });
    spy.mockRestore();
  });

  it("B4 只读：整块没有编辑/删除动作，检索期间不写任何数据", async () => {
    const svc = getMemoryService();
    await svc.flushPendingPersist();
    const writesBefore = port.__writes().length;

    const { container } = await renderPanel();
    enableCrossScope(container);

    const block = byTestId(container, "memory-cross-scope")!;
    // 唯一允许的按钮是「搜索」（项目/查询都是输入框）
    const buttons = Array.from(block.querySelectorAll("button"));
    expect(buttons.length, "跨项目检索块只该有一个按钮（搜索）").toBe(1);
    expect(buttons[0].getAttribute("data-testid")).toBe("memory-cross-scope-search");

    fireEvent.change(byTestId(container, "memory-cross-scope-project")!, { target: { value: PROJ_B } });
    fireEvent.change(byTestId(container, "memory-cross-scope-query")!, { target: { value: "构建约定" } });
    fireEvent.click(byTestId(container, "memory-cross-scope-search")!);
    await waitFor(() => {
      expect(byTestId(container, "memory-cross-scope-result")).not.toBeNull();
    });
    // 命中条目上没有任何动作按钮（跨项目命中的误删代价太高）
    expect(block.querySelector('[data-testid="memory-cross-scope-result"] button')).toBeNull();
    expect(port.__writes().length, "跨项目检索是只读的，不该产生任何写命令").toBe(writesBefore);
  });
});
