/**
 * ★ 第 184 波（G10）：**按模型族钳制思考档位**（对标 Pi v1.1.0）。
 *
 * ## 为什么需要它
 *
 * 各家对"思考强度"的字段与取值**不一样**，而我们把用户选的档位原样发出去：
 * ·
 * · `gpt-oss` 系列走**扁平**的 `reasoning_effort`，**只接受 low / medium / high**
 *   —— 发 `xhigh` / `max` 会被拒（400）或静默降级，用户看到的是"我明明选了最高档"；
 * · 其余 OpenAI 系走**嵌套**的 `reasoning.effort`，且**拒绝 `minimal`**（要发 `low`）。
 *
 * 上游 Pi 在 v1.1.0 就是这么做的（`packages/ai/src/api/bedrock-converse-stream.ts:1339-1355`
 * 的两张映射表 `OPENAI_GPT_OSS_EFFORT` / `OPENAI_GPT_EFFORT`，注释写明
 * "gpt-oss takes a flat reasoning_effort and only accepts low, medium and high"）。
 *
 * ## 我们这一版**只做钳制，不编事实**
 *
 * 上游的档位上限来自它对每个模型的目录知识；我们**没有**给新模型编窗口/价格/档位上限
 * （那类数字我们不 invent —— G4 已经把"表外模型"标成 `costUnknown`，
 * 窗口/输出上限走 `model-output-limit` 的族规则与动态拉取）。
 * 所以这里只落**按族的字段形状与取值约束**：把**不可能被接受**的值钳到该族接受的集合里。
 */
import type { ReasoningEffort } from "./types";

/** gpt-oss 系：扁平 `reasoning_effort`，只接受 low / medium / high（上游同款约束） */
const GPT_OSS_EFFORT: Record<ReasoningEffort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  // 它不接受这两档 ⇒ 钳到 high（"用户要更高"应当保住最高可用档，而不是悄悄降到 medium）
  xhigh: "high",
  max: "high",
};

/**
 * 该模型名是否属于 `gpt-oss` 族。
 *
 * 判据与上游一致：**先看模型 id，再看显示名**（上游用 `getModelMatchCandidates(id, name)`
 * 同时匹配两者 —— 因为有的网关只把族信息放在显示名里）。
 */
export function isGptOssFamily(modelId: string, modelName?: string): boolean {
  const hay = `${modelId} ${modelName ?? ""}`.toLowerCase();
  // 分隔符三种都要认：`gpt-oss` / `gpt_oss` / `gpt oss`（各家写法不一，判据 EFF-4 覆盖）
  return /gpt[-_\s]?oss/.test(hay);
}

/** 把档位钳到 `gpt-oss` 接受的集合（低档原样，高档封顶到 high） */
export function clampEffortForGptOss(effort: ReasoningEffort): "low" | "medium" | "high" {
  return GPT_OSS_EFFORT[effort] ?? "medium";
}

/**
 * 计算要发出去的 `reasoning_effort` 值。
 *
 * @returns 要发的值；`undefined` 表示**不发这个字段**（调用方据此省略它）
 */
export function reasoningEffortForRequest(
  modelId: string,
  modelName: string | undefined,
  effort: ReasoningEffort | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (isGptOssFamily(modelId, modelName)) return clampEffortForGptOss(effort);
  return effort;
}
