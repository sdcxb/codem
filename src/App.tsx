import { useEffect, useState, useRef, useCallback } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
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
import { ConfirmDialog } from "./components/ConfirmDialog";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { McpManager } from "./components/McpManager";
import { SkillManager } from "./components/SkillManager";
import { MemoryManager } from "./components/MemoryManager";
import { SessionRecovery } from "./components/SessionRecovery";
import { UsageStats } from "./components/UsageStats";
import { DiffViewer } from "./components/DiffViewer";
import { InteractiveFormDialog } from "./components/InteractiveFormDialog";
import { PromptChangeReviewDialog } from "./components/PromptChangeReviewDialog";
import { NotebookManager } from "./components/NotebookManager";
import { GitHubCloneDialog } from "./components/GitHubCloneDialog";
import { SearchDialog } from "./components/SearchDialog";
import type { InteractiveFormQuestion, PromptChange } from "./core/llm/tools";
import { useAppStore } from "./store";
import { useProjectStore } from "./core/store";
import { loadAppIdentity } from "./core/config/loader";
import { AppIdentity, type Session } from "./core/types";
import { getLLMEngine } from "./core/llm";
import { getMiMoAuth } from "./core/auth/mimo";
import type { PermissionRequest, PermissionResult } from "./core/permission/permission";
import { initDatabase, resetDatabase } from "./core/storage";
import { migrateFromLocalStorage } from "./core/storage/migration";
import { getSetting, setSetting, getSettingJSON } from "./core/storage/settings";
import { setLang, useLang, S } from "./core/i18n/lang";
import * as MessageStorage from "./core/storage/message";
import { formatAttachmentsInline } from "./core/llm/attachment-formatter";
import { syncAttachmentsToWorkspace } from "./core/llm/attachment-sync";
import { ThemeManager, useSkin } from "./core/theme";
import { HubLayout } from "./components/HubLayout";
import { DreamLayout } from "./components/DreamLayout";

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
  const { messages, addMessage, appendToMessage, setStreaming, isStreaming, addToolCall, updateToolCall, loadMessages, saveMessages, setLLMStatus } = useAppStore();
  const { currentProject, currentSession, createSession, dbReady, loadFromDB } = useProjectStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [appRoot, setAppRoot] = useState<string>(APP_ROOT_FALLBACK);
  const [showSettings, setShowSettings] = useState(false);
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showMcpManager, setShowMcpManager] = useState(false);
  const [showSkillManager, setShowSkillManager] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
  const [showNotebookManager, setShowNotebookManager] = useState(false);
  const [showGitHubClone, setShowGitHubClone] = useState(false);
  const [showSearchDialog, setShowSearchDialog] = useState(false);
  const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
  const [activeNotebookName, setActiveNotebookName] = useState<string>('');
  const [showSessionRecovery, setShowSessionRecovery] = useState(false);
  const [showUsageStats, setShowUsageStats] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>("chat");
  const [fileExplorerProjectId, setFileExplorerProjectId] = useState<string | null>(null);
  const [fileExplorerRefreshKey, setFileExplorerRefreshKey] = useState(0);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [appIdentity, setAppIdentity] = useState<AppIdentity | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [cliModel, setCliModel] = useState("mimo-v2.5-pro");
  const [currentMode, setCurrentMode] = useState<"cli" | "api">("cli");
  const [currentProvider, setCurrentProvider] = useState("mimo");
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

  // S4: Pending write confirmation for diff review
  const [pendingWriteConfirm, setPendingWriteConfirm] = useState<{
    filePath: string;
    existingContent: string;
    newContent: string;
    resolve: (result: import("./core/llm/tools").WriteConfirmResult) => void;
  } | null>(null);

  // D3: Pending interactive form
  const [pendingInteractiveForm, setPendingInteractiveForm] = useState<{
    questions: InteractiveFormQuestion[];
    resolve: (answers: Record<string, unknown>) => void;
  } | null>(null);

  // D2: Pending prompt changes
  const [pendingPromptChanges, setPendingPromptChanges] = useState<{
    changes: PromptChange[];
    resolve: (result: { applied: boolean; message: string }) => void;
  } | null>(null);

  // Handle model change from chat header - sync with engine
  const handleModelChange = useCallback((model: string) => {
    // Abort any ongoing streaming
    if (abortRef.current) {
      abortRef.current.abort();
    }

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
  }, []);
const [compactionStatus, setCompactionStatus] = useState<{ active: boolean; messagesRemoved?: number } | null>(null);
const [pendingPermission, setPendingPermission] = useState<{
request: PermissionRequest;
    resolve: (result: PermissionResult) => void;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null);
  const engineRef = useRef(getLLMEngine());
  const abortRef = useRef<AbortController | null>(null);
  const mimoSessionRef = useRef<string | null>(null);
  const messagesSessionRef = useRef<string | null>(null);
  
  // Streaming buffer - batch text updates to reduce re-renders
  const streamBufferRef = useRef<{ id: string; text: string; timer: ReturnType<typeof setTimeout> | null }>({ id: "", text: "", timer: null });
  const generatedFilesRef = useRef<Set<string>>(new Set());
  const flushStreamBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    if (buffer.id && buffer.text) {
      appendToMessage(buffer.id, buffer.text);
      buffer.text = "";
    }
    buffer.timer = null;
  }, [appendToMessage]);

  // Flush buffer on unmount
  useEffect(() => {
    return () => {
      if (streamBufferRef.current.timer) {
        clearTimeout(streamBufferRef.current.timer);
      }
      flushStreamBuffer();
    };
  }, [flushStreamBuffer]);

  useEffect(() => {
    // Initialize SQLite first, then load everything from database
    (async () => {
      try {
        await initDatabase();
        await migrateFromLocalStorage();
        ThemeManager.init();
        useProjectStore.getState().loadFromDB();
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
    })();
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
        // CLI mode: always use mimo model
        const model = "mimo-v2.5-pro";
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

    const providerName = engine.getDefaultProvider();
    const modelName = engine.getDefaultModel();
    

    const providerObj2 = engine.providers.get(providerName);
    if (providerObj2 && !providerObj2.isConfigured()) {
      
      setStreaming(false);
      addMessage({
        id: 'err-' + Date.now(),
        role: 'system',
        content: '[Error] ' + providerName + ' not configured. Please set API Key in Settings.',
        timestamp: Date.now(),
        status: 'error',
      });
      return;
    }

    
    const cwd = currentProject?.path || await getAppRoot();
    let assistantMsgId = `assistant-${Date.now()}`;
    let assistantContent = "";
    let reasoningContent = "";
    let lastAssistantMsgId = "";

    // Record start time for execution timer
    useAppStore.getState().setStreamStartTime(Date.now());

    try {
      abortRef.current = new AbortController();

      for await (const event of engine.process(session.id, message, cwd, undefined, {
        onPermissionRequest: (request) => {
          return new Promise((resolve) => {
            setPendingPermission({ request, resolve });
          });
        },
        collaborationMode,
        // S4: Wire up write confirmation for diff review
        onWriteConfirm: (params) => {
          return new Promise((resolve) => {
            setPendingWriteConfirm({ ...params, resolve });
          });
        },
        // Security mode: three-tier approval policy
        securityMode,
        // D2: Prompt optimization callbacks
        getSystemPrompt: () => {
          // Return the current system prompt from the engine
          return engine.buildSystemPrompt(session.id, undefined, cwd);
        },
        onPromptChangeSubmit: (changes: PromptChange[]) => {
          return new Promise((resolve) => {
            setPendingPromptChanges({ changes, resolve });
          });
        },
        // D3: Interactive form callback
        onInteractiveForm: (questions: InteractiveFormQuestion[]) => {
          return new Promise((resolve) => {
            setPendingInteractiveForm({ questions, resolve });
          });
        },
        // F5: Notebook knowledge mode
        ...(activeNotebookId ? { notebookId: activeNotebookId } : {}),
        // User-selected skills (injected with 🎯 marker in system prompt)
        ...(selectedSkills && selectedSkills.length > 0 ? { userSelectedSkills: selectedSkills } : {}),
      })) {
        if (abortRef.current.signal.aborted) break;

        switch (event.type) {
          case "reasoning_delta":
            reasoningContent += event.text;
            // Create assistant message if it doesn't exist yet (reasoning often arrives before text)
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              addMessage({
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
            useAppStore.getState().updateMessage(assistantMsgId, {
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
              flushStreamBuffer();
              if (useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
                useAppStore.getState().updateMessage(assistantMsgId, {
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
            break;
          }

          case "text_delta":
            assistantContent += event.text;
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              addMessage({
                id: assistantMsgId,
                role: "assistant",
                content: assistantContent,
                timestamp: Date.now(),
                status: "streaming",
              });
if (session) {
saveMessages(session.id);
}
            }
            streamBufferRef.current.id = assistantMsgId;
            streamBufferRef.current.text += event.text;
            if (!streamBufferRef.current.timer) {
              streamBufferRef.current.timer = setTimeout(flushStreamBuffer, 100);
            }
            break;

          case "tool_start": {
            flushStreamBuffer();
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
                addMessage({
                  id: assistantMsgId,
                  role: "assistant",
                  content: "",
                  timestamp: Date.now(),
                  status: "streaming",
                });
              }
              streamBufferRef.current.id = assistantMsgId;
              addToolCall(assistantMsgId, {
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
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              // Extract the output string from the result
              let resultStr: string;
              if (typeof event.result === "string") {
                resultStr = event.result;
              } else if (event.result && typeof event.result === "object" && "output" in event.result) {
                resultStr = (event.result as any).output;
              } else {
                resultStr = JSON.stringify(event.result || "");
              }
              // Filter out <system-reminder> tags from tool results
              resultStr = resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
              updateToolCall(assistantMsgId, tc.id, {
                status: "done",
                result: resultStr,
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
            const tc = "toolCall" in event ? event.toolCall : null;
            const err = "error" in event ? event.error : "Unknown error";
            
            if (tc) {
              updateToolCall(assistantMsgId, tc.id, {
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
            // Auto-clear compaction status after 3 seconds
            setTimeout(() => setCompactionStatus(null), 3000);
            break;
          }

          case "end": {
            // Handle overflow result (context completely exhausted)
            if ("result" in event && event.result?.type === "overflow") {
              const msg = event.result.message || "上下文窗口已满，请开启新对话。";
              addMessage({
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
        useAppStore.getState().updateMessage(assistantMsgId, {
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
    } finally {
      // Flush any remaining buffered text
      flushStreamBuffer();
      // Clear step progress after a short delay so user sees the final state
      setTimeout(() => useAppStore.getState().setStepProgress(null), 2000);
      // Clear stream start time
      useAppStore.getState().setStreamStartTime(null);
      
      setStreaming(false);
      abortRef.current = null;
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

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Note: Sub-agents continue running when main task is paused (Codex strategy)
    // Only global pause should freeze everything
    engineRef.current.abort();
    setStreaming(false);
  };

  // Global pause: freeze everything (main + sub-agents)
  const handleGlobalPause = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
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
      <TitleBar />
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
              onTasks={() => setShowProjectManager(true)}
              onSkills={() => setShowSkillManager(true)}
              onNotebooks={() => setShowNotebookManager(true)}
              onAutomations={() => setShowMcpManager(true)}
              onSearch={() => setShowSearchDialog(true)}
              onSettings={() => setShowSettings(true)}
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
                    onRemoveProject={(id, name, path) => {
                      setConfirmDialog({
                        title: "Remove Project",
                        message: `Remove project "${name}"?`,
                        confirmLabel: "Remove Only",
                        cancelLabel: "Delete Files",
                        onConfirm: () => {
                          useProjectStore.getState().deleteProject(id);
                          setConfirmDialog(null);
                        },
                        onCancel: async () => {
                          try {
                            const { invoke } = (window as any).__TAURI__.core;
                            await invoke("delete_directory", { path });
                          } catch (e) {
                            console.error("Failed to delete directory:", e);
                          }
                          useProjectStore.getState().deleteProject(id);
                          setConfirmDialog(null);
                        },
                      });
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
                        💬 {lang === "zh" ? "对话" : "Chat"}
                      </button>
                      <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
                        ⌨️ {lang === "zh" ? "终端" : "Terminal"}
                      </button>
                    </div>
                    <div className="panel-content">
                      {compactionStatus && (
                        <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                          {compactionStatus.active ? (
                            <><span className="compaction-spinner" /> 正在压缩上下文...</>
                          ) : (
                            <>✅ 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                          )}
                        </div>
                      )}
                      {activeNotebookId && (
                        <div className="notebook-mode-banner">
                          <span className="notebook-mode-icon">📓</span>
                          <span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
                          <button className="notebook-mode-close" onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); }}>✕</button>
                        </div>
                      )}
                      {bottomTab === "chat" && (
                        <ChatPanel
                          onSend={handleSend}
                          onCancel={handleCancel}
                          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                          onRegenerate={handleRegenerate}
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
                  onRemoveProject={(id, name, path) => {
                    setConfirmDialog({
                      title: "Remove Project",
                      message: `Remove project "${name}"?`,
                      confirmLabel: "Remove Only",
                      cancelLabel: "Delete Files",
                      onConfirm: () => {
                        useProjectStore.getState().deleteProject(id);
                        setConfirmDialog(null);
                      },
                      onCancel: async () => {
                        try {
                          const { invoke } = (window as any).__TAURI__.core;
                          await invoke("delete_directory", { path });
                        } catch (e) {
                          console.error("Failed to delete directory:", e);
                        }
                        useProjectStore.getState().deleteProject(id);
                        setConfirmDialog(null);
                      },
                    });
                  }}
                  fileExplorerProjectId={fileExplorerProjectId}
                  onToggleFileExplorer={handleToggleFileExplorer}
                />
              )}

              <div className="main-area">
                <div className="panel-right">
                  <div className="panel-tabs">
                    <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
                      💬 {lang === "zh" ? "对话" : "Chat"}
                    </button>
                    <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
                      ⌨️ {lang === "zh" ? "终端" : "Terminal"}
                    </button>
                  </div>
                  <div className="panel-content">
                    {compactionStatus && (
                      <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                        {compactionStatus.active ? (
                          <><span className="compaction-spinner" /> 正在压缩上下文...</>
                        ) : (
                          <>✅ 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                        )}
                      </div>
                    )}
                    {activeNotebookId && (
                      <div className="notebook-mode-banner">
                        <span className="notebook-mode-icon">📓</span>
                        <span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
                        <button className="notebook-mode-close" onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); }}>✕</button>
                      </div>
                    )}
                    {bottomTab === "chat" && (
                      <ChatPanel
                        onSend={handleSend}
                        onCancel={handleCancel}
                        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                        onRegenerate={handleRegenerate}
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
                      />
                    )}
                    {bottomTab === "terminal" && (
                      <TerminalPanel cwd={currentProject?.path || appRoot} />
                    )}
                  </div>
                </div>
              </div>
            </DreamLayout>
          ) : (
            <>
              {/* 默认皮肤：原始布局，不受 ThemeManager 干预 */}
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
          onRemoveProject={(id, name, path) => {
            setConfirmDialog({
              title: "Remove Project",
              message: `Remove project "${name}"?`,
              confirmLabel: "Remove Only",
              cancelLabel: "Delete Files",
              onConfirm: () => {
                useProjectStore.getState().deleteProject(id);
                setConfirmDialog(null);
              },
              onCancel: async () => {
                // Delete files from disk
                try {
                  const { invoke } = (window as any).__TAURI__.core;
                  await invoke("delete_directory", { path });
                } catch (e) {
                  console.error("Failed to delete directory:", e);
                }
                useProjectStore.getState().deleteProject(id);
                setConfirmDialog(null);
              },
            });
          }}
          fileExplorerProjectId={fileExplorerProjectId}
          onToggleFileExplorer={handleToggleFileExplorer}
        />
      )}

      <div className="main-area">
        <div className="panel-right">
          <div className="panel-tabs">
            <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
              💬 {lang === "zh" ? "对话" : "Chat"}
            </button>
            <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
              ⌨️ {lang === "zh" ? "终端" : "Terminal"}
            </button>
          </div>

          <div className="panel-content">
            {compactionStatus && (
              <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                {compactionStatus.active ? (
                  <><span className="compaction-spinner" /> 正在压缩上下文...</>
                ) : (
                  <>✅ 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                )}
              </div>
            )}
            {activeNotebookId && (
              <div className="notebook-mode-banner">
                <span className="notebook-mode-icon">📓</span>
                <span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
                <button
                  className="notebook-mode-close"
                  onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); }}
                >
                  ✕
                </button>
              </div>
            )}
            {bottomTab === "chat" && (
              <ChatPanel
                onSend={handleSend}
                onCancel={handleCancel}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                onRegenerate={handleRegenerate}
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
              />
            )}
            {bottomTab === "terminal" && (
              <TerminalPanel cwd={currentProject?.path || appRoot} />
            )}
          </div>
        </div>
      </div>
            </>
          )}

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSessionRecovery={() => { setShowSettings(false); setShowSessionRecovery(true); }}
          onUsageStats={() => { setShowSettings(false); setShowUsageStats(true); }}
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
              onOpenNotebookChat={(notebookId, notebookName) => {
                setActiveNotebookId(notebookId);
                setActiveNotebookName(notebookName);
                setShowNotebookManager(false);
              }}
            />
          </div>
        </div>
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

      {fileExplorerProjectId && currentProject && fileExplorerProjectId === currentProject.id && (
        <div className="floating-explorer">
          <div className="floating-explorer-header">
            <span>File Explorer</span>
            <button className="floating-explorer-close" onClick={() => setFileExplorerRefreshKey((k) => k + 1)} title="Refresh">🔄</button>
            <button className="floating-explorer-close" onClick={() => setFileExplorerProjectId(null)}>✕</button>
          </div>
          <div className="floating-explorer-body">
            <FileExplorer cwd={currentProject.path} onFileClick={(p) => setEditingFile(p)} refreshKey={fileExplorerRefreshKey} />
          </div>
        </div>
      )}

      {editingFile && (
        <div className="modal-overlay" onClick={() => setEditingFile(null)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <FileEditor filePath={editingFile} onClose={() => setEditingFile(null)} />
          </div>
        </div>
      )}

      {pendingPermission && (
        <PermissionDialog
          request={pendingPermission.request}
          onResolve={(allow, alwaysAllow) => {
            pendingPermission.resolve({
              requestId: pendingPermission.request.id,
              action: allow ? "allow" : "deny",
              alwaysAllow,
            });
            setPendingPermission(null);
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

      {showCloseConfirm && (
        <CloseConfirmDialog onChoose={handleCloseChoice} />
      )}

      {/* S4: Diff Review Dialog for file overwrites */}
      {pendingWriteConfirm && (
        <div className="modal-overlay" onClick={() => {
          pendingWriteConfirm.resolve({ action: "reject" });
          setPendingWriteConfirm(null);
        }}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "90vw", width: "900px" }}>
            <DiffViewer
              filePath={pendingWriteConfirm.filePath}
              before={pendingWriteConfirm.existingContent}
              after={pendingWriteConfirm.newContent}
              onAccept={() => {
                pendingWriteConfirm.resolve({ action: "accept" });
                setPendingWriteConfirm(null);
              }}
              onReject={() => {
                pendingWriteConfirm.resolve({ action: "reject" });
                setPendingWriteConfirm(null);
              }}
              onCustom={(instruction) => {
                pendingWriteConfirm.resolve({ action: "custom", instruction });
                setPendingWriteConfirm(null);
              }}
              onClose={() => {
                pendingWriteConfirm.resolve({ action: "reject" });
                setPendingWriteConfirm(null);
              }}
            />
          </div>
        </div>
      )}

      {/* D3: Interactive Form Dialog */}
      {pendingInteractiveForm && (
        <InteractiveFormDialog
          questions={pendingInteractiveForm.questions}
          onSubmit={(answers) => {
            pendingInteractiveForm.resolve(answers);
            setPendingInteractiveForm(null);
          }}
          onCancel={() => {
            pendingInteractiveForm.resolve({});
            setPendingInteractiveForm(null);
          }}
        />
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
            setPendingPromptChanges(null);
          }}
          onCancel={() => {
            pendingPromptChanges.resolve({ applied: false, message: "User cancelled all changes." });
            setPendingPromptChanges(null);
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

