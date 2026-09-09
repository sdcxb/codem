/**
 * 纠偏模型配置 — 设置读写 + fact_check 模型决策纯函数 单测
 *
 * 覆盖审计修复（纠偏模型面板原为占位、fact_check 曾依赖从未注入的
 * ctx.correctionProvider/correctionModel 假默认）：
 *  - codem-correction-model 设置读写往返一致；
 *  - fact_check 的模型决策纯函数 decideCorrectionModel：
 *    配置存在 → 用它（source: "dedicated"）；缺失/不完整 → null（回退主模型）；
 *  - 核查结果解析兜底 parseCorrectionOutput；
 *  - 源码 lint：fact_check 不再引用 ctx.correctionProvider / correctionModel 假默认。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSettingJSON, setSettingJSON, removeSetting } from "../core/storage/settings";
import {
  CORRECTION_MODEL_SETTING_KEY,
  MAIN_MODEL_FALLBACK_NOTE,
  decideCorrectionModel,
  parseCorrectionOutput,
  type CorrectionModelConfig,
} from "../core/llm/tools/fact-check";

describe("纠偏模型配置 — codem-correction-model 设置读写", () => {
  it("setSettingJSON → getSettingJSON 往返一致（完整 JSON）", () => {
    const cfg: CorrectionModelConfig = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test-123",
      baseUrl: "https://api.deepseek.com",
    };
    setSettingJSON(CORRECTION_MODEL_SETTING_KEY, cfg);
    const loaded = getSettingJSON<CorrectionModelConfig | null>(CORRECTION_MODEL_SETTING_KEY, null);
    expect(loaded).toEqual(cfg);
  });

  it("覆盖保存：新值替换旧值", () => {
    setSettingJSON(CORRECTION_MODEL_SETTING_KEY, { provider: "openai", model: "gpt-4o" });
    const newer: CorrectionModelConfig = {
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "gkey",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    };
    setSettingJSON(CORRECTION_MODEL_SETTING_KEY, newer);
    const loaded = getSettingJSON<CorrectionModelConfig | null>(CORRECTION_MODEL_SETTING_KEY, null);
    expect(loaded).toEqual(newer);
  });

  it("removeSetting 清除后读取返回 null（= 回退主模型）", () => {
    setSettingJSON(CORRECTION_MODEL_SETTING_KEY, { provider: "openai", model: "gpt-4o" });
    removeSetting(CORRECTION_MODEL_SETTING_KEY);
    expect(getSettingJSON<CorrectionModelConfig | null>(CORRECTION_MODEL_SETTING_KEY, null)).toBeNull();
  });

  it("key 不存在时读取返回默认值 null", () => {
    removeSetting(CORRECTION_MODEL_SETTING_KEY);
    expect(getSettingJSON<CorrectionModelConfig | null>(CORRECTION_MODEL_SETTING_KEY, null)).toBeNull();
  });
});

describe("fact_check 模型决策纯函数 decideCorrectionModel", () => {
  it("配置存在 → 使用专属纠偏模型（provider/model + source: dedicated）", () => {
    const decided = decideCorrectionModel({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-x",
      baseUrl: "https://api.deepseek.com",
    });
    expect(decided).toEqual({ provider: "deepseek", model: "deepseek-v4-flash", source: "dedicated" });
  });

  it("配置缺失（null / undefined）→ null（调用方回退主模型）", () => {
    expect(decideCorrectionModel(null)).toBeNull();
    expect(decideCorrectionModel(undefined)).toBeNull();
  });

  it("字段不完整（缺 model / provider 为空串 / 非对象）→ null", () => {
    expect(decideCorrectionModel({ provider: "deepseek" })).toBeNull();
    expect(decideCorrectionModel({ model: "gpt-4o" })).toBeNull();
    expect(decideCorrectionModel({ provider: "   ", model: "deepseek-v4-flash" })).toBeNull();
    expect(decideCorrectionModel({ provider: "deepseek", model: "" })).toBeNull();
    expect(decideCorrectionModel("garbage" as unknown as CorrectionModelConfig)).toBeNull();
  });

  it("provider/model 前后空白被 trim", () => {
    expect(decideCorrectionModel({ provider: " openai ", model: " gpt-4o " })).toEqual({
      provider: "openai",
      model: "gpt-4o",
      source: "dedicated",
    });
  });
});

describe("fact_check 核查结果解析 parseCorrectionOutput（真实模型回复兜底）", () => {
  it("解析纯 JSON", () => {
    const out = parseCorrectionOutput(
      JSON.stringify({ corrected: "修正后的内容", changes: ["改了一处事实错误"] }),
    );
    expect(out.corrected).toBe("修正后的内容");
    expect(out.changes).toEqual(["改了一处事实错误"]);
  });

  it("解析被 ```json 围栏包裹的 JSON", () => {
    const out = parseCorrectionOutput(
      '```json\n{"corrected": "ok", "changes": ["c1"]}\n```',
    );
    expect(out.corrected).toBe("ok");
    expect(out.changes).toEqual(["c1"]);
  });

  it("非 JSON 回复 → 原样保留 corrected + parseWarning（不假装无需修正）", () => {
    const out = parseCorrectionOutput("这段内容没有事实错误。");
    expect(out.corrected).toBe("这段内容没有事实错误。");
    expect(out.changes).toEqual([]);
    expect(out.parseWarning).toBeTruthy();
  });

  it("changes 仅保留字符串项", () => {
    const out = parseCorrectionOutput(
      JSON.stringify({ corrected: "x", changes: ["a", 1, null, "b"] }),
    );
    expect(out.changes).toEqual(["a", "b"]);
  });
});

describe("fact_check 源码 lint（审计修复断言）", () => {
  const src = readFileSync(join(process.cwd(), "src/core/llm/tools/fact-check.ts"), "utf-8");

  it("不再引用 ctx.correctionProvider / ctx.correctionModel 假默认", () => {
    expect(src).not.toContain("correctionProvider");
    expect(src).not.toContain("correctionModel");
  });

  it("使用真实设置 key codem-correction-model，并在回退主模型时如实标注", () => {
    expect(src).toContain('"codem-correction-model"');
    expect(src).toContain(MAIN_MODEL_FALLBACK_NOTE);
    expect(src).toContain("main (fallback)");
  });
});
