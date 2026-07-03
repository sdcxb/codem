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

const APP_ROOT = "D:\\mimo";
type BottomTab = "chat" | "terminal";

function getCliSessionKey(projectId: string, sessionId: string) {
  return `mimo-cli-session-${projectId}-${sessionId}`;
}

function loadCliSessionId(projectId: string, sessionId: string): string | null {
  try {
    return localStorage.getItem(getCliSessionKey(projectId, sessionId));
  } catch {}
  return null;
}

function saveCliSessionId(projectId: string, sessionId: string, mimoSessionId: string) {
  try {
    localStorage.setItem(getCliSessionKey(projectId, sessionId), mimoSessionId);
  } catch {}
}

function getMode(): "cli" | "api" {
  try {
    const saved = localStorage.getItem("mimo-settings");
    if (saved) {
      const settings = JSON.parse(saved);
      return settings.mode || "api";
    }
  } catch {}
  return "api";
}

function App() {
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
      else if (model.startsWith("gpt") || model.startsWith("o3")) provider = "openai";
      engine.updateConfig({ defaultProvider: provider });
      setCurrentProvider(provider);
      console.log(`[ModelChange] model=${model}, provider=${provider}`);
    }
  }, []);
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
    const identity = loadAppIdentity();
    setAppIdentity(identity);
    if (!identity.onboarded || !identity.name) {
      setShowBootstrap(true);
    }

    // Initialize SQLite, migrate from localStorage, then load projects
    (async () => {
      try {
        await initDatabase();
        await migrateFromLocalStorage();
        useProjectStore.getState().loadFromDB();
      } catch (err) {
        console.error("[App] Init failed:", err);
        useProjectStore.getState().loadFromDB();
      }
    })();
  }, []);

  // Configure engine based on mode and settings
  const configureEngine = useCallback(async () => {
    const saved = localStorage.getItem("mimo-settings");
    const engine = engineRef.current;

    if (saved) {
      const settings = JSON.parse(saved);
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
    window.addEventListener("mimo-settings-changed", configureEngine);
    return () => window.removeEventListener("mimo-settings-changed", configureEngine);
  }, [configureEngine]);

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
          saveMessages(currentSession.id);
        }, 2000);
      } else {
        // Save immediately when not streaming
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
            // Update message with reasoning content
            if (useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              useAppStore.getState().updateMessage(assistantMsgId, { 
                reasoning: reasoningContent 
              } as any);
            }
            break;

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
            }
            // Always set buffer ID and accumulate text
            streamBufferRef.current.id = assistantMsgId;
            streamBufferRef.current.text += event.text;
            if (!streamBufferRef.current.timer) {
              streamBufferRef.current.timer = setTimeout(flushStreamBuffer, 100);
            }
            break;

          case "tool_start": {
            // Flush any buffered text before showing tool call
            flushStreamBuffer();
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              // Ensure assistant message exists before adding tool call
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
                args: tc.input || {},
                status: "running",
              });
            }
            break;
          }

          case "tool_complete": {
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              updateToolCall(assistantMsgId, tc.id, {
                status: "done",
                result: typeof event.result === "string" ? event.result : JSON.stringify(event.result || ""),
              });
              // Track generated files from write tool
              if (tc.name === "write" && tc.input?.path) {
                generatedFilesRef.current.add(tc.input.path as string);
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
          // Save to recovery service for session restoration
          try {
            const engine = engineRef.current;
            const session = engine.sessions.getSession(currentSession.id);
            if (session) {
              engine.saveToRecovery(session);
            }
          } catch {}
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
                const projects = useProjectStore.getState().projects.filter((p) => p.id !== id);
                localStorage.setItem("mimo-projects", JSON.stringify(projects));
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
                const projects = useProjectStore.getState().projects.filter((p) => p.id !== id);
                localStorage.setItem("mimo-projects", JSON.stringify(projects));
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
              💬 Chat
            </button>
            <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
              ⌨️ Terminal
            </button>
          </div>

          <div className="panel-content">
            {bottomTab === "chat" && (
              <ChatPanel
                onSend={handleSend}
                onCancel={handleCancel}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                onFork={(messageIndex) => {
                  if (currentSession && currentProject) {
                    createSession('Fork: ' + currentSession.title);
                    // Load forked messages into new session
                    const sourceKey = `mimo-chat-${currentProject.id}-${currentSession.id}`;
                    const sourceData = localStorage.getItem(sourceKey);
                    if (sourceData) {
                      const sourceMessages = JSON.parse(sourceData);
                      const forkedMessages = sourceMessages.slice(0, messageIndex + 1);
                      const targetKey = `mimo-chat-${currentProject.id}-${useProjectStore.getState().currentSession?.id}`;
                      localStorage.setItem(targetKey, JSON.stringify(forkedMessages));
                      loadMessages(useProjectStore.getState().currentSession!.id);
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
        </>
      )}
    </div>
  );
}

export default App;

