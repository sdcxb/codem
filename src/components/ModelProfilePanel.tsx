import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useLang } from "../core/i18n/lang";
import {
  getModelProfileManager,
  type ModelProfile,
  type TaskSlot,
  type ModelSlotConfig,
} from "../core/llm/model-profile";
import { getSettingJSON } from "../core/storage/settings";
import { MIMO_MODELS } from "../core/model-config";

// ========== Constants ==========

const SLOT_LABELS_ZH: Record<TaskSlot, string> = {
  chat: "主对话",
  subagent: "子智能体",
  memory: "记忆提取",
  compaction: "上下文压缩",
  vision: "视觉理解",
  tts: "语音合成",
  imageGen: "图像生成",
  embedding: "向量嵌入",
};

const SLOT_LABELS_EN: Record<TaskSlot, string> = {
  chat: "Chat",
  subagent: "Sub-agent",
  memory: "Memory",
  compaction: "Compaction",
  vision: "Vision",
  tts: "TTS",
  imageGen: "Image Gen",
  embedding: "Embedding",
};

const SLOT_DESCRIPTIONS_ZH: Record<TaskSlot, string> = {
  chat: "主 agentic 循环，处理用户的主要请求",
  subagent: "子任务执行器（探索、搜索、通用任务）",
  memory: "从对话中提取持久化记忆",
  compaction: "上下文窗口压缩时的摘要生成",
  vision: "图片理解代理 — 当主模型不支持视觉时，用此模型描述图片内容",
  tts: "文本转语音（预留）",
  imageGen: "图像生成（预留）",
  embedding: "语义搜索向量化（预留）",
};

/**
 * 从存储读取已配置 API Key 的 provider 列表和动态模型列表。
 * Provider 列表来自 codem-settings.providers，模型列表来自 codem-dynamic-models。
 * 如果动态模型不存在，回退到 API_MODELS 静态列表。
 */
interface ProviderWithModels {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

function getAvailableProviders(): ProviderWithModels[] {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = settings.providers || [];
    const dynamicModels = getSettingJSON<Record<string, Array<{ id: string; name: string }>>>("codem-dynamic-models", {});

    const result: ProviderWithModels[] = [];

    // MiMo provider 始终可用（CLI 模式），用静态列表
    result.push({
      id: "mimo",
      name: "MiMo",
      models: MIMO_MODELS.map(m => ({ id: m.id, name: m.name })),
    });

    // 已配置 API Key 的 provider
    for (const p of providers) {
      if (!p.apiKey || p.id === "mimo") continue;
      // 优先使用动态模型列表
      const dynModels = dynamicModels[p.id];
      if (dynModels && dynModels.length > 0) {
        result.push({ id: p.id, name: p.name || p.id, models: dynModels });
      }
      // 回退到静态列表
      else if (API_MODELS_FALLBACK[p.id]) {
        result.push({ id: p.id, name: p.name || p.id, models: API_MODELS_FALLBACK[p.id] });
      }
    }

    return result;
  } catch {
    return [{ id: "mimo", name: "MiMo", models: MIMO_MODELS.map(m => ({ id: m.id, name: m.name })) }];
  }
}

/** 静态回退模型列表 */
const API_MODELS_FALLBACK: Record<string, Array<{ id: string; name: string }>> = {
  openai: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "gpt-4o-mini", name: "GPT-4o Mini" }, { id: "o3", name: "o3" }],
  anthropic: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" }, { id: "claude-opus-4-20250514", name: "Claude Opus 4" }],
  deepseek: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
  moonshot: [{ id: "moonshot-v1-8k", name: "Moonshot 8K" }, { id: "moonshot-v1-32k", name: "Moonshot 32K" }],
  gemini: [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }, { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
};

const EDITABLE_SLOTS: TaskSlot[] = ["chat", "subagent", "memory", "compaction", "vision"];

// ========== Component ==========

interface ModelProfilePanelProps {
  onClose: () => void;
}

export function ModelProfilePanel({ onClose }: ModelProfilePanelProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const manager = getModelProfileManager();

  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState(manager.getActiveProfileId());
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const refresh = useCallback(() => {
    setProfiles(manager.getAll());
    setActiveProfileId(manager.getActiveProfileId());
  }, [manager]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSetActive = (id: string) => {
    manager.setActiveProfile(id);
    refresh();
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const handleDuplicate = (profile: ModelProfile) => {
    const newProfile = manager.createProfile({
      name: `${profile.name} (副本)`,
      description: profile.description,
      enabled: true,
      slots: { ...profile.slots },
    });
    manager.setActiveProfile(newProfile.id);
    setEditingProfileId(newProfile.id);
    refresh();
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const handleDelete = (id: string) => {
    if (manager.deleteProfile(id)) {
      refresh();
    }
  };

  const handleUpdateSlot = (slot: TaskSlot, config: ModelSlotConfig | null) => {
    if (editingProfileId) {
      manager.updateSlot(slot, config);
      refresh();
    }
  };

  const handleRenameProfile = (id: string, name: string, description: string) => {
    manager.updateProfile(id, { name, description });
    refresh();
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const handleCreateProfile = (name: string, description: string) => {
    const profile = manager.createProfile({
      name,
      description,
      enabled: true,
      slots: {},
    });
    manager.setActiveProfile(profile.id);
    setEditingProfileId(profile.id);
    setShowCreateForm(false);
    refresh();
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const slotLabels = zh ? SLOT_LABELS_ZH : SLOT_LABELS_EN;

  return createPortal(
    <div className="settings-overlay" onClick={onClose} style={{ zIndex: 2000 }}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, display: "flex", flexDirection: "column", zIndex: 2001 }}>
        <div className="settings-header">
          <h3>{zh ? "模型配置方案" : "Model Profiles"}</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: "20px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Active profile selector */}
          <div className="setting-group">
            <label style={{ fontWeight: 600, marginBottom: 8, display: "block" }}>
              {zh ? "当前方案" : "Active Profile"}
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleSetActive(p.id)}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: `2px solid ${activeProfileId === p.id ? "var(--accent)" : "var(--border-primary)"}`,
                    background: activeProfileId === p.id ? "var(--accent)" : "var(--bg-secondary)",
                    color: activeProfileId === p.id ? "var(--text-on-accent)" : "var(--text-primary)",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    textAlign: "left",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{p.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-divider" />

          {/* Profile management */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div className="settings-section-title" style={{ margin: 0 }}>
              {zh ? "方案管理" : "Profile Management"}
            </div>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid var(--border-primary)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {showCreateForm ? (zh ? "取消" : "Cancel") : `+ ${zh ? "新建方案" : "New Profile"}`}
            </button>
          </div>

          {/* Create form */}
          {showCreateForm && (
            <CreateProfileForm onCreate={handleCreateProfile} zh={zh} />
          )}

          {/* Profile list with slot editing */}
          {profiles.map((profile) => (
            <div
              key={profile.id}
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 8,
                border: `1px solid ${editingProfileId === profile.id ? "var(--accent)" : "var(--border-primary)"}`,
                background: "var(--bg-secondary)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {profile.name}
                    {profile.isBuiltIn && (
                      <span style={{ fontSize: 10, marginLeft: 6, padding: "2px 6px", borderRadius: 4, background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                        {zh ? "内置" : "Built-in"}
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {!profile.isBuiltIn && (
                    <>
                      <button
                        onClick={() => setEditingProfileId(editingProfileId === profile.id ? null : profile.id)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 4,
                          border: "1px solid var(--border-primary)",
                          background: "var(--bg-tertiary)",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                      >
                        {editingProfileId === profile.id ? (zh ? "收起" : "Collapse") : (zh ? "编辑槽位" : "Edit Slots")}
                      </button>
                      <button
                        onClick={() => handleDelete(profile.id)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 4,
                          border: "1px solid var(--error)",
                          background: "transparent",
                          color: "var(--error)",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                      >
                        {zh ? "删除" : "Delete"}
                      </button>
                    </>
                  )}
                  {profile.isBuiltIn && (
                    <button
                      onClick={() => handleDuplicate(profile)}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 4,
                        border: "1px solid var(--accent)",
                        background: "transparent",
                        color: "var(--accent)",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      {zh ? "复制并编辑" : "Duplicate & Edit"}
                    </button>
                  )}
                </div>
              </div>

              {/* Slot configuration table */}
              {editingProfileId === profile.id && !profile.isBuiltIn && (
                <>
                {/* Editable name & description */}
                <ProfileNameEditor
                  profile={profile}
                  zh={zh}
                  onRename={(name, desc) => handleRenameProfile(profile.id, name, desc)}
                />
                <SlotConfigTable
                  profile={profile}
                  zh={zh}
                  slotLabels={slotLabels}
                  onUpdateSlot={handleUpdateSlot}
                />
                </>
              )}

              {/* Slot summary (read-only) */}
              {(editingProfileId !== profile.id || profile.isBuiltIn) && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                  {EDITABLE_SLOTS.filter(s => profile.slots[s]).length > 0 ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {EDITABLE_SLOTS.filter(s => profile.slots[s]).map(slot => (
                        <span
                          key={slot}
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: "var(--bg-tertiary)",
                            fontSize: 11,
                          }}
                        >
                          {slotLabels[slot]}: {profile.slots[slot]!.provider}/{profile.slots[slot]!.model}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontStyle: "italic" }}>
                      {zh ? "未配置槽位，所有任务使用引擎默认模型" : "No slots configured, all tasks use engine default"}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 20px", borderTop: "1px solid var(--border-primary)" }}>
          <button className="save-btn" onClick={onClose}>
            {zh ? "完成" : "Done"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ========== Sub-components ==========

function CreateProfileForm({
  onCreate,
  zh,
}: {
  onCreate: (name: string, description: string) => void;
  zh: boolean;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  return (
    <div
      style={{
        marginBottom: 16,
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--accent)",
        background: "var(--bg-secondary)",
      }}
    >
      <div className="setting-group">
        <label>{zh ? "方案名称" : "Profile Name"}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={zh ? "例如：自定义经济模式" : "e.g., Custom Economy"}
          style={{ width: "100%" }}
        />
      </div>
      <div className="setting-group">
        <label>{zh ? "描述" : "Description"}</label>
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={zh ? "方案用途说明" : "What this profile is for"}
          style={{ width: "100%" }}
        />
      </div>
      <button
        onClick={() => name.trim() && onCreate(name.trim(), desc.trim())}
        disabled={!name.trim()}
        style={{
          padding: "8px 20px",
          borderRadius: 6,
          border: "none",
          background: name.trim() ? "var(--accent)" : "var(--bg-tertiary)",
          color: "var(--text-on-accent)",
          cursor: name.trim() ? "pointer" : "not-allowed",
          fontSize: 13,
          width: "100%",
        }}
      >
        {zh ? "创建并编辑槽位" : "Create & Edit Slots"}
      </button>
    </div>
  );
}

function ProfileNameEditor({
  profile,
  zh,
  onRename,
}: {
  profile: ModelProfile;
  zh: boolean;
  onRename: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(profile.name);
  const [desc, setDesc] = useState(profile.description);

  return (
    <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 48 }}>
          {zh ? "名称" : "Name"}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name, desc)}
          style={{ flex: 1, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13 }}
        />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 48 }}>
          {zh ? "描述" : "Desc"}
        </label>
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => onRename(name, desc)}
          style={{ flex: 1, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 13 }}
        />
      </div>
    </div>
  );
}

function SlotConfigTable({
  profile,
  zh,
  slotLabels,
  onUpdateSlot,
}: {
  profile: ModelProfile;
  zh: boolean;
  slotLabels: Record<TaskSlot, string>;
  onUpdateSlot: (slot: TaskSlot, config: ModelSlotConfig | null) => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
            <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--text-secondary)" }}>
              {zh ? "任务槽位" : "Slot"}
            </th>
            <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--text-secondary)" }}>
              {zh ? "提供商" : "Provider"}
            </th>
            <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--text-secondary)" }}>
              {zh ? "模型" : "Model"}
            </th>
            <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--text-secondary)" }}>
              {zh ? "推理强度" : "Reasoning"}
            </th>
            <th style={{ padding: "6px 8px" }} />
          </tr>
        </thead>
        <tbody>
          {EDITABLE_SLOTS.map((slot) => {
            const config = profile.slots[slot];
            return (
              <SlotConfigRow
                key={slot}
                slot={slot}
                label={slotLabels[slot]}
                config={config}
                zh={zh}
                onUpdate={(newConfig) => onUpdateSlot(slot, newConfig)}
              />
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
        {zh
          ? "💡 未配置的槽位会自动回退：memory→subagent→chat, compaction→subagent→chat"
          : "💡 Unconfigured slots fall back: memory→subagent→chat, compaction→subagent→chat"}
      </div>
    </div>
  );
}

function SlotConfigRow({
  slot,
  label,
  config,
  zh,
  onUpdate,
}: {
  slot: TaskSlot;
  label: string;
  config: ModelSlotConfig | undefined;
  zh: boolean;
  onUpdate: (config: ModelSlotConfig | null) => void;
}) {
  const [enabled, setEnabled] = useState(!!config);
  const [provider, setProvider] = useState(config?.provider || "mimo");
  const [model, setModel] = useState(config?.model || "mimo-v2.5-pro");
  const [reasoning, setReasoning] = useState(config?.reasoningEffort || "medium");

  // 从存储读取动态 provider 和模型列表
  const availableProviders = getAvailableProviders();
  const providerModels = availableProviders.find((p) => p.id === provider)?.models || [];

  const handleToggle = () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    if (newEnabled) {
      onUpdate({ provider, model, reasoningEffort: reasoning as "low" | "medium" | "high" });
    } else {
      onUpdate(null);
    }
  };

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    const newModels = availableProviders.find((p) => p.id === newProvider)?.models || [];
    const newModel = newModels[0]?.id || "";
    setModel(newModel);
    if (enabled) {
      onUpdate({ provider: newProvider, model: newModel, reasoningEffort: reasoning as "low" | "medium" | "high" });
    }
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    if (enabled) {
      onUpdate({ provider, model: newModel, reasoningEffort: reasoning as "low" | "medium" | "high" });
    }
  };

  const handleReasoningChange = (newReasoning: "low" | "medium" | "high") => {
    setReasoning(newReasoning);
    if (enabled) {
      onUpdate({ provider, model, reasoningEffort: newReasoning as "low" | "medium" | "high" });
    }
  };

  return (
    <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
      <td style={{ padding: "8px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={handleToggle} />
          <span style={{ fontWeight: 500 }}>{label}</span>
        </label>
      </td>
      <td style={{ padding: "8px" }}>
        {enabled ? (
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            style={{ width: "100%", fontSize: 12 }}
          >
            {availableProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>
      <td style={{ padding: "8px" }}>
        {enabled ? (
          <select
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            style={{ width: "100%", fontSize: 12 }}
          >
            {providerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>
      <td style={{ padding: "8px" }}>
        {enabled ? (
          <select
            value={reasoning}
            onChange={(e) => handleReasoningChange(e.target.value as "low" | "medium" | "high")}
            style={{ width: "100%", fontSize: 12 }}
          >
            <option value="low">{zh ? "低" : "Low"}</option>
            <option value="medium">{zh ? "中" : "Medium"}</option>
            <option value="high">{zh ? "高" : "High"}</option>
          </select>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>
      <td style={{ padding: "8px" }}>
        {!enabled && (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
            {zh ? "回退到上级" : "Fallback"}
          </span>
        )}
      </td>
    </tr>
  );
}
