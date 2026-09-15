/**
 * 引擎侧的目录注入范围 —— 「配了 key 但没刷新过」也不能丢内置目录（第 81 波）
 *
 * 真实缺陷（自查发现）：`LLMEngine.loadDynamicModels()` 原来只遍历 `codem-dynamic-models`
 * 缓存里的键。而缓存是在**用户点刷新**时才写入的 —— 配好 key 却一次没刷新的机器上，
 * 缓存里连 `deepseek` 这个键都没有，于是目录模型一个都注入不进去：
 *
 *   界面侧（走 getMergedDynamicModels）能看到 `deepseek-v4-flash-vision-exp`，
 *   引擎侧 provider.dynamicModels 里却没有它 → 选中后按默认窗口/默认能力跑。
 *
 * 同一个名单必须在界面与引擎两处一致，否则就是"看得见摸不着"。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
}));

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: vi.fn((key: string, fallback: unknown) => (key in mocks.store ? mocks.store[key] : fallback)),
  setSettingJSON: vi.fn((key: string, value: unknown) => {
    mocks.store[key] = value;
  }),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
  removeSetting: vi.fn(),
}));

import { LLMEngine } from "../core/llm/index";

/** 引擎默认就会注册好 deepseek 等内置 provider，直接用注册表里的那个 */
const dynamicIds = (engine: LLMEngine, id: string): string[] =>
  ((engine.providers.get(id) as any)?.dynamicModels || []).map((m: any) => m.id);

beforeEach(() => {
  mocks.store = {};
});

describe("引擎的模型注入范围（界面与引擎必须同源）", () => {
  it("ENG-1: 缓存为空（从没点过刷新）时，内置目录仍要注入到 provider.dynamicModels", () => {
    const engine = new LLMEngine();
    engine.loadDynamicModels();
    const models = (engine.providers.get("deepseek") as any)?.dynamicModels || [];
    const ids = models.map((m: any) => m.id);
    expect(ids, "目录里的视觉模型必须被引擎认识").toContain("deepseek-v4-flash-vision-exp");
    expect(ids).toContain("deepseek-v4-pro");
    // 标记来源，便于排查
    expect(models.find((m: any) => m.id === "deepseek-v4-flash-vision-exp")?.catalogOnly).toBe(true);
  });

  it("ENG-2: 缓存里只有服务器两条时，注入 = 服务器 ∪ 目录（旧名不重复）", () => {
    mocks.store["codem-dynamic-models"] = {
      deepseek: [
        { id: "deepseek-flash", name: "deepseek-flash" },
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
      ],
    };
    const engine = new LLMEngine();
    engine.loadDynamicModels();
    const ids = dynamicIds(engine, "deepseek");
    expect(ids).toContain("deepseek-flash");
    expect(ids).toContain("deepseek-v4-flash-vision-exp");
    expect(ids, "已改名的旧名不该与服务器当前名同时出现").not.toContain("deepseek-v4-flash");
  });

  it("ENG-3: 缓存里的旧数据照样补 contextWindow（迁移不被新的遍历方式弄丢）", () => {
    mocks.store["codem-dynamic-models"] = {
      deepseek: [{ id: "deepseek-flash", name: "deepseek-flash" }],
    };
    const engine = new LLMEngine();
    engine.loadDynamicModels();
    const flash = ((engine.providers.get("deepseek") as any)?.dynamicModels || []).find(
      (m: any) => m.id === "deepseek-flash",
    );
    expect(flash?.contextWindow).toBeGreaterThan(0);
    // 回填只写服务器缓存，不把目录条目写进缓存（缓存只存服务器事实）
    const persisted = mocks.store["codem-dynamic-models"] as any;
    expect(persisted.deepseek.map((m: any) => m.id)).toEqual(["deepseek-flash"]);
  });

  it("ENG-4: 目录里没有、注册表里也没有的 provider 不会让注入报错，也不会被塞进目录条目", () => {
    mocks.store["codem-dynamic-models"] = {
      "my-provider": [{ id: "my-model", name: "my-model" }],
    };
    const engine = new LLMEngine();
    expect(() => engine.loadDynamicModels()).not.toThrow();
    expect(dynamicIds(engine, "my-provider")).toEqual([]);
  });
});
