import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

// ====== Cordis 插件系统初始化（P4.3） ======
// 创建全局 Cordis Context 并加载桥接插件。
// 所有核心服务（LLM、Tools、Session 等）通过 ctx.provide() 注册为可替换的服务。
import { Context } from "./core/cordis/src/index.ts";
import { SlotsService } from "./core/slots/index.ts";
import { bridgePlugin } from "./core/provider/bridge-plugin";
import { setActiveContext } from "./core/consumer";

// 全局 Cordis Context（App 生命周期内唯一）
let _codemCtx: Context | null = null;

async function getCordisContext(): Promise<Context> {
  if (_codemCtx) return _codemCtx;
  const ctx = new Context();
  // 安装 Slot Registry Service
  ctx.plugin(SlotsService as any);
  // 加载桥接插件（注册 49 个核心服务）
  ctx.plugin(bridgePlugin as any);
  // 设置活跃 Context，让工具 Consumer 包可以使用
  setActiveContext(ctx);

  // === P6: 接入 PluginLoader + UI 插件 ===
  const { PluginLoader } = await import("./core/plugin-loader/index.ts");
  const { loadUIPlugins } = await import("./core/ui-plugins/index.ts");
  // PluginLoader 可扫描和加载插件包
  const loader = new PluginLoader(ctx);
  await loader.scan();
  // 暂不调用 loader.load()，因为插件已在 bridgePlugin 中注册
  // 加载所有 UI 插件包（注册到 Slot Registry）
  loadUIPlugins(ctx);

  _codemCtx = ctx;
  return ctx;
}
// ====== Cordis 插件系统初始化结束 ======
import { RefreshCw, X, MessageSquare, Terminal, BookOpen, Save, FolderOpen, PencilLine, Trash2, CheckCircle, Menu, Hammer, ClipboardList, Search, Bot } from "lucide-react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { BootSplash } from "./components/BootSplash";
import { WorkspaceBackdrop } from "./components/WorkspaceBackdrop";
import { ToastContainer } from "./components/ToastNotification";
import { ChatPanel } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { FileExplorer } from "./components/FileExplorer";
import { FileEditor } from "./components/FileEditor";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProjectManager } from "./components/ProjectManager";
import { ConfigEditor } from "./components/ConfigEditor";
import { BootstrapWizard } from "./components/BootstrapWizard";
import type { CollaborationMode } from "./core/agent/agent";
import { getEffectiveSecurityMode, type SecurityMode } from "./core/permission/security-mode";
import { PermissionDialog } from "./components/PermissionDialog";
import { DecisionTray, type ApprovalRequest } from "./components/DecisionTray";
import { RightSidebar } from "./components/RightSidebar";
import { Drawer } from "./components/Drawer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NeedsYouPanel } from "./components/NeedsYouPanel";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { McpManager } from "./components/McpManager";
import { SkillManager } from "./components/SkillManager";
import { MemoryManager } from "./components/MemoryManager";
import { SessionRecovery } from "./components/SessionRecovery";
import { UsageStats } from "./components/UsageStats";
import { TaskCenter, type TaskCenterTab } from "./components/TaskCenter";
import { AgentManager } from "./components/AgentManager";
import { DiffViewer } from "./components/DiffViewer";
import { InlineDiffReview } from "./components/InlineDiffReview";
import { InteractiveFormDialog } from "./components/InteractiveFormDialog";
import { PromptChangeReviewDialog } from "./components/PromptChangeReviewDialog";
import { NotebookManager } from "./components/NotebookManager";
import { NotebookWorkspace } from "./components/NotebookWorkspace";
import { SourceViewer } from "./components/SourceViewer";
import { setActiveSourceFilter as setNotebookSourceFilter, createNote, listSources } from "./core/knowledge";
import { GitHubCloneDialog } from "./components/GitHubCloneDialog";
import { CicdPanel } from "./components/CicdPanel";
import { PerformanceDashboard } from "./components/PerformanceDashboard";
import { PlanApprovalCard } from "./components/PlanApprovalCard";
import { setPlanApprovalCallback, clearPlanApprovalCallback } from "./core/llm/tools/exit-plan-mode";
import { SearchDialog } from "./components/SearchDialog";
import { usePetStore } from "./core/pet/pet-store";
import { loadInstalledPets as loadInstalledPetsPets } from "./core/pet/pet-manager";
import { getSessionMessageBus, getDelegationOrchestrator, executeSessionTurn, isSessionExecuting } from "./core/session";
import type { InteractiveFormQuestion, PromptChange } from "./core/llm/tools";
import { useAppStore } from "./store";
import { useProjectStore } from "./core/store";
import { loadAppIdentity } from "./core/config/loader";
import { AppIdentity, type Session } from "./core/types";
import { getLLMEngine } from "./core/llm";
import { getMiMoAuth } from "./core/auth/mimo";
import type { PermissionRequest, PermissionResult } from "./core/permission/permission";
import { initDatabase, resetDatabase, flushDatabase } from "./core/storage";
import { getModelProfileManager } from "./core/llm/model-profile";
import { migrateFromLocalStorage } from "./core/storage/migration";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "./core/storage/settings";
import { setLang, useLang, S } from "./core/i18n/lang";
import * as MessageStorage from "./core/storage/message";
import { formatAttachmentsInline } from "./core/llm/attachment-formatter";
import { syncAttachmentsToWorkspace } from "./core/llm/attachment-sync";
import { ThemeManager, useSkin } from "./core/theme";
import { HubLayout } from "./components/HubLayout";
import { DreamLayout } from "./components/DreamLayout";
import { OnboardingTour } from "./components/OnboardingTour";
import { QuickAccessCards } from "./components/QuickAccessCards";
import { CorrectionResultPanel } from "./components/CorrectionResultPanel";
import { ClarificationForm } from "./components/ClarificationForm";
import { PipelineNextStepDialog } from "./components/PipelineNextStepDialog";
import { getAgentRegistry } from "./core/agent/agent";
import type { ClarificationFormData } from "./core/llm/agentic-loop";
import { runSetupScript, runCleanupScript } from "./core/environment";

/**
 * 动态获取应用根目录（用户主目录）。
 * 不再写死 D:\mimo，而是从 Tauri 运行时获取用户主目录。
 */
let _appRootCache: string | null = null;
async function getAppRoot(): Promise<string> {
  if (_appRootCache) return _appRootCache;
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (invoke) {
      _appRootCache = (await invoke("get_default_cwd")) as string;
      return _appRootCache;
    }
  } catch {}
  _appRootCache = "D:\\mimo";
  return _appRootCache;
}

// 同步 fallback：在异步 getAppRoot 完成前使用
const APP_ROOT_FALLBACK = "D:\\mimo";
type BottomTab = "chat" | "terminal";

function getCliSessionKey(projectId: string, sessionId: string) {
  return `codem-cli-session-${projectId}-${sessionId}`;
}

function loadCliSessionId(projectId: string, sessionId: string): string | null {
  try {
    return getSetting(getCliSessionKey(projectId, sessionId));
  } catch {}
  return null;
}

function saveCliSessionId(projectId: string, sessionId: string, mimoSessionId: string) {
  try {
    setSetting(getCliSessionKey(projectId, sessionId), mimoSessionId);
  } catch {}
}

function getMode(): "cli" | "api" {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    return settings.mode || "api";
  } catch {}
  return "api";
}

function App() {
  const lang = useLang();
  const { messages, addMessage, appendToMessage, setStreaming, isStreaming, addToolCall, updateToolCall, loadMessages, saveMessages, setLLMStatus, addGuidanceMessage, markGuidanceConsumed, clearGuidanceMessages } = useAppStore();
  const { currentProject, currentSession, createSession, dbReady, loadFromDB } = useProjectStore();

  // P4.3: 初始化 Cordis 插件系统
  // 在 App 挂载时创建全局 Context，加载桥接插件和 Slot Registry。
  // 所有核心服务通过 ctx.provide() 注册后，插件可以通过 ctx.get() 消费。
  const [cordisReady, setCordisReady] = useState(false);
  useEffect(() => {
    getCordisContext().then(() => {
      setCordisReady(true);
    }).catch((err) => {
      console.error("Failed to initialize Cordis context:", err);
      // 即使 Cordis 初始化失败，也继续运行现有功能
      setCordisReady(true);
    });
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);
const [rightRailOpen, setRightRailOpen] = useState(false);
  // P3 #46: Mobile sidebar drawer
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [appRoot, setAppRoot] = useState<string>(APP_ROOT_FALLBACK);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>("general");
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showMcpManager, setShowMcpManager] = useState(false);
  const [showSkillManager, setShowSkillManager] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
  const [showNotebookManager, setShowNotebookManager] = useState(false);
  const [showGitHubClone, setShowGitHubClone] = useState(false);
const [showCicdPanel, setShowCicdPanel] = useState(false);
const [showPerfDashboard, setShowPerfDashboard] = useState(false);
const [planApproval, setPlanApproval] = useState<{ plan: string; resolve: (result: { approved: boolean; feedback?: string }) => void } | null>(null);
  const [showSearchDialog, setShowSearchDialog] = useState(false);
const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
const [activeNotebookName, setActiveNotebookName] = useState<string>('');
const [notebookWorkspaceId, setNotebookWorkspaceId] = useState<string | null>(null);
const [notebookWorkspaceName, setNotebookWorkspaceName] = useState<string>('');
// Citation viewer — opens SourceViewer when user clicks [Source: name] in chat
const [citationViewer, setCitationViewer] = useState<{ sourceId: string; notebookId: string; chunkIndex?: number } | null>(null);
  const [showSessionRecovery, setShowSessionRecovery] = useState(false);
  const [showUsageStats, setShowUsageStats] = useState(false);
const [showTaskCenter, setShowTaskCenter] = useState(false);
const [taskCenterTab, setTaskCenterTab] = useState<TaskCenterTab>("overview");
const [showAgentManager, setShowAgentManager] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>("chat");
  const [fileExplorerProjectId, setFileExplorerProjectId] = useState<string | null>(null);
  const [fileExplorerRefreshKey, setFileExplorerRefreshKey] = useState(0);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [appIdentity, setAppIdentity] = useState<AppIdentity | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [bootSplashVisible, setBootSplashVisible] = useState(true);
  const [bootSplashPhase, setBootSplashPhase] = useState<"initializing" | "loading-db" | "loading-config" | "ready">("initializing");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  // P2: Onboarding tour — shown on first launch (after DB is ready)
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showOnboardingReplay, setShowOnboardingReplay] = useState(false);
  // Check onboarding flag after DB is initialized (dbReady transitions from false to true)
  useEffect(() => {
    if (dbReady) {
      try {
        const completed = getSetting("onboarding-completed");
        if (!completed) setShowOnboarding(true);
      } catch { /* DB not ready yet — will retry on next render */ }
    }
  }, [dbReady]);
  // Initialize from saved settings synchronously to avoid UI flash showing wrong model list.
  // getMode() reads from SQLite synchronously; if DB not ready yet, falls back to "api".
  const _initialSettings = (() => {
    try {
      return getSettingJSON<any>("codem-settings", {});
    } catch {
      return {};
    }
  })();
  const _initialMode: "cli" | "api" = _initialSettings.mode || "api";
  // For API mode, find the first provider with an API key (excluding mimo) and use its first model.
  // This avoids defaulting to "gpt-4o" when the user hasn't configured an OpenAI key.
  const _initialModel: string = (() => {
    if (_initialSettings.mode === "cli") {
      return _initialSettings.model || "mimo-v2.5-pro";
    }
    // API mode: use saved model if it belongs to a configured provider
    const savedModel: string = _initialSettings.model || "";
    if (savedModel) return savedModel;
    // No saved model: find first provider with API key
    const providers = _initialSettings.providers || [];
    const defaultModels: Record<string, string> = {
      openai: "gpt-4o",
      anthropic: "claude-sonnet-4-20250514",
      deepseek: "deepseek-v4-flash",
      moonshot: "moonshot-v1-8k",
      gemini: "gemini-2.5-flash",
    };
    for (const p of providers) {
      if (p.apiKey && p.id !== "mimo" && defaultModels[p.id]) {
        return defaultModels[p.id];
      }
    }
    return "mimo-v2.5-pro"; // ultimate fallback
  })();
  const _initialProvider: string = (() => {
    const model = _initialModel;
    if (_initialMode === "cli") return "mimo";
    if (model.startsWith("deepseek")) return "deepseek";
    if (model.startsWith("claude")) return "anthropic";
    if (model.startsWith("moonshot")) return "moonshot";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt") || model.startsWith("o3")) return "openai";
    return "mimo";
  })();

  const [cliModel, setCliModel] = useState(_initialModel);
  const [currentMode, setCurrentMode] = useState<"cli" | "api">(_initialMode);
  const [currentProvider, setCurrentProvider] = useState(_initialProvider);
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>("default");
  const windowVisibleRef = useRef(true);
  const [securityMode, setSecurityMode] = useState<SecurityMode>(getEffectiveSecurityMode(currentProject?.path));

  // Track window visibility for task completion notifications
  useEffect(() => {
    const onVisibilityChange = () => { windowVisibleRef.current = !document.hidden; };
    const onBlur = () => { windowVisibleRef.current = false; };
    const onFocus = () => { windowVisibleRef.current = true; };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // 动态加载应用根目录（用户主目录），替换写死的 D:\mimo
  useEffect(() => {
    getAppRoot().then(setAppRoot).catch(() => {});
  }, []);

  // Listen for security mode changes from UI (InputArea toggle, SettingsPanel)
  useEffect(() => {
    const handler = () => {
      setSecurityMode(getEffectiveSecurityMode(currentProject?.path));
    };
    window.addEventListener("codem-security-mode-changed", handler);
    return () => window.removeEventListener("codem-security-mode-changed", handler);
  }, [currentProject?.path]);

  // P0-3: Register plan approval callback — connects exit_plan_mode tool to UI
  useEffect(() => {
    setPlanApprovalCallback(async (plan: string) => {
      return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
        setPlanApproval({ plan, resolve });
      });
    });
    return () => clearPlanApprovalCallback();
  }, []);

  // 监听文件打开事件（来自侧边栏等所有文件浏览器），自动展开右侧栏显示分割窗口
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path) {
        setEditingFile(path);
        // 确保右侧栏展开
        setRightRailOpen(true);
      }
    };
    window.addEventListener("codem:open-file", handler);
    return () => window.removeEventListener("codem:open-file", handler);
  }, []);

  // ENV series: Auto-run setup/cleanup scripts on project switch
  const prevProjectPathRef = useRef<string | null>(null);
  useEffect(() => {
    const prevPath = prevProjectPathRef.current;
    const newPath = currentProject?.path || null;

    // Only act when project path actually changes
    if (prevPath === newPath) return;
    prevProjectPathRef.current = newPath;

    // Run cleanup script for the old project (if any)
    if (prevPath) {
      runCleanupScript(prevPath).then((result) => {
        if (result && !result.success) {
          console.warn(`[ENV] Cleanup script failed for ${prevPath}:`, result.stderr);
        }
      }).catch(() => {});
    }

    // Run setup script for the new project (if any)
    if (newPath) {
      runSetupScript(newPath).then((result) => {
        if (result && !result.success) {
          console.warn(`[ENV] Setup script failed for ${newPath}:`, result.stderr);
        }
      }).catch(() => {});
    }
  }, [currentProject?.path]);

  // S4: Pending write confirmation for diff review — per-session for parallel safety
  const [pendingWriteConfirms, setPendingWriteConfirms] = useState<Map<string, {
    filePath: string;
    existingContent: string;
    newContent: string;
    resolve: (result: import("./core/llm/tools").WriteConfirmResult) => void;
  }>>(new Map());
  // Track per-session file change count and auto-approve state for batch review
  const [writeConfirmStats, setWriteConfirmStats] = useState<Map<string, { count: number; autoApprove: boolean }>>(new Map());
  // Convenience accessor: get the pending write confirm for the current session
  const pendingWriteConfirm = currentSession ? pendingWriteConfirms.get(currentSession.id) : null;
  const writeConfirmStat = currentSession ? (writeConfirmStats.get(currentSession.id) || { count: 0, autoApprove: false }) : { count: 0, autoApprove: false };
  const setPendingWriteConfirm = (val: any) => {
    if (!val || !currentSession) { return; }
    setPendingWriteConfirms(prev => {
      const next = new Map(prev);
      next.set(currentSession.id, val);
      return next;
    });
    // Increment count
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      const cur = next.get(currentSession.id) || { count: 0, autoApprove: false };
      next.set(currentSession.id, { ...cur, count: cur.count + 1 });
      return next;
    });
  };
  const clearPendingWriteConfirm = () => {
    if (!currentSession) return;
    setPendingWriteConfirms(prev => {
      const next = new Map(prev);
      next.delete(currentSession.id);
      return next;
    });
  };
  const setSessionAutoApprove = (autoApprove: boolean) => {
    if (!currentSession) return;
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      const cur = next.get(currentSession.id) || { count: 0, autoApprove: false };
      next.set(currentSession.id, { ...cur, autoApprove });
      return next;
    });
  };
  const resetWriteConfirmStats = (sessionId: string) => {
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

// D3: Pending interactive form — per-session for parallel safety
const [pendingInteractiveForms, setPendingInteractiveForms] = useState<Map<string, {
questions: InteractiveFormQuestion[];
resolve: (answers: Record<string, unknown>) => void;
}>>(new Map());
const pendingInteractiveForm = currentSession ? pendingInteractiveForms.get(currentSession.id) : null;
const setPendingInteractiveForm = (val: any) => {
  if (!val || !currentSession) return;
  setPendingInteractiveForms(prev => { const next = new Map(prev); next.set(currentSession.id, val); return next; });
};
const clearPendingInteractiveForm = () => {
if (!currentSession) return;
setPendingInteractiveForms(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P1: Per-session pending clarification forms (AI asks structured questions)
const [pendingClarifications, setPendingClarifications] = useState<Map<string, { form: ClarificationFormData; resolve: (answers: string[]) => void }>>(new Map());
const pendingClarification = currentSession ? pendingClarifications.get(currentSession.id) : null;
const clearPendingClarification = () => {
if (!currentSession) return;
setPendingClarifications(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P1: Per-session pending correction results (fact-check comparison)
const [pendingCorrections, setPendingCorrections] = useState<Map<string, { original: string; corrected: string; changes: string[] }>>(new Map());
const pendingCorrection = currentSession ? pendingCorrections.get(currentSession.id) : null;
const clearPendingCorrection = () => {
if (!currentSession) return;
setPendingCorrections(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P1: Per-session pending pipeline next-step dialog
const [pendingPipelineSteps, setPendingPipelineSteps] = useState<Map<string, { contextItems: any[] }>>(new Map());
const pendingPipelineStep = currentSession ? pendingPipelineSteps.get(currentSession.id) : null;
const clearPendingPipelineStep = () => {
if (!currentSession) return;
setPendingPipelineSteps(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P2: QuickAccessCards — agent quick access
const [showQuickAccess, setShowQuickAccess] = useState(false);
const [quickAccessFavorites, setQuickAccessFavorites] = useState<Set<string>>(() => {
try { return new Set(getSettingJSON<string[]>("codem-quick-access-favorites", [])); } catch { return new Set(); }
});

// D2: Pending prompt changes — per-session for parallel safety
const [pendingPromptChangesMap, setPendingPromptChangesMap] = useState<Map<string, {
changes: PromptChange[];
resolve: (result: { applied: boolean; message: string }) => void;
}>>(new Map());
const pendingPromptChanges = currentSession ? pendingPromptChangesMap.get(currentSession.id) : null;
const setPendingPromptChanges = (val: any) => {
  if (!val || !currentSession) return;
  setPendingPromptChangesMap(prev => { const next = new Map(prev); next.set(currentSession.id, val); return next; });
};
const clearPendingPromptChanges = () => {
  if (!currentSession) return;
  setPendingPromptChangesMap(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// Handle model change from chat header - sync with engine
const handleModelChange = useCallback((model: string) => {
// Abort all ongoing streaming sessions
for (const controller of abortControllersRef.current.values()) {
controller.abort();
}
abortControllersRef.current.clear();

    // Save current messages before switching models
    if (currentProject && currentSession && messages.length > 0) {
      console.log(`[ModelChange] Saving ${messages.length} messages before switching to ${model}`);
      saveMessages(currentSession.id);
    }

    setCliModel(model);
    const engine = engineRef.current;
    engine.updateConfig({ defaultModel: model });

    // Determine provider from model
    const mode = getMode();
    if (mode === "api") {
      let provider = "openai";
      if (model.startsWith("deepseek")) provider = "deepseek";
      else if (model.startsWith("claude")) provider = "anthropic";
      else if (model.startsWith("moonshot")) provider = "moonshot";
      else if (model.startsWith("gemini")) provider = "gemini";
      else if (model.startsWith("gpt") || model.startsWith("o3")) provider = "openai";
      engine.updateConfig({ defaultProvider: provider });
      setCurrentProvider(provider);
      console.log(`[ModelChange] model=${model}, provider=${provider}`);
    }

    // Persist the selected model to settings so it survives app restart
    try {
      const settings = getSettingJSON<any>("codem-settings", {});
      setSettingJSON("codem-settings", { ...settings, model });
    } catch (e) {
      console.warn("[ModelChange] Failed to persist model:", e);
    }
  }, []);
const [compactionStatus, setCompactionStatus] = useState<{ active: boolean; messagesRemoved?: number } | null>(null);
const [pendingPermissions, setPendingPermissions] = useState<Map<string, {
request: PermissionRequest;
    resolve: (result: PermissionResult) => void;
  }>>(new Map());
  // Convenience accessor: get the pending permission for the current session
  const pendingPermission = currentSession ? pendingPermissions.get(currentSession.id) : null;
  // Background permission: first pending permission from a non-current session (delegation system)
  const backgroundPermission = (() => {
    for (const [sid, val] of pendingPermissions) {
      if (!currentSession || sid !== currentSession.id) return { sessionId: sid, ...val };
    }
    return null;
  })();
  const setPendingPermission = (val: any) => {
    if (!val || !currentSession) { return; }
    setPendingPermissions(prev => {
      const next = new Map(prev);
      next.set(currentSession.id, val);
      return next;
    });
  };
  const clearPendingPermission = () => {
    if (!currentSession) return;
    setPendingPermissions(prev => {
      const next = new Map(prev);
      next.delete(currentSession.id);
      return next;
    });
  };
const [confirmDialog, setConfirmDialog] = useState<{
title: string;
message: string;
confirmLabel: string;
cancelLabel: string;
onConfirm: () => void;
onCancel: () => void;
} | null>(null);
// Safe project removal dialog with 3 options
const [removeProjectDialog, setRemoveProjectDialog] = useState<{
id: string; name: string; path: string;
} | null>(null);
const engineRef = useRef(getLLMEngine());
// Per-session abort controllers for parallel execution
const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
// handleSend ref for automation callbacks (avoids stale closure)
const handleSendRef = useRef<(message: string, attachments?: any[], selectedSkills?: string[]) => void>(() => {});
const mimoSessionRef = useRef<string | null>(null);
  const messagesSessionRef = useRef<string | null>(null);
  /** Tracks which session is currently streaming — for parallel message isolation */
  const streamingSessionIdRef = useRef<string | null>(null);
  
  // Streaming buffer - batch text updates to reduce re-renders
  // Keyed by sessionId for parallel isolation — each session has its own buffer
  const streamBufferRef = useRef<Map<string, { id: string; text: string; timer: ReturnType<typeof setTimeout> | null }>>(new Map());
  const generatedFilesRef = useRef<Set<string>>(new Set());
  const flushStreamBuffer = useCallback((sessionId?: string) => {
    const buffers = streamBufferRef.current;
    // If sessionId given, flush only that session's buffer; otherwise flush all
    const toFlush = sessionId ? [buffers.get(sessionId)].filter(Boolean) : Array.from(buffers.values());
    for (const buffer of toFlush) {
      if (!buffer) continue;
      if (buffer.id && buffer.text) {
        // Only append to UI if this session is currently being viewed
        const viewing = useProjectStore.getState().currentSession?.id;
        if (viewing === sessionId) {
          appendToMessage(buffer.id, buffer.text);
        }
        buffer.text = "";
      }
      buffer.timer = null;
    }
  }, [appendToMessage]);

  // Flush all buffers on unmount
  useEffect(() => {
    return () => {
for (const buffer of streamBufferRef.current.values()) {
if (buffer.timer) clearTimeout(buffer.timer);
}
flushStreamBuffer(); // flush all on unmount
};
}, [flushStreamBuffer]);

  useEffect(() => {
    // Initialize SQLite first, then load everything from database
    (async () => {
      try {
        setBootSplashPhase("loading-db");
        await initDatabase();
        await migrateFromLocalStorage();
        setBootSplashPhase("loading-config");
        ThemeManager.init();
        useProjectStore.getState().loadFromDB();
        // S0-3: Initialize Capability Seam — register default local providers
        // for filesystem and shell. Tools can now access these capabilities
        // through the seam registry instead of hard-importing file-api.
        const { initDefaultSeams } = await import("./core/seam/types");
        await initDefaultSeams();
        // DB is now ready — re-configure engine to read the correct mode/model/provider.
        // The initial configureEngine() in the other useEffect may have run before DB init.
        configureEngine();
        // Reload model profiles from database — they may have been loaded before DB init
        getModelProfileManager().reload();
      } catch (err) {
        console.error("[App] Init failed:", err);
        useProjectStore.getState().loadFromDB();
      }

      // Detect installer default language on first run (no language setting in DB)
      // NSIS installer (Chinese .exe) → default "zh"
      // MSI installer (English .msi) → default "en"
      const existingLang = getSetting("codem-language");
      if (!existingLang) {
        try {
          const { invoke } = (window as any).__TAURI__?.core || {};
          if (invoke) {
            const installerLang = await invoke("get_installer_default_lang");
            if (installerLang === "en" || installerLang === "zh") {
              setLang(installerLang);
              console.log(`[App] Detected installer language: ${installerLang}`);
            }
          }
        } catch (e) {
          console.warn("[App] Failed to detect installer language:", e);
        }
      }

      // Load identity AFTER database is ready
      const identity = loadAppIdentity();
      setAppIdentity(identity);
      if (!identity.onboarded || !identity.name) {
        setShowBootstrap(true);
      }

      // Start automation engines (file watch + timer triggers)
      try {
        const { startAutomationEngines, getAutomationConfig } = await import("./core/automation/automation-manager");
        const config = getAutomationConfig();
        if (config.triggers.length > 0) {
          startAutomationEngines((trigger) => {
            console.log(`[Automation] Triggered: ${trigger.name}`);
            // Create a new session and send the trigger message
            const session = useProjectStore.getState().createSession(`🤖 ${trigger.name}`);
            if (session) {
              handleSendRef.current(trigger.message, [], []);
            }
          });
        }
      } catch (e) {
        console.warn("[App] Automation engine startup failed:", e);
      }

      // Initialize pet system
      try {
        await loadInstalledPetsPets();
        await usePetStore.getState().init();
      } catch (e) {
        console.warn("[App] Pet system init failed:", e);
      }

      // Listen for "查看剩余 Token" requests from pet context menu
      const tauriForPet = (window as any).__TAURI__;
      if (tauriForPet?.event?.listen) {
        tauriForPet.event.listen("pet-check-tokens-request", async () => {
          try {
            const engine = engineRef.current;
            if (!engine) {
              usePetStore.getState().showBubble("引擎未初始化");
              return;
            }
            // Use context manager to calculate remaining tokens for current session
            const sessionId = useProjectStore.getState().currentSession?.id;
            if (!sessionId) {
              usePetStore.getState().showBubble("没有活跃会话");
              return;
            }
            const messages = MessageStorage.listMessages(sessionId);
            const budget = engine.context.calculateBudgetFromMessages(messages);
            const remaining = budget.remaining;
            const total = budget.total;
            const used = budget.used;
            usePetStore.getState().showBubble(
              `剩余 Token: ${remaining.toLocaleString()} / ${total.toLocaleString()}（已用 ${used.toLocaleString()}）`,
              6000
            );
          } catch {
            usePetStore.getState().showBubble("查询 Token 失败");
          }
        });
      }

      // All initialization complete — transition boot splash to ready
      setBootSplashPhase("ready");
    })();
  }, []);

  // ========== 跨会话委派系统接入 ==========
  // 监听 SessionMessageBus 的委派事件，当其他会话委派任务到当前项目会话时，
  // 自动在后台执行 executeSessionTurn。
  useEffect(() => {
    const bus = getSessionMessageBus();
    const orchestrator = getDelegationOrchestrator();

    // 订阅所有会话的委派消息（通配符）
    const unsub = bus.subscribeAll((msg) => {
      if (msg.type !== "delegation") return;

      // 委派请求到达：在目标会话后台执行
      const { targetSessionId, task, taskId, sourceSessionId } = msg;
      if (!task || !taskId) return;

      // 防止重复执行
      if (isSessionExecuting(targetSessionId)) {
        console.log(`[Delegation] Session ${targetSessionId} is already executing, delegation ${taskId} queued`);
        return;
      }

      // 获取目标会话信息
      const session = useProjectStore.getState().sessions.find((s) => s.id === targetSessionId);
      if (!session) {
        console.warn(`[Delegation] Target session not found: ${targetSessionId}`);
        orchestrator.failTask(taskId, `Target session not found: ${targetSessionId}`);
        return;
      }

      // 获取工作目录
      const project = useProjectStore.getState().currentProject;
      let cwd = project?.path || "D:\\mimo";
      if (session.worktreePath) {
        cwd = session.worktreePath;
      }

      const engine = engineRef.current;

      // 后台执行（不阻塞 UI）
      executeSessionTurn({
        sessionId: targetSessionId,
        message: task,
        cwd,
        engine,
        delegationTaskId: taskId,
        onPermissionRequest: (request) => {
          // 后台权限请求：放入 per-session Map，UI 显示通知
          return new Promise((resolve) => {
            setPendingPermissions((prev) => {
              const next = new Map(prev);
              next.set(targetSessionId, { request, resolve });
              return next;
            });
          });
        },
      }).catch((err) => {
        console.error(`[Delegation] executeSessionTurn failed for ${targetSessionId}:`, err);
      });
    });

    return () => {
      unsub();
    };
  }, []);

  // ========== Squad Dispatch 路由 ==========
  // 监听 squad_dispatch 工具发出的事件，创建 Leader 会话并后台执行。
  useEffect(() => {
    const handleSquadDispatch = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || !detail.squadId || !detail.task) return;

      const { squadId, task, originalTask, sourceSessionId, projectId } = detail;
      console.log(`[Squad] Dispatch received: squad=${squadId}, task=${originalTask.substring(0, 60)}...`);

      // Get squad info
      const { getSquadManager } = await import("./core/squad/squad");
      const mgr = getSquadManager();
      const squad = mgr.getSquad(squadId);
      if (!squad) {
        console.error(`[Squad] Squad not found: ${squadId}`);
        return;
      }

      // Create a new session for the leader
      const leaderSessionTitle = `[Squad] ${squad.name}: ${originalTask.substring(0, 40)}`;
      const state = useProjectStore.getState();
      const targetProjectId = projectId || state.currentProject?.id || "";

      // Switch to the target project if needed
      if (targetProjectId && state.currentProject?.id !== targetProjectId) {
        state.openProject(targetProjectId);
      }

      // Create a new session
      const newSession = state.createSession();
      const newSessionId = newSession.id;
      console.log(`[Squad] Leader session created: ${newSessionId} for squad ${squad.name}`);

      // Wait a tick for the session to be available
      setTimeout(async () => {
        const session = useProjectStore.getState().sessions.find((s) => s.id === newSessionId);
        if (!session) {
          console.error(`[Squad] Leader session not found after creation: ${newSessionId}`);
          return;
        }

        // Determine cwd: use worktree path if session has one, otherwise project path
        const project = useProjectStore.getState().currentProject;
        let cwd = session.worktreePath || project?.path || "";

        // Execute the task in the leader session
        executeSessionTurn({
          sessionId: newSessionId,
          message: task,
          cwd,
          engine: engineRef.current,
          onPermissionRequest: (request) => {
            return new Promise((resolve) => {
              setPendingPermissions((prev) => {
                const next = new Map(prev);
                next.set(newSessionId, { request, resolve });
                return next;
              });
            });
          },
        }).catch((err) => {
          console.error(`[Squad] Leader executeSessionTurn failed for ${newSessionId}:`, err);
        });
      }, 200);
    };

    window.addEventListener("codem-squad-dispatch", handleSquadDispatch as EventListener);
    return () => {
      window.removeEventListener("codem-squad-dispatch", handleSquadDispatch as EventListener);
    };
  }, []);

  // Configure engine based on mode and settings
  const configureEngine = useCallback(async () => {
    const saved = getSettingJSON<any>("codem-settings", null);
    const engine = engineRef.current;

    if (saved) {
      const settings = saved;
      const prevMode = getMode();
      const modeChanged = settings.mode !== prevMode;

      // Save messages before switching modes
      if (modeChanged && currentProject && currentSession && messages.length > 0) {
        saveMessages(currentSession.id);
      }

      if (settings.mode === "cli") {
        // CLI mode: use saved model or default to mimo-v2.5-pro
        const model = settings.model || "mimo-v2.5-pro";
        engine.updateConfig({ defaultProvider: "mimo", defaultModel: model });
        setCliModel(model);
        setCurrentMode("cli");
        setCurrentProvider("mimo");
        const auth = getMiMoAuth();
        let account = auth.getActiveAccount();
        if (!account) {
          account = await auth.loadFromAuthJson();
        }
        if (account) {
          engine.setProviderConfig("mimo", { apiKey: account.accessToken, baseUrl: account.url });
          console.log("[Engine] CLI mode: loaded API key");
        } else {
          console.warn("[Engine] CLI mode: no account found, please login");
        }
      } else {
        // API mode: use configured API keys
        if (settings.providers) {
          for (const p of settings.providers) {
            if (p.apiKey) {
              engine.setProviderConfig(p.id, { apiKey: p.apiKey, baseUrl: p.baseUrl });
              console.log(`[Engine] API mode: set ${p.id} apiKey`);
            }
          }
        }
        // Determine provider from selected model
        const model = settings.model || "";
        let provider = "openai"; // default fallback
        if (model.startsWith("deepseek")) provider = "deepseek";
        else if (model.startsWith("claude")) provider = "anthropic";
        else if (model.startsWith("moonshot")) provider = "moonshot";
        else if (model.startsWith("gemini")) provider = "gemini";
        else if (model.startsWith("gpt") || model.startsWith("o3")) provider = "openai";
        // If model doesn't match any provider, use first configured provider's first model
        let finalModel = model;
        if (!model || provider === "openai" && !model.startsWith("gpt") && !model.startsWith("o3")) {
          // Find first configured provider and use its first model
          if (settings.providers) {
            for (const p of settings.providers) {
              if (p.apiKey && p.id !== "mimo") {
                provider = p.id;
                const models: Record<string, string> = {
                  openai: "gpt-4o",
                  anthropic: "claude-sonnet-4-20250514",
                  deepseek: "deepseek-v4-flash",
                  moonshot: "moonshot-v1-8k",
                  gemini: "gemini-2.5-flash",
                };
                finalModel = models[p.id] || model;
                break;
              }
            }
          }
        }
        engine.updateConfig({ defaultProvider: provider, defaultModel: finalModel });
        setCliModel(finalModel);
        setCurrentMode("api");
        setCurrentProvider(provider);
        console.log(`[Engine] API mode: provider=${provider}, model=${finalModel}`);
      }
    }
  }, []);

  useEffect(() => {
    configureEngine();
    // Listen for settings changes from SettingsPanel
    window.addEventListener("codem-settings-changed", configureEngine);
    return () => window.removeEventListener("codem-settings-changed", configureEngine);
  }, [configureEngine]);

  // Handle window close request from Rust (tray icon support)
  useEffect(() => {
    const { listen } = (window as any).__TAURI__?.event || {};
    if (!listen) return;

    let unlisten: (() => void) | undefined;
    listen("close-requested", () => {
      const closeBehavior = getSetting("codem-close-behavior"); // "tray" | "close" | null
      // Flush any pending DB writes before closing/minimizing
      flushDatabase();
      if (closeBehavior === "tray") {
        // Minimize to tray
        const { invoke } = (window as any).__TAURI__?.core || {};
        invoke?.("hide_to_tray");
      } else if (closeBehavior === "close") {
        // Quit the app
        const { invoke } = (window as any).__TAURI__?.core || {};
        invoke?.("quit_app");
      } else {
        // First time — show dialog
        setShowCloseConfirm(true);
      }
    }).then((un: () => void) => { unlisten = un; });

    return () => { unlisten?.(); };
  }, []);

  const handleCloseChoice = useCallback((action: "tray" | "close", remember: boolean) => {
    setShowCloseConfirm(false);
    if (remember) {
      setSetting("codem-close-behavior", action);
    }
    // Flush DB to ensure settings are persisted before app exits
    flushDatabase();
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (action === "tray") {
      invoke?.("hide_to_tray");
    } else {
      invoke?.("quit_app");
    }
  }, []);

  useEffect(() => {
    if (currentSession) {
      // Save old messages to old session before switching
      if (messagesSessionRef.current && messagesSessionRef.current !== currentSession.id && messages.length > 0) {
        saveMessages(messagesSessionRef.current);
      }
      messagesSessionRef.current = currentSession.id;
      loadMessages(currentSession.id);
      // CLI session ID is keyed by project + session; for global sessions, use "" as project ID
      const projId = currentProject?.id || "";
      const saved = loadCliSessionId(projId, currentSession.id);
      mimoSessionRef.current = saved;
    }
  }, [currentProject?.id, currentSession?.id]);

  // Auto-save messages with debounce (every 2 seconds during streaming, immediately when done)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (currentSession && messages.length > 0 && messagesSessionRef.current === currentSession.id) {
      if (isStreaming) {
        // Debounce during streaming
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          console.log(`[AutoSave] Debounce save: ${messages.length} messages to ${currentSession.id}`);
          saveMessages(currentSession.id);
        }, 2000);
      } else {
        // Save immediately when not streaming
        console.log(`[AutoSave] Immediate save: ${messages.length} messages to ${currentSession.id}`);
        saveMessages(currentSession.id);
      }
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, isStreaming]);

  // Save messages before unmount or session switch
  useEffect(() => {
    return () => {
      if (currentSession && messages.length > 0) {
        saveMessages(currentSession.id);
      }
    };
  }, [currentSession?.id]);

// Keep handleSendRef updated for automation callbacks (defined after handleSend below)

// ========== Send Message ==========
const handleSend = async (message: string, attachments?: any[], selectedSkills?: string[]) => {
// Always read latest currentSession from store (avoids stale closure)
const session = useProjectStore.getState().currentSession;
if (!session) return;

    // F3.2: Handle /memory slash commands
    const trimmedMessage = message.trim();
    if (trimmedMessage.startsWith("/memory")) {
      const parts = trimmedMessage.split(/\s+/);
      const subcommand = parts[1]?.toLowerCase();
      const engineInstance = engineRef.current;
      const sessionId = session.id;

      if (subcommand === "off" || subcommand === "disable") {
        engineInstance.setMemoryEnabled(sessionId, false);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "记忆提取已关闭。本会话不再自动提取记忆。使用 /memory on 重新开启。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else if (subcommand === "on" || subcommand === "enable") {
        engineInstance.setMemoryEnabled(sessionId, true);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "记忆提取已开启。本会话将自动提取记忆。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else if (subcommand === "status") {
        const enabled = engineInstance.isMemoryEnabled(sessionId);
        const stats = engineInstance.getMemoryConsolidationStats();
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: `记忆状态: ${enabled ? "✅ 开启" : "❌ 关闭"}\n记忆总数: ${stats.totalEntries}\n潜在重复: ${stats.potentialDuplicates}\n作用域分布: 项目=${stats.scopeBreakdown.project}, 全局=${stats.scopeBreakdown.global}, 会话=${stats.scopeBreakdown.session}`,
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else if (subcommand === "consolidate" || subcommand === "clean") {
        const result = engineInstance.consolidateMemories();
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: `记忆整合完成：合并 ${result.duplicatesMerged} 条重复，清理 ${result.staleRemoved} 条过期，裁剪 ${result.capacityTrimmed} 条超额。`,
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else {
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "用法：\n/memory on — 开启记忆提取\n/memory off — 关闭记忆提取\n/memory status — 查看记忆状态\n/memory consolidate — 手动整合记忆",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      }
    }

    // F3.3: Handle /generate-agents slash command
    if (trimmedMessage === "/generate-agents" || trimmedMessage === "/gen-agents") {
      const projectPath = currentProject?.path;
      if (!projectPath) {
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "❌ 未找到项目路径，请先打开一个项目。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      }
      addMessage({
        id: `system-${Date.now()}`,
        role: "system",
        content: "🔍 正在分析项目结构并生成 AGENTS.md...",
        timestamp: Date.now(),
        status: "done",
      });
      try {
        const { generateAgentsMd } = await import("./core/project/files");
        const { writeFile } = await import("./core/file-api");
        const content = await generateAgentsMd(projectPath);
        await writeFile(`${projectPath}\\AGENTS.md`, content);
        addMessage({
          id: `system-${Date.now() + 1}`,
          role: "system",
          content: `✅ AGENTS.md 已生成并写入项目根目录。\n\n生成内容摘要：\n- 检测技术栈和框架\n- 识别项目结构\n- 推断构建/测试/lint 命令\n- 生成代码规范和 AI 规则\n\n你可以编辑 AGENTS.md 来补充更多项目特定信息。`,
          timestamp: Date.now(),
          status: "done",
        });
      } catch (e: any) {
        addMessage({
          id: `system-${Date.now() + 1}`,
          role: "system",
          content: `❌ 生成 AGENTS.md 失败：${e?.message || e}`,
          timestamp: Date.now(),
          status: "done",
        });
      }
      return;
    }

    useProjectStore.getState().updateSession(session.id, {
      messageCount: session.messageCount + 1,
      lastMessageAt: Date.now(),
    });

    let userContent = message;
    if (attachments && attachments.length > 0) {
      // Sync attachments to the workspace .attachments/ directory so the LLM
      // can use read/grep/glob tools on them directly (Wegent-style sandbox sync).
      const cwd = currentProject?.path || await getAppRoot();
      const syncedAttachments = await syncAttachmentsToWorkspace(attachments, cwd);

      // Wegent-style: inline attachment content with truncation annotations
      // Small files (< 4KB) are fully inlined; large files get head+tail preview
      // LLM naturally calls read_attachment when it sees "Truncated: yes"
      const attachmentInfo = formatAttachmentsInline(syncedAttachments);
      userContent = attachmentInfo + (message ? "\n\n" + message : "");

      // Use synced attachments (with sandboxPath) for the message
      addMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: userContent,
        timestamp: Date.now(),
        status: "done",
        attachments: syncedAttachments,
      });
    } else {
      addMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: userContent,
        timestamp: Date.now(),
        status: "done",
      });
    }

    // Immediately save to database so agentic loop can read it
    saveMessages(session.id);

      await runAgenticLoop(message, session, selectedSkills);
  };

  // P1-5: Save last AI response as a note in the active notebook
  const handleSaveAIResponseAsNote = () => {
    if (!activeNotebookId) return;
    // Find the last AI message
    const lastAIMessage = [...messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
    if (!lastAIMessage) {
      alert(lang === 'zh' ? '没有可保存的 AI 回复' : 'No AI response to save');
      return;
    }
    const title = lang === 'zh'
      ? `AI回复 ${new Date().toLocaleString('zh-CN')}`
      : `AI Response ${new Date().toLocaleString('en-US')}`;
    createNote({ notebookId: activeNotebookId, title, content: lastAIMessage.content });
    alert(lang === 'zh' ? '已保存为笔记' : 'Saved as note');
  };

  // B4: Handle citation click — find source by name and open SourceViewer
  const handleCitationClick = useCallback((sourceName: string) => {
    if (!activeNotebookId) return;
    const sources = listSources(activeNotebookId);
    // Try exact match first, then partial match
    const source = sources.find(s => s.name === sourceName)
      || sources.find(s => s.name.toLowerCase() === sourceName.toLowerCase())
      || sources.find(s => s.name.toLowerCase().includes(sourceName.toLowerCase()));
    if (source) {
      setCitationViewer({ sourceId: source.id, notebookId: activeNotebookId });
    }
  }, [activeNotebookId]);

  // Handle source click from structured metadata — directly use sourceId (no name lookup needed)
  const handleSourceClick = useCallback((sourceId: string, chunkIndex?: number) => {
    if (!activeNotebookId) return;
    setCitationViewer({ sourceId, notebookId: activeNotebookId, chunkIndex });
  }, [activeNotebookId]);

  // Keep handleSendRef updated for automation callbacks (avoids stale closure)
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  // ========== Guidance (mid-turn steering) ==========
  // Send a guidance message to the currently running agentic loop.
  // The message is enqueued and will be consumed at the next iteration boundary.
  const handleSendGuidance = useCallback((message: string) => {
    const session = useProjectStore.getState().currentSession;
    if (!session) return;
    const engine = engineRef.current;
    const success = engine.sendGuidance(session.id, message);
    if (success) {
      // Add to guidance messages in the store for UI display
      addGuidanceMessage({
        id: `guide-${Date.now()}`,
        message,
        timestamp: Date.now(),
        consumed: false,
      });
      console.log(`[Guidance] Sent to session ${session.id}: "${message.substring(0, 80)}..."`);
    } else {
      console.warn(`[Guidance] Failed to send — no active loop for session ${session.id}`);
    }
  }, [addGuidanceMessage]);

  /**
   * Run the agentic loop — shared by handleSend and handleRegenerate.
   * This function handles provider setup, streaming, tool calls, and
   * all event processing from the LLM engine.
   */
  const runAgenticLoop = async (message: string, session: Session, selectedSkills?: string[]) => {
    if (!session) return;

    const mode = getMode();
    const engine = engineRef.current;

    

    const provider = engine.getDefaultProvider();
    const model = engine.getDefaultModel();
    

    const providerObj = engine.providers.get(provider);
    

    if (provider === "openai" && model === "gpt-4o") {
      configureEngine();
    }

    if (mode === "cli") {
      const auth = getMiMoAuth();
      let account = auth.getActiveAccount();
      if (!account) {
        account = await auth.loadFromAuthJson();
      }
      if (!account) {
        addMessage({
          id: 'err-' + Date.now(),
          role: 'system',
          content: '[Error] MiMo auth not found. Please login first.',
          timestamp: Date.now(),
          status: "error",
        });
        return;
      }
      engine.setProviderConfig("mimo", { apiKey: account.accessToken, baseUrl: account.url });
    }

    
setStreaming(true);
useAppStore.getState().setSessionActive(session.id, true);
streamingSessionIdRef.current = session.id;

    const providerName = engine.getDefaultProvider();
    const modelName = engine.getDefaultModel();
    

    const providerObj2 = engine.providers.get(providerName);
    if (providerObj2 && !providerObj2.isConfigured()) {
      
setStreaming(false);
useAppStore.getState().setSessionActive(session.id, false);
streamingSessionIdRef.current = null;
addMessage({
id: 'err-' + Date.now(),
role: 'system',
content: '[Error] ' + providerName + ' not configured. Please set API Key in Settings.',
timestamp: Date.now(),
        status: 'error',
      });
      return;
    }

    // Determine cwd: use worktree path if session has one, otherwise project path
    let cwd = currentProject?.path || await getAppRoot();
    if (session.worktreePath) {
      cwd = session.worktreePath;
    } else if (session.executionMode === "git_worktree" && currentProject?.path) {
      // Session wants worktree mode but doesn't have a path yet — create one
      try {
        const { createWorktree, getProjectExecutionMode } = await import("./core/environment");
        const wtPath = await createWorktree(currentProject.path, session.id, session.worktreeBranch);
        cwd = wtPath;
        // Persist the worktree path on the session
        useProjectStore.getState().updateSession(session.id, { worktreePath: wtPath });
        session.worktreePath = wtPath;
      } catch (e) {
        console.error("[App] Failed to create worktree, falling back to project dir:", e);
        addMessage({
          id: `wt-err-${Date.now()}`,
          role: "system",
          content: lang === "zh"
            ? `❌ 工作树创建失败，使用本地目录: ${e instanceof Error ? e.message : String(e)}`
            : `❌ Worktree creation failed, using local dir: ${e instanceof Error ? e.message : String(e)}`,
          timestamp: Date.now(),
          status: "error",
        });
      }
    }
    // Show success toast if worktree was just created
    if (session.worktreePath && session.executionMode === "git_worktree" && cwd === session.worktreePath) {
      addMessage({
        id: `wt-ok-${Date.now()}`,
        role: "system",
        content: lang === "zh" ? `🌲 工作树已创建: ${session.worktreePath}` : `🌲 Worktree created: ${session.worktreePath}`,
        timestamp: Date.now(),
        status: "done",
      });
    }
    let assistantMsgId = `assistant-${Date.now()}`;
    let assistantContent = "";
    let reasoningContent = "";
    let lastAssistantMsgId = "";

    // Record start time for execution timer
    useAppStore.getState().setStreamStartTime(Date.now());

    try {
const sessionAbort = new AbortController();
abortControllersRef.current.set(session.id, sessionAbort);

// Helper: check if this session is currently being viewed (for UI updates)
const isViewingSession = () => {
  const viewing = useProjectStore.getState().currentSession?.id;
  return viewing === session.id;
};
// Safe message helpers: only update UI if viewing this session, always save to DB
const safeAddMessage = (msg: any) => {
  if (isViewingSession()) addMessage(msg);
  // Always persist to DB regardless
  if (session) saveMessages(session.id);
};
const safeUpdateMessage = (id: string, update: any) => {
  if (isViewingSession()) useAppStore.getState().updateMessage(id, update);
};

      for await (const event of engine.process(session.id, message, cwd, undefined, {
        onPermissionRequest: (request) => {
          return new Promise((resolve) => {
            // Per-session: set permission for this specific session
            setPendingPermissions(prev => {
              const next = new Map(prev);
              next.set(session.id, { request, resolve });
              return next;
            });
          });
        },
        collaborationMode,
        // S4: Wire up write confirmation for diff review (inline, non-modal)
        onWriteConfirm: (params) => {
          // Check if user has enabled auto-approve for this session
          const stat = writeConfirmStats.get(session.id);
          if (stat?.autoApprove) {
            return Promise.resolve({ action: "accept" as const });
          }
          return new Promise((resolve) => {
            // Per-session: set write confirm for this specific session
            setPendingWriteConfirms(prev => {
              const next = new Map(prev);
              next.set(session.id, { ...params, resolve });
              return next;
            });
            // Increment count for this session
            setWriteConfirmStats(prev => {
              const next = new Map(prev);
              const cur = next.get(session.id) || { count: 0, autoApprove: false };
              next.set(session.id, { ...cur, count: cur.count + 1 });
              return next;
            });
          });
        },
        // Deep thinking: read reasoning effort from settings (set via model picker dropdown)
        ...((() => {
          const effort = getSettingJSON<string>("codem-reasoning-effort", "high");
          if (effort && effort !== "off") {
            return { reasoningEffort: effort as "low" | "medium" | "high" | "ultra" };
          }
          return {};
        })()),
        // Security mode: three-tier approval policy
        securityMode,
        // D2: Prompt optimization callbacks
        getSystemPrompt: () => {
          // Return the current system prompt from the engine
          return engine.buildSystemPrompt(session.id, undefined, cwd);
        },
        onPromptChangeSubmit: (changes: PromptChange[]) => {
          return new Promise((resolve) => {
            setPendingPromptChangesMap(prev => {
              const next = new Map(prev);
              next.set(session.id, { changes, resolve });
              return next;
            });
          });
        },
        // D3: Interactive form callback
        onInteractiveForm: (questions: InteractiveFormQuestion[]) => {
          return new Promise((resolve) => {
            setPendingInteractiveForms(prev => {
              const next = new Map(prev);
              next.set(session.id, { questions, resolve });
              return next;
            });
          });
        },
        // F5: Notebook knowledge mode
        ...(activeNotebookId ? { notebookId: activeNotebookId } : {}),
        // User-selected skills (injected with 🎯 marker in system prompt)
        ...(selectedSkills && selectedSkills.length > 0 ? { userSelectedSkills: selectedSkills } : {}),
      })) {
        if (sessionAbort.signal.aborted) break;

        switch (event.type) {
          case "knowledge_sources": {
            // Auto-retrieved knowledge sources from notebook RAG
            // Create assistant message if it doesn't exist yet (sources arrive before text)
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              safeAddMessage({
                id: assistantMsgId,
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                status: "streaming",
                retrievedSources: event.sources,
              });
            } else {
              safeUpdateMessage(assistantMsgId, {
                retrievedSources: event.sources,
              } as any);
            }
            if (session) {
              saveMessages(session.id);
            }
            break;
          }

          case "reasoning_delta":
            reasoningContent += event.text;
            // Create assistant message if it doesn't exist yet (reasoning often arrives before text)
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              safeAddMessage({
                id: assistantMsgId,
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                status: "streaming",
              });
if (session) {
saveMessages(session.id);
}
            }
            // Update message with reasoning content
            safeUpdateMessage(assistantMsgId, {
              reasoning: reasoningContent
            } as any);
            break;

          case "start": {
            // Each iteration gets its own assistant message so the LLM sees
            // clear iteration boundaries in its context. Previously all
            // iterations accumulated into one giant message, causing the LLM
            // to lose track of which tool results belonged to which iteration.
            //
            // Both unified and segmented modes create separate DB messages per
            // iteration. The difference is purely visual: unified mode collapses
            // reasoning and tool calls by default (handled in MessageBubble.tsx
            // via displayMode === "unified" check).
            const iter = 'iteration' in event ? event.iteration : 1;
            if (iter > 1) {
// Finalize previous, create new message — same for both modes
flushStreamBuffer(session.id);
              if (useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
                safeUpdateMessage(assistantMsgId, {
                  status: "done",
                  reasoning: reasoningContent || undefined,
                } as any);
                if (session) {
                  saveMessages(session.id);
                }
              }
              // Start a new assistant message for this iteration
              lastAssistantMsgId = assistantMsgId;
              assistantMsgId = `assistant-${Date.now()}-${iter}`;
              assistantContent = "";
              reasoningContent = "";
              generatedFilesRef.current.clear();
            }
            break;
          }

          case "llm_status": {
            // State-based connection tracking — no timers, just state transitions
            // connecting → streaming → executing_tools → (next iteration or done)
            setLLMStatus(event.status);
            // Bridge to pet system
            usePetStore.getState().onLLMStatus(event.status);
            break;
          }

          case "step_progress": {
            // Deterministic step progress from the agentic loop itself
            useAppStore.getState().setStepProgress({
              current: event.step,
              total: event.total ?? 0,
              title: event.title || "",
              steps: event.steps?.map(s => ({ title: s.title })) ?? null,
            });
            // P0-2: 步骤进度气泡
            const stepTitle = event.title || `步骤 ${event.step}`;
            const stepTotal = event.total ? `/${event.total}` : "";
            usePetStore.getState().showRawBubble(`${stepTitle}${stepTotal}`, 3000);
            break;
          }

          case "text_delta":
            assistantContent += event.text;
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              safeAddMessage({
                id: assistantMsgId,
                role: "assistant",
                content: assistantContent,
                timestamp: Date.now(),
                status: "streaming",
              });
            }
            // Per-session buffer
            let buf = streamBufferRef.current.get(session.id);
            if (!buf) { buf = { id: "", text: "", timer: null }; streamBufferRef.current.set(session.id, buf); }
            buf.id = assistantMsgId;
            buf.text += event.text;
            if (!buf.timer) {
              buf.timer = setTimeout(() => flushStreamBuffer(session.id), 100);
            }
            break;

          case "tool_start": {
            flushStreamBuffer(session.id);
            // Bridge to pet system
            usePetStore.getState().onStreamEvent(event);
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
                safeAddMessage({
                  id: assistantMsgId,
                  role: "assistant",
                  content: "",
                  timestamp: Date.now(),
                  status: "streaming",
                });
              }
              let buf2 = streamBufferRef.current.get(session.id);
              if (!buf2) { buf2 = { id: "", text: "", timer: null }; streamBufferRef.current.set(session.id, buf2); }
              buf2.id = assistantMsgId;
              if (isViewingSession()) addToolCall(assistantMsgId, {
                id: tc.id,
                tool: tc.name,
                args: { ...tc.input, name: tc.input?.name || (tc as any).metadata?.name },
                status: "running",
              });
              // Immediately save tool call so agentic loop can read it
if (session) {
saveMessages(session.id);
}
            }
            break;
          }

          case "tool_complete": {
            // Bridge to pet system
            usePetStore.getState().onStreamEvent(event);
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              // Extract the output string from the result
              let resultStr: string;
              let toolMetadata: Record<string, any> | undefined;
              if (typeof event.result === "string") {
                resultStr = event.result;
              } else if (event.result && typeof event.result === "object" && "output" in event.result) {
                resultStr = (event.result as any).output;
                // 提取结构化元数据（如 search_notebook 的来源引用信息）
                if ((event.result as any).metadata) {
                  toolMetadata = (event.result as any).metadata;
                }
              } else {
                resultStr = JSON.stringify(event.result || "");
              }
              // Filter out <system-reminder> tags from tool results
              resultStr = resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
              if (isViewingSession()) updateToolCall(assistantMsgId, tc.id, {
                status: "done",
                result: resultStr,
                metadata: toolMetadata,
              });
              // Track generated files from write tool
              if (tc.name === "write" && tc.input?.path) {
                generatedFilesRef.current.add(tc.input.path as string);
              }
              // Immediately save so next agentic loop iteration can read it
if (session) {
saveMessages(session.id);
}
            }
            break;
          }

          case "tool_error": {
            // Bridge to pet system
            usePetStore.getState().onStreamEvent(event);
            const tc = "toolCall" in event ? event.toolCall : null;
            const err = "error" in event ? event.error : "Unknown error";
            
            if (tc) {
              if (isViewingSession()) updateToolCall(assistantMsgId, tc.id, {
                status: "error",
                result: err,
              });
              // Immediately save tool error
if (session) {
saveMessages(session.id);
}
            }
            break;
          }

          case "compaction_start": {
            setCompactionStatus({ active: true });
            // P1-8: 宠物切到 waiting 状态 + 压缩提示气泡
            usePetStore.getState().setPetState("waiting");
            usePetStore.getState().showRawBubble("正在压缩上下文…", 5000);
            break;
          }

          case "compaction_end": {
            const removed = "messagesRemoved" in event ? event.messagesRemoved : 0;
            setCompactionStatus({ active: false, messagesRemoved: removed });
            // Reload messages from DB since old ones were deleted
        if (session) {
          loadMessages(session.id);
          saveMessages(session.id);
        }
            // P1-8: 恢复宠物状态 + 压缩完成气泡
            usePetStore.getState().setPetState("idle");
            if (removed > 0) {
              usePetStore.getState().showRawBubble(`已压缩 ${removed} 条消息`, 3000);
            }
            // Auto-clear compaction status after 3 seconds
            setTimeout(() => setCompactionStatus(null), 3000);
            break;
          }

          case "guidance_received": {
            // Mark the guidance message as consumed in the store
            markGuidanceConsumed(event.guidanceId);
            // Show a brief toast/notification via pet system
            usePetStore.getState().showRawBubble(`📨 引导消息已注入: ${event.message.substring(0, 40)}...`, 3000);
            break;
          }

          case "clarification": {
            // P1: AI asks the user a structured question via a form
            setPendingClarifications(prev => {
              const next = new Map(prev);
              next.set(session.id, { form: event.form, resolve: event.resolve });
              return next;
            });
            break;
          }

          case "correction_complete": {
            // P1: Fact-check result is ready for user review
            setPendingCorrections(prev => {
              const next = new Map(prev);
              next.set(session.id, { original: event.original, corrected: event.corrected, changes: event.changes });
              return next;
            });
            break;
          }

          case "pipeline_step_complete": {
            // P1: A pipeline step completed — offer context for next step
            // Build context items from recent messages and notebook sources
            const contextItems: any[] = [];
            // Add recent user messages as context options
            const recentMessages = useAppStore.getState().messages.slice(-5);
            for (const msg of recentMessages) {
              if (msg.content) {
                contextItems.push({
                  id: msg.id,
                  type: 'message' as const,
                  title: msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : ''),
                  content: msg.content,
                });
              }
            }
            // If in notebook mode, add notebook as context
            if (activeNotebookId) {
              contextItems.push({
                id: `notebook-${activeNotebookId}`,
                type: 'notebook' as const,
                title: activeNotebookName || 'Notebook',
              });
            }
            setPendingPipelineSteps(prev => {
              const next = new Map(prev);
              next.set(session.id, { contextItems });
              return next;
            });
            break;
          }

          case "todo_list_created": {
            // P1: AI created a todo list — store will be updated via tool metadata
            // The todo data is persisted by the show-todo tool to SQLite
            // No additional UI action needed here — ChatPanel reads todos from DB
            break;
          }

          case "end": {
            // Bridge to pet system
            usePetStore.getState().onStreamEvent(event);
            // Show bubble notification on task completion
            const isOverflow = "result" in event && event.result?.type === "overflow";
            if (!isOverflow) {
              // Determine if tools were used (task with actions) vs simple chat
              const fileCount = generatedFilesRef.current.size;
              const hadToolCalls = fileCount > 0;
              if (hadToolCalls) {
                // P0-3 + P1-9: 有文件变更时用 waving 状态 + 文件数摘要
                usePetStore.getState().setPetState("waving");
                const bubbleMsg = fileCount === 1 ? "任务完成！修改了 1 个文件" : `任务完成！修改了 ${fileCount} 个文件`;
                setTimeout(() => usePetStore.getState().showBubble(bubbleMsg), 300);
              } else {
                const bubbleMsg = "回复完成了！";
                setTimeout(() => usePetStore.getState().showBubble(bubbleMsg), 300);
              }
            }
            // Handle overflow result (context completely exhausted)
            if ("result" in event && event.result?.type === "overflow") {
              const msg = event.result.message || "上下文窗口已满，请开启新对话。";
              safeAddMessage({
                id: 'overflow-' + Date.now(),
                role: "system",
                content: `⚠️ ${msg}`,
                timestamp: Date.now(),
                status: "error",
              });
            }
            break;
          }
        }
      }

      if (assistantContent) {
        const generatedFiles = Array.from(generatedFilesRef.current);
        safeUpdateMessage(assistantMsgId, {
          status: "done",
          generatedFiles: generatedFiles.length > 0 ? generatedFiles : undefined,
        });
        generatedFilesRef.current.clear();
      }
    } catch (error: any) {
      
      addMessage({
        id: 'err-' + Date.now(),
        role: 'system',
        content: '[Error] ' + (error.message || String(error)),
        timestamp: Date.now(),
        status: 'error',
      });
      if (session) saveMessages(session.id);
    } finally {
// Flush any remaining buffered text for this session
flushStreamBuffer(session.id);
      // Clear step progress after a short delay so user sees the final state
      setTimeout(() => useAppStore.getState().setStepProgress(null), 2000);
      // Clear guidance messages when the run ends
      clearGuidanceMessages();
      // Clear stream start time
      useAppStore.getState().setStreamStartTime(null);
      
setStreaming(false);
if (session) {
useAppStore.getState().setSessionActive(session.id, false);
// Reset auto-approve flag when the turn ends
resetWriteConfirmStats(session.id);
}
streamingSessionIdRef.current = null;
abortControllersRef.current.delete(session?.id || "");
      if (session) {
        saveMessages(session.id);
      }
      // Task completion notification when app is in background or minimized
      if (!windowVisibleRef.current) {
        // Use Tauri internal API to show window and bring to front
        try {
          const tauri = (window as any).__TAURI__;
          if (tauri?.core?.invoke) {
            await tauri.core.invoke("plugin:window|show", { label: "main" });
            await tauri.core.invoke("plugin:window|set_focus", { label: "main" });
            await tauri.core.invoke("plugin:window|unminimize", { label: "main" });
            console.log("[Notify] Window shown and focused");
          }
        } catch (e) { console.warn("[Notify] Window show failed:", e); }
        // Send native notification
        try {
          const tauri = (window as any).__TAURI__;
          if (tauri?.core?.invoke) {
            let granted = true;
            try {
              granted = await tauri.core.invoke("plugin:notification|is_permission_granted");
              if (!granted) {
                const result = await tauri.core.invoke("plugin:notification|request_permission");
                granted = result === 2 || result === "granted";
              }
            } catch {}
            if (granted) {
              const sessionTitle = session.title || "对话";
              const userQuestion = message.length > 30 ? message.substring(0, 30) + "..." : message;
              await tauri.core.invoke("plugin:notification|notify", {
                options: { title: `任务完成 — ${sessionTitle}`, body: `"${userQuestion}" 执行完毕，点击查看结果` }
              });
              console.log("[Notify] Notification sent");
            }
          }
        } catch (e) { console.warn("[Notify] Native notification failed:", e); }
      }
    }
  };

  /**
   * Regenerate the assistant response for the current Q&A turn.
   * Called from the LAST assistant message in a turn. Finds the user message
   * that started this turn, deletes ALL assistant messages in the turn,
   * and re-runs the agentic loop from that user message.
   */
  const handleRegenerate = async (messageIndex: number) => {
    const session = useProjectStore.getState().currentSession;
    if (!session || isStreaming) return;

    const allMessages = useAppStore.getState().messages;
    if (messageIndex < 0 || messageIndex >= allMessages.length) return;

    // Find the user message that started this turn (search backwards from messageIndex)
    let userMessage = "";
    let userIndex = -1;
    for (let i = messageIndex; i >= 0; i--) {
      if (allMessages[i].role === "user") {
        userMessage = allMessages[i].content;
        userIndex = i;
        break;
      }
    }
    if (!userMessage || userIndex === -1) return;

    // Collect message IDs to delete (all messages AFTER the user message = entire assistant response)
    const idsToDelete = allMessages.slice(userIndex + 1).map((m) => m.id);

    // Truncate messages in store: keep everything up to and including the user message
    useAppStore.setState({ messages: allMessages.slice(0, userIndex + 1) });

    // Delete removed messages from DB
    if (idsToDelete.length > 0) {
      try { MessageStorage.deleteMessagesByIds(idsToDelete); } catch (e) {
        console.error("[Regenerate] Failed to delete messages:", e);
      }
    }

    // Re-run the agentic loop with the original user message
    await runAgenticLoop(userMessage, session);
  };

  /**
   * P0: Edit a user message and resend — deletes the original message and all
   * messages after it, then re-runs the agentic loop with the new content.
   */
  const handleEditAndResend = async (messageId: string, newContent: string) => {
    const session = useProjectStore.getState().currentSession;
    if (!session) return;
    // P0 fix: use per-session active check instead of global isStreaming,
    // so editing works even when another session is streaming.
    const activeSessions = useAppStore.getState().activeSessions;
    if (activeSessions.has(session.id)) return;

    const allMessages = useAppStore.getState().messages;
    const targetMessage = allMessages.find((m) => m.id === messageId);
    if (!targetMessage || targetMessage.role !== "user") return;

    // 1. Update the message content in the store
    useAppStore.getState().updateMessage(messageId, { content: newContent });

    // 2. Update in DB
    try {
      MessageStorage.updateMessageContent(messageId, newContent);
    } catch (e) {
      console.error("[EditAndResend] Failed to update message content:", e);
    }

    // 3. Delete all messages AFTER this message (from DB)
    try {
      const deletedCount = MessageStorage.deleteMessagesAfter(session.id, messageId);
      console.log(`[EditAndResend] Deleted ${deletedCount} messages after edited message`);
    } catch (e) {
      console.error("[EditAndResend] Failed to delete subsequent messages:", e);
    }

    // 4. Remove messages after this one from the store
    useAppStore.getState().removeMessagesAfter(messageId, false);

    // 5. Re-run the agentic loop with the new content
    await runAgenticLoop(newContent, session);
  };

  /**
   * P0: Re-edit is now handled internally by ChatPanel — no parent state needed.
   * The onReEdit prop is optional and not passed, so ChatPanel manages its own quoteContext.
   */

  const handleCancel = () => {
// Abort the current session's streaming
if (currentSession) {
const controller = abortControllersRef.current.get(currentSession.id);
if (controller) {
controller.abort();
abortControllersRef.current.delete(currentSession.id);
}
} else {
// Fallback: abort all
for (const controller of abortControllersRef.current.values()) {
controller.abort();
}
abortControllersRef.current.clear();
}
    // Note: Sub-agents continue running when main task is paused
    // Only global pause should freeze everything
    engineRef.current.abort();
    setStreaming(false);
  };

  // Global pause: freeze everything (main + sub-agents)
  const handleGlobalPause = () => {
    // Abort all active sessions
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    try {
      const { getSubagentManager } = require("../core/subagent/subagent");
      const manager = getSubagentManager();
      manager.cancelAll();
    } catch {}
    engineRef.current.abort();
    setStreaming(false);
  };

  const handleToggleFileExplorer = (projectId: string) => {
    const state = useProjectStore.getState();
    if (state.currentProject?.id !== projectId) {
      useProjectStore.getState().openProject(projectId);
    }
    // 直接展开右侧栏并切换到文件 Tab（不再用浮动浏览器）
    setRightRailOpen(true);
    setFileExplorerProjectId((prev) => (prev === projectId ? null : projectId));
  };

  const handleBootstrapComplete = (identity: AppIdentity) => {
    setAppIdentity(identity);
    setShowBootstrap(false);
  };

  const { skin } = useSkin();

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={500}>
    <div className="app">
      <BootSplash
        visible={bootSplashVisible}
        phase={bootSplashPhase}
        progress={bootSplashPhase === "initializing" ? 15 : bootSplashPhase === "loading-db" ? 45 : bootSplashPhase === "loading-config" ? 75 : 100}
        onComplete={() => setBootSplashVisible(false)}
      />
      <WorkspaceBackdrop />
      <ToastContainer />
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onNewChat={() => {
          useProjectStore.setState({ currentProject: null });
          createSession();
        }}
        onSearch={() => setShowSearchDialog(true)}
        onSettings={() => setShowSettings(true)}
        rightRailOpen={rightRailOpen}
        onToggleRightRail={() => setRightRailOpen(!rightRailOpen)}
      />
      <div className="app-content">
      {!dbReady ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-secondary)" }}>
          Loading...
        </div>
      ) : (
        <>
          {showBootstrap && (
            <BootstrapWizard appRoot={appRoot} onComplete={handleBootstrapComplete} />
          )}

          {/* 核心内容：Sidebar + MainArea，根据皮肤选择不同布局包裹 */}
          {skin === "hub" ? (
            <HubLayout
              rightRailOpen={rightRailOpen}
              onToggleRightRail={() => setRightRailOpen(!rightRailOpen)}
              onTasks={() => setShowProjectManager(true)}
              onSkills={() => setShowSkillManager(true)}
              onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
              onNewChat={() => {
                // 新建全局对话（不属于任何项目）
                useProjectStore.setState({ currentProject: null });
                createSession();
              }}
              onNewProject={() => setShowProjectManager(true)}
              onImportProject={() => setShowProjectManager(true)}
              onGitHubClone={() => setShowGitHubClone(true)}
              onOpenSession={(sessionId, projectId) => {
                // 切换到指定会话
                useProjectStore.getState().openProject(projectId);
                useProjectStore.getState().switchSession(sessionId);
              }}
              editingFile={editingFile}
              onEditingFileChange={setEditingFile}
              refreshKey={fileExplorerRefreshKey}
              sidebar={
                sidebarOpen ? (
                  <Sidebar
                    identity={appIdentity}
                    onSettings={() => setShowSettings(true)}
                    onProjects={() => setShowProjectManager(true)}
                    onConfig={() => setShowConfigEditor(true)}
                    onMcp={() => setShowMcpManager(true)}
                    onSkills={() => setShowSkillManager(true)}
                    onMemory={() => setShowMemoryManager(true)}
                    onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
onAgents={() => setShowAgentManager(true)}
onCicd={() => setShowCicdPanel(true)}
onPerf={() => setShowPerfDashboard(true)}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
                    fileExplorerProjectId={fileExplorerProjectId}
                    onToggleFileExplorer={handleToggleFileExplorer}
                  />
                ) : null
              }
              mainPanel={
                <div className="main-area">
                  <div className="panel-right">
                    <div className="panel-tabs">
                      <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
                        <MessageSquare size={14} /> {lang === "zh" ? "对话" : "Chat"}
                      </button>
                      <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
                        <Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}
                      </button>
                    </div>
                    <div className="panel-content">
                      {compactionStatus && (
                        <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                          {compactionStatus.active ? (
                            <><span className="compaction-spinner" /> 正在压缩上下文...</>
                          ) : (
                            <><CheckCircle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                          )}
                        </div>
                      )}
                      {activeNotebookId && (
                        <div className="notebook-mode-banner">
                          <span className="notebook-mode-icon"><BookOpen size={16} /></span>
<span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
<button className="notebook-mode-save" onClick={handleSaveAIResponseAsNote} title={lang === 'zh' ? '保存AI回复为笔记' : 'Save AI response as note'}><Save size={14} /></button>
<button className="notebook-mode-save" onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }} title={lang === 'zh' ? '返回工作区' : 'Back to Workspace'}><FolderOpen size={14} /></button>
<button className="notebook-mode-close" onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); setNotebookSourceFilter(null); }}><X size={14} /></button>
</div>
)}
{bottomTab === "chat" && (
                        <ChatPanel
                          onSend={handleSend}
                          onCancel={handleCancel}
                          onSendGuidance={handleSendGuidance}
                          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                          onRegenerate={handleRegenerate}
                          onEditAndResend={handleEditAndResend}
                          sessionId={currentSession?.id}
                          onFork={(messageIndex) => {
                            if (currentSession && currentProject) {
                              const newSession = createSession('Fork: ' + currentSession.title);
                              const sourceMessages = MessageStorage.listMessages(currentSession.id);
                              if (sourceMessages.length > 0) {
                                let endIdx = sourceMessages.length;
                                for (let i = messageIndex + 1; i < sourceMessages.length; i++) {
                                  if (sourceMessages[i].role === "user") { endIdx = i; break; }
                                }
                                const forkedMessages = sourceMessages.slice(0, endIdx);
                                const forkTs = Date.now();
                                for (const msg of forkedMessages) {
                                  const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
                                  MessageStorage.createMessage({
                                    ...msg, id: newMsgId,
                                    toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}` })),
                                  }, newSession.id);
                                }
                                loadMessages(newSession.id);
                              }
                            }
                          }}
                          connected={true}
                          model={cliModel}
                          onModelChange={handleModelChange}
                          mode={currentMode}
                          providerId={currentProvider}
                          collaborationMode={collaborationMode}
                          onModeChange={setCollaborationMode}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
                      )}
                      {bottomTab === "terminal" && (
                        <TerminalPanel cwd={currentProject?.path || appRoot} />
                      )}
                    </div>
                  </div>
                </div>
              }
            />
          ) : skin === "dream" ? (
            <DreamLayout>
              {sidebarOpen && (
                <Sidebar
                  identity={appIdentity}
                  onSettings={() => setShowSettings(true)}
                  onProjects={() => setShowProjectManager(true)}
                  onConfig={() => setShowConfigEditor(true)}
                  onMcp={() => setShowMcpManager(true)}
                  onSkills={() => setShowSkillManager(true)}
                  onMemory={() => setShowMemoryManager(true)}
                  onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
onAgents={() => setShowAgentManager(true)}
onCicd={() => setShowCicdPanel(true)}
onPerf={() => setShowPerfDashboard(true)}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
                  fileExplorerProjectId={fileExplorerProjectId}
                  onToggleFileExplorer={handleToggleFileExplorer}
                />
              )}

              <div className="main-area">
                <div className="panel-right">
                  <div className="panel-tabs">
                    <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
                      <MessageSquare size={14} /> {lang === "zh" ? "对话" : "Chat"}
                    </button>
                    <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
                      <Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}
                    </button>
                  </div>
                  <div className="panel-content">
                    {compactionStatus && (
                      <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                        {compactionStatus.active ? (
                          <><span className="compaction-spinner" /> 正在压缩上下文...</>
                        ) : (
                          <><CheckCircle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                        )}
                      </div>
                    )}
                    {activeNotebookId && (
                      <div className="notebook-mode-banner">
                        <span className="notebook-mode-icon"><BookOpen size={16} /></span>
<span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
<button className="notebook-mode-save" onClick={handleSaveAIResponseAsNote} title={lang === 'zh' ? '保存AI回复为笔记' : 'Save AI response as note'}><Save size={14} /></button>
<button className="notebook-mode-save" onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }} title={lang === 'zh' ? '返回工作区' : 'Back to Workspace'}><FolderOpen size={14} /></button>
<button className="notebook-mode-close" onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); setNotebookSourceFilter(null); }}><X size={14} /></button>
</div>
)}
{bottomTab === "chat" && (
                      <ChatPanel
                        onSend={handleSend}
                        onCancel={handleCancel}
                        onSendGuidance={handleSendGuidance}
                        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                        onRegenerate={handleRegenerate}
                        onEditAndResend={handleEditAndResend}
                        sessionId={currentSession?.id}
                        onFork={(messageIndex) => {
                          if (currentSession && currentProject) {
                            const newSession = createSession('Fork: ' + currentSession.title);
                            const sourceMessages = MessageStorage.listMessages(currentSession.id);
                            if (sourceMessages.length > 0) {
                              let endIdx = sourceMessages.length;
                              for (let i = messageIndex + 1; i < sourceMessages.length; i++) {
                                if (sourceMessages[i].role === "user") { endIdx = i; break; }
                              }
                              const forkedMessages = sourceMessages.slice(0, endIdx);
                              const forkTs = Date.now();
                              for (const msg of forkedMessages) {
                                const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
                                MessageStorage.createMessage({
                                  ...msg, id: newMsgId,
                                  toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}` })),
                                }, newSession.id);
                              }
                              loadMessages(newSession.id);
                            }
                          }
                        }}
                        connected={true}
                        model={cliModel}
                        onModelChange={handleModelChange}
                        mode={currentMode}
                        providerId={currentProvider}
                        collaborationMode={collaborationMode}
                        onModeChange={setCollaborationMode}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
                    )}
                    {bottomTab === "terminal" && (
                      <TerminalPanel cwd={currentProject?.path || appRoot} />
                    )}
                  </div>
                </div>
            </div>
{/* Right sidebar for Dream skin */}
<RightSidebar
collapsed={!rightRailOpen}
onToggleCollapse={() => setRightRailOpen(!rightRailOpen)}
onNewChat={() => { useProjectStore.setState({ currentProject: null }); createSession(); }}
onNewProject={() => setShowProjectManager(true)}
onImportProject={() => setShowProjectManager(true)}
onGitHubClone={() => setShowGitHubClone(true)}
onOpenSession={(sessionId, projectId) => { useProjectStore.getState().openProject(projectId); useProjectStore.getState().switchSession(sessionId); }}
editingFile={editingFile}
onEditingFileChange={setEditingFile}
refreshKey={fileExplorerRefreshKey}
/>
          </DreamLayout>
          ) : (
            <>
              {/* 默认皮肤：原始布局，不受 ThemeManager 干预 */}
          {/* P3 #46: Mobile sidebar hamburger button */}
          <button
            className="mobile-sidebar-toggle"
            onClick={() => setMobileSidebarOpen(true)}
            title={lang === "zh" ? "打开菜单" : "Open menu"}
            style={{ display: "none" }}
          >
            <Menu size={20} />
          </button>
          {sidebarOpen && (
                <Sidebar
          identity={appIdentity}
          onSettings={() => setShowSettings(true)}
          onProjects={() => setShowProjectManager(true)}
          onConfig={() => setShowConfigEditor(true)}
          onMcp={() => setShowMcpManager(true)}
          onSkills={() => setShowSkillManager(true)}
          onMemory={() => setShowMemoryManager(true)}
          onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
onAgents={() => setShowAgentManager(true)}
onCicd={() => setShowCicdPanel(true)}
onPerf={() => setShowPerfDashboard(true)}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
          fileExplorerProjectId={fileExplorerProjectId}
          onToggleFileExplorer={handleToggleFileExplorer}
        />
      )}

      <div className="main-area">
        <div className="panel-right">
          <div className="panel-tabs">
            <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
              <MessageSquare size={14} /> {lang === "zh" ? "对话" : "Chat"}
            </button>
            <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
              <Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}
            </button>
          </div>

          <div className="panel-content">
            {compactionStatus && (
              <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                {compactionStatus.active ? (
                  <><span className="compaction-spinner" /> 正在压缩上下文...</>
                ) : (
                  <><CheckCircle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                )}
              </div>
            )}
            {activeNotebookId && (
              <div className="notebook-mode-banner">
                <span className="notebook-mode-icon"><BookOpen size={16} /></span>
                <span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
<button className="notebook-mode-save" onClick={handleSaveAIResponseAsNote} title={lang === 'zh' ? '保存AI回复为笔记' : 'Save AI response as note'}><Save size={14} /></button>
<button
  className="notebook-mode-save"
  onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }}
  title={lang === 'zh' ? '返回工作区' : 'Back to Workspace'}
><FolderOpen size={14} /></button>
<button
  className="notebook-mode-close"
  onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); setNotebookSourceFilter(null); }}
>
  <X size={14} />
</button>
              </div>
            )}
            {bottomTab === "chat" && (
              <ChatPanel
                onSend={handleSend}
                onCancel={handleCancel}
                onSendGuidance={handleSendGuidance}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                onRegenerate={handleRegenerate}
                onEditAndResend={handleEditAndResend}
                sessionId={currentSession?.id}
                onFork={(messageIndex) => {
                  if (currentSession && currentProject) {
                    const newSession = createSession('Fork: ' + currentSession.title);
                    // Fork messages from SQLite via MessageStorage
                    const sourceMessages = MessageStorage.listMessages(currentSession.id);
                    if (sourceMessages.length > 0) {
                      // Fork the entire Q&A turn: from the user message at messageIndex
                      // through all subsequent assistant messages until the next user message.
                      let endIdx = sourceMessages.length;
                      for (let i = messageIndex + 1; i < sourceMessages.length; i++) {
                        if (sourceMessages[i].role === "user") {
                          endIdx = i;
                          break;
                        }
                      }
                      const forkedMessages = sourceMessages.slice(0, endIdx);
                      const forkTs = Date.now();
                      for (const msg of forkedMessages) {
                        // Generate new IDs to avoid conflicts with source messages
                        const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
                        MessageStorage.createMessage({
                          ...msg,
                          id: newMsgId,
                          toolCalls: msg.toolCalls?.map((tc) => ({
                            ...tc,
                            id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`,
                          })),
                        }, newSession.id);
                      }
                      loadMessages(newSession.id);
                    }
                  }
                }}
                connected={true}
                model={cliModel}
                onModelChange={handleModelChange}
                mode={currentMode}
                providerId={currentProvider}
                collaborationMode={collaborationMode}
                onModeChange={setCollaborationMode}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
            )}
            {bottomTab === "terminal" && (
              <TerminalPanel cwd={currentProject?.path || appRoot} />
            )}
          </div>
        </div>
      </div>

{/* Right sidebar for default skin */}
<RightSidebar
collapsed={!rightRailOpen}
onToggleCollapse={() => setRightRailOpen(!rightRailOpen)}
onNewChat={() => { useProjectStore.setState({ currentProject: null }); createSession(); }}
onNewProject={() => setShowProjectManager(true)}
onImportProject={() => setShowProjectManager(true)}
onGitHubClone={() => setShowGitHubClone(true)}
onOpenSession={(sessionId, projectId) => { useProjectStore.getState().openProject(projectId); useProjectStore.getState().switchSession(sessionId); }}
editingFile={editingFile}
onEditingFileChange={setEditingFile}
refreshKey={fileExplorerRefreshKey}
/>
        </>
          )}

          {/* P3 #46: Mobile sidebar Drawer */}
          <Drawer
            open={mobileSidebarOpen}
            onClose={() => setMobileSidebarOpen(false)}
            side="left"
            size={280}
            title={lang === "zh" ? "菜单" : "Menu"}
          >
            <Sidebar
              identity={appIdentity}
              onSettings={() => { setShowSettings(true); setMobileSidebarOpen(false); }}
              onProjects={() => { setShowProjectManager(true); setMobileSidebarOpen(false); }}
              onConfig={() => { setShowConfigEditor(true); setMobileSidebarOpen(false); }}
              onMcp={() => { setShowMcpManager(true); setMobileSidebarOpen(false); }}
              onSkills={() => { setShowSkillManager(true); setMobileSidebarOpen(false); }}
              onMemory={() => { setShowMemoryManager(true); setMobileSidebarOpen(false); }}
              onNotebooks={() => { setShowNotebookManager(true); setMobileSidebarOpen(false); }}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); setMobileSidebarOpen(false); }}
onAgents={() => { setShowAgentManager(true); setMobileSidebarOpen(false); }}
onCicd={() => { setShowCicdPanel(true); setMobileSidebarOpen(false); }}
onPerf={() => { setShowPerfDashboard(true); setMobileSidebarOpen(false); }}
              onRemoveProject={(id, name, path) => { setRemoveProjectDialog({ id, name, path }); setMobileSidebarOpen(false); }}
              fileExplorerProjectId={fileExplorerProjectId}
              onToggleFileExplorer={handleToggleFileExplorer}
              onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            />
          </Drawer>

{showSettings && (
<SettingsPanel
onClose={() => { setSettingsInitialTab("general"); setShowSettings(false); }}
initialTab={settingsInitialTab}
onSessionRecovery={() => { setShowSettings(false); setShowSessionRecovery(true); }}
          onUsageStats={() => { setShowSettings(false); setShowUsageStats(true); }}
          setShowOnboardingReplay={(v) => { setShowOnboardingReplay(v); setShowSettings(false); }}
        />
      )}
      {showProjectManager && <ProjectManager onClose={() => setShowProjectManager(false)} />}
      {showConfigEditor && currentProject && (
        <ConfigEditor
          appRoot={appRoot}
          projectPath={currentProject.path}
          onClose={() => setShowConfigEditor(false)}
        />
      )}

      {showMcpManager && (
        <div className="modal-overlay" onClick={() => setShowMcpManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <McpManager onClose={() => setShowMcpManager(false)} />
          </div>
        </div>
      )}

      {showSkillManager && (
        <div className="modal-overlay" onClick={() => setShowSkillManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SkillManager onClose={() => setShowSkillManager(false)} />
          </div>
        </div>
      )}

      {showMemoryManager && (
        <div className="modal-overlay" onClick={() => setShowMemoryManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <MemoryManager onClose={() => setShowMemoryManager(false)} />
          </div>
        </div>
      )}

      {showGitHubClone && (
        <GitHubCloneDialog onClose={() => setShowGitHubClone(false)} />
      )}

      {showCicdPanel && (
        <CicdPanel onClose={() => setShowCicdPanel(false)} />
      )}

      {showPerfDashboard && (
        <PerformanceDashboard onClose={() => setShowPerfDashboard(false)} />
      )}

      {/* P0-3: Plan Approval Card — shown when model calls exit_plan_mode */}
      {planApproval && (
        <PlanApprovalCard
          plan={planApproval.plan}
          onApprove={() => {
            planApproval.resolve({ approved: true });
            setPlanApproval(null);
          }}
          onReject={(feedback) => {
            planApproval.resolve({ approved: false, feedback });
            setPlanApproval(null);
          }}
        />
      )}

      {showSearchDialog && (
        <SearchDialog
          onClose={() => setShowSearchDialog(false)}
          onSwitchProject={(projectId) => { useProjectStore.getState().openProject(projectId); setShowSearchDialog(false); }}
          onNewSession={() => { if (currentProject) createSession(); setShowSearchDialog(false); }}
          onOpenSkills={() => { setShowSkillManager(true); setShowSearchDialog(false); }}
        />
      )}

{showNotebookManager && (
<div className="modal-overlay" onClick={() => setShowNotebookManager(false)}>
<div className="modal-editor" style={{ maxWidth: '900px', height: '80vh' }} onClick={(e) => e.stopPropagation()}>
<NotebookManager
onClose={() => setShowNotebookManager(false)}
onOpenWorkspace={(notebookId, notebookName) => {
setNotebookWorkspaceId(notebookId);
setNotebookWorkspaceName(notebookName);
setShowNotebookManager(false);
}}
onOpenNotebookChat={(notebookId, notebookName) => {
setActiveNotebookId(notebookId);
setActiveNotebookName(notebookName);
setShowNotebookManager(false);
}}
/>
</div>
</div>
)}

      {notebookWorkspaceId && (
        <div className="nb-workspace-overlay">
          <NotebookWorkspace
            notebookId={notebookWorkspaceId}
            notebookName={notebookWorkspaceName}
            onBack={() => { setNotebookWorkspaceId(null); setShowNotebookManager(true); }}
            onOpenChat={(id, name, selectedSourceIds) => {
              setActiveNotebookId(id);
              setActiveNotebookName(name);
              setNotebookWorkspaceId(null);
              // Set source filter for retrieval scope control
              setNotebookSourceFilter(selectedSourceIds && selectedSourceIds.length > 0 ? selectedSourceIds : null);
            }}
          />
        </div>
      )}

{/* B4: Citation viewer — opens SourceViewer when user clicks a source citation in chat */}
{citationViewer && (
<SourceViewer
sourceId={citationViewer.sourceId}
notebookId={citationViewer.notebookId}
highlightChunkIndex={citationViewer.chunkIndex}
onClose={() => setCitationViewer(null)}
/>
)}

      {showSessionRecovery && (
        <div className="modal-overlay" onClick={() => setShowSessionRecovery(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SessionRecovery onClose={() => setShowSessionRecovery(false)} />
          </div>
        </div>
      )}

      {showUsageStats && (
        <div className="modal-overlay" onClick={() => setShowUsageStats(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <UsageStats onClose={() => setShowUsageStats(false)} />
          </div>
        </div>
      )}

      {showTaskCenter && (
        <TaskCenter
          onClose={() => setShowTaskCenter(false)}
          initialTab={taskCenterTab}
          subagentTasks={(() => {
            try {
              const { getSubagentManager } = require("./core/subagent/subagent");
              return getSubagentManager().getAllTasks();
            } catch { return []; }
          })()}
          onSelectSubagent={() => {
            setShowTaskCenter(false);
          }}
        />
      )}

      {showAgentManager && (
        <div className="modal-overlay" onClick={() => setShowAgentManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, maxHeight: "85vh" }}>
            <AgentManager />
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px" }}>
              <button
                onClick={() => setShowAgentManager(false)}
                style={{
                  padding: "6px 16px", borderRadius: 4, fontSize: 12,
                  border: "1px solid var(--border-primary)", background: "none",
                  color: "var(--text-primary)", cursor: "pointer",
                }}
              >{lang === "zh" ? "关闭" : "Close"}</button>
            </div>
          </div>
        </div>
      )}



      {/* P1 #24: DecisionTray — inline decision UI replaces popup for main permissions */}
      {pendingPermission && (() => {
        const req = pendingPermission.request as any;
        const approvalReq: ApprovalRequest = {
          type: "approval",
          id: req.id,
          toolName: req.tool || req.title || "tool",
          description: req.title || req.description || "",
          args: typeof req.args === 'object' ? JSON.stringify(req.args, null, 2) : req.args,
        };
        return (
          <DecisionTray
            request={approvalReq}
            onApprove={(id) => {
              pendingPermission.resolve({ requestId: id, action: "allow", alwaysAllow: false });
              clearPendingPermission();
            }}
            onReject={(id) => {
              pendingPermission.resolve({ requestId: id, action: "deny", alwaysAllow: false });
              clearPendingPermission();
            }}
            onClarify={() => {}}
          />
        );
      })()}

      {/* Background session permission (from delegation system) — still uses popup as fallback */}
      {!pendingPermission && backgroundPermission && (
        <PermissionDialog
          request={{ ...(backgroundPermission.request as any), title: `[委派任务] ${(backgroundPermission.request as any).title || backgroundPermission.request.tool || ''}` } as any}
          onResolve={(allow, alwaysAllow) => {
            backgroundPermission.resolve({
              requestId: backgroundPermission.request.id,
              action: allow ? "allow" : "deny",
              alwaysAllow,
            });
            setPendingPermissions((prev) => {
              const next = new Map(prev);
              next.delete(backgroundPermission.sessionId);
              return next;
            });
          }}
        />
      )}

      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={confirmDialog.onCancel}
        />
      )}

      {/* Safe project removal dialog — 3 options, click outside = cancel */}
      {removeProjectDialog && (() => {
        const { id, name, path } = removeProjectDialog;
        return createPortal(
          <div className="confirm-overlay" onClick={() => setRemoveProjectDialog(null)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
              <div className="confirm-title">{lang === "zh" ? "移除项目" : "Remove Project"}</div>
              <div className="confirm-message" style={{ marginBottom: 16 }}>
                {lang === "zh" ? `确定要移除项目 "${name}" 吗？` : `Remove project "${name}"?`}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 8 }}>
                <button
                  style={{ padding: "10px 16px", borderRadius: 6, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", cursor: "pointer", fontSize: 13, textAlign: "left" }}
                  onClick={() => { useProjectStore.getState().deleteProject(id); setRemoveProjectDialog(null); }}
                >
                  <span style={{ fontWeight: 600 }}>📁 {lang === "zh" ? "仅移除项目" : "Remove Only"}</span>
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{lang === "zh" ? "从列表移除，不删除文件" : "Remove from list, keep files"}</div>
                </button>
                <button
                  style={{ padding: "10px 16px", borderRadius: 6, border: "1px solid #e74c3c", background: "none", color: "#e74c3c", cursor: "pointer", fontSize: 13, textAlign: "left" }}
                  onClick={async () => {
                    try {
                      const { invoke } = (window as any).__TAURI__.core;
                      await invoke("delete_directory", { path });
                    } catch (e) {
                      console.error("Failed to move to recycle bin:", e);
                    }
                    useProjectStore.getState().deleteProject(id);
                    setRemoveProjectDialog(null);
                  }}
                >
                  <span style={{ fontWeight: 600 }}><Trash2 size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> {lang === "zh" ? "移除并删除文件到回收站" : "Remove & Recycle"}</span>
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{lang === "zh" ? "从列表移除 + 文件送入回收站" : "Remove from list + send files to Recycle Bin"}</div>
                </button>
              </div>
              <button
                className="confirm-btn cancel"
                style={{ width: "100%", padding: "8px 16px", borderRadius: 6 }}
                onClick={() => setRemoveProjectDialog(null)}
              >
                {lang === "zh" ? "取消" : "Cancel"}
              </button>
            </div>
          </div>,
          document.body
        );
      })()}

      {showCloseConfirm && (
        <CloseConfirmDialog onChoose={handleCloseChoice} />
      )}

      {/* P1-8: Needs You — Agent proactively asks user a precise question */}
      {currentSession && (
        <NeedsYouPanel
          sessionId={currentSession.id}
          onAnswer={(itemId, answer) => {
            import("./core/llm/needs-you-queue").then(({ getNeedsYouQueue }) => {
              getNeedsYouQueue().answer(itemId, answer);
            });
          }}
          onSkip={(sid) => {
            import("./core/llm/needs-you-queue").then(({ getNeedsYouQueue }) => {
              getNeedsYouQueue().skip(sid);
            });
          }}
        />
      )}

      {/* S4: Inline Diff Review for file overwrites (replaces modal popup) */}
      {pendingWriteConfirm && (
        <div className="inline-diff-container">
          <InlineDiffReview
            filePath={pendingWriteConfirm.filePath}
            before={pendingWriteConfirm.existingContent}
            after={pendingWriteConfirm.newContent}
            sequenceInfo={writeConfirmStat.count > 1 ? `文件 ${writeConfirmStat.count}` : undefined}
            onAccept={() => {
              pendingWriteConfirm.resolve({ action: "accept" });
              clearPendingWriteConfirm();
            }}
            onReject={() => {
              pendingWriteConfirm.resolve({ action: "reject" });
              clearPendingWriteConfirm();
            }}
            onCustom={(instruction) => {
              pendingWriteConfirm.resolve({ action: "custom", instruction });
              clearPendingWriteConfirm();
            }}
            onAcceptAll={() => {
              // Auto-approve this file and all future files in this turn
              pendingWriteConfirm.resolve({ action: "accept" });
              clearPendingWriteConfirm();
              setSessionAutoApprove(true);
            }}
          />
        </div>
      )}

      {/* D3: Interactive Form Dialog */}
      {pendingInteractiveForm && (
        <InteractiveFormDialog
          questions={pendingInteractiveForm.questions}
          onSubmit={(answers) => {
            pendingInteractiveForm.resolve(answers);
            clearPendingInteractiveForm();
          }}
          onCancel={() => {
            pendingInteractiveForm.resolve({});
            clearPendingInteractiveForm();
          }}
        />
      )}

      {/* P1: Clarification Form — AI asks structured questions */}
      {pendingClarification && (
        <div className="dialog-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { pendingClarification.resolve([]); clearPendingClarification(); }}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: "500px", width: "90vw" }}>
            <ClarificationForm
              form={pendingClarification.form}
              onSubmit={(answers) => {
                const flatAnswers = Object.values(answers).flatMap(a => Array.isArray(a) ? a : [a]) as string[];
                pendingClarification.resolve(flatAnswers);
                clearPendingClarification();
              }}
              onCancel={() => {
                pendingClarification.resolve([]);
                clearPendingClarification();
              }}
            />
          </div>
        </div>
      )}

      {/* P1: Correction Result Panel — fact-check comparison */}
      {pendingCorrection && (
        <div className="dialog-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => clearPendingCorrection()}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: "800px", width: "90vw", maxHeight: "80vh", overflowY: "auto" }}>
            <CorrectionResultPanel
              original={pendingCorrection.original}
              corrected={pendingCorrection.corrected}
              changes={pendingCorrection.changes}
              onApply={() => {
                // Replace the last assistant message content with the corrected version
                const msgs = useAppStore.getState().messages;
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant' && m.status === 'done');
                if (lastAssistant) {
                  useAppStore.getState().updateMessage(lastAssistant.id, { content: pendingCorrection.corrected });
                  if (currentSession) saveMessages(currentSession.id);
                }
                clearPendingCorrection();
              }}
              onDismiss={() => {
                clearPendingCorrection();
              }}
            />
          </div>
        </div>
      )}

      {/* P1: Pipeline Next Step Dialog */}
      {pendingPipelineStep && (
        <PipelineNextStepDialog
          contextItems={pendingPipelineStep.contextItems}
          onSubmit={(_selectedContext, customPrompt, _mode) => {
            if (customPrompt) {
              handleSend(customPrompt);
            }
            clearPendingPipelineStep();
          }}
          onDismiss={() => {
            clearPendingPipelineStep();
          }}
        />
      )}

      {/* P2: Quick Access Cards — show agent shortcuts */}
      {showQuickAccess && messages.length === 0 && !isStreaming && (
        <div style={{ padding: "12px 16px", maxWidth: "600px", margin: "0 auto" }}>
          <QuickAccessCards
            agents={getAgentRegistry().getPrimary().map(a => ({
              id: a.id,
              name: a.name,
              description: a.description,
              icon: a.id === 'build' ? <Hammer size={20} /> : a.id === 'plan' ? <ClipboardList size={20} /> : a.id === 'explore' ? <Search size={20} /> : <Bot size={20} />,
            }))}
            favoriteIds={quickAccessFavorites}
            onSelect={(agentId) => {
              const agent = getAgentRegistry().get(agentId);
              if (agent) {
                // Switch collaboration mode based on agent's config
                if (agent.collaborationMode === "plan") {
                  setCollaborationMode("plan");
                } else {
                  setCollaborationMode("default");
                }
                // Pre-fill input with agent context and send
                const prompt = lang === 'zh'
                  ? `使用${agent.name}模式：${agent.description}`
                  : `Use ${agent.name} mode: ${agent.description}`;
                handleSend(prompt);
              }
              setShowQuickAccess(false);
            }}
            onToggleFavorite={(agentId) => {
              setQuickAccessFavorites(prev => {
                const next = new Set(prev);
                if (next.has(agentId)) next.delete(agentId);
                else next.add(agentId);
                setSettingJSON("codem-quick-access-favorites", Array.from(next));
                return next;
              });
            }}
          />
        </div>
      )}

      {/* D2: Prompt Change Review Dialog */}
      {pendingPromptChanges && (
        <PromptChangeReviewDialog
          changes={pendingPromptChanges.changes}
          onApply={(appliedChanges) => {
            // Here you would apply the changes to the actual system prompt
            // For now, we just confirm what was applied
            const msg = appliedChanges.length > 0
              ? `Applied ${appliedChanges.length} prompt change(s): ${appliedChanges.map(c => c.name).join(", ")}`
              : "No changes were applied.";
            pendingPromptChanges.resolve({ applied: appliedChanges.length > 0, message: msg });
            clearPendingPromptChanges();
          }}
          onCancel={() => {
            pendingPromptChanges.resolve({ applied: false, message: "User cancelled all changes." });
            clearPendingPromptChanges();
          }}
        />
      )}

      {/* P2: Onboarding tour for first-time users or replay from Help */}
      {(showOnboarding || showOnboardingReplay) && (
        <OnboardingTour
          steps={[
            { target: ".chat-panel", title: lang === "zh" ? "对话面板" : "Chat Panel", content: lang === "zh" ? "在这里与 AI 进行对话交互" : "Chat with AI here", position: "right" },
            { target: ".sidebar-toggle", title: lang === "zh" ? "侧边栏" : "Sidebar", content: lang === "zh" ? "管理会话历史和项目" : "Manage sessions and projects", position: "right" },
            { target: ".model-selector", title: lang === "zh" ? "模型选择" : "Model Selector", content: lang === "zh" ? "切换不同的 AI 模型" : "Switch between AI models", position: "bottom" },
            { target: ".message-input", title: lang === "zh" ? "输入区域" : "Input Area", content: lang === "zh" ? "输入你的问题或任务，支持附件上传和技能选择" : "Type your questions, upload files, and select skills", position: "top" },
          ]}
          onComplete={() => {
            setSetting("onboarding-completed", "1");
            setShowOnboarding(false);
            setShowOnboardingReplay(false);
          }}
          onSkip={() => {
            setSetting("onboarding-completed", "1");
            setShowOnboarding(false);
            setShowOnboardingReplay(false);
          }}
        />
      )}
        </>
      )}
      </div>

</div>
</TooltipProvider>
);
}

export default App;

