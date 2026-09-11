import { useState, useEffect, useCallback, useMemo } from "react";
import type { IdentityConfig, UserConfig, AppIdentity } from "../core/types";
import { saveAppIdentity } from "../core/config/loader";
import { version as APP_VERSION } from "../../package.json";
import { getMiMoAuth } from "../core/auth/mimo";
import type { LoginResult } from "../core/auth/mimo";
import { useAppStore } from "../store";
import { inferContextWindow } from "../core/llm/provider";
import { getSettingJSON, setSettingJSON, getSetting, setSetting, removeSetting } from "../core/storage/settings";
import { mergeCustomModels, addCustomModel, removeCustomModel, customNamesFor } from "../core/llm/custom-models";
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
import { PersonaManager } from "./PersonaManager";
import { ComputerUseSettings } from "./ComputerUseSettings";
import { WechatSettings } from "./WechatSettings";
import { PhoneLinkSettings } from "./PhoneLinkSettings";
import { applyUiFontScale, applyStoredUiFont, FONT_BASE_PX } from "../core/ui-font";
// P2 #34: Import reusable settings components
import { SettingsNav, ConfigEntry, ToggleEntry } from "./SettingsParts";
// P2 #35: Import UsageStats for embedding in settings
import { UsageStats } from "./UsageStats";
import { PerformanceDashboard } from "./PerformanceDashboard";
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
  BrainCircuit,
  MousePointer2,
  MessageCircle,
  Smartphone,
  PawPrint,
  Zap,
  HelpCircle,
  Key,
  Terminal,
  CheckCircle,
  Activity,
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
import { ActionIcons } from "../core/icons/icon-map";

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
  // 第 56 波：默认字号必须等于 `--fs-*` 的缩放基准（13px）。
  // 此前这里是 14、而启动不应用字号 → 打开设置瞬间把全站放大 14/13 ≈ 7.7%，且关掉设置也不回退。
  fontSize: FONT_BASE_PX,
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
  // 手动添加模型名（服务器列表外的内测/测试模型）—— 每个 provider 一个输入草稿
  const [customModelDrafts, setCustomModelDrafts] = useState<Record<string, string>>({});
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

    // D1: 打开设置时确保字号与**启动时一致** —— 共用 ui-font 的同一个解析器。
    // 这里顺带把滑杆显示的值也统一成解析结果：旧版本把默认字号 14 一起写进了设置对象，
    // 于是"滑杆显示 14、界面按 13 渲染"这种不一致也要一并消除（见 core/ui-font.ts 的归一规则）。
    // 此前这里直接应用 parsed.fontSize（默认 14），而启动路径读的是旧扁平键 → 打开设置就跳字。
    const appliedPx = applyStoredUiFont();
    setSettings((prev) => ({ ...prev, fontSize: appliedPx }));

    // Load dynamically fetched models from DB cache
    try {
      const stored = getSettingJSON<Record<string, Array<{ id: string; name: string; contextWindow?: number }>>>("codem-dynamic-models", {});
      if (stored && Object.keys(stored).length > 0) {
        // 合并手动添加的自定义模型（服务器列表外），与 engine.loadDynamicModels 保持一致
        setDynamicModels(mergeCustomModels(stored));
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
const [activeTab, setActiveTab] = useState<"general" | "appearance" | "security" | "git" | "environment" | "worktree" | "knowledge" | "automation" | "multimodal" | "voice" | "ollama" | "pet" | "tools" | "persona" | "computer" | "wechat" | "phone" | "codegraph" | "advanced" | "help" | "usage" | "performance">((initialTab as any) || "general");
  // P2 #36: Settings search — D2 修复：占位搜索框现在真正过滤/跳转设置分组
  const [settingsSearch, setSettingsSearch] = useState("");
  const [advancedSubTab, setAdvancedSubTab] = useState<"agents" | "heartbeat" | "retry" | "prompt" | "settings" | "recovery" | "correction" | "profiles" | "transcript">("agents");
  const [showPetMarket, setShowPetMarket] = useState(false);

  // D2: 设置分组搜索元数据（id → [中文名, 英文名, 别名...]）
  const SETTINGS_TAB_INDEX: Array<[string, string[]]> = [
    ["general", ["通用", "general", "模式", "语言", "账号"]],
    ["appearance", ["外观", "appearance", "主题", "皮肤", "字体", "字号", "font", "皮肤", "背景"]],
    ["security", ["安全", "security", "权限", "模式"]],
    ["git", ["Git", "仓库", "提交"]],
    ["environment", ["环境", "environment", "worktree", "工作树"]],
    ["worktree", ["工作树", "worktree"]],
    ["knowledge", ["知识", "knowledge", "笔记本", "记忆"]],
    ["automation", ["自动化", "automation"]],
    ["multimodal", ["多模态", "multimodal", "图片", "视觉"]],
    ["voice", ["语音", "voice", "tts", "朗读"]],
    ["ollama", ["Ollama", "本地模型"]],
    ["pet", ["宠物", "pet", "桌宠"]],
    ["tools", ["工具", "tools", "终端"]],
    ["persona", ["人设", "persona", "人格", "角色", "soul"]],
    ["computer", ["电脑操作", "computer", "读屏", "鼠标", "自动化"]],
    ["wechat", ["微信", "wechat", "clawbot", "桥", "绑定", "手机"]],
    ["phone", ["连接手机", "phone", "手机", "LAN", "配对", "扫码"]],
    ["codegraph", ["代码图谱", "codegraph", "graph"]],
    ["advanced", ["高级", "advanced", "实验", "分层"]],
    ["help", ["帮助", "help", "关于", "教程"]],
    ["usage", ["用量统计", "usage", "费用", "token", "限额"]],
    ["performance", ["性能", "performance", "指标"]],
  ];
  // 由搜索词过滤出的匹配 tab（空 = 全部显示）
  const searchFilteredTabs = useMemo(() => {
    const q = settingsSearch.trim().toLowerCase();
    if (!q) return SETTINGS_TAB_INDEX.map(([id]) => id);
    return SETTINGS_TAB_INDEX
      .filter(([, words]) => words.some((w) => w.toLowerCase().includes(q)))
      .map(([id]) => id);
  }, [settingsSearch]);
  // 搜索时自动跳到第一个匹配分组（若当前分组不再匹配）
  useEffect(() => {
    const q = settingsSearch.trim().toLowerCase();
    if (!q) return;
    const first = searchFilteredTabs[0];
    if (first && first !== activeTab) setActiveTab(first as any);
  }, [settingsSearch, searchFilteredTabs]);
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

  /** 手动添加服务器列表外的模型（内测/测试模型，如 deepseek-v4.1-flash-expires-on-0910）。
   *  自定义模型存 codem-custom-models；不写入服务器缓存 codem-dynamic-models，
   *  由展示/引擎加载时 mergeCustomModels 合并，删除即移除。 */
  const handleAddCustomModel = (providerId: string) => {
    const draft = (customModelDrafts[providerId] || "").trim();
    if (!draft) return;
    const added = addCustomModel(providerId, draft);
    setCustomModelDrafts((prev) => ({ ...prev, [providerId]: "" }));
    if (!added) {
      setRefreshStatus((prev) => ({ ...prev, [providerId]: "该模型已存在" }));
      return;
    }
    // 同步合并进当前动态模型视图（✓ 计数即时更新）
    setDynamicModels((prev) => mergeCustomModels(prev || {}));
    setRefreshStatus((prev) => ({ ...prev, [providerId]: "" }));
    // 通知引擎重载：模型选择器/方案立即可用
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const handleRemoveCustomModel = (providerId: string, name: string) => {
    removeCustomModel(providerId, name);
    // 重建视图 = 服务器缓存 + 剩余自定义（不基于 prev filter，
    // 避免服务器列表本身含同名模型时被误滤）
    try {
      const cached = getSettingJSON<Record<string, Array<{ id: string; name: string; contextWindow?: number }>>>("codem-dynamic-models", {});
      setDynamicModels(mergeCustomModels(cached));
    } catch (e) { console.warn('[SettingsPanel] rebuild models after remove:', e) }
    window.dispatchEvent(new Event("codem-settings-changed"));
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
          <button className="settings-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="settings-body">
          <div className="settings-sidebar">
            {/* P2 #36: Settings search */}
            <div className="settings-search-box settings-search-box--bordered">
              <div className="sp-search">
                <SearchIcon size={14} className="sp-search-icon" />
                <input
                  type="text"
                  placeholder={lang === "zh" ? "搜索设置..." : "Search settings..."}
                  value={settingsSearch}
                  onChange={(e) => setSettingsSearch(e.target.value)}
                  className="sp-search-input"
                />
                {settingsSearch && <button onClick={() => setSettingsSearch("")} className="sp-btn--icon sp-btn"><X size={12} /></button>}
              </div>
              {settingsSearch.trim() && (
                <div className="sp-search-status">
                  {searchFilteredTabs.length > 0
                    ? (lang === "zh"
                      ? `已跳转至「${SETTINGS_TAB_INDEX.find(([id]) => id === searchFilteredTabs[0])?.[1]?.[0] || searchFilteredTabs[0]}」设置`
                      : `Jumped to "${searchFilteredTabs[0]}" settings`)
                    : (lang === "zh" ? "未找到匹配的设置分组" : "No matching settings group")}
                </div>
              )}
            </div>
            <button className={`settings-sidebar-item ${activeTab === "general" ? "active" : ""}`}
              aria-current={activeTab === "general" ? "page" : undefined} onClick={() => setActiveTab("general")}>
              <span className="sidebar-icon"><SettingsIcon size={16} /></span>{lang === "zh" ? "通用" : "General"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "appearance" ? "active" : ""}`}
              aria-current={activeTab === "appearance" ? "page" : undefined} onClick={() => setActiveTab("appearance")}>
              <span className="sidebar-icon"><Palette size={16} /></span>{lang === "zh" ? "外观" : "Appearance"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "security" ? "active" : ""}`}
              aria-current={activeTab === "security" ? "page" : undefined} onClick={() => setActiveTab("security")}>
              <span className="sidebar-icon"><Shield size={16} /></span>{lang === "zh" ? "安全" : "Security"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "git" ? "active" : ""}`}
              aria-current={activeTab === "git" ? "page" : undefined} onClick={() => setActiveTab("git")}>
              <span className="sidebar-icon"><GitBranchIcon size={16} /></span>{lang === "zh" ? "Git" : "Git"}
            </button>
<button className={`settings-sidebar-item ${activeTab === "environment" ? "active" : ""}`}
              aria-current={activeTab === "environment" ? "page" : undefined} onClick={() => setActiveTab("environment")}>
<span className="sidebar-icon"><Server size={16} /></span>{lang === "zh" ? "环境" : "Environment"}
</button>
<button className={`settings-sidebar-item ${activeTab === "worktree" ? "active" : ""}`}
              aria-current={activeTab === "worktree" ? "page" : undefined} onClick={() => setActiveTab("worktree")}>
<span className="sidebar-icon"><FolderTree size={16} /></span>{lang === "zh" ? "工作树" : "Worktree"}
</button>
<button className={`settings-sidebar-item ${activeTab === "knowledge" ? "active" : ""}`}
              aria-current={activeTab === "knowledge" ? "page" : undefined} onClick={() => setActiveTab("knowledge")}>
<span className="sidebar-icon"><BookOpenIcon size={16} /></span>{lang === "zh" ? "知识" : "Knowledge"}
</button>
<button className={`settings-sidebar-item ${activeTab === "automation" ? "active" : ""}`}
              aria-current={activeTab === "automation" ? "page" : undefined} onClick={() => setActiveTab("automation")}>
<span className="sidebar-icon"><Bot size={16} /></span>{lang === "zh" ? "自动化" : "Automation"}
</button>
<button className={`settings-sidebar-item ${activeTab === "multimodal" ? "active" : ""}`}
              aria-current={activeTab === "multimodal" ? "page" : undefined} onClick={() => setActiveTab("multimodal")}>
<span className="sidebar-icon"><Layers size={16} /></span>{lang === "zh" ? "多模态" : "Multimodal"}
</button>
<button className={`settings-sidebar-item ${activeTab === "voice" ? "active" : ""}`}
              aria-current={activeTab === "voice" ? "page" : undefined} onClick={() => setActiveTab("voice")}>
<span className="sidebar-icon"><Mic size={16} /></span>{lang === "zh" ? "语音" : "Voice"}
</button>
<button className={`settings-sidebar-item ${activeTab === "ollama" ? "active" : ""}`}
              aria-current={activeTab === "ollama" ? "page" : undefined} onClick={() => setActiveTab("ollama")}>
<span className="sidebar-icon"><Server size={16} /></span>{lang === "zh" ? "Ollama" : "Ollama"}
</button>
            <button className={`settings-sidebar-item ${activeTab === "tools" ? "active" : ""}`}
              aria-current={activeTab === "tools" ? "page" : undefined} onClick={() => setActiveTab("tools")}>
              <span className="sidebar-icon"><Wrench size={16} /></span>{lang === "zh" ? "工具" : "Tools"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "persona" ? "active" : ""}`}
              aria-current={activeTab === "persona" ? "page" : undefined} onClick={() => setActiveTab("persona")}>
              <span className="sidebar-icon"><BrainCircuit size={16} /></span>{lang === "zh" ? "人设" : "Persona"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "computer" ? "active" : ""}`}
              aria-current={activeTab === "computer" ? "page" : undefined} onClick={() => setActiveTab("computer")}>
              <span className="sidebar-icon"><MousePointer2 size={16} /></span>{lang === "zh" ? "电脑操作" : "Computer Use"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "wechat" ? "active" : ""}`}
              aria-current={activeTab === "wechat" ? "page" : undefined} onClick={() => setActiveTab("wechat")}>
              <span className="sidebar-icon"><MessageCircle size={16} /></span>{lang === "zh" ? "微信 ClawBot" : "WeChat ClawBot"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "phone" ? "active" : ""}`}
              aria-current={activeTab === "phone" ? "page" : undefined} onClick={() => setActiveTab("phone")}>
              <span className="sidebar-icon"><Smartphone size={16} /></span>{lang === "zh" ? "连接手机" : "Phone Link"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "codegraph" ? "active" : ""}`}
              aria-current={activeTab === "codegraph" ? "page" : undefined} onClick={() => setActiveTab("codegraph")}>
              <span className="sidebar-icon"><Network size={16} /></span>{lang === "zh" ? "代码图谱" : "CodeGraph"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "pet" ? "active" : ""}`}
              aria-current={activeTab === "pet" ? "page" : undefined} onClick={() => setActiveTab("pet")}>
              <span className="sidebar-icon"><PawPrint size={16} /></span>{lang === "zh" ? "宠物" : "Pet"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "advanced" ? "active" : ""}`}
              aria-current={activeTab === "advanced" ? "page" : undefined} onClick={() => setActiveTab("advanced")}>
              <span className="sidebar-icon"><Zap size={16} /></span>{lang === "zh" ? "高级" : "Advanced"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "help" ? "active" : ""}`}
              aria-current={activeTab === "help" ? "page" : undefined} onClick={() => setActiveTab("help")}>
              <span className="sidebar-icon"><HelpCircle size={16} /></span>{lang === "zh" ? "帮助" : "Help"}
            </button>
            {/* P2 #35: Usage stats tab */}
            <button className={`settings-sidebar-item ${activeTab === "usage" ? "active" : ""}`}
              aria-current={activeTab === "usage" ? "page" : undefined} onClick={() => setActiveTab("usage")}>
              <span className="sidebar-icon"><Zap size={16} /></span>{lang === "zh" ? "用量统计" : "Usage"}
            </button>
            {/* 性能面板：从主对话区域顶部 tab 移入设置 */}
            <button className={`settings-sidebar-item ${activeTab === "performance" ? "active" : ""}`}
              aria-current={activeTab === "performance" ? "page" : undefined} onClick={() => setActiveTab("performance")}>
              <span className="sidebar-icon"><Activity size={16} /></span>{lang === "zh" ? "性能" : "Performance"}
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
              <div className="sp-text sp-text--secondary sp-hint--lead">
                登录小米账号，mimo-v2.5-pro 模型免费
              </div>

              {mimoAccount ? (
                <div className="sp-card--secondary sp-card--between sp-card sp-text">
                  <span className="sp-row--gap-tight sp-row"><CheckCircle size={14} className="sp-icon-success" /> 已登录</span>
                  <button
                    onClick={handleLogout}
                    className="sp-btn sp-btn--sm"
                  >
                    登出
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleLogin}
                  disabled={loginStatus === "loading"}
                  className="sp-btn sp-btn--lg sp-btn--block sp-btn--primary"
                >
                  {loginStatus === "loading" ? "正在打开浏览器..." : <span className="sp-row sp-row--gap-sm"><LogIn size={16} /> 登录小米账号</span>}
                </button>
              )}

              {loginStatus === "error" && (
                <div className="sp-hint sp-hint--error sp-hint--spaced">
                  {loginError}
                </div>
              )}

              <div className="sp-hint sp-hint--spaced">
                点击后会打开浏览器，在浏览器中完成授权即可。
              </div>

              <button
                onClick={runLoginTest}
                className="sp-btn sp-btn--sm sp-btn--block sp-btn--secondary"
              >
                <span className="sp-row sp-row--gap-sm"><SearchIcon size={14} /> 运行登录测试</span>
              </button>

              {testResult && (
                <pre className="sp-output sp-output--page">
                  {testResult}
                </pre>
              )}
            </div>
          )}

          <div className="setting-group">
            <label>{S.settings.model[lang]}</label>
            <div className="sp-row">
              <select
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                className="sp-select-flex"
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
                className="sp-btn sp-btn--secondary sp-btn--nowrap"
              >
                {lang === "zh" ? <span className="sp-row--gap-tight sp-row"><SettingsIcon size={14} /> 配置方案</span> : <span className="sp-row--gap-tight sp-row"><SettingsIcon size={14} /> Profiles</span>}
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
              onChange={(e) => {
                const px = parseInt(e.target.value);
                const next = { ...settings, fontSize: px };
                setSettings(next);
                // D1: 立即生效 —— 写 CSS 变量（基准 13px → scale）+ 落盘 + 广播
                applyUiFontScale(px);
                setSettingJSON("codem-settings", next);
                setSetting("codem-font-size", String(px));
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
            />
            <span>{settings.fontSize}px</span>
          </div>

          <div className="setting-group">
            <label>{lang === "zh" ? "字体粗细 (wght)" : "Font Weight (wght)"}</label>
            <div className="sp-row sp-row--gap-wide">
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
                className="sp-flex-fill"
              />
              <span className="sp-weight-value" style={{ fontWeight: Number(fontWeight) }}>
                {fontWeight}
              </span>
            </div>
            <div className="sp-hint sp-hint--spaced">
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
              className="sp-select"
            >
              <option value="unified">{lang === "zh" ? "统一模式（多轮回复合并为一个气泡）" : "Unified (merge multi-turn replies)"}</option>
              <option value="segmented">{lang === "zh" ? "分段模式（每轮回复独立显示）" : "Segmented (each reply separate)"}</option>
            </select>
            <div className="sp-hint sp-hint--tiny">
              {lang === "zh" ? "统一模式：AI 的多轮回复合并为一个连续气泡，阅读更连贯" : "Unified: merges AI multi-turn replies into one continuous bubble"}
            </div>
          </div>

</>
          )}
          {activeTab === "security" && (
          <>
          {/* Security Mode — three-tier approval policy */}
          <div className="setting-group">
            <label className="sp-row sp-row--gap-sm">{lang === "zh" ? <><Shield size={16} /> 安全策略</> : <><Shield size={16} /> Security Policy</>}</label>
            <div className="sp-note sp-hint--lead">
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
              className="sp-select--inherit"
            >
              <option value="AlimamaFangYuanTi">Alimama 方圆体 (默认)</option>
              <option value="Inter, sans-serif">Inter</option>
              <option value="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">System Default</option>
              <option value="'Courier New', monospace">Courier New</option>
              <option value="Georgia, serif">Georgia</option>
            </select>
            <div className="sp-hint sp-hint--tiny">
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
            <div className="sp-row sp-row--gap-md sp-row--lead">
              <div className="user-avatar-preview">
                {userConfig.avatar ? (
                  <img src={userConfig.avatar} alt="avatar" className="sp-avatar-img" />
                ) : (
                  <User size={24} className="sp-icon-muted" />
                )}
              </div>
              <div className="sp-row sp-row--wrap">
                <button
                  onClick={() => document.getElementById("avatar-upload-input")?.click()}
                  className="sp-btn sp-btn--secondary"
                >
                  {lang === "zh" ? "上传头像" : "Upload"}
                </button>
                {userConfig.avatar && (
                  <button
                    onClick={() => setUserConfig({ ...userConfig, avatar: "" })}
                    className="sp-btn sp-btn--secondary"
                  >
                    {lang === "zh" ? "清除" : "Clear"}
                  </button>
                )}
              </div>
              <input
                id="avatar-upload-input"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                className="sp-hidden"
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
            <div className="preset-avatar-grid">
              {PRESET_AVATARS.map((url) => (
                <button
                  key={url}
                  onClick={() => setUserConfig({ ...userConfig, avatar: url })}
                  className={`sp-avatar--sm sp-avatar ${userConfig.avatar === url ? "is-active" : ""}`}
                >
                  <img src={url} alt="preset" className="sp-avatar-img" />
                </button>
              ))}
            </div>
            <div className="sp-hint sp-hint--spaced">
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
                    className="sp-input--title"
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
                    className="sp-btn sp-btn--icon"
                  >
                    <Trash2 size={14} />
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

              <div className="setting-group sp-row sp-row--wrap">
                <button
                  onClick={() => refreshProviderModels(provider.id)}
                  disabled={refreshingModels[provider.id]}
                  className={`sp-btn sp-btn--sm ${refreshingModels[provider.id] ? "sp-btn--busy" : "sp-btn--primary"}`}
                >
                  {refreshingModels[provider.id] ? "获取中..." : "刷新模型列表"}
                </button>
                {refreshStatus[provider.id] && (
                  <span className="hint-sm">
                    {refreshStatus[provider.id]}
                  </span>
                )}
                {dynamicModels[provider.id] && dynamicModels[provider.id].length > 0 && !refreshStatus[provider.id] && (
                  <span className="hint-sm">
                    ✓ {dynamicModels[provider.id].length} 个动态模型
                  </span>
                )}
              </div>

              {/* 手动添加服务器列表外的模型：内测/测试模型（调用方式与同 provider 其它模型一致，仅模型名不同） */}
              <div className="setting-group sp-row sp-row--gap-sm sp-row--wrap">
                <input
                  type="text"
                  value={customModelDrafts[provider.id] || ""}
                  onChange={(e) => setCustomModelDrafts((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                  placeholder={lang === "zh"
                    ? "手动添加模型名（服务器列表外的内测模型，如 deepseek-xxx-expires-on-0910）"
                    : "Add model name not in server list (e.g. deepseek-xxx-expires-on-0910)"}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddCustomModel(provider.id); }}
                  className="sp-input sp-input--inline"
                />
                <button
                  onClick={() => handleAddCustomModel(provider.id)}
                  disabled={!(customModelDrafts[provider.id] || "").trim()}
                  className="sp-btn sp-btn--primary sp-btn--nowrap"
                >
                  {lang === "zh" ? "添加模型" : "Add Model"}
                </button>
                {customNamesFor(provider.id).length > 0 && (
                  <div className="sp-row sp-row--gap-tight sp-row--wrap sp-row--full">
                    <span className="sp-mini">
                      {lang === "zh" ? "自定义：" : "Custom: "}
                    </span>
                    {customNamesFor(provider.id).map((nm) => (
                      <span
                        key={nm}
                        title={nm}
                        className="sp-chip"
                      >
                        <span className="sp-ellipsis">{nm}</span>
                        <button
                          onClick={() => handleRemoveCustomModel(provider.id, nm)}
                          title={lang === "zh" ? "移除" : "Remove"}
                          className="sp-btn sp-btn--icon sp-btn--flush"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
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
                className="sp-btn sp-btn--sm sp-btn--primary sp-btn--spaced"
              >
                {S.settings.saveRefresh[lang]}
              </button>
            </div>
          ))}

          {/* 通用协议配置：添加自定义 OpenAI-compatible Provider（如 b.ai / 百川智能等） */}
          <div className="provider-group sp-group-dashed">
            {!showAddCustom ? (
              <button
                onClick={() => setShowAddCustom(true)}
                className="sp-btn sp-btn--dashed sp-btn--block"
              >
                <Plus size={14} />
                {lang === "zh" ? "添加自定义 Provider（通用 OpenAI 兼容协议）" : "Add Custom Provider (OpenAI-compatible)"}
              </button>
            ) : (
              <div className="sp-col">
                <div className="sp-note sp-note--tight">
                  {lang === "zh"
                    ? "输入任意 OpenAI 兼容服务的 Base URL 和 API Key，点击保存后可从服务商拉取模型列表（如 b.ai: https://api.baichuan-ai.com/v1）。"
                    : "Enter any OpenAI-compatible service Base URL and API Key. After saving, the model list can be fetched from the provider (e.g. b.ai: https://api.baichuan-ai.com/v1)."}
                </div>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={lang === "zh" ? "Provider 名称（如 b.ai）" : "Provider name (e.g. b.ai)"}
                  className="sp-input"
                />
                <input
                  type="text"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder={lang === "zh" ? "Base URL（如 https://api.baichuan-ai.com/v1）" : "Base URL (e.g. https://api.baichuan-ai.com/v1)"}
                  className="sp-input sp-input--compact"
                />
                <input
                  type="password"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder={lang === "zh" ? "API Key" : "API Key"}
                  className="sp-input sp-input--compact"
                />
                <div className="sp-row">
                  <button
                    onClick={addCustomProvider}
                    disabled={!customName.trim() || !customBaseUrl.trim()}
                    className="sp-btn sp-btn--lg sp-btn--primary"
                  >
                    {lang === "zh" ? "保存 Provider" : "Save Provider"}
                  </button>
                  <button
                    onClick={() => { setShowAddCustom(false); setCustomName(""); setCustomBaseUrl(""); setCustomApiKey(""); }}
                    className="sp-btn sp-btn--lg"
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
            <div className="sp-note sp-note--spaced">
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
            <label><Palette size={14} className="icon-inline-gap" />{lang === "zh" ? "多模态能力" : "Multimodal"}</label>
            <div className="sp-note sp-hint--lead">
              {lang === "zh"
                ? "配置 Embedding 语义搜索、TTS 语音合成、ImageGen 图像生成。"
                : "Configure Embedding semantic search, TTS text-to-speech, and ImageGen image generation."}
            </div>
            <button
              onClick={() => setShowMultimodal(!showMultimodal)}
              className={`sp-btn sp-btn--lg sp-btn--block sp-row--between ${showMultimodal ? "is-active" : ""}`}
            >
              <span>{lang === "zh" ? <><Palette size={12} className="icon-inline" /> 多模态设置</> : <><Palette size={12} className="icon-inline" /> Multimodal Settings</>}</span>
              <span className="hint-sm">{showMultimodal ? '▼' : '▶'}</span>
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
<div className="sp-placeholder">
  <div className="sp-placeholder-text">
    {lang === "zh" ? "自动化任务已移至任务管理面板。" : "Automation tasks have moved to Task Center."}
  </div>
  <div className="hint-sm">
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
{activeTab === "persona" && (
<>
{/* B2 Persona cards management (对标 EAC soul-md) */}
<PersonaManager onClose={() => {}} />
</>
)}
{activeTab === "computer" && (
<>
{/* computer-use 电脑操作设置（对标 EAC computer-user） */}
<ComputerUseSettings />
</>
)}
{activeTab === "wechat" && (
<>
{/* 微信 ClawBot 桥设置（对标 EAC/OpenClaw 微信通道） */}
<WechatSettings />
</>
)}
{activeTab === "phone" && (
<>
{/* 手机连接设置（对标 dsh-phone） */}
<PhoneLinkSettings />
</>
)}
{activeTab === "advanced" && (
<>
{/* Advanced Settings with sub-tabs */}
<div className="sp-row sp-row--gap-tight sp-row--wrap sp-row--lead">
  {[
    { id: "agents", label: lang === "zh" ? "智能体" : "Agents", icon: <Bot size={12} className="icon-inline" /> },
    { id: "heartbeat", label: lang === "zh" ? "心跳" : "Heartbeat", icon: <HeartPulse size={12} className="icon-inline" /> },
    { id: "retry", label: lang === "zh" ? "重试" : "Retry", icon: <RotateCcw size={12} className="icon-inline" /> },
    { id: "prompt", label: lang === "zh" ? "提示词" : "Prompt", icon: <FileText size={12} className="icon-inline" /> },
    { id: "settings", label: lang === "zh" ? "分层设置" : "Layered", icon: <Layers size={12} className="icon-inline" /> },
    { id: "correction", label: lang === "zh" ? "纠偏模型" : "Correction", icon: <SearchIcon size={12} className="icon-inline" /> },
    { id: "profiles", label: "Agent Profile", icon: <User size={12} className="icon-inline" /> },
    { id: "transcript", label: lang === "zh" ? "缓存统计" : "Cache", icon: <MessageSquare size={12} className="icon-inline" /> },
    { id: "recovery", label: lang === "zh" ? "恢复" : "Recovery", icon: <RotateCcw size={12} className="icon-inline" /> },
  ].map(tab => (
    <button
      key={tab.id}
      onClick={() => setAdvancedSubTab(tab.id as any)}
      className={`sp-tab ${advancedSubTab === tab.id ? "is-active" : ""}`}
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
  <div className="sp-card sp-card--col">
    <h3 className="sp-title">{lang === "zh" ? "纠偏模型配置" : "Correction Model Config"}</h3>
    <p className="sp-hint sp-hint--relaxed">
      {lang === "zh" ? "配置 fact_check 事实核查使用的专属纠偏模型。保存后立即生效；未配置时自动回退使用当前主模型并如实标注。" : "Configure the dedicated model used by fact_check. Takes effect once saved; when unset, falls back to the main model with an honest note."}
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
  <div className="sp-card sp-card--col sp-card--narrow">
    <h3 className="sp-title sp-title--lg">{lang === "zh" ? "帮助" : "Help"}</h3>
    
    <div className="setting-group">
      <label className="sp-label-md">{lang === "zh" ? "新手引导" : "Onboarding Tour"}</label>
      <p className="sp-hint sp-hint--relaxed sp-note--spaced">
        {lang === "zh" ? "重新查看应用功能引导教程。" : "Replay the app feature tour."}
      </p>
      <button
        onClick={() => {
          setSetting("onboarding-completed", "");
          setShowOnboardingReplay?.(true);
        }}
        className="sp-btn sp-btn--lg sp-btn--primary"
      >
        {lang === "zh" ? <><Play size={12} className="icon-inline" /> 重新播放新手引导</> : <><Play size={12} className="icon-inline" /> Replay Onboarding Tour</>}
      </button>
    </div>

    <div className="setting-group">
      <label className="sp-label-md">{lang === "zh" ? "快捷键" : "Keyboard Shortcuts"}</label>
      <div className="sp-note sp-shortcuts">
        <div><kbd>Ctrl + K</kbd> — {lang === "zh" ? "搜索对话" : "Search chat"}</div>
        <div><kbd>Ctrl + B</kbd> — {lang === "zh" ? "切换侧边栏" : "Toggle sidebar"}</div>
        <div><kbd>Esc</kbd> — {lang === "zh" ? "关闭弹窗/取消" : "Close dialog/cancel"}</div>
        <div><kbd>/</kbd> — {lang === "zh" ? "技能选择" : "Skill selector"}</div>
      </div>
    </div>

    <div className="setting-group">
      <label className="sp-label-md">{lang === "zh" ? "关于" : "About"}</label>
      <div className="sp-hint sp-hint--relaxed-16">
        Codem (mimo-gui) v{APP_VERSION}
        <br />
        {lang === "zh" ? "AI 编程助手 — 本地优先，隐私安全" : "AI Coding Assistant — Local-first, Privacy-focused"}
      </div>
      <button
        id="check-update-btn"
        className="sp-btn sp-btn--primary sp-btn--spaced"
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
  <div className="sp-card">
    <UsageStats onClose={() => setActiveTab("general")} />
  </div>
)}
{activeTab === "performance" && (
  <div className="sp-card">
    <PerformanceDashboard onClose={() => setActiveTab("general")} />
  </div>
)}
          </div>
        </div>

        <div className="settings-footer">
          {onSessionRecovery && (
            <button
              className="save-btn sp-btn-auto"
              onClick={onSessionRecovery}
            >
              {S.settings.sessionRecovery[lang]}
            </button>
          )}
          {onUsageStats && (
            <button
              className="save-btn sp-btn-mr"
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
    <div className="sp-col sp-col--lg">
      {/* 启用开关 */}
      <div className="settings-row">
        <div>
          <div className="sp-title--md">
            {zh ? "启用桌面宠物" : "Enable Desktop Pet"}
          </div>
          <div className="sp-note sp-note--spaced">
            {zh ? "在窗口右下角显示宠物，它会响应 Agent 的工作状态" : "Show a pet in the bottom-right corner that reacts to Agent activity"}
          </div>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`sp-toggle ${enabled ? "is-on" : ""}`}
        >
          <span className="sp-toggle-knob" />
        </button>
      </div>

      {/* 宠物市场按钮 */}
      <div className="sp-card--lg sp-card--between sp-card">
        <div>
          <div className="sp-title--sm">
            {zh ? "宠物市场" : "Pet Market"}
          </div>
          <div className="sp-hint--xs sp-note--spaced">
            {zh ? "从 Petdex 浏览和下载更多宠物" : "Browse and download more pets from Petdex"}
          </div>
        </div>
        <button
          onClick={onOpenMarket}
          className="sp-btn sp-btn--lg sp-btn--primary"
        >
          🐾 {zh ? "浏览市场" : "Browse Market"}
        </button>
      </div>

      {/* 已安装宠物列表 */}
      <div>
        <div className="sp-title--md sp-title--lead">
          {zh ? "已安装宠物" : "Installed Pets"} ({installedPets.length})
        </div>
        {installedPets.length === 0 ? (
          <div className="sp-empty">
            {zh ? "暂无已安装的宠物，去市场看看吧~" : "No pets installed yet. Check out the market!"}
          </div>
        ) : (
          <div className="sp-col">
            {installedPets.map((pet) => (
              <div
                key={pet.slug}
                className={`sp-pet-row ${activePet?.slug === pet.slug ? "is-active" : ""}`}
              >
                <div className="sp-flex-fill">
                  <div className="sp-title--sm">
                    {pet.definition.name}
                    {activePet?.slug === pet.slug && (
                      <span className="sp-active-dot">● {zh ? "当前" : "Active"}</span>
                    )}
                  </div>
                  <div className="sp-hint--xs">
                    {pet.definition.description || pet.definition.author || pet.slug}
                  </div>
                </div>
                <div className="sp-row sp-row--gap-xs">
                  {activePet?.slug !== pet.slug && (
                    <button
                      onClick={() => setActivePet(pet.slug)}
                      className="sp-btn sp-btn--sm sp-btn--ghost"
                    >
                      {zh ? "激活" : "Activate"}
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      await uninstallPet(pet.slug);
                      await refreshInstalledPets();
                    }}
                    className="sp-btn sp-btn--sm sp-btn--danger"
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
        <div className="sp-slider-row">
          <span className="sp-slider-label">{zh ? "宠物大小" : "Pet Size"}</span>
          <span className="sp-slider-value">{Math.round(scale * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.15"
          max="1.5"
          step="0.05"
          value={scale}
          onChange={(e) => setScale(parseFloat(e.target.value))}
          className="sp-range-full"
        />
        <div className="sp-slider-hint">
          <span>{zh ? "小" : "Small"}</span>
          <span>{zh ? "大" : "Large"}</span>
        </div>
      </div>

      {/* 其他显示设置 — 仅启用且有激活宠物时可见 */}
      {enabled && activePet && (
        <>
          {/* 透明度 */}
          <div>
            <div className="sp-slider-row">
              <span className="sp-slider-label">{zh ? "透明度" : "Opacity"}</span>
              <span className="sp-slider-value">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.3"
              max="1.0"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              className="sp-range-full"
            />
          </div>

          {/* 位置 X */}
          <div>
            <div className="sp-slider-row">
              <span className="sp-slider-label">{zh ? "水平位置" : "Position X"}</span>
              <span className="sp-slider-value">{positionX}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="400"
              step="4"
              value={positionX}
              onChange={(e) => handlePosChange("x", parseInt(e.target.value))}
              className="sp-range-full"
            />
          </div>

          {/* 位置 Y */}
          <div>
            <div className="sp-slider-row">
              <span className="sp-slider-label">{zh ? "垂直位置" : "Position Y"}</span>
              <span className="sp-slider-value">{positionY}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="300"
              step="4"
              value={positionY}
              onChange={(e) => handlePosChange("y", parseInt(e.target.value))}
              className="sp-range-full"
            />
          </div>

          {/* 提示 */}
          <div className="sp-callout">
            <Lightbulb size={12} className="icon-inline" /> {zh ? "提示：可以直接拖拽窗口中的宠物来移动位置。空闲时点击宠物有彩蛋。" : "Tip: Drag the pet in the window to reposition. Click the pet when idle for a surprise."}
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
      <div className="sp-note sp-hint--lead">
        {zh
          ? "自定义工具权限规则。规则按顺序匹配，最后匹配的规则生效。内置规则（受保护路径、危险命令）始终生效。"
          : "Custom tool permission rules. Rules are matched in order, last match wins. Built-in rules (protected paths, dangerous commands) always apply."}
      </div>

      {/* Existing custom rules */}
      {customRules.length > 0 && (
        <div className="sp-check-row">
          {customRules.map((rule, i) => (
            <div
              key={i}
              className="sp-rule-row"
            >
              <span className="sp-mono-auto">
                {rule.tool}
              </span>
              {rule.resource && (
                <>
                  <span className="sp-muted">→</span>
                  <span className="sp-mono-auto sp-mono-auto--secondary">
                    {rule.resource}
                  </span>
                </>
              )}
              <span className="sp-rule-action" style={{ color: actionColors[rule.action] }}>
                {actionLabels[rule.action]}
              </span>
              <button
                onClick={() => handleRemove(i)}
                className="sp-btn sp-btn--icon sp-btn--icon-text"
                title={zh ? "删除" : "Delete"}
                aria-label={zh ? "删除" : "Delete"}
              >
                <ActionIcons.delete size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {customRules.length === 0 && (
        <div className="sp-hint sp-hint--italic">
          {zh ? "暂无自定义规则" : "No custom rules"}
        </div>
      )}

      {/* Add new rule */}
      <div
        className="sp-rule-form"
      >
        <div className="sp-flex-fill">
          <label className="sp-field-label">
            {zh ? "工具名 (支持 * 通配)" : "Tool (supports * wildcard)"}
          </label>
          <input
            type="text"
            value={newRule.tool}
            onChange={(e) => setNewRule({ ...newRule, tool: e.target.value })}
            placeholder="bash / write / *"
            className="sp-input sp-input--mono"
          />
        </div>
        <div className="sp-flex-fill">
          <label className="sp-field-label">
            {zh ? "资源匹配 (可选)" : "Resource (optional)"}
          </label>
          <input
            type="text"
            value={newRule.resource || ""}
            onChange={(e) => setNewRule({ ...newRule, resource: e.target.value })}
            placeholder="rm -rf* / **/.env"
            className="sp-input sp-input--mono"
          />
        </div>
        <div className="sp-auto">
          <label className="sp-field-label">
            {zh ? "动作" : "Action"}
          </label>
          <select
            value={newRule.action}
            onChange={(e) => setNewRule({ ...newRule, action: e.target.value as PermissionAction })}
            className="sp-hint"
          >
            <option value="ask">{zh ? "询问" : "Ask"}</option>
            <option value="allow">{zh ? "允许" : "Allow"}</option>
            <option value="deny">{zh ? "禁止" : "Deny"}</option>
          </select>
        </div>
        <button
          onClick={handleAdd}
          className="sp-btn sp-btn--primary sp-btn--nowrap sp-auto"
        >
          {zh ? "添加" : "Add"}
        </button>
      </div>

      {/* Quick templates */}
      <div className="sp-templates">
        <span className="hint-sm">{zh ? "快速添加: " : "Quick add: "}</span>
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
            className="sp-btn sp-btn--sm"
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
    <div className={`sp-row sp-row--wrap ${compact ? "sp-row--gap-tight" : ""}`}>
      {SECURITY_MODES.map((m) => (
        <button
          key={m.mode}
          onClick={() => onModeChange(m.mode)}
          className={`sp-mode-btn ${compact ? "sp-mode-btn--compact" : ""} ${currentMode === m.mode ? "is-active" : ""}`}
          title={zh ? m.desc_zh : m.desc_en}
        >
          <span className={`sp-mode-icon ${compact ? "sp-mode-icon--compact" : ""}`}>{m.icon}</span>
          <span>{zh ? m.label_zh : m.label_en}</span>
          {!compact && (
            <span className="sp-mode-desc">
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

  const labelStyle = "sp-field-label sp-field-label--strong";
  const inputStyle = "sp-input sp-input--number";

  return (
    <div className="setting-group">
      <label className="sp-label-lg">
        🌲 {zh ? "Git 工作树管理" : "Git Worktree Management"}
      </label>
      <div className="sp-note sp-hint--lead">
        {zh
          ? "管理 Git Worktree 的创建、清理和数量限制。工作树模式为每个任务创建独立的文件系统目录，实现真正的并行隔离。"
          : "Manage Git Worktree creation, cleanup, and limits. Worktree mode creates isolated filesystem directories per task for true parallel isolation."}
      </div>

      {/* Max worktrees */}
      <div className="sp-block-lead">
        <label className={labelStyle}>{zh ? "最大工作树数量" : "Max Worktrees"}</label>
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
          className={inputStyle}
        />
        <span className="sp-hint sp-ml">
          {zh ? "超过此数量自动清理最旧的（默认 15）" : "Auto-clean oldest when exceeded (default 15)"}
        </span>
        {scanResults.length > 0 && (
          <span className={`sp-hint sp-ml-lg ${scanResults.length >= settings.maxWorktrees ? "sp-icon-error" : "sp-icon-success"}`}>
            {zh ? `当前: ${scanResults.length}/${settings.maxWorktrees}` : `Current: ${scanResults.length}/${settings.maxWorktrees}`}
          </span>
        )}
      </div>

      {/* Auto clean oldest */}
      <div className="sp-block-lead">
        <label className="sp-check">
          <input
            type="checkbox"
            checked={settings.autoCleanOldest}
            onChange={(e) => {
              setWorktreeSettings({ autoCleanOldest: e.target.checked });
              setSettings(getWorktreeSettings());
            }}
            className="icon-md"
          />
          <span>{zh ? "自动清理最旧工作树" : "Auto-clean oldest worktrees"}</span>
        </label>
        <div className="sp-hint sp-hint--indent">
          {zh ? "新建工作树时，如果超过上限，自动删除最旧的非活跃工作树。" : "When creating a new worktree, auto-remove the oldest inactive one if limit exceeded."}
        </div>
      </div>

      {/* Warn on dirty */}
      <div className="sp-block-lead">
        <label className="sp-check">
          <input
            type="checkbox"
            checked={settings.warnOnDirty}
            onChange={(e) => {
              setWorktreeSettings({ warnOnDirty: e.target.checked });
              setSettings(getWorktreeSettings());
            }}
            className="icon-md"
          />
          <span>{zh ? "归档前检查未提交修改" : "Warn on uncommitted changes before archive"}</span>
        </label>
        <div className="sp-hint sp-hint--indent">
          {zh ? "删除工作树前检查是否有未提交的代码，有则提示确认。" : "Check for uncommitted changes before deleting a worktree; prompt for confirmation."}
        </div>
      </div>

      <div className="sp-block-sep">
        <div className="sp-row sp-block-lead">
          <label className="sp-field-label sp-field-label--strong sp-label-flush">
            {zh ? "已有工作树" : "Existing Worktrees"}
          </label>
          <button
            onClick={handleScan}
            disabled={scanning || !currentProject?.path}
            className="sp-btn sp-btn--sm"
          >
            {scanning ? <Clock size={12} className="icon-inline" /> : <RotateCcw size={12} className="icon-inline" />} {zh ? "扫描" : "Scan"}
          </button>
        </div>
        {!currentProject?.path && (
          <div className="hint-sm">
            {zh ? "请先选择项目" : "Select a project first"}
          </div>
        )}
        {scanError && (
          <div className="sp-hint sp-hint--error sp-hint--lead">{scanError}</div>
        )}
        {scanResults.length > 0 && (
          <div className="sp-col sp-col--tight">
            {scanResults.map(wt => (
              <div key={wt.sessionId} className="sp-wt-row">
                <span className="sp-mode-icon">{wt.hasUncommitted ? <AlertTriangle size={14} className="sp-icon-warning" /> : <GitBranchIcon size={14} className="sp-icon-success" />}</span>
                <div className="sp-flex-fill sp-min0">
                  <div className="sp-strong">{wt.sessionId}</div>
                  <div className="sp-mini sp-ellipsis sp-dim">{wt.path}</div>
                </div>
                <span className="sp-mini sp-row sp-row--gap-xs sp-dim"><GitBranchIcon size={10} /> {wt.branch}</span>
                {wt.hasUncommitted && (
                  <span className="sp-mini sp-icon-warning">
                    {zh ? "未提交" : "dirty"}
                  </span>
                )}
                <button
                  onClick={() => handleDelete(wt)}
                  className="sp-btn sp-btn--xs sp-btn--danger-ghost"
                >
                  {zh ? "删除" : "Delete"}
                </button>
              </div>
            ))}
          </div>
        )}
        {scanResults.length === 0 && currentProject?.path && !scanning && !scanError && (
          <div className="hint-sm">
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
    borderRadius: "var(--radius-sm)",
    border: '1px solid var(--border-primary)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: 'var(--fs-base)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-secondary)',
    marginBottom: 4,
    display: 'block',
  };

  return (
    <div className="sp-card sp-card--secondary sp-card--mt">
      <div className="settings-section-title sp-title--lead">
        {zh ? '📓 知识笔记本设置' : '📓 Notebook Knowledge Settings'}
      </div>
      <div className="sp-grid-2">
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
      <p className="sp-hint sp-hint--spaced sp-flush">
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
    <div className="sp-card sp-card--col">
      <div className="sp-row--between sp-row">
        <h3 className="sp-title">{zh ? "👤 Agent Profile 管理" : "👤 Agent Profile Management"}</h3>
        <button
          onClick={() => setEditing({ identity: "", domain: "", scope: "" })}
          className="sp-btn sp-btn--sm sp-btn--primary"
        >+ {zh ? "新建" : "New"}</button>
      </div>
      <p className="sp-hint sp-hint--relaxed">
        {zh ? "Profile 是子智能体的持久化身份/领域/范围记录，生成子智能体时自动注入到 system prompt。" : "Profiles are persistent identity/domain/scope records for subagents, auto-injected into system prompt on spawn."}
      </p>

      {editing && (
        <div className="sp-card--sm sp-card--col sp-card">
          <input value={editing.identity || ""} onChange={(e) => setEditing({ ...editing, identity: e.target.value })} placeholder={zh ? "身份标识（如：前端专家）" : "Identity (e.g.: Frontend Expert)"} className="sp-input sp-input--compact" />
          <input value={editing.domain || ""} onChange={(e) => setEditing({ ...editing, domain: e.target.value })} placeholder={zh ? "领域（如：React/TypeScript）" : "Domain (e.g.: React/TypeScript)"} className="sp-input sp-input--compact" />
          <input value={editing.scope || ""} onChange={(e) => setEditing({ ...editing, scope: e.target.value })} placeholder={zh ? "范围（如：组件开发/性能优化）" : "Scope (e.g.: Components/Performance)"} className="sp-input sp-input--compact" />
          <textarea value={editing.experience_summary || ""} onChange={(e) => setEditing({ ...editing, experience_summary: e.target.value })} placeholder={zh ? "经验摘要（可选）" : "Experience summary (optional)"}  rows={2} className="sp-input sp-input--compact sp-input--resize" />
          <div className="sp-row">
            <button onClick={handleSave} className="sp-btn sp-btn--sm sp-btn--primary">{zh ? "保存" : "Save"}</button>
            <button onClick={() => setEditing(null)} className="sp-btn sp-btn--sm sp-btn--ghost">{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}

      {profiles.length === 0 && !editing && (
        <div className="sp-empty sp-empty--plain">{zh ? "暂无 Agent Profile" : "No agent profiles yet"}</div>
      )}

      {profiles.map((p) => (
        <div key={p.id} className="sp-card--tight sp-card--col sp-card sp-col--tight">
          <div className="sp-row sp-row--between">
            <span className="sp-text-medium">{p.identity}</span>
            <div className="sp-row sp-row--gap-tight">
              <button onClick={() => setEditing(p)} className="sp-btn sp-btn--xs sp-btn--ghost">{zh ? "编辑" : "Edit"}</button>
              <button onClick={() => handleDelete(p.id)} className="sp-btn sp-btn--xs sp-btn--danger-ghost">{zh ? "删除" : "Delete"}</button>
            </div>
          </div>
          <div className="hint-sm">{p.domain} · {p.scope}</div>
          {p.experience_summary && <div className="sp-note sp-line-14">{p.experience_summary}</div>}
          {p.skills && p.skills.length > 0 && (
            <div className="sp-row sp-row--gap-tight sp-row--wrap">
              {p.skills.map((s) => <span key={s} className="sp-mini sp-tag-chip">{s}</span>)}
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
    <div className="sp-card sp-card--col">
      <h3 className="sp-title">{zh ? "💬 Transcript 缓存统计" : "💬 Transcript Cache Stats"}</h3>
      <p className="sp-hint sp-hint--relaxed">
        {zh ? "缓存 LLM 请求/响应对以减少 token 消耗。10 分钟 TTL，最多 100 条。上下文压缩时自动清空。" : "Caches LLM request/response pairs to reduce token waste. 10min TTL, max 100 entries. Auto-cleared on context compaction."}
      </p>

      <div className="sp-card">
        <div className="sp-row--between sp-row sp-row--lead">
          <span className="sp-text-medium">{zh ? "缓存占用" : "Cache Usage"}</span>
          <span className="hint-sm">{stats.size} / {stats.maxSize}</span>
        </div>
        <div className="sp-bar-track">
          <div className={`sp-bar-fill ${pct > 80 ? "is-danger" : ""}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="sp-hint sp-hint--spaced">{pct}% {zh ? "已使用" : "used"}</div>
      </div>

      <div className="sp-row">
        <button
          onClick={() => { TranscriptCache.clear(); setStats(TranscriptCache.stats()); }}
          className="sp-btn"
        >{zh ? "🗑️ 清空缓存" : "🗑️ Clear Cache"}</button>
        <button
          onClick={() => setStats(TranscriptCache.stats())}
          className="sp-btn"
        >{zh ? "🔄 刷新" : "🔄 Refresh"}</button>
        <label className="sp-inline-check">
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
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState("");

  // CLI 检测：①应用内一键安装记下的启动器路径存在 → 已安装；
  // ②否则 execute_command 探测（exitCode/stdout/stderr 三重兜底——此前只看
  // stderr 两种英文文案，任何 stderr 为空/文案不同的失败都会误判"已安装"）
  const checkCli = useCallback(async () => {
    setStatus("checking");
    try {
      const { getSetting } = require("../core/storage/settings");
      const launcher = getSetting("codem-codegraph-launcher");
      if (launcher) {
        const { invoke } = (window as any).__TAURI__.core;
        const exists = await invoke("path_exists", { path: launcher }).catch(() => false);
        if (exists) { setStatus("installed"); return; }
      }
      const { invoke } = (window as any).__TAURI__.core;
      const result = await invoke("execute_command", {
        command: "codegraph --version",
        cwd: null,
      });
      const stderr = String(result.stderr || "");
      const stdout = String(result.stdout || "");
      const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
      const looksNotFound =
        stderr.includes("not recognized") || stderr.includes("not found") ||
        stderr.includes("不是内部或外部命令") || stderr.includes("找不到") ||
        stdout.includes("not recognized");
      if (looksNotFound || (exitCode !== 0 && stdout.trim() === "")) {
        setStatus("not_installed");
      } else {
        setStatus("installed");
      }
    } catch {
      setStatus("not_installed");
    }
  }, []);

  // 索引检测（当前项目 .codegraph/ 是否存在）
  const checkIndex = useCallback(async () => {
    try {
      const { getSetting } = require("../core/storage/settings");
      const p = getSetting("codem-current-project-path") || "";
      setProjectPath(p);
      if (p) {
        const { invoke } = (window as any).__TAURI__.core;
        const exists = await invoke("path_exists", { path: `${p}/.codegraph` }).catch(() => false);
        setHasIndex(!!exists);
      } else {
        setHasIndex(false);
      }
    } catch { setHasIndex(false); }
  }, []);

  const handleRecheck = useCallback(() => {
    void checkCli();
    void checkIndex();
  }, [checkCli, checkIndex]);

  // 一键安装 CodeGraph（方案 B：应用内下载 → 解压 %LOCALAPPDATA%\codegraph\current
  // → 记录启动器路径；用户零命令行）
  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setInstallMsg(zh ? "正在下载并安装 CodeGraph（约 52MB，首次约需 1-2 分钟）..." : "Downloading & installing CodeGraph (~52MB, may take a minute)...");
    try {
      const { invoke } = (window as any).__TAURI__.core;
      const res = await invoke("codegraph_install");
      const { setSetting } = require("../core/storage/settings");
      setSetting("codem-codegraph-launcher", res.launcher);
      setInstallMsg(zh ? `✓ 安装完成：${res.launcher}` : `Installed: ${res.launcher}`);
      setStatus("installed");
    } catch (e: any) {
      setInstallMsg(zh ? `✗ 安装失败：${e?.message || e}` : `Install failed: ${e?.message || e}`);
      setStatus("not_installed");
    } finally {
      setInstalling(false);
    }
  }, [zh]);

  useEffect(() => {
    void checkCli();
    void checkIndex();
  }, [checkCli, checkIndex]);

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
    <div className="sp-card sp-card--col sp-col--lg">
      <h3 className="sp-title">
        {zh ? "🔗 CodeGraph 代码知识图谱" : "🔗 CodeGraph Code Intelligence"}
      </h3>
      <p className="sp-hint sp-hint--relaxed-16 sp-flush">
        {zh
          ? "CodeGraph 把代码库从\"文件集合\"转换成\"可查询的关系图\"，帮助 AI 更快理解大型项目。Agent 用一次 codegraph_explore 调用替代 10-20 次 grep+read，大幅减少 token 消耗。"
          : "CodeGraph transforms your codebase from a \"collection of files\" into a \"queryable relationship graph\", helping AI understand large projects faster. One codegraph_explore call replaces 10-20 grep+read calls, dramatically reducing token usage."}
      </p>

      <div className="sp-card">
        <label className="sp-check">
          <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} className="icon-md" />
          <span className="sp-strong">{zh ? "启用 CodeGraph 集成" : "Enable CodeGraph Integration"}</span>
        </label>
        <div className="sp-hint sp-hint--indent">
          {zh
            ? "开启后，打开包含 .codegraph/ 目录的项目时自动连接 CodeGraph MCP Server，agent 将获得 codegraph_explore 工具。"
            : "When enabled, opening a project with a .codegraph/ directory auto-connects the CodeGraph MCP Server. The agent gains the codegraph_explore tool."}
        </div>
      </div>

      <div className="sp-card">
        <div className="sp-row sp-row--between sp-row--lead">
          <div className="sp-text-medium">{zh ? "CLI 状态" : "CLI Status"}</div>
          <button
            onClick={handleRecheck}
            disabled={status === "checking"}
            className="sp-btn sp-btn--xs"
            title={zh ? "重新检测 CLI 与索引" : "Re-check CLI and index"}
          >
            {status === "checking" ? (zh ? "检测中..." : "Checking...") : (zh ? "🔄 重新检测" : "🔄 Re-check")}
          </button>
        </div>
        {status === "checking" && <div className="hint-sm">{zh ? "正在执行 codegraph --version..." : "Running codegraph --version..."}</div>}
        {status === "installed" && <div className="sp-hint sp-icon-success">✓ {zh ? "codegraph CLI 已安装" : "codegraph CLI is installed"}</div>}
        {status === "not_installed" && (
          <div>
            <div className="sp-hint sp-hint--error sp-hint--lead">✗ {zh ? "codegraph CLI 未安装" : "codegraph CLI is not installed"}</div>
            <button
              onClick={handleInstall}
              disabled={installing}
              className="sp-btn sp-btn--lg sp-btn--primary sp-hint--lead"
            >
              {installing ? (zh ? "⏳ 安装中..." : "⏳ Installing...") : (zh ? "⬇️ 一键安装 CodeGraph（约 52MB）" : "⬇️ Install CodeGraph (~52MB)")}
            </button>
            {installMsg && (
              <pre className="sp-output sp-output--short">
                {installMsg}
              </pre>
            )}
            <div className="sp-hint sp-hint--relaxed">
              {zh ? "或手动安装（PowerShell）：" : "Or install manually (PowerShell):"}
              <br />
              <code className="sp-code-chip">
                irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
              </code>
            </div>
          </div>
        )}
      </div>

      {projectPath && (
        <div className="sp-card">
          <div className="sp-text-medium sp-hint--lead">{zh ? "当前项目" : "Current Project"}</div>
          <div className="sp-hint sp-hint--lead sp-break">{projectPath}</div>
          <div className="sp-hint-sm-block">
            {hasIndex ? (
              <span className="sp-icon-success">✓ {zh ? "已有 .codegraph/ 索引" : ".codegraph/ index exists"}</span>
            ) : (
              <span className="sp-icon-error">✗ {zh ? "未找到 .codegraph/ 索引" : ".codegraph/ index not found"}</span>
            )}
          </div>
          {!hasIndex && status === "installed" && (
            <button
              onClick={handleInit}
              disabled={initRunning}
              className="sp-btn sp-btn--lg sp-btn--primary"
            >
              {initRunning ? (zh ? "构建中..." : "Building...") : (zh ? "🔨 构建代码图谱" : "🔨 Build Code Graph")}
            </button>
          )}
          {initOutput && (
            <pre className="sp-output">
              {initOutput}
            </pre>
          )}
        </div>
      )}

      <div className="sp-card sp-card--sm sp-card--secondary">
        <div className="sp-text-soft sp-hint--lead">
          {zh ? "📊 实测效果（7 个真实项目基准）" : "📊 Measured Results (7 real-world repos)"}
        </div>
        <div className="sp-hint sp-hint--relaxed-16">
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