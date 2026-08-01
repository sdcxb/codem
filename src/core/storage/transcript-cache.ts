/**
 * TranscriptCache — Cache LLM request/response pairs to reduce token waste
 *
 * Key: SHA-256(messages_json + model + temperature)
 * Value: { response_text, tool_calls_json, usage, cached_at }
 *
 * Stored in-memory (Map) with optional SQLite persistence.
 * Cache hit returns cached response without calling the LLM.
 * Cache is invalidated when:
 *   - New user message is added (session-level invalidation)
 *   - Context compaction happens (full clear)
 *   - Explicitly cleared
 */

const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  responseText: string;
  toolCalls: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  cachedAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface TranscriptCacheKey {
  messages: any[];
  model: string;
  temperature: number;
  systemPrompt: string;
}

export interface TranscriptCacheResult {
  responseText?: string;
  toolCalls?: any[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  hit: boolean;
}

export const TranscriptCache = {
  /**
   * Build cache key from request params.
   */
  async buildKey(params: TranscriptCacheKey): Promise<string> {
    const serialized = JSON.stringify({
      m: params.messages.map((m: any) => ({ r: m.role, c: typeof m.content === "string" ? m.content.slice(0, 500) : "" })),
      model: params.model,
      temp: params.temperature,
      sp: params.systemPrompt.slice(0, 500),
    });
    return sha256(serialized);
  },

  /**
   * Get cached response by key.
   */
  get(key: string): TranscriptCacheResult | null {
    const entry = memoryCache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      memoryCache.delete(key);
      return null;
    }

    return {
      responseText: entry.responseText,
      toolCalls: entry.toolCalls ? JSON.parse(entry.toolCalls) : undefined,
      usage: entry.usage,
      hit: true,
    };
  },

  /**
   * Store a response in cache.
   */
  set(
    key: string,
    responseText: string,
    toolCalls: any[] | null,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null,
  ): void {
    // Enforce max size — evict oldest entries
    if (memoryCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = memoryCache.keys().next().value;
      if (oldestKey) memoryCache.delete(oldestKey);
    }

    memoryCache.set(key, {
      responseText,
      toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
      usage,
      cachedAt: Date.now(),
    });
  },

  /**
   * Clear entire cache (e.g., on context compaction).
   */
  clear(): void {
    memoryCache.clear();
  },

  /**
   * Get current cache stats.
   */
  stats(): { size: number; maxSize: number } {
    return { size: memoryCache.size, maxSize: MAX_CACHE_SIZE };
  },
};
