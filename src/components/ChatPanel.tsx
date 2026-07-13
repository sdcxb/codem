import { useState, useEffect, useRef } from "react";
import { useAppStore, MessageAttachment } from "../store";
import { useProjectStore } from "../core/store";
import { MessageBubble } from "./MessageBubble";
import { InputArea } from "./InputArea";
import { SelectionTooltip } from "./SelectionTooltip";
import type { CollaborationMode } from "../core/agent/agent";
import { AgentPanel } from "./AgentPanel";
import { AgentDetail } from "./AgentDetail";
import { SnapshotPanel } from "./SnapshotPanel";
import { ContextMonitor } from "./ContextMonitor";
import { SubagentTask } from "../core/subagent/subagent";
import { getSubagentManager } from "../core/subagent/subagent";
import { useLang, S } from "../core/i18n/lang";

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
  collaborationMode?: CollaborationMode;
  onModeChange?: (mode: CollaborationMode) => void;
  projectPath?: string;
}

export function ChatPanel({ onSend, onCancel, onToggleSidebar, onFork, connected, model, onModelChange, mode = "cli", providerId = "mimo", collaborationMode = "default", onModeChange, projectPath }: ChatPanelProps) {
  const lang = useLang();
  const { messages, isStreaming, removeGeneratedFiles, hasMoreMessages, isLoadingMore, loadMoreMessages, stepProgress, streamStartTime, llmStatus } = useAppStore();
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
  const [quoteContext, setQuoteContext] = useState<string | null>(null);

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

    // Poll for updates frequently for real-time activity tracking
    const interval = setInterval(updateAgents, 500);
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
          title={showReasoning ? S.chat.hideReasoning[lang] : S.chat.showReasoning[lang]}
        >
          💭
        </button>
        <button
          className={`agent-toggle ${showAgentPanel ? "active" : ""}`}
          onClick={() => { setShowAgentPanel(!showAgentPanel); setShowSnapshotPanel(false); setSelectedAgentId(null); }}
          title={S.chat.agentList[lang]}
        >
          🤖
          {runningCount > 0 && <span className="agent-badge">{runningCount}</span>}
        </button>
        <button
          className={`agent-toggle ${showSnapshotPanel ? "active" : ""}`}
          onClick={() => { setShowSnapshotPanel(!showSnapshotPanel); setShowAgentPanel(false); setSelectedAgentId(null); }}
          title={S.chat.snapshot[lang]}
        >
          📸
        </button>
        <button
          className={`agent-toggle ${showContextMonitor ? "active" : ""}`}
          onClick={() => { setShowContextMonitor(!showContextMonitor); setShowAgentPanel(false); setShowSnapshotPanel(false); setSelectedAgentId(null); }}
          title={S.chat.contextMonitor[lang]}
        >
          📊
        </button>
        <span className={`status-dot ${connected ? "connected" : "disconnected"}`}>
          {connected ? "●" : "○"}
        </span>
      </div>

      <div className="chat-body">
        <div className="messages-container" ref={messagesContainerRef}>
          <SelectionTooltip containerRef={messagesContainerRef} onQuote={(text) => setQuoteContext(text)} />
          {hasMoreMessages && (
            <div className="load-more-indicator">
              {isLoadingMore ? (
                <span className="load-more-loading">{S.chat.loading[lang]}</span>
              ) : (
                <span>{S.chat.loadMore[lang]}</span>
              )}
            </div>
          )}
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="logo">⚡</div>
              <h2>Codem</h2>
              <p>{S.chat.emptyTitle[lang]}</p>
              {!connected && (
                <p className="connecting-text">{S.chat.connecting[lang]}</p>
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
              onRegenerate={(idx) => {
                /* TODO: implement regenerate */
                console.log("Regenerate from index", idx);
              }}
            />
          ))}
          {isStreaming && (
            <StreamingTimer startTime={streamStartTime} lang={lang} llmStatus={llmStatus} />
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

      {stepProgress && isStreaming && (
        <div className="step-progress-container">
          <div className="step-progress-pill">
            {/* Mini circular indicator */}
            <svg className="step-progress-ring" width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--bg-tertiary)" strokeWidth="2" />
              {stepProgress.total > 0 ? (
                <circle
                  cx="8" cy="8" r="6" fill="none" stroke="var(--accent-primary)" strokeWidth="2"
                  strokeDasharray={`${2 * Math.PI * 6}`}
                  strokeDashoffset={`${2 * Math.PI * 6 * (1 - stepProgress.current / stepProgress.total)}`}
                  strokeLinecap="round"
                  transform="rotate(-90 8 8)"
                  style={{ transition: "stroke-dashoffset 0.4s ease" }}
                />
              ) : (
                <circle
                  cx="8" cy="8" r="6" fill="none" stroke="var(--accent-primary)" strokeWidth="2"
                  strokeDasharray={`${2 * Math.PI * 6 * 0.3}`}
                  strokeLinecap="round"
                  transform="rotate(-90 8 8)"
                  className="step-ring-indeterminate"
                />
              )}
            </svg>
            <span className="step-progress-text">
              {stepProgress.total > 0
                ? (lang === "zh"
                    ? `第${stepProgress.current}/${stepProgress.total}步`
                    : `Step ${stepProgress.current}/${stepProgress.total}`)
                : (lang === "zh"
                    ? `第${stepProgress.current}步`
                    : `Step ${stepProgress.current}`)}
            </span>
            {stepProgress.title && (
              <span className="step-progress-sep">·</span>
            )}
            {stepProgress.title && (
              <span className="step-progress-detail">{stepProgress.title}</span>
            )}
          </div>

          {/* Hover tooltip with full step plan — pure CSS hover, immune to re-renders */}
          {stepProgress.steps && stepProgress.steps.length > 0 && (
            <div className="step-tooltip">
              <div className="step-tooltip-header">
                {lang === "zh" ? "执行计划" : "Execution Plan"}
              </div>
              <div className="step-tooltip-list">
                {stepProgress.steps.map((s, i) => {
                  const stepNum = i + 1;
                  const isCompleted = stepNum < stepProgress.current;
                  const isCurrent = stepNum === stepProgress.current;
                  const isPending = stepNum > stepProgress.current;
                  return (
                    <div key={i} className={`step-tooltip-item ${isCompleted ? "done" : ""} ${isCurrent ? "active" : ""} ${isPending ? "pending" : ""}`}>
                      <svg className="step-tooltip-ring" width="20" height="20" viewBox="0 0 20 20">
                        {isCompleted && (
                          <g>
                            <circle cx="10" cy="10" r="8" fill="none" stroke="#22c55e" strokeWidth="2.5" />
                            <path d="M6 10 L9 13 L14 7" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          </g>
                        )}
                        {isCurrent && (
                          <g>
                            <circle cx="10" cy="10" r="8" fill="none" stroke="#555" strokeWidth="2.5" />
                            <path d="M10 2 A 8 8 0 0 1 10 18" fill="none" stroke="#7c6cf0" strokeWidth="2.5" strokeLinecap="round" />
                            <circle cx="10" cy="10" r="3" fill="#7c6cf0" />
                          </g>
                        )}
                        {isPending && (
                          <circle cx="10" cy="10" r="8" fill="none" stroke="#555" strokeWidth="2.5" />
                        )}
                      </svg>
                      <span className={`step-tooltip-title ${isCurrent ? "active" : ""} ${isPending ? "pending" : ""}`}>
                        {s.title}
                      </span>
                      {isCurrent && <span className="step-tooltip-badge">{lang === "zh" ? "进行中" : "running"}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <InputArea onSend={(msg, atts) => { onSend(msg, atts); setQuoteContext(null); }} onCancel={onCancel} disabled={isStreaming || !connected} isStreaming={isStreaming} collaborationMode={collaborationMode} onModeChange={onModeChange || (() => {})} projectPath={projectPath} quoteContext={quoteContext} onClearQuote={() => setQuoteContext(null)} />
    </div>
  );
}

/** Format duration in ms to compact human-readable string */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** State-based streaming indicator — shows current LLM connection state + elapsed time.
 *  Instead of time-based timeouts, we track state transitions:
 *    connecting → streaming → executing_tools → (next iteration or done)
 *  The user can cancel at any time via the ■ button. */
function StreamingTimer({ startTime, lang, llmStatus }: {
  startTime: number | null;
  lang: "zh" | "en";
  llmStatus: string;
}) {
  const zh = lang === "zh";
  const textRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);

  // Status labels — state-driven, not time-driven
  const statusLabels: Record<string, { zh: string; en: string }> = {
    connecting: { zh: "正在连接 AI 服务器", en: "Connecting to AI server" },
    streaming: { zh: "正在接收 AI 响应", en: "Receiving AI response" },
    executing_tools: { zh: "正在执行工具", en: "Executing tools" },
    idle: { zh: "处理中", en: "Processing" },
  };

  useEffect(() => {
    if (!startTime) return;
    let rafId: number;
    const update = () => {
      if (textRef.current) {
        const elapsed = Date.now() - startTime;
        textRef.current.textContent = formatElapsed(elapsed);
      }
      rafId = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(rafId);
  }, [startTime]);

  // Update status text when llmStatus changes
  useEffect(() => {
    if (statusRef.current) {
      const label = statusLabels[llmStatus] || statusLabels.idle;
      statusRef.current.textContent = zh ? label.zh : label.en;
    }
  }, [llmStatus, zh]);

  if (!startTime) return null;

  const label = statusLabels[llmStatus] || statusLabels.idle;

  return (
    <div className="streaming-timer">
      <span className="streaming-timer-spinner" />
      <span className="streaming-timer-status" ref={statusRef}>
        {zh ? label.zh : label.en}
      </span>
      <span className="streaming-timer-sep">·</span>
      <span className="streaming-timer-text" ref={textRef}>
        0s
      </span>
    </div>
  );
}
