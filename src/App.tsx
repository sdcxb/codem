import { useEffect, useState, useRef, useCallback } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { FileExplorer } from "./components/FileExplorer";
import { FileEditor } from "./components/FileEditor";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProjectManager } from "./components/ProjectManager";
import { ConfigEditor } from "./components/ConfigEditor";
import { BootstrapWizard } from "./components/BootstrapWizard";
import { PermissionDialog } from "./components/PermissionDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { McpManager } from "./components/McpManager";
import { SkillManager } from "./components/SkillManager";
import { MemoryManager } from "./components/MemoryManager";
import { SessionRecovery } from "./components/SessionRecovery";
import { UsageStats } from "./components/UsageStats";
import { useAppStore } from "./store";
import { useProjectStore } from "./core/store";
import { loadAppIdentity } from "./core/config/loader";
import { AppIdentity } from "./core/types";
import { getLLMEngine } from "./core/llm";
import { getMiMoAuth } from "./core/auth/mimo";
import type { PermissionRequest, PermissionResult } from "./core/permission/permission";
import { initDatabase, resetDatabase } from "./core/storage";
import { migrateFromLocalStorage } from "./core/storage/migration";
import { getSetting, setSetting, getSettingJSON } from "./core/storage/settings";
import { setLang, useLang, S } from "./core/i18n/lang";
import * as MessageStorage from "./core/storage/message";

const APP_ROOT = "D:\\mimo";
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
  const { messages, addMessage, appendToMessage, setStreaming, isStreaming, addToolCall, updateToolCall, loadMessages, saveMessages } = useAppStore();
  const { currentProject, currentSession, createSession, dbReady, loadFromDB } = useProjectStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showMcpManager, setShowMcpManager] = useState(false);
  const [showSkillManager, setShowSkillManager] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // WebSocket connection for CLI mode
  const connectWebSocket = useCallback(() => {
    if (getMode() !== "cli") return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket("ws://localhost:3001");

      ws.onopen = () => {};

      ws.onmessage = (event) => {
        try {
          const e = JSON.parse(event.data as string);
          handleWSMessage(e);
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connectWebSocket, 2000);
      };

      ws.onerror = () => {};
      wsRef.current = ws;
    } catch {}
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connectWebSocket]);

  useEffect(() => {
    if (currentProject && currentSession) {
      // Save old messages to old session before switching
      if (messagesSessionRef.current && messagesSessionRef.current !== currentSession.id && messages.length > 0) {
        saveMessages(messagesSessionRef.current);
      }
      messagesSessionRef.current = currentSession.id;
      loadMessages(currentSession.id);
      const saved = loadCliSessionId(currentProject.id, currentSession.id);
      mimoSessionRef.current = saved;
    }
  }, [currentProject?.id, currentSession?.id]);

  // Auto-save messages with debounce (every 2 seconds during streaming, immediately when done)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (currentProject && currentSession && messages.length > 0 && messagesSessionRef.current === currentSession.id) {
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
      if (currentProject && currentSession && messages.length > 0) {
        saveMessages(currentSession.id);
      }
    };
  }, [currentSession?.id]);

  // ========== Send Message ==========
  const handleSend = async (message: string, attachments?: any[]) => {
    if (!currentSession) return;

    
    useProjectStore.getState().updateSession(currentSession.id, {
      messageCount: currentSession.messageCount + 1,
      lastMessageAt: Date.now(),
    });

    let userContent = message;
    if (attachments && attachments.length > 0) {
      const attachmentInfo = attachments.map((a: any) => {
        if (a.type === "image") return `[Image: ${a.name}]`;
        return `[File: ${a.name}${a.size ? ` (${a.size} bytes)` : ""}]`;
      }).join("\n");
      userContent = attachmentInfo + (message ? "\n" + message : "");
    }

    
    addMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: userContent,
      timestamp: Date.now(),
      status: "done",
      attachments,
    });

    // Immediately save to database so agentic loop can read it
    if (currentSession) {
      saveMessages(currentSession.id);
    }
    

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

    
    const cwd = currentProject?.path || APP_ROOT;
    let assistantMsgId = `assistant-${Date.now()}`;
    let assistantContent = "";
    let reasoningContent = "";
    let lastAssistantMsgId = "";

    // Record start time for execution timer
    useAppStore.getState().setStreamStartTime(Date.now());

    try {
      abortRef.current = new AbortController();

      for await (const event of engine.process(currentSession.id, message, cwd, undefined, {
        onPermissionRequest: (request) => {
          return new Promise((resolve) => {
            setPendingPermission({ request, resolve });
          });
        },
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
              if (currentSession) {
                saveMessages(currentSession.id);
              }
            }
            // Update message with reasoning content
            useAppStore.getState().updateMessage(assistantMsgId, {
              reasoning: reasoningContent
            } as any);
            break;

          case "start": {
            // New agentic loop iteration — keep the SAME assistant message
            // so all iterations accumulate into one reply (text + reasoning + tools)
            const iter = 'iteration' in event ? event.iteration : 1;
            if (iter > 1) {
              // Add a visual separator between iterations in reasoning
              const sep = `\n\n---\n\n`;
              reasoningContent += sep;
              // Update the existing message with the separator
              const existing = useAppStore.getState().messages.find((m) => m.id === assistantMsgId);
              if (existing) {
                useAppStore.getState().updateMessage(assistantMsgId, {
                  reasoning: reasoningContent
                } as any);
              }
            }
            lastAssistantMsgId = assistantMsgId;
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
              if (currentSession) {
                saveMessages(currentSession.id);
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
              if (currentSession) {
                saveMessages(currentSession.id);
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
              if (currentSession) {
                saveMessages(currentSession.id);
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
              if (currentSession) {
                saveMessages(currentSession.id);
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
            if (currentSession) {
              loadMessages(currentSession.id);
              saveMessages(currentSession.id);
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
      if (currentProject && currentSession) {
        saveMessages(currentSession.id);
      }
    }
  };

  // WebSocket message handler for CLI mode
  const currentMsgIdRef = useRef<string | null>(null);

  const handleWSMessage = (e: any) => {
    // Capture mimo session ID from response and persist
    if (e.sessionID && !mimoSessionRef.current) {
      mimoSessionRef.current = e.sessionID;
      if (currentProject && currentSession) {
        saveCliSessionId(currentProject.id, currentSession.id, e.sessionID);
      }
    }

    switch (e.type) {
      case "text": {
        const text = e.part?.text || "";
        const msgId = e.part?.messageID || currentMsgIdRef.current || `msg-${Date.now()}`;
        if (!currentMsgIdRef.current || currentMsgIdRef.current !== msgId) {
          currentMsgIdRef.current = msgId;
          addMessage({ id: msgId, role: "assistant", content: text, timestamp: Date.now(), status: "streaming" });
        } else {
          appendToMessage(msgId, text);
        }
        break;
      }
      case "tool_use": {
        const msgId = currentMsgIdRef.current || `tool-${Date.now()}`;
        const part = e.part || {};
        const state = part.state || {};
        addToolCall(msgId, {
          id: part.callID || `tc-${Date.now()}`,
          tool: part.tool || "unknown",
          args: state.input || {},
          result: typeof state.output === "string" ? state.output : JSON.stringify(state.output || ""),
          status: state.status === "completed" ? "done" : "running",
        });
        break;
      }
      case "done": {
        setStreaming(false);
        currentMsgIdRef.current = null;
        if (currentProject && currentSession) {
          saveMessages(currentSession.id);
          // Recovery is handled by the messages table - no need for SessionManager
        }
        break;
      }
      case "error": {
        addMessage({ id: 'err-' + Date.now(), role: 'system', content: '[Error] ' + (e.message || 'Unknown error'), timestamp: Date.now(), status: 'error' });
        setStreaming(false);
        currentMsgIdRef.current = null;
        break;
      }
      case "cancelled": {
        setStreaming(false);
        currentMsgIdRef.current = null;
        break;
      }
    }
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

  return (
    <div className="app">
      {!dbReady ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-secondary)" }}>
          Loading...
        </div>
      ) : (
        <>
          {showBootstrap && (
            <BootstrapWizard appRoot={APP_ROOT} onComplete={handleBootstrapComplete} />
          )}

          {sidebarOpen && (
            <Sidebar
          identity={appIdentity}
          onSettings={() => setShowSettings(true)}
          onProjects={() => setShowProjectManager(true)}
          onConfig={() => setShowConfigEditor(true)}
          onMcp={() => setShowMcpManager(true)}
          onSkills={() => setShowSkillManager(true)}
          onMemory={() => setShowMemoryManager(true)}
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
            {bottomTab === "chat" && (
              <ChatPanel
                onSend={handleSend}
                onCancel={handleCancel}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                onFork={(messageIndex) => {
                  if (currentSession && currentProject) {
                    const newSession = createSession('Fork: ' + currentSession.title);
                    // Fork messages from SQLite via MessageStorage
                    const sourceMessages = MessageStorage.listMessages(currentSession.id);
                    if (sourceMessages.length > 0) {
                      const forkedMessages = sourceMessages.slice(0, messageIndex + 1);
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
              />
            )}
            {bottomTab === "terminal" && (
              <TerminalPanel cwd={currentProject?.path || APP_ROOT} />
            )}
          </div>
        </div>
      </div>

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
          appRoot={APP_ROOT}
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
        </>
      )}
    </div>
  );
}

export default App;

