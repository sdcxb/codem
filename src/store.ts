import { create } from "zustand";
import * as MessageStorage from "./core/storage/message";

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
}

export interface MessageAttachment {
  id: string;
  name: string;
  type: "file" | "image" | "code" | "url";
  content?: string;
  preview?: string;
  mimeType?: string;
  size?: number;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "done" | "error";
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

interface AppState {
  messages: Message[];
  isStreaming: boolean;
  currentModel: string;
  cwd: string;
  streamingMsgId: string | null;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  stepProgress: StepProgress | null;
  agentActivities: AgentActivity[];
  streamStartTime: number | null;

  addMessage: (msg: Message) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  appendToMessage: (id: string, content: string) => void;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (messageId: string, toolId: string, update: Partial<ToolCall>) => void;
  setStreaming: (v: boolean) => void;
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
}

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  isStreaming: false,
  currentModel: "mimo-auto",
  cwd: "",
  streamingMsgId: null,
  hasMoreMessages: false,
  isLoadingMore: false,
  stepProgress: null,
  agentActivities: [],
  streamStartTime: null,

  addMessage: (msg) => {
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id)) return s;
      return { messages: [...s.messages, msg] };
    });
  },

  updateMessage: (id, update) => set((s) => ({ messages: s.messages.map((m) => m.id === id ? { ...m, ...update } : m) })),

  appendToMessage: (id, content) => set((s) => {
    const msg = s.messages.find((m) => m.id === id);
    if (!msg) return s;
    return {
      messages: s.messages.map((m) => m.id === id && content ? { ...m, content: m.content + content } : m),
    };
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

  setStreaming: (v) => set({ isStreaming: v, streamingMsgId: v ? get().streamingMsgId : null, stepProgress: v ? get().stepProgress : null, agentActivities: v ? get().agentActivities : [], streamStartTime: v ? get().streamStartTime : null }),
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
    try {
      const msgs = get().messages;
      for (const msg of msgs) {
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
}));
