/**
 * 输出上限「按模型动态解析 + 自动降档」契约（第 67 波）。
 *
 * 第 66 波把写死的 4096 换成常量 8192 —— 那只是**兜底**，两个方向都可能错：
 *   · 比模型能力小 → 大文件的工具参数被截断（用户遇到的报错）；
 *   · 比模型能力大 → 请求被 API 直接拒绝（400 invalid max_tokens），任务直接失败。
 * 模型目录里**本来就有** `maxOutputTokens`（deepseek-v4-flash 384000 / gpt-4o 16384 /
 * moonshot-v1-8k 4096），所以正确做法是按模型取，并在被拒绝时自动降档记住 ——
 * 而不是让用户去设置里手调（他并不知道每个模型的上限）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveMaxOutputTokens,
  noteOutputLimitRejection,
  isOutputLimitRejection,
  lookupCatalogModel,
  resetLearnedOutputLimits,
  getLearnedOutputLimit,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HARD_OUTPUT_CEILING,
} from "../core/llm/model-output-limit";
import type { LLMProvider } from "../core/llm/types";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 造一个带模型目录的 provider（形状与 OpenAICompatibleProvider 一致） */
function fakeProvider(models: Array<{ id: string; maxOutputTokens?: number }>): LLMProvider {
  return {
    id: "fake",
    name: "Fake",
    isConfigured: () => true,
    listModels: async () => models as any,
    config: { models },
    findModelConfig: (id: string) => models.find((m) => m.id === id),
  } as any;
}

describe("输出上限按模型动态解析（第 67 波）", () => {
  beforeEach(() => resetLearnedOutputLimits());

  it("OUTLIM-1: 目录里有就用目录值（按模型不同而不同）", () => {
    const p = fakeProvider([
      { id: "deepseek-v4-flash", maxOutputTokens: 384000 },
      { id: "gpt-4o", maxOutputTokens: 16384 },
      { id: "moonshot-v1-8k", maxOutputTokens: 4096 },
    ]);
    // 极大值被天花板夹住（384000 → 65536）
    expect(resolveMaxOutputTokens({ provider: p, modelId: "deepseek-v4-flash" })).toMatchObject({
      maxTokens: HARD_OUTPUT_CEILING,
      source: "catalog",
      catalogMax: 384000,
    });
    expect(resolveMaxOutputTokens({ provider: p, modelId: "gpt-4o" })).toMatchObject({ maxTokens: 16384, source: "catalog" });
    // 小上限模型保持小值（不硬塞 8192 —— 那会被 API 拒绝）
    expect(resolveMaxOutputTokens({ provider: p, modelId: "moonshot-v1-8k" })).toMatchObject({ maxTokens: 4096, source: "catalog" });
  });

  it("OUTLIM-2: 显式配置优先（用户/智能体/槽位说了算），但仍受天花板约束", () => {
    const p = fakeProvider([{ id: "gpt-4o", maxOutputTokens: 16384 }]);
    expect(resolveMaxOutputTokens({ provider: p, modelId: "gpt-4o", explicit: 2048 })).toMatchObject({
      maxTokens: 2048,
      source: "explicit",
    });
    expect(resolveMaxOutputTokens({ provider: p, modelId: "gpt-4o", explicit: 999999 })).toMatchObject({
      maxTokens: HARD_OUTPUT_CEILING,
      source: "explicit",
    });
  });

  it("OUTLIM-3: 目录里查不到（自定义模型）→ 用兜底值", () => {
    const p = fakeProvider([{ id: "known" }]);
    expect(resolveMaxOutputTokens({ provider: p, modelId: "my-custom-model" })).toMatchObject({
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      source: "default",
    });
    expect(resolveMaxOutputTokens({ modelId: "no-provider" }).source).toBe("default");
  });

  it("OUTLIM-4: 被 API 拒绝 → 自动折半降档并**记住**（下一次直接用它）", () => {
    const p = fakeProvider([{ id: "strict-model", maxOutputTokens: 65536 }]);
    const first = resolveMaxOutputTokens({ provider: p, modelId: "strict-model" });
    expect(first.maxTokens).toBe(65536);

    const learned = noteOutputLimitRejection("strict-model", first.maxTokens);
    expect(learned).toBe(32768);
    expect(getLearnedOutputLimit("strict-model")).toBe(32768);

    // 学到之后优先级高于目录（避免重复踩坑）
    expect(resolveMaxOutputTokens({ provider: p, modelId: "strict-model" })).toMatchObject({
      maxTokens: 32768,
      source: "learned",
      catalogMax: 65536,
    });
    // 继续被拒会继续降，但有下限（降到底时返回 undefined，表示"无法再降"）
    let v: number | undefined = 32768;
    for (let i = 0; i < 20 && v !== undefined; i++) v = noteOutputLimitRejection("strict-model", v);
    expect(getLearnedOutputLimit("strict-model")).toBeGreaterThanOrEqual(1024);
    expect(v, "降到下限后应返回 undefined（调用方改为不发送 max_tokens）").toBeUndefined();
  });

  it("OUTLIM-5: 拒绝判定要保守 —— 只有 400/422 + 提到 max_tokens + 像「值不合法」才算", () => {
    expect(isOutputLimitRejection(400, '{"error":{"message":"Invalid max_tokens: must be less than 8192"}}')).toBe(true);
    expect(isOutputLimitRejection(422, "max_output_tokens out of range")).toBe(true);
    // 其它 400（例如内容审核、字段缺失）不能被当成上限问题反复重试
    expect(isOutputLimitRejection(400, "content filtered")).toBe(false);
    expect(isOutputLimitRejection(429, "rate limit")).toBe(false);
    expect(isOutputLimitRejection(500, "max_tokens invalid")).toBe(false);
    // 提到了 max_tokens 但不像是"值不合法" → 不判定
    expect(isOutputLimitRejection(400, "max_tokens is missing")).toBe(false);
  });

  it("OUTLIM-6: 主链路真的接上了（引擎按模型解析、provider 会自动降档重试）", () => {
    const index = read("src/core/llm/index.ts");
    expect(index).toMatch(/resolveMaxOutputTokens\(\{/);
    expect(index, "不再用写死的 4096 兜底").not.toMatch(/maxOutputTokens:[^\n]*\|\| 4096/);
    expect(index, "ultra 模式也不能硬抬超过模型上限").toMatch(/resolveMaxOutputTokens\(\{[\s\S]{0,240}explicit: Math\.max\(/);
    const provider = read("src/core/llm/provider.ts");
    expect(provider).toMatch(/isOutputLimitRejection\(response\.status, probe\)/);
    expect(provider).toMatch(/noteOutputLimitRejection\(request\.model, request\.maxTokens\)/);
    // 降档后必须真的重发一次请求
    expect(provider).toMatch(/retryBody\.max_tokens = next/);
  });

  it("OUTLIM-7: 目录查找兼容三种形状（findModelConfig / config.models / models）", () => {
    const viaMethod = fakeProvider([{ id: "a", maxOutputTokens: 111 }]);
    expect(lookupCatalogModel(viaMethod, "a")?.maxOutputTokens).toBe(111);
    const viaList = { id: "x", models: [{ id: "b", maxOutputTokens: 222 }] } as any;
    expect(lookupCatalogModel(viaList, "b")?.maxOutputTokens).toBe(222);
    const viaConfig = { id: "y", config: { models: [{ id: "c", maxOutputTokens: 333 }] } } as any;
    expect(lookupCatalogModel(viaConfig, "c")?.maxOutputTokens).toBe(333);
    expect(lookupCatalogModel(undefined, "a")).toBeUndefined();
  });
});

describe("同类问题清查（第 67 波）：静默丢数据", () => {
  it("SAMECLASS-1: 无法解析的流数据行不再被静默丢弃 —— 计数并让参数走「拒绝执行」", () => {
    const provider = read("src/core/llm/provider.ts");
    expect(provider).toContain("droppedStreamLines");
    expect(provider, "丢弃时要计数并给出可读信息").toMatch(/丢弃了 1 行无法解析的流数据/);
    // 两条结束路径（正常结束 / 无 finish_reason 兜底）都要标注"参数可能不完整"
    const marks = provider.match(/arguments may be incomplete/g) || [];
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it("SAMECLASS-2: 因输出上限截断的回复里跑了内容型工具 → 必须提示核对完整性", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toMatch(/finishReason === "length" && isContentBearingTool\(name\)/);
    expect(loop).toMatch(/recordLoopStop\(sessionId, "output_truncated"/);
    expect(loop).toMatch(/核对它是否完整|核实它是否完整/);
  });

  it("SAMECLASS-3: 把已有非空文件写成空 → 结果里必须警告（避免静默清空）", () => {
    const tools = read("src/core/llm/tools.ts");
    expect(tools).toContain("emptiedExisting");
    expect(tools).toMatch(/写成了空/);
    expect(tools, "要带上原文件大小，便于判断损失").toMatch(/existingContent!\.length/);
  });
});
