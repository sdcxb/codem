/**
 * 内置模型目录 —— 合并规则与 id 大小写（第 74 波）
 *
 * 起因（用户提问）：为什么 Codem 的模型下拉里 DeepSeek 只有两个模型、没有
 * `deepseek-v4-flash-vision-exp`，而 DSH 有？
 *
 * 实测事实（2026-09-13，用用户同一把 key 直连官方接口，脚本见 .preview-shot/probe-deepseek-*.mjs）：
 *
 *   GET  /v1/models                              → 2 个：deepseek-flash, deepseek-v4-pro
 *   POST /v1/chat/completions  model=deepseek-v4-flash-vision-exp → 200 ✅
 *   POST /v1/chat/completions  model=DeepSeek-V4-Flash-Vision-Exp → 400 ❌（大小写敏感）
 *
 * DSH 之所以有：它的 DeepSeek 模型是**静态目录**（`dsh-llm-deepseek` 的 DEFAULT_MODELS，
 * 其 listModels() 不请求服务器）。Codem 之前只信服务器 /models，于是"能调用但未列出"的
 * 模型就消失了 —— 视觉模型正是这种。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettingJSON: vi.fn(),
}));

/**
 * settings 的 mock 走**共享基座**（`./settings-mock`，单一实现，见那里的文件头）；
 * 这里只覆盖本用例自己的 `mocks.getSettingJSON`。工厂内动态 import 的理由见基座文件头。
 */
vi.mock("../core/storage/settings", async () => ({
  ...(await import("./settings-mock")).createSettingsMock(),
  getSettingJSON: mocks.getSettingJSON,
}));

import {
  BUILTIN_MODEL_CATALOG,
  catalogFor,
  mergeModelsWithCatalog,
  normalizeModelId,
  getMergedDynamicModels,
} from "../core/llm/model-catalog";
import { getModelProfileManager } from "../core/llm/model-profile";

beforeEach(() => {
  mocks.getSettingJSON.mockReset().mockReturnValue({});
});

describe("内置模型目录 — 与服务器列表的并集", () => {
  it("CAT-1: 服务器列出的模型全部保留；已 retired 的视觉实验模型不再补进来", () => {
    const server = [
      { id: "deepseek-flash", name: "deepseek-flash" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    ];
    const merged = mergeModelsWithCatalog("deepseek", server);

    expect(merged.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(merged.map((m) => m.id)).not.toContain("deepseek-v4-flash-vision-exp");
    expect(merged.every((m) => !m.catalogOnly)).toBe(true);
  });

  it("CAT-2: 旧缓存里只有服务器两条时，不再复活视觉实验模型", () => {
    const staleCache = {
      deepseek: [
        { id: "deepseek-v4-flash", name: "deepseek-v4-flash", contextWindow: 1000000 },
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro", contextWindow: 1000000 },
      ],
    };
    mocks.getSettingJSON.mockImplementation((key: string) =>
      key === "codem-dynamic-models" ? staleCache : [],
    );

    const merged = getMergedDynamicModels();
    const ids = merged.deepseek.map((m) => m.id);

    expect(ids).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(ids).not.toContain("deepseek-v4-flash-vision-exp");
  });

  it("CAT-3: 目录里没有的 provider 不受影响（不凭空造模型）", () => {
    const server = [{ id: "gpt-4o", name: "gpt-4o" }];
    const merged = mergeModelsWithCatalog("openai", server);
    expect(merged.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(catalogFor("openai")).toEqual([]);
  });

  it("CAT-4: 未知的服务器模型不会被丢弃（未来新模型照样出现在列表里）", () => {
    const merged = mergeModelsWithCatalog("deepseek", [
      { id: "deepseek-something-new-2027", name: "x" },
    ]);
    expect(merged.map((m) => m.id)).toContain("deepseek-something-new-2027");
  });
});

describe("模型 id 大小写 —— API 敏感，必须纠正显示名当 id 的历史写法", () => {
  it("CAT-5: 已 retired 的视觉 id / 显示名收敛到当前 deepseek-flash", () => {
    expect(normalizeModelId("deepseek", "DeepSeek-V4-Flash-Vision-Exp")).toBe("deepseek-flash");
    expect(normalizeModelId("deepseek", "deepseek-v4-flash-vision-exp")).toBe("deepseek-flash");
    // 不认识的不动（用户手动添加的模型不能被改写）
    expect(normalizeModelId("deepseek", "some-custom-model")).toBe("some-custom-model");
    expect(normalizeModelId("openai", "DeepSeek-V4-Flash-Vision-Exp")).toBe(
      "DeepSeek-V4-Flash-Vision-Exp",
    );
  });

  it("CAT-6: 内置 profile 的 vision 槽位指向当前多模态模型 deepseek-flash", () => {
    const manager = getModelProfileManager();
    for (const profile of manager.getAll()) {
      const vision = profile.slots.vision;
      if (!vision) continue;
      expect(vision.model).toBe("deepseek-flash");
    }
    const resolved = manager.resolveSlot("vision");
    expect(resolved?.model).toBe("deepseek-flash");
  });

  it("CAT-7: 当前 Flash 条目自带 image 模态；视觉实验模型已不在目录里", () => {
    const flash = BUILTIN_MODEL_CATALOG.deepseek.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.inputModalities).toEqual(["text", "image"]);
    expect(
      BUILTIN_MODEL_CATALOG.deepseek.some((m) => m.id === "deepseek-v4-flash-vision-exp"),
    ).toBe(false);
  });
  it("CAT-8: 服务器已列出等价 id 时，目录里的旧名不再重复列出（也不补 retired 视觉模型）", () => {
    const server = [
      { id: "deepseek-flash", name: "deepseek-flash" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    ];
    const merged = mergeModelsWithCatalog("deepseek", server);
    const ids = merged.map((m) => m.id);

    expect(ids).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(ids).not.toContain("deepseek-v4-flash");
    expect(merged.every((m) => !m.catalogOnly)).toBe(true);
  });

  it("CAT-9: 服务器两条都不列时，旧 Flash 仍作为兜底出现", () => {
    const merged = mergeModelsWithCatalog("deepseek", [{ id: "some-other-model", name: "x" }]);
    const ids = merged.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).not.toContain("deepseek-v4-flash-vision-exp");
    expect(merged.find((m) => m.id === "deepseek-v4-flash")?.catalogOnly).toBe(true);
  });

  it("CAT-10: 旧缓存里已经存了 retired 视觉模型 → 读取时过滤掉（不靠用户手动刷新）", () => {
    const merged = mergeModelsWithCatalog("deepseek", [
      { id: "deepseek-flash", name: "deepseek-flash" },
      { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (实验)" },
    ]);
    expect(merged.map((m) => m.id)).toEqual(["deepseek-flash"]);
  });
});