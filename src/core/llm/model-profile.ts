/**
 * M1: Model Profile System
 *
 * Allows different task types (chat, subagent, memory extraction, compaction)
 * to route to different models/providers. Users can create multiple profiles
 * and switch between them.
 *
 * Fallback chain: tts/imageGen/embedding → chat, memory/compaction → subagent → chat
 */
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { normalizeModelId } from "./model-catalog";
import { reportPersistFailure } from "../storage/persist-failure";

// ========== Types ==========

/** Task slots that can be configured with different models */
export type TaskSlot =
  | "chat"        // Main agentic loop
  | "subagent"    // Sub-agent tasks (exploration, search, etc.)
  | "memory"      // Memory extraction (simple summaries)
  | "compaction"  // Context compaction summaries
  | "vision"      // Vision proxy (image description for non-vision models)
  | "tts"         // Text-to-speech (future)
  | "imageGen"    // Image generation (future)
  | "embedding";  // Embedding/semantic search (future)

/** Configuration for a single slot */
export interface ModelSlotConfig {
  provider: string;        // Provider id: "openai", "mimo", "deepseek", etc.
  model: string;           // Model id: "gpt-4o-mini", "mimo-v2-flash", etc.
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  maxTokens?: number;
}

/** A model configuration profile */
export interface ModelProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isBuiltIn: boolean;
  /** Slot configurations. Unconfigured slots fall back up the chain. */
  slots: Partial<Record<TaskSlot, ModelSlotConfig>>;
}

// ========== Fallback Chain ==========

/** Fallback map: if a slot is not configured, try the parent slot */
const SLOT_FALLBACK: Record<TaskSlot, TaskSlot | null> = {
  tts: "chat",
  imageGen: "chat",
  embedding: "chat",
  vision: "chat",
  memory: "subagent",
  compaction: "subagent",
  subagent: "chat",
  chat: null, // Root — no further fallback
};

// ========== Built-in Profiles ==========

const BUILTIN_PROFILES: ModelProfile[] = [
  {
    id: "default",
    name: "默认（统一模型）",
    description: "所有任务使用同一个模型，视觉理解用 DeepSeek 多模态模型",
    enabled: true,
    isBuiltIn: true,
    slots: {
      vision: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
    },
  },
  {
    id: "standard",
    name: "常规模式",
    description: "主对话用 DeepSeek Pro，子任务用 Flash 降本，含视觉代理",
    enabled: false,
    isBuiltIn: true,
    slots: {
      chat:       { provider: "deepseek", model: "deepseek-v4-pro" },
      subagent:   { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" },
      memory:     { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" },
      compaction: { provider: "deepseek", model: "deepseek-v4-pro" },
      vision:     { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
    },
  },
  {
    id: "economy",
    name: "经济模式",
    description: "全部使用 Flash 模型，最大程度降本",
    enabled: false,
    isBuiltIn: true,
    slots: {
      chat:       { provider: "deepseek", model: "deepseek-v4-flash" },
      subagent:   { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" },
      memory:     { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" },
      compaction: { provider: "deepseek", model: "deepseek-v4-pro" },
      vision:     { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
    },
  },
  {
    id: "performance",
    name: "高性能模式",
    description: "所有任务使用最强模型，不考虑成本",
    enabled: false,
    isBuiltIn: true,
    slots: {
      chat:     { provider: "anthropic", model: "claude-opus-4-20250514",  reasoningEffort: "high" },
      subagent: { provider: "openai",    model: "gpt-4o",                   reasoningEffort: "medium" },
      memory:   { provider: "openai",    model: "gpt-4o",                   reasoningEffort: "medium" },
    },
  },
];

// ========== Profile Manager ==========

const STORAGE_KEY = "codem-model-profiles";

export class ModelProfileManager {
  private profiles: ModelProfile[] = [];
  private activeProfileId: string = "default";

  constructor() {
    this.load();
  }

  // ========== Persistence ==========

  private load() {
    try {
      const stored = getSettingJSON<{
        profiles: ModelProfile[];
        activeProfileId: string;
      } | null>(STORAGE_KEY, null);

      if (stored && stored.profiles) {
        // Merge built-in profiles with stored custom profiles
        // Built-in profiles may have been updated — always use latest built-in definitions
        const customProfiles = stored.profiles.filter(p => !p.isBuiltIn);
        this.profiles = [...BUILTIN_PROFILES, ...customProfiles];
        this.activeProfileId = stored.activeProfileId || "default";
      } else {
        this.profiles = [...BUILTIN_PROFILES];
        this.activeProfileId = "default";
      }
    } catch {
      this.profiles = [...BUILTIN_PROFILES];
      this.activeProfileId = "default";
    }
  }

  private save() {
    try {
      /**
       * 第 18 轮：这里原来跟着一句 `flushDatabase()`（"强制立刻落盘、别等 500ms 防抖"）。
       * 旧引擎的整库导出有防抖，所以需要它；**端口写入是一条命令 = 一次事务**，
       * 没有可 flush 的缓冲 —— 那次调用在新架构下是空操作（而且旧库句柄已不存在）。
       */
      setSettingJSON(STORAGE_KEY, {
        profiles: this.profiles,
        activeProfileId: this.activeProfileId,
      });
    } catch (e) { reportPersistFailure("modelProfile.save", e); }
  }

  // ========== Queries ==========

  /** Reload from database — call after DB init is complete */
  reload(): void {
    this.load();
  }

  /** Get all profiles */
  getAll(): ModelProfile[] {
    return [...this.profiles];
  }

  /** Get the currently active profile */
  getActiveProfile(): ModelProfile {
    const profile = this.profiles.find(p => p.id === this.activeProfileId);
    return profile || this.profiles[0] || BUILTIN_PROFILES[0];
  }

  /** Get the active profile ID */
  getActiveProfileId(): string {
    return this.activeProfileId;
  }

  /**
   * Resolve a task slot to its actual model configuration.
   * Walks the fallback chain until a configured slot is found.
   * Returns null if no slot is configured (caller should use engine default).
   */
  resolveSlot(slot: TaskSlot): ModelSlotConfig | null {
    const profile = this.getActiveProfile();

    // 1. Exact match
    if (profile.slots[slot]) {
      return this.normalizeSlot(profile.slots[slot]!);
    }

    // 2. Walk fallback chain
    let current: TaskSlot | null = SLOT_FALLBACK[slot];
    while (current) {
      if (profile.slots[current]) {
        return this.normalizeSlot(profile.slots[current]!);
      }
      current = SLOT_FALLBACK[current];
    }

    // 3. No configuration found — caller uses engine default
    return null;
  }

  /**
   * 槽位模型 id 归一化（第 74 波）。
   *
   * 历史版本把**显示名**当模型 id 存进了 slot（`DeepSeek-V4-Flash-Vision-Exp`），
   * 而 DeepSeek API 对模型名大小写敏感 —— 实测该写法直接 400：
   *   "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed …"
   * 正确写法是 `deepseek-v4-flash-vision-exp`（HTTP 200）。
   * 已保存的用户方案没法批量改，所以在**读取处**统一纠正。
   */
  private normalizeSlot(slot: ModelSlotConfig): ModelSlotConfig {
    const normalized = normalizeModelId(slot.provider, slot.model);
    return normalized === slot.model ? slot : { ...slot, model: normalized };
  }

  /** Get the fallback chain for a slot (for UI display) */
  getFallbackChain(slot: TaskSlot): TaskSlot[] {
    const chain: TaskSlot[] = [];
    let current: TaskSlot | null = SLOT_FALLBACK[slot];
    while (current) {
      chain.push(current);
      current = SLOT_FALLBACK[current];
    }
    return chain;
  }

  // ========== Mutations ==========

  /** Set the active profile */
  setActiveProfile(id: string): boolean {
    if (!this.profiles.find(p => p.id === id)) return false;
    this.activeProfileId = id;
    this.save();
    return true;
  }

  /** Create a custom profile */
  createProfile(profile: Omit<ModelProfile, "id" | "isBuiltIn">): ModelProfile {
    const id = `profile-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const full: ModelProfile = {
      ...profile,
      id,
      isBuiltIn: false,
    };
    this.profiles.push(full);
    this.save();
    return full;
  }

  /** Update a profile (only non-built-in can be edited) */
  updateProfile(id: string, updates: Partial<Omit<ModelProfile, "id" | "isBuiltIn">>): boolean {
    const idx = this.profiles.findIndex(p => p.id === id);
    if (idx < 0) return false;
    if (this.profiles[idx].isBuiltIn) return false;

    this.profiles[idx] = {
      ...this.profiles[idx],
      ...updates,
      id, // Prevent id change
      isBuiltIn: false, // Prevent promotion to built-in
    };
    this.save();
    return true;
  }

  /** Delete a profile (only non-built-in can be deleted) */
  deleteProfile(id: string): boolean {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile || profile.isBuiltIn) return false;

    this.profiles = this.profiles.filter(p => p.id !== id);
    if (this.activeProfileId === id) {
      this.activeProfileId = "default";
    }
    this.save();
    return true;
  }

  /**
   * Update a single slot configuration.
   *
   * ## ⚠️ 必须带上"改哪个档案"（第 45 轮设置审计 D-6）
   *
   * 原来签名是 `updateSlot(slot, config)`，内部用 `this.activeProfileId` 定位 —— 而**激活的档案**
   * 与**正在编辑的档案**是两个不同的东西：`ModelProfilePanel` 进入编辑态只设 `editingProfileId`，
   * 并不会切换激活档案。于是用户点开自己另一个档案的「编辑槽位」时：
   *
   * - 激活的是内置 `default`（全新安装就是这样）→ `updateSlot` 返回 `false`，编辑**静默消失**
   *   （调用方原来还忽略了返回值）；
   * - 激活的是另一个自建档案 A，而用户在 B 上编辑 → **改动落到 A 并 `save()` 落盘**，
   *   界面却一直显示 B。这比"无效"更难发现：它改了**别的东西**。
   *
   * 所以档案 id 必须是**显式入参**（默认仍取激活档案，保留既有调用点的语义），
   * 由调用方传入它正在编辑的那个档案。
   */
  updateSlot(slot: TaskSlot, config: ModelSlotConfig | null, profileId: string = this.activeProfileId): boolean {
    const idx = this.profiles.findIndex(p => p.id === profileId);
    if (idx < 0) return false;
    if (this.profiles[idx].isBuiltIn) return false;

    const slots = { ...this.profiles[idx].slots };
    if (config === null) {
      delete slots[slot];
    } else {
      slots[slot] = config;
    }
    this.profiles[idx].slots = slots;
    this.save();
    return true;
  }
}

// ========== Singleton ==========

let instance: ModelProfileManager | null = null;

export function getModelProfileManager(): ModelProfileManager {
  if (!instance) {
    instance = new ModelProfileManager();
  }
  return instance;
}
