import type { MessageV2 } from "../llm/session";
import { loadMemory, saveMemory } from "../storage/settings";

// ========== Memory Types ==========
export type MemoryScope = "project" | "session" | "global";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  filePath?: string;
  timestamp: number;
  tags?: string[];
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

export interface MemoryConfig {
  /** Root directory for memory files */
  rootDir: string;
  /** Maximum entries per scope */
  maxEntries: number;
  /** Maximum content length per entry */
  maxContentLength: number;
}

const DEFAULT_CONFIG: MemoryConfig = {
  rootDir: ".mimo-memory",
  maxEntries: 1000,
  maxContentLength: 10000,
};

// ========== Memory Service ==========
export class MemoryService {
  private config: MemoryConfig;
  private entries: Map<string, MemoryEntry> = new Map();

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.load();
  }

  /** Load memory from SQLite */
  private load() {
    try {
      const data = loadMemory();
      if (data) {
        const parsed = JSON.parse(data);
        for (const [id, entry] of Object.entries(parsed)) {
          this.entries.set(id, entry as MemoryEntry);
        }
      }
    } catch {}
  }

  /** Save memory to SQLite */
  private save() {
    const obj: Record<string, MemoryEntry> = {};
    for (const [id, entry] of this.entries) {
      obj[id] = entry;
    }
    try {
      saveMemory(JSON.stringify(obj));
    } catch {}
  }

  /** Add a memory entry */
  add(entry: Omit<MemoryEntry, "id" | "timestamp">): MemoryEntry {
    const id = `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fullEntry: MemoryEntry = {
      ...entry,
      id,
      timestamp: Date.now(),
      content: entry.content.substring(0, this.config.maxContentLength),
    };

    this.entries.set(id, fullEntry);
    this.save();
    return fullEntry;
  }

  /** Get a memory entry */
  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  /** Update a memory entry */
  update(id: string, updates: Partial<MemoryEntry>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    this.entries.set(id, {
      ...entry,
      ...updates,
      id, // Prevent id change
      timestamp: Date.now(),
    });
    this.save();
    return true;
  }

  /** Delete a memory entry */
  delete(id: string): boolean {
    const deleted = this.entries.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  /** List entries by scope */
  listByScope(scope: MemoryScope): MemoryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.scope === scope)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /** List entries by tag */
  listByTag(tag: string): MemoryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.tags?.includes(tag))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Search memory using simple text matching (BM25-like) */
  search(query: string, scope?: MemoryScope, limit: number = 10): MemorySearchResult[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: MemorySearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (scope && entry.scope !== scope) continue;

      const contentLower = entry.content.toLowerCase();
      const keyLower = entry.key.toLowerCase();

      let score = 0;
      for (const term of queryTerms) {
        // Key match (higher weight)
        if (keyLower.includes(term)) {
          score += 10;
        }

        // Content match
        const contentMatches = (contentLower.match(new RegExp(term, "g")) || []).length;
        score += contentMatches;

        // Tag match
        if (entry.tags?.some((t) => t.toLowerCase().includes(term))) {
          score += 5;
        }
      }

      if (score > 0) {
        // Extract snippet around first match
        const firstMatch = contentLower.indexOf(queryTerms[0]);
        const snippetStart = Math.max(0, firstMatch - 50);
        const snippetEnd = Math.min(entry.content.length, firstMatch + 100);
        const snippet = entry.content.substring(snippetStart, snippetEnd);

        results.push({ entry, score, snippet });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Build memory prompt for system prompt */
  buildMemoryPrompt(scope: MemoryScope, _projectId?: string): string {
    const entries = this.listByScope(scope);
    if (entries.length === 0) return "";

    const lines = entries.slice(0, 20).map((e) => {
      const date = new Date(e.timestamp).toISOString().split("T")[0];
      return `- [${date}] ${e.key}: ${e.content.substring(0, 200)}`;
    });

    return `## ${scope.charAt(0).toUpperCase() + scope.slice(1)} Memory\n\n${lines.join("\n")}`;
  }

  /** Build checkpoint for session */
  buildCheckpoint(messages: MessageV2[]): string {
    const lines: string[] = ["# Session Checkpoint", ""];

    // Extract key information from messages
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    lines.push(`## Conversation Summary`);
    lines.push(`- Total messages: ${messages.length}`);
    lines.push(`- User messages: ${userMessages.length}`);
    lines.push(`- Assistant messages: ${assistantMessages.length}`);

    // Extract tool calls
    const toolCalls: string[] = [];
    for (const msg of assistantMessages) {
      for (const part of msg.parts) {
        if (part.type === "tool") {
          toolCalls.push(`${part.name}: ${JSON.stringify(part.input).substring(0, 100)}`);
        }
      }
    }

    if (toolCalls.length > 0) {
      lines.push("\n## Tools Used");
      toolCalls.forEach((tc) => lines.push(`- ${tc}`));
    }

    // Extract recent decisions
    const recentTexts = assistantMessages
      .slice(-5)
      .flatMap((m) => m.parts.filter((p) => p.type === "text"))
      .map((p) => p.content.substring(0, 200));

    if (recentTexts.length > 0) {
      lines.push("\n## Recent Responses");
      recentTexts.forEach((t) => lines.push(`- ${t}`));
    }

    return lines.join("\n");
  }

  /** Get stats */
  getStats(): {
    totalEntries: number;
    byScope: Record<MemoryScope, number>;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    const entries = Array.from(this.entries.values());
    const byScope: Record<MemoryScope, number> = { project: 0, session: 0, global: 0 };

    for (const entry of entries) {
      byScope[entry.scope]++;
    }

    const timestamps = entries.map((e) => e.timestamp);

    return {
      totalEntries: entries.length,
      byScope,
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : null,
    };
  }

  /** Clear all entries */
  clear(scope?: MemoryScope) {
    if (scope) {
      for (const [id, entry] of this.entries) {
        if (entry.scope === scope) {
          this.entries.delete(id);
        }
      }
    } else {
      this.entries.clear();
    }
    this.save();
  }
}

// ========== Singleton ==========
let instance: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!instance) {
    instance = new MemoryService();
  }
  return instance;
}
