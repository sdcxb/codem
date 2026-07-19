/**
 * F4: 多模态设置面板
 *
 * 配置 Embedding / TTS / ImageGen 三个多模态能力的 Provider 和模型。
 */

import { useState, useEffect } from "react";
import {
  getMultimodalSettings,
  saveMultimodalSettings,
  MULTIMODAL_MODELS,
  isLocalEmbeddingProvider,
  getDefaultLocalEmbeddingConfig,
  type MultimodalSettings,
  type MultimodalProviderConfig,
} from "../core/llm/multimodal";
import { getSettingJSON } from "../core/storage/settings";
import { AVAILABLE_LOCAL_MODELS, getStatus as getLocalStatus, type LocalEmbeddingStatus } from "../core/knowledge/local-embedding";

interface ProviderKey {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
}

interface MultimodalPanelProps {
  onClose: () => void;
}

export function MultimodalPanel({ onClose }: MultimodalPanelProps) {
  const [settings, setSettings] = useState<MultimodalSettings>({
    embedding: null,
    tts: null,
    imageGen: null,
  });
  const [saved, setSaved] = useState(false);
  const [localStatus, setLocalStatus] = useState<LocalEmbeddingStatus>(getLocalStatus());

  useEffect(() => {
    setSettings(getMultimodalSettings());
    // 定期轮询本地模型状态
    const interval = setInterval(() => {
      setLocalStatus(getLocalStatus());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Load existing provider keys from codem-settings for quick selection
  const providerKeys: ProviderKey[] = getSettingJSON<{ providers?: ProviderKey[] }>("codem-settings", { providers: [] })?.providers || [];

  const handleSave = () => {
    saveMultimodalSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updateModality = (
    modality: "embedding" | "tts" | "imageGen",
    field: keyof MultimodalProviderConfig,
    value: string | boolean,
  ) => {
    setSettings(prev => {
      const current = prev[modality] || {
        providerId: "openai",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        model: "",
        enabled: true,
      };
      return {
        ...prev,
        [modality]: { ...current, [field]: value },
      };
    });
  };

  const toggleModality = (modality: "embedding" | "tts" | "imageGen", enabled: boolean) => {
    if (enabled) {
      // Enable: create config from first provider with API key
      const provider = providerKeys.find(p => p.apiKey) || providerKeys[0];
      const models = MULTIMODAL_MODELS[provider?.id || "openai"];
      const defaultModel = modality === "embedding" ? models?.embedding[0]
        : modality === "tts" ? models?.tts[0]
        : models?.imageGen[0];

      setSettings(prev => ({
        ...prev,
        [modality]: {
          providerId: provider?.id || "openai",
          apiKey: provider?.apiKey || "",
          baseUrl: provider?.baseUrl || "https://api.openai.com/v1",
          model: defaultModel || "",
          enabled: true,
        },
      }));
    } else {
      setSettings(prev => ({ ...prev, [modality]: null }));
    }
  };

  const renderModalityConfig = (
    modality: "embedding" | "tts" | "imageGen",
    title: string,
    icon: string,
    description: string,
  ) => {
    const config = settings[modality];
    const isEnabled = config !== null;
    const models = MULTIMODAL_MODELS[config?.providerId || "openai"];
    const availableModels = modality === "embedding" ? models?.embedding
      : modality === "tts" ? models?.tts
      : models?.imageGen;

    return (
      <div
        key={modality}
        style={{
          padding: 12,
          background: "var(--bg-secondary)",
          borderRadius: 8,
          border: `1px solid ${isEnabled ? "var(--accent)" : "var(--border-primary)"}`,
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <span style={{ fontSize: 16, marginRight: 6 }}>{icon}</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          </div>
          <label style={{ cursor: "pointer", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => toggleModality(modality, e.target.checked)}
            />
            {isEnabled ? "已启用" : "已禁用"}
          </label>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: isEnabled ? 10 : 0 }}>
          {description}
        </div>

        {/* Embedding 未配置时显示默认本地模型提示 */}
        {!isEnabled && modality === "embedding" && (
          <div style={{
            marginTop: 8,
            padding: "6px 10px",
            background: "rgba(34,197,94,0.08)",
            borderRadius: 6,
            fontSize: 11,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
            border: "1px solid rgba(34,197,94,0.2)",
          }}>
            ✅ 当前默认使用内置本地模型（{getDefaultLocalEmbeddingConfig().model}，~22MB），
            随安装包打包，无需配置 API Key，安装后即可离线使用。如需更高精度，可启用后选择其他本地模型或远程 API。
          </div>
        )}

        {isEnabled && config && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Provider selector */}
            <div>
              <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
                Provider
              </label>
              <select
                value={config.providerId}
                onChange={(e) => {
                  const newProviderId = e.target.value;
                  if (newProviderId === "local") {
                    // 本地模式：无需 API Key 和 Base URL
                    setSettings(prev => ({
                      ...prev,
                      [modality]: {
                        ...prev[modality]!,
                        providerId: "local",
                        apiKey: "",
                        baseUrl: "",
                        model: AVAILABLE_LOCAL_MODELS[0].id,
                      },
                    }));
                  } else {
                    const selected = providerKeys.find(p => p.id === newProviderId);
                    updateModality(modality, "providerId", newProviderId);
                    if (selected) {
                      updateModality(modality, "apiKey", selected.apiKey);
                      updateModality(modality, "baseUrl", selected.baseUrl);
                    }
                  }
                }}
                style={{ width: "100%", fontSize: 12 }}
              >
                {providerKeys.map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.apiKey ? " ✓" : ""}</option>
                ))}
                {/* 本地模型选项（仅 Embedding 可用） */}
                {modality === "embedding" && (
                  <option value="local">🖥️ 本地模型 (ONNX Runtime)</option>
                )}
              </select>
            </div>

            {/* === 本地模式特殊 UI === */}
            {modality === "embedding" && isLocalEmbeddingProvider(config) ? (
              <>
                {/* 本地模型选择器 */}
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
                    本地模型
                  </label>
                  <select
                    value={config.model}
                    onChange={(e) => updateModality(modality, "model", e.target.value)}
                    style={{ width: "100%", fontSize: 12 }}
                  >
                    {AVAILABLE_LOCAL_MODELS.map(m => (
                      <option key={m.id} value={m.id}>{m.name} ({m.size})</option>
                    ))}
                  </select>
                </div>

                {/* 模型详情 */}
                {(() => {
                  const modelInfo = AVAILABLE_LOCAL_MODELS.find(m => m.id === config.model);
                  if (!modelInfo) return null;
                  return (
                    <div style={{
                      padding: 8,
                      background: "var(--bg-tertiary, var(--bg-primary))",
                      borderRadius: 6,
                      fontSize: 11,
                      color: "var(--text-secondary)",
                      lineHeight: 1.6,
                    }}>
                      <div style={{ marginBottom: 4 }}>{modelInfo.description}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        <span style={{
                          padding: "1px 6px",
                          background: "var(--bg-secondary)",
                          borderRadius: 3,
                          fontSize: 10,
                        }}>维度: {modelInfo.dim}</span>
                        <span style={{
                          padding: "1px 6px",
                          background: "var(--bg-secondary)",
                          borderRadius: 3,
                          fontSize: 10,
                        }}>{modelInfo.languages}</span>
                        <span style={{
                          padding: "1px 6px",
                          background: "var(--bg-secondary)",
                          borderRadius: 3,
                          fontSize: 10,
                        }}>{modelInfo.license}</span>
                      </div>
                    </div>
                  );
                })()}

                {/* 模型状态指示器 */}
                <div style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  background: localStatus.state === "ready" ? "rgba(34,197,94,0.1)"
                    : localStatus.state === "loading" ? "rgba(59,130,246,0.1)"
                    : localStatus.state === "error" ? "rgba(239,68,68,0.1)"
                    : "var(--bg-tertiary, var(--bg-primary))",
                  color: localStatus.state === "ready" ? "var(--success)"
                    : localStatus.state === "error" ? "var(--danger)"
                    : "var(--text-secondary)",
                }}>
                  {localStatus.state === "ready" && "✅ 模型已加载，可正常使用"}
                  {localStatus.state === "loading" && `⏳ ${localStatus.message || "正在加载..."}`}
                  {localStatus.state === "not-loaded" && "⚪ 模型未加载（首次使用时自动下载）"}
                  {localStatus.state === "error" && `❌ ${localStatus.message || "加载失败"}`}
                </div>

                {/* 说明文字 */}
                <div style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.6,
                  padding: "4px 0",
                }}>
                  💡 本地模式无需 API Key，模型在本地运行（ONNX Runtime WASM）。
                  默认模型（all-MiniLM-L6-v2）已随安装包内置，开箱即用。
                  其他模型首次使用时从 HuggingFace 下载并缓存。超长文本自动子分块处理。
                </div>
              </>
            ) : (
              <>
                {/* === 远程模式 UI（原有逻辑） === */}

                {/* Model selector */}
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
                    模型
                  </label>
                  {availableModels && availableModels.length > 0 ? (
                    <select
                      value={config.model}
                      onChange={(e) => updateModality(modality, "model", e.target.value)}
                      style={{ width: "100%", fontSize: 12 }}
                    >
                      {availableModels.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={config.model}
                      onChange={(e) => updateModality(modality, "model", e.target.value)}
                      placeholder="输入模型名称"
                      style={{ width: "100%", fontSize: 12 }}
                    />
                  )}
                </div>

                {/* API Key */}
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
                    API Key
                  </label>
                  <input
                    type="password"
                    value={config.apiKey}
                    onChange={(e) => updateModality(modality, "apiKey", e.target.value)}
                    placeholder="API Key"
                    style={{ width: "100%", fontSize: 12 }}
                  />
                </div>

                {/* Base URL */}
                <div>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={config.baseUrl}
                    onChange={(e) => updateModality(modality, "baseUrl", e.target.value)}
                    style={{ width: "100%", fontSize: 12 }}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 480,
        height: "100%",
        background: "var(--bg-primary)",
        borderLeft: "1px solid var(--border-primary)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>🎨 多模态设置</h3>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          配置 Embedding（语义搜索）、TTS（语音合成）、ImageGen（图像生成）三种多模态能力。
          启用后 AI 助手可以在对话中使用这些能力。
        </div>

        {renderModalityConfig(
          "embedding",
          "Embedding 语义搜索",
          "🔍",
          "将文本转为向量进行语义相似度搜索。未配置时默认使用本地模型（ONNX Runtime，无需 API Key），也可选择远程 API（OpenAI/Gemini）。",
        )}

        {renderModalityConfig(
          "tts",
          "TTS 语音合成",
          "🔊",
          "将文本转为语音播放，支持多种音色和语速。",
        )}

        {renderModalityConfig(
          "imageGen",
          "ImageGen 图像生成",
          "🎨",
          "根据文字描述生成图像，支持多种尺寸和质量选项。",
        )}
      </div>

      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid var(--border-primary)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {saved && (
          <span style={{ fontSize: 12, color: "var(--success)" }}>✅ 已保存</span>
        )}
        <button
          onClick={handleSave}
          style={{
            marginLeft: "auto",
            padding: "8px 20px",
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}
