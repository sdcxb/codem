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
  const { messages, addMessage, appendToMessage, setStreaming, addToolCall, updateToolCall, loadMessages, saveMessages } = useAppStore();
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
  const [cliModel, setCliModel] = useState("mimo/mimo-auto");
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

      if (settings.mode === "cli") {
        // CLI mode: load API key from auth.json or local DB
        engine.updateConfig({ defaultProvider: "mimo", defaultModel: settings.model || "mimo-v2.5-pro" });
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
        if (settings.model) {
          engine.updateConfig({ defaultModel: settings.model });
          console.log(`[Engine] API mode: model=${settings.model}`);
        }
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

  // Auto-save messages whenever they change (only for the correct session)
  useEffect(() => {
    if (currentProject && currentSession && messages.length > 0 && messagesSessionRef.current === currentSession.id) {
      saveMessages(currentSession.id);
    }
  }, [messages, currentProject?.id, currentSession?.id]);

  // ========== Send Message ==========
  const handleSend = async (message: string, attachments?: any[]) => {
    const logs: string[] = [];
    const log = (msg: string) => { logs.push(`[${new Date().toISOString()}] ${msg}`); console.log(msg); };

    log(`[Send] message: "${message.substring(0, 80)}"`);
    log(`[Send] currentSession: ${currentSession?.id || "NULL"}`);
    log(`[Send] currentProject: ${currentProject?.id || "NULL"}`);

    if (!currentSession) {
      log("[Send] ABORT: no currentSession");
      try { const { invoke } = (window as any).__TAURI__.core; await invoke("write_file", { path: "debug.log", content: logs.join("\n") }); } catch {}
      return;
    }

    useProjectStore.getState().updateSession(currentSession.id, {
      messageCount: currentSession.messageCount + 1,
      lastMessageAt: Date.now(),
    });

    let userContent = message;
    if (attachments && attachments.length > 0) {
      const attachmentInfo = attachments.map((a: any) => {
        if (a.type === "image") return `[附件: 图片 ${a.name}]`;
        return `[附件: ${a.name}${a.size ? ` (${a.size} bytes)` : ""}]`;
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

    // Check if engine is properly configured
    const provider = engine.getDefaultProvider();
    const model = engine.getDefaultModel();
    console.log(`[Send] mode=${mode}, provider=${provider}, model=${model}`);

    // Ensure engine is configured
    if (provider === "openai" && model === "gpt-4o") {
      // Not configured - try to configure from settings
      configureEngine();
    }

    // CLI mode: check MiMo auth
    if (mode === "cli") {
      const auth = getMiMoAuth();
      let account = auth.getActiveAccount();
      if (!account) {
        // Try loading from auth.json
        account = await auth.loadFromAuthJson();
      }
      if (!account) {
        addMessage({
          id: `err-${Date.now()}`,
          role: "system",
          content: `❌ 未找到 MiMo 认证信息。请先在终端运行 \`mimo providers login\` 登录。`,
          timestamp: Date.now(),
          status: "error",
        });
        return;
      }
      engine.setProviderConfig("mimo", { apiKey: account.accessToken, baseUrl: account.url });
    }

    // Both API and CLI modes use the internal LLM engine
    // Mode only affects authentication (API keys vs MiMo OAuth)
    setStreaming(true);
    const providerName = engine.getDefaultProvider();
    const modelName = engine.getDefaultModel();
    log(`[Send] mode=${getMode()}, provider=${providerName}, model=${modelName}`);

    // Check if provider is configured
    const providerObj = engine.providers.get(providerName);
    if (providerObj && !providerObj.isConfigured()) {
      log(`[Send] Provider "${providerName}" not configured (no API key)`);
      setStreaming(false);
      addMessage({
        id: `err-${Date.now()}`,
        role: "system",
        content: `❌ ${providerName} 未配置 API Key。请打开设置配置，或切换到 CLI 模式。`,
        timestamp: Date.now(),
        status: "error",
      });
      try { const { invoke } = (window as any).__TAURI__.core; await invoke("write_file", { path: "debug.log", content: logs.join("\n") }); } catch {}
      return;
    }

    log("[Send] Starting engine.process...");
    const cwd = currentProject?.path || APP_ROOT;
    let assistantMsgId = `assistant-${Date.now()}`;
    let assistantContent = "";

    try {
      abortRef.current = new AbortController();

      log("[Send] Starting engine.process loop...");
      for await (const event of engine.process(currentSession.id, message, cwd, undefined, {
        onPermissionRequest: (request) => {
          return new Promise((resolve) => {
            setPendingPermission({ request, resolve });
          });
        },
      })) {
        log(`[Send] Event: ${event.type}`);
        if (abortRef.current.signal.aborted) break;

        switch (event.type) {
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
            } else {
              appendToMessage(assistantMsgId, event.text);
            }
            break;

          case "tool_start": {
            const tc = "toolCall" in event ? event.toolCall : null;
            log(`[Send] tool_start: ${tc?.name || "?"} (${tc?.id || "?"})`);
            if (tc) {
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
            }
            break;
          }

          case "tool_error": {
            const tc = "toolCall" in event ? event.toolCall : null;
            const err = "error" in event ? event.error : "Unknown error";
            log(`[Send] tool_error: ${tc?.name || "?"} - ${err}`);
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
        useAppStore.getState().updateMessage(assistantMsgId, { status: "done" });
      }
    } catch (error: any) {
      log(`[Send] ERROR: ${error.message || String(error)}`);
      addMessage({
        id: `err-${Date.now()}`,
        role: "system",
        content: `❌ ${error.message || String(error)}`,
        timestamp: Date.now(),
        status: "error",
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (currentProject && currentSession) {
        saveMessages(currentSession.id);
        try {
          const engine = engineRef.current;
          const session = engine.sessions.getSession(currentSession.id);
          if (session) engine.saveToRecovery(session);
        } catch {}
      }
      // Write debug logs to file
      try {
        const { invoke } = (window as any).__TAURI__.core;
        await invoke("write_file", { path: "debug.log", content: logs.join("\n") });
      } catch {}
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
        addMessage({ id: `err-${Date.now()}`, role: "system", content: `�?${e.message || "Error"}`, timestamp: Date.now(), status: "error" });
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
          加载中...
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
              title: "移除项目",
              message: `确定移除项目「${name}」？`,
              confirmLabel: "仅移除",
              cancelLabel: "删除文件",
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
              💬 对话
            </button>
            <button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
              ⌨️ 终端
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
                    createSession(`分叉�? ${currentSession.title}`);
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
                onModelChange={setCliModel}
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
            <span>📂 文件浏览器</span>
            <button className="floating-explorer-close" onClick={() => setFileExplorerRefreshKey((k) => k + 1)} title="刷新">🔄</button>
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
