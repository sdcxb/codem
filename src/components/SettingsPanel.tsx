import { useState, useEffect } from "react";
import type { IdentityConfig, UserConfig, AppIdentity } from "../core/types";
import { saveAppIdentity } from "../core/config/loader";
import { version as APP_VERSION } from "../../package.json";
import { getMiMoAuth } from "../core/auth/mimo";
import type { LoginResult } from "../core/auth/mimo";
import { useAppStore } from "../store";
import { inferContextWindow } from "../core/llm/provider";
import { getSettingJSON, setSettingJSON, getSetting, setSetting, removeSetting } from "../core/storage/settings";
import { setLang, useLang, S, type Language } from "../core/i18n/lang";
import { ModelProfilePanel } from "./ModelProfilePanel";
import { getPermissionManager, type PermissionRule, type PermissionAction } from "../core/permission/permission";
import { SECURITY_MODES, getGlobalSecurityMode, setGlobalSecurityMode, type SecurityMode } from "../core/permission/security-mode";
import { MultimodalPanel } from "./MultimodalPanel";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";
import { OllamaSettingsPanel } from "./OllamaSettingsPanel";
import { getNotebookConfig } from "../core/knowledge";
import { SkinSelector } from "./SkinSelector";
import { GitConfigSection, EnvironmentConfigSection } from "./GitEnvSettings";
import { AgentProfileStorage, type AgentProfile } from "../core/storage/agent-profile-storage";
import { TranscriptCache } from "../core/storage/transcript-cache";
import { getWorktreeSettings, setWorktreeSettings, type WorktreeInfo } from "../core/environment";
import { useProjectStore } from "../core/store";
import { getAutomationConfig, setAutomationConfig, refreshAutomationEngines, stopAutomationEngines, type AutomationTrigger, type TriggerType } from "../core/automation/automation-manager";
import { PetMarketDialog } from "./PetMarketDialog";
import { usePetStore } from "../core/pet/pet-store";
import { uninstallPet } from "../core/pet/pet-manager";
import { ToolManager } from "./ToolManager";
import { AgentManager } from "./AgentManager";
import { HeartbeatMonitor } from "./HeartbeatMonitor";
import { RetryConfigPanel } from "./RetryConfigPanel";
import { PromptDebugger } from "./PromptDebugger";
import { LayeredSettingsPanel } from "./LayeredSettingsPanel";
import { RecoveryPanel } from "./RecoveryPanel";
import { CorrectionModelConfig } from "./CorrectionModelConfig";
// P2 #34: Import reusable settings components
import { SettingsNav, ConfigEntry, ToggleEntry } from "./SettingsParts";
// P2 #35: Import UsageStats for embedding in settings
import { UsageStats } from "./UsageStats";
// P2 #38: framer-motion for animations
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings as SettingsIcon,
  Palette,
  Shield,
  GitBranch as GitBranchIcon,
  Server,
  FolderTree,
  BookOpen as BookOpenIcon,
  Bot,
  Layers,
  Wrench,
  Network,
  PawPrint,
  Zap,
  HelpCircle,
  Key,
  Terminal,
  CheckCircle,
  LogIn,
  Search as SearchIcon,
  X,
  Eye,
  EyeOff,
  HeartPulse,
  RotateCcw,
  FileText,
  User,
  MessageSquare,
  Play,
  Lightbulb,
  AlertTriangle,
  Folder,
  Clock,
  Mic,
  Trash2,
  Plus,
} from "lucide-react";

interface ProviderKey {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  /** Custom OpenAI-compatible provider added by the user (通用协议配置) */
  custom?: boolean;
}

interface Settings {
  mode: "cli" | "api";
  mimoPath: string;
  model: string;
  theme: "dark" | "light";
  fontSize: number;
  autoApprove: boolean;
  language: Language;
  providers: ProviderKey[];
}

const defaultProviders: ProviderKey[] = [
  { id: "mimo", name: "MiMo (小米)", apiKey: "", baseUrl: "https://api.mimo.ai/v1" },
  { id: "openai", name: "OpenAI", apiKey: "", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", apiKey: "", baseUrl: "https://api.anthropic.com/v1" },
  { id: "deepseek", name: "DeepSeek", apiKey: "", baseUrl: "https://api.deepseek.com/v1" },
  { id: "moonshot", name: "Moonshot (Kimi)", apiKey: "", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "gemini", name: "Google Gemini", apiKey: "", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
];

const defaultSettings: Settings = {
  mode: "api",
  mimoPath: "",
  model: "mimo-v2.5-pro",
  theme: "dark",
  fontSize: 14,
  autoApprove: false,
  language: "zh",
  providers: defaultProviders,
};

interface SettingsPanelProps {
  onClose: () => void;
  onSessionRecovery?: () => void;
  onUsageStats?: () => void;
  /** Open a specific tab on mount (e.g. "automation") */
  initialTab?: string;
  /** Replay onboarding tour from Help tab */
  setShowOnboardingReplay?: (v: boolean) => void;
}

const defaultIdentity: IdentityConfig = {
  name: "Codem",
  creature: "AI 助手",
  vibe: "靠谱、直接、有观点",
  emoji: "⚡",
  avatar: "",
  raw: "",
};

const defaultUser: UserConfig = {
  name: "",
  callBy: "",
  pronouns: "",
  timezone: "Asia/Shanghai",
  notes: "",
  context: "",
  raw: "",
  avatar: "",
};

// DiceBear 开源头像 (MIT License, https://dicebear.com)
// 50 个预设头像 — 混合多种风格
const PRESET_AVATARS: string[] = [
  // adventurer 风格 (10)
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Lily",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Alex",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Mia",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Oliver",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Zoe",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Leo",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Ivy",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Max",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Ruby",
  "https://api.dicebear.com/9.x/adventurer/svg?seed=Finn",
  // avataaars 风格 (10)
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Coco",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Riley",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Sage",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Jade",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Orion",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Nova",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Eli",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Maya",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Theo",
  "https://api.dicebear.com/9.x/avataaars/svg?seed=Luna",
  // lorelei 风格 (10)
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Aria",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Kai",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Iris",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Hugo",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Piper",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Quinn",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Vera",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Wren",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Yuki",
  "https://api.dicebear.com/9.x/lorelei/svg?seed=Zane",
  // thumbs 风格 (8)
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Asa",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Brio",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Cleo",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Dori",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Eve",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Glen",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Halo",
  "https://api.dicebear.com/9.x/thumbs/svg?seed=Juno",
  // fun-emoji 风格 (6)
  "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Sunny",
  "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Cloud",
  "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Star",
  "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Sky",
  "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Tay",
  "https://api.dicebear.com/9.x/fun-emoji/svg?seed=Uri",
  // pixel-art 风格 (6)
  "https://api.dicebear.com/9.x/pixel-art/svg?seed=Bit",
  "https://api.dicebear.com/9.x/pixel-art/svg?seed=Dash",
  "https://api.dicebear.com/9.x/pixel-art/svg?seed=Kira",
  "https://api.dicebear.com/9.x/pixel-art/svg?seed=Lio",
  "https://api.dicebear.com/9.x/pixel-art/svg?seed=Nyx",
  "https://api.dicebear.com/9.x/pixel-art/svg?seed=Onyx",
];

export function SettingsPanel({ onClose, onSessionRecovery, onUsageStats, initialTab, setShowOnboardingReplay }: SettingsPanelProps) {
  const lang = useLang();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [identity, setIdentity] = useState<IdentityConfig>(defaultIdentity);
  const [userConfig, setUserConfig] = useState<UserConfig>(defaultUser);
  const [saved, setSaved] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [dynamicModels, setDynamicModels] = useState<Record<string, Array<{ id: string; name: string; contextWindow?: number }>>>({});
  const [refreshingModels, setRefreshingModels] = useState<Record<string, boolean>>({});
  const [refreshStatus, setRefreshStatus] = useState<Record<string, string>>({});
  // Custom OpenAI-compatible provider form (通用协议配置)
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [mimoAccount, setMimoAccount] = useState<{ email: string; uid: string } | null>(null);
  const [loginStatus, setLoginStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [fontFamily, setFontFamily] = useState<string>(getSetting("codem-font-family") || "AlimamaFangYuanTi");
  const [fontWeight, setFontWeight] = useState<string>(getSetting("codem-font-weight") || "400");

  useEffect(() => {
    const stored = getSettingJSON<Settings | null>("codem-settings", null);
    if (stored) {
      const parsed = stored;
      if (!parsed.providers) {
        parsed.providers = defaultProviders;
      } else {
        // 补全缺失的 provider（兼容旧版本设置）
        const existingIds = parsed.providers.map((p: ProviderKey) => p.id);
        for (const dp of defaultProviders) {
          if (!existingIds.includes(dp.id)) {
            parsed.providers.push(dp);
          }
        }
      }
      setSettings({ ...defaultSettings, ...parsed });
    }

    // Load dynamically fetched models from DB cache
    try {
      const stored = getSettingJSON<Record<string, Array<{ id: string; name: string; contextWindow?: number }>>>("codem-dynamic-models", {});
      if (stored && Object.keys(stored).length > 0) {
        setDynamicModels(stored);
      }
    } catch (e) { console.warn('[SettingsPanel] load dynamic models:', e) }

    // Load language setting (also stored separately for fast access)
    const storedLang = getSetting("codem-language");
    if (storedLang === "en" || storedLang === "zh") {
      setSettings(prev => ({ ...prev, language: storedLang }));
    }

    const storedIdentity = getSettingJSON<IdentityConfig | null>("codem-identity", null);
    if (storedIdentity) {
      const parsed = storedIdentity;
      setIdentity({
        name: parsed.name || defaultIdentity.name,
        creature: parsed.creature || defaultIdentity.creature,
        vibe: parsed.vibe || defaultIdentity.vibe,
        emoji: parsed.emoji || defaultIdentity.emoji,
        avatar: parsed.avatar || "",
        raw: parsed.raw || "",
      });
    }

    // Load user config (name, callBy, timezone, etc.)
    const storedUser = getSettingJSON<UserConfig | null>("codem-user", null);
    console.log("[SettingsPanel] Loading codem-user:", JSON.stringify(storedUser));
    if (storedUser) {
      setUserConfig({
        name: storedUser.name || "",
        callBy: storedUser.callBy || "",
        pronouns: storedUser.pronouns || "",
        timezone: storedUser.timezone || "Asia/Shanghai",
        notes: storedUser.notes || "",
        context: storedUser.context || "",
        raw: storedUser.raw || "",
        avatar: storedUser.avatar || "",
      });
    }

    // Check MiMo auth.json
    const auth = getMiMoAuth();
    auth.loadFromAuthJson().then((account) => {
      if (account) {
        setMimoAccount({ email: account.email, uid: account.id });
      }
    }).catch(() => {});
  }, []);

  const handleSave = () => {
    setSettingJSON("codem-settings", settings);
    setLang(settings.language);

    const identityToSave: IdentityConfig = {
      name: identity.name,
      creature: identity.creature,
      vibe: identity.vibe,
      emoji: identity.emoji,
      avatar: identity.avatar || "",
      raw: identity.raw || "",
    };
    setSettingJSON("codem-identity", identityToSave);

    const appIdentity: AppIdentity = {
      name: identity.name || "Codem",
      creature: identity.creature,
      vibe: identity.vibe,
      emoji: identity.emoji,
      avatar: identity.avatar || "",
      onboarded: true,
    };
    saveAppIdentity(appIdentity);

    const userToSave: UserConfig = {
      name: userConfig.name,
      callBy: userConfig.callBy || userConfig.name,
      pronouns: userConfig.pronouns || "",
      timezone: userConfig.timezone,
      notes: userConfig.notes || "",
      context: userConfig.context || "",
      raw: userConfig.raw || "",
      avatar: userConfig.avatar || "",
    };
    setSettingJSON("codem-user", userToSave);

    // Trigger engine reconfigure (mode/provider/apiKey may have changed)
    window.dispatchEvent(new Event("codem-settings-changed"));

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleLogin = async () => {
    setLoginStatus("loading");
    setLoginError(null);
    try {
      const auth = getMiMoAuth();
      // First try loading from existing auth.json
      const existing = await auth.loadFromAuthJson();
      if (existing) {
        setLoginStatus("success");
        setMimoAccount({ email: existing.email, uid: existing.id });
        window.dispatchEvent(new Event("codem-settings-changed"));
        return;
      }
      // If no existing auth, run mimo providers login
      const result: LoginResult = await auth.login();
      if (result.success) {
        setLoginStatus("success");
        setMimoAccount({ email: "MiMo User", uid: "" });
        window.dispatchEvent(new Event("codem-settings-changed"));
      } else {
        setLoginStatus("error");
        setLoginError(result.error || "Login failed");
      }
    } catch (e) {
      setLoginStatus("error");
      setLoginError(String(e));
    }
  };

  const handleLogout = async () => {
    const auth = getMiMoAuth();
    const account = auth.getActiveAccount();
    if (account) {
      await auth.logout(account.id);
      setMimoAccount(null);
      setLoginStatus("idle");
      window.dispatchEvent(new Event("codem-settings-changed"));
    }
  };

  const [testResult, setTestResult] = useState<string>("");
const [showModelProfiles, setShowModelProfiles] = useState(false);
const [showMultimodal, setShowMultimodal] = useState(false);
const [activeTab, setActiveTab] = useState<"general" | "appearance" | "security" | "git" | "environment" | "worktree" | "knowledge" | "automation" | "multimodal" | "voice" | "ollama" | "pet" | "tools" | "codegraph" | "advanced" | "help" | "usage">((initialTab as any) || "general");
  // P2 #36: Settings search
  const [settingsSearch, setSettingsSearch] = useState("");
  const [advancedSubTab, setAdvancedSubTab] = useState<"agents" | "heartbeat" | "retry" | "prompt" | "settings" | "recovery" | "correction" | "profiles" | "transcript">("agents");
  const [showPetMarket, setShowPetMarket] = useState(false);
  const runLoginTest = async () => {
    const lines: string[] = [];
    const log = (msg: string) => { lines.push(msg); console.log(msg); };

    // Test 1: Read auth.json
    log("=== 1. 读取 auth.json ===");
    try {
      const { invoke } = (window as any).__TAURI__.core;
      const auth = await invoke("mimo_read_auth");
      if (auth?.xiaomi?.key) {
        log("✅ key: " + auth.xiaomi.key.substring(0, 10) + "...");
        log("  uid: " + auth.xiaomi.metadata?.uid);
        log("  url: " + auth.xiaomi.metadata?.base_url);
      } else {
        log("❌ auth.json 无 key");
      }
    } catch (e) {
      log("❌ " + e);
      setTestResult(lines.join("\n"));
      return;
    }

    // Test 2: AccountStorage.createAccount upsert
    log("\n=== 2. createAccount upsert ===");
    try {
      const AccountStorage = await import("../core/storage/account");
      const testId = "test-" + Date.now();
      const testAcc = { id: testId, email: "test", url: "https://t", accessToken: "k", isActive: true, createdAt: Date.now(), updatedAt: Date.now() };
      AccountStorage.createAccount(testAcc);
      log("  首次创建: OK");
      AccountStorage.createAccount({ ...testAcc, email: "updated" });
      log("  重复创建(upsert): OK");
      AccountStorage.deleteAccount(testId);
      log("✅ createAccount upsert 正常");
    } catch (e) {
      log("❌ " + e);
    }

    // Test 3: loadFromAuthJson
    log("\n=== 3. loadFromAuthJson ===");
    try {
      const { getMiMoAuth } = await import("../core/auth/mimo");
      const auth = getMiMoAuth();
      const account = await auth.loadFromAuthJson();
      if (account) {
        log("✅ id: " + account.id);
        log("  email: " + account.email);
        log("  token: " + account.accessToken.substring(0, 10) + "...");
      } else {
        log("❌ 返回 null");
      }
    } catch (e) {
      log("❌ " + e);
    }

    // Test 4: getActiveAccount
    log("\n=== 4. getActiveAccount ===");
    try {
      const { getMiMoAuth } = await import("../core/auth/mimo");
      const active = getMiMoAuth().getActiveAccount();
      log(active ? "✅ " + active.email : "❌ null");
    } catch (e) {
      log("❌ " + e);
    }

    // Test 5: API call
    log("\n=== 5. MiMo API 调用 ===");
    try {
      const { getMiMoAuth } = await import("../core/auth/mimo");
      const acc = getMiMoAuth().getActiveAccount();
      if (acc) {
        // Test non-streaming
        log("  测试非 streaming...");
        const r = await fetch(acc.url + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + acc.accessToken },
          body: JSON.stringify({ model: "mimo-v2.5-pro", messages: [{ role: "user", content: "say hi" }], max_tokens: 20 }),
        });
        log("  非streaming HTTP " + r.status);
        if (r.ok) {
          const d = await r.json();
          log("✅ 非streaming 响应: " + JSON.stringify(d).substring(0, 120));
        } else {
          log("❌ " + (await r.text()).substring(0, 100));
        }

        // Test streaming
        log("  测试 streaming...");
        const rs = await fetch(acc.url + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + acc.accessToken },
          body: JSON.stringify({ model: "mimo-v2.5-pro", messages: [{ role: "user", content: "say hi" }], max_tokens: 20, stream: true }),
        });
        log("  streaming HTTP " + rs.status);
        if (rs.ok && rs.body) {
          const reader = rs.body.getReader();
          const decoder = new TextDecoder();
          let chunks = 0;
          let text = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks++;
            text += decoder.decode(value, { stream: true });
          }
          log("✅ streaming OK: " + chunks + " chunks, " + text.length + " bytes");
        } else {
          log("❌ streaming failed: " + rs.status);
        }
      } else {
        log("❌ 无活跃账号");
      }
    } catch (e) {
      log("❌ " + e);
    }

    // Summary
    const passed = lines.filter((l) => l.startsWith("✅")).length;
    const failed = lines.filter((l) => l.startsWith("❌")).length;
    log("\n=== 结果: " + passed + " 通过, " + failed + " 失败 ===");
    setTestResult(lines.join("\n"));
  };

  const updateProvider = (id: string, update: Partial<ProviderKey>) => {
    setSettings({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...update } : p
      ),
    });
  };

  const addCustomProvider = () => {
    const name = customName.trim();
    const baseUrl = customBaseUrl.trim();
    if (!name || !baseUrl) return;
    const id = `custom-${Date.now()}`;
    const newProvider: ProviderKey = {
      id,
      name,
      apiKey: customApiKey.trim(),
      baseUrl,
      custom: true,
    };
    const newSettings = { ...settings, providers: [...settings.providers, newProvider] };
    setSettings(newSettings);
    setSettingJSON("codem-settings", newSettings);
    window.dispatchEvent(new Event("codem-settings-changed"));
    setShowAddCustom(false);
    setCustomName("");
    setCustomBaseUrl("");
    setCustomApiKey("");
  };

  const removeCustomProvider = (id: string) => {
    const newSettings = { ...settings, providers: settings.providers.filter((p) => p.id !== id) };
    setSettings(newSettings);
    setSettingJSON("codem-settings", newSettings);
    window.dispatchEvent(new Event("codem-settings-changed"));
    // Also clear cached dynamic models for this provider
    try {
      const existing = getSettingJSON<Record<string, any>>("codem-dynamic-models", {});
      if (existing[id]) {
        const next = { ...existing };
        delete next[id];
        setSettingJSON("codem-dynamic-models", next);
      }
    } catch (e) { console.warn('[SettingsPanel] remove dynamic models:', e) }
  };

  /** Fetch models from the provider's /models endpoint and cache them */
  const refreshProviderModels = async (providerId: string) => {
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider || !provider.apiKey) {
      setRefreshStatus((prev) => ({ ...prev, [providerId]: "请先配置 API Key" }));
      return;
    }

    setRefreshingModels((prev) => ({ ...prev, [providerId]: true }));
    setRefreshStatus((prev) => ({ ...prev, [providerId]: "" }));

    const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
    };

    // Try /models and /v1/models endpoints
    const endpoints = [`${baseUrl}/models`, `${baseUrl}/v1/models`];
    let success = false;

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) continue;

        const data = await response.json();
        const serverModels = data.data || data.models || [];
        if (!Array.isArray(serverModels) || serverModels.length === 0) continue;

        // Convert to {id, name, contextWindow} format.
        // 保留 contextWindow（用 ID 启发式推断），否则运行时窗口解析会回退
        // 128k，导致 1M 窗口模型（DeepSeek/Gemini/MiMo）过早压缩。
        const models = serverModels.map((sm: any) => ({
          id: sm.id,
          name: sm.id,
          contextWindow: sm.context_window || sm.contextWindow || inferContextWindow(sm.id),
          maxOutputTokens: sm.max_output_tokens || sm.maxOutputTokens || 16384,
          supportsTools: sm.supports_tools ?? sm.supportsTools ?? true,
          supportsStreaming: sm.supports_streaming ?? sm.supportsStreaming ?? true,
        }));

        // Update state
        setDynamicModels((prev) => ({ ...prev, [providerId]: models }));
        setRefreshStatus((prev) => ({ ...prev, [providerId]: `✓ 获取到 ${models.length} 个模型` }));

        // Persist to DB cache (merge with existing)
        try {
          const existing = getSettingJSON<Record<string, any>>("codem-dynamic-models", {});
          setSettingJSON("codem-dynamic-models", { ...existing, [providerId]: models });
        } catch (e) { console.warn('[SettingsPanel] persist models:', e) }

        // Notify engine to reload
        window.dispatchEvent(new Event("codem-settings-changed"));
        success = true;
        break;
      } catch (e: any) {
        console.warn(`[SettingsPanel] refresh ${providerId} ${url}:`, e.message);
        continue;
      }
    }

    if (!success) {
      setRefreshStatus((prev) => ({ ...prev, [providerId]: "✗ 获取失败，使用内置列表" }));
    }

    setRefreshingModels((prev) => ({ ...prev, [providerId]: false }));
  };

  const toggleShowKey = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{S.settings.title[lang]}</h3>
          <button className="settings-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="settings-body">
          <div className="settings-sidebar">
            {/* P2 #36: Settings search */}
            <div className="settings-search-box" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg-tertiary)", borderRadius: 6, padding: "4px 8px" }}>
                <SearchIcon size={14} style={{ color: "var(--text-muted)" }} />
                <input
                  type="text"
                  placeholder={lang === "zh" ? "搜索设置..." : "Search settings..."}
                  value={settingsSearch}
                  onChange={(e) => setSettingsSearch(e.target.value)}
                  style={{ flex: 1, background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 'var(--fs-sm)', outline: "none" }}
                />
                {settingsSearch && <button onClick={() => setSettingsSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}><X size={12} /></button>}
              </div>
            </div>
            <button className={`settings-sidebar-item ${activeTab === "general" ? "active" : ""}`} onClick={() => setActiveTab("general")}>
              <span className="sidebar-icon"><SettingsIcon size={16} /></span>{lang === "zh" ? "通用" : "General"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "appearance" ? "active" : ""}`} onClick={() => setActiveTab("appearance")}>
              <span className="sidebar-icon"><Palette size={16} /></span>{lang === "zh" ? "外观" : "Appearance"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "security" ? "active" : ""}`} onClick={() => setActiveTab("security")}>
              <span className="sidebar-icon"><Shield size={16} /></span>{lang === "zh" ? "安全" : "Security"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "git" ? "active" : ""}`} onClick={() => setActiveTab("git")}>
              <span className="sidebar-icon"><GitBranchIcon size={16} /></span>{lang === "zh" ? "Git" : "Git"}
            </button>
<button className={`settings-sidebar-item ${activeTab === "environment" ? "active" : ""}`} onClick={() => setActiveTab("environment")}>
<span className="sidebar-icon"><Server size={16} /></span>{lang === "zh" ? "环境" : "Environment"}
</button>
<button className={`settings-sidebar-item ${activeTab === "worktree" ? "active" : ""}`} onClick={() => setActiveTab("worktree")}>
<span className="sidebar-icon"><FolderTree size={16} /></span>{lang === "zh" ? "工作树" : "Worktree"}
</button>
<button className={`settings-sidebar-item ${activeTab === "knowledge" ? "active" : ""}`} onClick={() => setActiveTab("knowledge")}>
<span className="sidebar-icon"><BookOpenIcon size={16} /></span>{lang === "zh" ? "知识" : "Knowledge"}
</button>
<button className={`settings-sidebar-item ${activeTab === "automation" ? "active" : ""}`} onClick={() => setActiveTab("automation")}>
<span className="sidebar-icon"><Bot size={16} /></span>{lang === "zh" ? "自动化" : "Automation"}
</button>
<button className={`settings-sidebar-item ${activeTab === "multimodal" ? "active" : ""}`} onClick={() => setActiveTab("multimodal")}>
<span className="sidebar-icon"><Layers size={16} /></span>{lang === "zh" ? "多模态" : "Multimodal"}
</button>
<button className={`settings-sidebar-item ${activeTab === "voice" ? "active" : ""}`} onClick={() => setActiveTab("voice")}>
<span className="sidebar-icon"><Mic size={16} /></span>{lang === "zh" ? "语音" : "Voice"}
</button>
<button className={`settings-sidebar-item ${activeTab === "ollama" ? "active" : ""}`} onClick={() => setActiveTab("ollama")}>
<span className="sidebar-icon"><Server size={16} /></span>{lang === "zh" ? "Ollama" : "Ollama"}
</button>
            <button className={`settings-sidebar-item ${activeTab === "tools" ? "active" : ""}`} onClick={() => setActiveTab("tools")}>
              <span className="sidebar-icon"><Wrench size={16} /></span>{lang === "zh" ? "工具" : "Tools"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "codegraph" ? "active" : ""}`} onClick={() => setActiveTab("codegraph")}>
              <span className="sidebar-icon"><Network size={16} /></span>{lang === "zh" ? "代码图谱" : "CodeGraph"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "pet" ? "active" : ""}`} onClick={() => setActiveTab("pet")}>
              <span className="sidebar-icon"><PawPrint size={16} /></span>{lang === "zh" ? "宠物" : "Pet"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "advanced" ? "active" : ""}`} onClick={() => setActiveTab("advanced")}>
              <span className="sidebar-icon"><Zap size={16} /></span>{lang === "zh" ? "高级" : "Advanced"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "help" ? "active" : ""}`} onClick={() => setActiveTab("help")}>
              <span className="sidebar-icon"><HelpCircle size={16} /></span>{lang === "zh" ? "帮助" : "Help"}
            </button>
            {/* P2 #35: Usage stats tab */}
            <button className={`settings-sidebar-item ${activeTab === "usage" ? "active" : ""}`} onClick={() => setActiveTab("usage")}>
              <span className="sidebar-icon"><Zap size={16} /></span>{lang === "zh" ? "用量统计" : "Usage"}
            </button>
          </div>

          <div className="settings-content">
          {activeTab === "general" && (
          <>
          <div className="settings-mode-switch">
            <label className="mode-label">{S.settings.runMode[lang]}</label>
            <div className="mode-options">
              <button
                className={`mode-btn ${settings.mode === "api" ? "active" : ""}`}
                onClick={() => {
                  const newSettings = { ...settings, mode: "api" as const };
                  setSettings(newSettings);
                  setSettingJSON("codem-settings", newSettings);
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
              >
                <span className="mode-icon"><Key size={20} /></span>
                <span className="mode-title">{S.settings.apiMode[lang]}</span>
                <span className="mode-desc">{S.settings.apiModeDesc[lang]}</span>
              </button>
              <button
                className={`mode-btn ${settings.mode === "cli" ? "active" : ""}`}
                onClick={() => {
                  const newSettings = { ...settings, mode: "cli" as const };
                  setSettings(newSettings);
                  setSettingJSON("codem-settings", newSettings);
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
              >
                <span className="mode-icon"><Terminal size={20} /></span>
                <span className="mode-title">{S.settings.cliMode[lang]}</span>
                <span className="mode-desc">{S.settings.cliModeDesc[lang]}</span>
              </button>
            </div>
          </div>

          {settings.mode === "cli" && (
            <div className="setting-group">
              <label>MiMo 账号</label>
              <div style={{ fontSize: 'var(--fs-base)', color: "var(--text-secondary)", marginBottom: 8 }}>
                登录小米账号，mimo-v2.5-pro 模型免费
              </div>

              {mimoAccount ? (
                <div style={{
                  padding: "8px 12px",
                  background: "var(--bg-secondary)",
                  borderRadius: 6,
                  border: "1px solid var(--border-primary)",
                  fontSize: 'var(--fs-base)',
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}><CheckCircle size={14} style={{ color: "var(--success)" }} /> 已登录</span>
                  <button
                    onClick={handleLogout}
                    style={{
                      padding: "4px 8px",
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: 4,
                      fontSize: 'var(--fs-sm)',
                      cursor: "pointer",
                    }}
                  >
                    登出
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleLogin}
                  disabled={loginStatus === "loading"}
                  style={{
                    padding: "8px 16px",
                    background: loginStatus === "loading" ? "var(--bg-tertiary)" : "var(--accent)",
                    color: "var(--text-on-accent)",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 'var(--fs-base)',
                    cursor: loginStatus === "loading" ? "wait" : "pointer",
                    width: "100%",
                  }}
                >
                  {loginStatus === "loading" ? "正在打开浏览器..." : <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}><LogIn size={16} /> 登录小米账号</span>}
                </button>
              )}

              {loginStatus === "error" && (
                <div style={{ fontSize: 'var(--fs-sm)', color: "var(--error)", marginTop: 6 }}>
                  {loginError}
                </div>
              )}

              <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 6 }}>
                点击后会打开浏览器，在浏览器中完成授权即可。
              </div>

              <button
                onClick={runLoginTest}
                style={{
                  marginTop: 12,
                  padding: "6px 12px",
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: 4,
                  fontSize: 'var(--fs-sm)',
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}><SearchIcon size={14} /> 运行登录测试</span>
              </button>

              {testResult && (
                <pre style={{
                  marginTop: 8,
                  padding: 8,
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: 4,
                  fontSize: 'var(--fs-sm)',
                  whiteSpace: "pre-wrap",
                  maxHeight: 300,
                  overflow: "auto",
                }}>
                  {testResult}
                </pre>
              )}
            </div>
          )}

          <div className="setting-group">
            <label>{S.settings.model[lang]}</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                style={{ flex: 1 }}
              >
              {settings.mode === "cli" ? (
                <>
                  <option value="mimo-v2.5-pro">MiMo v2.5 Pro (免费)</option>
                  <option value="mimo-v2.5">MiMo v2.5</option>
                  <option value="mimo-v2-pro">MiMo v2 Pro</option>
                  <option value="mimo-v2-flash">MiMo v2 Flash</option>
                </>
              ) : (
                <>
                  {settings.providers.filter(p => p.apiKey).map(p => {
                    // Use dynamic models if available, otherwise fall back to static list
                    const dynModels = dynamicModels[p.id];
                    if (dynModels && dynModels.length > 0) {
                      return dynModels.map(m => (
                        <option key={m.id} value={m.id}>{p.name} - {m.name}</option>
                      ));
                    }
                    // Static fallback
                    const staticModels: Record<string, Array<{id: string, name: string}>> = {
                      openai: [{id:"gpt-4o",name:"GPT-4o"},{id:"gpt-4o-mini",name:"GPT-4o Mini"},{id:"o3",name:"o3"}],
                      anthropic: [{id:"claude-sonnet-4-20250514",name:"Claude Sonnet 4"},{id:"claude-opus-4-20250514",name:"Claude Opus 4"}],
                      deepseek: [
                        {id:"deepseek-v4-flash",name:"DeepSeek V4 Flash"},
                        {id:"deepseek-v4-pro",name:"DeepSeek V4 Pro"},
                      ],
                      moonshot: [{id:"moonshot-v1-8k",name:"Moonshot 8K"},{id:"moonshot-v1-32k",name:"Moonshot 32K"},{id:"moonshot-v1-128k",name:"Moonshot 128K"}],
                      gemini: [{id:"gemini-2.5-flash",name:"Gemini 2.5 Flash"},{id:"gemini-2.5-pro",name:"Gemini 2.5 Pro"},{id:"gemini-2.0-flash",name:"Gemini 2.0 Flash"}],
                    };
                    return (staticModels[p.id] || []).map(m => (
                      <option key={m.id} value={m.id}>{p.name} - {m.name}</option>
                    ));
                  })}
                  {!settings.providers.some(p => p.apiKey && p.id !== "mimo") && (
                    <option value="" disabled>请先配置 API Key</option>
                  )}
                </>
              )}
            </select>
              <button
                onClick={() => setShowModelProfiles(true)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 4,
                  border: "1px solid var(--border-primary)",
                  background: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: 'var(--fs-sm)',
                  whiteSpace: "nowrap",
                }}
              >
                {lang === "zh" ? <span style={{ display: "flex", alignItems: "center", gap: 4 }}><SettingsIcon size={14} /> 配置方案</span> : <span style={{ display: "flex", alignItems: "center", gap: 4 }}><SettingsIcon size={14} /> Profiles</span>}
              </button>
            </div>
          </div>

          {showModelProfiles && (
            <ModelProfilePanel onClose={() => setShowModelProfiles(false)} />
          )}

</>
          )}
          {activeTab === "appearance" && (
          <>
          <SkinSelector />

          <div className="setting-group">
            <label>语言 / Language</label>
            <select
              value={settings.language}
              onChange={(e) => {
                const lang = e.target.value as Language;
                setLang(lang);
                const newSettings = { ...settings, language: lang };
                setSettings(newSettings);
                setSettingJSON("codem-settings", newSettings);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="setting-group">
            <label>{S.settings.fontSize[lang]}</label>
            <input
              type="range"
              min="10"
              max="20"
              value={settings.fontSize}
              onChange={(e) => setSettings({ ...settings, fontSize: parseInt(e.target.value) })}
            />
            <span>{settings.fontSize}px</span>
          </div>

          <div className="setting-group">
            <label>{lang === "zh" ? "字体粗细 (wght)" : "Font Weight (wght)"}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range"
                min={100}
                max={900}
                step={50}
                value={fontWeight}
                onChange={(e) => {
                  const w = e.target.value;
                  setFontWeight(w);
                  setSetting("codem-font-weight", w);
                  document.documentElement.style.setProperty("--font-weight", w);
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", minWidth: 36, textAlign: "right", fontFamily: "var(--font-family)", fontWeight: Number(fontWeight) }}>
                {fontWeight}
              </span>
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 2 }}>
              {lang === "zh" ? "100=极细 · 400=常规 · 700=粗体 · 900=极粗" : "100=Thin · 400=Regular · 700=Bold · 900=Black"}
            </div>
          </div>

          {/* Display mode toggle — moved from header per benchmark plan */}
          <div className="setting-group">
            <label>{lang === "zh" ? "对话显示模式" : "Message Display Mode"}</label>
            <select
              value={useAppStore.getState().displayMode}
              onChange={(e) => {
                useAppStore.getState().setDisplayMode(e.target.value as "unified" | "segmented");
                setSettingJSON("codem-display-mode", e.target.value);
              }}
              style={{ padding: "6px 8px", fontSize: 'var(--fs-base)', background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: 4 }}
            >
              <option value="unified">{lang === "zh" ? "统一模式（多轮回复合并为一个气泡）" : "Unified (merge multi-turn replies)"}</option>
              <option value="segmented">{lang === "zh" ? "分段模式（每轮回复独立显示）" : "Segmented (each reply separate)"}</option>
            </select>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 2 }}>
              {lang === "zh" ? "统一模式：AI 的多轮回复合并为一个连续气泡，阅读更连贯" : "Unified: merges AI multi-turn replies into one continuous bubble"}
            </div>
          </div>

</>
          )}
          {activeTab === "security" && (
          <>
          {/* Security Mode — three-tier approval policy */}
          <div className="setting-group">
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>{lang === "zh" ? <><Shield size={16} /> 安全策略</> : <><Shield size={16} /> Security Policy</>}</label>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginBottom: 8 }}>
              {lang === "zh"
                ? "控制 AI 执行操作时的审批级别。项目级设置可覆盖全局策略。"
                : "Control the approval level for AI operations. Per-project settings can override this."}
            </div>
            <SecurityModeSelector
              currentMode={getGlobalSecurityMode()}
              onModeChange={(mode) => {
                setGlobalSecurityMode(mode);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
              lang={lang}
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.closeBehavior[lang]}</label>
            <select
              value={getSetting("codem-close-behavior") || "ask"}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "ask") {
                  removeSetting("codem-close-behavior");
                } else {
                  setSetting("codem-close-behavior", val);
                }
              }}
            >
              <option value="ask">{S.settings.closeAsk[lang]}</option>
              <option value="tray">{S.settings.closeTray[lang]}</option>
              <option value="close">{S.settings.closeQuit[lang]}</option>
            </select>
          </div>

          <div className="setting-group">
            <label>{lang === "zh" ? "全局字体" : "Font Family"}</label>
            <select
              value={fontFamily}
              onChange={(e) => {
                setFontFamily(e.target.value);
                setSetting("codem-font-family", e.target.value);
                document.documentElement.style.setProperty("--font-family", e.target.value);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
              style={{ fontSize: 'var(--fs-base)', fontFamily: "inherit" }}
            >
              <option value="AlimamaFangYuanTi">Alimama 方圆体 (默认)</option>
              <option value="Inter, sans-serif">Inter</option>
              <option value="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">System Default</option>
              <option value="'Courier New', monospace">Courier New</option>
              <option value="Georgia, serif">Georgia</option>
            </select>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 2 }}>
              {lang === "zh" ? "选择应用全局使用的字体（外观选项卡可调粗细）" : "Select the global font (adjust weight in Appearance tab)"}
            </div>
          </div>

</>
          )}
          {activeTab === "general" && (
          <>
          <div className="settings-divider" />

          <div className="settings-section-title">{S.settings.identityConfig[lang]}</div>

          <div className="setting-group">
            <label>{S.settings.callMe[lang]}</label>
            <input
              type="text"
              value={identity.name}
              onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
                placeholder="CODEM、小助手、或者随便什么..."
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.whatAmI[lang]}</label>
            <div className="identity-options">
              {["AI 助手", "数字精灵", "代码伙伴", "赛博管家", "电子幽灵"].map((opt) => (
                <button
                  key={opt}
                  className={`identity-option ${identity.creature === opt ? "selected" : ""}`}
                  onClick={() => setIdentity({ ...identity, creature: opt })}
                >
                  {opt}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={identity.creature}
              onChange={(e) => setIdentity({ ...identity, creature: e.target.value })}
              placeholder="或者自己写..."
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.whatStyle[lang]}</label>
            <div className="identity-options">
              {["靠谱、直接、有观点", "温暖、耐心、鼓励型", "犀利、幽默、毒舌", "冷静、专业、简洁", "随性、自然、像朋友"].map((opt) => (
                <button
                  key={opt}
                  className={`identity-option ${identity.vibe === opt ? "selected" : ""}`}
                  onClick={() => setIdentity({ ...identity, vibe: opt })}
                >
                  {opt}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={identity.vibe}
              onChange={(e) => setIdentity({ ...identity, vibe: e.target.value })}
              placeholder="或者自己描述..."
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.myIcon[lang]}</label>
            <div className="identity-emoji-grid">
              {["⚡", "🤖", "🦊", "🐱", "🔮", "🌙", "🎯", "💎", "🚀", "🧠", "🎭", "🌊"].map((e) => (
                <button
                  key={e}
                  className={`identity-emoji ${identity.emoji === e ? "selected" : ""}`}
                  onClick={() => setIdentity({ ...identity, emoji: e })}
                >
                  {e}
                </button>
              ))}
            </div>
            <input
              type="text"
              className="identity-emoji-input"
              value={identity.emoji}
              onChange={(e) => setIdentity({ ...identity, emoji: e.target.value })}
              placeholder="或输入任意 emoji"
            />
          </div>

          <div className="settings-divider" />

          <div className="settings-section-title">{S.settings.aboutYou[lang]}</div>

          <div className="setting-group">
            <label>{lang === "zh" ? "头像" : "Avatar"}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div className="user-avatar-preview" style={{
                width: 48, height: 48, borderRadius: "50%", overflow: "hidden",
                background: "var(--bg-tertiary)", display: "flex", alignItems: "center",
                justifyContent: "center", flexShrink: 0, border: "2px solid var(--border-primary)",
              }}>
                {userConfig.avatar ? (
                  <img src={userConfig.avatar} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <User size={24} style={{ color: "var(--text-muted)" }} />
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => document.getElementById("avatar-upload-input")?.click()}
                  style={{
                    padding: "6px 12px", borderRadius: 6,
                    border: "1px solid var(--border-primary)",
                    background: "var(--bg-secondary)", color: "var(--text-primary)",
                    cursor: "pointer", fontSize: 'var(--fs-sm)',
                    display: "flex", alignItems: "center", gap: 4,
                  }}
                >
                  {lang === "zh" ? "上传头像" : "Upload"}
                </button>
                {userConfig.avatar && (
                  <button
                    onClick={() => setUserConfig({ ...userConfig, avatar: "" })}
                    style={{
                      padding: "6px 12px", borderRadius: 6,
                      border: "1px solid var(--border-primary)",
                      background: "var(--bg-secondary)", color: "var(--text-primary)",
                      cursor: "pointer", fontSize: 'var(--fs-sm)',
                    }}
                  >
                    {lang === "zh" ? "清除" : "Clear"}
                  </button>
                )}
              </div>
              <input
                id="avatar-upload-input"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    alert(lang === "zh" ? "头像大小不能超过 2MB" : "Avatar must be under 2MB");
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    setUserConfig({ ...userConfig, avatar: reader.result as string });
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </div>
            <div className="preset-avatar-grid" style={{
              display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 8, marginTop: 8,
            }}>
              {PRESET_AVATARS.map((url) => (
                <button
                  key={url}
                  onClick={() => setUserConfig({ ...userConfig, avatar: url })}
                  style={{
                    width: 36, height: 36, borderRadius: "50%", padding: 0,
                    border: userConfig.avatar === url ? "2px solid var(--accent)" : "2px solid transparent",
                    background: "var(--bg-tertiary)", cursor: "pointer", overflow: "hidden",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <img src={url} alt="preset" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </button>
              ))}
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 6 }}>
              {lang === "zh" ? "预设头像来自 DiceBear (MIT)，也可上传自定义图片（≤2MB）" : "Presets from DiceBear (MIT), or upload your own (≤2MB)"}
            </div>
          </div>

          <div className="setting-group">
            <label>{S.settings.yourName[lang]}</label>
            <input
              type="text"
              value={userConfig.name}
              onChange={(e) => setUserConfig({ ...userConfig, name: e.target.value })}
              placeholder="怎么称呼你"
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.callYou[lang]}</label>
            <input
              type="text"
              value={userConfig.callBy}
              onChange={(e) => setUserConfig({ ...userConfig, callBy: e.target.value })}
              placeholder="（可选，默认用名字）"
            />
          </div>

          <div className="setting-group">
            <label>{S.settings.yourTimezone[lang]}</label>
            <input
              type="text"
              value={userConfig.timezone}
              onChange={(e) => setUserConfig({ ...userConfig, timezone: e.target.value })}
              placeholder="Asia/Shanghai"
            />
          </div>

          <div className="settings-divider" />

          <div className="settings-section-title">{S.settings.apiConfig[lang]}</div>

          {settings.providers.map((provider) => (
            <div key={provider.id} className="provider-group">
              <div className="provider-header">
                {provider.custom ? (
                  <input
                    type="text"
                    value={provider.name}
                    onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
                    style={{ flex: 1, background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 'var(--fs-base)', fontWeight: 600, outline: "none", borderBottom: "1px dashed var(--border-primary)", padding: "2px 0", marginRight: 8 }}
                    title={lang === "zh" ? "自定义 Provider 名称（可修改）" : "Custom provider name (editable)"}
                  />
                ) : (
                  <span className="provider-name">{provider.name}</span>
                )}
                {provider.apiKey && <span className="provider-status">✓</span>}
                {provider.custom && (
                  <button
                    onClick={() => removeCustomProvider(provider.id)}
                    title={lang === "zh" ? "删除此 Provider" : "Remove this provider"}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", marginLeft: 6, display: "flex", alignItems: "center" }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              <div className="setting-group">
                <label>API Key</label>
                <div className="api-key-input">
                  <input
                    type={showKeys[provider.id] ? "text" : "password"}
                    value={provider.apiKey}
                    onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                    placeholder={`输入 ${provider.name} API Key`}
                  />
                  <button
                    className="api-key-toggle"
                    onClick={() => toggleShowKey(provider.id)}
                    title={showKeys[provider.id] ? "隐藏" : "显示"}
                  >
                    {showKeys[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <label>Base URL</label>
                <input
                  type="text"
                  value={provider.baseUrl}
                  onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                />
              </div>

              <div className="setting-group" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={() => refreshProviderModels(provider.id)}
                  disabled={refreshingModels[provider.id]}
                  style={{
                    padding: "4px 12px",
                    background: refreshingModels[provider.id] ? "var(--bg-tertiary)" : "var(--accent)",
                    color: "var(--text-on-accent)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: 4,
                    fontSize: 'var(--fs-sm)',
                    cursor: refreshingModels[provider.id] ? "not-allowed" : "pointer",
                    opacity: refreshingModels[provider.id] ? 0.6 : 1,
                  }}
                >
                  {refreshingModels[provider.id] ? "获取中..." : "刷新模型列表"}
                </button>
                {refreshStatus[provider.id] && (
                  <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
                    {refreshStatus[provider.id]}
                  </span>
                )}
                {dynamicModels[provider.id] && dynamicModels[provider.id].length > 0 && !refreshStatus[provider.id] && (
                  <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
                    ✓ {dynamicModels[provider.id].length} 个动态模型
                  </span>
                )}
              </div>

              <button
                onClick={() => {
                  // Save settings
                  const newSettings = { ...settings };
                  setSettingJSON("codem-settings", newSettings);
                  // Trigger engine reconfigure
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
                style={{
                  padding: "6px 16px",
background: "var(--accent)",
color: "var(--text-on-accent)",
border: "none",
borderRadius: 4,
fontSize: 'var(--fs-sm)',
cursor: "pointer",
marginTop: 4,
                }}
              >
                {S.settings.saveRefresh[lang]}
              </button>
            </div>
          ))}

          {/* 通用协议配置：添加自定义 OpenAI-compatible Provider（如 b.ai / 百川智能等） */}
          <div className="provider-group" style={{ borderTop: "1px dashed var(--border-primary)", paddingTop: 10, marginTop: 4 }}>
            {!showAddCustom ? (
              <button
                onClick={() => setShowAddCustom(true)}
                style={{
                  width: "100%", padding: "8px 12px",
                  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                  border: "1px dashed var(--border-primary)", borderRadius: 6,
                  fontSize: 'var(--fs-sm)', cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                <Plus size={14} />
                {lang === "zh" ? "添加自定义 Provider（通用 OpenAI 兼容协议）" : "Add Custom Provider (OpenAI-compatible)"}
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginBottom: 2 }}>
                  {lang === "zh"
                    ? "输入任意 OpenAI 兼容服务的 Base URL 和 API Key，点击保存后可从服务商拉取模型列表（如 b.ai: https://api.baichuan-ai.com/v1）。"
                    : "Enter any OpenAI-compatible service Base URL and API Key. After saving, the model list can be fetched from the provider (e.g. b.ai: https://api.baichuan-ai.com/v1)."}
                </div>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={lang === "zh" ? "Provider 名称（如 b.ai）" : "Provider name (e.g. b.ai)"}
                  style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 'var(--fs-sm)' }}
                />
                <input
                  type="text"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder={lang === "zh" ? "Base URL（如 https://api.baichuan-ai.com/v1）" : "Base URL (e.g. https://api.baichuan-ai.com/v1)"}
                  style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 'var(--fs-sm)' }}
                />
                <input
                  type="password"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder={lang === "zh" ? "API Key" : "API Key"}
                  style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 'var(--fs-sm)' }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={addCustomProvider}
                    disabled={!customName.trim() || !customBaseUrl.trim()}
                    style={{
                      padding: "6px 16px", background: "var(--accent)", color: "var(--text-on-accent)",
                      border: "none", borderRadius: 4, fontSize: 'var(--fs-sm)', cursor: "pointer",
                      opacity: (!customName.trim() || !customBaseUrl.trim()) ? 0.5 : 1,
                    }}
                  >
                    {lang === "zh" ? "保存 Provider" : "Save Provider"}
                  </button>
                  <button
                    onClick={() => { setShowAddCustom(false); setCustomName(""); setCustomBaseUrl(""); setCustomApiKey(""); }}
                    style={{
                      padding: "6px 16px", background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                      border: "1px solid var(--border-primary)", borderRadius: 4, fontSize: 'var(--fs-sm)', cursor: "pointer",
                    }}
                  >
                    {lang === "zh" ? "取消" : "Cancel"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="settings-divider" />

          {/* S5: Sandbox Mode */}
          <div className="setting-group">
            <label>
              <input
                type="checkbox"
                checked={getSetting("codem-sandbox-enabled") === "true"}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSetting("codem-sandbox-enabled", "true");
                  } else {
                    removeSetting("codem-sandbox-enabled");
                  }
                  window.dispatchEvent(new Event("codem-settings-changed"));
                }}
              />
              {lang === "zh" ? "🔒 沙箱模式（限制写入范围到工作目录）" : "🔒 Sandbox Mode (restrict writes to workspace)"}
            </label>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginTop: 4 }}>
              {lang === "zh"
                ? "开启后，AI 助手只能在当前工作目录及其子目录中写入文件，防止意外修改项目外部文件。"
                : "When enabled, the AI assistant can only write files within the current workspace directory and its subdirectories."}
            </div>
          </div>

</>
          )}
          {activeTab === "multimodal" && (
          <>
          {/* F4: Multimodal Settings Entry */}
          <div className="setting-group">
            <label><Palette size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />{lang === "zh" ? "多模态能力" : "Multimodal"}</label>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginBottom: 8 }}>
              {lang === "zh"
                ? "配置 Embedding 语义搜索、TTS 语音合成、ImageGen 图像生成。"
                : "Configure Embedding semantic search, TTS text-to-speech, and ImageGen image generation."}
            </div>
            <button
              onClick={() => setShowMultimodal(!showMultimodal)}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "1px solid var(--border-primary)",
                background: showMultimodal ? "var(--accent-muted)" : "var(--bg-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                fontSize: 'var(--fs-base)',
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>{lang === "zh" ? <><Palette size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> 多模态设置</> : <><Palette size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Multimodal Settings</>}</span>
              <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{showMultimodal ? '▼' : '▶'}</span>
            </button>
          </div>

          {showMultimodal && (
            <MultimodalPanel inline onClose={() => setShowMultimodal(false)} />
          )}

          </>
          )}
{activeTab === "knowledge" && (
<>
{/* F8: Notebook Knowledge Settings */}
<NotebookSettingsSection />
</>
)}
{activeTab === "automation" && (
<>
<div style={{ padding: "40px 20px", textAlign: "center" }}>
  <div style={{ fontSize: 'var(--fs-md)', color: "var(--text-secondary)", marginBottom: 12 }}>
    {lang === "zh" ? "自动化任务已移至任务管理面板。" : "Automation tasks have moved to Task Center."}
  </div>
  <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
    {lang === "zh" ? "请在侧边栏点击“任务管理” → “自动化” Tab。" : "Click \"Task Center\" in the sidebar → \"Automation\" tab."}
  </div>
</div>
</>
)}
          {activeTab === "security" && (
          <>
          {/* F3.5: Custom Permission Rules UI */}
          <PermissionRulesSection />
          </>
          )}
          {activeTab === "git" && (
          <>
          {/* G series: Git Preferences */}
          <GitConfigSection />
          </>
          )}
{activeTab === "environment" && (
<>
{/* ENV series: Environment Scripts */}
<EnvironmentConfigSection />
</>
)}
{activeTab === "worktree" && (
<>
{/* Worktree Settings */}
<WorktreeSettingsSection lang={lang} />
</>
)}
{activeTab === "pet" && (
<>
{/* Pet Settings */}
<PetSettingsSection lang={lang} onOpenMarket={() => setShowPetMarket(true)} />
</>
)}
{activeTab === "voice" && (
<>
{/* P3-26: Voice Settings */}
<VoiceSettingsPanel />
</>
)}
{activeTab === "ollama" && (
<>
{/* P3-31: Ollama Local LLM Settings */}
<OllamaSettingsPanel />
</>
)}
{activeTab === "tools" && (
<>
{/* Tool Registry Management */}
<ToolManager onClose={() => {}} />
</>
)}
{activeTab === "codegraph" && (
<CodeGraphSettingsSection lang={lang} />
)}
{activeTab === "advanced" && (
<>
{/* Advanced Settings with sub-tabs */}
<div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
  {[
    { id: "agents", label: lang === "zh" ? "智能体" : "Agents", icon: <Bot size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "heartbeat", label: lang === "zh" ? "心跳" : "Heartbeat", icon: <HeartPulse size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "retry", label: lang === "zh" ? "重试" : "Retry", icon: <RotateCcw size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "prompt", label: lang === "zh" ? "提示词" : "Prompt", icon: <FileText size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "settings", label: lang === "zh" ? "分层设置" : "Layered", icon: <Layers size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "correction", label: lang === "zh" ? "纠偏模型" : "Correction", icon: <SearchIcon size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "profiles", label: "Agent Profile", icon: <User size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "transcript", label: lang === "zh" ? "缓存统计" : "Cache", icon: <MessageSquare size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
    { id: "recovery", label: lang === "zh" ? "恢复" : "Recovery", icon: <RotateCcw size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> },
  ].map(tab => (
    <button
      key={tab.id}
      onClick={() => setAdvancedSubTab(tab.id as any)}
      style={{
        padding: "5px 12px", borderRadius: 4, fontSize: 'var(--fs-sm)',
        border: `1px solid ${advancedSubTab === tab.id ? "var(--accent)" : "var(--border-primary)"}`,
        background: advancedSubTab === tab.id ? "var(--accent)" : "var(--bg-tertiary)",
        color: advancedSubTab === tab.id ? "#fff" : "var(--text-primary)",
        cursor: "pointer", whiteSpace: "nowrap",
      }}
    >
      {tab.icon} {tab.label}
    </button>
  ))}
</div>
{advancedSubTab === "agents" && <AgentManager onClose={() => {}} />}
{advancedSubTab === "heartbeat" && <HeartbeatMonitor />}
{advancedSubTab === "retry" && <RetryConfigPanel />}
{advancedSubTab === "prompt" && <PromptDebugger />}
{advancedSubTab === "settings" && <LayeredSettingsPanel />}
{advancedSubTab === "correction" && (
  <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
    <h3 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>{lang === "zh" ? "纠偏模型配置" : "Correction Model Config"}</h3>
    <p style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.5 }}>
      {lang === "zh" ? "开启后，AI 每次回复后会自动调用纠偏模型进行事实核查，弹出对比弹窗供你确认。" : "When enabled, AI responses are automatically fact-checked by a correction model, showing a comparison dialog."}
    </p>
    <CorrectionModelConfig />
  </div>
)}
{advancedSubTab === "recovery" && <RecoveryPanel />}
{advancedSubTab === "profiles" && <AgentProfileSection lang={lang} />}
{advancedSubTab === "transcript" && <TranscriptCacheStats lang={lang} />}
</>
)}
{activeTab === "help" && (
  <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, maxWidth: 500 }}>
    <h3 style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 600 }}>{lang === "zh" ? "帮助" : "Help"}</h3>
    
    <div className="setting-group">
      <label style={{ fontSize: 'var(--fs-md)', fontWeight: 500 }}>{lang === "zh" ? "新手引导" : "Onboarding Tour"}</label>
      <p style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.5, marginTop: 4 }}>
        {lang === "zh" ? "重新查看应用功能引导教程。" : "Replay the app feature tour."}
      </p>
      <button
        onClick={() => {
          setSetting("onboarding-completed", "");
          setShowOnboardingReplay?.(true);
        }}
        style={{
          padding: "8px 16px", fontSize: 'var(--fs-base)', cursor: "pointer",
          background: "var(--accent)", color: "#fff",
          border: "none", borderRadius: 6,
        }}
      >
        {lang === "zh" ? <><Play size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> 重新播放新手引导</> : <><Play size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> Replay Onboarding Tour</>}
      </button>
    </div>

    <div className="setting-group">
      <label style={{ fontSize: 'var(--fs-md)', fontWeight: 500 }}>{lang === "zh" ? "快捷键" : "Keyboard Shortcuts"}</label>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", lineHeight: 2 }}>
        <div><kbd>Ctrl + K</kbd> — {lang === "zh" ? "搜索对话" : "Search chat"}</div>
        <div><kbd>Ctrl + B</kbd> — {lang === "zh" ? "切换侧边栏" : "Toggle sidebar"}</div>
        <div><kbd>Esc</kbd> — {lang === "zh" ? "关闭弹窗/取消" : "Close dialog/cancel"}</div>
        <div><kbd>/</kbd> — {lang === "zh" ? "技能选择" : "Skill selector"}</div>
      </div>
    </div>

    <div className="setting-group">
      <label style={{ fontSize: 'var(--fs-md)', fontWeight: 500 }}>{lang === "zh" ? "关于" : "About"}</label>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.6 }}>
        Codem (mimo-gui) v{APP_VERSION}
        <br />
        {lang === "zh" ? "AI 编程助手 — 本地优先，隐私安全" : "AI Coding Assistant — Local-first, Privacy-focused"}
      </div>
      <button
        id="check-update-btn"
        className="save-btn"
        style={{ marginTop: 8, background: "var(--accent)", color: "#fff", border: "none", padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontSize: 'var(--fs-sm)' }}
        onClick={async () => {
          const btn = document.getElementById("check-update-btn") as HTMLButtonElement;
          if (!btn) return;
          btn.disabled = true;
          btn.textContent = lang === "zh" ? "检查中..." : "Checking...";
          try {
            const { check } = await import("@tauri-apps/plugin-updater");
            const { relaunch } = await import("@tauri-apps/plugin-process");
            const update = await check();
            if (update && update.available) {
              btn.textContent = lang === "zh" ? `发现新版本 ${update.version}，下载中...` : `New version ${update.version} found, downloading...`;
              await update.downloadAndInstall();
              btn.textContent = lang === "zh" ? "安装完成，即将重启..." : "Installed, relaunching...";
              await relaunch();
            } else {
              btn.textContent = lang === "zh" ? "已是最新版本" : "Up to date";
              setTimeout(() => { btn.disabled = false; btn.textContent = lang === "zh" ? "检查更新" : "Check for Updates"; }, 2000);
            }
          } catch (err: any) {
            const rawMsg = typeof err === "string" ? err
              : err?.message ? err.message
              : err?.code ? `Code: ${err.code}`
              : "";
            // If the remote release JSON is missing, offer a direct GitHub link instead
            const isNoRelease = rawMsg.includes("Could not fetch") || rawMsg.includes("release JSON");
            if (isNoRelease) {
              btn.textContent = lang === "zh" ? "自动更新不可用，正在打开下载页..." : "Auto-update unavailable, opening download page...";
              try {
                const { invoke } = (window as any).__TAURI__?.core ?? {};
                if (invoke) {
                  await invoke("plugin:shell|open", { path: "https://github.com/sdcxb/codem/releases" });
                } else {
                  window.open("https://github.com/sdcxb/codem/releases", "_blank");
                }
              } catch {
                window.open("https://github.com/sdcxb/codem/releases", "_blank");
              }
              setTimeout(() => { btn.disabled = false; btn.textContent = lang === "zh" ? "检查更新" : "Check for Updates"; }, 3000);
            } else {
              const errMsg = rawMsg || (lang === "zh" ? "未知错误（请检查网络连接或稍后重试）" : "Unknown error (check network or retry)");
              btn.textContent = lang === "zh" ? `更新失败: ${errMsg}` : `Update failed: ${errMsg}`;
              setTimeout(() => { btn.disabled = false; btn.textContent = lang === "zh" ? "检查更新" : "Check for Updates"; }, 3000);
            }
          }
        }}
      >
        {lang === "zh" ? "检查更新" : "Check for Updates"}
      </button>
    </div>
  </div>
)}
{/* P2 #35: Usage stats embedded in settings */}
{activeTab === "usage" && (
  <div style={{ padding: 16 }}>
    <UsageStats onClose={() => setActiveTab("general")} />
  </div>
)}
          </div>
        </div>

        <div className="settings-footer">
          {onSessionRecovery && (
            <button
              className="save-btn"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", marginRight: "auto" }}
              onClick={onSessionRecovery}
            >
              {S.settings.sessionRecovery[lang]}
            </button>
          )}
          {onUsageStats && (
            <button
              className="save-btn"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", marginRight: "8px" }}
              onClick={onUsageStats}
            >
              {S.settings.usageStats[lang]}
            </button>
          )}
          {saved && <span className="save-success">{S.settings.saved[lang]}</span>}
          <button className="save-btn" onClick={handleSave}>{S.settings.saveSettings[lang]}</button>
        </div>
      </div>
      <PetMarketDialog open={showPetMarket} onClose={() => setShowPetMarket(false)} />
    </div>
  );
}

// ========== Pet Settings Section ==========

function PetSettingsSection({ lang, onOpenMarket }: { lang: Language; onOpenMarket: () => void }) {
  const zh = lang === "zh";
  const {
    enabled,
    activePet,
    installedPets,
    scale,
    opacity,
    positionX,
    positionY,
    setEnabled,
    setActivePet,
    setScale,
    setOpacity,
    setPosition,
    refreshInstalledPets,
  } = usePetStore();

  // 位置滑块回调
  const handlePosChange = (axis: "x" | "y", value: number) => {
    if (axis === "x") {
      setPosition(value, positionY);
    } else {
      setPosition(positionX, value);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* 启用开关 */}
      <div className="settings-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: "var(--fs-md)", color: "var(--text-primary)" }}>
            {zh ? "启用桌面宠物" : "Enable Desktop Pet"}
          </div>
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", marginTop: "2px" }}>
            {zh ? "在窗口右下角显示宠物，它会响应 Agent 的工作状态" : "Show a pet in the bottom-right corner that reacts to Agent activity"}
          </div>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          style={{
            width: "44px",
            height: "24px",
            borderRadius: "12px",
            border: enabled ? "none" : "1px solid var(--border-primary)",
            background: enabled ? "var(--accent)" : "var(--bg-hover)",
            color: "#fff",
            cursor: "pointer",
            position: "relative",
            transition: "background 0.2s, border-color 0.2s",
            flexShrink: 0,
          }}
        >
          <span style={{
            position: "absolute",
            top: enabled ? "2px" : "1px",
            left: enabled ? "22px" : "2px",
            width: "20px",
            height: "20px",
            borderRadius: "50%",
            background: enabled ? "#fff" : "var(--text-secondary)",
            transition: "left 0.2s, background 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }} />
        </button>
      </div>

      {/* 宠物市场按钮 */}
      <div style={{
        padding: "12px 16px",
        borderRadius: "8px",
        background: "var(--bg-tertiary)",
        border: "1px solid var(--border-primary)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: "var(--fs-base)", color: "var(--text-primary)" }}>
            {zh ? "宠物市场" : "Pet Market"}
          </div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginTop: "2px" }}>
            {zh ? "从 Petdex 浏览和下载更多宠物" : "Browse and download more pets from Petdex"}
          </div>
        </div>
        <button
          onClick={onOpenMarket}
          style={{
            padding: "6px 16px",
            borderRadius: "6px",
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            fontSize: "var(--fs-base)",
            fontWeight: 500,
          }}
        >
          🐾 {zh ? "浏览市场" : "Browse Market"}
        </button>
      </div>

      {/* 已安装宠物列表 */}
      <div>
        <div style={{ fontWeight: 600, fontSize: "var(--fs-md)", color: "var(--text-primary)", marginBottom: "8px" }}>
          {zh ? "已安装宠物" : "Installed Pets"} ({installedPets.length})
        </div>
        {installedPets.length === 0 ? (
          <div style={{
            padding: "24px",
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: "var(--fs-base)",
            background: "var(--bg-tertiary)",
            borderRadius: "8px",
            border: "1px dashed var(--border-primary)",
          }}>
            {zh ? "暂无已安装的宠物，去市场看看吧~" : "No pets installed yet. Check out the market!"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {installedPets.map((pet) => (
              <div
                key={pet.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  background: activePet?.slug === pet.slug ? "rgba(99, 102, 241, 0.15)" : "var(--bg-tertiary)",
                  border: activePet?.slug === pet.slug ? "1px solid var(--accent)" : "1px solid var(--border-primary)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "var(--fs-base)", color: "var(--text-primary)" }}>
                    {pet.definition.name}
                    {activePet?.slug === pet.slug && (
                      <span style={{ marginLeft: "8px", fontSize: "var(--fs-xs)", color: "var(--accent)" }}>● {zh ? "当前" : "Active"}</span>
                    )}
                  </div>
                  <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)" }}>
                    {pet.definition.description || pet.definition.author || pet.slug}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  {activePet?.slug !== pet.slug && (
                    <button
                      onClick={() => setActivePet(pet.slug)}
                      style={{
                        padding: "4px 10px",
                        borderRadius: "4px",
                        border: "1px solid var(--border-primary)",
                        background: "none",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        fontSize: "var(--fs-sm)",
                      }}
                    >
                      {zh ? "激活" : "Activate"}
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      await uninstallPet(pet.slug);
                      await refreshInstalledPets();
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "4px",
                      border: "1px solid rgba(239, 68, 68, 0.3)",
                      background: "rgba(239, 68, 68, 0.1)",
                      color: "#f87171",
                      cursor: "pointer",
                      fontSize: "var(--fs-sm)",
                    }}
                  >
                    {zh ? "卸载" : "Uninstall"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 缩放滑轨 — 始终可见 */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
          <span style={{ fontSize: "var(--fs-base)", color: "var(--text-primary)" }}>{zh ? "宠物大小" : "Pet Size"}</span>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)" }}>{Math.round(scale * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.15"
          max="1.5"
          step="0.05"
          value={scale}
          onChange={(e) => setScale(parseFloat(e.target.value))}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "2px", fontSize: "var(--fs-xs)", color: "var(--text-muted, #666)" }}>
          <span>{zh ? "小" : "Small"}</span>
          <span>{zh ? "大" : "Large"}</span>
        </div>
      </div>

      {/* 其他显示设置 — 仅启用且有激活宠物时可见 */}
      {enabled && activePet && (
        <>
          {/* 透明度 */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ fontSize: "var(--fs-base)", color: "var(--text-primary)" }}>{zh ? "透明度" : "Opacity"}</span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)" }}>{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.3"
              max="1.0"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>

          {/* 位置 X */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ fontSize: "var(--fs-base)", color: "var(--text-primary)" }}>{zh ? "水平位置" : "Position X"}</span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)" }}>{positionX}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="400"
              step="4"
              value={positionX}
              onChange={(e) => handlePosChange("x", parseInt(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>

          {/* 位置 Y */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ fontSize: "var(--fs-base)", color: "var(--text-primary)" }}>{zh ? "垂直位置" : "Position Y"}</span>
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)" }}>{positionY}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="300"
              step="4"
              value={positionY}
              onChange={(e) => handlePosChange("y", parseInt(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>

          {/* 提示 */}
          <div style={{
            padding: "8px 12px",
            borderRadius: "6px",
            background: "rgba(99, 102, 241, 0.08)",
            border: "1px solid rgba(99, 102, 241, 0.2)",
            fontSize: "var(--fs-xs)",
            color: "var(--text-secondary)",
          }}>
            <Lightbulb size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> {zh ? "提示：可以直接拖拽窗口中的宠物来移动位置。空闲时点击宠物有彩蛋。" : "Tip: Drag the pet in the window to reposition. Click the pet when idle for a surprise."}
          </div>
        </>
      )}
    </div>
  );
}

// ========== F3.5: Permission Rules Section ==========

function PermissionRulesSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [customRules, setCustomRules] = useState<PermissionRule[]>([]);
  const [newRule, setNewRule] = useState<PermissionRule>({
    tool: "*",
    action: "ask",
    resource: "",
  });

  const refresh = () => {
    const evaluator = getPermissionManager().getEvaluator();
    setCustomRules([...evaluator.getCustomRules()]);
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAdd = () => {
    if (!newRule.tool.trim()) return;
    const evaluator = getPermissionManager().getEvaluator();
    evaluator.addCustomRule({
      tool: newRule.tool.trim(),
      action: newRule.action,
      resource: newRule.resource?.trim() || undefined,
    });
    refresh();
    setNewRule({ tool: "*", action: "ask", resource: "" });
  };

  const handleRemove = (index: number) => {
    const evaluator = getPermissionManager().getEvaluator();
    // Custom rules start after default rules
    const defaultCount = 16;
    evaluator.removeCustomRule(defaultCount + index);
    refresh();
  };

  const actionLabels: Record<PermissionAction, string> = {
    allow: zh ? "允许" : "Allow",
    deny: zh ? "禁止" : "Deny",
    ask: zh ? "询问" : "Ask",
  };

  const actionColors: Record<PermissionAction, string> = {
    allow: "var(--success)",
    deny: "var(--error)",
    ask: "var(--text-secondary)",
  };

  return (
    <div className="setting-group">
      <div className="settings-section-title">
        {zh ? "🔐 权限规则" : "🔐 Permission Rules"}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh
          ? "自定义工具权限规则。规则按顺序匹配，最后匹配的规则生效。内置规则（受保护路径、危险命令）始终生效。"
          : "Custom tool permission rules. Rules are matched in order, last match wins. Built-in rules (protected paths, dangerous commands) always apply."}
      </div>

      {/* Existing custom rules */}
      {customRules.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {customRules.map((rule, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                background: "var(--bg-secondary)",
                borderRadius: 6,
                border: "1px solid var(--border-primary)",
                fontSize: 'var(--fs-sm)',
              }}
            >
              <span style={{ fontFamily: "monospace", flex: "0 0 auto", color: "var(--text-primary)" }}>
                {rule.tool}
              </span>
              {rule.resource && (
                <>
                  <span style={{ color: "var(--text-muted)" }}>→</span>
                  <span style={{ fontFamily: "monospace", flex: "0 0 auto", color: "var(--text-secondary)" }}>
                    {rule.resource}
                  </span>
                </>
              )}
              <span style={{ color: actionColors[rule.action], fontWeight: 600, marginLeft: "auto" }}>
                {actionLabels[rule.action]}
              </span>
              <button
                onClick={() => handleRemove(i)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 'var(--fs-md)',
                  padding: "0 4px",
                }}
                title={zh ? "删除" : "Delete"}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {customRules.length === 0 && (
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginBottom: 12, fontStyle: "italic" }}>
          {zh ? "暂无自定义规则" : "No custom rules"}
        </div>
      )}

      {/* Add new rule */}
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          padding: 10,
          background: "var(--bg-secondary)",
          borderRadius: 6,
          border: "1px solid var(--border-primary)",
        }}
      >
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            {zh ? "工具名 (支持 * 通配)" : "Tool (supports * wildcard)"}
          </label>
          <input
            type="text"
            value={newRule.tool}
            onChange={(e) => setNewRule({ ...newRule, tool: e.target.value })}
            placeholder="bash / write / *"
            style={{ width: "100%", fontSize: 'var(--fs-sm)', fontFamily: "monospace" }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            {zh ? "资源匹配 (可选)" : "Resource (optional)"}
          </label>
          <input
            type="text"
            value={newRule.resource || ""}
            onChange={(e) => setNewRule({ ...newRule, resource: e.target.value })}
            placeholder="rm -rf* / **/.env"
            style={{ width: "100%", fontSize: 'var(--fs-sm)', fontFamily: "monospace" }}
          />
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <label style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            {zh ? "动作" : "Action"}
          </label>
          <select
            value={newRule.action}
            onChange={(e) => setNewRule({ ...newRule, action: e.target.value as PermissionAction })}
            style={{ fontSize: 'var(--fs-sm)' }}
          >
            <option value="ask">{zh ? "询问" : "Ask"}</option>
            <option value="allow">{zh ? "允许" : "Allow"}</option>
            <option value="deny">{zh ? "禁止" : "Deny"}</option>
          </select>
        </div>
        <button
          onClick={handleAdd}
          style={{
            padding: "6px 14px",
background: "var(--accent)",
color: "var(--text-on-accent)",
border: "none",
borderRadius: 4,
fontSize: 'var(--fs-sm)',
cursor: "pointer",
whiteSpace: "nowrap",
flex: "0 0 auto",
          }}
        >
          {zh ? "添加" : "Add"}
        </button>
      </div>

      {/* Quick templates */}
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{zh ? "快速添加: " : "Quick add: "}</span>
        {[
          { label: zh ? "禁止 bash sudo" : "Deny sudo", tool: "bash", action: "deny" as PermissionAction, resource: "sudo*" },
          { label: zh ? "允许 read *" : "Allow read", tool: "read", action: "allow" as PermissionAction, resource: "" },
          { label: zh ? "禁止 write *.lock" : "Deny *.lock", tool: "write", action: "deny" as PermissionAction, resource: "**/*.lock" },
          { label: zh ? "询问 bash npm*" : "Ask npm", tool: "bash", action: "ask" as PermissionAction, resource: "npm*" },
        ].map((tpl) => (
          <button
            key={tpl.label}
            onClick={() => {
              const evaluator = getPermissionManager().getEvaluator();
              evaluator.addCustomRule({
                tool: tpl.tool,
                action: tpl.action,
                resource: tpl.resource || undefined,
              });
              refresh();
            }}
            style={{
              padding: "3px 8px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              borderRadius: 3,
              fontSize: 'var(--fs-sm)',
              cursor: "pointer",
              color: "var(--text-secondary)",
            }}
          >
            {tpl.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ========== Security Mode Selector Component ==========

export function SecurityModeSelector({
  currentMode,
  onModeChange,
  lang,
  compact,
}: {
  currentMode: SecurityMode;
  onModeChange: (mode: SecurityMode) => void;
  lang: "zh" | "en";
  compact?: boolean;
}) {
  const zh = lang === "zh";
  return (
    <div style={{ display: "flex", gap: compact ? 4 : 8, flexWrap: "wrap" }}>
      {SECURITY_MODES.map((m) => (
        <button
          key={m.mode}
          onClick={() => onModeChange(m.mode)}
          style={{
            flex: compact ? undefined : 1,
            padding: compact ? "4px 8px" : "8px 12px",
            borderRadius: 6,
            border: `1px solid ${currentMode === m.mode ? "var(--accent)" : "var(--border-primary)"}`,
            background: currentMode === m.mode ? "var(--accent)" : "var(--bg-secondary)",
            color: currentMode === m.mode ? "#fff" : "var(--text-primary)",
            cursor: "pointer",
            fontSize: compact ? 11 : 13,
            fontWeight: currentMode === m.mode ? 600 : 400,
            transition: "all 0.15s ease",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}
          title={zh ? m.desc_zh : m.desc_en}
        >
          <span style={{ fontSize: compact ? 12 : 16 }}>{m.icon}</span>
          <span>{zh ? m.label_zh : m.label_en}</span>
          {!compact && (
            <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.8, textAlign: "center", marginTop: 2 }}>
              {zh ? m.desc_zh : m.desc_en}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ========== Worktree Settings Section ==========

function WorktreeSettingsSection({ lang }: { lang: ReturnType<typeof useLang> }) {
  const zh = lang === "zh";
  const [settings, setSettings] = useState(() => getWorktreeSettings());
  const [scanResults, setScanResults] = useState<WorktreeInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const { currentProject } = useProjectStore();
  const [scanError, setScanError] = useState<string | null>(null);

  // Load settings
  useEffect(() => {
    setSettings(getWorktreeSettings());
    const handler = () => setSettings(getWorktreeSettings());
    window.addEventListener("codem-worktree-settings-changed", handler);
    return () => window.removeEventListener("codem-worktree-settings-changed", handler);
  }, []);

  // Scan worktrees for current project
  const handleScan = async () => {
    if (!currentProject?.path) {
      setScanError(zh ? "请先选择项目" : "Select a project first");
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      const { getWorktreeRoot, scanWorktrees } = await import("../core/environment");
      const root = getWorktreeRoot(currentProject.path);
      const results = await scanWorktrees(root);
      setScanResults(results);
    } catch (e: any) {
      setScanError(e?.message || String(e));
    } finally {
      setScanning(false);
    }
  };

  // Delete a worktree
  const handleDelete = async (wt: WorktreeInfo) => {
    if (!currentProject?.path) return;
    if (wt.hasUncommitted) {
      if (!confirm(zh ? `工作树 ${wt.sessionId} 有未提交修改，确认删除？` : `Worktree ${wt.sessionId} has uncommitted changes. Delete anyway?`)) {
        return;
      }
    }
    try {
      const { removeWorktree } = await import("../core/environment");
      await removeWorktree(currentProject.path, wt.path);
      handleScan(); // Refresh
    } catch (e: any) {
      setScanError(e?.message || String(e));
    }
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--text-primary)", marginBottom: 4,
    display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "6px 10px", borderRadius: 4,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)",
    fontSize: 'var(--fs-base)', width: 80,
  };

  return (
    <div className="setting-group">
      <label style={{ fontSize: 'var(--fs-md)', fontWeight: 700, marginBottom: 8, display: "block" }}>
        🌲 {zh ? "Git 工作树管理" : "Git Worktree Management"}
      </label>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh
          ? "管理 Git Worktree 的创建、清理和数量限制。工作树模式为每个任务创建独立的文件系统目录，实现真正的并行隔离。"
          : "Manage Git Worktree creation, cleanup, and limits. Worktree mode creates isolated filesystem directories per task for true parallel isolation."}
      </div>

      {/* Max worktrees */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{zh ? "最大工作树数量" : "Max Worktrees"}</label>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={settings.maxWorktrees}
          onChange={(e) => {
            const val = parseInt(e.target.value) || 15;
            setWorktreeSettings({ maxWorktrees: val });
            setSettings(getWorktreeSettings());
          }}
          style={inputStyle}
        />
        <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginLeft: 8 }}>
          {zh ? "超过此数量自动清理最旧的（默认 15）" : "Auto-clean oldest when exceeded (default 15)"}
        </span>
        {scanResults.length > 0 && (
          <span style={{ fontSize: 'var(--fs-sm)', marginLeft: 12, color: scanResults.length >= settings.maxWorktrees ? "#e74c3c" : "#22c55e" }}>
            {zh ? `当前: ${scanResults.length}/${settings.maxWorktrees}` : `Current: ${scanResults.length}/${settings.maxWorktrees}`}
          </span>
        )}
      </div>

      {/* Auto clean oldest */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 'var(--fs-base)' }}>
          <input
            type="checkbox"
            checked={settings.autoCleanOldest}
            onChange={(e) => {
              setWorktreeSettings({ autoCleanOldest: e.target.checked });
              setSettings(getWorktreeSettings());
            }}
            style={{ width: 16, height: 16 }}
          />
          <span>{zh ? "自动清理最旧工作树" : "Auto-clean oldest worktrees"}</span>
        </label>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 4, marginLeft: 24 }}>
          {zh ? "新建工作树时，如果超过上限，自动删除最旧的非活跃工作树。" : "When creating a new worktree, auto-remove the oldest inactive one if limit exceeded."}
        </div>
      </div>

      {/* Warn on dirty */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 'var(--fs-base)' }}>
          <input
            type="checkbox"
            checked={settings.warnOnDirty}
            onChange={(e) => {
              setWorktreeSettings({ warnOnDirty: e.target.checked });
              setSettings(getWorktreeSettings());
            }}
            style={{ width: 16, height: 16 }}
          />
          <span>{zh ? "归档前检查未提交修改" : "Warn on uncommitted changes before archive"}</span>
        </label>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 4, marginLeft: 24 }}>
          {zh ? "删除工作树前检查是否有未提交的代码，有则提示确认。" : "Check for uncommitted changes before deleting a worktree; prompt for confirmation."}
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border-primary)", margin: "16px 0", paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            {zh ? "已有工作树" : "Existing Worktrees"}
          </label>
          <button
            onClick={handleScan}
            disabled={scanning || !currentProject?.path}
            style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 'var(--fs-sm)',
              border: "1px solid var(--border-primary)",
              background: "var(--bg-tertiary)", color: "var(--text-primary)",
              cursor: scanning ? "wait" : "pointer",
            }}
          >
            {scanning ? <Clock size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> : <RotateCcw size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />} {zh ? "扫描" : "Scan"}
          </button>
        </div>
        {!currentProject?.path && (
          <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
            {zh ? "请先选择项目" : "Select a project first"}
          </div>
        )}
        {scanError && (
          <div style={{ fontSize: 'var(--fs-sm)', color: "#e74c3c", marginBottom: 8 }}>{scanError}</div>
        )}
        {scanResults.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {scanResults.map(wt => (
              <div key={wt.sessionId} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 8px", borderRadius: 4,
                border: "1px solid var(--border-primary)",
                background: "var(--bg-tertiary)", fontSize: 'var(--fs-sm)',
              }}>
                <span style={{ fontSize: 'var(--fs-md)' }}>{wt.hasUncommitted ? <AlertTriangle size={14} style={{ color: 'var(--warning)' }} /> : <GitBranchIcon size={14} style={{ color: 'var(--success)' }} />}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{wt.sessionId}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis" }}>{wt.path}</div>
                </div>
                <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7, display: 'flex', alignItems: 'center', gap: 2 }}><GitBranchIcon size={10} /> {wt.branch}</span>
                {wt.hasUncommitted && (
                  <span style={{ fontSize: 'var(--fs-xs)', color: "#e67e22" }}>
                    {zh ? "未提交" : "dirty"}
                  </span>
                )}
                <button
                  onClick={() => handleDelete(wt)}
                  style={{
                    padding: "2px 8px", borderRadius: 4, fontSize: 'var(--fs-sm)',
                    border: "1px solid #e74c3c", background: "transparent",
                    color: "#e74c3c", cursor: "pointer",
                  }}
                >
                  {zh ? "删除" : "Delete"}
                </button>
              </div>
            ))}
          </div>
        )}
        {scanResults.length === 0 && currentProject?.path && !scanning && !scanError && (
          <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
            {zh ? "无工作树（扫描后显示）" : "No worktrees (scan to see)"}
          </div>
        )}
      </div>
    </div>
  );
}

function NotebookSettingsSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [config, setConfig] = useState(() => {
    try {
      return getNotebookConfig();
    } catch {
      return { maxChunkSize: 2000, overlapSize: 200, topK: 5, similarityThreshold: 0.3 };
    }
  });

  const updateConfig = (key: string, value: number) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    setSettingJSON('codem-notebook-config', newConfig);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--border-primary)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: 'var(--fs-base)',
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-secondary)',
    marginBottom: 4,
    display: 'block',
  };

  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border-primary)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      <div className="settings-section-title" style={{ marginBottom: 12 }}>
        {zh ? '📓 知识笔记本设置' : '📓 Notebook Knowledge Settings'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>
            {zh ? '最大分块大小（字符）' : 'Max Chunk Size (chars)'}
          </label>
          <input
            type="number"
            min={500}
            max={8000}
            step={100}
            value={config.maxChunkSize}
            onChange={(e) => updateConfig('maxChunkSize', parseInt(e.target.value) || 2000)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>
            {zh ? '重叠大小（字符）' : 'Overlap Size (chars)'}
          </label>
          <input
            type="number"
            min={0}
            max={1000}
            step={50}
            value={config.overlapSize}
            onChange={(e) => updateConfig('overlapSize', parseInt(e.target.value) || 200)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>
            {zh ? '检索结果数量 (Top-K)' : 'Retrieval Top-K'}
          </label>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={config.topK}
            onChange={(e) => updateConfig('topK', parseInt(e.target.value) || 5)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>
            {zh ? '相似度阈值' : 'Similarity Threshold'}
          </label>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.similarityThreshold}
            onChange={(e) => updateConfig('similarityThreshold', parseFloat(e.target.value) || 0.3)}
            style={inputStyle}
          />
        </div>
      </div>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
        {zh
          ? '调整知识笔记本的文本分块和检索参数。较小的分块提供更精确的检索但可能丢失上下文；较大的分块保留更多上下文但可能引入噪声。'
          : 'Adjust text chunking and retrieval parameters for knowledge notebooks. Smaller chunks provide more precise retrieval but may lose context; larger chunks retain more context but may introduce noise.'}
      </p>
    </div>
  );
}

// ========== Automation Settings Section ==========
// NOTE: AutomationSettingsSection has been moved to TaskCenter → AutomationTab.
// The settings panel now shows a redirect message instead.

// ========== Agent Profile Management Section ==========

function AgentProfileSection({ lang }: { lang: Language }) {
  const zh = lang === "zh";
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [editing, setEditing] = useState<Partial<AgentProfile> | null>(null);

  const refresh = () => setProfiles(AgentProfileStorage.listAll());
  useEffect(() => { refresh(); }, []);

  const handleSave = () => {
    if (!editing || !editing.identity || !editing.domain) return;
    if (editing.id) {
      AgentProfileStorage.update(editing.id, {
        identity: editing.identity,
        domain: editing.domain,
        scope: editing.scope || "",
        skills: editing.skills,
        experience_summary: editing.experience_summary,
      });
    } else {
      AgentProfileStorage.create({
        id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        identity: editing.identity,
        domain: editing.domain,
        scope: editing.scope || "",
        skills: editing.skills,
        experience_summary: editing.experience_summary,
      });
    }
    setEditing(null);
    refresh();
  };

  const handleDelete = (id: string) => {
    if (confirm(zh ? "确认删除此 Profile？" : "Delete this profile?")) {
      AgentProfileStorage.delete(id);
      refresh();
    }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>{zh ? "👤 Agent Profile 管理" : "👤 Agent Profile Management"}</h3>
        <button
          onClick={() => setEditing({ identity: "", domain: "", scope: "" })}
          style={{ padding: "4px 12px", fontSize: 'var(--fs-sm)', cursor: "pointer", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 4 }}
        >+ {zh ? "新建" : "New"}</button>
      </div>
      <p style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.5 }}>
        {zh ? "Profile 是子智能体的持久化身份/领域/范围记录，生成子智能体时自动注入到 system prompt。" : "Profiles are persistent identity/domain/scope records for subagents, auto-injected into system prompt on spawn."}
      </p>

      {editing && (
        <div style={{ padding: 12, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", display: "flex", flexDirection: "column", gap: 8 }}>
          <input value={editing.identity || ""} onChange={(e) => setEditing({ ...editing, identity: e.target.value })} placeholder={zh ? "身份标识（如：前端专家）" : "Identity (e.g.: Frontend Expert)"} style={{ fontSize: 'var(--fs-sm)', padding: "4px 8px" }} />
          <input value={editing.domain || ""} onChange={(e) => setEditing({ ...editing, domain: e.target.value })} placeholder={zh ? "领域（如：React/TypeScript）" : "Domain (e.g.: React/TypeScript)"} style={{ fontSize: 'var(--fs-sm)', padding: "4px 8px" }} />
          <input value={editing.scope || ""} onChange={(e) => setEditing({ ...editing, scope: e.target.value })} placeholder={zh ? "范围（如：组件开发/性能优化）" : "Scope (e.g.: Components/Performance)"} style={{ fontSize: 'var(--fs-sm)', padding: "4px 8px" }} />
          <textarea value={editing.experience_summary || ""} onChange={(e) => setEditing({ ...editing, experience_summary: e.target.value })} placeholder={zh ? "经验摘要（可选）" : "Experience summary (optional)"} rows={2} style={{ fontSize: 'var(--fs-sm)', padding: "4px 8px", resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSave} style={{ padding: "4px 12px", fontSize: 'var(--fs-sm)', cursor: "pointer", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 4 }}>{zh ? "保存" : "Save"}</button>
            <button onClick={() => setEditing(null)} style={{ padding: "4px 12px", fontSize: 'var(--fs-sm)', cursor: "pointer", background: "none", border: "1px solid var(--border-primary)", borderRadius: 4 }}>{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}

      {profiles.length === 0 && !editing && (
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", textAlign: "center", padding: 16 }}>{zh ? "暂无 Agent Profile" : "No agent profiles yet"}</div>
      )}

      {profiles.map((p) => (
        <div key={p.id} style={{ padding: 10, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 'var(--fs-base)', fontWeight: 500 }}>{p.identity}</span>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => setEditing(p)} style={{ fontSize: 'var(--fs-sm)', padding: "2px 8px", cursor: "pointer", background: "transparent", border: "1px solid var(--border-primary)", borderRadius: 3 }}>{zh ? "编辑" : "Edit"}</button>
              <button onClick={() => handleDelete(p.id)} style={{ fontSize: 'var(--fs-sm)', padding: "2px 8px", cursor: "pointer", background: "transparent", border: "1px solid #e55", borderRadius: 3, color: "#e55" }}>{zh ? "删除" : "Delete"}</button>
            </div>
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{p.domain} · {p.scope}</div>
          {p.experience_summary && <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-secondary)", lineHeight: 1.4 }}>{p.experience_summary}</div>}
          {p.skills && p.skills.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {p.skills.map((s) => <span key={s} style={{ fontSize: 'var(--fs-xs)', padding: "1px 6px", background: "var(--bg-secondary)", borderRadius: 3, border: "1px solid var(--border-primary)" }}>{s}</span>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ========== TranscriptCache Stats Section ==========

function TranscriptCacheStats({ lang }: { lang: Language }) {
  const zh = lang === "zh";
  const [stats, setStats] = useState({ size: 0, maxSize: 100 });
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => setStats(TranscriptCache.stats()), 2000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const pct = stats.maxSize > 0 ? Math.round((stats.size / stats.maxSize) * 100) : 0;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>{zh ? "💬 Transcript 缓存统计" : "💬 Transcript Cache Stats"}</h3>
      <p style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.5 }}>
        {zh ? "缓存 LLM 请求/响应对以减少 token 消耗。10 分钟 TTL，最多 100 条。上下文压缩时自动清空。" : "Caches LLM request/response pairs to reduce token waste. 10min TTL, max 100 entries. Auto-cleared on context compaction."}
      </p>

      <div style={{ padding: 16, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 'var(--fs-base)', fontWeight: 500 }}>{zh ? "缓存占用" : "Cache Usage"}</span>
          <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{stats.size} / {stats.maxSize}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "var(--bg-secondary)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: pct > 80 ? "#e55" : "var(--accent)", borderRadius: 4, transition: "width 0.3s" }} />
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 4 }}>{pct}% {zh ? "已使用" : "used"}</div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => { TranscriptCache.clear(); setStats(TranscriptCache.stats()); }}
          style={{ padding: "6px 12px", fontSize: 'var(--fs-sm)', cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 4 }}
        >{zh ? "🗑️ 清空缓存" : "🗑️ Clear Cache"}</button>
        <button
          onClick={() => setStats(TranscriptCache.stats())}
          style={{ padding: "6px 12px", fontSize: 'var(--fs-sm)', cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 4 }}
        >{zh ? "🔄 刷新" : "🔄 Refresh"}</button>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 'var(--fs-sm)', cursor: "pointer" }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          {zh ? "自动刷新" : "Auto refresh"}
        </label>
      </div>
    </div>
  );
}

// ========== CodeGraph Settings Section ==========

function CodeGraphSettingsSection({ lang }: { lang: ReturnType<typeof useLang> }) {
  const zh = lang === "zh";
  const [enabled, setEnabled] = useState(() => {
    try {
      const { isCodeGraphEnabled } = require("../core/mcp/mcp");
      return isCodeGraphEnabled();
    } catch { return true; }
  });
  const [status, setStatus] = useState<"checking" | "installed" | "not_installed">("checking");
  const [projectPath, setProjectPath] = useState("");
  const [hasIndex, setHasIndex] = useState(false);
  const [initRunning, setInitRunning] = useState(false);
  const [initOutput, setInitOutput] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { invoke } = (window as any).__TAURI__.core;
        const result = await invoke("execute_command", {
          command: "codegraph --version",
          cwd: null,
        });
        const stderr = result.stderr || "";
        if (stderr.includes("not recognized") || stderr.includes("not found")) {
          setStatus("not_installed");
        } else {
          setStatus("installed");
        }
      } catch {
        setStatus("not_installed");
      }
    })();
  }, []);

  useEffect(() => {
    try {
      const { getSetting } = require("../core/storage/settings");
      const p = getSetting("codem-current-project-path") || "";
      setProjectPath(p);
      if (p) {
        const { invoke } = (window as any).__TAURI__.core;
        invoke("path_exists", { path: `${p}/.codegraph` }).then((exists: boolean) => {
          setHasIndex(exists);
        }).catch(() => setHasIndex(false));
      }
    } catch {}
  }, []);

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    try {
      const { setCodeGraphEnabled, disconnectCodeGraph, getMCPRegistry } = require("../core/mcp/mcp");
      setCodeGraphEnabled(checked);
      if (!checked) {
        disconnectCodeGraph(getMCPRegistry());
      }
      window.dispatchEvent(new CustomEvent("codem-codegraph-config-changed", { detail: { enabled: checked } }));
    } catch {}
  };

  const handleInit = async () => {
    if (!projectPath) return;
    setInitRunning(true);
    setInitOutput(zh ? "正在构建代码图谱..." : "Building code graph...");
    try {
      const { invoke } = (window as any).__TAURI__.core;
      const result = await invoke("execute_command", {
          command: "codegraph init",
          cwd: projectPath,
        });
      setInitOutput(result.stdout || result.stderr || (zh ? "完成" : "Done"));
      setHasIndex(true);
    } catch (e: any) {
      setInitOutput(zh ? `失败: ${e.message || e}` : `Failed: ${e.message || e}`);
    } finally {
      setInitRunning(false);
    }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h3 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>
        {zh ? "🔗 CodeGraph 代码知识图谱" : "🔗 CodeGraph Code Intelligence"}
      </h3>
      <p style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
        {zh
          ? "CodeGraph 把代码库从\"文件集合\"转换成\"可查询的关系图\"，帮助 AI 更快理解大型项目。Agent 用一次 codegraph_explore 调用替代 10-20 次 grep+read，大幅减少 token 消耗。"
          : "CodeGraph transforms your codebase from a \"collection of files\" into a \"queryable relationship graph\", helping AI understand large projects faster. One codegraph_explore call replaces 10-20 grep+read calls, dramatically reducing token usage."}
      </p>

      <div style={{ padding: 16, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 'var(--fs-base)' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} style={{ width: 16, height: 16 }} />
          <span style={{ fontWeight: 600 }}>{zh ? "启用 CodeGraph 集成" : "Enable CodeGraph Integration"}</span>
        </label>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginTop: 4, marginLeft: 24 }}>
          {zh
            ? "开启后，打开包含 .codegraph/ 目录的项目时自动连接 CodeGraph MCP Server，agent 将获得 codegraph_explore 工具。"
            : "When enabled, opening a project with a .codegraph/ directory auto-connects the CodeGraph MCP Server. The agent gains the codegraph_explore tool."}
        </div>
      </div>

      <div style={{ padding: 16, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 'var(--fs-base)', fontWeight: 500, marginBottom: 8 }}>{zh ? "CLI 状态" : "CLI Status"}</div>
        {status === "checking" && <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{zh ? "检测中..." : "Checking..."}</div>}
        {status === "installed" && <div style={{ fontSize: 'var(--fs-sm)', color: "#22c55e" }}>✓ {zh ? "codegraph CLI 已安装" : "codegraph CLI is installed"}</div>}
        {status === "not_installed" && (
          <div>
            <div style={{ fontSize: 'var(--fs-sm)', color: "#e74c3c", marginBottom: 8 }}>✗ {zh ? "codegraph CLI 未安装" : "codegraph CLI is not installed"}</div>
            <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.5 }}>
              {zh ? "安装命令（PowerShell）：" : "Install command (PowerShell):"}
              <br />
              <code style={{ background: "var(--bg-secondary)", padding: "2px 6px", borderRadius: 3, fontSize: 'var(--fs-sm)' }}>
                irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
              </code>
            </div>
          </div>
        )}
      </div>

      {projectPath && (
        <div style={{ padding: 16, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 'var(--fs-base)', fontWeight: 500, marginBottom: 8 }}>{zh ? "当前项目" : "Current Project"}</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginBottom: 8, wordBreak: "break-all" }}>{projectPath}</div>
          <div style={{ fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
            {hasIndex ? (
              <span style={{ color: "#22c55e" }}>✓ {zh ? "已有 .codegraph/ 索引" : ".codegraph/ index exists"}</span>
            ) : (
              <span style={{ color: "#e74c3c" }}>✗ {zh ? "未找到 .codegraph/ 索引" : ".codegraph/ index not found"}</span>
            )}
          </div>
          {!hasIndex && status === "installed" && (
            <button
              onClick={handleInit}
              disabled={initRunning}
              style={{
                padding: "8px 16px", fontSize: 'var(--fs-sm)', cursor: initRunning ? "wait" : "pointer",
                background: "var(--accent)", border: "none", borderRadius: 4, color: "white",
                fontWeight: 500, opacity: initRunning ? 0.6 : 1,
              }}
            >
              {initRunning ? (zh ? "构建中..." : "Building...") : (zh ? "🔨 构建代码图谱" : "🔨 Build Code Graph")}
            </button>
          )}
          {initOutput && (
            <pre style={{ marginTop: 8, padding: 8, background: "var(--bg-secondary)", borderRadius: 4, fontSize: 'var(--fs-sm)', overflow: "auto", maxHeight: 200, whiteSpace: "pre-wrap" }}>
              {initOutput}
            </pre>
          )}
        </div>
      )}

      <div style={{ padding: 16, borderRadius: 6, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, marginBottom: 8 }}>
          {zh ? "📊 实测效果（7 个真实项目基准）" : "📊 Measured Results (7 real-world repos)"}
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.6 }}>
          {zh ? "• 工具调用次数减少 88%（28 次 → 2 次）" : "• Tool calls reduced 88% (28 → 2)"}<br />
          {zh ? "• 文件读取次数降为零（19 次 → 0 次）" : "• File reads reduced to zero (19 → 0)"}<br />
          {zh ? "• Token 消耗减少 62%" : "• Token usage reduced 62%"}<br />
          {zh ? "• 费用降低 44%" : "• Cost reduced 44%"}<br />
          {zh ? "• 响应时间快 53%" : "• Response time 53% faster"}
        </div>
      </div>
    </div>
  );
}