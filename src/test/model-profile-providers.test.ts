/**
 * 方案面板（视觉/STT/嵌入槽位选择）的模型来源 —— 内置目录必须出现（第 81 波）
 *
 * 真实缺陷（自查发现）：`ModelProfilePanel` 原来只读 `codem-dynamic-models` 缓存，
 * 而**内置目录条目从来不在缓存里**（服务器 /models 不列它们，刷新时也只落服务器事实）。
 * 于是视觉槽位正指向的 `deepseek-v4-flash-vision-exp` 在"方案"面板的下拉里**选不到** ——
 * 同一台机器上"主设置里能看到、方案面板里看不到"，全看缓存里恰好有没有它。
 *
 * `model-catalog.ts` 的注释写的就是"界面与引擎统一走这里"（`getMergedDynamicModels`），
 * 这里之前漏了一处。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
}));

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: vi.fn((key: string, fallback: unknown) => (key in mocks.store ? mocks.store[key] : fallback)),
  setSettingJSON: vi.fn(),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
}));

import { buildAvailableProviders } from "../components/ModelProfilePanel";
import { getMergedDynamicModels } from "../core/llm/model-catalog";

const SERVER_ONLY_CACHE = {
  deepseek: [
    { id: "deepseek-flash", name: "deepseek-flash" },
    { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
  ],
};

beforeEach(() => {
  mocks.store = {};
});

describe("方案面板的 provider/模型列表", () => {
  it("MPS-1: 内置目录条目（服务器从不列、缓存里也没有）在方案面板里**必须能选到**", () => {
    mocks.store["codem-dynamic-models"] = SERVER_ONLY_CACHE;
    const providers = buildAvailableProviders(
      { providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "sk-x" }] },
      getMergedDynamicModels(),
    );
    const ds = providers.find((p) => p.id === "deepseek");
    expect(ds).toBeDefined();
    const ids = ds!.models.map((m) => m.id);
    expect(ids).toContain("deepseek-flash");
    expect(ids, "视觉槽位指向的目录模型必须可选").toContain("deepseek-v4-flash-vision-exp");
    // 与主设置的并集口径一致（3 条：服务器 2 + 目录补充 1）
    expect(ids).toHaveLength(3);
    // 来源标记跟着走，界面若要标注也有依据
    expect(ds!.models.find((m) => m.id === "deepseek-v4-flash-vision-exp")?.catalogOnly).toBe(true);
  });

  it("MPS-2: 没有 key 的 provider 不进列表；mimo 始终在（CLI 模式）", () => {
    const providers = buildAvailableProviders(
      { providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "" }, { id: "openai", name: "OpenAI", apiKey: "sk-y" }] },
      { openai: [{ id: "gpt-4o", name: "gpt-4o" }] },
    );
    expect(providers.map((p) => p.id)).toEqual(["mimo", "openai"]);
  });

  it("MPS-3: 缓存里没有该 provider 时回退到静态名单（有则用缓存+目录）", () => {
    const providers = buildAvailableProviders(
      { providers: [{ id: "gemini", name: "Gemini", apiKey: "k" }] },
      {},
      { gemini: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }] },
    );
    expect(providers.find((p) => p.id === "gemini")?.models.map((m) => m.id)).toEqual(["gemini-2.5-pro"]);
  });

  it("MPS-4: 手动添加的模型也必须在（不能被目录并集吃掉）", () => {
    // 手动添加的模型存在 `codem-custom-models`（列表形态：provider + name + addedAt）
    mocks.store["codem-custom-models"] = [
      { provider: "deepseek", name: "my-beta-model", addedAt: Date.now() },
    ];
    mocks.store["codem-dynamic-models"] = SERVER_ONLY_CACHE;
    const providers = buildAvailableProviders(
      { providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "sk-x" }] },
      getMergedDynamicModels(),
    );
    const ids = providers.find((p) => p.id === "deepseek")!.models.map((m) => m.id);
    expect(ids).toContain("my-beta-model");
  });
});
