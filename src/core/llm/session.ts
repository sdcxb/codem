import type { LLMMessage, ContentBlock } from "./types";
import { loadV2Sessions, saveV2Session, deleteV2Session } from "../storage/v2-session";

// ========== Message V2 (Claude Code style) ==========
export interface MessageV2 {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  timestamp: number;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cost?: number;
  };
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | StepStartPart
  | StepFinishPart;

export interface TextPart {
  type: "text";
  content: string;
}

export interface ReasoningPart {
  type: "reasoning";
  content: string;
}

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: "pending" | "running" | "completed" | "error";
  error?: string;
  metadata?: Record<string, any>;
}

export interface FilePart {
  type: "file";
  path: string;
  action: "read" | "write" | "edit";
}

export interface StepStartPart {
  type: "step_start";
  name: string;
}

export interface StepFinishPart {
  type: "step_finish";
  name: string;
  duration: number;
  result: "success" | "error";
}

// ========== Session ==========
export interface Session {
  id: string;
  projectId: string;
  title: string;
  messages: MessageV2[];
  createdAt: number;
  updatedAt: number;
  model: string;
  totalUsage: {
    promptTokens: number;
    completionTokens: number;
    cost: number;
  };
}

// ========== Session Manager ==========

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private currentSessionId: string | null = null;

  constructor() {
    this.load();
  }

  private load() {
    this.sessions = loadV2Sessions();
  }

  /** Reload sessions from database (call after DB init) */
  reload() {
    this.load();
  }

  private save(session: Session) {
    saveV2Session(session);
    // Don't sync to messages table - let useAppStore handle persistence
  }

  createSession(projectId: string, model: string): Session {
    const session: Session = {
      id: `ses-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      projectId,
      title: `对话 ${this.sessions.size + 1}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      totalUsage: { promptTokens: 0, completionTokens: 0, cost: 0 },
    };
    this.sessions.set(session.id, session);
    this.currentSessionId = session.id;
    this.save(session);
    return session;
  }

  getOrCreateSession(id: string, projectId: string, model: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        projectId,
        title: `对话 ${this.sessions.size + 1}`,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model,
        totalUsage: { promptTokens: 0, completionTokens: 0, cost: 0 },
      };
      this.sessions.set(session.id, session);
      this.save(session);
    }
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getCurrentSession(): Session | undefined {
    return this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined;
  }

  setCurrentSession(id: string) {
    this.currentSessionId = id;
  }

  getSessionsForProject(projectId: string): Session[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addMessage(sessionId: string, message: MessageV2) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.updatedAt = Date.now();
    this.save(session);
  }

  updateMessage(sessionId: string, messageId: string, updater: (msg: MessageV2) => MessageV2) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    session.messages[idx] = updater(session.messages[idx]);
    session.updatedAt = Date.now();
    this.save(session);
  }

  deleteSession(id: string) {
    this.sessions.delete(id);
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
    }
    deleteV2Session(id);
  }

  renameSession(id: string, title: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title;
    this.save(session);
  }

  /** Convert MessageV2 to LLM API message format */
  toAPIMessages(messages: MessageV2[]): LLMMessage[] {
    const result: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        const textParts = msg.parts.filter((p) => p.type === "text") as TextPart[];
        result.push({
          id: msg.id,
          role: "user",
          content: textParts.map((p) => p.content).join("\n") || "(empty)",
        });
      } else if (msg.role === "assistant") {
        const textContent: string[] = [];
        const toolParts: any[] = [];

        for (const part of msg.parts) {
          if (part.type === "text") {
            textContent.push(part.content);
          } else if (part.type === "reasoning") {
            textContent.push(`[Thinking: ${part.content}]`);
          } else if (part.type === "tool") {
            toolParts.push(part);
          }
        }

        // Only add tool_calls if ALL tool parts have results
        const completedTools = toolParts.filter((p) => p.status === "completed" || p.status === "error");
        const hasCompleteTools = toolParts.length > 0 && completedTools.length === toolParts.length;

        // Add assistant message
        if (textContent.length > 0 || toolParts.length > 0) {
          const assistantMsg: any = {
            id: msg.id,
            role: "assistant",
            content: textContent.join("\n") || "",
          };
          if (hasCompleteTools) {
            assistantMsg.tool_calls = completedTools.map((part) => ({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input || {}),
              },
            }));
          }
          result.push(assistantMsg);
        }

        // Add tool results only if we added tool_calls
        if (hasCompleteTools) {
          for (const part of completedTools) {
            result.push({
              id: `${msg.id}-tool-${part.id}`,
              role: "tool",
              content: part.output || part.error || "(no output)",
              toolCallId: part.id,
            });
          }
        }
      }
    }

    // Final safety: remove orphan tool messages
    const cleaned: LLMMessage[] = [];
    let lastAssistantWithToolCalls = false;
    for (const msg of result) {
      if (msg.role === "assistant") {
        lastAssistantWithToolCalls = !!(msg as any).tool_calls;
        cleaned.push(msg);
      } else if (msg.role === "tool") {
        if (lastAssistantWithToolCalls) {
          cleaned.push(msg);
        }
      } else {
        lastAssistantWithToolCalls = false;
        cleaned.push(msg);
      }
    }

    return cleaned;
  }
}
