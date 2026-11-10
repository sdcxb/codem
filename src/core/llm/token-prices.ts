/**
 * 群聊成本估算：**用户可配置的 token 价格表**
 *
 * ## 为什么仓库里一个厂商价格都不内置
 *
 * 同一模型在不同渠道/账号下的单价并不相同，供应商还会调价；把「某个日期查到的价格」
 * 写进代码，用户看到的会是一个**自信的错数** —— 比「未配置价格」更难发现。
 * 所以价格只能由用户显式配置（`codem-context-config.tokenPrices`），
 * 本模块不提供任何默认价目、也不从网络拉取。
 *
 * ## 配置形状（唯一口径）
 *
 * ```json
 * {
 *   "tokenPrices": {
 *     "aicodewith/claude-haiku-4-5-20251001": {
 *       "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25
 *     }
 *   },
 *   "tokenPriceCurrency": "$"
 * }
 * ```
 *
 * - key = `providerId/modelId`；也接受只写 `modelId`（provider 未知时使用，
 *   或作为已知 provider 匹配不到精确键时的**显式兜底**）。
 * - 四个价格都按**每 1M tokens**计；`cacheRead` / `cacheWrite` 省略 ⇒ 按 `input` 价计。
 * - `input` 是**未命中缓存**的输入价：`BotTurnUsage.inputTokens` 含缓存命中
 *   （见 `TokenUsage.promptTokens` 注释），计价前必须先扣掉 `cacheReadTokens`，
 *   否则缓存命中会被按两次输入价收费。
 * - `cacheWriteTokens` 是 Anthropic 独立的「写缓存」桶，不在 `inputTokens` 里，
 *   单独按 `cacheWrite` 价加一次。
 *
 * ## 未知绝不按 0
 *
 * 本模块只回答「这个模型有没有价格」与「按这个价格是多少」。**没有价格时返回 null**，
 * 由汇总层把整轮成本标成 null —— 不允许把缺价当 0，否则「一轮成本 $0」会被用户
 * 当成真的没花钱。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";

/** 与上下文压缩参数共用的唯一设置键（`codem-context-config`） */
const CONTEXT_CONFIG_KEY = "codem-context-config";
/** 价格表字段（按 providerId/modelId 配） */
const TOKEN_PRICES_FIELD = "tokenPrices";
/** 货币符号字段（默认 `$`；只影响展示，不做汇率换算） */
const TOKEN_PRICE_CURRENCY_FIELD = "tokenPriceCurrency";
/** 货币符号默认值 */
export const DEFAULT_TOKEN_PRICE_CURRENCY = "$";

/** 一个模型的四个单价（每 1M tokens） */
export interface TokenPrice {
  /** 未命中缓存的输入价 */
  input: number;
  /** 输出价 */
  output: number;
  /** 读缓存价；省略 ⇒ 按 input 价 */
  cacheRead?: number;
  /** 写缓存价；省略 ⇒ 按 input 价 */
  cacheWrite?: number;
}

/** 解析后的价格表（currency 已归一，prices 的 key 已 trim） */
export interface TokenPriceTable {
  currency: string;
  prices: Record<string, TokenPrice>;
}

/** 一次 usage 里计价需要的字段（结构类型，避免与 bots/types 循环依赖） */
interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只接受有限且非负的数字；其它（字符串/NaN/负数/缺失）一律当「没配」 */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 把 provider/model 归一成价格表 key。
 *
 * - 两者都有 ⇒ `provider/model`；
 * - 只有 model ⇒ `model`；
 * - 没有 model ⇒ null（没有模型名就无从匹配，不能猜）。
 */
export function tokenPriceKey(providerId?: string, modelId?: string): string | null {
  const model = (modelId ?? "").trim();
  if (model === "") return null;
  const provider = (providerId ?? "").trim();
  return provider === "" ? model : `${provider}/${model}`;
}

/**
 * 解析 `codem-context-config` 里的价格表（纯函数）。
 *
 * 坏形状的单条价格直接跳过（不猜、不补 0）；一条有效价格都没有 ⇒ null
 * （「配了一张空表」与「没配」对用户是同一件事）。
 */
export function parseTokenPriceTable(contextConfig: unknown): TokenPriceTable | null {
  if (!isRecord(contextConfig)) return null;
  const rawPrices = contextConfig[TOKEN_PRICES_FIELD];
  if (!isRecord(rawPrices)) return null;
  /* 空原型：用户可把模型/提供方名写成 `__proto__`，普通对象赋值会改原型而不是写键 */
  const prices: Record<string, TokenPrice> = Object.create(null) as Record<string, TokenPrice>;
  for (const [rawKey, rawPrice] of Object.entries(rawPrices)) {
    const key = rawKey.trim();
    if (key === "" || !isRecord(rawPrice)) continue;
    const input = finiteNonNegative(rawPrice.input);
    const output = finiteNonNegative(rawPrice.output);
    if (input === undefined || output === undefined) continue;
    const cacheRead = finiteNonNegative(rawPrice.cacheRead);
    const cacheWrite = finiteNonNegative(rawPrice.cacheWrite);
    prices[key] = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  }
  if (Object.keys(prices).length === 0) return null;
  const rawCurrency = contextConfig[TOKEN_PRICE_CURRENCY_FIELD];
  const currency =
    typeof rawCurrency === "string" && rawCurrency.trim() !== ""
      ? rawCurrency.trim()
      : DEFAULT_TOKEN_PRICE_CURRENCY;
  return { currency, prices };
}

/** 从设置里读当前价格表；没有配置 / 读失败 ⇒ null（未知，不是空表） */
export function readTokenPriceTable(): TokenPriceTable | null {
  try {
    return parseTokenPriceTable(getSettingJSON<unknown>(CONTEXT_CONFIG_KEY, null));
  } catch {
    return null;
  }
}

/**
 * 把价格表写回 `codem-context-config`（与压缩参数共用同一个键）。
 *
 * 只读改写 `tokenPrices` / `tokenPriceCurrency` 两个字段，**不动其它配置**；
 * 空表 ⇒ 删掉两个字段（回到「未配置」）。
 */
export function saveTokenPriceTable(table: TokenPriceTable): void {
  /**
   * ⚠️ 读失败**不写**：把读失败当「空配置」再整份写回，会把用户已有的
   * `compactionThreshold` 等参数一并抹掉 —— 那比「这次没保存」严重得多。
   * 异常向上抛，由设置面板显示「保存失败」。
   */
  const raw = getSettingJSON<unknown>(CONTEXT_CONFIG_KEY, null);
  const current: Record<string, unknown> = isRecord(raw) ? raw : {};
  const next: Record<string, unknown> = { ...current };
  if (Object.keys(table.prices).length === 0) {
    delete next[TOKEN_PRICES_FIELD];
    delete next[TOKEN_PRICE_CURRENCY_FIELD];
  } else {
    next[TOKEN_PRICES_FIELD] = table.prices;
    next[TOKEN_PRICE_CURRENCY_FIELD] =
      table.currency.trim() === "" ? DEFAULT_TOKEN_PRICE_CURRENCY : table.currency.trim();
  }
  setSettingJSON(CONTEXT_CONFIG_KEY, next);
}

/**
 * 为一个模型解析价格。
 *
 * 先按精确的 `provider/model`，再按裸 `model` 兜底（用户只关注模型、不区分渠道时
 * 可以只配一条；这条兜底是**显式匹配**，不是拿别的模型的价格来猜）。
 */
export function resolveTokenPrice(
  table: TokenPriceTable | null,
  providerId?: string,
  modelId?: string,
): TokenPrice | null {
  if (!table) return null;
  const exactKey = tokenPriceKey(providerId, modelId);
  if (exactKey !== null) {
    const exact = table.prices[exactKey];
    if (exact) return exact;
  }
  const bareKey = tokenPriceKey(undefined, modelId);
  if (bareKey === null) return null;
  return table.prices[bareKey] ?? null;
}

/**
 * 按价格表计算一次 usage 的成本（金额单位 = 配置的货币）。
 *
 * 分项：未命中输入 / 读缓存 / 写缓存 / 输出。缓存读省略价 ⇒ 按 input 价；
 * 缓存写省略价 ⇒ 按 input 价（与 `cost-tracker` 的平费率兜底同口径）。
 */
export function computeUsageCost(usage: PricedUsage, price: TokenPrice): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  /* inputTokens 含缓存命中；扣掉后才是「未命中输入」 */
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead);
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input;
  return (
    (uncachedInput * price.input +
      cacheRead * cacheReadRate +
      cacheWrite * cacheWriteRate +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

/** 人读的模型标识（缺模型名时如实说未知，不拿空串冒充） */
export function tokenPriceModelLabel(providerId?: string, modelId?: string): string {
  return tokenPriceKey(providerId, modelId) ?? "（未知模型）";
}

/** 估算金额的展示文本（4 位小数；货币符号由用户配置） */
export function formatEstimatedCost(cost: number, currency: string): string {
  const symbol = currency.trim() === "" ? DEFAULT_TOKEN_PRICE_CURRENCY : currency.trim();
  return `≈ ${symbol}${cost.toFixed(4)}`;
}
