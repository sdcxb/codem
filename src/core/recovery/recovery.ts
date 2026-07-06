import type { Session, MessageV2 } from "../llm/session";

// ========== Recovery Types ==========
export interface RecoveryConfig {
  /** Storage key prefix */
  storagePrefix: string;
  /** Maximum sessions to keep */
  maxSessions: number;
  /** Maximum messages per session */
  maxMessagesPerSession: number;
  /** Whether to auto-save on changes */
  autoSave: boolean;
  /** Auto-save interval (ms) */
  autoSaveInterval: number;
}

const DEFAULT_CONFIG: RecoveryConfig = {
  storagePrefix: "mimo-recovery",
  maxSessions: 50,
  maxMessagesPerSession: 500,
  autoSave: true,
  autoSaveInterval: 5000,
};

export interface RecoveryData {
  version: number;
  lastSaved: number;
  sessions: Record<string, Session>;
  currentSessionId: string | null;
  metadata: {
    createdAt: number;
    lastActiveAt: number;
    totalSessions: number;
    totalMessages: number;
  };
}

// ========== Session Recovery Service ==========
export class SessionRecoveryService {
  private config: RecoveryConfig;
  private data: RecoveryData;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(config?: Partial<RecoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = this.load();
    this.startAutoSave();
  }

  /** Load recovery data from SQLite */
  private load(): RecoveryData {
    try {
      const { loadRecoveryData } = require("../storage/settings");
      const raw = loadRecoveryData(this.config.storagePrefix);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.version === 1) {
          return parsed;
        }
      }
    } catch {}

    // Return default data
    return {
      version: 1,
      lastSaved: Date.now(),
      sessions: {},
      currentSessionId: null,
      metadata: {
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        totalSessions: 0,
        totalMessages: 0,
      },
    };
  }

  /** Save recovery data to SQLite */
  private save() {
    try {
      const { saveRecoveryData } = require("../storage/settings");
      this.data.lastSaved = Date.now();
      saveRecoveryData(this.config.storagePrefix, JSON.stringify(this.data));
      this.dirty = false;
    } catch (error) {
      console.error("[Recovery] Failed to save:", error);
    }
  }

  /** Start auto-save timer */
  private startAutoSave() {
    if (!this.config.autoSave) return;

    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, this.config.autoSaveInterval);
  }

  /** Stop auto-save timer */
  stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /** Mark data as dirty (needs save) */
  private markDirty() {
    this.dirty = true;
    this.data.metadata.lastActiveAt = Date.now();
  }

  /** Save a session */
  saveSession(session: Session) {
    this.data.sessions[session.id] = session;
    this.data.metadata.totalSessions = Object.keys(this.data.sessions).length;
    this.data.metadata.totalMessages = Object.values(this.data.sessions)
      .reduce((sum, s) => sum + s.messages.length, 0);
    this.markDirty();
  }

  /** Load a session */
  loadSession(sessionId: string): Session | undefined {
    return this.data.sessions[sessionId];
  }

  /** Get all sessions */
  getAllSessions(): Session[] {
    return Object.values(this.data.sessions)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get sessions for a project */
  getProjectSessions(projectId: string): Session[] {
    return this.getAllSessions()
      .filter((s) => s.projectId === projectId);
  }

  /** Delete a session */
  deleteSession(sessionId: string) {
    delete this.data.sessions[sessionId];
    if (this.data.currentSessionId === sessionId) {
      this.data.currentSessionId = null;
    }
    this.markDirty();
  }

  /** Set current session */
  setCurrentSession(sessionId: string | null) {
    this.data.currentSessionId = sessionId;
    this.markDirty();
  }

  /** Get current session */
  getCurrentSessionId(): string | null {
    return this.data.currentSessionId;
  }

  /** Add a message to a session */
  addMessage(sessionId: string, message: MessageV2) {
    const session = this.data.sessions[sessionId];
    if (!session) return;

    session.messages.push(message);
    session.updatedAt = Date.now();

    // Trim messages if too many
    if (session.messages.length > this.config.maxMessagesPerSession) {
      const excess = session.messages.length - this.config.maxMessagesPerSession;
      session.messages = session.messages.slice(excess);
    }

    this.markDirty();
  }

  /** Update a message in a session */
  updateMessage(sessionId: string, messageId: string, updater: (msg: MessageV2) => MessageV2) {
    const session = this.data.sessions[sessionId];
    if (!session) return;

    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    session.messages[idx] = updater(session.messages[idx]);
    session.updatedAt = Date.now();
    this.markDirty();
  }

  /** Get recovery state for a session */
  getSessionState(sessionId: string): {
    exists: boolean;
    messageCount: number;
    lastActivity: number;
    canRecover: boolean;
  } {
    const session = this.data.sessions[sessionId];
    if (!session) {
      return { exists: false, messageCount: 0, lastActivity: 0, canRecover: false };
    }

    return {
      exists: true,
      messageCount: session.messages.length,
      lastActivity: session.updatedAt,
      canRecover: session.messages.length > 0,
    };
  }

  /** Get recovery summary */
  getRecoverySummary(): {
    totalSessions: number;
    totalMessages: number;
    lastSaved: number;
    lastActive: number;
    sessionsWithMessages: number;
    recoverableSessions: number;
  } {
    const sessions = Object.values(this.data.sessions);
    const sessionsWithMessages = sessions.filter((s) => s.messages.length > 0).length;
    const recoverableSessions = sessions.filter((s) => s.messages.length > 0).length;

    return {
      totalSessions: sessions.length,
      totalMessages: sessions.reduce((sum, s) => sum + s.messages.length, 0),
      lastSaved: this.data.lastSaved,
      lastActive: this.data.metadata.lastActiveAt,
      sessionsWithMessages,
      recoverableSessions,
    };
  }

  /** Trim old sessions */
  trimSessions() {
    const sessions = this.getAllSessions();
    if (sessions.length > this.config.maxSessions) {
      const toDelete = sessions.slice(this.config.maxSessions);
      for (const session of toDelete) {
        delete this.data.sessions[session.id];
      }
      this.markDirty();
    }
  }

  /** Force save */
  forceSave() {
    this.save();
  }

  /** Clear all data */
  clear() {
    this.data = {
      version: 1,
      lastSaved: Date.now(),
      sessions: {},
      currentSessionId: null,
      metadata: {
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        totalSessions: 0,
        totalMessages: 0,
      },
    };
    this.save();
  }

  /** Export data */
  exportData(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /** Import data */
  importData(json: string): boolean {
    try {
      const imported = JSON.parse(json);
      if (imported.version !== 1) {
        throw new Error("Invalid data version");
      }
      this.data = imported;
      this.save();
      return true;
    } catch {
      return false;
    }
  }

  /** Destroy the service */
  destroy() {
    this.stopAutoSave();
    this.save();
  }
}

// ========== Singleton ==========
let instance: SessionRecoveryService | null = null;

export function getSessionRecoveryService(config?: Partial<RecoveryConfig>): SessionRecoveryService {
  if (!instance) {
    instance = new SessionRecoveryService(config);
  }
  return instance;
}
