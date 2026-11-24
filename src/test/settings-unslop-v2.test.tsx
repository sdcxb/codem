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
});
