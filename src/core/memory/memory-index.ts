/**
 * **跨启动的记忆索引缓存**（24 号文 P2 · 跨启动索引缓存）。
 *
 * ## 被守的缺陷（每次启动都付一遍的确定性成本）
 *
 * 记忆的读写单位是 settings 里**一整份 JSON**。每次启动都要把它读进来、逐条建索引
 * （排序键、注入摘要、内容指纹…）。条目一多，这一步就是"启动时把全部正文扫一遍"：
 * 内容没变、结果也不会变，但成本每次都要重付 —— 而它恰好落在启动最敏感的那段时间。
 *
 * 本轮把"每条记忆的派生读数"缓存进 settings 的一个**独立小键**
 * `memory-index-cache`（不写进 `memory` 那份权威 payload —— 那是整份读写、还有体积预算）：
 *
 * ```jsonc
 * { "version": 1, "payloadHash": "<整份 payload 的 sha256>", "builtAt": 0,
 *   "entries": [{ "id", "key", "scope", "usageCount", "lastUsedAt", "summary", "contentSha256" }],
 *   "truncated": 0 }
 * ```
 *
 * ## 三条边界（缺一条就会变成"第二份真相"或"无界增长"）
 *
 * 1. **不是权威**：缓存只加速"派生读数"，正文/归属/状态永远以 `memory` payload 为准；
 *    任何一条对不上（payload 哈希不符 / 版本不符 / 形状坏）都**按没有缓存处理**；
 * 2. **有界**：整份缓存 ≤ {@link MEMORY_INDEX_CACHE_MAX_BYTES}（256 KB）。超了从尾部
 *    （用得最少的那些）丢，丢掉多少如实记在 `truncated` 里 —— 命中时缺的那部分重算，
 *    而不是"假装全都缓存过"；
 * 3. **坏数据不阻断启动**：解析失败/形状不认识 ⇒ 返回"没有缓存"并带一句原因，
 *    调用方 warn 一行后重算（**不许**因为缓存坏了让记忆读不出来）。
 *
 * ## 为什么还要逐条 `contentSha256`
 *
 * 只有整份哈希时，"同步了一次小改动"就会让**全部**条目失效（整份哈希必然变）——
 * 那等于缓存只在"一条都没改过"时有用。逐条指纹让增量刷新成立：内容没变的条目
 * 复用旧摘要，只有真正改过的才重算（判据 `MEM-IDX-3` 断言"改一条 ⇒ 只重算一条"）。
 */

/** settings 键（独立小键：与 `memory` 那份权威 payload 分开） */
export const MEMORY_INDEX_CACHE_KEY = "memory-index-cache";

/** 缓存格式版本（改形状必须 +1；版本不符按没有缓存处理） */
const MEMORY_INDEX_CACHE_VERSION = 1;

/**
 * 整份缓存的字节上限（**保守口径** `json.length * 2`，与记忆 payload 预算同一把尺）。
 *
 * 取 256 KB 的理由：400 条中等规模记忆的索引 ≈ 20~40 KB；256 KB 留了一个数量级的余量，
 * 同时给"settings 每次整值读写"这件事一个明确上界（它是独立键，不占记忆的 2 MiB 预算）。
 */
export const MEMORY_INDEX_CACHE_MAX_BYTES = 256 * 1024;

/**
 * 每条缓存摘要的长度上限（**160**）。
 *
 * 与注入行的 120 字符刻意不同：注入有自己的行宽契约（`MEMORY_INJECT_LINE_MAX`），
 * 而索引里的摘要是"检索结果里没命中位置时展示的那一段"（`memory-p2-hybrid-search`
 * 的兜底摘要就是 160）—— 两处消费方各有各的口径，缓存按**较大**的那个存，
 * 小的一侧自己 slice，避免同一条记忆在两处展示不同的前缀。
 */
const MEMORY_INDEX_SUMMARY_MAX = 160;

/** 一条索引记录（落盘形态；**不含正文**） */
export interface MemoryIndexRecord {
  id: string;
  key: string;
  scope: string;
  usageCount: number;
  lastUsedAt?: number;
  /** 归一化后的正文前缀（`\s+` → 空格，≤ {@link MEMORY_INDEX_SUMMARY_MAX}） */
  summary: string;
  /** 正文的 sha256（增量刷新用；**不是**安全用途） */
  contentSha256: string;
}

/** 落盘的整份缓存 */
export interface MemoryIndexCache {
  version: number;
  /** 生成时那份 `memory` payload 的 sha256（**唯一**的整份失效判据） */
  payloadHash: string;
  builtAt: number;
  entries: MemoryIndexRecord[];
  /** 因字节上限被裁掉的条数（>0 ⇒ 缓存是部分的） */
  truncated: number;
}

/** 缓存状态（诊断/判据用；"读到了什么"必须能说清，不许只有 hit/miss 两态） */
export type MemoryIndexCacheStatus = "hit" | "partial" | "absent" | "corrupt" | "version-mismatch";

export interface MemoryIndexCacheRead {
  status: MemoryIndexCacheStatus;
  cache: MemoryIndexCache | null;
  /** 不是 hit 时的人读原因（`corrupt` / `version-mismatch` 必须带原因） */
  reason?: string;
}

/** 参与建索引的条目最小形状 */
export interface IndexableMemory {
  id: string;
  key?: unknown;
  scope?: unknown;
  usageCount?: unknown;
  lastUsedAt?: unknown;
  content?: unknown;
}

/** 正文的**展示摘要**（唯一的摘要口径；注入/检索/缓存三处都从它派生） */
export function memorySummaryOf(entry: Pick<IndexableMemory, "content">): string {
  const text = typeof entry?.content === "string" ? entry.content : String(entry?.content ?? "");
  return text.replace(/\s+/g, " ").slice(0, MEMORY_INDEX_SUMMARY_MAX);
}

/** 字节口径（与 `estimatePayloadBytes` 同一把尺：JS 字符串按 2 字节/字符保守估） */
function estimateCacheBytes(json: string): number {
  return json.length * 2;
}

/**
 * 校验并读出一份缓存（**纯函数**：调用方负责从 settings 读字符串）。
 *
 * 只做形状校验，不做语义推断：多出来的字段忽略、缺字段的条目**整条丢弃**
 * （一条坏条目不该让整份缓存作废，但它自己必须消失 —— 否则建索引时会拿到 `undefined` 摘要）。
 */
function parseMemoryIndexCache(raw: unknown): MemoryIndexCacheRead {
  if (raw === null || raw === undefined) return { status: "absent", cache: null };
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return { status: "absent", cache: null };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        status: "corrupt",
        cache: null,
        reason: `memory-index-cache 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "corrupt", cache: null, reason: "memory-index-cache 不是一个对象" };
  }
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === "number" ? Math.floor(obj.version) : -1;
  if (version !== MEMORY_INDEX_CACHE_VERSION) {
    return {
      status: "version-mismatch",
      cache: null,
      reason: `memory-index-cache 版本 ${String(obj.version)} 与当前 ${MEMORY_INDEX_CACHE_VERSION} 不符`,
    };
  }
  if (typeof obj.payloadHash !== "string" || obj.payloadHash.length === 0) {
    return { status: "corrupt", cache: null, reason: "memory-index-cache 缺 payloadHash" };
  }
  const entriesRaw = Array.isArray(obj.entries) ? obj.entries : null;
  if (!entriesRaw) return { status: "corrupt", cache: null, reason: "memory-index-cache 的 entries 不是数组" };

  const entries: MemoryIndexRecord[] = [];
  for (const item of entriesRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    entries.push({
      id,
      key: typeof r.key === "string" ? r.key : "",
      scope: typeof r.scope === "string" ? r.scope : "",
      usageCount: typeof r.usageCount === "number" && Number.isFinite(r.usageCount) ? Math.max(0, Math.floor(r.usageCount)) : 0,
      lastUsedAt:
        typeof r.lastUsedAt === "number" && Number.isFinite(r.lastUsedAt) && r.lastUsedAt > 0
          ? Math.floor(r.lastUsedAt)
          : undefined,
      summary: typeof r.summary === "string" ? r.summary.slice(0, MEMORY_INDEX_SUMMARY_MAX) : "",
      contentSha256: typeof r.contentSha256 === "string" ? r.contentSha256 : "",
    });
  }
  return {
    status: "partial",
    cache: {
      version,
      payloadHash: obj.payloadHash,
      builtAt: typeof obj.builtAt === "number" && Number.isFinite(obj.builtAt) ? Math.floor(obj.builtAt) : 0,
      entries,
      truncated:
        typeof obj.truncated === "number" && Number.isFinite(obj.truncated) ? Math.max(0, Math.floor(obj.truncated)) : 0,
    },
  };
}

/** 一条缓存记录是否**可用于这条条目**（同一 id 且正文指纹相同） */
function recordMatches(record: MemoryIndexRecord | undefined, sha: string): record is MemoryIndexRecord {
  return !!record && record.contentSha256 !== "" && record.contentSha256 === sha;
}

export interface BuildMemoryIndexOptions {
  /** 生成时那份 payload 的 sha256 */
  payloadHash: string;
  /** 生成时刻（毫秒） */
  builtAt: number;
  /** 上一次的缓存（`null` = 没有/不可用） */
  previous: MemoryIndexCache | null;
  /** 正文指纹（调用方注入：本模块不依赖任何哈希实现） */
  hashContent: (text: string) => string;
  /** 计算摘要（调用方注入：便于计数/替换） */
  computeSummary: (entry: IndexableMemory) => string;
  /** 逐条上限（默认 {@link MEMORY_INDEX_CACHE_MAX_BYTES}） */
  maxBytes?: number;
}

export interface BuildMemoryIndexResult {
  cache: MemoryIndexCache;
  /**
   * 整份 payload 哈希命中（**完全**复用，一条摘要都没重算）。
   *
   * 与 `partial` 的区别必须可判定：判据 `MEM-IDX-1` 直接断言"重启后重算次数 = 0"，
   * 而 `partial` 只允许在"payload 变了但某些条目没变"时出现。
   */
  fullHit: boolean;
  /** 复用了几条摘要 */
  reused: number;
  /** 重算了几条摘要（判据用它断言"改一条只重算一条"） */
  computed: number;
  /** 因字节上限被裁掉的条数 */
  truncated: number;
}

/**
 * 建索引（**纯函数**）：命中整份哈希 ⇒ 一条摘要都不重算；否则逐条按正文指纹增量复用。
 *
 * 裁剪规则（有界）：超出字节上限时按 `usageCount` 升序、再按 `lastUsedAt` 升序丢弃
 * （用得最少的先丢）—— 于是一次命中之后，被丢的最不可能是"用户真的在用"的那些，
 * 而丢了多少条如实落在 `truncated` 上。
 */
export function buildMemoryIndex(
  entries: Iterable<IndexableMemory>,
  options: BuildMemoryIndexOptions,
): BuildMemoryIndexResult {
  const maxBytes = options.maxBytes ?? MEMORY_INDEX_CACHE_MAX_BYTES;
  const previous = options.previous;
  const fullHit = !!previous && previous.payloadHash === options.payloadHash;
  const prevById = new Map<string, MemoryIndexRecord>();
  if (previous) for (const record of previous.entries) prevById.set(record.id, record);

  const records: MemoryIndexRecord[] = [];
  let reused = 0;
  let computed = 0;
  for (const entry of entries) {
    const id = String(entry?.id ?? "");
    if (!id) continue;
    const idPrev = prevById.get(id);
    const text = typeof entry.content === "string" ? entry.content : String(entry.content ?? "");
    /*
     * 整份哈希命中 ⇒ **不逐条算指纹**（哈希已经覆盖了全份内容，再算一遍是纯浪费）；
     * 否则逐条算指纹，只为"内容没变"的那些条目复用旧摘要。
     */
    let sha = "";
    if (fullHit && idPrev) {
      sha = idPrev.contentSha256;
    } else {
      sha = options.hashContent(text);
    }
    const canReuse = idPrev && (fullHit || recordMatches(idPrev, sha));
    let summary: string;
    if (canReuse) {
      summary = idPrev.summary;
      reused += 1;
    } else {
      summary = options.computeSummary(entry);
      computed += 1;
    }
    records.push({
      id,
      key: typeof entry.key === "string" ? entry.key : "",
      scope: typeof entry.scope === "string" ? entry.scope : "",
      usageCount:
        typeof entry.usageCount === "number" && Number.isFinite(entry.usageCount)
          ? Math.max(0, Math.floor(entry.usageCount))
          : 0,
      lastUsedAt:
        typeof entry.lastUsedAt === "number" && Number.isFinite(entry.lastUsedAt) && entry.lastUsedAt > 0
          ? Math.floor(entry.lastUsedAt)
          : undefined,
      summary,
      contentSha256: sha,
    });
  }

  const { cache, truncated } = makeIndexCache(records, {
    payloadHash: options.payloadHash,
    builtAt: options.builtAt,
    maxBytes,
  });
  return { cache, fullHit, reused, computed, truncated };
}

/**
 * 把记录包成一份**可落盘**的缓存（有界；超出上限按"最不值钱"的顺序裁）。
 *
 * 建索引与保存路径共用这一处：**有界**只有一份实现，判据直接断言
 * `JSON.stringify(cache).length * 2 <= MEMORY_INDEX_CACHE_MAX_BYTES`。
 *
 * 为什么"丢了"必须返回而不是静默：命中之后这些条目的摘要会被重算，
 * 而 `truncated > 0` 是"这次启动会比上次多花一点"的唯一可解释证据。
 */
export function makeIndexCache(
  records: readonly MemoryIndexRecord[],
  options: { payloadHash: string; builtAt: number; maxBytes?: number },
): { cache: MemoryIndexCache; truncated: number } {
  const capped = capIndexCache(records, options);
  return {
    cache: {
      version: MEMORY_INDEX_CACHE_VERSION,
      payloadHash: options.payloadHash,
      builtAt: options.builtAt,
      entries: capped.kept,
      truncated: capped.truncated,
    },
    truncated: capped.truncated,
  };
}

/**
 * 把记录裁到字节上限内（用最少的最先丢）。
 *
 * 返回 `{ kept, truncated }`（不含版本/哈希包装 —— 那一步在 `makeIndexCache`）。
 */
function capIndexCache(
  records: readonly MemoryIndexRecord[],
  options: { payloadHash: string; builtAt: number; maxBytes?: number },
): { kept: MemoryIndexRecord[]; truncated: number } {
  const maxBytes = options.maxBytes ?? MEMORY_INDEX_CACHE_MAX_BYTES;
  const list = [...records];
  const serialize = (items: MemoryIndexRecord[]): string =>
    JSON.stringify({
      version: MEMORY_INDEX_CACHE_VERSION,
      payloadHash: options.payloadHash,
      builtAt: options.builtAt,
      entries: items,
      truncated: list.length - items.length,
    });
  if (estimateCacheBytes(serialize(list)) <= maxBytes) return { kept: list, truncated: 0 };

  // 稳定排序：用得少的先丢；同 usage 时先丢更久没用过的
  const byValue = [...list].sort((a, b) => {
    if (a.usageCount !== b.usageCount) return a.usageCount - b.usageCount;
    const au = a.lastUsedAt ?? 0;
    const bu = b.lastUsedAt ?? 0;
    if (au !== bu) return au - bu;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  /** 被丢弃的 id（按"最不值钱"的顺序）——用集合而不是每次重扫数组，避免 O(n²) 的 `includes` */
  const dropped = new Set<string>();
  let kept = list;
  for (const record of byValue) {
    dropped.add(record.id);
    kept = list.filter((r) => !dropped.has(r.id));
    if (estimateCacheBytes(serialize(kept)) <= maxBytes) break;
  }
  return { kept, truncated: dropped.size };
}

/**
 * 缓存的**可用性**判定（读路径唯一入口）。
 *
 * `status: "partial"` 是"读到了，但整份哈希不符或版本/形状有瑕疵"——调用方必须按
 * "能复用就复用、不能就重算"处理，**不许**把它当 hit（那会把陈旧摘要当成新内容展示）。
 */
export function resolveIndexCache(raw: unknown, currentPayloadHash: string): MemoryIndexCacheRead {
  const read = parseMemoryIndexCache(raw);
  if (!read.cache) return read;
  if (read.cache.payloadHash === currentPayloadHash) return { status: "hit", cache: read.cache };
  return {
    status: "partial",
    cache: read.cache,
    reason: "memory-index-cache 的 payloadHash 与当前 payload 不符（内容已变，需要增量重建）",
  };
}

