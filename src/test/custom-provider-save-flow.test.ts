/**
 * CUSTPROV：自定义 Provider 的「添加」必须并入规范保存流程。
 *
 * ## 缺陷形态（2026-10-18 用户拍板修）
 *
 * `addCustomProvider` 原来直接 `setSettingJSON("codem-settings", newSettings)`：
 * 没有 `beginSettingsWriteProbe()` / `flushSettingsWrites()` 的写后确认，
 * 没有以库值为基座合并（`buildSavePayload`），也没有 `dirtyLocalFields` 结账。
 * 后果与 provider 卡片那次"假保存"同类：**界面显示已添加，库里可能没有**。
 *
 * 判据：纯逻辑（输入 → provider）+ 源码级控制流（必须 `await handleSave(newSettings)`、
 * 未确认不得收起表单、不得再裸写）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { appendCustomProvider } from "../core/settings/custom-provider";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "components", "SettingsPanel.tsx"), "utf8");

describe("CUSTPROV 自定义 Provider 保存", () => {
  it("CUSTPROV-1: 输入去空格、id 走 custom- 前缀、带 custom 标记、不改原数组", () => {
    const before = [{ id: "mimo", name: "MiMo", apiKey: "", baseUrl: "https://api.mimo.ai/v1" }];
    const { providers, provider } = appendCustomProvider(before, {
      name: "  b.ai  ",
      baseUrl: " https://api.b.ai/v1 ",
      apiKey: "  sk-abc  ",
    }, 1700000000000);
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe("custom-1700000000000");
    expect(provider!.name).toBe("b.ai");
    expect(provider!.baseUrl).toBe("https://api.b.ai/v1");
    expect(provider!.apiKey).toBe("sk-abc");
    expect(provider!.custom).toBe(true);
    expect(providers).toHaveLength(2);
    expect(before).toHaveLength(1); // 原数组不变
  });

  it("CUSTPROV-2: 名称或 Base URL 为空 ⇒ 不生成 provider（列表原样副本）", () => {
    const before = [{ id: "mimo", name: "MiMo", apiKey: "", baseUrl: "x" }];
    expect(appendCustomProvider(before, { name: " ", baseUrl: "https://x", apiKey: "" }).provider).toBeNull();
    expect(appendCustomProvider(before, { name: "x", baseUrl: "  ", apiKey: "" }).provider).toBeNull();
    expect(appendCustomProvider(before, { name: "", baseUrl: "", apiKey: "" }).providers).toHaveLength(1);
  });

  it("CUSTPROV-3: 添加走 handleSave(新列表)，未确认不收起表单，且不再裸写", () => {
    const start = SRC.indexOf("const addCustomProvider = async () => {");
    expect(start, "addCustomProvider 应当存在").toBeGreaterThan(0);
    // 函数体结束在**两空格缩进**的 `};`（嵌套对象里的 `};` 缩进更深）
    const end = SRC.indexOf("\n  };", start);
    const body = SRC.slice(start, end + 4);
    expect(body, "必须把新列表显式传给 handleSave").toContain("handleSave(newSettings)");
    expect(body, "必须 await 保存确认").toMatch(/const confirmed = await handleSave\(newSettings\)/);
    expect(body, "未确认时不得收起表单/清空输入").toMatch(/if \(!confirmed\) return;/);
    expect(body, "不得再裸写 codem-settings（绕过写后确认）").not.toContain('setSettingJSON("codem-settings"');
    // 关闭表单必须发生在确认之后
    expect(body.indexOf("setShowAddCustom(false)")).toBeGreaterThan(body.indexOf("if (!confirmed) return;"));
  });

  it("CUSTPROV-4: handleSave 支持面板覆盖并以它为基座落库", () => {
    expect(SRC).toContain("const handleSave = async (panelOverride?: Settings): Promise<boolean> =>");
    expect(SRC).toContain("const panel = panelOverride ?? settings;");
    expect(SRC).toContain('setSettingJSON("codem-settings", buildSavePayload(panel));');
    expect(SRC).toContain("setLang(panel.language);");
  });
});
