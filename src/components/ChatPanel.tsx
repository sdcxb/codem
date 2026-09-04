import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore, MessageAttachment, type Message } from "../store";
import { useProjectStore } from "../core/store";
import { MessageBubble } from "./MessageBubble";
import { InputArea } from "./InputArea";
import { SelectionTooltip } from "./SelectionTooltip";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import type { CollaborationMode } from "../core/agent/agent";
import { AgentPanel } from "./AgentPanel";
import { AgentDetail } from "./AgentDetail";
import { SnapshotPanel } from "./SnapshotPanel";
import { ContextMonitor } from "./ContextMonitor";
import { GitInfoPanel } from "./GitInfoPanel";
import { SubagentTask } from "../core/subagent/subagent";
import { getSubagentRuntime } from "../core/subagent/index";
import { useLang, S } from "../core/i18n/lang";
import { MIMO_MODELS, getConfiguredApiModels } from "../core/model-config";
import { ScrollbarMarkers } from "./ScrollbarMarkers";
import { ScrollToBottomIndicator } from "./ScrollToBottomIndicator";
import { useScrollState, useUnreadMessagesTracker } from "../hooks/useScrollState";
// Lucide icons — replacing all emoji icons with professional vector icons
import {
  PanelLeftClose, PanelLeftOpen, ChevronDown, Brain, Bot, Camera, BarChart3, LayoutGrid,
  Search, X, GitFork, RotateCcw, Check, Hammer, ClipboardList, Zap,
  Activity, Pencil,
} from "lucide-react";
// P2 #38: framer-motion for smooth list animations
import { motion, AnimatePresence } from "framer-motion";
// P1: 高级功能组件
import { CorrectionModeToggle } from "./CorrectionModeToggle";
import { Workbench } from "./Workbench";
import { StreamingWaitIndicator } from "./StreamingWaitIndicator";
import { TodoListDisplay } from "./TodoListDisplay";
import { PanelSidebar } from "./PanelSidebar";
// P2: 体验提升组件
import { QuickPhraseSelector } from "./QuickPhraseSelector";
import { PromptDraftPicker } from "./PromptDraftPicker";
import { QuickAccessCards } from "./QuickAccessCards";
import { RunStatusBar } from "./RunStatusBar";
import { NewChatPage } from "./NewChatPage";
import type { RunPhase } from "../core/llm/run-status-tracker";
// P2: 存储
import { loadQuickPhrases, type QuickPhrase } from "../core/storage/settings";
import { loadPromptDrafts, type PromptDraft } from "../core/storage/prompt-draft";
import { getAgentRegistry } from "../core/agent/agent";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import { SlotBridge, SlotListBridge } from "../core/slots/SlotBridge";
import { JobsBadge, type JobView } from "./JobsBadge";
import { DeliverableFiles } from "./DeliverableFiles";
import { TrajectoryPanel } from "./TrajectoryPanel";

interface ChatPanelProps {
  onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void;
  onCancel: () => void;
  /** Send a guidance message to the currently running agentic loop */
  onSendGuidance?: (message: string) => void;
  onToggleSidebar: () => void;
  /** 侧边栏当前是否展开（决定收起/展开图标） */
  sidebarOpen?: boolean;
  onFork?: (messageIndex: number) => void;
  onRegenerate?: (messageIndex: number) => void;
  /** P0: Edit a message and resend from that point */
  onEditAndResend?: (messageId: string, newContent: string) => void;
  /** P0: Restore message content to input box — handled internally by ChatPanel */
  onReEdit?: (content: string) => void;
  /** P0: Session ID for DB persistence */
  sessionId?: string;
  connected: boolean;
  model: string;
  onModelChange: (model: string) => void;
  mode?: "cli" | "api";
  providerId?: string;
collaborationMode?: CollaborationMode;
onModeChange?: (mode: CollaborationMode) => void;
projectPath?: string;
/** Current session ID for per-session streaming state */
currentSessionId?: string;
/** Called when user clicks a citation in notebook mode */
onCitationClick?: (sourceName: string) => void;
/** Called when user clicks a source in the metadata-driven sources panel */
onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
/** P3/P4: Active notebook ID for source selector in InputArea */
notebookId?: string;
}

export function ChatPanel({ onSend, onCancel, onSendGuidance, onToggleSidebar, sidebarOpen = true, onFork, onRegenerate, onEditAndResend, onReEdit, sessionId, connected, model, onModelChange, mode = "cli", providerId = "mimo", collaborationMode = "default", onModeChange, projectPath, currentSessionId, onCitationClick, onSourceClick, notebookId }: ChatPanelProps) {
  const lang = useLang();
  const { messages, isStreaming, activeSessions, removeGeneratedFiles, hasMoreMessages, isLoadingMore, loadMoreMessages, stepProgress, streamStartTime, llmStatus, displayMode, setDisplayMode, guidanceMessages, removeGuidanceMessage } = useAppStore();
  const { currentSession, currentProject } = useProjectStore();
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showEffortPicker, setShowEffortPicker] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const [stepTooltipLocked, setStepTooltipLocked] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // P0: Scroll state tracking
  useScrollState(messagesContainerRef, [messages.length]);
  useUnreadMessagesTracker(messages.length, isStreaming);

  // Measure chat-body bounds and set CSS vars for floating panel positioning
  useEffect(() => {
    const updateBounds = () => {
      const header = document.querySelector('.chat-header');
      const inputArea = document.querySelector('.input-area');
      if (header) {
        const rect = header.getBoundingClientRect();
        document.documentElement.style.setProperty('--chat-body-top', `${rect.bottom}px`);
      }
      if (inputArea) {
        const rect = inputArea.getBoundingClientRect();
        document.documentElement.style.setProperty('--chat-body-bottom', `${window.innerHeight - rect.top}px`);
      }
    };
    updateBounds();
    window.addEventListener('resize', updateBounds);
    const observer = new MutationObserver(updateBounds);
    const inputArea = document.querySelector('.input-area');
    if (inputArea) observer.observe(inputArea, { attributes: true, subtree: true });
    return () => {
      window.removeEventListener('resize', updateBounds);
      observer.disconnect();
    };
  }, []);

  const models = mode === "cli" ? MIMO_MODELS : getConfiguredApiModels();
  // Whether the current session is actively streaming (running an agentic loop)
  const isSessionStreaming = !currentSessionId ? isStreaming : activeSessions.has(currentSessionId);

  // Derive RunPhase from llmStatus for RunStatusBar
  const runPhase: RunPhase = isSessionStreaming
    ? llmStatus === "connecting" ? "thinking"
      : llmStatus === "executing_tools" ? "working"
      : llmStatus === "streaming" ? "presenting"
      : "thinking"
    : "idle";
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [showSnapshotPanel, setShowSnapshotPanel] = useState(false);
  const [showContextMonitor, setShowContextMonitor] = useState(false);
  const [showTrajectoryPanel, setShowTrajectoryPanel] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<SubagentTask[]>([]);
  const [quoteContext, setQuoteContext] = useState<string | null>(null);
  // Bug9: 建议卡片直接设置输入框内容
  const [suggestionPrompt, setSuggestionPrompt] = useState<string | null>(null);
  // P0: Re-edit content is managed internally so onClearQuote can clear it immediately
  const handleReEditInternal = useCallback((content: string) => {
    setQuoteContext(content);
    onReEdit?.(content);
  }, [onReEdit]);
  // P2 #31: Listen for paragraph-level quote events from RichContent
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.text) {
        setQuoteContext(`> ${detail.text}\n\n`);
      }
    };
    window.addEventListener("rich-content-quote", handler);
    return () => window.removeEventListener("rich-content-quote", handler);
  }, []);
  // A9: Chat history search
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // P1: Correction mode toggle
  // Correction/Clarification removed from main UI — correction config moved to Settings, clarification auto-triggers
  // P1: Workbench panel
  const [showWorkbench, setShowWorkbench] = useState(false);
  // P1: RightSidebar (Git + Workbench per benchmark layer 4)
  const [showRightSidebar, setShowRightSidebar] = useState(false);
  // P1: Todo list display
  const [activeTodoId, setActiveTodoId] = useState<string | null>(null);
  const [activeTodos, setActiveTodos] = useState<any[]>([]);
  // P2: Quick phrase selector
  const [showQuickPhrase, setShowQuickPhrase] = useState(false);
  const [quickPhrases, setQuickPhrases] = useState<QuickPhrase[]>([]);
  // P2: Prompt draft picker
  const [showDraftPicker, setShowDraftPicker] = useState(false);
  const [promptDrafts, setPromptDrafts] = useState<PromptDraft[]>([]);
  // P2: Quick access cards
  const [showQuickAccess, setShowQuickAccess] = useState(true);
  // P2 #37: Task title dropdown
  const [showTitleDropdown, setShowTitleDropdown] = useState(false);
  const [quickAccessFavorites, setQuickAccessFavorites] = useState<Set<string>>(() => {
    try { return new Set(getSettingJSON<string[]>("codem-quick-access-favorites", [])); } catch { return new Set(); }
  });

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
      // After loading history, maintain scroll position so user can continue
      // scrolling up to load more. Save the scroll height before the new
      // messages were prepended, then restore the offset.
      loadingHistoryRef.current = false;
      prevMessagesLenRef.current = messages.length;
      setTimeout(() => {
        const container = messagesContainerRef.current;
        const scrollContainer = container?.parentElement as HTMLElement | null;
        if (scrollContainer) {
          // Keep scroll position near the top where user was reading.
          // Offset by ~300px so the "load more" indicator is just out of view
          // and there's content above for the next scroll-up trigger.
          const targetTop = 300;
          if (scrollContainer.scrollTop < targetTop) {
            scrollContainer.scrollTop = targetTop;
          }
        }
      }, 50);
    } else if (messages.length > prevMessagesLenRef.current) {
      // P0 fix: Only auto-scroll if user is already at/near bottom.
      // If scrolled up, don't force-scroll — let the unread indicator show instead.
      const container = messagesContainerRef.current;
      const scrollPos = useAppStore.getState().scrollPosition;
      if (container && (scrollPos === "bottom" || scrollPos === "near-bottom")) {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }
      prevMessagesLenRef.current = messages.length;
    }
  }, [messages, isStreaming]);

  // When streaming ends (task complete), scroll to the latest assistant answer
  // so the user sees the conclusion immediately. The answer content is ABOVE the
  // reasoning and tool calls in our layout, so we scroll the answer into view at
  // the top of the viewport — not to the bottom of the message list.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isSessionStreaming;
if (wasStreaming && !isSessionStreaming) {
// Reset step tooltip lock when streaming ends
setStepTooltipLocked(false);
      // Streaming just ended — scroll to the "task complete" badge so the user
      // sees the completion footer (产出物位置不固定，锚定到标签最稳定).
      // Use retry mechanism because React re-render + framer-motion animation
      // may delay the footer appearing in the DOM.
      const scrollToFooter = (attempt: number) => {
        const container = messagesContainerRef.current;
        if (!container) return;
        // Find the last qa-turn-footer (task complete badge) in the DOM
        const footers = container.querySelectorAll('.qa-turn-footer');
        const lastFooter = footers.length > 0 ? footers[footers.length - 1] as HTMLElement : null;
        if (lastFooter) {
          lastFooter.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (attempt < 10) {
          // Retry: footer not yet rendered (animation delay), try again after 150ms
          setTimeout(() => scrollToFooter(attempt + 1), 150);
        } else {
          // Final fallback: scroll to bottom
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      };
      setTimeout(() => scrollToFooter(0), 150);
    }
  }, [isSessionStreaming]);

  // Reset initial load flag when session changes
  useEffect(() => {
    isInitialLoadRef.current = true;
    prevMessagesLenRef.current = 0;
    loadingHistoryRef.current = false;
  }, [currentSession?.id]);

  // P2: Load quick phrases on mount
  useEffect(() => {
    setQuickPhrases(loadQuickPhrases());
  }, []);

  // P2: Load prompt drafts when session changes
  useEffect(() => {
    if (currentSession?.id) {
      setPromptDrafts(loadPromptDrafts(currentSession.id));
    }
  }, [currentSession?.id]);

  // P2: Handle quick phrase selection
  const handleQuickPhraseSelect = useCallback((content: string) => {
    setQuoteContext(content);
    setShowQuickPhrase(false);
  }, []);

  // P2: Handle prompt draft selection
  const handleDraftSelect = useCallback((draft: PromptDraft) => {
    setQuoteContext(draft.content);
    setShowDraftPicker(false);
  }, []);

  // Scroll detection for loading more messages
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // .chat-body 是真正的滚动容器（overflow-y: auto），.messages-container 不滚动
    const scrollContainer = container.parentElement as HTMLElement | null;
    if (!scrollContainer) return;

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      // Replace previous timer (debounce) instead of ignoring the event
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        // Use larger threshold (200px) so user can keep scrolling up to trigger
        // consecutive loads without needing to scroll back down first
        if (scrollContainer.scrollTop < 200 && hasMoreMessages && !isLoadingMore) {
          loadingHistoryRef.current = true;
          loadMoreMessages(currentSession?.id || "", 20);
        }
      }, 150);
    };

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, [hasMoreMessages, isLoadingMore, loadMoreMessages, currentSession?.id]);

  // Subscribe to SubagentRuntime updates — DSH-style 事件驱动
  // 对标 DSH ctx.subagents — 替代旧 SubagentManager
  useEffect(() => {
    const runtime = getSubagentRuntime();

    const updateAgents = () => {
      if (runtime) {
        setAgents(runtime.getAllTasks());
      } else {
        setAgents([]);
      }
    };

    // Initial load
    updateAgents();

    // DSH-style: 订阅事件而非轮询
    const unsubscribe = runtime?.subscribe(updateAgents);

    return () => {
      if (unsubscribe) unsubscribe();
    };
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
        <button
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          title={sidebarOpen ? (lang === "zh" ? "收起侧边栏" : "Collapse sidebar") : (lang === "zh" ? "展开侧边栏" : "Expand sidebar")}
          aria-label={sidebarOpen ? (lang === "zh" ? "收起侧边栏" : "Collapse sidebar") : (lang === "zh" ? "展开侧边栏" : "Expand sidebar")}
        >
          {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        {/* P2 #37: Task title dropdown */}
        <div style={{ position: "relative" }}>
          <button
            className="chat-title-dropdown-btn"
            onClick={() => setShowTitleDropdown(!showTitleDropdown)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-primary)", fontSize: 'var(--fs-md)', fontWeight: 600, display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4 }}
            title={currentSession?.title || "Codem"}
          >
            <span className="chat-title">{currentSession?.title || "Codem"}</span>
            <ChevronDown size={12} style={{ opacity: 0.5 }} />
          </button>
          {showTitleDropdown && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowTitleDropdown(false)} />
              <div className="bottom-bar-dropdown" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, minWidth: 240, maxHeight: 300, overflowY: "auto", zIndex: 100 }}>
                <div className="bottom-bar-dropdown-header">{lang === "zh" ? "切换会话" : "Switch Session"}</div>
                {(() => {
                  const sessions = currentProject
                    ? useProjectStore.getState().getProjectSessions(currentProject.id)
                    : [];
                  if (sessions.length === 0) return <div className="bottom-bar-dropdown-empty">{lang === "zh" ? "无会话" : "No sessions"}</div>;
                  return sessions.slice(0, 15).map(s => (
                    <button
                      key={s.id}
                      className={`bottom-bar-dropdown-item ${currentSession?.id === s.id ? "active" : ""}`}
                      onClick={() => { useProjectStore.getState().switchSession(s.id); setShowTitleDropdown(false); }}
                    >
                      <span style={{ fontSize: 'var(--fs-sm)' }}>{s.title || (lang === "zh" ? "新对话" : "New Chat")}</span>
                    </button>
                  ));
                })()}
              </div>
            </>
          )}
        </div>
        {/* SlotBridge 消费 app.jobs-badge — 会话头部任务指示器 */}
        <SlotBridge
          name="app.jobs-badge"
          fallback={null}
          jobs={agents.map((a): JobView => ({
            id: a.id,
            kind: a.agentId || 'subagent',
            label: a.name || a.prompt?.slice(0, 40) || a.id,
            status: a.status === 'running' ? 'running' : a.status === 'completed' ? 'completed' : a.status === 'failed' ? 'failed' : 'cancelled',
            startedAt: a.startedAt || a.createdAt || Date.now(),
            finishedAt: a.completedAt,
            detail: a.error,
          }))}
          onSelectJob={(jobId: string) => {
            setSelectedAgentId(jobId)
            setShowAgentPanel(true)
          }}
        />
        <div className="model-selector" onClick={() => setShowModelPicker(!showModelPicker)}>
          <span className="model-badge">{models.find(m => m.id === model)?.name || model}</span>
          <span className="model-arrow"><ChevronDown size={10} /></span>
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
              {/* Reasoning effort divider + selector */}
              <div style={{ height: 1, background: "var(--border-primary)", margin: "6px 0" }} />
              <div style={{ padding: "4px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", position: "relative" }}
                onClick={(e) => { e.stopPropagation(); setShowEffortPicker(!showEffortPicker); }}
              >
                <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{lang === "zh" ? "推理强度" : "Reasoning Effort"}</span>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: "var(--accent)" }}>
                  {(() => {
                    const effort = getSettingJSON<string>("codem-reasoning-effort", "high");
                    const labels: Record<string, { zh: string; en: string }> = {
                      low: { zh: "低", en: "Low" },
                      medium: { zh: "中", en: "Medium" },
                      high: { zh: "高", en: "High" },
                      ultra: { zh: "超高", en: "Ultra" },
                    };
                    return (labels[effort]?.[lang] || labels.high[lang]);
                  })()}
                </span>
                {showEffortPicker && (
                  <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={(e) => { e.stopPropagation(); setShowEffortPicker(false); }} />
                    <div style={{
                      position: "absolute", top: "100%", right: 0, marginTop: 4,
                      minWidth: 120, zIndex: 100, padding: 4,
                      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                      borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                    }}>
                      {([
                        { id: "low", zh: "低", en: "Low" },
                        { id: "medium", zh: "中", en: "Medium" },
                        { id: "high", zh: "高", en: "High" },
                        { id: "ultra", zh: "超高", en: "Ultra" },
                      ] as const).map(opt => {
                        const currentEffort = getSettingJSON<string>("codem-reasoning-effort", "high");
                        return (
                          <div key={opt.id}
                            className={`model-option ${currentEffort === opt.id ? "active" : ""}`}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSettingJSON("codem-reasoning-effort", opt.id);
                              setShowEffortPicker(false);
                              setShowModelPicker(false);
                            }}
                          >
                            <span className="model-option-name">{lang === "zh" ? opt.zh : opt.en}</span>
                            {opt.id === "ultra" && <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 4 }}>max tokens</span>}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <button
          className={`agent-toggle ${showReasoning ? "active" : ""}`}
          onClick={() => setShowReasoning(!showReasoning)}
          title={showReasoning ? S.chat.hideReasoning[lang] : S.chat.showReasoning[lang]}
        >
          <Brain size={16} />
        </button>
        <button
          className={`agent-toggle ${showAgentPanel ? "active" : ""}`}
          onClick={() => { setShowAgentPanel(!showAgentPanel); setShowSnapshotPanel(false); setShowContextMonitor(false); setShowTrajectoryPanel(false); setSelectedAgentId(null); }}
          title={S.chat.agentList[lang]}
        >
          <Bot size={16} />
          {runningCount > 0 && <span className="agent-badge">{runningCount}</span>}
        </button>
        <button
          className={`agent-toggle ${showSnapshotPanel ? "active" : ""}`}
          onClick={() => { setShowSnapshotPanel(!showSnapshotPanel); setShowAgentPanel(false); setShowContextMonitor(false); setShowTrajectoryPanel(false); setSelectedAgentId(null); }}
          title={S.chat.snapshot[lang]}
        >
          <Camera size={16} />
        </button>
        <button
          className={`agent-toggle ${showContextMonitor ? "active" : ""}`}
          onClick={() => { setShowContextMonitor(!showContextMonitor); setShowAgentPanel(false); setShowSnapshotPanel(false); setShowTrajectoryPanel(false); setSelectedAgentId(null); }}
          title={S.chat.contextMonitor[lang]}
        >
          <BarChart3 size={16} />
        </button>
        <button
          className={`agent-toggle ${showTrajectoryPanel ? "active" : ""}`}
          onClick={() => { setShowTrajectoryPanel(!showTrajectoryPanel); setShowAgentPanel(false); setShowSnapshotPanel(false); setShowContextMonitor(false); setSelectedAgentId(null); }}
          title={lang === "zh" ? "执行轨迹" : "Trajectory"}
        >
          <Activity size={16} />
        </button>
        {/* Display mode toggle moved to Settings > Appearance — default unified mode */}
        <span className="header-spacer" style={{ flex: 1 }} />
        {/* Side panel toggle — header right */}
        <button
          className={`agent-toggle ${showRightSidebar ? "active" : ""}`}
          onClick={() => setShowRightSidebar(!showRightSidebar)}
          title={lang === "zh" ? "侧边面板" : "Side Panel"}
        >
          <LayoutGrid size={16} />
        </button>
        <span className={`status-dot ${connected ? "connected" : "disconnected"}`}>
          {connected ? "●" : "○"}
        </span>
      </div>

      {/* Search — modal dialog instead of inline bar (per benchmark analysis) */}
      {showSearch && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} onClick={() => setShowSearch(false)} />
          <div style={{
            position: 'fixed', top: '20%', left: '50%', transform: 'translateX(-50%)',
            width: '480px', maxWidth: '90vw', zIndex: 301,
            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderRadius: 12, padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                autoFocus
                placeholder={lang === 'zh' ? '搜索对话内容...' : 'Search messages...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  flex: 1,
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--fs-base)',
                  outline: 'none',
                }}
              />
              <button onClick={() => setShowSearch(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><X size={16} /></button>
            </div>
            {searchQuery && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 8 }}>
                {messages.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase())).length} / {messages.length} {lang === 'zh' ? '条匹配' : 'matches'}
              </div>
            )}
            {searchQuery && messages.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase())).slice(0, 10).map(m => (
              <div key={m.id} style={{ padding: '8px', borderRadius: 6, cursor: 'pointer', marginBottom: 4, background: 'var(--bg-tertiary)' }}
                onClick={() => { setShowSearch(false); setSearchQuery(''); }}
              >
                <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.6 }}>{m.role}</span>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.content.substring(0, 80)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Connection lost banner */}
      {!connected && messages.length > 0 && (
        <div className="connection-lost-banner">
          <span className="connection-lost-dot" />
          <span>{lang === "zh" ? "连接已断开，正在重新连接..." : "Connection lost, reconnecting..."}</span>
        </div>
      )}

      <div className={`chat-body ${showWorkbench ? "workbench-split-active" : ""}`}>
        <div className="messages-container" ref={messagesContainerRef}>
          <RunStatusBar
            phase={runPhase}
            startedAt={streamStartTime}
            isRunning={isSessionStreaming}
            onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}
          />
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
              <NewChatPage
                appName="Codem"
                connected={connected}
                onSuggestionClick={(prompt) => setSuggestionPrompt(prompt)}
              />
              {/* P2: Quick access cards + quick phrases in empty state */}
              {showQuickAccess && connected && !isSessionStreaming && (
                <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                          onModeChange?.("plan");
                        } else {
                          onModeChange?.("default");
                        }
                        // Per benchmark: fill input box instead of auto-send
                        const prompt = lang === 'zh'
                          ? `使用${agent.name}模式：${agent.description}`
                          : `Use ${agent.name} mode: ${agent.description}`;
                        setQuoteContext(prompt);
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
                  {/* Quick phrase list in empty state (per benchmark plan) */}
                  {quickPhrases.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                      {quickPhrases.slice(0, 6).map((p, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            setQuoteContext(p.content);
                            setShowQuickAccess(false);
                          }}
                          style={{
                            padding: '4px 10px', borderRadius: 16, border: '1px solid var(--border-color)',
                            background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                            fontSize: 'var(--fs-sm)', cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          {p.title || p.content.substring(0, 20)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* In unified mode, merge consecutive assistant messages into one visual bubble.
              DB keeps separate messages per iteration (for LLM context clarity),
              but the UI merges them so the user sees one unified response. */}
          {(() => {
            const isUnified = displayMode === "unified";
            // A9: Filter messages by search query
            const displayMessages = showSearch && searchQuery.trim()
              ? messages.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase()))
              : messages;
            // Build render list: each entry is either a single message or a merged group
            // origIndex tracks the index in displayMessages (not renderList) for correct turn-boundary detection
            const renderList: { msg: Message; skip: boolean; isLastInGroup: boolean; origIndex: number; groupLastIdx?: number }[] = [];
            for (let i = 0; i < displayMessages.length; i++) {
              const msg = displayMessages[i];
              if (isUnified && msg.role === "assistant") {
                // Check if this is the start of a consecutive assistant group
                const prevMsg = displayMessages[i - 1];
                const isGroupStart = !prevMsg || prevMsg.role !== "assistant";
                if (isGroupStart) {
                  // Collect all consecutive assistant messages
                  const group: Message[] = [msg];
                  let lastIdx = i;
                  for (let j = i + 1; j < displayMessages.length; j++) {
                    if (displayMessages[j].role !== "assistant") break;
                    group.push(displayMessages[j]);
                    lastIdx = j;
                  }
                  // Create merged message
                  const merged: Message = {
                    ...msg,
                    id: msg.id, // keep first message's ID
                    content: group.map(m => m.content).filter(Boolean).join("\n\n---\n\n"),
                    reasoning: group.map(m => m.reasoning).filter(Boolean).join("\n\n---\n\n") || undefined,
                    toolCalls: group.flatMap(m => m.toolCalls || []),
                    status: group[group.length - 1].status,
                    generatedFiles: group.flatMap(m => m.generatedFiles || []).length > 0
                      ? group.flatMap(m => m.generatedFiles || [])
                      : undefined,
                  };
                  renderList.push({ msg: merged, skip: false, isLastInGroup: true, origIndex: i, groupLastIdx: lastIdx });
                  // Mark intermediate messages as skipped
                  for (let j = i + 1; j <= lastIdx; j++) {
                    renderList.push({ msg: displayMessages[j], skip: true, isLastInGroup: j === lastIdx, origIndex: j });
                  }
                  i = lastIdx; // skip to end of group
                } else {
                  // Already handled by group start
                  renderList.push({ msg, skip: true, isLastInGroup: false, origIndex: i });
                }
              } else {
                renderList.push({ msg, skip: false, isLastInGroup: false, origIndex: i });
              }
            }

            return renderList.map(({ msg, skip, origIndex, groupLastIdx }) => {
            if (skip) return null;

            // For unified mode merged groups, use groupLastIdx (the last index in
            // the group) for turn boundary detection. Otherwise use origIndex.
            const effectiveIdx = groupLastIdx !== undefined ? groupLastIdx : origIndex;

            // Determine if this is the last assistant message in the current Q&A turn.
            let isLastInTurn = false;
            if (msg.role === "assistant") {
              isLastInTurn = true;
              for (let i = effectiveIdx + 1; i < displayMessages.length; i++) {
                if (displayMessages[i].role === "user") break;
                if (displayMessages[i].role === "assistant") {
                  isLastInTurn = false;
                  break;
                }
              }
            }
            // Determine turn boundary: a new turn starts at each user message.
            // The footer (with "task complete" badge) should appear after the last
            // message in a turn — i.e., when the next message is a user message,
            // or when this is the very last message in the list.
            let isTurnEnd = false;
            if (effectiveIdx === displayMessages.length - 1) {
              isTurnEnd = true;
            } else if (displayMessages[effectiveIdx + 1]?.role === "user") {
              isTurnEnd = true;
            }
            // Check if this turn has any assistant response (walk backwards to find user start)
            let isTurnWithResponse = false;
            if (isTurnEnd) {
              for (let j = effectiveIdx; j >= 0; j--) {
                if (displayMessages[j].role === "user") break;
                if (displayMessages[j].role === "assistant") { isTurnWithResponse = true; break; }
              }
            }

            // P2: 入场动画只对最新一条消息启用 —— 历史消息/长对话滚动加载时
            // 全部跑 framer-motion 动画会在首屏同时创建大量动画帧导致卡顿。
            // 最新一条（新进入的回复）保留动画，其余静态渲染。
            const isLatestMsg = (groupLastIdx ?? origIndex) === displayMessages.length - 1;

            return (
            <React.Fragment key={msg.id}>
            {isLatestMsg ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
            <MessageBubble
message={msg}
index={origIndex}
showReasoning={showReasoning}
onDeleteFiles={(files) => handleDeleteFiles(msg.id, files)}
isLastInTurn={isLastInTurn}
onCitationClick={onCitationClick}
onSourceClick={onSourceClick}
onEditAndResend={onEditAndResend}
onReEdit={handleReEditInternal}
sessionId={sessionId || currentSession?.id}
canEdit={!isSessionStreaming}
/>
            </motion.div>
            ) : (
            <MessageBubble
message={msg}
index={origIndex}
showReasoning={showReasoning}
onDeleteFiles={(files) => handleDeleteFiles(msg.id, files)}
isLastInTurn={isLastInTurn}
onCitationClick={onCitationClick}
onSourceClick={onSourceClick}
onEditAndResend={onEditAndResend}
onReEdit={handleReEditInternal}
sessionId={sessionId || currentSession?.id}
canEdit={!isSessionStreaming}
/>
            )}
{/* Task complete badge — rendered when turn has ended with assistant response.
                The isTurnEnd check now correctly handles unified mode merged groups
                by using groupLastIdx for boundary detection. */}
{isTurnEnd && isTurnWithResponse && !isSessionStreaming && (
              <div className="qa-turn-footer">
                <span className="task-complete-badge">
                  <Check size={13} />
                  {lang === "zh" ? "任务完成" : "Done"}
                </span>
                {onFork && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="qa-turn-btn" onClick={() => onFork(origIndex)}>
                        <GitFork size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{S.bubble.fork[lang]}</TooltipContent>
                  </Tooltip>
                )}
                {onRegenerate && isTurnWithResponse && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="qa-turn-btn" onClick={() => onRegenerate(origIndex)}>
                        <RotateCcw size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{S.bubble.regenerate[lang]}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
            </React.Fragment>
            );
          });
          })()}
          {isStreaming && (
            <StreamingTimer startTime={streamStartTime} lang={lang} llmStatus={llmStatus} />
          )}
          {/* SlotListBridge 消费 conversation.messages slot — 允许插件注入额外消息渲染器 */}
          <SlotListBridge name="conversation.messages" />
          {/* SlotBridge 消费 conversation.details.tool slot — 工具调用详情 */}
          <SlotBridge name="conversation.details.tool" fallback={null} />
          {/* SlotBridge 消费 app.deliverable-files — Turn tail 交付物文件列表 */}
          <SlotBridge
            name="app.deliverable-files"
            fallback={null}
            sessionId={sessionId || currentSession?.id || ''}
            workspace={projectPath || currentProject?.path || ''}
            onOpenFile={(path: string) => {
              // 打开文件 — 复用 App.tsx 的事件机制
              window.dispatchEvent(new CustomEvent('codem-open-file', { detail: { path } }))
            }}
            onViewDiff={(record: any, file: any) => {
              // 触发 diff review — 复用 App.tsx 的事件机制
              window.dispatchEvent(new CustomEvent('codem-view-diff', { detail: { record, file } }))
            }}
          />
          <div ref={messagesEndRef} />
          {/* P0: Scrollbar markers for message navigation */}
          <ScrollbarMarkers messages={messages} containerRef={messagesContainerRef} />

          {/* P1: Streaming wait indicator — inside message flow */}
          {isSessionStreaming && !stepProgress && (
            <StreamingWaitIndicator
              phase={llmStatus === "connecting" ? "thinking" : "coding"}
            />
          )}
        </div>

        {/* P2 #39: Workbench split-screen panel */}
        {showWorkbench && (
          <div className="workbench-split-pane">
            <Workbench
              collapsed={false}
              onToggle={() => setShowWorkbench(false)}
              activeTools={[]}
              modifiedFiles={[]}
            />
          </div>
        )}

        {/* P0: Scroll-to-bottom indicator */}
        <ScrollToBottomIndicator
          containerRef={messagesContainerRef}
          messagesEndRef={messagesEndRef}
        />

        {/* P1: Todo list display — stays in message flow */}
        {activeTodoId && activeTodos.length > 0 && (
          <TodoListDisplay
            todoId={activeTodoId}
            todos={activeTodos}
          />
        )}
      </div>

      {/* TrajectoryPanel — floating overlay */}
      {showTrajectoryPanel && (
        <div className="floating-overlay-panel" style={{
          position: 'fixed', top: 'var(--chat-body-top, 48px)', right: 0, bottom: 'var(--chat-body-bottom, 140px)', width: 'min(380px, calc(100vw - 24px))',
          zIndex: 200,
          borderRadius: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <TrajectoryPanel
            messages={messages}
            sessionId={currentSession?.id || sessionId || null}
            defaultExpanded={true}
          />
        </div>
      )}

      {/* AgentPanel — floating overlay outside chat-body */}
      {showAgentPanel && (
        <div className="floating-overlay-panel" style={{
          position: 'fixed', top: 'var(--chat-body-top, 48px)', right: 0, bottom: 'var(--chat-body-bottom, 140px)', width: 'min(380px, calc(100vw - 24px))',
          zIndex: 200, overflowY: 'auto',
          borderRadius: 0,
        }}>
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

      {/* SnapshotPanel — floating overlay */}
      {showSnapshotPanel && (
        <div className="floating-overlay-panel" style={{
          position: 'fixed', top: 'var(--chat-body-top, 48px)', right: 0, bottom: 'var(--chat-body-bottom, 140px)', width: 'min(380px, calc(100vw - 24px))',
          zIndex: 200, overflowY: 'auto',
          borderRadius: 0,
        }}>
          <SnapshotPanel
            cwd={currentProject?.path || ""}
            onClose={() => setShowSnapshotPanel(false)}
          />
        </div>
      )}

      {/* ContextMonitor — floating overlay */}
      {showContextMonitor && (
        <div className="floating-overlay-panel" style={{
          position: 'fixed', top: 'var(--chat-body-top, 48px)', right: 0, bottom: 'var(--chat-body-bottom, 140px)', width: 'min(380px, calc(100vw - 24px))',
          zIndex: 200, overflowY: 'auto',
          borderRadius: 0,
        }}>
          <ContextMonitor sessionId={currentSession?.id || ""} visible={showContextMonitor} />
        </div>
      )}

      {/* RightSidebar — per benchmark plan layer 4: Git + Workbench tabs */}
      <PanelSidebar open={showRightSidebar} onClose={() => setShowRightSidebar(false)} />

      {showQuickPhrase && (
        <div className="floating-overlay-panel" style={{
          position: 'fixed', top: 'var(--chat-body-top, 48px)', right: 0, bottom: 'var(--chat-body-bottom, 140px)', width: 300,
          zIndex: 200, overflowY: 'auto',
        }}>
          <QuickPhraseSelector
            phrases={quickPhrases}
            onSelect={handleQuickPhraseSelect}
            onClose={() => setShowQuickPhrase(false)}
          />
        </div>
      )}

      {showDraftPicker && (
        <div className="floating-overlay-panel" style={{
          position: 'fixed', top: 'var(--chat-body-top, 48px)', right: 0, bottom: 'var(--chat-body-bottom, 140px)', width: 360,
          zIndex: 200, overflowY: 'auto',
        }}>
          <PromptDraftPicker
            drafts={promptDrafts}
            onSelect={handleDraftSelect}
            onClose={() => setShowDraftPicker(false)}
          />
        </div>
      )}

      {/* Step progress — standalone indicator */}
      {stepProgress && isStreaming && (
        <div className={`step-progress-container ${stepTooltipLocked ? "tooltip-locked" : ""}`}>
          <div
            className="step-progress-pill"
            onClick={() => setStepTooltipLocked(v => !v)}
            style={{ cursor: "pointer" }}
          >
            {/* Mini circular indicator */}
            <svg className="step-progress-ring" width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--bg-tertiary)" strokeWidth="2" />
              {stepProgress.total > 0 ? (
                <circle
                  cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="2"
                  strokeDasharray={`${2 * Math.PI * 6}`}
                  strokeDashoffset={`${2 * Math.PI * 6 * (1 - stepProgress.current / stepProgress.total)}`}
                  strokeLinecap="round"
                  transform="rotate(-90 8 8)"
                  style={{ transition: "stroke-dashoffset 0.4s ease" }}
                />
              ) : (
                <circle
                  cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="2"
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

      {/* Guidance messages display — shown when agent is running */}
      {isSessionStreaming && guidanceMessages.length > 0 && (
        <div className="guidance-messages-bar">
          {guidanceMessages.map((g) => (
            <div key={g.id} className={`guidance-item ${g.consumed ? 'consumed' : 'pending'}`}>
              <div className="guidance-item-body">
                <div className="guidance-item-meta">
                  <span className="guidance-status-badge">
                    {g.consumed
                      ? (lang === "zh" ? "已接收" : "Applied")
                      : (lang === "zh" ? "待接收" : "Queued")}
                  </span>
                </div>
                <p className="guidance-item-text">{g.message}</p>
              </div>
              {!g.consumed && (
                <div className="guidance-item-actions">
                  <button
                    type="button"
                    className="guidance-action-btn guidance-action-primary"
                    onClick={() => {
                      // "Guide now" — interrupt the current reply and inject this guidance immediately
                      window.dispatchEvent(new CustomEvent('codem-guidance-immediate', { detail: { message: g.message, guidanceId: g.id } }));
                    }}
                    title={lang === "zh" ? "立刻引导（马上注入当前对话）" : "Guide now (inject immediately)"}
                  >
                    <Zap size={12} />
                    {lang === "zh" ? "立刻引导" : "Guide"}
                  </button>
                  <button
                    type="button"
                    className="guidance-action-btn"
                    onClick={() => {
                      // Edit: cancel the queued guidance and put its content back into the input box
                      setSuggestionPrompt(g.message);
                      removeGuidanceMessage(g.id);
                    }}
                    title={lang === "zh" ? "编辑" : "Edit"}
                  >
                    <Pencil size={12} />
                    {lang === "zh" ? "编辑" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="guidance-action-btn guidance-action-close"
                    onClick={() => removeGuidanceMessage(g.id)}
                    title={lang === "zh" ? "取消" : "Cancel"}
                    aria-label={lang === "zh" ? "取消引导" : "Cancel guidance"}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <InputArea sessionKey={currentSessionId} onSend={(msg, atts, skills) => { if (isSessionStreaming && onSendGuidance) { onSendGuidance(msg); } else { onSend(msg, atts, skills); } setQuoteContext(null); }} onSendGuidance={isSessionStreaming ? onSendGuidance : undefined} onCancel={onCancel} disabled={!connected} isStreaming={!currentSessionId ? isStreaming : activeSessions.has(currentSessionId)} noSession={!currentSessionId} collaborationMode={collaborationMode} onModeChange={onModeChange || (() => {})} projectPath={projectPath} quoteContext={quoteContext} onClearQuote={() => { setQuoteContext(null); }} suggestionPrompt={suggestionPrompt} onSuggestionConsumed={() => setSuggestionPrompt(null)} notebookId={notebookId} onToggleRightSidebar={() => setShowRightSidebar(!showRightSidebar)} onToggleQuickPhrase={() => setShowQuickPhrase(!showQuickPhrase)} onToggleDraftPicker={() => setShowDraftPicker(!showDraftPicker)} hasDrafts={promptDrafts.length > 0} model={model} onModelChange={onModelChange} mode={mode} />
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
