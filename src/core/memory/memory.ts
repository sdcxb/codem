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
  rootDir: ".codem-memory",
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

/** Reload memory from SQLite (call when DB is ready) */
reload() {
this.entries.clear();
this.load();
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

  // ========== F2.4: Export / Import ==========

  /** Export all memories as JSON string */
  exportAsJSON(): string {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: Array.from(this.entries.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Export all memories as Markdown */
  exportAsMarkdown(): string {
    const lines: string[] = ["# Codem Memory Export", ""];
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push("");

    for (const scope of ["global", "project", "session"] as MemoryScope[]) {
      const entries = this.listByScope(scope);
      if (entries.length === 0) continue;
      lines.push(`## ${scope.charAt(0).toUpperCase() + scope.slice(1)} Memories`);
      lines.push("");
      for (const e of entries) {
        const date = new Date(e.timestamp).toISOString().split("T")[0];
        lines.push(`### ${e.key}`);
        lines.push(`- **ID**: ${e.id}`);
        lines.push(`- **Date**: ${date}`);
        if (e.tags && e.tags.length > 0) {
          lines.push(`- **Tags**: ${e.tags.join(", ")}`);
        }
        if (e.filePath) {
          lines.push(`- **File**: ${e.filePath}`);
        }
        lines.push("");
        lines.push(e.content);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /** Import memories from JSON string. Returns count of imported entries. */
  importFromJSON(jsonStr: string, overwrite = false): number {
    try {
      const data = JSON.parse(jsonStr);
      const entries: MemoryEntry[] = Array.isArray(data) ? data : (data.entries || []);
      let count = 0;
      for (const entry of entries) {
        if (!entry.id || !entry.key || !entry.content) continue;
        if (!overwrite && this.entries.has(entry.id)) continue;
        this.entries.set(entry.id, {
          ...entry,
          content: entry.content.substring(0, this.config.maxContentLength),
        });
        count++;
      }
      if (count > 0) this.save();
      return count;
    } catch (err) {
      console.error("[importFromJSON] Failed:", err);
      return 0;
    }
  }

  // ========== F3.1: Cross-session Memory Consolidation ==========

  /**
   * F3.1: Consolidate memories across sessions.
   *
   * Performs three operations:
   * 1. **Deduplication**: Find entries with similar keys/content and merge them
   *    into a single entry (keeping the most recent, combining content).
   * 2. **Stale cleanup**: Remove entries older than `maxAgeDays` that haven't been
   *    accessed recently (based on timestamp).
   * 3. **Capacity enforcement**: Enforce max entries per scope (FIFO eviction).
   *
   * Returns a summary of what was done.
   */
  consolidate(options?: {
    maxAgeDays?: number;        // Default: 90 days
    maxEntriesPerScope?: number; // Default: from config
    similarityThreshold?: number; // Default: 0.7 (70% content similarity)
  }): { duplicatesMerged: number; staleRemoved: number; capacityTrimmed: number } {
    const maxAgeDays = options?.maxAgeDays ?? 90;
    const maxPerScope = options?.maxEntriesPerScope ?? 200;
    const similarityThreshold = options?.similarityThreshold ?? 0.7;

    let duplicatesMerged = 0;
    let staleRemoved = 0;
    let capacityTrimmed = 0;

    const allEntries = Array.from(this.entries.values());

    // --- 1. Deduplication ---
    // Group by scope, then find similar entries within each scope
    for (const scope of ["project", "global", "session"] as MemoryScope[]) {
      const scopedEntries = allEntries
        .filter(e => e.scope === scope)
        .sort((a, b) => b.timestamp - a.timestamp); // Most recent first

      const toDelete = new Set<string>();
      const toMerge: Map<string, string[]> = new Map(); // keeperId -> [duplicateIds]

      for (let i = 0; i < scopedEntries.length; i++) {
        if (toDelete.has(scopedEntries[i].id)) continue;

        for (let j = i + 1; j < scopedEntries.length; j++) {
          if (toDelete.has(scopedEntries[j].id)) continue;

          const similarity = this.calculateSimilarity(scopedEntries[i], scopedEntries[j]);
          if (similarity >= similarityThreshold) {
            // Mark j as duplicate of i
            toDelete.add(scopedEntries[j].id);
            const existing = toMerge.get(scopedEntries[i].id) || [];
            existing.push(scopedEntries[j].id);
            toMerge.set(scopedEntries[i].id, existing);
          }
        }
      }

      // Merge duplicate content into keepers
      for (const [keeperId, dupIds] of toMerge) {
        const keeper = this.entries.get(keeperId);
        if (!keeper) continue;

        const dupContents: string[] = [];
        for (const dupId of dupIds) {
          const dup = this.entries.get(dupId);
          if (dup) {
            // Append content that's not already in the keeper
            if (!keeper.content.includes(dup.content.substring(0, 50))) {
              dupContents.push(dup.content);
            }
            // Merge tags
            if (dup.tags) {
              keeper.tags = [...new Set([...(keeper.tags || []), ...dup.tags])];
            }
          }
        }

        if (dupContents.length > 0) {
          keeper.content = (keeper.content + "\n\n" + dupContents.join("\n\n")).substring(0, this.config.maxContentLength);
        }

        this.entries.set(keeperId, keeper);
        duplicatesMerged += dupIds.length;
      }

      // Delete duplicates
      for (const id of toDelete) {
        this.entries.delete(id);
      }
    }

    // --- 2. Stale cleanup ---
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    for (const [id, entry] of this.entries) {
      if (entry.scope === "session") continue; // Don't auto-clean session memories
      if (now - entry.timestamp > maxAgeMs) {
        this.entries.delete(id);
        staleRemoved++;
      }
    }

    // --- 3. Capacity enforcement ---
    for (const scope of ["project", "global", "session"] as MemoryScope[]) {
      const scopedEntries = Array.from(this.entries.values())
        .filter(e => e.scope === scope)
        .sort((a, b) => b.timestamp - a.timestamp); // Most recent first

      if (scopedEntries.length > maxPerScope) {
        const toRemove = scopedEntries.slice(maxPerScope);
        for (const entry of toRemove) {
          this.entries.delete(entry.id);
          capacityTrimmed++;
        }
      }
    }

    if (duplicatesMerged > 0 || staleRemoved > 0 || capacityTrimmed > 0) {
      this.save();
      console.log(`[F3.1] Memory consolidation: ${duplicatesMerged} duplicates merged, ${staleRemoved} stale removed, ${capacityTrimmed} capacity trimmed`);
    }

    return { duplicatesMerged, staleRemoved, capacityTrimmed };
  }

  /**
   * Calculate similarity between two memory entries (0-1).
   * Uses key similarity (Jaccard) + content overlap.
   */
  private calculateSimilarity(a: MemoryEntry, b: MemoryEntry): number {
    // Key similarity: exact match = 1.0, partial match = lower
    let keyScore = 0;
    if (a.key === b.key) {
      keyScore = 1.0;
    } else {
      const aWords = new Set(a.key.toLowerCase().split(/\s+/));
      const bWords = new Set(b.key.toLowerCase().split(/\s+/));
      const intersection = [...aWords].filter(w => bWords.has(w)).length;
      const union = new Set([...aWords, ...bWords]).size;
      keyScore = union > 0 ? intersection / union : 0;
    }

    // Content similarity: based on first 200 chars overlap
    const aPrefix = a.content.substring(0, 200).toLowerCase();
    const bPrefix = b.content.substring(0, 200).toLowerCase();
    let contentScore = 0;
    if (aPrefix === bPrefix) {
      contentScore = 1.0;
    } else {
      // Simple character-level overlap
      const aChars = new Set(aPrefix);
      const bChars = new Set(bPrefix);
      const intersection = [...aChars].filter(c => bChars.has(c)).length;
      const union = new Set([...aChars, ...bChars]).size;
      contentScore = union > 0 ? intersection / union : 0;
    }

    // Weighted: key match is more important
    return keyScore * 0.6 + contentScore * 0.4;
  }

  /**
   * F3.1: Get memory consolidation stats.
   * Useful for UI display and debugging.
   */
  getConsolidationStats(): {
    totalEntries: number;
    potentialDuplicates: number;
    oldestAge: number | null;
    scopeBreakdown: Record<MemoryScope, number>;
  } {
    const allEntries = Array.from(this.entries.values());
    let potentialDuplicates = 0;

    // Quick check for potential duplicates (same key)
    const keyCounts: Record<string, number> = {};
    for (const entry of allEntries) {
      const key = entry.key.toLowerCase();
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
    for (const count of Object.values(keyCounts)) {
      if (count > 1) potentialDuplicates += count - 1;
    }

    const timestamps = allEntries.map(e => e.timestamp);
    const now = Date.now();
    const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const oldestAge = oldest !== null ? Math.floor((now - oldest) / (24 * 60 * 60 * 1000)) : null;

    const scopeBreakdown: Record<MemoryScope, number> = { project: 0, session: 0, global: 0 };
    for (const entry of allEntries) {
      scopeBreakdown[entry.scope]++;
    }

    return {
      totalEntries: allEntries.length,
      potentialDuplicates,
      oldestAge,
      scopeBreakdown,
    };
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
