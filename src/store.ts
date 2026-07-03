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

interface AppState {
  messages: Message[];
  isStreaming: boolean;
  currentModel: string;
  cwd: string;
  streamingMsgId: string | null;

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
  saveMessages: (sessionId: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  isStreaming: false,
  currentModel: "mimo-auto",
  cwd: "",
  streamingMsgId: null,

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

  setStreaming: (v) => set({ isStreaming: v, streamingMsgId: v ? get().streamingMsgId : null }),
  setCurrentModel: (m) => set({ currentModel: m }),
  setCwd: (d) => set({ cwd: d }),
  clearMessages: () => set({ messages: [], streamingMsgId: null }),

  loadMessages: (sessionId) => {
    try {
      const messages = MessageStorage.listMessages(sessionId);
      set({ messages });
    } catch (e) {
      console.error("[Store] loadMessages failed:", e);
      set({ messages: [] });
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
}));
