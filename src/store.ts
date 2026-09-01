import { create } from "zustand";
import * as MessageStorage from "./core/storage/message";
import type { FeedbackType } from "./core/storage/message";
import { putMessageFeedback } from "./core/llm/feedback";
import { isCompactionInProgress } from "./core/storage/database";

/** Auto-retrieved knowledge source (from notebook RAG, not from tool calls) */
export interface RetrievedSource {
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
  snippet: string;
  score: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  toolCalls?: ToolCall[];
  attachments?: MessageAttachment[];
  status?: "pending" | "streaming" | "done" | "error";
  generatedFiles?: string[];
  /** Sources auto-retrieved from notebook knowledge base (not from tool calls) */
  retrievedSources?: RetrievedSource[];
  /** Structured metadata (e.g. RAG source references, tool results) */
  metadata?: Record<string, any>;
}

export interface MessageAttachment {
  id: string;
  name: string;
  type: "file" | "image" | "code" | "url" | "video" | "audio";
  content?: string;
  preview?: string;
  mimeType?: string;
  size?: number;
  /** Sandbox file path — when the attachment is synced to the workspace, this is the
   * relative path (from workspace root) where the file can be read/grep'd by file tools. */
  sandboxPath?: string;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "done" | "error";
  /** Structured metadata from tool result (e.g. search_notebook source citations) */
  metadata?: Record<string, any>;
}

export interface StepItem {
  title: string;
}

export interface AgentActivity {
  id: string;
  type: "thinking" | "tool";
  label: string;
  status: "running" | "done";
  startedAt: number;
  completedAt?: number;
}

export interface StepProgress {
  current: number;
  total: number; // 0 means unknown (indeterminate progress)
  title: string;
  steps: StepItem[] | null; // Full step plan for hover tooltip
}

export type LLMStatus = "idle" | "connecting" | "streaming" | "executing_tools";

/** A guidance message sent by the user during an active agent run */
export interface GuidanceMessage {
  id: string;
  message: string;
  timestamp: number;
  /** Whether the guidance has been consumed by the agentic loop */
  consumed: boolean;
}

/** Scroll position state for chat panel */
export type ScrollPosition = "bottom" | "near-bottom" | "scrolled-up";

/** Feedback state map: messageId -> 'like' | 'dislike' */
type FeedbackMap = Record<string, FeedbackType>;

interface AppState {
  messages: Message[];
  isStreaming: boolean;
  /** Map of sessionId → true for sessions currently running an agentic loop */
  activeSessions: Map<string, boolean>;
  currentModel: string;
  cwd: string;
  streamingMsgId: string | null;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  stepProgress: StepProgress | null;
  agentActivities: AgentActivity[];
  streamStartTime: number | null;
  llmStatus: LLMStatus;
  displayMode: "segmented" | "unified";
  /** Guidance messages sent during the current active run */
  guidanceMessages: GuidanceMessage[];
  /** P0: Message feedback map (messageId -> 'like' | 'dislike') */
  feedback: FeedbackMap;
  /** P0: Whether the user has scrolled up from the bottom of the chat */
  scrollPosition: ScrollPosition;
  /** P0: Whether there are new messages the user hasn't seen (because they scrolled up) */
  hasUnreadMessages: boolean;

  addMessage: (msg: Message) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  appendToMessage: (id: string, content: string) => void;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (messageId: string, toolId: string, update: Partial<ToolCall>) => void;
  setStreaming: (v: boolean) => void;
  /** Mark a session as active (running) or inactive */
  setSessionActive: (sessionId: string, active: boolean) => void;
  /** Check if any session is currently active */
  hasActiveSessions: () => boolean;
  setCurrentModel: (m: string) => void;
  setCwd: (d: string) => void;
  clearMessages: () => void;
  loadMessages: (sessionId: string) => void;
  loadMoreMessages: (sessionId: string, count?: number) => void;
  saveMessages: (sessionId: string) => void;
  removeGeneratedFiles: (messageId: string, files: string[]) => void;
  setStepProgress: (progress: StepProgress | null) => void;
  setAgentActivities: (activities: AgentActivity[]) => void;
  addAgentActivity: (activity: AgentActivity) => void;
  updateAgentActivity: (id: string, update: Partial<AgentActivity>) => void;
  clearAgentActivities: () => void;
  setStreamStartTime: (time: number | null) => void;
  setLLMStatus: (status: LLMStatus) => void;
  setDisplayMode: (mode: "segmented" | "unified") => void;
  /** Add a guidance message to the current run */
  addGuidanceMessage: (msg: GuidanceMessage) => void;
  /** Mark a guidance message as consumed by the loop */
  markGuidanceConsumed: (id: string) => void;
  /** Remove a guidance message once it has been injected into the loop (it no longer stays in the status bar) */
  removeGuidanceMessage: (id: string) => void;
  /** Clear all guidance messages (called when run ends) */
  clearGuidanceMessages: () => void;
  /** P0: Set feedback for a message (persists to DB). sessionId is needed for DB persistence. */
  setFeedback: (messageId: string, feedback: FeedbackType | null, sessionId?: string) => void;
  /** P0: Load feedback for a message from DB */
  loadFeedback: (messageId: string) => void;
  /** P0: Remove messages after a given message (for inline edit) */
  removeMessagesAfter: (messageId: string, includeSelf?: boolean) => void;
  /** P0: Update scroll position state */
  setScrollPosition: (pos: ScrollPosition) => void;
  /** P0: Mark that there are unread messages */
  setHasUnreadMessages: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  isStreaming: false,
  activeSessions: new Map<string, boolean>(),
  currentModel: "codem-auto",
  cwd: "",
  streamingMsgId: null,
  hasMoreMessages: false,
  isLoadingMore: false,
  stepProgress: null,
  agentActivities: [],
  streamStartTime: null,
  llmStatus: "idle" as LLMStatus,
  displayMode: "unified" as "segmented" | "unified",
  guidanceMessages: [],
  feedback: {},
  scrollPosition: "bottom",
  hasUnreadMessages: false,

  addMessage: (msg) => {
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id)) return s;
      return { messages: [...s.messages, msg] };
    });
  },

  updateMessage: (id, update) => set((s) => {
    // Only create a new object for the updated message; keep all other
    // message references identical so React.memo on MessageBubble can skip
    // re-rendering unchanged rows. This is critical for streaming performance
    // — without it, every text_delta/reasoning_delta token causes ALL
    // MessageBubbles to re-render (O(n) per token).
    let found = false;
    const messages = s.messages.map((m) => {
      if (m.id === id) { found = true; return { ...m, ...update }; }
      return m;
    });
    if (!found) return s;
    return { messages };
  }),

  appendToMessage: (id, content) => set((s) => {
    let found = false;
    const messages = s.messages.map((m) => {
      if (m.id === id && content) { found = true; return { ...m, content: m.content + content }; }
      return m;
    });
    if (!found) return s;
    return { messages };
  }),

  addToolCall: (messageId, toolCall) => set((s) => {
    const msg = s.messages.find((m) => m.id === messageId);
    if (!msg) return s;
    if ((msg.toolCalls || []).some((t) => t.id === toolCall.id)) {
      return { messages: s.messages.map((m) => m.id === messageId ? { ...m, toolCalls: (m.toolCalls || []).map((t) => t.id === toolCall.id ? { ...t, ...toolCall } : t) } : m) };
    }
    return { messages: s.messages.map((m) => m.id === messageId ? { ...m, toolCalls: [...(m.toolCalls || []), toolCall] } : m) };
  }),

  updateToolCall: (messageId, toolId, update) => set((s) => ({
    messages: s.messages.map((m) => m.id === messageId ? { ...m, toolCalls: (m.toolCalls || []).map((t) => t.id === toolId ? { ...t, ...update } : t) } : m),
  })),

  setStreaming: (v) => set((s) => {
    // Only clear global streaming UI state, not per-session activeSessions
    if (!v) {
      return { isStreaming: s.activeSessions.size > 0, streamingMsgId: null, stepProgress: null, agentActivities: [], streamStartTime: null, llmStatus: "idle" as LLMStatus };
    }
    return { isStreaming: true };
  }),
  setSessionActive: (sessionId, active) => {
    const next = new Map(get().activeSessions);
    if (active) {
      next.set(sessionId, true);
    } else {
      next.delete(sessionId);
    }
    // isStreaming = true if any session is active
    set({ activeSessions: next, isStreaming: next.size > 0 });
  },
  hasActiveSessions: () => get().activeSessions.size > 0,
  setCurrentModel: (m) => set({ currentModel: m }),
  setCwd: (d) => set({ cwd: d }),
  clearMessages: () => set({ messages: [], streamingMsgId: null, stepProgress: null, agentActivities: [], streamStartTime: null }),

  loadMessages: (sessionId) => {
    try {
      const INITIAL_LIMIT = 10;
      const messages = MessageStorage.listMessages(sessionId);
      const totalCount = messages.length;
      const initialMessages = totalCount > INITIAL_LIMIT ? messages.slice(totalCount - INITIAL_LIMIT) : messages;
      set({ 
        messages: initialMessages, 
        hasMoreMessages: totalCount > INITIAL_LIMIT,
        isLoadingMore: false,
      });
    } catch (e) {
      console.error("[Store] loadMessages failed:", e);
      set({ messages: [], hasMoreMessages: false, isLoadingMore: false });
    }
  },

  loadMoreMessages: (sessionId, count = 10) => {
    try {
      const currentMessages = get().messages;
      if (currentMessages.length === 0 || get().isLoadingMore) return;
      
      set({ isLoadingMore: true });
      
      // Small delay so the loading indicator is visible
      setTimeout(() => {
        const allMessages = MessageStorage.listMessages(sessionId);
        const currentOldestTimestamp = currentMessages[0].timestamp;
        const olderMessages = allMessages.filter(m => m.timestamp < currentOldestTimestamp);
        
        if (olderMessages.length === 0) {
          set({ hasMoreMessages: false, isLoadingMore: false });
          return;
        }
        
        const newBatch = olderMessages.length > count 
          ? olderMessages.slice(olderMessages.length - count) 
          : olderMessages;
        
        set((s) => ({ 
          messages: [...newBatch, ...s.messages],
          hasMoreMessages: olderMessages.length > count,
          isLoadingMore: false,
        }));
      }, 300);
    } catch (e) {
      console.error("[Store] loadMoreMessages failed:", e);
      set({ isLoadingMore: false });
    }
  },

  saveMessages: (sessionId) => {
    // Defense-in-depth: skip auto-save while compaction is mutating the DB.
    // The agentic-loop sets this flag during its synchronous DB commit block
    // to prevent UI auto-save from interleaving db.run calls that corrupt
    // sql.js state ("bad parameter or other API misuse").
    if (isCompactionInProgress()) {
      console.log("[Store] saveMessages skipped — compaction in progress");
      return;
    }
    try {
      const msgs = get().messages;
      for (const msg of msgs) {
        // createMessage handles dedup internally: new messages get INSERT + event log append,
        // existing messages get UPDATE only (no duplicate event).
        MessageStorage.createMessage(msg, sessionId);
      }
    } catch (e) {
      console.error("[Store] saveMessages failed:", e);
    }
  },

  removeGeneratedFiles: (messageId, files) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? { ...m, generatedFiles: (m.generatedFiles || []).filter((f) => !files.includes(f)) }
          : m
      ),
    }));
  },

  setStepProgress: (progress) => set({ stepProgress: progress }),
  setAgentActivities: (activities) => set({ agentActivities: activities }),
  addAgentActivity: (activity) => set((s) => ({ agentActivities: [...s.agentActivities, activity] })),
  updateAgentActivity: (id, update) => set((s) => ({ agentActivities: s.agentActivities.map((a) => a.id === id ? { ...a, ...update } : a) })),
  clearAgentActivities: () => set({ agentActivities: [], streamStartTime: null }),
  setStreamStartTime: (time) => set({ streamStartTime: time }),
  setLLMStatus: (status) => set({ llmStatus: status }),
  setDisplayMode: (mode) => set({ displayMode: mode }),
  addGuidanceMessage: (msg) => set((s) => ({ guidanceMessages: [...s.guidanceMessages, msg] })),
  markGuidanceConsumed: (id) => set((s) => ({
    guidanceMessages: s.guidanceMessages.map((g) => g.id === id ? { ...g, consumed: true } : g),
  })),
  removeGuidanceMessage: (id) => set((s) => ({
    guidanceMessages: s.guidanceMessages.filter((g) => g.id !== id),
  })),
  clearGuidanceMessages: () => set({ guidanceMessages: [] }),

  setFeedback: (messageId, feedback, sessionId) => {
    // Persist to database if we have a sessionId
    if (sessionId) {
      try {
        MessageStorage.saveFeedback(messageId, sessionId, feedback);
        // R3-2.2: Also record through the feedback module for event log integration
        try {
          putMessageFeedback(sessionId, messageId, feedback === "like" ? "like" : feedback === "dislike" ? "dislike" : "neutral");
        } catch { /* non-critical */ }
      } catch (e) {
        console.warn("[setFeedback] DB save failed:", e);
      }
    }
    // Update in-memory state
    set((s) => {
      const newFeedback = { ...s.feedback };
      if (feedback === null) {
        delete newFeedback[messageId];
      } else {
        newFeedback[messageId] = feedback;
      }
      return { feedback: newFeedback };
    });
  },

  loadFeedback: (messageId) => {
    try {
      const fb = MessageStorage.loadFeedback(messageId);
      if (fb) {
        set((s) => ({ feedback: { ...s.feedback, [messageId]: fb } }));
      }
    } catch (e) {
      console.warn("[loadFeedback] Failed:", e);
    }
  },

  removeMessagesAfter: (messageId, includeSelf) => {
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return s;
      const keepCount = includeSelf ? idx : idx + 1;
      // P0 fix: also clean up feedback entries for removed messages
      const removedMessages = s.messages.slice(keepCount);
      if (removedMessages.length === 0) {
        return { messages: s.messages.slice(0, keepCount) };
      }
      const newFeedback = { ...s.feedback };
      for (const msg of removedMessages) {
        delete newFeedback[msg.id];
      }
      return { messages: s.messages.slice(0, keepCount), feedback: newFeedback };
    });
  },

  setScrollPosition: (pos) => set((s) => {
    // When user scrolls to bottom, clear unread flag
    if (pos === "bottom" || pos === "near-bottom") {
      return { scrollPosition: pos, hasUnreadMessages: false };
    }
    return { scrollPosition: pos };
  }),

  setHasUnreadMessages: (v) => set({ hasUnreadMessages: v }),
}));
