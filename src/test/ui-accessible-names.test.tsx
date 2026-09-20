/**
 * 真机逐面板走查（`C:\mimo-gui\.preview-shot\audit-ui-walk.md`）量到的两类缺陷的**机器可复核**判据：
 *
 * 1. **16 个无名可交互控件**（按面板求和；最差是设置→工具页 7 个）：纯图标按钮
 *    (`usage-stats-close` / `memory-manager-close` / 任务中心关闭 / 记忆搜索 / `sp-toggle` / `toggle-entry`)
 *    里连 `aria-label`、`title`、文本都没有 ⇒ 读屏用户听到的只是"按钮"。
 * 2. **4 个面板"按可访问名找不到关闭按钮"**：任务中心 / 记忆管理 / library-ops 看板·场景·设置
 *    （后三者共用任务中心的那个无名纯图标关闭按钮）。
 *
 * 为什么写这条测试：修复后**必须能按名字找到并点中**，但真机复量只能等下一版出包
 * （当前运行中的构建不含本次改动）——所以把"按可访问名可达"钉在组件层，出包后再用走查脚本复量。
 *
 * 注意：任务中心用 `createPortal(panel, document.body)`（`TaskCenter.tsx:282`），所以查询一律
 * 在 `document.body` 上做、且每个用例前后 `cleanup()`，否则会量到上一个用例残留的 portal。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MemoryManager } from "../components/MemoryManager";
import { UsageStats } from "../components/UsageStats";
import { ToolManager } from "../components/ToolManager";
import { TaskCenter } from "../components/TaskCenter";
import { ToggleEntry } from "../components/SettingsParts";

afterEach(() => cleanup());

/** 按**可访问名**（aria-label / title / 文本）找元素，复刻走查脚本的口径 */
function findByAccessibleName(name: string): Element | null {
  const all = Array.from(document.body.querySelectorAll("button, [role=button], [role=switch]"));
  return (
    all.find((el) => {
      const label = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      const text = (el.textContent || "").trim();
      return label.includes(name) || title.includes(name) || text.includes(name);
    }) || null
  );
}

/** 有尺寸（排除 display:none / visibility:hidden）的控件里，`aria-label`/`title`/文本三者皆空的 */
function unnamedControls(): string[] {
  const unnamed: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll("button, [role=button], [role=switch]"))) {
    const html = el as HTMLElement;
    if (html.style.display === "none" || html.style.visibility === "hidden") continue;
    const label = el.getAttribute("aria-label") || "";
    const title = el.getAttribute("title") || "";
    const text = (el.textContent || "").trim();
    if (!label && !title && !text) {
      unnamed.push(`${el.tagName}.${el.className || "(no class)"} ${html.outerHTML.slice(0, 160)}`);
    }
  }
  return unnamed;
}

describe("走查缺陷：16 个无名控件里被点名的四类都必须补上可访问名", () => {
  it("R1 记忆管理：能按「关闭记忆管理」找到并点中", () => {
    const onClose = vi.fn();
    render(<MemoryManager onClose={onClose} />);
    expect(findByAccessibleName("关闭")).not.toBeNull();
    const btn = findByAccessibleName("关闭记忆管理");
    expect(btn, "记忆管理关闭按钮必须有不含歧义的可访问名").not.toBeNull();
    fireEvent.click(btn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("R2 任务中心（也是 library-ops 看板/场景/设置三视图的唯一关闭出口）：能按「关闭任务中心」找到并点中", () => {
    const onClose = vi.fn();
    render(<TaskCenter onClose={onClose} />);
    const btn = findByAccessibleName("关闭任务中心");
    expect(btn, "任务中心关闭按钮必须能按名字找到").not.toBeNull();
    fireEvent.click(btn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("R3 用量统计 / 工具管理：各自的关闭按钮都能按名字找到并点中（不是同一个糊名字）", () => {
    const onCloseUsage = vi.fn();
    render(<UsageStats onClose={onCloseUsage} />);
    const usageBtn = findByAccessibleName("关闭用量统计");
    expect(usageBtn).not.toBeNull();
    fireEvent.click(usageBtn!);
    expect(onCloseUsage).toHaveBeenCalledTimes(1);
    cleanup();

    const onCloseTools = vi.fn();
    render(<ToolManager onClose={onCloseTools} />);
    const toolsBtn = findByAccessibleName("关闭工具管理");
    expect(toolsBtn).not.toBeNull();
    fireEvent.click(toolsBtn!);
    expect(onCloseTools).toHaveBeenCalledTimes(1);
  });
});

describe("走查缺陷：无名可交互控件必须补上可访问名", () => {
  it("R4 记忆管理：搜索按钮（纯图标，无文本）有可访问名", () => {
    render(<MemoryManager onClose={() => {}} />);
    expect(findByAccessibleName("搜索记忆")).not.toBeNull();
  });

  it("R5 设置·语音：ToggleEntry（role=switch）的可访问名来自条目 label，不能只有 aria-checked", () => {
    const { container } = render(
      <ToggleEntry label="优先使用云端 TTS" description="x" value={false} onChange={() => {}} />,
    );
    const sw = container.querySelector('[role="switch"]')!;
    expect(sw).toBeTruthy();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-label")).toBe("优先使用云端 TTS");
  });
});

describe("走查缺陷：修复不得留下新的无名控件", () => {
  it("R6 设置·工具页：工具行的「启用/禁用」开关与「展开详情」按钮都有可访问名（走查量到该页 6 个 20×19 无名纯图标按钮）", () => {
    render(<ToolManager onClose={() => {}} />);
    const unnamed = unnamedControls();
    expect(unnamed, `工具管理里以下控件仍然没有可访问名：\n${unnamed.join("\n")}`).toEqual([]);
    // 两个按钮的名字都要能区分"哪一个工具"和"做什么动作"，不能糊成一个通用名
    expect(findByAccessibleName("点击禁用「bash」"), "启用/禁用开关缺名或名字不含工具名").not.toBeNull();
    expect(findByAccessibleName("展开详情「bash」"), "展开详情按钮缺名或名字不含工具名").not.toBeNull();
  });

  it("R7 四个面板的关闭按钮都不是无名控件（走查的 4 条「按可访问名找不到关闭」）", () => {
    const onClose = vi.fn();
    const panels: [string, string, () => void][] = [
      ["记忆管理", "关闭记忆管理", () => { render(<MemoryManager onClose={onClose} />); }],
      ["用量统计", "关闭用量统计", () => { render(<UsageStats onClose={onClose} />); }],
      ["工具管理", "关闭工具管理", () => { render(<ToolManager onClose={onClose} />); }],
      ["任务中心", "关闭任务中心", () => { render(<TaskCenter onClose={onClose} />); }],
    ];
    for (const [name, closeName, mount] of panels) {
      cleanup();
      mount();
      expect(findByAccessibleName(closeName), `${name} 的关闭按钮按名字找不到`).not.toBeNull();
    }
  });
});
