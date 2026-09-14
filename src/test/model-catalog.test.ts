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

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: mocks.getSettingJSON,
  setSettingJSON: vi.fn(),
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
  it("CAT-1: 服务器列出的模型全部保留，只补服务器缺的目录模型，并标记来源", () => {
    const server = [
      { id: "deepseek-flash", name: "deepseek-flash" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    ];
    const merged = mergeModelsWithCatalog("deepseek", server);

    const ids = merged.map((m) => m.id);
    // 服务器条目原样保留（含改名后的新 id）
    expect(ids).toContain("deepseek-flash");
    expect(ids).toContain("deepseek-v4-pro");
    // 目录独有的补进来
    expect(ids).toContain("deepseek-v4-flash-vision-exp");
    // 服务器已列出的目录条目**不重复**（v4-pro 在目录里也有）
    expect(ids.filter((id) => id === "deepseek-v4-pro")).toHaveLength(1);
    // 来源可区分：只有目录补充的才带标记
    expect(merged.find((m) => m.id === "deepseek-v4-flash-vision-exp")?.catalogOnly).toBe(true);
    expect(merged.find((m) => m.id === "deepseek-flash")?.catalogOnly).toBeUndefined();
  });

  it("CAT-2: 用户场景回归 —— 缓存里只有服务器那两个模型时，视觉模型必须出现（且无需手动刷新）", () => {
    // 这正是用户机器上的缓存形态：[deepseek-v4-flash / deepseek-v4-pro] 或 [deepseek-flash / deepseek-v4-pro]
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

    expect(ids).toContain("deepseek-v4-flash-vision-exp");
    // 目录补充的视觉模型必须带 id（小写）与显示名（给人看的那份）
    const vision = merged.deepseek.find((m) => m.id === "deepseek-v4-flash-vision-exp");
    expect(vision?.name).toBe("DeepSeek V4 Flash Vision (实验)");
    expect(vision?.inputModalities).toContain("image");
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
  it("CAT-5: normalizeModelId 把显示名写法纠成可调用的 id（实测 400 → 200）", () => {
    expect(normalizeModelId("deepseek", "DeepSeek-V4-Flash-Vision-Exp")).toBe(
      "deepseek-v4-flash-vision-exp",
    );
    // 已经正确的原样返回
    expect(normalizeModelId("deepseek", "deepseek-v4-flash-vision-exp")).toBe(
      "deepseek-v4-flash-vision-exp",
    );
    // 不认识的不动（用户手动添加的模型不能被改写）
    expect(normalizeModelId("deepseek", "some-custom-model")).toBe("some-custom-model");
    expect(normalizeModelId("openai", "DeepSeek-V4-Flash-Vision-Exp")).toBe(
      "DeepSeek-V4-Flash-Vision-Exp",
    );
  });

  it("CAT-6: 内置 profile 的 vision 槽位用小写可调用 id，且与目录一致", () => {
    const manager = getModelProfileManager();
    for (const profile of manager.getAll()) {
      const vision = profile.slots.vision;
      if (!vision) continue;
      expect(vision.model).toBe(vision.model.toLowerCase());
      expect(catalogFor(vision.provider).some((m) => m.id === vision.model)).toBe(true);
    }
    // 读取处再兜一层：历史保存的方案（显示名当 id）也会被纠正
    const resolved = manager.resolveSlot("vision");
    expect(resolved?.model).toBe("deepseek-v4-flash-vision-exp");
  });

  it("CAT-7: 目录条目自带能力信息（视觉模型必须标 image 模态）", () => {
    const vision = BUILTIN_MODEL_CATALOG.deepseek.find((m) => m.id === "deepseek-v4-flash-vision-exp");
    expect(vision?.inputModalities).toEqual(["text", "image"]);
    const flash = BUILTIN_MODEL_CATALOG.deepseek.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.inputModalities).toBeUndefined();
  });
});
