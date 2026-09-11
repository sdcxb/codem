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
import { ActionIcons } from "../core/icons/icon-map";

interface ProviderKey {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
}

interface MultimodalPanelProps {
  onClose: () => void;
  /** 内联模式：不使用浮动定位，直接嵌在父容器中 */
  inline?: boolean;
}

export function MultimodalPanel({ onClose, inline }: MultimodalPanelProps) {
  const [settings, setSettings] = useState<MultimodalSettings>({
    vision: null,
    stt: null,
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
    modality: "vision" | "stt" | "embedding" | "tts" | "imageGen",
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

  const toggleModality = (modality: "vision" | "stt" | "embedding" | "tts" | "imageGen", enabled: boolean) => {
    if (enabled) {
      // Enable: create config from first provider with API key
      const provider = providerKeys.find(p => p.apiKey) || providerKeys[0];
      const models = MULTIMODAL_MODELS[provider?.id || "openai"];
      const defaultModel = modality === "vision" ? models?.vision[0]
        : modality === "stt" ? models?.stt[0]
        : modality === "embedding" ? models?.embedding[0]
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
    modality: "vision" | "stt" | "embedding" | "tts" | "imageGen",
    title: string,
    icon: string,
    description: string,
  ) => {
    const config = settings[modality];
    const isEnabled = config !== null;
    const models = MULTIMODAL_MODELS[config?.providerId || "openai"];
    const availableModels = modality === "vision" ? models?.vision
      : modality === "stt" ? models?.stt
      : modality === "embedding" ? models?.embedding
      : modality === "tts" ? models?.tts
      : models?.imageGen;

    return (
      <div
        key={modality}
        className={`mm-card${isEnabled ? " is-enabled" : ""}`}
      >
        <div className="mm-card-head">
          <div>
            <span className="mm-card-icon">{icon}</span>
            <span className="mm-card-title">{title}</span>
          </div>
          <label className="mm-toggle">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => toggleModality(modality, e.target.checked)}
            />
            {isEnabled ? "已启用" : "已禁用"}
          </label>
        </div>
        <div className={`mm-card-desc${isEnabled ? "" : " mm-card-desc--tight"}`}>
          {description}
        </div>

        {/* Embedding 未配置时显示默认本地模型提示 */}
        {!isEnabled && modality === "embedding" && (
          <div className="mm-note">
            ✅ 当前默认使用内置本地模型（{getDefaultLocalEmbeddingConfig().model}，~22MB），
            随安装包打包，无需配置 API Key，安装后即可离线使用。如需更高精度，可启用后选择其他本地模型或远程 API。
          </div>
        )}

        {isEnabled && config && (
          <div className="mm-fields">
            {/* Provider selector */}
            <div>
              <label className="mm-label">
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
                className="mm-control"
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
                  <label className="mm-label">
                    本地模型
                  </label>
                  <select
                    value={config.model}
                    onChange={(e) => updateModality(modality, "model", e.target.value)}
                    className="mm-control"
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
                    <div className="mm-model-info">
                      <div className="mm-model-desc">{modelInfo.description}</div>
                      <div className="mm-model-tags">
                        <span className="mm-tag">维度: {modelInfo.dim}</span>
                        <span className="mm-tag">{modelInfo.languages}</span>
                        <span className="mm-tag">{modelInfo.license}</span>
                      </div>
                    </div>
                  );
                })()}

                {/* 模型状态指示器 */}
                <div className={`mm-status is-${localStatus.state === "ready" ? "ready" : localStatus.state === "loading" ? "loading" : localStatus.state === "error" ? "error" : "idle"}`}>
                  {localStatus.state === "ready" && "✅ 模型已加载，可正常使用"}
                  {localStatus.state === "loading" && `⏳ ${localStatus.message || "正在加载..."}`}
                  {localStatus.state === "not-loaded" && "⚪ 模型未加载（首次使用时自动下载）"}
                  {localStatus.state === "error" && `❌ ${localStatus.message || "加载失败"}`}
                </div>

                {/* 说明文字 */}
                <div className="mm-help">
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
                  <label className="mm-label">
                    模型
                  </label>
                  {availableModels && availableModels.length > 0 ? (
                    <select
                      value={config.model}
                      onChange={(e) => updateModality(modality, "model", e.target.value)}
                      className="mm-control"
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
                      className="mm-control"
                    />
                  )}
                </div>

                {/* API Key */}
                <div>
                  <label className="mm-label">
                    API Key
                  </label>
                  <input
                    type="password"
                    value={config.apiKey}
                    onChange={(e) => updateModality(modality, "apiKey", e.target.value)}
                    placeholder="API Key"
                    className="mm-control"
                  />
                </div>

                {/* Base URL */}
                <div>
                  <label className="mm-label">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={config.baseUrl}
                    onChange={(e) => updateModality(modality, "baseUrl", e.target.value)}
                    className="mm-control"
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
      className={inline ? "mm-panel-inline" : "floating-overlay-panel mm-panel-floating"}
    >
      <div className="mm-header">
        <h3 className="mm-title">🎨 多模态设置</h3>
        <button
          onClick={onClose}
          className="mm-close"
          aria-label="关闭"
        >
          <ActionIcons.close size={16} />
        </button>
      </div>

      <div className="mm-body">
        <div className="mm-intro">
          配置 Embedding（语义搜索）、TTS（语音合成）、ImageGen（图像生成）三种多模态能力。
          启用后 AI 助手可以在对话中使用这些能力。
        </div>

        {renderModalityConfig(
          "vision",
          "Vision 图片理解",
          "📷",
          "图片理解/OCR。当主对话模型不支持视觉（如 DeepSeek）时，自动调用视觉模型描述图片内容，再将描述转发给主模型。支持视觉的模型（如 GPT-4o）则直接传图。",
        )}

        {renderModalityConfig(
          "stt",
          "STT 语音输入",
          "🎤",
          "将语音转为文字输入（预留功能，需要 Whisper 等模型支持）。",
        )}

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

      <div className="mm-footer">
        {saved && (
          <span className="mm-saved">✅ 已保存</span>
        )}
        <button
          onClick={handleSave}
          className="panel-btn panel-btn--primary mm-save-btn"
        >
          保存
        </button>
      </div>
    </div>
  );
}
