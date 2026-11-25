/**
 * design/unslop-v2 · 设置页「去 emoji + 主次层级 + 模型全名」判据。
 *
 * 被守的形态（本轮之前）：
 * - 页面标题/分组标题/按钮用 emoji 当图标（`⚙️ 设置`、`♻️`、`👤`、`💬`、`📊`、`🔄`…），
 *   与旁边的 lucide 线性图标混用；
 * - 底栏「会话恢复 / 用量统计」与「保存设置」共用 `.save-btn` ⇒ 三颗按钮同权重，
 *   用户分不清哪一个是主操作；
 * - 模型下拉被 flex 压窄后收起态只显示 `OpenAI - G…`，且没有 `title` 给出全名。
 *
 * 本轮约定：
 * - 只清 **chrome** 的 emoji；身份头像 `identity.emoji` 那组选择器保留（它不是 chrome）；
 * - 主操作只有「保存设置」；另外两颗降级为 `.settings-footer-action--secondary`，
 *   不再带 `.save-btn`（否则 unslop-v2.css 会把它们涂成主色）；
 * - 模型值/业务逻辑一个字不动，只补 `title` 与语义 class（样式由集成方补）。
 *
 * 第二轮收口（本轮新增 SU-7/SU-8）：
 * - 底栏是**一个 action bar**：次操作（会话恢复/用量统计）一组在左、主操作（保存设置）一组在右；
 *   结构与 class 是本次交付，sticky 视觉由集成 CSS 落地；
 * - 模型行下方的「配置方案」不再是和下拉并排的第二个字段，而是字段行内的附加动作行：
 *   与下拉左缘对齐，且不改 select 的宽度/落库逻辑。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { setSettingJSON } from "../core/storage/settings";
import { SettingsPanel } from "../components/SettingsPanel";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.setConfig({ testTimeout: 15000 });

async function installPort(): Promise<void> {
  const port = createFakeStoragePort();
  // 与真启动顺序一致：端口注册前配置面已经可读
  await port.config.warmup();
  setStoragePort(port);
}

beforeEach(async () => {
  localStorage.clear();
  await installPort();
  setSettingJSON("codem-settings", {
    mode: "api",
    model: "gpt-4o",
    provider: "openai",
    fontSize: 13,
    language: "zh",
    providers: [
      { id: "openai", name: "OpenAI", apiKey: "sk-test-unslop", baseUrl: "https://api.openai.com/v1" },
    ],
  });
});

afterEach(() => {
  cleanup();
  setStoragePort(null);
  vi.restoreAllMocks();
});

function renderPanel(initialTab?: string, handlers?: { onSessionRecovery?: () => void; onUsageStats?: () => void }) {
  return render(
    createElement(SettingsPanel, {
      onClose: () => {},
      initialTab,
      ...handlers,
    } as never),
  );
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => (button.textContent ?? "").trim() === text,
  );
}

describe("SETTINGS-UNSLOP：标题/按钮去 emoji，主操作唯一", () => {
  it("SU-1：页面标题是「设置」，不再带 ⚙️", () => {
    const { container } = renderPanel();
    const title = container.querySelector(".settings-header h3");
    expect(title, "弹窗模式应有标题").toBeTruthy();
    expect(title!.textContent).toBe("设置");
    expect(title!.textContent, "标题不许再用 emoji 当图标").not.toContain("⚙️");
  });

  it("SU-2：底栏只有「保存设置」是主操作；会话恢复/用量统计为次级且不带 save-btn", () => {
    const onSessionRecovery = vi.fn();
    const onUsageStats = vi.fn();
    const { container } = renderPanel(undefined, { onSessionRecovery, onUsageStats });

    const footer = container.querySelector(".settings-footer");
    expect(footer, "应渲染设置底栏").toBeTruthy();

    const save = buttonByText(container, "保存设置");
    expect(save, "保存设置必须还在").toBeTruthy();
    expect(save!.classList.contains("settings-footer-action--primary"), "保存必须是主操作").toBe(true);
    expect(save!.classList.contains("save-btn"), "主操作保留既有 save-btn 视觉").toBe(true);

    const secondary = Array.from(footer!.querySelectorAll<HTMLButtonElement>(".settings-footer-action--secondary"));
    expect(secondary, "会话恢复与用量统计都要保留").toHaveLength(2);
    expect(secondary.map((b) => (b.textContent ?? "").trim())).toEqual(["会话恢复", "用量统计"]);
    for (const button of secondary) {
      expect(button.classList.contains("save-btn"), `${button.textContent} 不许再和保存同权重`).toBe(false);
      expect(button.textContent ?? "", `${button.textContent} 不许再带 emoji`).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }

    act(() => {
      fireEvent.click(secondary[0]);
      fireEvent.click(secondary[1]);
    });
    expect(onSessionRecovery, "降级只改层级，行为不能丢").toHaveBeenCalledTimes(1);
    expect(onUsageStats, "降级只改层级，行为不能丢").toHaveBeenCalledTimes(1);
  });

  it("SU-3：模型下拉带语义 class 与完整「供应商 - 模型」title（值不变）", () => {
    const { container } = renderPanel();
    const select = container.querySelector<HTMLSelectElement>(".settings-model-select");
    expect(select, "模型下拉应有语义 class 供集成方加最小宽度").toBeTruthy();
    expect(select!.classList.contains("sp-select-flex"), "既有布局 class 不能被拿掉").toBe(true);
    expect(select!.title, "收起态截断时 title 必须能给出全名").toBe("OpenAI - gpt-4o");
    expect(select!.value, "模型值/落库字段不许被这轮改动").toContain("gpt-4o");
  });

  it("SU-4：安全页的恢复入口/权限规则/模式按钮已去 chrome emoji（功能仍在）", () => {
    const { container } = renderPanel("security");
    const reset = buttonByText(container, "恢复默认界面设置");
    expect(reset, "恢复默认入口必须保留").toBeTruthy();
    expect(container.textContent, "权限规则仍在").toContain("权限规则");
    for (const forbidden of ["♻️", "🔐", "🛡️", "⚡", "🚀"]) {
      expect(container.textContent, `安全页可见文本不许再出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("SU-5：通用页的沙箱模式标签已去 🔒，且勾选框仍可用", () => {
    const { container } = renderPanel();
    const sandbox = Array.from(container.querySelectorAll("label")).find((label) =>
      (label.textContent ?? "").includes("沙箱模式"),
    );
    expect(sandbox, "沙箱模式文案必须保留").toBeTruthy();
    expect(sandbox!.textContent, "去 emoji 不能顺手删功能文案").toContain("沙箱模式");
    expect(sandbox!.textContent, "标签不许再带 🔒").not.toContain("🔒");
    expect(sandbox!.querySelector("input[type=checkbox]"), "开关本身不能丢").toBeTruthy();
  });

  it("SU-6：四个分组标题的 emoji 已清（字号/颜色仍由既有 sp-title 承担）", () => {
    const source = readFileSync(join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");
    for (const heading of [
      "👤 Agent Profile 管理",
      "💬 Transcript 缓存统计",
      "📊 实测效果（7 个真实项目基准）",
      "♻️ 恢复默认界面设置",
    ]) {
      expect(source, `标题不该再用 emoji：${heading}`).not.toContain(heading);
    }
  });

  it("SU-7：底栏是一个 action bar —— 次操作一组在左、主操作一组在右（回调不变）", () => {
    const onSessionRecovery = vi.fn();
    const onUsageStats = vi.fn();
    const { container } = renderPanel(undefined, { onSessionRecovery, onUsageStats });

    const bar = container.querySelector<HTMLElement>(".settings-footer .settings-action-bar");
    expect(bar, "底栏要有明确的 action bar 容器（供集成 CSS 做 sticky）").toBeTruthy();
    expect(bar!.classList.contains("settings-footer-inner"), "既有底栏几何 class 不能丢").toBe(true);
    expect(bar!.getAttribute("role"), "动作条用分组语义").toBe("group");
    expect(bar!.getAttribute("style"), "不新增内联样式").toBeNull();

    const secondary = bar!.querySelector<HTMLElement>(".settings-action-bar__secondary");
    const primary = bar!.querySelector<HTMLElement>(".settings-action-bar__primary");
    expect(secondary, "次操作要有独立分组").toBeTruthy();
    expect(primary, "主操作要有独立分组").toBeTruthy();

    /* 左次右主：DOM 顺序上主组是 bar 的最后一个子元素（flex 两端对齐） */
    expect(bar!.firstElementChild, "次操作组在左").toBe(secondary);
    expect(bar!.lastElementChild, "主操作组在右").toBe(primary);
    expect(secondary!.querySelectorAll(".settings-footer-action--secondary")).toHaveLength(2);
    expect(primary!.querySelectorAll(".settings-footer-action--primary")).toHaveLength(1);
    expect(primary!.querySelector(".save-btn"), "主操作仍是 save-btn").toBeTruthy();

    /* 主组里只有保存设置是按钮（已保存/失败提示是文本，不是动作） */
    expect(primary!.querySelectorAll("button")).toHaveLength(1);

    /* 行为不变：点击仍然调用原回调 */
    const secondaryButtons = [...secondary!.querySelectorAll<HTMLButtonElement>("button")];
    expect(secondaryButtons.map((b) => (b.textContent ?? "").trim())).toEqual(["会话恢复", "用量统计"]);
    act(() => {
      fireEvent.click(secondaryButtons[0]);
      fireEvent.click(secondaryButtons[1]);
    });
    expect(onSessionRecovery).toHaveBeenCalledTimes(1);
    expect(onUsageStats).toHaveBeenCalledTimes(1);
  });

  it("SU-8：模型行下方「配置方案」是字段内的附加动作行（与下拉左对齐，select 逻辑不变）", () => {
    const { container } = renderPanel();

    const select = container.querySelector<HTMLSelectElement>(".settings-model-select");
    expect(select, "模型下拉仍在").toBeTruthy();
    const row = select!.parentElement as HTMLElement;
    expect(row.classList.contains("settings-model-row"), "字段行有语义 class").toBe(true);
    expect(row.classList.contains("sp-row"), "既有布局 class 不能拿掉").toBe(true);

    /* 配置方案不再与 select 平级（那会被当成第二个字段/被挤到右侧） */
    const profiles = row.querySelector<HTMLElement>(".settings-model-profiles");
    expect(profiles, "配置方案应在字段行内部作为附加动作行").toBeTruthy();
    const profilesButton = profiles!.querySelector("button");
    expect(profilesButton?.textContent).toContain("配置方案");
    expect(profilesButton!.classList.contains("sp-btn--secondary"), "仍复用既有次按钮样式").toBe(true);
    expect(row.children.length, "字段行 = 下拉 + 附加动作行（两格）").toBe(2);
    expect(row.lastElementChild, "附加动作行在下拉之后（视觉上位于其下方）").toBe(profiles);

    /* 模型值/落库字段没有被这轮结构改动 */
    expect(select!.value).toContain("gpt-4o");
    expect(select!.classList.contains("sp-select-flex")).toBe(true);

    /* 入口行为不变：点开仍是原来的配置方案面板（面板走 portal 挂到 body） */
    fireEvent.click(profilesButton!);
    expect(document.querySelector(".mp-panel"), "配置方案面板仍能打开").toBeTruthy();
  });
});
