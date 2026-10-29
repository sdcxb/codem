/**
 * 记忆「像不像同一条」的**唯一判定处**（第 197 波）。
 *
 * ## 为什么要有这个模块（用户报的缺陷 + 真机取证）
 *
 * 用户原话：「已经有的类似的记忆，还是频繁写入并申请审批。写入记忆应该先查一下之前有没有
 * 类似记忆，否则太多重复记忆了。」
 *
 * 旧实现（`llm/index.ts` 的提取循环）只有两条判据：`key` **逐字相等**，或
 * `content` 的**前 50 个字符逐字相等**。真机库（48 条记忆）现存 23 对近似重复，
 * 全部被它放过去了 —— 因为模型每轮都会**换个说法**：
 *
 * | 同一条事实的几种写法 | 合并相似度 |
 * | --- | --- |
 * | 「开发环境:Windows + PowerShell」/「Shell 环境:Windows PowerShell 5.1」/「Windows + PowerShell 环境限制」 | 0.43 / 0.39 / 0.31 |
 * | 「Vitest 位置参数是路径子串匹配」/「vitest 路径参数按子串匹配、多参数为 OR」/「vitest 位置参数匹配语义」 | 0.42 / 0.40 / 0.41 |
 * | 「无本地 TypeScript 编译器」/「项目内调用 tsc 的方式」/「类型检查入口:项目未通过 npx 暴露 tsc」 | 0.44 / 0.45 / 0.45 |
 * | 「基线对比方法:git stash 验证既有红」/「用 git stash 判定「红是否既有」的方法」 | 0.31 / 0.24 |
 * | 「收尾必须点名仍红的测试」/「回执不得隐去红的测试」 | 0.47 |
 *
 * ## 阈值是**量出来的**，不是拍的（真机 1128 对配对的分布）
 *
 * - `≥0.30`：**每一对都是同一条事实的两种说法**（0.31~0.55）⇒ 直接判重；
 * - `0.22~0.30`：真重复（Windows 环境族 0.23~0.27、git stash 0.24）与**误报**混在一起 ——
 *   首个误报出现在 **0.23**（「MCP 探针服务器 codem-res-probe」vs「二进制 MCP 资源不内联」，
 *   两条**不同**的事实，只是都带 MCP）⇒ 这一档**必须再加一条"标题自己也像"**才算判重；
 * - `key ≥0.60 且合并 ≥0.15`：标题几乎一样、内容有重叠（真机：「开发环境:Windows + PowerShell」
 *   vs 「Windows + PowerShell 开发环境」＝ 0.20 / key 0.90）⇒ 判重。
 *
 * 误判的两个方向代价不对称，所以规则取**保守**那一侧：
 * - 漏判 = 多一条重复（用户看得见、可拒绝、还能用「找出相似重复」一键清理）；
 * - 误判 = 一条**新事实**永远不写（用户看不见的损失）。
 * 哨兵数据里那条 0.23 的误报就是用来钉住"低档必须更严"的。
 */
import type { MemoryEntry } from "./memory";

/**
 * 合并（标题 + 正文）相似度达到这个值 ⇒ 直接判重（真机 0.31 起全是真重复）。
 *
 * ⚠️ **导出的理由（第 229 波）**：入队前的同主题合并（`candidate-merge.ts`）要**同一把尺**。
 * 那里曾想"既然只比同一次提取的候选，就把阈值放宽到 0.22"——**试出来的结论是不行**：
 * `clusterDuplicateMemories` 的命中判定里 `combined >= threshold` 与
 * `combined >= 0.22 && keySim >= 0.40` 是**两条并列**的条件，threshold 一降到 0.22
 * 就等于把"标题自己也像"那道附加闸**整条短路**（真机哨兵：MCP 那对误报当场被合并进来）。
 * ⇒ 合并侧因此改用这一档（0.3）：覆盖率靠"全批两两比 + 传递闭包"变宽，而不是靠降阈值。
 */
export const MEMORY_DUPLICATE_THRESHOLD = 0.3;
/**
 * 低档：合并 ≥0.22 时，还必须"标题自己也像"（key ≥0.40）才判重 —— 用来挡开 0.23 那类误报。
 *
 * ⚠️ **它不是一个可以拿去做 `clusterDuplicateMemories` 阈值的值**：那一档是"正文相似度 ≥0.22
 * **且** 标题 ≥0.40"，而把 0.22 当阈值传进去会让 `combined >= threshold` 先命中 ⇒
 * 标题那道闸被短路（第 229 波给「入队前合并」选阈值时实测到的坑）。
 * 所以入队前合并（`candidate-merge.ts`）用的是 `MEMORY_DUPLICATE_THRESHOLD`，**不引用**这个值 ——
 * 两个常量语义不同（这一个恒与 `MEMORY_DUPLICATE_KEY_ASSIST_KEY` 配对出现），各写各的反而安全。
 */
const MEMORY_DUPLICATE_KEY_ASSIST_MIN = 0.22;
const MEMORY_DUPLICATE_KEY_ASSIST_KEY = 0.4;
/** 同一档：标题几乎逐字相同（key ≥0.60）且正文有一点重叠 ⇒ 判重 */
const MEMORY_DUPLICATE_SAME_TITLE_KEY = 0.6;
const MEMORY_DUPLICATE_SAME_TITLE_MIN = 0.15;

/** 判重只看这两个字段（`MemoryEntry` 也满足这个形状） */
export interface MemoryDuplicateShape {
  key: string;
  content: string;
}

/** 归一化：小写 + 只留字母数字与中日韩（空白、标点、全半角差异都不该影响"像不像"） */
export function normalizeMemoryText(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 字符 2-gram 集合（中文没有词边界，2-gram 是这一类文本最稳的近似） */
function bigrams(normalized: string): Set<string> {
  const out = new Set<string>();
  if (normalized.length === 0) return out;
  if (normalized.length === 1) {
    out.add(normalized);
    return out;
  }
  for (let i = 0; i < normalized.length - 1; i++) out.add(normalized.slice(i, i + 2));
  return out;
}

/** 两个字符串的 2-gram Jaccard 相似度（0~1；任一侧为空 ⇒ 0） */
export function memorySimilarity(a: string, b: string): number {
  const A = bigrams(normalizeMemoryText(a));
  const B = bigrams(normalizeMemoryText(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 预计算好的 2-gram 集合（第 233 轮审计 · P2 卡顿）。
 *
 * `clusterDuplicateMemories` 原来是 O(n²) 次 `memorySimilarity` 调用，
 * 每次都重新规范化文本 + 重建 bigram 集合 ⇒ 同一条记忆的集合被重建 n−1 遍。
 * 实测 600 条 ≈ 3 s、按平方外推到 1500 条 ≈ 19 s（界面冻住）。
 *
 * 这里把「规范化 + 建集合」提前到 n 次，之后每对只做集合求交。
 */
interface PreparedText {
  grams: Set<string>;
}

function prepare(text: string): PreparedText {
  return { grams: bigrams(normalizeMemoryText(text)) };
}

/** 两个已备好的集合的 Jaccard（与 `memorySimilarity` 逐字节同值） */
function jaccardPrepared(A: PreparedText, B: PreparedText): number {
  if (A.grams.size === 0 || B.grams.size === 0) return 0;
  let inter = 0;
  // 用较小的一侧迭代（求交是对称的，但迭代开销与集合大小成正比）
  const [small, large] = A.grams.size <= B.grams.size ? [A.grams, B.grams] : [B.grams, A.grams];
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / (A.grams.size + B.grams.size - inter);
}

/**
 * Jaccard 的**上界**：`min(|A|,|B|) / max(|A|,|B|)`。
 *
 * 为什么要它：上界小于阈值 ⇒ 真值必然小于阈值（精确，不是近似）。
 * 于是"规模差太多 / 完全不相干"的那些对可以整对跳过 ——
 * 这一步不会漏任何真命中，见判据 `DUP-P3`。
 */
function jaccardUpperBound(A: PreparedText, B: PreparedText): number {
  const a = A.grams.size;
  const b = B.grams.size;
  if (a === 0 || b === 0) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

/** 合并相似度（标题 + 正文一起算；标题是模型对这条事实的概括，权重天然更高） */
function memoryCombinedSimilarity(a: MemoryDuplicateShape, b: MemoryDuplicateShape): number {
  return memorySimilarity(`${a.key}\n${a.content}`, `${b.key}\n${b.content}`);
}

/**
 * 这两条记忆**是不是同一条**（三段规则，见文件头）。
 *
 * ⚠️ 调用方负责决定"跟哪些条目比"（桶的边界在 `MemoryService.findDuplicateOf` 里，
 * 因为那属于数据归属策略，不属于"像不像"这件事）。
 */
export function memoryLooksDuplicate(a: MemoryDuplicateShape, b: MemoryDuplicateShape): boolean {
  if (a.key === b.key) return true; // 标题逐字相同（旧口径保留，最便宜的一条）
  const combined = memoryCombinedSimilarity(a, b);
  if (combined >= MEMORY_DUPLICATE_THRESHOLD) return true;
  const keySim = memorySimilarity(a.key, b.key);
  if (combined >= MEMORY_DUPLICATE_KEY_ASSIST_MIN && keySim >= MEMORY_DUPLICATE_KEY_ASSIST_KEY) return true;
  if (keySim >= MEMORY_DUPLICATE_SAME_TITLE_KEY && combined >= MEMORY_DUPLICATE_SAME_TITLE_MIN) return true;
  return false;
}

/** 一组被判为"同一条"的记忆（界面复核用：人工看得到证据再决定删谁） */
export interface MemoryDuplicateGroup {
  /** 组内条目 id，按**创建序**（最早的在前 —— "保留最早的一条"要用它） */
  ids: string[];
  /** 组内最相似的一对（0~1），用来在界面上给出可核对的读数 */
  similarity: number;
  /** 最相似的那一对的标题（界面上一眼看得出"为什么把它们放一起"） */
  pair: [string, string];
}

/**
 * 「找出相似重复」一次扫描的**条目上限**（第 233 轮审计）。
 *
 * 5000 条（`maxTotalEntries` 的上限）全量 O(n²) 是 1250 万对 ≈ 十几秒的同步卡顿 ——
 * 一次点击让界面冻住十几秒，比"少扫一部分"糟得多。所以：
 * - 只扫**最近** `MEMORY_DUPLICATE_SCAN_LIMIT` 条（最近的记忆最可能是那批需要清的）；
 * - 超限**如实披露**（`truncated` + `total`），不假装"全都比过了"。
 */
export const MEMORY_DUPLICATE_SCAN_LIMIT = 2000;

/** 分块大小：每块 2 万对比对，块间让出一次事件循环 */
const DUPLICATE_CHUNK_PAIRS = 20_000;

export interface DuplicateScanResult<T> {
  groups: Array<MemoryDuplicateGroup & { entries: T[] }>;
  /** 实际参与比对的条数 */
  scanned: number;
  /** 候选总数（> `scanned` 说明被上限截断） */
  total: number;
  truncated: boolean;
  /** 比对耗时（ms），界面可以如实显示 */
  elapsedMs: number;
}

/** 让出一次事件循环（Node/浏览器都可用；不依赖 DOM） */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 同 `clusterDuplicateMemories`，但**分块 + 让出主线程 + 进度回调**。
 *
 * 判据见 `memory-duplicate-scale.test.ts` 的 DUP-P4/P5/P6：
 * - 5000 条也要"有界且可披露"（`truncated: true`、`scanned: 2000`）；
 * - 分块之间真的让出（进度回调 ≥ 2 次 ⇒ 界面能画进度、能响应取消）；
 * - 小规模时与同步版**结果逐组相同**。
 */
export async function clusterDuplicateMemoriesChunked<
  T extends MemoryDuplicateShape & { id: string; order?: number },
>(
  entries: readonly T[],
  opts: {
    threshold?: number;
    /** 条目上限（默认 `MEMORY_DUPLICATE_SCAN_LIMIT`）；传 `Infinity` 表示不截断 */
    limit?: number;
    /** 每块比对的对数（默认 2 万）；判据可以调小以便观察让出 */
    chunkPairs?: number;
    onProgress?: (donePairs: number, totalPairs: number) => void;
    /** 允许取消（返回 true 就停止扫描，已得到的组照样返回） */
    shouldCancel?: () => boolean;
  } = {},
): Promise<DuplicateScanResult<T>> {
  const startedAt = Date.now();
  const threshold = opts.threshold ?? MEMORY_DUPLICATE_THRESHOLD;
  const limit = opts.limit ?? MEMORY_DUPLICATE_SCAN_LIMIT;
  const chunkPairs = Math.max(1, opts.chunkPairs ?? DUPLICATE_CHUNK_PAIRS);

  const total = entries.length;
  /** 截断时取**最近**的（调用方给的是创建序 ⇒ 取尾部） */
  const scannedEntries = limit === Infinity || total <= limit ? entries.slice() : entries.slice(total - limit);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of scannedEntries) parent.set(e.id, e.id);

  const pairScore = new Map<string, { score: number; pair: [string, string] }>();
  const preparedCombined: PreparedText[] = scannedEntries.map((e) => prepare(e.key + "\n" + e.content));
  const preparedKey: PreparedText[] = scannedEntries.map((e) => prepare(e.key));
  const minCombined = Math.min(threshold, MEMORY_DUPLICATE_KEY_ASSIST_MIN, MEMORY_DUPLICATE_SAME_TITLE_MIN);
  const minKey = Math.min(MEMORY_DUPLICATE_KEY_ASSIST_KEY, MEMORY_DUPLICATE_SAME_TITLE_KEY);

  const n = scannedEntries.length;
  /** 总对数（用于进度百分比） */
  let totalPairs = 0;
  for (let i = 0; i < n; i++) totalPairs += n - i - 1;
  let donePairs = 0;

  const finish = (): DuplicateScanResult<T> => {
    const groups = new Map<string, T[]>();
    for (const e of scannedEntries) {
      const root = find(e.id);
      const list = groups.get(root) ?? [];
      list.push(e);
      groups.set(root, list);
    }
    const out: Array<MemoryDuplicateGroup & { entries: T[] }> = [];
    for (const [root, members] of groups) {
      if (members.length < 2) continue;
      const sorted = [...members];
      const best = pairScore.get(root);
      out.push({
        ids: sorted.map((m) => m.id),
        similarity: best?.score ?? 0,
        pair: best?.pair ?? ["", ""],
        entries: sorted,
      });
    }
    out.sort((a, b) => b.similarity - a.similarity);
    return {
      groups: out,
      scanned: n,
      total,
      truncated: n < total,
      elapsedMs: Date.now() - startedAt,
    };
  };

  /** 块末让出：进度 + 取消点 */
  const checkpoint = async (): Promise<boolean> => {
    opts.onProgress?.(donePairs, totalPairs);
    await yieldToEventLoop();
    return opts.shouldCancel?.() ?? false;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = scannedEntries[i];
      const b = scannedEntries[j];
      donePairs += 1;

      /** 精确预筛（上界是**真值上界**，跳过的对一定不可能命中） */
      let skip = false;
      if (a.key !== b.key) {
        const combinedBound = jaccardUpperBound(preparedCombined[i], preparedCombined[j]);
        if (combinedBound < minCombined) {
          const keyBound = jaccardUpperBound(preparedKey[i], preparedKey[j]);
          if (keyBound < minKey) skip = true;
        }
      }

      if (!skip) {
        const combined = a.key === b.key ? 1 : jaccardPrepared(preparedCombined[i], preparedCombined[j]);
        const keySim = a.key === b.key ? 1 : jaccardPrepared(preparedKey[i], preparedKey[j]);
        const hit =
          a.key === b.key ||
          combined >= threshold ||
          (combined >= MEMORY_DUPLICATE_KEY_ASSIST_MIN && keySim >= MEMORY_DUPLICATE_KEY_ASSIST_KEY) ||
          (keySim >= MEMORY_DUPLICATE_SAME_TITLE_KEY && combined >= MEMORY_DUPLICATE_SAME_TITLE_MIN);
        if (hit) {
          const ra = find(a.id);
          const rb = find(b.id);
          if (ra !== rb) {
            parent.set(ra, rb);
            const sa = pairScore.get(ra);
            const sb = pairScore.get(rb);
            const best = !sa ? sb : !sb ? sa : sa.score >= sb.score ? sa : sb;
            if (best) pairScore.set(rb, best);
          }
          const root = find(a.id);
          const prev = pairScore.get(root);
          if (!prev || combined > prev.score) {
            pairScore.set(root, { score: combined, pair: [a.key, b.key] });
          }
        }
      }

      if (donePairs % chunkPairs === 0 && (await checkpoint())) return finish();
    }
    /** 行末也报一次进度（小数据时也能看到 ≥1 次回调） */
    if (i % Math.max(1, Math.floor(n / 20)) === 0 && (await checkpoint())) return finish();
  }
  opts.onProgress?.(totalPairs, totalPairs);

  return finish();
}

/**
 * 把一批记忆按"像不像"聚成重复组（**跨桶**：真机上同一事实散落在不同桶里，正是要清的那批）。
 *
 * 用并查集做传递闭包（A~B、B~C ⇒ A/B/C 一组），阈值**故意比写入侧更宽**
 * （`threshold` 可传 `MEMORY_DUPLICATE_KEY_ASSIST_MIN`）：这是**人工复核**入口，
 * 宁可多给一组候选让人自己判，也不要漏掉；误判由用户点不点"删"来兜。
 */
export function clusterDuplicateMemories<T extends MemoryDuplicateShape & { id: string; order?: number }>(
  entries: readonly T[],
  threshold = MEMORY_DUPLICATE_THRESHOLD,
): Array<MemoryDuplicateGroup & { entries: T[] }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // 路径压缩
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of entries) parent.set(e.id, e.id);

  /** 每一对命中的读数（取组内最大的一对作为展示证据） */
  const pairScore = new Map<string, { score: number; pair: [string, string] }>();
  /**
   * 第 233 轮审计：每条只算一次 bigram 集合（原来每对重算 ⇒ O(n²·L)）。
   * `combined` 与 `key` 各备一份，与 `memorySimilarity` 的口径逐字对应。
   */
  const preparedCombined: PreparedText[] = entries.map((e) => prepare(`${e.key}\n${e.content}`));
  const preparedKey: PreparedText[] = entries.map((e) => prepare(e.key));

  /**
   * 预筛阈值取"所有能触发命中的规则里最小的那个"：
   * `min(threshold, KEY_ASSIST_MIN, SAME_TITLE_MIN)`。
   * 只有 `combined` 低于它、**且** `keySim` 也低于 `KEY_ASSIST_KEY`/`SAME_TITLE_KEY`
   * 时才可能完全不可能命中 —— 所以判断时两个上界都要看（见下面的 `possible`）。
   */
  const minCombined = Math.min(threshold, MEMORY_DUPLICATE_KEY_ASSIST_MIN, MEMORY_DUPLICATE_SAME_TITLE_MIN);
  const minKey = Math.min(MEMORY_DUPLICATE_KEY_ASSIST_KEY, MEMORY_DUPLICATE_SAME_TITLE_KEY);

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      /**
       * 精确预筛（上界是**真值上界**，跳过的对一定不可能命中）：
       * - `combined` 的上界低于 `minCombined`，且
       * - `keySim` 的上界低于 `minKey`
       * 两条同时成立 ⇒ 任何规则都不可能命中；同 key 的那条规则单独先判。
       */
      if (a.key !== b.key) {
        const combinedBound = jaccardUpperBound(preparedCombined[i], preparedCombined[j]);
        if (combinedBound < minCombined) {
          const keyBound = jaccardUpperBound(preparedKey[i], preparedKey[j]);
          if (keyBound < minKey) continue;
        }
      }
      const combined = a.key === b.key ? 1 : jaccardPrepared(preparedCombined[i], preparedCombined[j]);
      const keySim = a.key === b.key ? 1 : jaccardPrepared(preparedKey[i], preparedKey[j]);
      const hit =
        a.key === b.key ||
        combined >= threshold ||
        (combined >= MEMORY_DUPLICATE_KEY_ASSIST_MIN && keySim >= MEMORY_DUPLICATE_KEY_ASSIST_KEY) ||
        (keySim >= MEMORY_DUPLICATE_SAME_TITLE_KEY && combined >= MEMORY_DUPLICATE_SAME_TITLE_MIN);
      if (!hit) continue;
      const ra = find(a.id);
      const rb = find(b.id);
      if (ra !== rb) {
        parent.set(ra, rb);
        // 把已有读数搬到新的根上（并查集合并后组的证据要跟着走）
        const sa = pairScore.get(ra);
        const sb = pairScore.get(rb);
        const best = !sa ? sb : !sb ? sa : sa.score >= sb.score ? sa : sb;
        if (best) pairScore.set(rb, best);
      }
      const root = find(a.id);
      const prev = pairScore.get(root);
      if (!prev || combined > prev.score) {
        pairScore.set(root, { score: combined, pair: [a.key, b.key] });
      }
    }
  }

  const groups = new Map<string, T[]>();
  for (const e of entries) {
    const root = find(e.id);
    const list = groups.get(root) ?? [];
    list.push(e);
    groups.set(root, list);
  }

  const out: Array<MemoryDuplicateGroup & { entries: T[] }> = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    // 组内按创建序（`order` 缺省时退回数组原序 —— 调用方给的就是创建序）
    const sorted = [...members];
    const best = pairScore.get(root);
    out.push({
      ids: sorted.map((m) => m.id),
      similarity: best?.score ?? 0,
      pair: best?.pair ?? ["", ""],
      entries: sorted,
    });
  }
  // 证据最强的组排前面（用户先看最确定的）
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}
