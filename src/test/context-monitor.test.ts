/**
 * 测试 7：ContextMonitor getConfiguredProviders 从 codem-settings 读取
 *
 * 改动影响：
 *   - ContextMonitor.tsx 的 getConfiguredProviders 从 localStorage.getItem("mimo-settings") 改为 getSettingJSON("codem-settings")
 *   - 如果有误，余额查询面板无法读取 provider 配置，导致无法查询 DeepSeek 余额等
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";

// 模拟 ContextMonitor.tsx 中的 getConfiguredProviders 函数
function getConfiguredProviders(): Array<{ id: string; name: string; apiKey: string; baseUrl: string }> {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    if (!settings.providers) return [];
    return settings.providers.filter((p: any) => p.apiKey && p.id !== "mimo");
  } catch {
    return [];
  }
}

describe("ContextMonitor — getConfiguredProviders 从 codem-settings 读取", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("无设置时返回空数组", () => {
    const providers = getConfiguredProviders();
    expect(providers).toEqual([]);
  });

  it("读取有 API Key 的 provider（排除 mimo）", () => {
    setSettingJSON("codem-settings", {
      mode: "api",
      providers: [
        { id: "mimo", name: "MiMo", apiKey: "mimo-key", baseUrl: "https://api.mimo.ai/v1" },
        { id: "openai", name: "OpenAI", apiKey: "sk-xxx", baseUrl: "https://api.openai.com/v1" },
        { id: "deepseek", name: "DeepSeek", apiKey: "ds-key", baseUrl: "https://api.deepseek.com/v1" },
        { id: "anthropic", name: "Anthropic", apiKey: "", baseUrl: "https://api.anthropic.com/v1" },
      ],
    });

    const providers = getConfiguredProviders();
    // mimo 被排除，anthropic 没 apiKey 被排除
    expect(providers).toHaveLength(2);
    expect(providers[0].id).toBe("openai");
    expect(providers[1].id).toBe("deepseek");
  });

  it("只读 codem-settings，不读旧的 mimo-settings", () => {
    // 旧 key 不应该被读取
    localStorage.setItem("mimo-settings", JSON.stringify({
      providers: [{ id: "openai", name: "OpenAI", apiKey: "old-key", baseUrl: "" }],
    }));

    // 新 key 有不同数据
    setSettingJSON("codem-settings", {
      providers: [{ id: "openai", name: "OpenAI", apiKey: "new-key", baseUrl: "" }],
    });

    const providers = getConfiguredProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].apiKey).toBe("new-key");
  });

  it("空 providers 数组返回空", () => {
    setSettingJSON("codem-settings", { mode: "api", providers: [] });
    expect(getConfiguredProviders()).toEqual([]);
  });

  it("所有 provider 都没 apiKey 时返回空", () => {
    setSettingJSON("codem-settings", {
      providers: [
        { id: "openai", name: "OpenAI", apiKey: "", baseUrl: "" },
        { id: "deepseek", name: "DeepSeek", apiKey: "", baseUrl: "" },
      ],
    });
    expect(getConfiguredProviders()).toEqual([]);
  });
});
