import { useState, useEffect, useCallback, useMemo, useRef } from "react";
// 第 207 波：模型管理里要把内置免费模型插件的模型也列出来（它们不需要 API Key）
import { freeModelPlugin } from "../core/free-model-plugin/service";
/* 第 219 波：所有渲染模型选项的分支都必须用同一套「免费模型可用性」口径 */
import { isFreeModelId } from "../core/free-model-plugin/model-index";
import type { IdentityConfig, UserConfig, AppIdentity } from "../core/types";
import { saveAppIdentity } from "../core/config/loader";
import { version as APP_VERSION } from "../../package.json";
import { getMiMoAuth } from "../core/auth/mimo";
import type { LoginResult } from "../core/auth/mimo";
import { useAppStore } from "../store";
import { inferContextWindow } from "../core/llm/provider";
import {
  getSettingJSON,
  setSettingJSON,
  getSetting,
  setSetting,
  removeSetting,
  beginSettingsWriteProbe,
  flushSettingsWrites,
  type SettingsWriteReport,
} from "../core/storage/settings";
import { addCustomModel, removeCustomModel, customNamesFor } from "../core/llm/custom-models";
// 第 47 轮补：失败上报通道（代码图谱开关写失败时**必须可见**，不再静默）
import { reportActionFailure } from "../core/storage/persist-failure";
import { mergeModelsWithCatalog, getMergedDynamicModels, catalogFor } from "../core/llm/model-catalog";
import { MIMO_MODELS } from "../core/model-config";
import { getCatalogHealthFor, describeCatalogHealth, subscribeCatalogHealth, orderModelsByHealth, catalogModelLabelSuffix } from "../core/llm/catalog-health";
import { setLang, useLang, S, type Language } from "../core/i18n/lang";
import { ModelProfilePanel } from "./ModelProfilePanel";
import { getPermissionManager, type PermissionRule, type PermissionAction } from "../core/permission/permission";
import { SECURITY_MODES, getGlobalSecurityMode, setGlobalSecurityMode, type SecurityMode } from "../core/permission/security-mode";
import { MultimodalPanel } from "./MultimodalPanel";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";
import { SecretStorageSetting } from "./SecretStorageSetting"; // 第 62 轮：凭据封存开关
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
import { applyUiFontScale, applyStoredUiFont, applyUiFontFamily, applyStoredUiFontFamily, readStoredUiFontFamily, FONT_BASE_PX } from "../core/ui-font";
import { resetUiPreferencesToDefaults } from "../core/settings/ui-preferences";
import {
  applyContrastAttribute,
  applyDensityAttribute,
  isContrastMode,
  isDensityMode,
  readCachedContrast,
  readCachedDensity,
  CONTRAST_SETTING_KEY,
  DENSITY_SETTING_KEY,
  type ContrastMode,
  type DensityMode,
} from "../core/theme/appearance-modes";
// P2 #34: Import reusable settings components
import { SettingsNav, ConfigEntry, ToggleEntry } from "./SettingsParts";
import {
  DEEPSEEK_DEFAULT_SEARCH_COUNT,
  DEEPSEEK_MAX_SEARCH_COUNT,
  deepseekToolBaseUrl,
  readDeepSeekWebConfig,
  setDeepSeekFetchEnabled,
  setDeepSeekSearchCount,
  setDeepSeekSearchEnabled,
  type DeepSeekWebConfig,
} from "../core/llm/tools/deepseek-web";
import { setSandboxAclEnabled, isSandboxAclEnabled, getSandboxAllowedDirs, removeSandboxAllowedDir } from "../core/sandbox/sandbox-acl";
import { showToast } from "./ToastNotification";
import { useEdgeFade } from "./EdgeFade";
import { useRovingFocus } from "../hooks/useRovingFocus";
import { SOUND_CUES_SETTING_KEY } from "../core/ui/sound-cues";
import { appendCustomProvider } from "../core/settings/custom-provider";
// P2 #35: Import UsageStats for embedding in settings
import { UsageStats } from "./UsageStats";
import { PerformanceDashboard } from "./PerformanceDashboard";
import { MemoryCheckupView } from "./MemoryCheckupView";
import { projectIdFromCwd } from "../core/memory/memory";
// P2 #38: framer-motion for animations
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
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
  /* 第 186 轮：运行模式的「更多」入口图标 */
  Ellipsis,
  type LucideIcon,
} from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { alertDialog, confirmDialog } from "../core/ui/native-dialog";

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
  model: string;
  fontSize: number;
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

/**
 * 设置对象的默认值。
 *
 * 第 61 波（死字段排查）：删掉三个**从来没被读过**的字段 ——
 *   · `theme`：明暗主题的真相源是 `codem-theme`（`theme-default.ts`），这里还留着一个
 *     `theme: "dark"` 的旧默认值，与 `DEFAULT_THEME = "light"` 矛盾，是"两个来源不同默认值"的隐患；
 *   · `mimoPath`：全项目只有"类型声明 + 这里的默认值 + 一个测试夹具"三处出现，没有任何读取；
 *   · `autoApprove`：设置对象里没人读（真正生效的是 `App.tsx` 里**按会话**维护的
 *     `writeConfirmStats.autoApprove`，与本字段无关）。
 * 字段写得再整齐，只要没人读就是死代码 —— 而且会误导后续维护者以为"改这里能生效"。
 */
const defaultSettings: Settings = {
  mode: "api",
  model: "mimo-v2.5-pro",
  // 第 56 波：默认字号必须等于 `--fs-*` 的缩放基准（13px）。
  // 此前这里是 14、而启动不应用字号 → 打开设置瞬间把全站放大 14/13 ≈ 7.7%，且关掉设置也不回退。
  fontSize: FONT_BASE_PX,
  language: "zh",
  providers: defaultProviders,
};

interface SettingsPanelProps {
  onClose: () => void;
  onSessionRecovery?: () => void;
  onUsageStats?: () => void;
  /** Open a specific tab on mount (e.g. "automation") */
  initialTab?: string;
  /** P2-1：全屏工作台（路由视图）而不是 1080 居中弹窗 */
  fullPage?: boolean;
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

export function SettingsPanel({
  onClose, onSessionRecovery, onUsageStats, initialTab, fullPage = false, setShowOnboardingReplay }: SettingsPanelProps) {
  /* 滚动边缘渐隐（判据 EDGEFADE-*）：设置内容列是纯内容滚动区，可安全上 mask */
  const contentFade = useEdgeFade<HTMLDivElement>();
  /* 设置侧栏是一组按钮：方向键在组内移动、Tab 正常离开（判据 ROVING-*） */
  const sidebarRoving = useRovingFocus<HTMLDivElement>({ orientation: "vertical" });
  /* 提示音默认关闭（打扰性能力）；开关状态从设置里读，写回同一令牌 */
  const [soundCues, setSoundCues] = useState<boolean>(() => getSetting(SOUND_CUES_SETTING_KEY) === "1");
  const lang = useLang();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  /**
   * 第 159 轮（P2-1）：高对比 + 密度两档的**界面状态**。
   * 初始值取"启动期有效值"的镜像部分（与 `index.html` 内联脚本、`main.tsx` 用的是同一套语义），
   * DB 就绪后由下面的 effect 用 `resolveEffective*` 校正。
   */
  const [contrastMode, setContrastMode] = useState<ContrastMode>(() => readCachedContrast());
  const [densityMode, setDensityMode] = useState<DensityMode>(() => readCachedDensity());
  /**
   * 第 87 波：沙箱开关必须有自己的 state —— 原来直接读 `getSetting(...)`，
   * 勾选后调用 set/removeSetting 却不触发重渲染，界面上的勾选状态要等面板重开才更新。
   */
  const [sandboxOn, setSandboxOn] = useState<boolean>(() => isSandboxAclEnabled());
  /** 沙箱允许目录（交接时一键加入的那些）—— 这里必须能**看到并移除**，否则"可撤销"是假的 */
  const [allowedDirs, setAllowedDirs] = useState<string[]>(() => getSandboxAllowedDirs());
  useEffect(() => {
    const refresh = () => setAllowedDirs(getSandboxAllowedDirs());
    window.addEventListener("codem-settings-changed", refresh);
    return () => window.removeEventListener("codem-settings-changed", refresh);
  }, []);
  /**
   * DeepSeek 联网能力（Search / Fetch）的开关与条数 —— **默认关闭**。
   *
   * 为什么默认关：这两个接口**按成功次数计费**（各 5 元/1000 次）。默认打开等于
   * 让用户在不知情的情况下花钱；"要花钱的能力必须用户显式点头"是产品侧的硬规矩。
   *
   * 为什么放自己 state 而不是塞进 `settings`（codem-settings JSON）：开关必须**立刻生效**
   * （工具侧读 DB，不等「保存」），而且它和"哪家 provider"无关 —— 塞进 provider 卡片
   * 之外的扁平键才不会被「保存并刷新」的整块覆盖逻辑牵连。
   */
  const [deepseekWeb, setDeepseekWeb] = useState<DeepSeekWebConfig>(() => readDeepSeekWebConfig());
  const [identity, setIdentity] = useState<IdentityConfig>(defaultIdentity);
  const [userConfig, setUserConfig] = useState<UserConfig>(defaultUser);
  const [saved, setSaved] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [dynamicModels, setDynamicModels] = useState<Record<string, Array<{ id: string; name: string; contextWindow?: number; catalogOnly?: boolean }>>>({});
  /**
   * 第 81 波：目录条目健康状态变化时重绘。
   *
   * `getCatalogHealthFor` 读的是模块内缓存（同步、便宜），所以渲染时直接调用即可；
   * 这个 tick 只负责"调用结果翻转时让界面跟上"（例如设置面板开着的时候用户在聊天里
   * 调用了一个失效的内置模型，下拉里的标注要立刻变成"服务器已拒绝"）。
   */
  const [, setCatalogHealthTick] = useState(0);
  useEffect(() => subscribeCatalogHealth(() => setCatalogHealthTick((t) => t + 1)), []);
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
  const [fontFamily, setFontFamily] = useState<string>(() => readStoredUiFontFamily());
  const [fontWeight, setFontWeight] = useState<string>(getSetting("codem-font-weight") || "400");
  /** 保存结果提示（D-21）：`saved` 只在**确认落库**后为真；失败时走 `saveFailure` */
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  /** 重置界面设置的结果提示（D-11） */
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  /**
   * 面板里**只在本地 state 改、保存时才落库**的字段（D-23）。
   *
   * 为什么要记这个：`handleSave` 写的是面板 mount 时读到的快照演变来的 `settings` state。
   * 若面板打开期间别处改写了库里的同一个字段（header 切模型、`configureEngine` 落盘
   * mode/model），直接整块覆盖就会把**更新的那次写入顶回旧值**。
   * 现在保存时以"保存这一刻的库值"为基座，只把**面板真正改过的本地字段**盖上去
   * —— 没改过的字段以库为准（库是更晚的事实）。
   */
  const dirtyLocalFields = useRef<Set<string>>(new Set());

  /**
   * DeepSeek 联网能力的面板快照：保存 provider（含 Base URL / API Key）或别处改了设置时刷新。
   * 不刷新的话「实际使用的 base URL」会一直显示打开面板那一刻的旧值 —— 那正是
   * 这条只读展示想避免的事（面板说的和工具真正打的必须是同一条解析链）。
   */
  useEffect(() => {
    const refreshDeepseekWeb = () => setDeepseekWeb(readDeepSeekWebConfig());
    window.addEventListener("codem-settings-changed", refreshDeepseekWeb);
    return () => window.removeEventListener("codem-settings-changed", refreshDeepseekWeb);
  }, []);

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

    // 第 159 轮（P2-1）：DB 是这两档的真相源 —— 打开设置时用 DB 值校正界面状态与 DOM
    // （镜像可能落后，例如上一次退出前改过但没写进镜像）。写库只在用户改的时候发生。
    try {
      const dbContrast = getSetting(CONTRAST_SETTING_KEY);
      const dbDensity = getSetting(DENSITY_SETTING_KEY);
      if (isContrastMode(dbContrast)) {
        setContrastMode(dbContrast);
        applyContrastAttribute(dbContrast);
      }
      if (isDensityMode(dbDensity)) {
        setDensityMode(dbDensity);
        applyDensityAttribute(dbDensity);
      }
    } catch (e) {
      console.warn("[SettingsPanel] load appearance modes:", e);
    }

    // Load dynamically fetched models from DB cache
    try {
      const stored = getSettingJSON<Record<string, Array<{ id: string; name: string; contextWindow?: number }>>>("codem-dynamic-models", {});
      if (stored && Object.keys(stored).length > 0) {
        // 合并手动添加的自定义模型（服务器列表外），与 engine.loadDynamicModels 保持一致
        setDynamicModels(getMergedDynamicModels()) /* 服务器 + 手动 + 内置目录 */;
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

  /**
   * 保存基座（D-23）：以**保存这一刻的库值**为底，再盖上面板本地改动过的字段。
   *
   * 关键点：`mode` / `language` / `fontSize` 这类字段在面板里"改了就立刻写库"
   * （见各自 onChange），所以**库里的值就是用户最后一次的选择**，以库为准不会丢选择；
   * 而 `model` / `providers` 是"只在本地 state 改、保存时才落库"的字段（见
   * `dirtyLocalFields`），面板改过就以面板为准，否则同样以库为准。
   */
  const buildSavePayload = (panel: Settings): Settings => {
    let fresh: (Partial<Settings> & Record<string, unknown>) | null = null;
    try {
      fresh = getSettingJSON<(Partial<Settings> & Record<string, unknown>) | null>("codem-settings", null);
    } catch {
      fresh = null;
    }
    if (!fresh || typeof fresh !== "object") return panel; // 库读不到 ⇒ 只能用面板值
    const merged: Settings = { ...(fresh as Settings), ...panel };
    const dirty = dirtyLocalFields.current;
    // 面板没在本地改过的字段 ⇒ 以库为准（库是更晚的事实）
    if (typeof fresh.mode === "string" && !dirty.has("mode")) merged.mode = fresh.mode;
    if (typeof fresh.model === "string" && !dirty.has("model")) merged.model = fresh.model;
    if (typeof (fresh as { language?: unknown }).language === "string" && !dirty.has("language")) {
      merged.language = (fresh as { language: Language }).language;
    }
    if (typeof (fresh as { fontSize?: unknown }).fontSize === "number" && !dirty.has("fontSize")) {
      merged.fontSize = (fresh as { fontSize: number }).fontSize;
    }
    if (Array.isArray((fresh as { providers?: unknown }).providers) && !dirty.has("providers")) {
      merged.providers = (fresh as { providers: ProviderKey[] }).providers;
    }
    return merged;
  };

  /**
   * 规范保存流程。**返回"这次保存是否确认落库"**（true = 写队列已排空且窗口内没有新增失败）。
   *
   * 为什么要有返回值：provider 卡片上的「保存并刷新模型」要先确认"存上了"再去拉模型列表
   * —— 否则会在"没存上"的前提下装作已保存（2026-10-17「保存并刷新模型」误导实报，见该按钮处的注释）。
   */
  const handleSave = async (panelOverride?: Settings): Promise<boolean> => {
    /**
     * `panelOverride`：给"先改本地 state、紧接着要保存"的路径用。
     *
     * `setSettings()` 是异步的，`await handleSave()` 在同一个 tick 里读到的 `settings`
     * 还是旧值 —— 添加自定义 Provider 如果直接调 `handleSave()`，新 provider 根本不会进库。
     * 所以调用方把**它刚算出来的那份**显式传进来（并同时 `setSettings` 让界面跟上）。
     */
    const panel = panelOverride ?? settings;
    /**
     * D-21：写入是"内存即时生效 + 异步落库"，`setSetting*` 返回 `void`，
     * 所以"✅ 已保存"必须建立在**可等待的确认**上，而不是"没抛异常"。
     * `beginSettingsWriteProbe()` 记下写入前的失败水位；`flushSettingsWrites()` 等写队列排空
     * 并检查这段窗口里有没有新增失败。落库失败本身仍有旁路上报（guidance 提示），
     * 这里修的是"**即时反馈**不许撒谎"。
     */
    const probe = beginSettingsWriteProbe();

    setSettingJSON("codem-settings", buildSavePayload(panel));
    setLang(panel.language);

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

    // 面板本地改动已经落库（无论成功与否），下次保存重新按库值算基座
    dirtyLocalFields.current = new Set();

    const report = await flushSettingsWrites(probe);
    if (report.settled) {
      setSaveFailure(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    }
    // **不许把"写入失败"演成"已保存"**：如实显示未确认 + 为什么会失败
    setSaved(false);
    const reason = describeWriteFailure(report, lang);
    setSaveFailure(reason);
    showToast("error", reason, 6000);
    return false;
  };

  /** 把"没落库"讲清楚（给用户看的原因 + 给排查看的区域名） */
  const describeWriteFailure = (report: SettingsWriteReport, locale: Language): string => {
    if (!report.accepted) {
      return locale === "zh"
        ? "⚠️ 未确认保存：存储端口不可用，设置只存在于内存里（重启会丢）"
        : "⚠️ Not confirmed: storage port unavailable, changes live in memory only";
    }
    if (report.newAreas.length > 0) {
      return locale === "zh"
        ? `⚠️ 未确认保存：${report.newAreas.join("、")} 落库失败（重启会回到旧值）`
        : `⚠️ Not confirmed: failed to persist ${report.newAreas.join(", ")} (reverts on restart)`;
    }
    return locale === "zh"
      ? `⚠️ 未确认保存：仍有 ${report.pending} 条写入未落库（超时）`
      : `⚠️ Not confirmed: ${report.pending} write(s) still pending (timed out)`;
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
const [activeTab, setActiveTab] = useState<"general" | "appearance" | "security" | "git" | "environment" | "worktree" | "knowledge" | "automation" | "multimodal" | "voice" | "ollama" | "pet" | "tools" | "persona" | "computer" | "wechat" | "phone" | "codegraph" | "advanced" | "help" | "usage" | "performance" | "memory-checkup">((initialTab as any) || "general");
  /**
   * 切到「安全」时**重新读一次**允许目录。
   *
   * 真机教训（1.16.326 验证时发现）：设置面板是常驻挂载的，`useState(getSandboxAllowedDirs())`
   * 只在**首次挂载**求值 —— 那时存储端口可能还没就绪，读到空数组就再也不刷新，
   * 于是"库里明明有允许目录、界面上却显示暂无"。这里按 tab 重读，事件监听仍负责热更新。
   */
  useEffect(() => {
    if (activeTab === "security") setAllowedDirs(getSandboxAllowedDirs());
  }, [activeTab]);
  /**
   * 运行模式的「更多」是否展开（第 186 轮）。
   *
   * CLI 模式默认收起来：用户已改用 API 模式登录，平时不需要看到它。
   * ⚠️ 但它**不能只靠这个 state 决定可见性** —— 当前模式就是 CLI 时也必须显示，
   * 否则正在用 CLI 的人打开设置会只看到"API 模式已选中"，以为自己的模式被改掉了。
   * 展开状态**不持久化**：下次打开设置回到"只有 API 模式"的默认形态（这正是用户要的"平常不显示"）。
   */
  const [showMoreRunModes, setShowMoreRunModes] = useState(false);
  // P2 #36: Settings search — D2 修复：占位搜索框现在真正过滤/跳转设置分组
  const [settingsSearch, setSettingsSearch] = useState("");
  const [advancedSubTab, setAdvancedSubTab] = useState<"agents" | "heartbeat" | "retry" | "prompt" | "settings" | "recovery" | "correction" | "profiles" | "transcript">("agents");
  const [showPetMarket, setShowPetMarket] = useState(false);
  /**
   * 「检查更新」的进度/结果文案（第 62 轮）。
   *
   * ⚠️ 原来这段文字是**用 `btn.textContent = …` 直接改 DOM** 的 —— 真机复量发现：
   * 点下去之后只要组件因为**任何**原因重渲染一次，React 就会按 JSX 把按钮文字写回
   * "检查更新"，那句"发现新版本 x.y.z / 未发现更新 / 更新失败: …"用户**根本看不到**
   * （控制台里 `[updater] 未安装更新：none` 打了，界面上却什么都没有）。
   * 这是一类典型的"印出来的不是真的"：状态在 DOM 里、不在 React 里。
   * 所以文案改成 state，由 React 渲染。
   */
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  /**
   * 第 204 波（用户实报「正在下载，看不到进度条，进度条一直不动」）：更新下载的进度状态。
   *
   * **以前根本没有这个 state** —— 当时调 downloadAndInstall 连事件回调都没传（空参），插件发的
   * Started/Progress/Finished 全被丢掉，界面只有一句静态文案。
   */
  const [updateProgress, setUpdateProgress] = useState<null | {
    downloadedBytes: number;
    totalBytes: number | null;
    percent: number | null;
    label: { zh: string; en: string };
  }>(null);

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
    ["memory-checkup", ["记忆体检", "记忆", "memory", "体检", "checkup"]],
  ];

  /**
   * P2-1 两级 IA：左侧 8 个组，组内是原 23 个 tab。
   * tab id 与 SETTINGS_TAB_INDEX 一一对应；只重组展示，不改 activeTab 取值。
   */
  const SETTINGS_TAB_GROUPS: Array<{
    id: string;
    zh: string;
    en: string;
    tabs: Array<{ id: string; zh: string; en: string; icon: LucideIcon }>;
  }> = [
    {
      id: "essentials", zh: "日常", en: "Essentials",
      tabs: [
        { id: "general", zh: "通用", en: "General", icon: SettingsIcon },
        { id: "appearance", zh: "外观", en: "Appearance", icon: Palette },
        { id: "security", zh: "安全", en: "Security", icon: Shield },
      ],
    },
    {
      id: "project", zh: "项目与 Git", en: "Project & Git",
      tabs: [
        { id: "git", zh: "Git", en: "Git", icon: GitBranchIcon },
        { id: "environment", zh: "环境", en: "Environment", icon: Server },
        { id: "worktree", zh: "工作树", en: "Worktree", icon: FolderTree },
      ],
    },
    {
      id: "knowledge", zh: "知识与自动化", en: "Knowledge & automation",
      tabs: [
        { id: "knowledge", zh: "知识", en: "Knowledge", icon: BookOpenIcon },
        { id: "automation", zh: "自动化", en: "Automation", icon: Bot },
      ],
    },
    {
      id: "models", zh: "模型与能力", en: "Models & capabilities",
      tabs: [
        { id: "multimodal", zh: "多模态", en: "Multimodal", icon: Layers },
        { id: "voice", zh: "语音", en: "Voice", icon: Mic },
        { id: "ollama", zh: "Ollama", en: "Ollama", icon: Server },
        { id: "tools", zh: "工具", en: "Tools", icon: Wrench },
      ],
    },
    {
      id: "persona", zh: "人格与设备", en: "Persona & devices",
      tabs: [
        { id: "persona", zh: "人设", en: "Persona", icon: BrainCircuit },
        { id: "computer", zh: "电脑操作", en: "Computer Use", icon: MousePointer2 },
        { id: "wechat", zh: "微信 ClawBot", en: "WeChat ClawBot", icon: MessageCircle },
        { id: "phone", zh: "连接手机", en: "Phone Link", icon: Smartphone },
        { id: "codegraph", zh: "代码图谱", en: "CodeGraph", icon: Network },
        { id: "pet", zh: "宠物", en: "Pet", icon: PawPrint },
      ],
    },
    {
      id: "insights", zh: "数据与洞察", en: "Insights",
      tabs: [
        { id: "usage", zh: "用量统计", en: "Usage", icon: Zap },
        { id: "performance", zh: "性能", en: "Performance", icon: Activity },
        { id: "memory-checkup", zh: "记忆体检", en: "Memory checkup", icon: BrainCircuit },
      ],
    },
    {
      id: "system", zh: "系统", en: "System",
      tabs: [{ id: "advanced", zh: "高级", en: "Advanced", icon: Zap }],
    },
    {
      id: "help", zh: "帮助", en: "Help",
      tabs: [{ id: "help", zh: "帮助", en: "Help", icon: HelpCircle }],
    },
  ];
  const SETTINGS_GROUP_DESC: Record<string, { zh: string; en: string }> = {
    essentials: { zh: "应用外观、启动行为与通知。", en: "Appearance, startup behavior and notifications." },
    project: { zh: "项目、Git 与工作树相关设置。", en: "Project, Git and worktree settings." },
    knowledge: { zh: "知识、记忆与自动化能力。", en: "Knowledge, memory and automation." },
    models: { zh: "模型、语音、工具与本地推理。", en: "Models, voice, tools and local inference." },
    persona: { zh: "人设、电脑操作与外部设备。", en: "Persona, computer use and connected devices." },
    insights: { zh: "用量、性能与记忆体检。", en: "Usage, performance and memory checkup." },
    system: { zh: "高级系统选项。", en: "Advanced system options." },
    help: { zh: "帮助与关于。", en: "Help and about." },
  };
  const activeGroup = SETTINGS_TAB_GROUPS.find((group) => group.tabs.some((tab) => tab.id === activeTab)) ?? SETTINGS_TAB_GROUPS[0];
  const activeTabDef = activeGroup.tabs.find((tab) => tab.id === activeTab);
  const activeGroupDesc = SETTINGS_GROUP_DESC[activeGroup.id] ?? SETTINGS_GROUP_DESC.essentials;
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
    // D-23：provider 表单（API Key / Base URL）**只在本地 state 改** ⇒ 记进本地改动集合
    dirtyLocalFields.current.add("providers");
    setSettings({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...update } : p
      ),
    });
  };

  /**
   * 添加自定义 Provider —— **必须并入规范保存流程**（2026-10-18）。
   *
   * 旧实现在这里裸写 `setSettingJSON("codem-settings", newSettings)`：
   * 没有写后确认（`beginSettingsWriteProbe`/`flushSettingsWrites`），没有以库值为基座合并，
   * 也没有 `dirtyLocalFields` 结账 —— 于是"添加了"可能只是内存里添加了，
   * 重启后 provider 消失，用户毫无察觉（与 provider 卡片那个"假保存"同一类缺陷）。
   *
   * 现在：先把新列表放进本地 state（界面立刻可见），再把**这一份**显式传给 `handleSave(panel)`，
   * 只有保存被确认（`true`）才收起表单并清空输入；未确认就保留表单、由 `handleSave`
   * 自己给出失败原因（横幅 + toast），用户可以重试。
   */
  const addCustomProvider = async () => {
    const { providers, provider } = appendCustomProvider<ProviderKey>(settings.providers, {
      name: customName,
      baseUrl: customBaseUrl,
      apiKey: customApiKey,
    });
    if (!provider) return;
    const newSettings = { ...settings, providers };
    dirtyLocalFields.current.add("providers");
    setSettings(newSettings);
    const confirmed = await handleSave(newSettings);
    if (!confirmed) return;
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
    // 同步合并进当前动态模型视图（✓ 计数即时更新）：重建 = 服务器缓存 + 手动 + 内置目录
    setDynamicModels(getMergedDynamicModels());
    setRefreshStatus((prev) => ({ ...prev, [providerId]: "" }));
    // 通知引擎重载：模型选择器/方案立即可用
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const handleRemoveCustomModel = (providerId: string, name: string) => {
    removeCustomModel(providerId, name);
    // 重建视图 = 服务器缓存 + 剩余自定义 + 内置目录（不基于 prev filter，
    // 避免服务器列表本身含同名模型时被误滤）
    try {
      setDynamicModels(getMergedDynamicModels());
    } catch (e) { console.warn('[SettingsPanel] rebuild models after remove:', e) }
    window.dispatchEvent(new Event("codem-settings-changed"));
  };

  const removeCustomProvider = (id: string) => {
    const newSettings = { ...settings, providers: settings.providers.filter((p) => p.id !== id) };
    dirtyLocalFields.current.add("providers");
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
    /*
     * 第 208 波（用户实报：设置里点「Our Free Model（免费模型插件）」的『刷新模型列表』，
     * 仍然提示「请先配置 API Key」）：内置插件的托管条目是**故意不落盘密钥**的
     * （密钥由插件启动时运行时注册），而这道闸只认 apiKey ⇒ 永远刷不了。
     *
     * 第 209 波修正（同一个用户接着报：放行之后变成「获取失败，使用内置列表」）：
     * 那个本机服务**确实要 Key** —— 真机实测不带 Authorization 就是 **401**
     * （`Invoke-WebRequest http://127.0.0.1:18937/v1/models` ⇒ 401；带 `Bearer ofm-S-…` ⇒ 200）。
     * 密钥在插件自己的 settings.json 里（`forwardKey`）⇒ 从插件的诊断口**现读**它，
     * 而不是想当然地省略 Authorization。
     */
    const isManagedFreeModel = (provider as { managedBy?: string } | undefined)?.managedBy === "free-model-plugin";
    let authKey = provider?.apiKey ?? "";
    if (isManagedFreeModel && !authKey) {
      try {
        const runtime = await freeModelPlugin.diagnostics.runtime();
        authKey = runtime.key ?? "";
      } catch (e) {
        console.warn("[SettingsPanel] 读插件运行时密钥失败", e);
      }
    }
    if (!provider || (!authKey && !isManagedFreeModel)) {
      setRefreshStatus((prev) => ({ ...prev, [providerId]: "请先配置 API Key" }));
      return;
    }
    if (isManagedFreeModel && !authKey) {
      /* 读不到密钥 = 插件没跑起来。**不许**说"请先配置 API Key" —— 那个 Key 用户根本配不出来。
         第 227 波（用户实报）：原来这里指向「插件管理 → 插件市场」，而那张卡片在
         「插件管理 → Our Free Model」；「插件市场」是另一个页签（那里是 dsh 插件目录）。
         指错地方比不说更糟：用户会去一个永远找不到这张卡片的地方找。 */
      setRefreshStatus((prev) => ({
        ...prev,
        [providerId]: "插件未运行：到「插件管理 → Our Free Model」卡片上点「刷新状态」；若它写着「进程在跑，但服务没就绪」，点同一张卡片上的「结束残留进程并重试」",
      }));
      return;
    }

    setRefreshingModels((prev) => ({ ...prev, [providerId]: true }));
    setRefreshStatus((prev) => ({ ...prev, [providerId]: "" }));

    const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authKey}`,
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
        const serverList = serverModels.map((sm: any) => ({
          id: sm.id,
          name: sm.id,
          contextWindow: sm.context_window || sm.contextWindow || inferContextWindow(sm.id),
          maxOutputTokens: sm.max_output_tokens || sm.maxOutputTokens || 16384,
          supportsTools: sm.supports_tools ?? sm.supportsTools ?? true,
          supportsStreaming: sm.supports_streaming ?? sm.supportsStreaming ?? true,
        }));
        // 服务器 /models 不列"能调用但未公开"的模型（实测 deepseek-v4-flash-vision-exp
        // 不在列表里却返回 200），所以保存**并集**：服务器事实 + 内置目录兜底。
        const models = mergeModelsWithCatalog(providerId, serverList);
        const catalogOnly = models.filter((m) => m.catalogOnly).length;

        // Update state
        setDynamicModels((prev) => ({ ...prev, [providerId]: models }));
        /*
         * ★ 第 221 波（用户实报：清单里过滤了，但刷新提示还写着「✓ 获取到 25 个模型」）：
         * 提示必须和**列表里真实可见的数量**一致 —— 只报"拉回来多少"是误导：
         * 用户看到 25 会以为这 25 个都能用，而其中一批已经被隐藏了 ✗。
         */
        const summarize = () =>
          freeModelPlugin.models.summarizeList(isManagedFreeModel ? models : [], (id) =>
            freeModelPlugin.models.isUnavailable(id),
          );
        const describeRefresh = (probeNote?: string) => {
          const s = summarize();
          const parts = [`✓ 获取到 ${s.total} 个模型`];
          if (catalogOnly > 0) parts.push(`（服务器 ${serverList.length} + 内置目录 ${catalogOnly}）`);
          if (isManagedFreeModel && s.hidden > 0) {
            parts.push(` · 已隐藏 ${s.hidden} 个当前不可用的（可见 ${s.visible} 个）`);
          }
          if (probeNote) parts.push(` · ${probeNote}`);
          return parts.join("");
        };
        setRefreshStatus((prev) => ({ ...prev, [providerId]: describeRefresh() }));
        /*
         * ★ 第 220 波（用户实报：点「刷新模型列表」后**还是**列出 25 个、不能用的照样出现）：
         * 「刷新」只拉目录，**不测可用性**；而可用性结论过期就当"未知" ⇒ 列表里就会出现不能用的模型 ✗。
         * 用户的期待是"刷新完就该反映真实可用性" ⇒ 这里**在后台自动补测一次**：
         * 不阻塞（刷新按钮点完立刻可用），测完再让界面重渲染，把不可用的模型隐掉 ✓。
         */
        if (isManagedFreeModel) {
          /* 第 222 波：刷新后重读**模态依据**（上游可能改了某模型的模态；读不到就一律【未知】） */
          void freeModelPlugin.models.loadModalities();
          const started = freeModelPlugin.models.autoProbeIfStale(() => {
            setDynamicModels(getMergedDynamicModels());
            /* 第 221 波：后台测完把提示里的数字也刷新成最新的（否则又和列表对不上） */
            setRefreshStatus((prev) => ({ ...prev, [providerId]: describeRefresh() }));
          });
          if (started) {
            setRefreshStatus((prev) => ({ ...prev, [providerId]: describeRefresh("正在后台检测可用性…") }));
          }
        }

        // Persist to DB cache (merge with existing)
        // 只落盘**服务器事实**，不落盘内置目录条目 —— 目录在读取处再做并集
        // （否则目录条目会被冻进缓存，日后目录变动就反映不出来）。
        try {
          const existing = getSettingJSON<Record<string, any>>("codem-dynamic-models", {});
          setSettingJSON("codem-dynamic-models", { ...existing, [providerId]: serverList });
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
    <div
      className={`settings-overlay ${fullPage ? "settings-page-overlay" : ""}`}
      onClick={fullPage ? undefined : onClose}
    >
      <div
        className={`settings-panel ${fullPage ? "settings-page" : ""}`}
        role="dialog"
        aria-modal={fullPage ? undefined : "true"}
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        {!fullPage && (
        <div className="settings-header">
          <h3>{S.settings.title[lang]}</h3>
          {/**
           * 第 198 轮：**搜索框从左侧栏搬进标题栏中间**（用户要求）。
           *
           * 用户原话：「搜索设置留的区域太小了，把它从这个地方拿走，移到设置窗口弹窗
           * 标题栏【带 ⚙️ 设置】的那个中间。」
           *
           * 为什么原来确实太小：`.settings-panel` 宽 760px，而 `.settings-sidebar` 只占
           * **160px**，再减掉搜索框自身左右内边距，真正能打字的宽度不到 120px。
           *
           * 放在标题栏中间后，它落在「⚙️ 设置」标题与右侧 ✕ 之间，可用宽度约 520px。
           * 标题栏本身已是 `display:flex; justify-content:space-between`，
           * 所以这里只需给容器 `flex: 1; max-width` 就能居中占位，不必动标题栏布局。
           *
           * ⚠️ `.settings-header` **不能**直接摆可换行的元素（下面注释里那条：
           *   标题栏不许换行），所以输入框**固定单行高度**，匹配结果提示放在下一行、
           *   靠搜索词非空才出现 —— 只有在打字时标题栏才会稍高一点。
           */}
          <div className="settings-search-box settings-search-box--in-header">
            <div className="sp-search">
              <SearchIcon size={14} className="sp-search-icon" />
              <input
                type="text"
                placeholder={lang === "zh" ? "搜索设置..." : "Search settings..."}
                value={settingsSearch}
                onChange={(e) => setSettingsSearch(e.target.value)}
                className="sp-search-input"
              />
              {settingsSearch && <button
        aria-label={lang === "zh" ? "清空搜索" : "Clear search"}
                  title={lang === "zh" ? "清空搜索" : "Clear search"} onClick={() => setSettingsSearch("")} className="sp-btn--icon sp-btn"><X size={12} /></button>}
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
          {/* 第 74 轮：补可访问名 —— 真机普查实测这个 ✕ 是面板内 127 个按钮里**唯一无名**的那个
              （读屏只念"按钮"；第 63 轮走查脚本也因此按名字找不到它、只能按位置兜底）。 */}
          <button className="settings-close" aria-label={lang === "zh" ? "关闭设置" : "Close settings"} onClick={onClose}><X size={16} /></button>
        </div>
        )}

        <div className="settings-body">
          <div className="settings-sidebar" ref={sidebarRoving.containerRef} onKeyDown={sidebarRoving.onKeyDown}>
            {fullPage && (
              <div className="settings-side-head">
                <button className="settings-back settings-back--with-label" onClick={onClose}>
                  <ArrowLeft />
                  <span>{lang === "zh" ? "返回工作台" : "Back to workspace"}</span>
                </button>
                <h2>{S.settings.title[lang]}</h2>
                <div className="settings-side-search">
                  <SearchIcon className="sp-search-icon" />
                  <input
                    type="text"
                    placeholder={lang === "zh" ? "搜索设置..." : "Search settings..."}
                    value={settingsSearch}
                    onChange={(e) => setSettingsSearch(e.target.value)}
                    className="sp-search-input"
                  />
                  {settingsSearch && (
                    <button aria-label={lang === "zh" ? "清空搜索" : "Clear search"} onClick={() => setSettingsSearch("")}>
                      <X />
                    </button>
                  )}
                </div>
              </div>
            )}
                        <div className="settings-nav-group-label">{lang === "zh" ? "通用与外观" : "General & appearance"}</div>
            <button className={`settings-sidebar-item ${activeTab === "general" ? "active" : ""}`}
              aria-current={activeTab === "general" ? "page" : undefined} onClick={() => setActiveTab("general")}>
              <span className="sidebar-icon"><SettingsIcon size={16} /></span>{lang === "zh" ? "通用" : "General"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "appearance" ? "active" : ""}`}
              aria-current={activeTab === "appearance" ? "page" : undefined} onClick={() => setActiveTab("appearance")}>
              <span className="sidebar-icon"><Palette size={16} /></span>{lang === "zh" ? "外观" : "Appearance"}
            </button>
            <div className="settings-nav-group-label">{lang === "zh" ? "模型与运行" : "Models & runtime"}</div>
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
            <div className="settings-nav-group-label">{lang === "zh" ? "对话与知识" : "Chat & knowledge"}</div>
            <button className={`settings-sidebar-item ${activeTab === "knowledge" ? "active" : ""}`}
              aria-current={activeTab === "knowledge" ? "page" : undefined} onClick={() => setActiveTab("knowledge")}>
              <span className="sidebar-icon"><BookOpenIcon size={16} /></span>{lang === "zh" ? "知识" : "Knowledge"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "automation" ? "active" : ""}`}
              aria-current={activeTab === "automation" ? "page" : undefined} onClick={() => setActiveTab("automation")}>
              <span className="sidebar-icon"><Bot size={16} /></span>{lang === "zh" ? "自动化" : "Automation"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "persona" ? "active" : ""}`}
              aria-current={activeTab === "persona" ? "page" : undefined} onClick={() => setActiveTab("persona")}>
              <span className="sidebar-icon"><BrainCircuit size={16} /></span>{lang === "zh" ? "人设" : "Persona"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "memory-checkup" ? "active" : ""}`}
              aria-current={activeTab === "memory-checkup" ? "page" : undefined} onClick={() => setActiveTab("memory-checkup")}>
              <span className="sidebar-icon"><BrainCircuit size={16} /></span>{lang === "zh" ? "记忆体检" : "Memory checkup"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "codegraph" ? "active" : ""}`}
              aria-current={activeTab === "codegraph" ? "page" : undefined} onClick={() => setActiveTab("codegraph")}>
              <span className="sidebar-icon"><Network size={16} /></span>{lang === "zh" ? "代码图谱" : "CodeGraph"}
            </button>
            <div className="settings-nav-group-label">{lang === "zh" ? "工具与权限" : "Tools & permissions"}</div>
            <button className={`settings-sidebar-item ${activeTab === "security" ? "active" : ""}`}
              aria-current={activeTab === "security" ? "page" : undefined} onClick={() => setActiveTab("security")}>
              <span className="sidebar-icon"><Shield size={16} /></span>{lang === "zh" ? "安全" : "Security"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "computer" ? "active" : ""}`}
              aria-current={activeTab === "computer" ? "page" : undefined} onClick={() => setActiveTab("computer")}>
              <span className="sidebar-icon"><MousePointer2 size={16} /></span>{lang === "zh" ? "电脑操作" : "Computer Use"}
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
            <div className="settings-nav-group-label">{lang === "zh" ? "连接与设备" : "Connections & devices"}</div>
            <button className={`settings-sidebar-item ${activeTab === "wechat" ? "active" : ""}`}
              aria-current={activeTab === "wechat" ? "page" : undefined} onClick={() => setActiveTab("wechat")}>
              <span className="sidebar-icon"><MessageCircle size={16} /></span>{lang === "zh" ? "微信 ClawBot" : "WeChat ClawBot"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "phone" ? "active" : ""}`}
              aria-current={activeTab === "phone" ? "page" : undefined} onClick={() => setActiveTab("phone")}>
              <span className="sidebar-icon"><Smartphone size={16} /></span>{lang === "zh" ? "连接手机" : "Phone Link"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "pet" ? "active" : ""}`}
              aria-current={activeTab === "pet" ? "page" : undefined} onClick={() => setActiveTab("pet")}>
              <span className="sidebar-icon"><PawPrint size={16} /></span>{lang === "zh" ? "宠物" : "Pet"}
            </button>
            <div className="settings-nav-group-label">{lang === "zh" ? "高级与帮助" : "Advanced & help"}</div>
            <button className={`settings-sidebar-item ${activeTab === "usage" ? "active" : ""}`}
              aria-current={activeTab === "usage" ? "page" : undefined} onClick={() => setActiveTab("usage")}>
              <span className="sidebar-icon"><Zap size={16} /></span>{lang === "zh" ? "用量统计" : "Usage"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "performance" ? "active" : ""}`}
              aria-current={activeTab === "performance" ? "page" : undefined} onClick={() => setActiveTab("performance")}>
              <span className="sidebar-icon"><Activity size={16} /></span>{lang === "zh" ? "性能" : "Performance"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "advanced" ? "active" : ""}`}
              aria-current={activeTab === "advanced" ? "page" : undefined} onClick={() => setActiveTab("advanced")}>
              <span className="sidebar-icon"><Zap size={16} /></span>{lang === "zh" ? "高级" : "Advanced"}
            </button>
            <button className={`settings-sidebar-item ${activeTab === "help" ? "active" : ""}`}
              aria-current={activeTab === "help" ? "page" : undefined} onClick={() => setActiveTab("help")}>
              <span className="sidebar-icon"><HelpCircle size={16} /></span>{lang === "zh" ? "帮助" : "Help"}
            </button>
          </div>

          <div className="settings-main">
          <div className="settings-content" ref={contentFade.ref} style={contentFade.style}>
          <header className="settings-page-head">
            <div>
              <h1>{lang === "zh" ? activeTabDef?.zh : activeTabDef?.en}</h1>
              <p>{lang === "zh" ? activeGroupDesc.zh : activeGroupDesc.en}</p>
            </div>
          </header>
          <div className="settings-subnav" role="tablist" aria-label={lang === "zh" ? "设置子页" : "Settings tabs"}>
            {activeGroup.tabs.map((tab) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  className={`settings-subnav-pill ${selected ? "active" : ""}`}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(tab.id as any)}
                >
                  <Icon />
                  {lang === "zh" ? tab.zh : tab.en}
                </button>
              );
            })}
          </div>
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
                  /* 切回 API 模式后把「更多」收起来：CLI 已经不在用，没必要占着一行 */
                  setShowMoreRunModes(false);
                }}
              >
                <span className="mode-icon"><Key className="icon-lg" /></span>
                <span className="mode-title">{S.settings.apiMode[lang]}</span>
                <span className="mode-desc">{S.settings.apiModeDesc[lang]}</span>
              </button>

              {/*
                第 186 轮：CLI 模式默认**不显示**，收在「更多」里按需展开。
                用户原话：「因为我不怎么用 CLI 模式了，把设置里的 CLI 模式隐藏吧，
                以后 mimo 也改成 api 模式登陆。在运行模式里加一个更多按钮，
                在更多里面用户可以自己选择 cli，平常不显示。」

                ⚠️ 三个必须同时成立的条件（少一个就会让人找不到自己的模式）：
                  ① `showMoreRunModes` 为真时显示；
                  ② **当前就是 CLI 时无条件显示** —— 否则正在用 CLI 的人打开设置只会看到
                     API 模式被选中，会以为自己的模式被改掉了；
                  ③ 展开按钮的文案随状态切换（更多 / 收起），并且带 `aria-expanded`。
              */}
              <button
                type="button"
                className="mode-btn mode-btn--more"
                aria-expanded={showMoreRunModes}
                onClick={() => setShowMoreRunModes((v) => !v)}
              >
                <span className="mode-icon"><Ellipsis className="icon-lg" /></span>
                <span className="mode-title">
                  {showMoreRunModes ? S.settings.lessOptions[lang] : S.settings.moreOptions[lang]}
                </span>
                <span className="mode-desc">{S.settings.moreOptionsHint[lang]}</span>
              </button>
            </div>

            {/*
              第 186 轮：CLI 模式**默认不显示**（收在「更多」里按需展开）。
              用户原话：「因为我不怎么用 CLI 模式了，把设置里的 CLI 模式隐藏吧，
              以后 mimo 也改成 api 模式登陆。在运行模式里加一个更多按钮，
              在更多里面用户可以自己选择 cli，平常不显示。」

              ⚠️ 这里是"**看起来收起**"（`mode-options--collapsed` 做 display:none），
              而不是"从 DOM 里摘掉"。两个理由都是硬的：
                ① 正在用 CLI 的人打开设置必须一眼看到自己的模式 ⇒ `settings.mode === "cli"` 时无条件可见；
                ② 收起时仍留在 DOM 里：整块卸载会让读屏与自动化都拿不到这个入口 ——
                   那就是「藏得连自己都找不到」，而不是"平常不显示"。
            */}
            <div className={`mode-options mode-options--extra ${showMoreRunModes || settings.mode === "cli" ? "" : "mode-options--collapsed"}`}>
                <button
                  className={`mode-btn ${settings.mode === "cli" ? "active" : ""}`}
                  onClick={() => {
                    /**
                     * D-9：切到 CLI 时**必须同一次写入里把模型也切成 MiMo 模型**。
                     *
                     * 旧写法只改 `mode`，于是 `codem-settings` 落下的是
                     * `{ mode: "cli", model: "deepseek-…" }`；而 `codem-settings-changed`
                     * 会立刻触发 `configureEngine`，它的"历史脏数据修正"看到
                     * "mode=cli 但 model 是 API 模型前缀"就判定为脏数据、把 mode 翻回 `api`
                     * **并回写落库**（`App.tsx:1701-1711` / `:1787-1790`）。
                     * 结果：面板仍显示 CLI 选中、库里已是 api —— 用户的选择静默无效。
                     * 把模型一起换掉，这次写入就不再是"脏数据"，自愈逻辑自然不触发。
                     */
                    const nextModel = MIMO_MODELS[0]?.id ?? "mimo-v2.5-pro";
                    const keepMimoModel = (settings.model || "").startsWith("mimo-");
                    const newSettings = {
                      ...settings,
                      mode: "cli" as const,
                      model: keepMimoModel ? settings.model : nextModel,
                    };
                    setSettings(newSettings);
                    setSettingJSON("codem-settings", newSettings);
                    window.dispatchEvent(new Event("codem-settings-changed"));
                  }}
                >
                  <span className="mode-icon"><Terminal className="icon-lg" /></span>
                  <span className="mode-title">{S.settings.cliMode[lang]}</span>
                  <span className="mode-desc">{S.settings.cliModeDesc[lang]}</span>
                </button>
            </div>
          </div>

          <div className="settings-rows">
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
                onChange={(e) => {
                  // D-23：模型下拉**只在本地 state 改**（保存时才落库）⇒ 记进"本地改动"集合，
                  // 保存时这一项以面板为准，而不是被库里的更晚写入顶掉（反之亦然）。
                  dirtyLocalFields.current.add("model");
                  setSettings({ ...settings, model: e.target.value });
                  /*
                   * 第 208 波（用户实报「选了 free 模型，对话却报 openai not configured」）：
                   * 在「等面板保存」这条路上，用户选了之后**没保存 / 找不到保存按钮**就什么都没发生，
                   * 而引擎手里那份默认模型还是启动时抄下来的旧副本 ⇒ 请求发去了老供应商。
                   * 现在**这个字段选中即落盘**（设置是唯一真相、引擎现读现用）；面板保存照旧可用。
                   */
                  try {
                    const current = getSettingJSON<Record<string, unknown>>("codem-settings", {}) || {};
                    setSettingJSON("codem-settings", { ...current, model: e.target.value });
                  } catch (err) {
                    console.warn("[SettingsPanel] 模型选择没能立刻落盘（面板保存仍可兜住）", err);
                  }
                }}
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
                  {/*
                    第 207 波（用户实报）：**把内置免费模型插件的模型也列进来**。
                    这里原来只列"有 apiKey 的供应商"，而托管那条供应商是**故意不落盘密钥**的
                    （密钥由插件在启动时运行时注册）⇒ 它被整个跳过，用户既选不到免费模型，
                    又会看到「请先配置 API Key」这句误导的话（免费模型本来就不需要 Key）。
                  */}
                  {/*
                    第 218 波（用户实报：「既然不行为什么设置里刷新模型的时候，还会出现这个模型」）：
                    只标注不够 —— 已知不可用的**直接从列表里拿掉**，别让用户再踩一次。
                    例外：**当前选中的那个要留着**（它带「当前不可用」后缀），否则用户不知道自己在用什么 ✗。
                  */}
                  {freeModelPlugin.readSetting().enabled &&
                    freeModelPlugin.models
                      .cached()
                      .filter((m) => m.id === settings.model || !freeModelPlugin.models.isUnavailable(m.id))
                      .map((m) => (
                      <option
                        key={`ofm-${m.id}`}
                        value={m.id}
                        title="来自内置的免费模型插件（Our Free Model）：不需要 API Key，由插件在本地提供；选中后会走插件的本地网关。"
                      >
                        {freeModelPlugin.name} - {m.name}
                        {/* 第 215 波（用户实报：刷出来的模型一调就报"上游不可用"）：
                            「刷得出来」不等于「能用」—— catalog 里没有可用性字段。
                            这里把**探测 / 真实调用**得到的结论标在名字上（结论过期就不标）。 */}
                        {freeModelPlugin.models.unavailableSuffix(m.id, lang === "zh" ? "zh" : "en")}
{isFreeModelId(m.id) ? freeModelPlugin.models.modalityLabel(m.id, lang === "zh" ? "zh" : "en") : ""}
                      </option>
                    ))}
                  {/*
                    第 218 波：隐藏了就要**如实说**（静默消失比看到不可用的模型更糟 —— 用户会以为模型丢了）。
                    结论带时间戳，过期就自动回来；点上面的【刷新模型列表】即可重新检测。
                  */}
                  {freeModelPlugin.readSetting().enabled &&
                    (() => {
                      const hidden = freeModelPlugin.models
                        .cached()
                        .filter((m) => m.id !== settings.model && freeModelPlugin.models.isUnavailable(m.id)).length;
                      return hidden > 0 ? (
                        <option value="" disabled>
                          {lang === "zh"
                            ? `（已隐藏 ${hidden} 个当前不可用的免费模型 —— 点上面的【刷新模型列表】会重新检测）`
                            : `(${hidden} unavailable free models hidden — run "Check availability" on the plugin card to refresh)`}
                        </option>
                      ) : null;
                    })()}
                  {settings.providers.filter(p => p.apiKey).map(p => {
                    // Use dynamic models if available, otherwise fall back to static list
                    const dynModels = dynamicModels[p.id];
                    if (dynModels && dynModels.length > 0) {
                      // 第 81 波：内置目录条目的**实证**健康状态（服务器到底认不认这个名字）。
                      // 被服务器拒绝过的条目沉到末尾并如实标注 —— 不删除，供应商可能改回来。
                      const health = getCatalogHealthFor(p.id);
                      const ordered = orderModelsByHealth(p.id, dynModels);
                      /*
                       * ★ 第 219 波（用户实报：升级到 314 后「刷新模型列表」**还是**列出 25 个、
                       *   不能用的照样出现）：我上一波只给"插件目录"那条渲染分支加了过滤 ✗，
                       *   而**刷新之后**模型来自这条 `dynamicModels` 分支 ⇒ 过滤被绕过。
                       *   教训：**同一个口径要在所有渲染模型选项的地方生效** —— 这里补上：
                       *   ① 已知不可用的免费模型不列出来（当前选中的除外，否则用户不知道在用哪个）；
                       *   ② 列出来的免费模型带上可用性后缀（「慢/超时」与「不可用」分开）。
                       */
                      return ordered
                        .filter(
                          (m) =>
                            !(
                              isFreeModelId(m.id) &&
                              freeModelPlugin.models.isUnavailable(m.id) &&
                              m.id !== settings.model
                            ),
                        )
                        .map(m => {
                        const h = health[m.id.toLowerCase()];
                        const rejected = h?.status === "rejected";
                        // 措辞必须区分来源：服务器**自己列出来**的模型也可能被拒（改名/灰度），
                        // 那时说"内置目录"就是错的 —— 用户会拿着错结论去查错地方。
                        const suffix = catalogModelLabelSuffix({ catalogOnly: m.catalogOnly, rejected });
                        const why = m.catalogOnly
                          ? "它来自 Codem 内置目录，可能已被供应商改名或下线；服务器 /models 的当前列表优先，请优先选择服务器列出的条目。"
                          : "它在服务器的 /models 列表里，但这次调用被拒；建议点『刷新』重新拉取列表，或改用手动添加的模型名。";
                        const title = rejected
                          ? `${describeCatalogHealth(h)}\n${why}`
                          : m.catalogOnly
                            ? "Codem 内置目录条目：服务器 /models 没有列出它，但它确实可以调用（例如 DeepSeek 的视觉实验模型）。服务器的当前列表优先。"
                            : undefined;
                        return (
                          <option key={m.id} value={m.id} title={title}>
                            {p.name} - {m.name}
                            {suffix}
                            {/* 第 219 波：本条分支（刷新后的 dynamicModels）也要带可用性后缀 */}
                            {isFreeModelId(m.id) ? freeModelPlugin.models.unavailableSuffix(m.id, lang === "zh" ? "zh" : "en") : ""}
{isFreeModelId(m.id) ? freeModelPlugin.models.modalityLabel(m.id, lang === "zh" ? "zh" : "en") : ""}
                          </option>
                        );
                      });
                    }
                    // Static fallback —— 服务器列表还没取到（没点过"刷新"或上次刷新失败）时用。
                    // 这些同样是**写死在源码里的名单**，必须如实标注来源：否则用户会把它们
                    // 当成"服务器给的"，进而以为是当前真相（与内置目录标注保持同一口径）。
                    //
                    // 有内置目录的 provider（`BUILTIN_MODEL_CATALOG`）走目录，不再走这份表 ——
                    // **一个名单只能有一个来源**（这里原来的 deepseek 两行就是目录的旧版副本，
                    // 里面的 `deepseek-v4-flash` 早已是旧名，留着只会某天被误当真）。
                    const staticModels: Record<string, Array<{id: string, name: string}>> = {
                      openai: [{id:"gpt-4o",name:"GPT-4o"},{id:"gpt-4o-mini",name:"GPT-4o Mini"},{id:"o3",name:"o3"}],
                      anthropic: [{id:"claude-sonnet-4-20250514",name:"Claude Sonnet 4"},{id:"claude-opus-4-20250514",name:"Claude Opus 4"}],
                      moonshot: [{id:"moonshot-v1-8k",name:"Moonshot 8K"},{id:"moonshot-v1-32k",name:"Moonshot 32K"},{id:"moonshot-v1-128k",name:"Moonshot 128K"}],
                      gemini: [{id:"gemini-2.5-flash",name:"Gemini 2.5 Flash"},{id:"gemini-2.5-pro",name:"Gemini 2.5 Pro"},{id:"gemini-2.0-flash",name:"Gemini 2.0 Flash"}],
                    };
                    const fallbackModels = catalogFor(p.id).length > 0 ? catalogFor(p.id) : staticModels[p.id] || [];
                    return fallbackModels.filter((m) => !(isFreeModelId(m.id) && freeModelPlugin.models.isUnavailable(m.id) && m.id !== settings.model)).map(m => (
                      <option
                        key={m.id}
                        value={m.id}
                        title="Codem 内置名单：还没有从服务器取到模型列表（或上次获取失败）。点这一行的『刷新』按钮按服务器实际返回的列表更新；内置名单可能已过期。"
                      >
                        {p.name} - {m.name}（内置目录，服务器列表未获取）
{isFreeModelId(m.id) ? freeModelPlugin.models.modalityLabel(m.id, lang === "zh" ? "zh" : "en") : ""}
                      </option>
                    ));
                  })}
                  {/*
                    第 206 波（用户实报）：这些选项原来只按"有没有 apiKey"筛，于是内置免费模型插件
                    那条（**故意不落盘密钥**，密钥在运行时注册）会显示成「请先配置 API Key」——
                    而免费模型**本来就不需要 Key**。这里把它单独说清楚。
                  */}
                  {!settings.providers.some(p => p.apiKey && p.id !== "mimo") && (
                    <option value="" disabled>
                      {settings.providers.some((p) => (p as { managedBy?: string }).managedBy === "free-model-plugin")
                        ? "内置免费模型插件已在运行：它的模型无需 API Key（在模型列表里直接选）"
                        : "请先配置 API Key"}
                    </option>
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
          </div>

</>
          )}
          {activeTab === "appearance" && (
          <>
          <SkinSelector />
          <div className="settings-rows">

          <div className="setting-group">
            <label>{lang === "zh" ? "提示音" : "Sound cues"}</label>
            <div className="sp-row sp-row--between">
              <span className="sp-note">
                {lang === "zh"
                  ? "发送 / 任务完成时播放合成提示音（WebAudio 现场合成，默认关闭）"
                  : "Play synthesized cues on send / turn completion (WebAudio, off by default)"}
              </span>
              <button
                className={`sp-toggle ${soundCues ? "is-on" : ""}`}
                role="switch"
                aria-checked={soundCues}
                aria-label={lang === "zh" ? "提示音" : "Sound cues"}
                onClick={() => {
                  const next = !soundCues;
                  setSoundCues(next);
                  setSetting(SOUND_CUES_SETTING_KEY, next ? "1" : "0");
                }}
              >
                <span className="sp-toggle-knob" />
              </button>
            </div>
          </div>

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
            <label>{lang === "zh" ? "对比度" : "Contrast"}</label>
            <select
              value={contrastMode}
              onChange={(e) => {
                const next = e.target.value as ContrastMode;
                if (!isContrastMode(next)) return;
                setContrastMode(next);
                // 第 159 轮：**这一行就是那个缺口补上的地方** —— 在这之前 `[data-contrast="high"]`
                // 的 CSS 写了、全项目却没有任何写入方（用户永远看不到高对比档）。
                applyContrastAttribute(next);
                setSetting(CONTRAST_SETTING_KEY, next);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
            >
              <option value="normal">{lang === "zh" ? "标准" : "Standard"}</option>
              <option value="high">{lang === "zh" ? "高对比（文字更黑、边框更实）" : "High contrast"}</option>
            </select>
          </div>

          <div className="setting-group">
            <label>{lang === "zh" ? "界面密度" : "Density"}</label>
            <select
              value={densityMode}
              onChange={(e) => {
                const next = e.target.value as DensityMode;
                if (!isDensityMode(next)) return;
                setDensityMode(next);
                applyDensityAttribute(next);
                setSetting(DENSITY_SETTING_KEY, next);
                window.dispatchEvent(new Event("codem-settings-changed"));
              }}
            >
              <option value="comfortable">{lang === "zh" ? "舒适（默认）" : "Comfortable"}</option>
              <option value="compact">{lang === "zh" ? "紧凑（控件更矮、留白更少）" : "Compact"}</option>
            </select>
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

          {/* 第 62 轮：凭据封存（方案 docs/CREDENTIALS-PLAN.md）。组件单独一个文件，便于单独测。 */}
          <SecretStorageSetting lang={lang} />

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
                /**
                 * D-3：生效点是 `--font-ui`（`body { font-family: var(--font-ui) }` 等 9 处消费），
                 * 不是 `--font-family` —— 后者全项目 **0 处** `var()` 引用（只是给外部插件留的
                 * 兼容别名），所以旧写法等于"选字体毫无效果"。
                 * 默认档由 `applyUiFontFamily` 走 `removeProperty`，避免裸字体名覆盖整条 fallback 栈。
                 */
                applyUiFontFamily(e.target.value);
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

          {/**
            * D-11：「恢复默认设置」此前**全项目不存在** —— 崩溃恢复卡上的那个按钮
            * （`AppErrorBoundary.tsx:155-168`，属禁区文件）只清 localStorage 里 `codem-*`
            * 开头的键，而真正的偏好（关闭行为、字号、字体、语言、主题）都在 DB 的 settings 表里，
            * 文案却承诺"将清除本地界面设置（关闭行为、窗口状态等偏好）"。这里补上真正的实现与入口：
            * 删 DB 里的界面偏好键 + 清 localStorage 镜像，**不碰**会话/项目/身份等数据。
            */}
          <div className="settings-divider" />

          <div className="setting-group">
            <label>{lang === "zh" ? "恢复默认界面设置" : "Reset UI Preferences"}</label>
            <div className="sp-hint sp-hint--tiny">
              {lang === "zh"
                ? "把主题、皮肤、语言、字号/字体/字重、关闭行为、对话显示模式、侧栏宽度恢复为默认；窗口尺寸/位置缓存一并清空。会话、项目、API Key 与身份配置不受影响。"
                : "Restore theme, skin, language, font size/family/weight, close behavior, display mode and sidebar width to defaults; window size/position cache is cleared too. Chats, projects, API keys and identity are untouched."}
            </div>
            <div className="sp-row">
              <button
                className="sp-btn"
                onClick={async () => {
                  const confirmText = lang === "zh"
                    ? "将把界面偏好恢复为默认值（主题、皮肤、语言、字号、字体、字重、关闭行为、显示模式、侧栏宽度、窗口尺寸/位置）。会话与项目数据不受影响。确定继续？"
                    : "Reset UI preferences to defaults (theme, skin, language, font size, family, weight, close behavior, display mode, sidebar width, window geometry)? Chats and projects are untouched.";
                  // ⚠️ 必须 `await`：dialog 插件的 `window.confirm` 返回 Promise（恒为真），见 native-dialog.ts
                  if (!(await confirmDialog(confirmText))) return;
                  const result = resetUiPreferencesToDefaults();
                  setFontFamily(readStoredUiFontFamily());
                  setFontWeight(getSetting("codem-font-weight") || "400");
                  applyStoredUiFont();
                  applyStoredUiFontFamily();
                  const total = result.removedKeys.length + result.patchedFields.length + result.clearedLocalKeys.length;
                  setResetNotice(
                    lang === "zh"
                      ? `已恢复 ${total} 项界面设置${result.failed.length > 0 ? `（${result.failed.length} 项未恢复：${result.failed.join("、")}）` : ""}`
                      : `Reset ${total} UI preference(s)${result.failed.length > 0 ? ` (${result.failed.length} failed: ${result.failed.join(", ")})` : ""}`,
                  );
                }}
              >
                {lang === "zh" ? "♻️ 恢复默认界面设置" : "♻️ Reset UI Preferences"}
              </button>
            </div>
            {resetNotice && <div className="sp-hint sp-hint--tiny">{resetNotice}</div>}
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
                    void alertDialog(lang === "zh" ? "头像大小不能超过 2MB" : "Avatar must be under 2MB");
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
            <div className="preset-avatar-grid" role="group" aria-label={lang === "zh" ? "预设头像" : "Preset avatars"}>
              {PRESET_AVATARS.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  /*
                   * 第 83 轮：这些按钮原来唯一的"名字"来自子元素 `<img alt="preset">` ——
                   * 50 个按钮的可访问名**全都是同一个无意义的 "preset"**（读屏念出来无法区分）。
                   * 现在给每个按钮一个能区分的名字 + `aria-pressed` 表达选中态。
                   */
                  aria-label={lang === "zh" ? `预设头像 ${i + 1}` : `Preset avatar ${i + 1}`}
                  aria-pressed={userConfig.avatar === url}
                  title={lang === "zh" ? `预设头像 ${i + 1}` : `Preset avatar ${i + 1}`}
                  onClick={() => setUserConfig({ ...userConfig, avatar: url })}
                  className={`sp-avatar--sm sp-avatar ${userConfig.avatar === url ? "is-active" : ""}`}
                >
                  <img src={url} alt="" className="sp-avatar-img" />
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

              {/* DeepSeek 专属：联网能力（Search / Fetch）。两个开关默认关闭 —— 按成功次数计费。 */}
              {provider.id === "deepseek" && (
                <div className="setting-group">
                  <label>
                    {lang === "zh" ? "联网能力（DeepSeek Search / Fetch）" : "Web tools (DeepSeek Search / Fetch)"}
                  </label>
                  <div className="sp-note sp-note--tight">
                    {lang === "zh"
                      ? "每次成功调用计费 5 元/1000 次（Search 有结果、Fetch 取到正文才计费，失败或无结果不计费）；Search 与 Fetch 各自独立 QPS 5。默认关闭 —— 付费能力需要你显式开启。"
                      : "Each successful call costs ¥5 per 1000 (only billed when Search returns results or Fetch returns body text; failures and empty results are free). Search and Fetch have independent QPS 5. Off by default — paid capabilities need explicit opt-in."}
                  </div>

                  {!provider.apiKey && (
                    <div className="sp-hint">
                      {lang === "zh"
                        ? "未检测到 DeepSeek API Key：先在上方填写并点「保存并刷新」，两个开关才会启用。"
                        : "No DeepSeek API key yet: fill it in above and click Save & Refresh — the switches stay disabled until then."}
                    </div>
                  )}

                  <ToggleEntry
                    label={lang === "zh" ? "网页搜索（DeepSeek Search）" : "Web search (DeepSeek Search)"}
                    description={
                      lang === "zh"
                        ? "让 web_search 优先走 DeepSeek 真实检索（返回 title/url/snippet/summary/权威度）。开启后失败会直接报原因，不会静默回退到凭记忆的旧后端。"
                        : "Makes web_search use DeepSeek real search first (title/url/snippet/summary/authority). Failures are reported instead of silently falling back."
                    }
                    value={deepseekWeb.searchEnabled}
                    disabled={!provider.apiKey}
                    onChange={(next) => {
                      setDeepSeekSearchEnabled(next);
                      setDeepseekWeb(readDeepSeekWebConfig());
                    }}
                  />

                  <ToggleEntry
                    label={lang === "zh" ? "网页抓取（DeepSeek Fetch）" : "Web fetch (DeepSeek Fetch)"}
                    description={
                      lang === "zh"
                        ? "开放 web_fetch 工具：把指定 URL 的正文取回为 Markdown（超过 20 KB 会截断并标注）。关闭时该工具一律拒绝，不发任何请求。"
                        : "Enables the web_fetch tool: returns a page's body as Markdown (truncated and labelled above 20 KB). When off, the tool is refused without any request."
                    }
                    value={deepseekWeb.fetchEnabled}
                    disabled={!provider.apiKey}
                    onChange={(next) => {
                      setDeepSeekFetchEnabled(next);
                      setDeepseekWeb(readDeepSeekWebConfig());
                    }}
                  />

                  <ConfigEntry
                    label={lang === "zh" ? "每次搜索条数" : "Results per search"}
                    description={
                      lang === "zh"
                        ? `范围 1~${DEEPSEEK_MAX_SEARCH_COUNT}，缺省 ${DEEPSEEK_DEFAULT_SEARCH_COUNT}。模型在调用时显式指定条数时以模型为准。`
                        : `Range 1~${DEEPSEEK_MAX_SEARCH_COUNT}, default ${DEEPSEEK_DEFAULT_SEARCH_COUNT}. An explicit num_results from the model wins.`
                    }
                  >
                    <input
                      type="number"
                      min={1}
                      max={DEEPSEEK_MAX_SEARCH_COUNT}
                      value={deepseekWeb.searchCount}
                      aria-label={lang === "zh" ? "每次搜索条数" : "Results per search"}
                      disabled={!provider.apiKey}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value, 10);
                        setDeepSeekSearchCount(Number.isFinite(next) ? next : DEEPSEEK_DEFAULT_SEARCH_COUNT);
                        setDeepseekWeb(readDeepSeekWebConfig());
                      }}
                      className="sp-input sp-input--compact"
                    />
                  </ConfigEntry>

                  {/* 实际请求地址：与工具侧同一个解析函数，避免"面板写的和真正打的"不是一条链 */}
                  <div className="sp-hint">
                    {lang === "zh"
                      ? `实际使用的 base URL（只读，改上面的 Base URL 需保存后生效）：${deepseekToolBaseUrl(deepseekWeb.baseUrl)}`
                      : `Base URL in use (read-only; a change to Base URL above applies after saving): ${deepseekToolBaseUrl(deepseekWeb.baseUrl)}`}
                  </div>
                </div>
              )}

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

              {/**
               * 2026-10-17（用户实报：「卡片里那个是『保存并刷新模型』（只管模型列表）这个不对，会误导用户」）。
               *
               * 这里原来是一条**裸写** —— `setSettingJSON("codem-settings", { ...settings })`：
               * 只把面板快照整块塞进库，**不经过上面那条规范保存流程** `handleSave()`
               * （没有 `beginSettingsWriteProbe()` 的写后确认、没有 `buildSavePayload()`
               * 以库值做基座、没有 `dirtyLocalFields` 结账，也就没有"凭据必须封存"的保证）。
               * 用户真机复现：在 DeepSeek 卡片里填完 API Key（35 字符）连点两次，库里**没有**
               * `apiKeySealed`；改点底部「保存设置」（走 `handleSave`）才立刻出现。
               * 也就是说这个按钮宣称的"保存"对凭据类改动**是不成立的** ——
               * 真正兑现的语义只剩"刷新模型列表"。
               * ⚠️ 补封存是写回闸门**异步**补做的（单测里裸写也能补上），所以这里缺的不只是
               * "那一行封存"，而是规范保存的整套：**可等待的写后确认** + 以库值为基座做合并 +
               * 本地改动结账 + 如实报失败 —— 用户看到的形态正是"点了没存上"。
               *
               * 修法选**让它名副其实**（标签不变）：先 `handleSave()`，**确认落库之后**
               * 才刷新这个 provider 的模型列表；没确认（`false`）就什么都不刷。
               * 两半都写在标签里，所以两半都必须真的发生。
               *
               * 不会双写、也不会重复触发：`handleSave()` 本身不刷新模型列表，
               * 而 `refreshProviderModels()` 只写 `codem-dynamic-models`，不碰 `codem-settings`。
               */}
              <button
                onClick={async () => {
                  const confirmed = await handleSave();
                  if (!confirmed) return;
                  await refreshProviderModels(provider.id);
                }}
                disabled={refreshingModels[provider.id]}
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
                checked={sandboxOn}
                onChange={(e) => {
                  const next = e.target.checked;
                  setSandboxOn(next);
                  // 第 87 波：走统一入口（与 AgenticLoop 读的是同一个键），写入失败当场提示
                  if (!setSandboxAclEnabled(next)) {
                    showToast(
                      "error",
                      lang === "zh"
                        ? "沙箱设置未能写入数据库：本次运行内生效，重启后会回到旧值。"
                        : "Failed to persist the sandbox setting: it applies for this session only.",
                      7000,
                    );
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
            {/*
              允许目录（2026-10-18）：交接正文里的绝对路径常在工作区外，提示条可以一键把这些目录加进来。
              ⚠️ 必须能移除 —— 加进来的是**真实文件访问权限**，只进不出就是把"可撤销"说成假的。
            */}
            {sandboxOn && (
              <div className="sp-note sp-note--spaced">
                <div>
                  {lang === "zh" ? "沙箱允许目录（工作区外额外放行）" : "Sandbox allowlist (extra readable folders)"}
                </div>
                {allowedDirs.length === 0 ? (
                  <div className="hint-sm">
                    {lang === "zh" ? "暂无。交接时若正文里有工作区外的路径，会出现「加入允许目录」的提示。" : "None. Handovers with out-of-workspace paths will offer to add them."}
                  </div>
                ) : (
                  <ul className="sp-allowlist">
                    {allowedDirs.map((dir) => (
                      <li key={dir} className="sp-allowlist-item">
                        <span className="sp-allowlist-path" title={dir}>{dir}</span>
                        <button
                          type="button"
                          className="sp-btn sp-btn--sm"
                          onClick={() => {
                            removeSandboxAllowedDir(dir);
                            setAllowedDirs(getSandboxAllowedDirs());
                          }}
                          title={lang === "zh" ? "从允许目录移除" : "Remove from allowlist"}
                        >
                          {lang === "zh" ? "移除" : "Remove"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
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
        Codem v{APP_VERSION}
        <br />
        {lang === "zh" ? "AI 编程助手 — 本地优先，隐私安全" : "AI Coding Assistant — Local-first, Privacy-focused"}
      </div>
      <button
        id="check-update-btn"
        className="sp-btn sp-btn--primary sp-btn--spaced"
        disabled={updateBusy}
        onClick={async () => {
          /**
           * 文案一律走 state（第 62 轮真机复量：原来改 `textContent`，任何重渲染都会把它抹掉）。
           * 这里不再碰 DOM：`disabled` 与文字都由 React 渲染。
           */
          setUpdateBusy(true);
          setUpdateMsg(lang === "zh" ? "检查中…" : "Checking…");
          try {
            const { check } = await import("@tauri-apps/plugin-updater");
            const { relaunch } = await import("@tauri-apps/plugin-process");
            const { decideUpdate } = await import("../core/update/check-update");
            const { downloadWithRetry, describeUpdateError } = await import("../core/update/update-retry");
            const update = await check();
            /**
             * 第 62 轮：**不许无条件说"已是最新版本"**。
             *
             * 拿不到更新有两种原因，而界面原来只看得到一种：①真的没有更新；
             * ②**清单没读到**（网络问题，或刚发布会话里实测过的 **CDN 传播延迟**）。
             * 判定与措辞都交给纯函数 `decideUpdate`（有单测），这里只负责显示与动作：
             * 只有"清单版本确实高于本机"才安装；**清单版本更旧**（缓存的旧清单）明确拒绝并说明。
             */
            const decision = decideUpdate(APP_VERSION, update?.available ? update.version : null);
            if (decision.kind === "update" && update) {
              setUpdateMsg(lang === "zh" ? decision.message.zh : decision.message.en);
              /**
               * 第 82 轮：**有界重试**（O-9）。真机现场：这台机器的网络会把 40MB 安装包掐断
               * （独立 curl 第一次在 27MB 处 exit 56），而应用一次失败就放弃、还把
               * `error decoding response body` 原样印给用户。现在：
               * - 可恢复的传输类错误最多重试 3 次（退避 800→1600ms），界面显示"第 n/N 次尝试"；
               * - **签名/校验类错误一次就抛**（重试没有意义，还会把严重问题稀释成"网络不好"）；
               * - 次数用尽后由 `describeUpdateError` 翻成"发生了什么 + 下一步"，并保留原文。
               */
              const { applyProgressEvent, emptyProgress } = await import("../core/update/download-progress");
              setUpdateProgress(emptyProgress());
              /*
               * 第 212 波：安装前**先把内置插件停掉**。
               *
               * 没有够新的系统 Node 时，插件会运行**安装目录里**那份内置 Node
               * ⇒ 安装程序覆盖该文件时报「无法打开要写入的文件」（用户实报）。
               * 停掉它既释放句柄，也让升级过程中没有任何属于我们的进程占着安装目录。
               * 停掉 ≠ 禁用：`enabled` 设置保持 true，重装重启后启动钩子会把它再带起来。
               */
              try {
                await freeModelPlugin.stop();
              } catch (e) {
                console.warn("[updater] 安装前停止内置插件失败（继续安装：安装钩子还会再收一次）", e);
              }
              await downloadWithRetry(
                () =>
                  update.downloadAndInstall((event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
                    /* 每个事件都并进状态 ⇒ 进度条会动；总量未知时界面走不确定态（不编百分比） */
                    setUpdateProgress((prev) => applyProgressEvent(prev ?? emptyProgress(), event));
                  }),
                {
                attempts: 3,
                baseDelayMs: 800,
                onAttempt: ({ attempt, total, waitedMs }) => {
                  if (attempt === 1) return; // 第一次沿用上面那句"正在下载"
                  /* 重试 ⇒ 进度归零重算（否则会出现 80% 又跳回 10% 的假动作） */
                  setUpdateProgress((prev) =>
                    prev ? { ...prev, downloadedBytes: 0, percent: prev.totalBytes ? 0 : null } : null,
                  );
                  setUpdateMsg(
                    lang === "zh"
                      ? `下载中断，正在重试（第 ${attempt}/${total} 次${waitedMs ? `，等了 ${Math.round(waitedMs / 1000)}s` : ""}）…`
                      : `Download interrupted, retrying (attempt ${attempt}/${total}${waitedMs ? `, waited ${Math.round(waitedMs / 1000)}s` : ""})…`,
                  );
                },
              });
              setUpdateMsg(lang === "zh" ? "安装完成，即将重启…" : "Installed, relaunching…");
              setUpdateProgress(null);
              await relaunch();
            } else {
              console.warn(`[updater] 未安装更新：${decision.kind}（清单版本 ${decision.offered ?? "无"}）`);
              setUpdateMsg(lang === "zh" ? decision.message.zh : decision.message.en);
              setUpdateBusy(false);
            }
          } catch (err: any) {
            const rawMsg = typeof err === "string" ? err
              : err?.message ? err.message
              : err?.code ? `Code: ${err.code}`
              : "";
            // If the remote release JSON is missing, offer a direct GitHub link instead
            const isNoRelease = rawMsg.includes("Could not fetch") || rawMsg.includes("release JSON");
            if (isNoRelease) {
              setUpdateMsg(lang === "zh" ? "自动更新不可用，正在打开下载页…" : "Auto-update unavailable, opening download page…");
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
              setUpdateBusy(false);
            } else {
              /*
               * 第 82 轮：错误措辞收口到 `describeUpdateError`（纯函数、有单测）。
               * 改前是 `更新失败: ${rawMsg}` —— 用户看到的是 `error decoding response body`
               * 这种 reqwest 原文，既读不出原因也读不出下一步。
               */
              const { describeUpdateError } = await import("../core/update/update-retry");
              setUpdateMsg(
                lang === "zh" ? `更新失败：${describeUpdateError(err, "zh")}` : `Update failed: ${describeUpdateError(err, "en")}`,
              );
              setUpdateBusy(false);
            }
          }
        }}
      >
        {updateMsg ?? (lang === "zh" ? "检查更新" : "Check for Updates")}
      </button>

      {/*
        第 204 波（用户实报「正在下载，看不到进度条，进度条一直不动」）：下载时给一根**真的**进度条。
        以前这里什么都没有 —— 只有上面按钮里那句静态文案，而事件回调也没接（进度无从谈起）。

        两种形态都如实呈现：
        - 知道总量 ⇒ 有百分比的确定态（`aria-valuenow` 也跟着走，读屏可感知）；
        - 不知道总量（有些源不回 Content-Length）⇒ **不确定态**，只报"已下载 x"，不编百分比。
      */}
      {updateProgress && (
        <div className="sp-update-progress">
          <div
            className={`sp-update-progress-track${updateProgress.percent === null ? " is-indeterminate" : ""}`}
            role="progressbar"
            aria-label={lang === "zh" ? "更新下载进度" : "Update download progress"}
            {...(updateProgress.percent === null
              ? {}
              : { "aria-valuenow": updateProgress.percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
          >
            <div
              className="sp-update-progress-fill"
              style={updateProgress.percent === null ? undefined : { width: `${updateProgress.percent}%` }}
            />
          </div>
          <div className="sp-update-progress-label">
            {lang === "zh" ? updateProgress.label.zh : updateProgress.label.en}
          </div>
        </div>
      )}
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
{/* 记忆体检：三级分组 + 来源三态 + 归属未知单列（数据层复用 MemoryService） */}
{activeTab === "memory-checkup" && (
  <div className="sp-card">
    <MemoryCheckupView
      projectId={projectIdFromCwd(useProjectStore.getState().currentProject?.path)}
      sessionId={useProjectStore.getState().currentSession?.id}
      onNavigate={(target) => {
        /*
         * 「归属」那一栏是可点的：跳到对应项目/对话要**真的切过去**（切不动就如实说一句），
         * 而不是静默关闭设置面板。
         */
        const store = useProjectStore.getState();
        if (target.projectId) {
          const project = store.projects.find((p) => projectIdFromCwd(p.path) === target.projectId || p.id === target.projectId);
          if (project) store.openProject(project.id);
        }
        if (target.sessionId) {
          const session = store.sessions.find((s) => s.id === target.sessionId);
          if (session) {
            if (session.projectId && session.projectId !== store.currentProject?.id) store.openProject(session.projectId);
            useProjectStore.getState().switchSession(session.id);
          }
        }
        onClose?.();
      }}
    />
  </div>
)}
          </div>
          </div>
        </div>

        <div className="settings-footer">
          <div className="settings-footer-inner">
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
          {saveFailure && <span className="sp-hint">{saveFailure}</span>}
          <button className="save-btn" onClick={() => { void handleSave(); }}>{S.settings.saveSettings[lang]}</button>
          </div>
        </div>
      </div>
      <PetMarketDialog open={showPetMarket} onClose={() => setShowPetMarket(false)} />
    </div>
  );
}

// ========== Pet Settings Section ==========

function PetSettingsSection({ lang, onOpenMarket }: { lang: Language; onOpenMarket: () => void }) {
  const zh = lang === "zh";
  /** 卸载失败提示 —— 卸载失败必须可见，否则界面像是"点了没反应" */
  const [petActionError, setPetActionError] = useState<string | null>(null);
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
        {/* 纯图标开关：走查量到"无任何可访问名"（`.sp-toggle` 内只有一个 knob）⇒ 补名。
            只加属性（不动类名/内联样式），语义与 `.toggle-entry` 开关保持一致。 */}
        <button
          onClick={() => setEnabled(!enabled)}
          className={`sp-toggle ${enabled ? "is-on" : ""}`}
          role="switch"
          aria-checked={enabled}
          aria-label={zh ? "启用桌面宠物" : "Enable Desktop Pet"}
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
          <div className="empty-hint is-boxed">
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
                      setPetActionError(null);
                      const result = await uninstallPet(pet.slug);
                      if (!result.success) {
                        setPetActionError(result.error || (zh ? "卸载失败" : "Uninstall failed"));
                      }
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

function SecurityModeSelector({
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
      // ⚠️ 必须 `await`：dialog 插件的 `window.confirm` 返回 Promise（恒为真），见 native-dialog.ts
      if (!(await confirmDialog(zh ? `工作树 ${wt.sessionId} 有未提交修改，确认删除？` : `Worktree ${wt.sessionId} has uncommitted changes. Delete anyway?`))) {
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

  const handleDelete = async (id: string) => {
    // ⚠️ 必须 `await`：dialog 插件的 `window.confirm` 返回 Promise（恒为真），见 native-dialog.ts
    if (await confirmDialog(zh ? "确认删除此 Profile？" : "Delete this profile?")) {
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
            <button onClick={() => { void handleSave(); }} className="sp-btn sp-btn--sm sp-btn--primary">{zh ? "保存" : "Save"}</button>
            <button onClick={() => setEditing(null)} className="sp-btn sp-btn--sm sp-btn--ghost">{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}

      {profiles.length === 0 && !editing && (
        <div className="empty-hint">{zh ? "暂无 Agent Profile" : "No agent profiles yet"}</div>
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
      /**
       * ⚠️ 第 47 轮补：这里原来是 `require("../core/mcp/mcp")` —— 在 ESM 里必抛
       * `ReferenceError`，被 `catch { return true; }` 吞掉，于是开关**永远显示 ON**
       * （哪怕库里存着 false）。现在读**真正的设置键**（同步，首帧就有值，
       * 不会先闪一下 ON 再改），组件的 effect 里再用 `isCodeGraphEnabled()` 校正一次。
       */
      const raw = getSetting("codem-codegraph-enabled");
      // 缺省 ON（与既有产品语义一致：没设置过就是开启）
      return raw === null ? true : raw === "true" || raw === "1";
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
      // 第 61 波（死字段排查）：原来是 getSetting("codem-current-project-path") ——
      // 这个键**全项目没有任何写入方**，所以永远是空串，codegraph 的"索引检测"从来没生效过。
      // 当前项目路径的正确来源是 project store（同一份数据，且一定是最新的）。
      const p = useProjectStore.getState().currentProject?.path || "";
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

  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P1）：开关必须**真的**生效，且失败必须看得见
   *
   * 这一段原来用 `require("../core/mcp/mcp")` —— 而这是**浏览器 ESM** 组件
   * （`index.html` 用 `<script type="module">`，构建产物里没有 `require` shim），
   * 所以那四个 `require(...)` **一律抛 `ReferenceError`**，然后被**空 `catch {}`** 吞掉。
   *
   * 后果（用户可见的部分）：
   * - 开关只翻转本地 state：`codem-codegraph-enabled`（真正的闸门）永不写入，
   *   MCP 服务器不连也不断，事件永不派发；
   * - 初始化那段 `catch { return true; }` 让开关**永远显示 ON**，
   *   哪怕库里存着 `false` —— 用户以为"已经关掉了"；
   * - 「重新检测」第一句就抛 → **所有机器**都显示"✗ codegraph CLI 未安装"；
   * - 「一键安装」在真实安装成功之后抛 → 告诉用户"✗ 安装失败"。
   *
   * 修法：改成**动态 `import()`**（异步、可 await），并且**失败不再静默** ——
   * 走既有的上报通道（`reportActionFailure`）+ 面板内可见提示。
   * 为什么不用顶层静态 import：那段 MCP 依赖较重，而设置面板是启动路径的一部分，
   * 不该为一个可选集成把它拖进首屏包。
   */
  const handleToggle = async (checked: boolean) => {
    setEnabled(checked);
    try {
      const { setCodeGraphEnabled, disconnectCodeGraph, getMCPRegistry } = await import("../core/mcp/mcp");
      setCodeGraphEnabled(checked);
      if (!checked) {
        disconnectCodeGraph(getMCPRegistry());
      }
      window.dispatchEvent(new CustomEvent("codem-codegraph-config-changed", { detail: { enabled: checked } }));
      setInstallMsg("");
    } catch (e) {
      // 写失败不能假装成功：把开关拨回去 + 明确告诉用户
      setEnabled(!checked);
      const msg = e instanceof Error ? e.message : String(e);
      setInstallMsg(zh ? `✗ 代码图谱开关未生效：${msg}` : `Toggle failed: ${msg}`);
      reportActionFailure("settings.codegraph.toggle", e, "代码图谱开关未生效");
    }
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


