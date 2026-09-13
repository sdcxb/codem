/**
 * 上下文超限 / 确定性错误 / 思考吃掉预算（第 69 波）。
 *
 * 用户日志给出的完整真相：
 *   1. `finish_reason=length — text 0 chars, tool calls 0`：带思考的模型**把输出预算全用在 reasoning 上**，正文一个字没出；
 *   2. 之后每次重试都是 `400：maximum context length is 1048576 tokens. However, you requested 1048735 tokens`
 *      —— 上下文已超上限，而且自动续写还在让它**越滚越大**（1048735 → 1048992 → 1049249）；
 *   3. 每轮失败都重试 3 次（400 是确定性错误，重试毫无意义），最后整轮死掉。
 *
 * 三个根因：
 *   · **反应式压缩的判定字符串不匹配**：代码只认 `prompt_too_long` / `context_length_exceeded`，
 *     而 DeepSeek 的措辞是 `maximum context length is ...` → 本该救场的压缩**从未触发**；
 *   · **确定性错误被白重试**（没看 classifyError，也没把 HTTP 状态挂到错误对象上）；
 *   · **我上一波引入的 bug**：`lastFinishReason` 跨迭代不重置 → 某轮失败（没有任何 finish_reason）
 *     时沿用上一轮的 `length`，触发毫无意义的"续写"，把超限的上下文继续撑大。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isContextOverflowError,
  parseContextOverflowNumbers,
  describeContextOverflow,
} from "../core/llm/provider-errors";
import { resolveMaxOutputTokens, inferFamilyOutputLimit, HARD_OUTPUT_CEILING } from "../core/llm/model-output-limit";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 事故现场的真实错误体（原样抄自用户控制台） */
const DEEPSEEK_OVERFLOW =
  'API error 400: {"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1048735 tokens (1048735 in the messages, 0 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error"}}';

describe("上下文超限识别（第 69 波）", () => {
  it("OFLOW-1: 认得事故现场那条 DeepSeek 报错（旧代码只认 prompt_too_long/context_length_exceeded）", () => {
    expect(isContextOverflowError(DEEPSEEK_OVERFLOW)).toBe(true);
    // 各家常见的其它措辞
    for (const m of [
      "context_length_exceeded",
      "prompt_too_long",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "This model's maximum context length is 128000 tokens",
      "Please reduce the length of the messages or completion",
      "input is too long for this model",
      "too many tokens",
    ]) {
      expect(isContextOverflowError(m), m).toBe(true);
    }
    // 不能把无关的 400 也当成溢出（否则会误触发压缩）
    expect(isContextOverflowError("content filtered")).toBe(false);
    expect(isContextOverflowError("invalid max_tokens")).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  it("OFLOW-2: 能把「超出多少」解析出来，便于给用户一句可读说明", () => {
    const { limit, requested } = parseContextOverflowNumbers(DEEPSEEK_OVERFLOW);
    expect(limit).toBe(1048576);
    expect(requested).toBe(1048735);
    const msg = describeContextOverflow(DEEPSEEK_OVERFLOW);
    expect(msg).toMatch(/超出模型上限/);
    expect(msg, "要给出具体数字").toMatch(/1,048,735|1048735/);
    expect(msg, "并给出可执行的下一步").toMatch(/开一个新对话/);
  });

  it("OFLOW-3: 循环里改用语义匹配（旧的两个字符串判定已不存在）", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toMatch(/isContextOverflowError\(error\.message\)/);
    expect(loop, "旧判定应已被替换").not.toMatch(/error\.message\?\.includes\("prompt_too_long"\)/);
    // 溢出时不能白重试，要交给压缩路径
    expect(loop).toMatch(/isContextOverflowError\(retryError\.message\)/);
  });

  it("OFLOW-4: 压缩也救不回来时，明确停下并告诉用户怎么办（不是静默死掉）", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toMatch(/recordLoopStop\(sessionId, "context_overflow"/);
    expect(loop).toMatch(/describeContextOverflow\(error\.message\)/);
    expect(loop).toMatch(/reason: "context_overflow"/);
  });

  it("OFLOW-5: 确定性错误不重试；状态码挂到错误对象上（500 仍可重试）", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toMatch(/const retryClass = classifyError\(retryError\)/);
    expect(loop).toMatch(/if \(!retryClass\.isRetryable\)/);
    const provider = read("src/core/llm/provider.ts");
    expect(provider, "HTTP 状态必须挂到错误对象上，否则 classifyError 分不清 400/500").toMatch(/apiErr\.status = response\.status/);
    expect(provider, "错误体要给足长度（超限的关键数字不能被 200 字符截掉）").toMatch(/safe\.substring\(0, 2000\)/);
  });

  it("OFLOW-6: 结束原因每轮重置（修上一波引入的「失败轮沿用 length → 假续写」）", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    const idx = loop.indexOf("this.state.lastFinishReason = \"stop\";");
    expect(idx).toBeGreaterThan(-1);
    const around = loop.slice(Math.max(0, idx - 400), idx + 200);
    expect(around, "重置发生在迭代开头（与其它每轮状态一起）").toMatch(/iteration\+\+|guardSuppressedThisIteration = 0/);
    // 且要有正文长度判定，区分"接不上"与"正文 0 字符"
    expect(loop).toMatch(/lastIterationTextChars/);
  });

  it("OFLOW-7: 带思考的模型拿不到「目录值」时，按**模型族**给合理上限（不再一律 8192）", () => {
    // 事故里的模型 id 是 deepseek-flash（目录里只有 deepseek-v4-flash，查不到 → 以前落到 8192）
    const r = resolveMaxOutputTokens({ modelId: "deepseek-flash" });
    expect(r.source).toBe("family");
    expect(r.maxTokens).toBe(HARD_OUTPUT_CEILING);
    expect(r.note, "要说明为什么给这么大").toMatch(/DeepSeek|思考/);
    // 推理系同样给足
    expect(inferFamilyOutputLimit("deepseek-reasoner")?.maxTokens).toBe(HARD_OUTPUT_CEILING);
    expect(inferFamilyOutputLimit("o3")?.maxTokens).toBe(HARD_OUTPUT_CEILING);
    // 未知模型仍然走保守兜底
    expect(inferFamilyOutputLimit("some-unknown-model")).toBeUndefined();
    expect(resolveMaxOutputTokens({ modelId: "some-unknown-model" }).source).toBe("default");
  });
});
