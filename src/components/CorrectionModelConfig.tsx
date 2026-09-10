/**
 * CorrectionModelConfig — 纠偏模型配置面板（真实生效，非占位）
 *
 * 作用：配置 fact_check 工具做事实核查时使用的「专属纠偏模型」。
 * 设置保存在持久化 key `codem-correction-model`（JSON: { provider, model, apiKey, baseUrl }），
 * fact_check 工具（src/core/llm/tools/fact-check.ts）在执行时读取：
 *  - 已保存配置 → 用该专属纠偏模型发起真实 LLM 请求（apiKey/baseUrl 留空则复用该
 *    provider 在全局设置中的 API Key / 地址）；
 *  - 未保存 → fact_check 自动回退使用当前主对话模型，并在结果中附注
 *    「未配置专属纠偏模型，本次使用主模型核查」（诚实标注，不静默假默认）。
 *
 * 保存 / 清除后派发 window "codem-settings-changed" 事件，让其它监听方（引擎重配置等）刷新。
 */

import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import { useLang } from "../core/i18n/lang";
import { getSettingJSON, setSettingJSON, removeSetting } from "../core/storage/settings";

const SETTING_KEY = "codem-correction-model";

/** provider 建议列表（可自由输入自定义 provider id，用于复用其全局 Key/地址） */
const PROVIDER_SUGGESTIONS: Array<{ id: string; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "gemini", label: "Google Gemini" },
  { id: "moonshot", label: "Moonshot (Kimi)" },
  { id: "ollama", label: "Ollama (本地)" },
  { id: "custom", label: "自定义 (OpenAI 兼容)" },
];

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: "var(--fs-base)",
  background: "var(--bg-tertiary)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  borderRadius: 4,
  outline: "none",
};

export function CorrectionModelConfig() {
  const lang = useLang();
  const zh = lang === "zh";

  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  /** 当前已持久化的配置（用于显示"当前生效"状态） */
  const [saved, setSaved] = useState<{ provider: string; model: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cfg = getSettingJSON<{
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
    } | null>(SETTING_KEY, null);
    if (cfg) {
      setProvider(cfg.provider || "openai");
      setModel(cfg.model || "");
      setApiKey(cfg.apiKey || "");
      setBaseUrl(cfg.baseUrl || "");
      if (cfg.provider && cfg.model) {
        setSaved({ provider: cfg.provider, model: cfg.model });
      }
    }
  }, []);

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  const handleSave = () => {
    const p = provider.trim();
    const m = model.trim();
    if (!p || !m) {
      setError(zh ? "Provider 与模型名称必填，请填写后再保存。" : "Provider and model name are required.");
      return;
    }
    setError(null);
    setSettingJSON(SETTING_KEY, {
      provider: p,
      model: m,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
    });
    setSaved({ provider: p, model: m });
    window.dispatchEvent(new Event("codem-settings-changed"));
    showFlash(zh ? "✅ 已保存 — fact_check 将使用该专属纠偏模型" : "✅ Saved — fact_check will use this model");
  };

  const handleClear = () => {
    removeSetting(SETTING_KEY);
    setSaved(null);
    setError(null);
    window.dispatchEvent(new Event("codem-settings-changed"));
    showFlash(zh ? "已清除 — fact_check 将回退使用主模型" : "Cleared — fact_check falls back to the main model");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 500 }}>
      {/* 真实说明（替代原占位注释） */}
      <div
        style={{
          fontSize: "var(--fs-sm)",
          color: "var(--text-muted)",
          lineHeight: 1.6,
          padding: 10,
          background: "var(--bg-tertiary)",
          border: "1px solid var(--border-color)",
          borderRadius: 6,
        }}
      >
        {zh
          ? "配置 fact_check 工具在事实核查时使用的「专属纠偏模型」。保存后生效：已配置 → 用该模型做真实核查；未配置 → 自动回退使用当前主对话模型，并在核查结果中附注「未配置专属纠偏模型，本次使用主模型核查」。API Key / Base URL 留空时复用该 provider 在全局设置中的凭证。"
          : "Configure the dedicated model fact_check uses to verify AI responses. Once saved it takes effect: configured → real fact-check via this model; not configured → falls back to the current main chat model, and the result notes this honestly. Empty API Key / Base URL reuse that provider's global credentials."}
      </div>

      {/* Provider */}
      <div>
        <label style={{ display: "block", fontSize: "var(--fs-sm)", marginBottom: 4, color: "var(--text-muted)" }}>
          {zh ? "Provider（提供商 ID）" : "Provider"}
        </label>
        <input
          type="text"
          list="correction-provider-suggestions"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="deepseek / openai / anthropic / gemini / …"
          style={inputStyle}
        />
        <datalist id="correction-provider-suggestions">
          {PROVIDER_SUGGESTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </datalist>
        <p style={{ fontSize: "var(--fs-xs, 12px)", color: "var(--text-muted)", margin: "4px 0 0" }}>
          {zh ? "填写全局设置中已配置的 provider id 即可自动复用其 API Key 与地址。" : "Use a provider id from your global settings to reuse its API key and base URL."}
        </p>
      </div>

      {/* Model name */}
      <div>
        <label style={{ display: "block", fontSize: "var(--fs-sm)", marginBottom: 4, color: "var(--text-muted)" }}>
          {zh ? "纠偏模型名称" : "Model Name"}
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="deepseek-v4-flash / gpt-4o / claude-sonnet-4-20250514 / …"
          style={inputStyle}
        />
      </div>

      {/* API Key (optional) */}
      <div>
        <label style={{ display: "block", fontSize: "var(--fs-sm)", marginBottom: 4, color: "var(--text-muted)" }}>
          {zh ? "API Key（可选）" : "API Key (optional)"}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={zh ? "留空 = 使用该 provider 的全局 API Key" : "Empty = use the provider's global API key"}
          autoComplete="off"
          style={inputStyle}
        />
      </div>

      {/* Base URL (optional) */}
      <div>
        <label style={{ display: "block", fontSize: "var(--fs-sm)", marginBottom: 4, color: "var(--text-muted)" }}>
          {zh ? "Base URL（可选）" : "Base URL (optional)"}
        </label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com"
          style={inputStyle}
        />
      </div>

      {/* 当前生效状态 */}
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {saved
          ? zh
            ? <>当前生效：专属纠偏模型 <b>{saved.provider}/{saved.model}</b>（未保存的表单改动需点击保存）</>
            : <>Active: dedicated correction model <b>{saved.provider}/{saved.model}</b> (unsaved edits need Save)</>
          : zh
            ? <>当前未配置专属纠偏模型 — fact_check 将<b>回退使用主模型</b>核查，并在结果中标注。</>
            : <>No dedicated correction model configured — fact_check <b>falls back to the main model</b> and notes it in the result.</>}
      </div>

      {/* 保存 / 清除 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={handleSave}
          style={{
            padding: "8px 16px",
            fontSize: "var(--fs-base)",
            cursor: "pointer",
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            border: "none",
            borderRadius: 6,
          }}
        >
          {zh ? "保存配置" : "Save Config"}
        </button>
        <button
          onClick={handleClear}
          style={{
            padding: "8px 16px",
            fontSize: "var(--fs-base)",
            cursor: "pointer",
            background: "var(--bg-tertiary)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
          }}
        >
          {zh ? "清除配置（回退主模型）" : "Clear (use main model)"}
        </button>
        {flash && <span style={{ fontSize: "var(--fs-sm)", color: "var(--success, #22c55e)" }}>{flash}</span>}
      </div>

      {error && (
        <p style={{ fontSize: "var(--fs-sm)", color: "var(--danger, #ef4444)", margin: 0 }}>{error}</p>
      )}
    </div>
  );
}
