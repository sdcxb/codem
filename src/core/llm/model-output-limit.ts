/**
 * 单次回复**输出上限**的解析与自适应（第 67 波）。
 *
 * ## 为什么不能写死，也不能只靠用户手工调
 *
 * 第 66 波把 4096 换成常量 8192，但那只是**兜底**：模型目录里**本来就有**每个模型的
 * `maxOutputTokens`（`provider.ts` 的模型表，例如 `deepseek-v4-flash` = 384000、
 * `gpt-4o` = 16384、`moonshot-v1-8k` = 4096）。写死的后果有两个方向都错：
 *   · 比模型能力**小** → 大文件的工具参数被截断（正是用户遇到的报错）；
 *   · 比模型能力**大** → 请求被 API 直接拒绝（400 invalid max_tokens），任务直接失败。
 * 让用户去设置里手调是把配置负担丢给用户，而且他并不知道每个模型的上限。
 *
 * 所以这里的规则是（第 67 波）：
 *   1. **显式配置优先**（智能体 / 槽位 / 设置里的 maxTokens）—— 用户说了算；
 *   2. 否则用**模型目录**里的 `maxOutputTokens`，并按 `HARD_OUTPUT_CEILING` 夹住；
 *   3. 目录里查不到（自定义模型）→ 用 `DEFAULT_MAX_OUTPUT_TOKENS` 兜底；
 *   4. **被 API 拒绝就自动降档并记住**（`noteOutputLimitRejection`）：同一次任务内不再踩第二次，
 *      下次请求直接用学到的更小上限 —— 这就是"临时调整"的自动化版本，用户不需要干预。
 */

import type { LLMProvider } from "./types";

/** 单次回复输出上限的兜底值（模型目录查不到时使用） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * 实际使用的上限天花板。
 *
 * 模型目录里有些值极大（`deepseek-v4-flash` 标 384000）。一次性允许 38 万输出 token
 * 既没有实际意义（没有人真会在一次回复里写 20 万 token），也会让"跑飞"的代价变得很大。
 * 65536 对"生成大文件/长文档"已经绰绰有余，同时仍然远小于各家的硬上限。
 */
export const HARD_OUTPUT_CEILING = 65_536;

/** 被拒绝时至少退到多少（避免一路退到 0） */
const MIN_OUTPUT_TOKENS = 1024;

/**
 * 第 69 波：**按模型族给合理上限**（模型目录里查不到时用）。
 *
 * 为什么需要它：`deepseek-flash` 这类模型是**带思考的**（先输出 reasoning_content 再输出正文），
 * 而思考 token 也计入 `max_tokens`。事故现场就是：输出上限太小 → **思考把预算吃光**，
 * `finish_reason=length` 且**正文 0 字符** → 用户看到"任务又中断了"。
 * 这些模型上下文 1M、支持很长的输出，给 8192 明显偏小。
 *
 * 只匹配"族"，不硬编码单个模型的精确上限（那会随版本变）；未知型号仍走兜底值。
 */
const MODEL_FAMILY_OUTPUT_LIMITS: Array<{ pattern: RegExp; maxTokens: number; reason: string }> = [
  { pattern: /reasoner|thinking|-r1\b|deepseek-r1/i, maxTokens: 65_536, reason: "推理模型：思考 token 与正文共享输出预算" },
  { pattern: /deepseek-(v4|v3|flash|pro|chat)/i, maxTokens: 65_536, reason: "DeepSeek 系（1M 上下文；部分型号带思考，reasoning 与正文共享输出预算）" },
  { pattern: /o3|o4|gpt-5/i, maxTokens: 65_536, reason: "OpenAI 推理系" },
  { pattern: /claude-(opus|sonnet)-4/i, maxTokens: 32_000, reason: "Claude 4" },
  { pattern: /gemini-2\.5|gemini-3/i, maxTokens: 65_536, reason: "Gemini 2.5+" },
];

/** 按模型族推断上限；认不出来返回 undefined（交给兜底值） */
export function inferFamilyOutputLimit(modelId: string): { maxTokens: number; reason: string } | undefined {
  if (!modelId) return undefined;
  for (const entry of MODEL_FAMILY_OUTPUT_LIMITS) {
    if (entry.pattern.test(modelId)) return { maxTokens: Math.min(entry.maxTokens, HARD_OUTPUT_CEILING), reason: entry.reason };
  }
  return undefined;
}

export interface ResolvedOutputLimit {
  /** 要发给 API 的 max_tokens；undefined = 不发送（由 provider 用自己的默认上限） */
  maxTokens: number | undefined;
  /** 这个值是怎么来的（日志/排障用） */
  source: "explicit" | "learned" | "catalog" | "family" | "default";
  /** 模型目录里声明的上限（如果有），便于日志里对照 */
  catalogMax?: number;
  /** 为什么取这个值（family 档附原因） */
  note?: string;
}

/**
 * 「学到的上限」：模型 id → 上限。被 API 拒绝后写入，进程内有效。
 *
 * 放在模块级是刻意的：同一个模型在**任何会话/任务**里都不该重复踩同一个坑。
 */
const learnedLimits = new Map<string, number>();

/** 测试用：清空学到的上限 */
export function resetLearnedOutputLimits(): void {
  learnedLimits.clear();
}

/** 查某个模型"被学到"的上限（诊断/测试用） */
export function getLearnedOutputLimit(modelId: string): number | undefined {
  return learnedLimits.get(modelId);
}

/**
 * 从 provider 的模型表里同步查一个模型（`listModels()` 是异步的，创建循环时用不了）。
 * 兼容三类形状：OpenAI 兼容 provider 的 `findModelConfig`、`config.models`、`models`。
 */
export function lookupCatalogModel(provider: LLMProvider | undefined, modelId: string): { maxOutputTokens?: number } | undefined {
  if (!provider || !modelId) return undefined;
  const p = provider as any;
  try {
    if (typeof p.findModelConfig === "function") {
      const found = p.findModelConfig(modelId);
      if (found) return found;
    }
    const lists: any[] = [p.config?.models, p.models, p.dynamicModels];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((m: any) => m && (m.id === modelId || m.model === modelId));
      if (hit) return hit;
    }
  } catch (e) {
    console.warn("[model-output-limit] 查询模型目录失败:", e);
  }
  return undefined;
}

/**
 * 解析这次请求该用多大的输出上限。
 *
 * @param opts.explicit 用户/智能体/槽位显式配置的值（最高优先级）
 */
export function resolveMaxOutputTokens(opts: {
  provider?: LLMProvider;
  modelId: string;
  explicit?: number;
}): ResolvedOutputLimit {
  const { provider, modelId, explicit } = opts;

  if (typeof explicit === "number" && explicit > 0) {
    return { maxTokens: Math.min(explicit, HARD_OUTPUT_CEILING), source: "explicit" };
  }

  const learned = learnedLimits.get(modelId);
  const catalogMax = lookupCatalogModel(provider, modelId)?.maxOutputTokens;

  if (typeof learned === "number" && learned > 0) {
    return { maxTokens: learned, source: "learned", catalogMax };
  }

  if (typeof catalogMax === "number" && catalogMax > 0) {
    return { maxTokens: Math.min(catalogMax, HARD_OUTPUT_CEILING), source: "catalog", catalogMax };
  }

  // 第 69 波：目录里没有（常见于"服务端动态拉到的模型"）→ 按**模型族**推断，
  // 而不是一律 8192。带思考的模型会先把预算花在 reasoning 上，8192 很容易"正文 0 字符就截断"。
  const family = inferFamilyOutputLimit(modelId);
  if (family) {
    return { maxTokens: family.maxTokens, source: "family", note: family.reason };
  }

  return { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, source: "default", catalogMax };
}

/**
 * API 明确拒绝了 max_tokens 时调用：降档并记住。
 *
 * 降档策略：**折半**（但不超过被拒绝的值减一），下限 `MIN_OUTPUT_TOKENS`。
 * 折半而不是"减一点"，是因为拒绝通常意味着"这个量级不行"，慢慢试探会更慢。
 *
 * @returns 学到的新上限；无法解析时返回 undefined（调用方应改为"不发送 max_tokens"）
 */
export function noteOutputLimitRejection(modelId: string, rejectedValue?: number): number | undefined {
  const base = typeof rejectedValue === "number" && rejectedValue > 0
    ? rejectedValue
    : learnedLimits.get(modelId) ?? HARD_OUTPUT_CEILING;
  const next = Math.max(MIN_OUTPUT_TOKENS, Math.floor(base / 2));
  if (next >= base) return undefined;
  learnedLimits.set(modelId, next);
  console.warn(`[model-output-limit] ${modelId}: API 拒绝了 max_tokens=${base}，自动降到 ${next}（本次进程内记住）`);
  return next;
}

/**
 * 判断一个 API 错误是否属于"输出上限不被接受"。
 *
 * 各家的措辞不同，这里保守匹配：既要提到 max_tokens（或 max_output_tokens / maxTokens），
 * 又要像是"值不合法/超限"，避免把无关的 400 也当成上限问题反复重试。
 */
export function isOutputLimitRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = (body || "").toLowerCase();
  const mentionsLimit = text.includes("max_tokens") || text.includes("max_output_tokens") || text.includes("maxtokens");
  if (!mentionsLimit) return false;
  return (
    text.includes("invalid") ||
    text.includes("must be") ||
    text.includes("less than") ||
    text.includes("greater than") ||
    text.includes("out of range") ||
    text.includes("exceed") ||
    text.includes("maximum") ||
    text.includes("range")
  );
}
