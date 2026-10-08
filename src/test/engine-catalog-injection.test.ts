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

/**
 * settings 的 mock **一律走共享基座**（`./settings-mock`，单一实现，见那里的文件头）。
 *
 * 本文件原来的手写 mock 缺了本批新加的 `loadMemoryChecked` —— `MemoryService` 的构造函数
 * 就会调它，于是 ENG-1..4 **四条用例里全都**在 `new LLMEngine()` 当场抛
 * `No "loadMemoryChecked" export is defined on the "../core/storage/settings" mock`。
 *
 * 根因**不是**引擎的模型注入路径被改坏：报错栈是
 * `memory.ts:590 loadMemoryChecked ← new MemoryService ← getMemoryService ← LLMEngine 构造函数`，
 * 与 `loadDynamicModels()` 一行关系都没有。修的是缺 mock，不是实现。
 */
vi.mock("../core/storage/settings", async () => (await import("./settings-mock")).createSettingsMock());

import { createSettingsMock, settingsMockStore } from "./settings-mock";
import * as settingsModule from "../core/storage/settings";
import { LLMEngine } from "../core/llm/index";

/**
 * 被测代码（`LLMEngine`）看到的**就是**这一份 settings 对象 —— 它是上面工厂的返回值，
 * 所以直接从这里取它的内存库来预置/断言，两边不可能对不上（用 `vi.doMock` 重装会另起一个
 * 模块注册表：实测引擎会读到**空**库，ENG-2/3 就变成假红）。
 */
const settingsMock = settingsModule as unknown as Record<string, unknown>;
const store = settingsMockStore(settingsMock).raw;

/** 服务器缓存那一格：与真实 `setSettingJSON` 同形（JSON 字符串写进设置表） */
const setDynamicModels = (value: Record<string, unknown>) =>
  store.set("codem-dynamic-models", JSON.stringify(value));

beforeEach(() => {
  // 每个用例一份**全新的空库**（原来那句 `mocks.store = {}` 是同一个用意）
  store.clear();
  vi.clearAllMocks();
});

/** 引擎默认就会注册好 deepseek 等内置 provider，直接用注册表里的那个 */
const dynamicIds = (engine: LLMEngine, id: string): string[] =>
  ((engine.providers.get(id) as any)?.dynamicModels || []).map((m: any) => m.id);

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
    setDynamicModels({
      deepseek: [
        { id: "deepseek-flash", name: "deepseek-flash" },
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
      ],
    });
    const engine = new LLMEngine();
    engine.loadDynamicModels();
    const ids = dynamicIds(engine, "deepseek");
    expect(ids).toContain("deepseek-flash");
    expect(ids).toContain("deepseek-v4-flash-vision-exp");
    expect(ids, "已改名的旧名不该与服务器当前名同时出现").not.toContain("deepseek-v4-flash");
  });

  it("ENG-3: 缓存里的旧数据照样补 contextWindow（迁移不被新的遍历方式弄丢）", () => {
    setDynamicModels({ deepseek: [{ id: "deepseek-flash", name: "deepseek-flash" }] });
    const engine = new LLMEngine();
    engine.loadDynamicModels();
    const flash = ((engine.providers.get("deepseek") as any)?.dynamicModels || []).find(
      (m: any) => m.id === "deepseek-flash",
    );
    expect(flash?.contextWindow).toBeGreaterThan(0);
    // 回填只写服务器缓存，不把目录条目写进缓存（缓存只存服务器事实）
    const persisted = JSON.parse(store.get("codem-dynamic-models")!) as { deepseek: Array<{ id: string }> };
    expect(persisted.deepseek.map((m) => m.id)).toEqual(["deepseek-flash"]);
  });

  it("ENG-4: 目录里没有、注册表里也没有的 provider 不会让注入报错，也不会被塞进目录条目", () => {
    setDynamicModels({ "my-provider": [{ id: "my-model", name: "my-model" }] });
    const engine = new LLMEngine();
    expect(() => engine.loadDynamicModels()).not.toThrow();
    expect(dynamicIds(engine, "my-provider")).toEqual([]);
  });
});
