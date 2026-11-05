/**
 * 模型列表模态文案的唯一口径：不管模型来自免费插件、AICodeWith 还是原生供应商，
 * 同一能力只允许出现同一种写法，且必须区分「多模态 / 文本」。
 */
import { describe, expect, it } from "vitest";
import { modelModalityLabel } from "../core/llm/model-modality";

describe("MODALITY-UNIFY 统一模态文案", () => {
  it("供应商目录给的 image/text 优先，且都用【】包起来", () => {
    expect(modelModalityLabel("claude-sonnet-4-6", ["text", "image"], "zh")).toBe("【多模态】");
    expect(modelModalityLabel("kimi-k3.1-pro", ["text"], "zh")).toBe("【文本】");
    expect(modelModalityLabel("claude-sonnet-4-6", ["text", "image"], "en")).toBe("【Multimodal】");
  });

  it("没有目录字段时查能力表：原生 deepseek-flash 也必须标多模态", () => {
    expect(modelModalityLabel("deepseek-flash", undefined, "zh")).toBe("【多模态】");
    expect(modelModalityLabel("deepseek-v4-pro", undefined, "zh")).toBe("【文本】");
  });

  it("完全无依据不猜（不把未知模型硬标成文本）", () => {
    expect(modelModalityLabel("totally-unknown-model-xyz", undefined, "zh")).toBe("");
  });
});
