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
import { reportActionFailure } from "../core/storage/persist-failure";
import { getMergedDynamicModels } from "../core/llm/model-catalog";
import { MIMO_MODELS } from "../core/model-config";
import { ActionIcons } from "../core/icons/icon-map";

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
 * Provider 列表来自 codem-settings.providers，模型列表来自 `getMergedDynamicModels()`
 * （服务器缓存 + 手动添加 + **内置目录** 三路合并）。
 *
 * 为什么必须走统一的合并入口（第 81 波修）：这里原来只读 `codem-dynamic-models` 缓存，
 * 于是**内置目录里的模型在这个面板里根本选不到** —— 例如视觉槽位正指向的
 * `deepseek-v4-flash-vision-exp`：服务器 /models 从不列它，缓存里有没有它取决于上次
 * 刷新时的版本，于是同一台机器上"主设置里能看到、方案面板里看不到"。
 * `model-catalog.ts` 的注释写的就是"界面与引擎统一走这里"，这里之前漏了一处。
 */
interface ProviderWithModels {
  id: string;
  name: string;
  models: Array<{ id: string; name: string; catalogOnly?: boolean }>;
}

/** 纯函数部分抽出来，便于用例守住"内置目录条目必须出现在方案面板里" */
export function buildAvailableProviders(
  settings: { providers?: Array<{ id: string; name?: string; apiKey?: string }> },
  dynamicModels: Record<string, Array<{ id: string; name: string; catalogOnly?: boolean }>>,
  fallback: Record<string, Array<{ id: string; name: string }>> = API_MODELS_FALLBACK,
  mimoModels: Array<{ id: string; name: string }> = MIMO_MODELS.map((m) => ({ id: m.id, name: m.name })),
): ProviderWithModels[] {
  const result: ProviderWithModels[] = [{ id: "mimo", name: "MiMo", models: mimoModels }];
  for (const p of settings.providers || []) {
    if (!p.apiKey || p.id === "mimo") continue;
    const dynModels = dynamicModels[p.id];
    if (dynModels && dynModels.length > 0) {
      result.push({ id: p.id, name: p.name || p.id, models: dynModels });
    } else if (fallback[p.id]) {
      result.push({ id: p.id, name: p.name || p.id, models: fallback[p.id] });
    }
  }
  return result;
}

function getAvailableProviders(): ProviderWithModels[] {
  try {
    return buildAvailableProviders(getSettingJSON<any>("codem-settings", {}), getMergedDynamicModels());
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

  /**
   * 编辑某个档案的槽位。
   *
   * ## 第 45 轮（设置审计 D-6）：必须传**正在编辑的那个档案 id**
   *
   * 原来只传 `slot`，`updateSlot` 内部按 `activeProfileId` 定位 —— 而"激活的档案"与
   * "正在编辑的档案"是两个东西：内置 `default` 被激活时编辑自建档案会静默无效（返回 false），
   * 激活的是另一个自建档案时**改动会落到那个档案并落盘**，而界面一直显示正在编辑的那个。
   * 两种形态都是数据错误，后者更隐蔽。
   *
   * 返回值也不再忽略：失败必须让用户看见（否则"点了没反应"）。
   */
  const handleUpdateSlot = (slot: TaskSlot, config: ModelSlotConfig | null) => {
    if (!editingProfileId) return;
    const ok = manager.updateSlot(slot, config, editingProfileId);
    if (!ok) {
      /*
       * 失败必须可见：这条通道（`reportActionFailure`）是仓库统一的失败上报 ——
       * App 侧会把它变成用户可见提示并计入诊断台账。这里**不再**自己造一个 toast 状态，
       * 因为"每个面板各写一套提示"正是提示互相盖掉的原因。
       */
      reportActionFailure(
        "modelProfile.updateSlot",
        new Error(`档案 ${editingProfileId} 的槽位 ${slot} 未更新（档案不存在，或是内置档案）`),
        "模型档案槽位未保存（内置档案请先复制一份再编辑）",
      );
      return;
    }
    refresh();
    window.dispatchEvent(new Event("codem-settings-changed"));
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
    <div className="settings-overlay" onClick={onClose} style={{ zIndex: "var(--z-modal-stacked)" }}>
      <div className="settings-panel mp-panel" onClick={(e) => e.stopPropagation()} style={{ zIndex: "var(--z-modal-stacked)" }}>
        <div className="settings-header">
          <h3>{zh ? "模型配置方案" : "Model Profiles"}</h3>
          <button className="settings-close" onClick={onClose} aria-label="关闭"><ActionIcons.close size={16} /></button>
        </div>

        <div className="mp-body">
          {/* Active profile selector */}
          <div className="setting-group">
            <label className="mp-field-label">
              {zh ? "当前方案" : "Active Profile"}
            </label>
            <div className="mp-profile-row">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleSetActive(p.id)}
                  className={`mp-profile-btn ${activeProfileId === p.id ? "is-active" : ""}`}
                >
                  <div className="mp-profile-name">{p.name}</div>
                  <div className="mp-profile-desc">{p.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-divider" />

          {/* Profile management */}
          <div className="mp-bar">
            <div className="settings-section-title mp-bar-title">
              {zh ? "方案管理" : "Profile Management"}
            </div>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="mp-btn mp-btn--plain"
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
              className={`mp-card ${editingProfileId === profile.id ? "is-accent" : ""}`}
            >
              <div className="mp-card-head">
                <div>
                  <span className="mp-card-name">
                    {profile.name}
                    {profile.isBuiltIn && (
                      <span className="mp-badge">
                        {zh ? "内置" : "Built-in"}
                      </span>
                    )}
                  </span>
                </div>
                <div className="mp-card-actions">
                  {!profile.isBuiltIn && (
                    <>
                      <button
                        onClick={() => setEditingProfileId(editingProfileId === profile.id ? null : profile.id)}
                        className="mp-btn"
                      >
                        {editingProfileId === profile.id ? (zh ? "收起" : "Collapse") : (zh ? "编辑槽位" : "Edit Slots")}
                      </button>
                      <button
                        onClick={() => handleDelete(profile.id)}
                        className="mp-btn mp-btn--danger"
                      >
                        {zh ? "删除" : "Delete"}
                      </button>
                    </>
                  )}
                  {profile.isBuiltIn && (
                    <button
                      onClick={() => handleDuplicate(profile)}
                      className="mp-btn mp-btn--accent"
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
                <div className="mp-slot-summary">
                  {EDITABLE_SLOTS.filter(s => profile.slots[s]).length > 0 ? (
                    <div className="mp-slot-chips">
                      {EDITABLE_SLOTS.filter(s => profile.slots[s]).map(slot => (
                        <span
                          key={slot}
                          className="mp-slot-chip"
                        >
                          {slotLabels[slot]}: {profile.slots[slot]!.provider}/{profile.slots[slot]!.model}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="mp-empty-hint">
                      {zh ? "未配置槽位，所有任务使用引擎默认模型" : "No slots configured, all tasks use engine default"}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mp-footer">
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
    <div className="mp-card is-accent">
      <div className="setting-group">
        <label>{zh ? "方案名称" : "Profile Name"}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={zh ? "例如：自定义经济模式" : "e.g., Custom Economy"}
          className="mp-input--full"
        />
      </div>
      <div className="setting-group">
        <label>{zh ? "描述" : "Description"}</label>
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={zh ? "方案用途说明" : "What this profile is for"}
          className="mp-input--full"
        />
      </div>
      <button
        onClick={() => name.trim() && onCreate(name.trim(), desc.trim())}
        disabled={!name.trim()}
        className="mp-btn--wide"
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
    <div className="mp-form">
      <div className="mp-form-row">
        <label className="mp-form-label">
          {zh ? "名称" : "Name"}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name, desc)}
          className="mp-input"
        />
      </div>
      <div className="mp-form-row">
        <label className="mp-form-label">
          {zh ? "描述" : "Desc"}
        </label>
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => onRename(name, desc)}
          className="mp-input"
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
    <div className="mp-table-wrap">
      <table className="mp-table">
        <thead>
          <tr>
            <th>
              {zh ? "任务槽位" : "Slot"}
            </th>
            <th>
              {zh ? "提供商" : "Provider"}
            </th>
            <th>
              {zh ? "模型" : "Model"}
            </th>
            <th>
              {zh ? "推理强度" : "Reasoning"}
            </th>
            <th />
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
      <div className="mp-table-hint">
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
    <tr>
      <td>
        <label className="mp-check">
          <input type="checkbox" checked={enabled} onChange={handleToggle} />
          <span className="mp-check-label">{label}</span>
        </label>
      </td>
      <td>
        {enabled ? (
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="mp-select"
          >
            {availableProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="mp-none">—</span>
        )}
      </td>
      <td>
        {enabled ? (
          <select
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            className="mp-select"
          >
            {providerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="mp-none">—</span>
        )}
      </td>
      <td>
        {enabled ? (
          <select
            value={reasoning}
            onChange={(e) => handleReasoningChange(e.target.value as "low" | "medium" | "high")}
            className="mp-select"
          >
            <option value="low">{zh ? "低" : "Low"}</option>
            <option value="medium">{zh ? "中" : "Medium"}</option>
            <option value="high">{zh ? "高" : "High"}</option>
          </select>
        ) : (
          <span className="mp-none">—</span>
        )}
      </td>
      <td>
        {!enabled && (
          <span className="mp-fallback">
            {zh ? "回退到上级" : "Fallback"}
          </span>
        )}
      </td>
    </tr>
  );
}
