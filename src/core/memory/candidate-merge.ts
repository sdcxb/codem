/**
 * 自动提取候选的**入队前同主题合并**（第 229 波）。
 *
 * ## 被守的缺陷（用户实报：「自动记忆待批准条数过多、频繁打扰用户」）
 *
 * 一次提取里模型经常把**同一件事**写成好几条（真机取证：`MEMORY_MAX_PER_EXTRACTION` 降名额
 * 之前的批次 `count` 是 6~8；库内 23 对近似重复里，「Windows + PowerShell」一条事实有 5 种写法）。
 * 而写入路径的判重（`MemoryService.findDuplicateOf` → `memoryLooksDuplicate`）是**逐条写、逐条查**：
 * 第 2 条与第 1 条像时会被挡下 ⇒ 不新增条目。这一半是好的。
 *
 * 写入侧挡不住的是**三类**形态（它们各自占一个待批准名额 ⇒ 用户要点多次、看多遍）：
 * ① 相似度落在 **0.22~0.30** 低档、但标题不像的那些（真机 1128 对配对的分布里，
 *    这一档真重复与误报混在一起、首个误报 0.23）—— **本模块也不合并它们**（同一把尺，见下）；
 * ② 相似度落在低档、**标题也像**的那些（`combined ≥0.22 且 keySim ≥0.40`）——
 *    写入侧**能**判重，但那要等第 2 条已经轮到"跟第 1 条比"时才发生，而且受桶边界限制；
 *    本模块在**入队前一次性两两比 + 传递闭包**，把它们提前并成一条；
 * ③ 三条以上互相像（A~B、B~C）：写入侧逐条写入时只会"挡下后两条"，
 *    本模块并成**一条**（既少占名额，也不会留下三条互不相关的残片）。
 *
 * ## 阈值：与写入侧**同一把尺**（`MEMORY_DUPLICATE_THRESHOLD = 0.3`）
 *
 * 一开始想的是"既然只比同一次提取的候选，就放宽到 `MEMORY_DUPLICATE_KEY_ASSIST_MIN`（0.22）"
 * —— **实测证否**（第 229 波，`MEMC-2b` 抓住）：`clusterDuplicateMemories` 的命中判定里
 * `combined >= threshold` 与 `combined >= 0.22 && keySim >= 0.40` 是**两条并列**条件，
 * threshold 一降到 0.22 就把"标题自己也像"那道附加闸**整条短路**，
 * 真机哨兵（MCP 探针服务器 vs 二进制 MCP 资源不内联，combined 落在低档）当场被合并进来。
 *
 * 所以阈值定在量测分布里"每一对都是同一条事实的两种说法"的那一档（≥0.30），
 * 而"比写入侧覆盖得更宽"改由**另外两件事**实现（都不是降阈值）：
 * - **全批两两比**：写入侧的 `findDuplicateOf` 是"候选 vs 已有条目"，且受桶边界限制；
 *   这里是**候选之间**两两比，没有桶的概念（同一次提取里的候选本来就同属一段对话）；
 * - **传递闭包**：A~B、B~C ⇒ A/B/C 一组，并成**一条**。
 *   写入侧逐条写入 + 逐条查重做不到这件事（第二条被第一条挡下时，它也只会被挡下，
 *   不会让第一条知道"还有第三条跟它是一伙的"）。
 *
 * ## 误合并的代价（与写入侧判重**不对称**，务必看清）
 *
 * - 写入侧判重误判 = **一条新事实永远不写**（用户看不见的损失，`similarity.ts` 的原文）；
 * - 本模块误合并 = 两条候选**并成一条条目**，正文**仍然保留**（拼在合并条里，
 *   见 `CANDIDATE_MERGE_MAX_CONTENT_CHARS` 的边界与 `droppedContentKeys` 的留痕）
 *   ⇒ 内容没有消失，只是"不再各自单独成为一个待批准条目"。
 *   代价是：两条本来就无关的事实会挤在一个标题下（检索/注入时不会各自出现）。
 *
 * 也就是说：这里的误判**不丢内容**，只丢"条数"。
 */
import { clusterDuplicateMemories, MEMORY_DUPLICATE_THRESHOLD } from "./similarity";

/** 合并只看这三个字段（其余原样透传给调用方） */
export interface MemoryCandidateShape {
  key: string;
  content: string;
  tags?: string[];
  scope?: string;
  explicit?: boolean;
}

/**
 * 合并后正文的长度上限（字符）。
 *
 * 取值理由：单条记忆的正文上限是 `MemoryConfig.maxContentLength = 10000`，
 * 而真机语料里一条自动记忆的正文在 100~300 字符量级 ⇒ 1500 已经能容纳 5~10 条合并，
 * 同时把"合并出来的巨条"挡在注入预算（每次注入有总字符预算）之外。
 * 超限**不静默丢**：剩下的条目只保留**标题**（进 `droppedContentKeys` 如实上报）。
 */
export const CANDIDATE_MERGE_MAX_CONTENT_CHARS = 1500;

/** 一次合并的如实记录（日志与判据都用它，不靠"看正文猜"；只经 `CandidateMergeOutcome.merges` 对外） */
interface CandidateMergeRecord {
  /** 组内候选在**原始数组**里的下标（升序；第一个是保留正文的那条） */
  ids: number[];
  /** 组内所有标题（日志里点名，用户能核对"凭什么说它们是一件事"） */
  keys: string[];
  /** 组内最像的一对的合并相似度（0~1，可核对的读数） */
  similarity: number;
  /** 最像的那一对的标题 */
  pair: [string, string];
  /** 因正文长度上限而**只保留了标题**的候选（如实留痕：这些条目的正文没有进合并条） */
  droppedContentKeys: string[];
}

export interface CandidateMergeOutcome<T extends MemoryCandidateShape> {
  /** 合并后的候选（顺序沿用"每组第一条"的原始位置） */
  candidates: T[];
  /** 每一次合并的读数；没有合并时是空数组 */
  merges: CandidateMergeRecord[];
}

/**
 * 把同一次提取的候选里**同主题的那些并成一条**。
 *
 * @param items 本次提取解析出来的候选（顺序即模型给的顺序）
 * @param threshold 合并阈值；缺省 `MEMORY_DUPLICATE_THRESHOLD`（**与写入侧同一把尺**，理由见文件头）
 */
export function mergeSameTopicCandidates<T extends MemoryCandidateShape>(
  items: readonly T[],
  threshold: number = MEMORY_DUPLICATE_THRESHOLD,
): CandidateMergeOutcome<T> {
  if (items.length < 2) return { candidates: [...items], merges: [] };

  /**
   * `clusterDuplicateMemories` 按 `id` 做并查集，而候选本身没有 id
   * ⇒ 这里用**下标字符串**当 id。用下标而不是"标题"当键，是因为标题可能重复
   * （模型偶尔给两条同名候选），而重复的键会让并查集把两条不相干的条目当成同一条。
   */
  const indexed = items.map((item, index) => ({ ...item, id: String(index), order: index }));
  const groups = clusterDuplicateMemories(indexed, threshold);
  if (groups.length === 0) return { candidates: [...items], merges: [] };

  const groupOf = new Map<number, (typeof groups)[number]>();
  for (const group of groups) {
    for (const member of group.entries) groupOf.set(Number(member.id), group);
  }

  const candidates: T[] = [];
  const merges: CandidateMergeRecord[] = [];
  /** 已经被并进某一条的候选下标（它们不再单独成为一个候选） */
  const absorbed = new Set<number>();

  for (let index = 0; index < items.length; index++) {
    const group = groupOf.get(index);
    if (!group) {
      candidates.push(items[index]);
      continue;
    }
    /**
     * 每组的**组长** = 组内下标最小的一条：它决定合并条在候选序列里的位置，
     * 也让"合并后顺序"与"模型给的顺序"保持一致（顺序影响 `MEMORY_MAX_PER_EXTRACTION`
     * 名额的分配 —— 先给的候选先占名额，这是既有口径，不许因为合并而改变）。
     */
    const members = [...group.entries].sort((a, b) => Number(a.id) - Number(b.id));
    if (Number(members[0].id) !== index) {
      absorbed.add(index);
      continue;
    }
    const keeper = items[index];
    const rest = members.slice(1).map((m) => items[Number(m.id)]);
    const merged = mergeGroup(keeper, rest);
    candidates.push(merged.candidate);
    merges.push({
      ids: members.map((m) => Number(m.id)),
      keys: members.map((m) => m.key),
      similarity: group.similarity,
      pair: group.pair,
      droppedContentKeys: merged.droppedContentKeys,
    });
    for (const m of members.slice(1)) absorbed.add(Number(m.id));
  }

  return { candidates, merges };
}

/**
 * 把一个组并成一条候选。
 *
 * **保留正文的判据是"最长的那条"**（不是组长）：正文最长的候选信息最全，
 * 用它当合并条的正文能少一段"补充说明"。组长只决定位置，不决定正文 ——
 * 这两件事分开是刻意的：位置影响名额分配（既有口径），正文影响信息量（本次目标）。
 */
function mergeGroup<T extends MemoryCandidateShape>(
  keeper: T,
  rest: readonly T[],
): { candidate: T; droppedContentKeys: string[] } {
  if (rest.length === 0) return { candidate: keeper, droppedContentKeys: [] };
  const ordered = [keeper, ...rest];
  const bodyOwner = ordered.reduce((best, item) => (item.content.length > best.content.length ? item : best), keeper);
  const others = ordered.filter((item) => item !== bodyOwner);

  const droppedContentKeys: string[] = [];
  const lines: string[] = [];
  let budget = bodyOwner.content.length;
  for (const item of others) {
    const full = `- ${item.key}：${item.content}`;
    if (budget + full.length <= CANDIDATE_MERGE_MAX_CONTENT_CHARS) {
      lines.push(full);
      budget += full.length;
    } else {
      lines.push(`- ${item.key}`);
      budget += `- ${item.key}`.length;
      droppedContentKeys.push(item.key);
    }
  }

  const header = `（自动提取同批合并：另 ${others.length} 条讲的是同一件事）`;
  const content = [bodyOwner.content, header, ...lines].join("\n");
  /**
   * tags：合并条要带**组内所有标题**，否则用户在被并掉的那些说法上再也搜不到这条记忆
   * （搜索走 key/content/tags，见 `MemoryService.search`）。去重后按原顺序。
   */
  const tags = dedupeTags([...(bodyOwner.tags ?? []), ...others.map((o) => o.key)]);
  return { candidate: { ...bodyOwner, content, tags }, droppedContentKeys };
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const t = (tag ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
