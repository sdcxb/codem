import { useState, useEffect, useRef } from "react";
import { useAppStore, MessageAttachment } from "../store";
import { useProjectStore } from "../core/store";
import { MessageBubble } from "./MessageBubble";
import { InputArea } from "./InputArea";
import { AgentPanel } from "./AgentPanel";
import { AgentDetail } from "./AgentDetail";
import { SnapshotPanel } from "./SnapshotPanel";
import { ContextMonitor } from "./ContextMonitor";
import { SubagentTask } from "../core/subagent/subagent";
import { getSubagentManager } from "../core/subagent/subagent";

const MIMO_MODELS = [
  { id: "mimo-v2.5-pro", name: "MiMo v2.5 Pro" },
  { id: "mimo-v2.5", name: "MiMo v2.5" },
  { id: "mimo-v2-pro", name: "MiMo v2 Pro" },
  { id: "mimo-v2-flash", name: "MiMo v2 Flash" },
];

const API_MODELS: Record<string, Array<{ id: string; name: string }>> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o3", name: "o3" },
  ],
  anthropic: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  ],
  deepseek: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],
  moonshot: [
    { id: "moonshot-v1-8k", name: "Moonshot v1 8K" },
    { id: "moonshot-v1-32k", name: "Moonshot v1 32K" },
    { id: "moonshot-v1-128k", name: "Moonshot v1 128K" },
  ],
  gemini: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],
};

interface ChatPanelProps {
  onSend: (message: string, attachments?: MessageAttachment[]) => void;
  onCancel: () => void;
  onToggleSidebar: () => void;
  onFork?: (messageIndex: number) => void;
  connected: boolean;
  model: string;
  onModelChange: (model: string) => void;
  mode?: "cli" | "api";
  providerId?: string;
}

export function ChatPanel({ onSend, onCancel, onToggleSidebar, onFork, connected, model, onModelChange, mode = "cli", providerId = "mimo" }: ChatPanelProps) {
  const { messages, isStreaming, removeGeneratedFiles, hasMoreMessages, isLoadingMore, loadMoreMessages } = useAppStore();
  const { currentSession, currentProject } = useProjectStore();
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const models = mode === "cli" ? MIMO_MODELS : (API_MODELS[providerId] || MIMO_MODELS);
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [showSnapshotPanel, setShowSnapshotPanel] = useState(false);
  const [showContextMonitor, setShowContextMonitor] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<SubagentTask[]>([]);

  // Auto-scroll to bottom only on initial load or new messages (not when loading history)
  const prevMessagesLenRef = useRef(0);
  const isInitialLoadRef = useRef(true);
  const loadingHistoryRef = useRef(false);
  useEffect(() => {
    if (isInitialLoadRef.current && messages.length > 0) {
      isInitialLoadRef.current = false;
      prevMessagesLenRef.current = messages.length;
      setTimeout(() => messagesEndRef.current?.scrollIntoView(), 100);
    } else if (loadingHistoryRef.current) {
      // After loading history, nudge scroll down a bit to prevent re-trigger
      loadingHistoryRef.current = false;
      prevMessagesLenRef.current = messages.length;
      setTimeout(() => {
        const container = messagesContainerRef.current;
        if (container && container.scrollTop < 60) {
          container.scrollTop = 120;
        }
      }, 50);
    } else if (messages.length > prevMessagesLenRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      prevMessagesLenRef.current = messages.length;
    }
  }, [messages, isStreaming]);

  // Reset initial load flag when session changes
  useEffect(() => {
    isInitialLoadRef.current = true;
    prevMessagesLenRef.current = 0;
    loadingHistoryRef.current = false;
  }, [currentSession?.id]);

  // Scroll detection for loading more messages (10 at a time)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        if (container.scrollTop < 50 && hasMoreMessages && !isLoadingMore) {
          loadingHistoryRef.current = true;
          loadMoreMessages(currentSession?.id || "", 10);
        }
      }, 200);
    };

    container.addEventListener("scroll", handleScroll);
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, [hasMoreMessages, isLoadingMore, loadMoreMessages]);

  // Subscribe to SubagentManager updates
  useEffect(() => {
    const manager = getSubagentManager();

    const updateAgents = () => {
      setAgents(manager.getAllTasks());
    };

    // Initial load
    updateAgents();

    // Poll for updates every 2 seconds
    const interval = setInterval(updateAgents, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleDeleteFiles = async (messageId: string, files: string[]) => {
    for (const file of files) {
      try {
        await (window as any).__TAURI__?.core.invoke("delete_file", { path: file });
      } catch (e) {
        console.warn("[ChatPanel] Failed to delete file:", file, e);
      }
    }
    removeGeneratedFiles(messageId, files);
  };

  const selectedAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;
  const runningCount = agents.filter((a) => a.status === "running").length;

  const handleSelectAgent = (taskId: string) => {
    setSelectedAgentId(taskId);
  };

  const handleBackToList = () => {
    setSelectedAgentId(null);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <button className="sidebar-toggle" onClick={onToggleSidebar}>
          ☰
        </button>
        <span className="chat-title">Codem</span>
        <div className="model-selector" onClick={() => setShowModelPicker(!showModelPicker)}>
          <span className="model-badge">{model}</span>
          <span className="model-arrow">▾</span>
          {showModelPicker && (
            <div className="model-picker" onClick={(e) => e.stopPropagation()}>
              {models.map((m) => (
                <div
                  key={m.id}
                  className={`model-option ${model === m.id ? "active" : ""}`}
                  onClick={() => { onModelChange(m.id); setShowModelPicker(false); }}
                >
                  <span className="model-option-name">{m.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          className={`agent-toggle ${showReasoning ? "active" : ""}`}
          onClick={() => setShowReasoning(!showReasoning)}
          title={showReasoning ? "隐藏思考过程" : "显示思考过程"}
        >
          💭
        </button>
        <button
          className={`agent-toggle ${showAgentPanel ? "active" : ""}`}
          onClick={() => { setShowAgentPanel(!showAgentPanel); setShowSnapshotPanel(false); setSelectedAgentId(null); }}
          title="智能体工作列表"
        >
          🤖
          {runningCount > 0 && <span className="agent-badge">{runningCount}</span>}
        </button>
        <button
          className={`agent-toggle ${showSnapshotPanel ? "active" : ""}`}
          onClick={() => { setShowSnapshotPanel(!showSnapshotPanel); setShowAgentPanel(false); setSelectedAgentId(null); }}
          title="文件快照"
        >
          📸
        </button>
        <button
          className={`agent-toggle ${showContextMonitor ? "active" : ""}`}
          onClick={() => { setShowContextMonitor(!showContextMonitor); setShowAgentPanel(false); setShowSnapshotPanel(false); setSelectedAgentId(null); }}
          title="上下文监控"
        >
          📊
        </button>
        <span className={`status-dot ${connected ? "connected" : "disconnected"}`}>
          {connected ? "●" : "○"}
        </span>
      </div>

      <div className="chat-body">
        <div className="messages-container" ref={messagesContainerRef}>
          {hasMoreMessages && (
            <div className="load-more-indicator">
              {isLoadingMore ? (
                <span className="load-more-loading">⏳ 加载中...</span>
              ) : (
                <span>↑ 滚动加载更多历史消息</span>
              )}
            </div>
          )}
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="logo">⚡</div>
              <h2>Codem</h2>
              <p>开始对话，让我帮你写代码</p>
              {!connected && (
                <p className="connecting-text">正在连接服务器...</p>
              )}
            </div>
          )}
          {messages.map((msg, index) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              index={index}
              onFork={onFork}
              showReasoning={showReasoning}
              onDeleteFiles={(files) => handleDeleteFiles(msg.id, files)}
            />
          ))}
          {isStreaming && (
            <div className="thinking-indicator">
              <div className="thinking-dot"></div>
              <div className="thinking-dot"></div>
              <div className="thinking-dot"></div>
              <span className="thinking-text">思考中...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {showAgentPanel && (
          <div className="agent-panel-container">
            {selectedAgent ? (
              <AgentDetail task={selectedAgent} onBack={handleBackToList} />
            ) : (
              <AgentPanel
                agents={agents}
                onClose={() => setShowAgentPanel(false)}
                onSelectAgent={handleSelectAgent}
              />
            )}
          </div>
        )}

        {showSnapshotPanel && (
          <div className="agent-panel-container">
            <SnapshotPanel
              cwd={currentProject?.path || ""}
              onClose={() => setShowSnapshotPanel(false)}
            />
          </div>
        )}

        {showContextMonitor && (
          <div className="agent-panel-container">
            <ContextMonitor sessionId={currentSession?.id || ""} visible={showContextMonitor} />
          </div>
        )}
      </div>

      <InputArea onSend={onSend} onCancel={onCancel} disabled={isStreaming || !connected} isStreaming={isStreaming} />
    </div>
  );
}
