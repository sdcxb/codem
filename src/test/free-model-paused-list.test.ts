/**
 * OFM-11：暂停免费模型插件后，模型选择器不得再列出/允许选择免费模型。
 *
 * 真实现场：插件暂停（`enabled=false`）后，缓存虽然被清，但落盘的动态模型列表
 * 里仍有上次的 `free-model` 条目，`getConfiguredApiModels()` 把它们并回选择器。
 * 本判据钉住：开关关闭 ⇒ 一个免费模型都不出现；开关打开 ⇒ 才允许参与并集。
 */
import { describe, expect, it, vi } from "vitest";
import { createSettingsMock } from "./settings-mock";

const state = { enabled: false };

vi.mock("../core/storage/settings", () => ({
  ...createSettingsMock(),
  getSettingJSON: () => ({ providers: [{ id: "deepseek", apiKey: "sk-test" }] }),
}));

vi.mock("../core/llm/model-catalog", () => ({
  getMergedDynamicModels: () => ({
    "free-model": [{ id: "free-dynamic", name: "Free Dynamic" }],
  }),
}));

vi.mock("../core/free-model-plugin/service", () => ({
  freeModelPlugin: {
    readSetting: () => ({ enabled: state.enabled }),
    models: {
      cached: () => [{ id: "free-cached", name: "Free Cached" }],
    },
  },
}));

import { getConfiguredApiModels } from "../core/model-config";

describe("OFM-11 暂停后模型列表", () => {
  it("插件关闭 ⇒ 缓存/动态列表里的免费模型都不进选择器", () => {
    state.enabled = false;
    const ids = getConfiguredApiModels().map((m) => m.id);
    expect(ids).not.toContain("free-cached");
    expect(ids).not.toContain("free-dynamic");
    expect(ids, "普通 provider 的模型不能被误删").toContain("deepseek-v4-flash");
  });

  it("插件开启 ⇒ 免费模型才参与并集", () => {
    state.enabled = true;
    const ids = getConfiguredApiModels().map((m) => m.id);
    expect(ids).toContain("free-cached");
    expect(ids).toContain("free-dynamic");
  });
});
