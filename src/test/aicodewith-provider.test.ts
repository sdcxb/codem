/**
 * AICodeWith 接入判据：
 * 1. 只把文档明确走 OpenAI Chat Completions 的家族放进模型目录；
 * 2. 一把 AICodeWith key 的模型归属优先于 `gpt`/`deepseek` 等内置前缀，
 *    否则请求会被错误地路由到用户没配的原生 provider。
 */
import { describe, expect, it, vi } from "vitest";
import { createSettingsMock } from "./settings-mock";

const state: {
  settings: any;
  dynamic: Record<string, Array<{ id: string; name: string }>>;
} = {
  settings: { providers: [] },
  dynamic: {},
};

vi.mock("../core/storage/settings", () => ({
  ...createSettingsMock(),
  getSettingJSON: () => state.settings,
}));

vi.mock("../core/llm/model-catalog", () => ({
  getMergedDynamicModels: () => state.dynamic,
}));

import { getConfiguredApiModels, resolveProviderForModel } from "../core/model-config";
import { createDefaultProviders } from "../core/llm/provider";
import { isAICodeWithChatModel } from "../core/llm/aicodewith-protocols";

function defaults(providers: any[], dynamic: Record<string, Array<{ id: string; name: string }>>) {
  state.settings = { providers };
  state.dynamic = dynamic;
}

describe("AICODEWITH-1 模型目录过滤", () => {
  it("接受所有聊天模型，排除图像/视频生成模型", () => {
    for (const id of ["gpt-5.4", "deepseek-v4-flash", "glm-5.3", "kimi-k3", "claude-sonnet-4-6", "gemini-3-pro-preview"]) {
      expect(isAICodeWithChatModel(id), id).toBe(true);
    }
    for (const id of ["gpt-image-2", "nano-banana-2", "seedance-2", "veo-3.1"]) {
      expect(isAICodeWithChatModel(id), id).toBe(false);
    }
  });

  it("引擎里注册了 aicodewith，静态模型都是聊天模型且带模态", async () => {
    const registry = createDefaultProviders();
    const provider = registry.get("aicodewith");
    expect(provider, "必须有 aicodewith provider").toBeTruthy();
    const models = await provider!.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => isAICodeWithChatModel(m.id))).toBe(true);
    expect(models.find((m) => m.id.startsWith("claude"))?.inputModalities).toContain("image");
  });
});

describe("AICODEWITH-2 路由归属", () => {
  it("配了 AICodeWith key 时，gpt-5.4 归 aicodewith（不被 openai 前缀抢走）", () => {
    defaults(
      [
        { id: "openai", apiKey: "", baseUrl: "https://api.openai.com/v1" },
        { id: "aicodewith", apiKey: "sk-acw-test", baseUrl: "https://api.aicodewith.ai/v1" },
      ],
      { aicodewith: [{ id: "gpt-5.4", name: "GPT-5.4" }] },
    );
    expect(resolveProviderForModel("gpt-5.4")).toBe("aicodewith");
  });

  it("没配 AICodeWith key 时保持原生前缀行为", () => {
    defaults([{ id: "openai", apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1" }], {});
    expect(resolveProviderForModel("gpt-5.4")).toBe("openai");
  });

  it("模型列表包含 AICodeWith 的动态模型", () => {
    defaults(
      [{ id: "aicodewith", apiKey: "sk-acw-test", baseUrl: "https://api.aicodewith.ai/v1" }],
      { aicodewith: [{ id: "gpt-5.4", name: "GPT-5.4" }, { id: "glm-5.3", name: "GLM-5.3" }] },
    );
    const ids = getConfiguredApiModels().map((m) => m.id);
    expect(ids).toContain("gpt-5.4");
    expect(ids).toContain("glm-5.3");
  });
});
