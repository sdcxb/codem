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

// ========== Types ==========

/** Task slots that can be configured with different models */
export type TaskSlot =
  | "chat"        // Main agentic loop
  | "subagent"    // Sub-agent tasks (exploration, search, etc.)
  | "memory"      // Memory extraction (simple summaries)
  | "compaction"  // Context compaction summaries
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
    description: "所有任务使用同一个模型，与当前行为一致",
    enabled: true,
    isBuiltIn: true,
    slots: {}, // No slots configured → all fall back to engine default
  },
  {
    id: "economy",
    name: "经济模式",
    description: "主对话用标准模型，子任务用 mini/flash 降本",
    enabled: false,
    isBuiltIn: true,
    slots: {
      subagent:   { provider: "openai",   model: "gpt-4o-mini",   reasoningEffort: "low" },
      memory:     { provider: "openai",   model: "gpt-4o-mini",   reasoningEffort: "low" },
      compaction: { provider: "mimo",     model: "mimo-v2-flash", reasoningEffort: "low" },
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
      setSettingJSON(STORAGE_KEY, {
        profiles: this.profiles,
        activeProfileId: this.activeProfileId,
      });
    } catch {}
  }

  // ========== Queries ==========

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
      return profile.slots[slot]!;
    }

    // 2. Walk fallback chain
    let current: TaskSlot | null = SLOT_FALLBACK[slot];
    while (current) {
      if (profile.slots[current]) {
        return profile.slots[current]!;
      }
      current = SLOT_FALLBACK[current];
    }

    // 3. No configuration found — caller uses engine default
    return null;
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

  /** Update a single slot configuration in the active profile */
  updateSlot(slot: TaskSlot, config: ModelSlotConfig | null): boolean {
    const idx = this.profiles.findIndex(p => p.id === this.activeProfileId);
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
