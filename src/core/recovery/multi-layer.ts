import type { Session, MessageV2 } from "../llm/session";
import { loadRecoveryData, saveRecoveryData, removeRecoveryData } from "../storage/settings";

// ========== Recovery Types ==========
export type RecoveryLayer = "memory" | "local" | "file";

export interface RecoveryConfig {
  /** Storage key prefix for SQLite */
  storagePrefix: string;
  /** File path for JSONL persistence */
  filePath: string;
  /** Maximum sessions to keep per layer */
  maxSessions: number;
  /** Maximum messages per session */
  maxMessagesPerSession: number;
  /** Whether to sync across layers */
  syncAcrossLayers: boolean;
  /** Sync interval in milliseconds */
  syncInterval: number;
  /** Whether to enable JSONL append mode */
  enableJSONL: boolean;
}

const DEFAULT_CONFIG: RecoveryConfig = {
  storagePrefix: "codem-recovery",
  filePath: ".codem-recovery/sessions.jsonl",
  maxSessions: 50,
  maxMessagesPerSession: 500,
  syncAcrossLayers: true,
  syncInterval: 5000,
  enableJSONL: true,
};

export interface RecoveryEntry {
  id: string;
  sessionId: string;
  type: "session" | "message" | "checkpoint";
  data: Session | MessageV2;
  timestamp: number;
  layer: RecoveryLayer;
}

export interface RecoveryState {
  version: number;
  lastSync: number;
  layers: {
    memory: { lastWrite: number; entryCount: number };
    local: { lastWrite: number; entryCount: number };
    file: { lastWrite: number; entryCount: number; path: string };
  };
  sessions: Record<string, {
    id: string;
    lastUpdated: number;
    messageCount: number;
    layers: RecoveryLayer[];
  }>;
}

// ========== JSONL Writer ==========
export class JSONLWriter {
  private buffer: string[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private filePath: string;

  constructor(filePath: string, flushInterval: number = 1000) {
    this.filePath = filePath;
    this.flushInterval = setInterval(() => this.flush(), flushInterval);
  }

  /** Append an entry to the JSONL file */
  async append(entry: RecoveryEntry): Promise<void> {
    const line = JSON.stringify(entry);
    this.buffer.push(line);

    // Flush if buffer is large
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  /** Flush buffer to file */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const lines = this.buffer.join("\n") + "\n";
    this.buffer = [];

    try {
      const { readFile, writeFile } = await import("../file-api");
      // Append to file (read existing + write new content)
      let existing = "";
      try {
        existing = await readFile(this.filePath);
      } catch {}
      const newContent = existing ? existing + "\n" + lines : lines;
      await writeFile(this.filePath, newContent);
    } catch {}
  }

  /** Read all entries from the JSONL file */
  async read(): Promise<RecoveryEntry[]> {
    try {
      const { readFile } = await import("../file-api");
      const content = await readFile(this.filePath);
      return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /** Destroy the writer */
  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flush();
  }
}

// ========== Multi-Layer Recovery ==========
export class MultiLayerRecovery {
  private config: RecoveryConfig;
  private state: RecoveryState;
  private sessions: Map<string, Session> = new Map();
  private writer: JSONLWriter | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RecoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.initState();
    this.load();
    this.startSync();
  }

  private initState(): RecoveryState {
    return {
      version: 1,
      lastSync: Date.now(),
      layers: {
        memory: { lastWrite: 0, entryCount: 0 },
        local: { lastWrite: 0, entryCount: 0 },
        file: { lastWrite: 0, entryCount: 0, path: this.config.filePath },
      },
      sessions: {},
    };
  }

  /** Load from all layers */
  private load(): void {
    // Load from SQLite (Layer 2: local)
    try {
      const stateData = loadRecoveryData(`${this.config.storagePrefix}-state`);
      if (stateData) {
        this.state = JSON.parse(stateData);
      }

      const sessionsData = loadRecoveryData(`${this.config.storagePrefix}-sessions`);
      if (sessionsData) {
        const parsed = JSON.parse(sessionsData);
        for (const [id, session] of Object.entries(parsed)) {
          this.sessions.set(id, session as Session);
        }
      }
    } catch {}

    // Load from JSONL file (Layer 3: file) - async, will update on next sync
    if (this.config.enableJSONL) {
      this.writer = new JSONLWriter(this.config.filePath);
      this.loadFromFile();
    }
  }

  /** Load sessions from JSONL file */
  private async loadFromFile(): Promise<void> {
    if (!this.writer) return;

    const entries = await this.writer.read();
    for (const entry of entries) {
      if (entry.type === "session") {
        const session = entry.data as Session;
        const existing = this.sessions.get(session.id);
        if (!existing || session.updatedAt > existing.updatedAt) {
          this.sessions.set(session.id, session);
        }
      }
    }
  }

  /** Start periodic sync */
  private startSync(): void {
    if (!this.config.syncAcrossLayers) return;

    this.syncTimer = setInterval(() => {
      this.sync();
    }, this.config.syncInterval);
  }

  /** Sync across layers */
  async sync(): Promise<void> {
    // Sync memory (Layer 1: in-memory map)
    this.state.layers.memory.lastWrite = Date.now();
    this.state.layers.memory.entryCount = this.sessions.size;

    // Sync localStorage (Layer 2: local)
    this.saveToLocal();
    this.state.layers.local.lastWrite = Date.now();
    this.state.layers.local.entryCount = this.sessions.size;

    // Sync JSONL file (Layer 3: file)
    if (this.writer) {
      for (const session of this.sessions.values()) {
        const entry: RecoveryEntry = {
          id: `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          sessionId: session.id,
          type: "session",
          data: session,
          timestamp: Date.now(),
          layer: "file",
        };
        await this.writer.append(entry);
      }
      await this.writer.flush();
      this.state.layers.file.lastWrite = Date.now();
      this.state.layers.file.entryCount = this.sessions.size;
    }

    // Update state
    this.state.lastSync = Date.now();
    this.saveState();
  }

  /** Save to SQLite */
  private saveToLocal(): void {
    try {
      // Save state
      saveRecoveryData(`${this.config.storagePrefix}-state`, JSON.stringify(this.state));

      // Save sessions
      const sessionsObj: Record<string, Session> = {};
      for (const [id, session] of this.sessions) {
        sessionsObj[id] = session;
      }
      saveRecoveryData(`${this.config.storagePrefix}-sessions`, JSON.stringify(sessionsObj));
    } catch {}
  }

  /** Save state */
  private saveState(): void {
    try {
      saveRecoveryData(`${this.config.storagePrefix}-state`, JSON.stringify(this.state));
    } catch {}
  }

  /** Save a session */
  saveSession(session: Session): void {
    // Layer 1: In-memory
    this.sessions.set(session.id, session);

    // Layer 2: localStorage (immediate)
    this.saveToLocal();

    // Layer 3: JSONL (async, buffered)
    if (this.writer) {
      const entry: RecoveryEntry = {
        id: `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        sessionId: session.id,
        type: "session",
        data: session,
        timestamp: Date.now(),
        layer: "file",
      };
      this.writer.append(entry);
    }

    // Update state
    this.state.sessions[session.id] = {
      id: session.id,
      lastUpdated: Date.now(),
      messageCount: session.messages.length,
      layers: ["memory", "local", "file"],
    };

    this.trimSessions();
  }

  /** Load a session */
  loadSession(sessionId: string): Session | undefined {
    // Layer 1: In-memory (fastest)
    const memory = this.sessions.get(sessionId);
    if (memory) return memory;

    // Layer 2: SQLite
    try {
      const data = loadRecoveryData(`${this.config.storagePrefix}-sessions`);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed[sessionId]) {
          const session = parsed[sessionId] as Session;
          this.sessions.set(sessionId, session);
          return session;
        }
      }
    } catch {}

    // Layer 3: JSONL file (slowest)
    if (this.writer) {
      this.loadFromFile().then(() => {
        // Will be available on next access
      });
    }

    return undefined;
  }

  /** Get all sessions */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Delete a session */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    delete this.state.sessions[sessionId];
    this.saveToLocal();
  }

  /** Trim old sessions */
  private trimSessions(): void {
    const sessions = this.getAllSessions();
    if (sessions.length > this.config.maxSessions) {
      const toDelete = sessions.slice(this.config.maxSessions);
      for (const session of toDelete) {
        this.sessions.delete(session.id);
        delete this.state.sessions[session.id];
      }
    }
  }

  /** Get recovery state */
  getState(): Readonly<RecoveryState> {
    return { ...this.state };
  }

  /** Get layer health */
  getLayerHealth(): {
    memory: { healthy: boolean; entryCount: number };
    local: { healthy: boolean; entryCount: number };
    file: { healthy: boolean; entryCount: number; path: string };
  } {
    return {
      memory: {
        healthy: this.state.layers.memory.entryCount > 0,
        entryCount: this.state.layers.memory.entryCount,
      },
      local: {
        healthy: this.state.layers.local.entryCount > 0,
        entryCount: this.state.layers.local.entryCount,
      },
      file: {
        healthy: this.state.layers.file.entryCount > 0,
        entryCount: this.state.layers.file.entryCount,
        path: this.state.layers.file.path,
      },
    };
  }

  /** Export all data */
  exportData(): string {
    const data = {
      state: this.state,
      sessions: Array.from(this.sessions.entries()),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Import data */
  importData(json: string): boolean {
    try {
      const data = JSON.parse(json);
      if (data.state) this.state = data.state;
      if (data.sessions) {
        for (const [id, session] of data.sessions) {
          this.sessions.set(id, session as Session);
        }
      }
      this.saveToLocal();
      return true;
    } catch {
      return false;
    }
  }

  /** Get stats */
  getStats(): {
    totalSessions: number;
    totalMessages: number;
    lastSync: number;
    layers: {
      memory: number;
      local: number;
      file: number;
    };
  } {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      totalMessages: sessions.reduce((sum, s) => sum + s.messages.length, 0),
      lastSync: this.state.lastSync,
      layers: {
        memory: this.state.layers.memory.entryCount,
        local: this.state.layers.local.entryCount,
        file: this.state.layers.file.entryCount,
      },
    };
  }

  /** Clear all data */
  clear(): void {
    this.sessions.clear();
    this.state = this.initState();
    removeRecoveryData(`${this.config.storagePrefix}-state`);
    removeRecoveryData(`${this.config.storagePrefix}-sessions`);
  }

  /** Destroy */
  destroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    if (this.writer) {
      this.writer.destroy();
    }
  }
}

// ========== Singleton ==========
let instance: MultiLayerRecovery | null = null;

export function getMultiLayerRecovery(config?: Partial<RecoveryConfig>): MultiLayerRecovery {
  if (!instance) {
    instance = new MultiLayerRecovery(config);
  }
  return instance;
}
