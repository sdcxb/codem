import type { LLMMessage, ContentBlock } from "./types";

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
  stepNumber: number;
}

export interface StepFinishPart {
  type: "step_finish";
  finishReason: string;
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
const SESSIONS_KEY = "mimo-sessions-v2";

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private currentSessionId: string | null = null;

  constructor() {
    this.load();
  }

  private load() {
    try {
      const data = localStorage.getItem(SESSIONS_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        for (const [id, session] of Object.entries(parsed)) {
          this.sessions.set(id, session as Session);
        }
      }
    } catch {}
  }

  private save() {
    const obj: Record<string, Session> = {};
    for (const [id, session] of this.sessions) {
      obj[id] = session;
    }
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(obj));
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
    this.save();
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
      this.save();
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
    this.save();
  }

  updateMessage(sessionId: string, messageId: string, updater: (msg: MessageV2) => MessageV2) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    session.messages[idx] = updater(session.messages[idx]);
    session.updatedAt = Date.now();
    this.save();
  }

  deleteSession(id: string) {
    this.sessions.delete(id);
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
    }
    this.save();
  }

  renameSession(id: string, title: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title;
    this.save();
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
        // Collect text, reasoning, and tool parts
        const textContent: string[] = [];
        const toolCalls: ContentBlock[] = [];

        for (const part of msg.parts) {
          if (part.type === "text") {
            textContent.push(part.content);
          } else if (part.type === "reasoning") {
            textContent.push(`[Thinking: ${part.content}]`);
          } else if (part.type === "tool") {
            if (part.status === "completed" || part.status === "error") {
              // Add tool result as a separate message
              result.push({
                id: `${msg.id}-tool-${part.id}`,
                role: "tool",
                content: part.output || part.error || "(no output)",
                toolCallId: part.id,
              });
            }
          }
        }

        if (textContent.length > 0 || toolCalls.length > 0) {
          result.push({
            id: msg.id,
            role: "assistant",
            content: textContent.join("\n") || "(tool use)",
          });
        }
      }
    }

    return result;
  }
}
