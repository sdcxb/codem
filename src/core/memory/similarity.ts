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

/** 合并（标题 + 正文）相似度达到这个值 ⇒ 直接判重（真机 0.31 起全是真重复） */
const MEMORY_DUPLICATE_THRESHOLD = 0.3;
/** 低档：合并 ≥0.22 时，还必须"标题自己也像"（key ≥0.40）才判重 —— 用来挡开 0.23 那类误报 */
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
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const combined = memoryCombinedSimilarity(a, b);
      const keySim = memorySimilarity(a.key, b.key);
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
