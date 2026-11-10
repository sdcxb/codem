/**
 * 设置 · 用量 · **模型成本价格表**（2026-11 边界补齐）
 *
 * ## 为什么放在「用量」页签
 *
 * 价格只服务一个用途：把一轮调用的 token 读数换算成钱。它既不是模型配置
 * （不影响请求），也不是全局计费口径（`cost-tracker` 有自己的一套内置表），
 * 放在「用量」下与 token 读数相邻，用户看到「未配置价格」时能就地补上。
 *
 * ## 交互约束
 *
 * - **增删价格行**：provider / model / 输入 / 输出 / 缓存读 / 缓存写；
 * - **只写有效行**：model 为空或输入/输出不是非负有限数的行不落库（界面提示未填完），
 *   不拿 0 冒充缺失价格；
 * - 读写只碰 `codem-context-config.tokenPrices` / `tokenPriceCurrency`，
 *   与上下文压缩参数共用同一个键但不覆盖它们；
 * - 本组件**不内置任何厂商价格**，也不提供「一键填充」——价格只能由用户自己填。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TOKEN_PRICE_CURRENCY,
  readTokenPriceTable,
  saveTokenPriceTable,
  tokenPriceKey,
  type TokenPrice,
  type TokenPriceTable,
} from "../core/llm/token-prices";

interface PriceRowDraft {
  /** React key（增删行时保持输入框身份，不用数组下标） */
  id: number;
  providerId: string;
  modelId: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

type SaveState = "idle" | "saved" | "failed";

/** 四个价格的输入框共用一份定义（避免六段几乎相同的 JSX 漂移） */
const PRICE_FIELDS = [
  { key: "input", testId: "token-price-input", placeholder: "输入", label: "输入价" },
  { key: "output", testId: "token-price-output", placeholder: "输出", label: "输出价" },
  { key: "cacheRead", testId: "token-price-cache-read", placeholder: "缓存读", label: "缓存读价" },
  { key: "cacheWrite", testId: "token-price-cache-write", placeholder: "缓存写", label: "缓存写价" },
] as const;

function emptyRow(id: number): PriceRowDraft {
  return { id, providerId: "", modelId: "", input: "", output: "", cacheRead: "", cacheWrite: "" };
}

/** 空串 = 未填；其它必须是有限非负数，否则返回 undefined（不落库） */
function parsePriceInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 价格表 key → 行草稿（`provider/model` 或裸 `model`） */
function rowFromKey(id: number, key: string, price: TokenPrice): PriceRowDraft {
  const slash = key.indexOf("/");
  const providerId = slash > 0 ? key.slice(0, slash) : "";
  const modelId = slash > 0 ? key.slice(slash + 1) : key;
  return {
    id,
    providerId,
    modelId,
    input: String(price.input),
    output: String(price.output),
    cacheRead: price.cacheRead === undefined ? "" : String(price.cacheRead),
    cacheWrite: price.cacheWrite === undefined ? "" : String(price.cacheWrite),
  };
}

/** 行草稿 → 价格表（只收有效行；重复 key 后者覆盖前者，与设置里同一键的语义一致） */
function rowsToTable(rows: readonly PriceRowDraft[], currency: string): TokenPriceTable {
  /* 空原型：model 名可能被写成 `__proto__`，普通对象赋值会改原型而不是写键 */
  const prices: Record<string, TokenPrice> = Object.create(null) as Record<string, TokenPrice>;
  for (const row of rows) {
    const key = tokenPriceKey(row.providerId, row.modelId);
    if (key === null) continue;
    const input = parsePriceInput(row.input);
    const output = parsePriceInput(row.output);
    if (input === undefined || output === undefined) continue;
    const cacheRead = parsePriceInput(row.cacheRead);
    const cacheWrite = parsePriceInput(row.cacheWrite);
    prices[key] = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  }
  return {
    currency: currency.trim() === "" ? DEFAULT_TOKEN_PRICE_CURRENCY : currency.trim(),
    prices,
  };
}

export function TokenPricesPanel() {
  const [rows, setRows] = useState<PriceRowDraft[]>([]);
  const [currency, setCurrency] = useState(DEFAULT_TOKEN_PRICE_CURRENCY);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const nextRowId = useRef(1);

  useEffect(() => {
    const table = readTokenPriceTable();
    if (!table) return;
    const loaded = Object.entries(table.prices).map(([key, price]) =>
      rowFromKey(nextRowId.current++, key, price),
    );
    setRows(loaded);
    setCurrency(table.currency);
  }, []);

  const persist = useCallback((nextRows: readonly PriceRowDraft[], nextCurrency: string) => {
    try {
      saveTokenPriceTable(rowsToTable(nextRows, nextCurrency));
      setSaveState("saved");
    } catch {
      /* 写失败不能静默（用户以为保存了、用量却仍显示未配置价格） */
      setSaveState("failed");
    }
  }, []);

  const updateRow = (id: number, patch: Partial<PriceRowDraft>) => {
    const next = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    setRows(next);
    persist(next, currency);
  };

  const addRow = () => {
    /* 空行先不落库：没有 model / 价格的行不该在设置里留下一个「看起来配了」的壳 */
    setRows((prev) => [...prev, emptyRow(nextRowId.current++)]);
  };

  const removeRow = (id: number) => {
    const next = rows.filter((row) => row.id !== id);
    setRows(next);
    persist(next, currency);
  };

  const changeCurrency = (value: string) => {
    setCurrency(value);
    persist(rows, value);
  };

  /**
   * 有效行 = model 非空且输入/输出都可解析。界面用它解释「为什么某行没生效」，
   * 不把未填完的行写成 0。
   */
  const validRowCount = rows.filter(
    (row) =>
      tokenPriceKey(row.providerId, row.modelId) !== null &&
      parsePriceInput(row.input) !== undefined &&
      parsePriceInput(row.output) !== undefined,
  ).length;
  const incompleteRowCount = rows.length - validRowCount;

  return (
    <section className="sp-col" data-testid="token-prices-panel" aria-label="模型成本价格表">
      <div className="sp-row sp-row--between">
        <h3 className="sp-title">模型成本价格表</h3>
        <span className="sp-mini" data-testid="token-price-status" data-save-state={saveState}>
          {saveState === "saved"
            ? "已保存（只影响之后派发的群消息）"
            : saveState === "failed"
              ? "保存失败：设置未写入，重启后会丢失"
              : "每 1M tokens 计价；省略缓存价 ⇒ 按输入价"}
        </span>
      </div>
      <p className="sp-hint sp-hint--relaxed">
        这里不内置任何厂商价格，也不自动更新 —— 同一模型在不同渠道的单价不同，内置价格会过期误导。
        只有「这一轮每个已上报调用的模型都能匹配到价格」时才显示估算金额；缺一个就显示「未配置价格」，绝不按 0 计算。
      </p>

      <div className="sp-row sp-row--gap-sm">
        <label className="sp-mini" htmlFor="token-price-currency">货币符号</label>
        <input
          id="token-price-currency"
          className="sp-input sp-input--number"
          data-testid="token-price-currency"
          value={currency}
          onChange={(event) => changeCurrency(event.target.value)}
          aria-label="货币符号（默认 $）"
          placeholder="$"
        />
        <span className="sp-mini">例如 $ / ¥ / €（只用于显示，不做汇率换算）</span>
      </div>

      <div className="sp-col sp-col--tight" data-testid="token-price-rows">
        {rows.length === 0 && (
          <div className="sp-hint" data-testid="token-price-empty">
            还没有价格行。点下面的「添加价格行」，按 provider / model 填四个单价。
          </div>
        )}
        {rows.map((row, index) => (
          <div
            className="sp-row sp-row--wrap sp-row--gap-sm"
            data-testid="token-price-row"
            key={row.id}
          >
            <input
              className="sp-input sp-input--inline"
              data-testid="token-price-provider"
              value={row.providerId}
              onChange={(event) => updateRow(row.id, { providerId: event.target.value })}
              aria-label={`价格行 ${index + 1} 提供方（可留空）`}
              placeholder="providerId（可留空）"
            />
            <input
              className="sp-input sp-input--inline"
              data-testid="token-price-model"
              value={row.modelId}
              onChange={(event) => updateRow(row.id, { modelId: event.target.value })}
              aria-label={`价格行 ${index + 1} 模型`}
              placeholder="modelId（必填）"
            />
            {PRICE_FIELDS.map((field) => (
              <input
                key={field.key}
                className="sp-input sp-input--number"
                data-testid={field.testId}
                value={row[field.key]}
                onChange={(event) => updateRow(row.id, { [field.key]: event.target.value })}
                inputMode="decimal"
                aria-label={`价格行 ${index + 1} ${field.label}（每 1M tokens${
                  field.key.startsWith("cache") ? "，可留空" : ""
                }）`}
                placeholder={field.placeholder}
              />
            ))}
            <button
              className="sp-btn sp-btn--danger-ghost sp-btn--sm"
              data-testid="token-price-remove"
              onClick={() => removeRow(row.id)}
              aria-label={`删除价格行 ${index + 1}`}
              title="删除这一行"
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <div className="sp-row sp-row--gap-sm">
        <button className="sp-btn sp-btn--dashed" data-testid="token-price-add" onClick={addRow}>
          添加价格行
        </button>
        {rows.length > 0 && (
          <span className="sp-mini" data-testid="token-price-summary">
            {validRowCount} 行已写入价格表
            {incompleteRowCount > 0
              ? `；${incompleteRowCount} 行还没填完（model / 输入 / 输出），不会写入`
              : ""}
          </span>
        )}
      </div>
    </section>
  );
}
