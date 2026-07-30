/**
 * CorrectionModelConfig — 纠偏模型配置面板
 * 
 * 配置纠偏模型的 provider、model、是否启用
 * 保存在 settings 中，由 fact_check 工具读取
 */

import { useState, useEffect } from "react";
import { useLang } from "../core/i18n/lang";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";

export function CorrectionModelConfig() {
  const lang = useLang();
  const zh = lang === "zh";

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("gpt-4-turbo");

  useEffect(() => {
    const en = getSettingJSON<boolean>("correction-enabled", false);
    const prov = getSettingJSON<string>("correction-provider", "openai");
    const mdl = getSettingJSON<string>("correction-model", "gpt-4-turbo");
    setEnabled(en);
    setProvider(prov);
    setModel(mdl);
  }, []);

  const handleEnabledChange = (v: boolean) => {
    setEnabled(v);
    setSettingJSON("correction-enabled", v);
  };

  const handleProviderChange = (v: string) => {
    setProvider(v);
    setSettingJSON("correction-provider", v);
  };

  const handleModelChange = (v: string) => {
    setModel(v);
    setSettingJSON("correction-model", v);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 500 }}>
      {/* Enable toggle */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => handleEnabledChange(e.target.checked)}
          style={{ width: 16, height: 16, cursor: "pointer" }}
        />
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {zh ? "启用纠偏模式" : "Enable Correction Mode"}
        </span>
      </label>

      {enabled && (
        <>
          {/* Provider */}
          <div>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4, color: "var(--text-muted)" }}>
              {zh ? "纠偏模型提供商" : "Correction Model Provider"}
            </label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              style={{
                width: "100%", padding: "6px 8px", fontSize: 13,
                background: "var(--bg-tertiary)", color: "var(--text-primary)",
                border: "1px solid var(--border-color)", borderRadius: 4,
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {/* Model name */}
          <div>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4, color: "var(--text-muted)" }}>
              {zh ? "纠偏模型名称" : "Correction Model Name"}
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder="gpt-4-turbo"
              style={{
                width: "100%", padding: "6px 8px", fontSize: 13,
                background: "var(--bg-tertiary)", color: "var(--text-primary)",
                border: "1px solid var(--border-color)", borderRadius: 4,
                outline: "none",
              }}
            />
          </div>

          <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {zh
              ? "纠偏模型会在 AI 每次回复后自动检查事实错误、不准确表述和误导性陈述。注意：当前为占位实现，尚未接入真实 API。"
              : "The correction model automatically checks AI responses for factual errors, inaccuracies, and misleading statements. Note: Currently a placeholder, not yet connected to real API."}
          </p>
        </>
      )}
    </div>
  );
}
