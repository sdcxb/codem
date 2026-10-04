/**
 * **替它把"拿任务里的词搜仓库"这一步做了**（第 98 波）。
 *
 * ## 依据：读赢的那一臂的实际路径
 *
 * 对照臂（DSH）在 `repo-02` 上稳定通过 ✓，它的会话事件显示：
 * `glob` 摸形状 → **`grep "一次性要求"` / `grep "写入确认"`**（任务描述里的词）
 * → 顺代码线索 → `grep "classifyToolResult|applyToolResultStatus|isError" include:"*.ts"`（117 命中，含测试文件）
 * → 从命中里看出命名规律（D8/D9/D10）→ **`read src/test/dsh-d9-multi-edit-partial-failure.test.ts`** ✓。
 *
 * 而我们前两版机制都无效 ✗：真实工作区有 **496–4000+** 个测试文件，
 * 字母序前 40 全是 `aa-*`（目标在第 200–380 位）✗；按词面排序也不行 ——
 * **任务描述是中文、判据文件名是英文**，词面重叠≈0 ✗。
 *
 * ⇒ 正确等价物：**做那一步搜索** —— 从用户消息抽关键词，**只在测试文件里搜**，
 * 把命中的文件（含命中次数）列出来。仍然是**只陈述事实**（不评价该不该跑）✓。
 *
 * ## 设计约束
 *
 * 1. **只搜测试文件**：这份清单的用途是"找到该看哪条判据"，把源码命中混进来只会稀释信号 ✓。
 * 2. **按命中次数排序**：赢家正是从"命中多、名字像"的线索里看出规律的 ✓。
 * 3. **没有命中就什么都不输出**（返回 `null`）：不留噪声、不改变无关任务的行为 ✓。
 * 4. **跳过隐藏目录与依赖/产物目录**：参考检出（`.xxx-ref/`）与 `node_modules` 一进来就能把清单撑爆 ✗。
 * 5. **上限**：文件数、单文件读取字节数、关键词个数都有上限，保证只在会话开始时付一次小成本 ✓。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 一次最多列多少个命中的测试文件 */
export const DEFAULT_MAX_HITS = 12;
/** 最多用几个关键词去搜 */
export const MAX_TERMS = 8;
/** 单个测试文件最多读多少字节（大文件只读头部，够判命中） */
const MAX_BYTES_PER_FILE = 128 * 1024;
/** 扫描的测试文件数上限 */
const MAX_TEST_FILES = 4000;
/** 一个族最多记多少个成员名（够小族列全，又不至于爆） */
const MEMBERS_CAP = 30;
/** 成员数不超过这个值就**列全**（而不是只给几个例子） */
export const SMALL_CLUSTER_MAX = 25;

/** 只有工作区里的测试文件够多时，「命名分族」才有信息量（否则就是噪声 ✗） */
export const MIN_FILES_FOR_CLUSTERS = 50;

/** 把文本切成可比较的词元（小写、长度 ≥3 的字母数字片段；camelCase 会拆开） */
function tokenize(text: string): string[] {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x.length >= 3);
}

/** 跳过的目录（隐藏目录一律跳过：参考检出、快照、缓存都在这一类里） */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "coverage", "out", "vendor", "third_party"]);

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name);
}

/**
 * 从用户消息里抽"值得拿去搜仓库"的关键词。
 *
 * 三类（都来自赢家的做法 ✓）：
 * - **引号/书名号/反引号里的短语**（「写入确认」、`pendingWriteConfirms`）—— 刻意强调的 ✓；
 * - **中文短语**：先按常见虚词/助词切开，再保留 2–6 字的片段 ✓
 *   （第一版直接取 12 字连续汉字 ⇒ 抽出的是**整句**「你查一下哪里出的问题并修」⇒ 全仓库零命中 ✗）；
 * - **英文标识符**（≥4 字符，含 camelCase / 下划线）。
 *
 * 结果去重、长词优先，最多 {@link MAX_TERMS} 个。
 */
export function extractSearchTerms(message: string): string[] {
  const text = String(message ?? "");
  const terms = new Set<string>();

  // ① 引号/书名号里的短语
  for (const m of text.matchAll(/[「『“"']([^「」『』“”"'\n]{2,40})[」』”"']/g)) {
    const t = m[1].trim();
    if (t && t.length <= 20) terms.add(t);
  }
  // ② 反引号里的片段（代码标识符最常见）
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    const t = m[1].trim();
    if (t) terms.add(t);
  }
  // ③ 中文：**先切句再切词** —— 按虚词/助词/标点切开，保留 2–6 字的片段
  const CJK_SPLIT = /[的了是在和与及并而但却还只等如若为把被给对从到就也都很要会能可你我他她它这那些什么怎么吗呢吧啊哦嗯，。！？、；：（）《》【】\s]+/;
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,60}/g)) {
    for (const piece of m[0].split(CJK_SPLIT)) {
      if (piece.length >= 2 && piece.length <= 6) terms.add(piece);
    }
  }
  // ④ 英文标识符（≥4 字符；排除纯数字与常见噪声词）
  const stop = new Set(["this", "that", "with", "from", "have", "will", "test", "tests", "src", "code", "true", "false", "null", "error"]);
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,40}/g)) {
    const t = m[0];
    if (!stop.has(t.toLowerCase())) terms.add(t);
  }

  return [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/**
 * **测试文件命名簇**（第 98 波补，来自赢家的实际做法）。
 *
 * 观察到的关键一步：对照臂 `grep` 出一批命中后，**从命中里的文件名看出规律**
 * （"D8, D9, D10 waves…"），然后直接去读 `dsh-d9-*.test.ts` ✓。
 * 也就是说，真正有用的事实是"**这个仓库的测试文件按前缀分成哪些族**"，
 * 而不是"全部文件列表" ✗（4187 个文件里看不出任何结构 ✓）。
 */
export function summarizeNameClusters(
  files: string[],
  query = "",
  top = 12,
): { prefix: string; count: number; examples: string[]; members: string[]; relevance: number }[] {
  const buckets = new Map<string, { count: number; examples: string[]; members: string[] }>();
  for (const f of files) {
    const base = (f.split("/").pop() ?? f).replace(/\.(test|spec)\..*$/, "");
    /**
     * ⚠️ 只取**第一段**（第 98 波修正）：原来取"前两段"（`dsh-d9`），
     * 于是 `dsh-d9-…`、`dsh-d10-…` 各成一族、每族 1 个 ⇒ 被 count≥2 过滤掉 ✗，
     * 而**赢家看到的恰恰是"`dsh-*` 这一族"**（它从命中里认出 D8/D9/D10 的规律 ✓）。
     * 取第一段才能把这一族显出来 ✓。
     */
    const prefix = base.split(/[-_.]/).filter(Boolean)[0] ?? base;
    if (prefix.length < 2) continue;
    const cur = buckets.get(prefix);
    if (cur) {
      cur.count++;
      if (cur.examples.length < 3) cur.examples.push(f);
      if (cur.members.length < MEMBERS_CAP) cur.members.push(f);
    } else buckets.set(prefix, { count: 1, examples: [f], members: [f] });
  }
  /**
   * 排序依据（第 104 波修正）：**族内成员与任务文本的相关性**，而不是族的大小。
   * 实测：repo-03 的清单里明明有 `dsh-d6-usage-accounting`、`dsh-d7-usage-cache-buckets`，
   * 但 `dsh-*` 族被排在第三（前面是 25 个的 library-*、21 个的 tool-* ✗）⇒ 那次运行只碰了 d6、没碰 d7 ✗。
   */
  const queryTokens = new Set(tokenize(query));
  const relevanceOf = (members: string[]) => {
    if (queryTokens.size === 0) return 0;
    let score = 0;
    for (const m of members) {
      const nameTokens = new Set(tokenize(m.split("/").pop() ?? m));
      for (const tk of queryTokens) if (nameTokens.has(tk)) score += 1;
    }
    return score;
  };
  return [...buckets.entries()]
    .map(([prefix, v]) => ({
      prefix,
      count: v.count,
      examples: v.examples,
      members: [...v.members].sort(),
      relevance: relevanceOf(v.members),
    }))
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.relevance - a.relevance || b.count - a.count || a.prefix.localeCompare(b.prefix))
    .slice(0, top);
}

/** 收集工作区里的测试文件（相对路径，跳过隐藏/依赖/产物目录） */
function collectTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_TEST_FILES) return;
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_TEST_FILES) return;
      if (e.isDirectory()) {
        // 隐藏目录 + 依赖/产物目录一律跳过（参考检出就在隐藏目录里）
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && isTestFile(e.name)) {
        out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * **紧凑版"这一族判据"提醒**（第 109 波）——用在**第一次测试跑出红**的那一刻。
 *
 * ## 为什么需要它（证据）
 *
 * 第 108 波测出：**"有没有主动碰那条判据"对成败的预测力是 4/4** ✓（两任务两构建）。
 * 而 237 的 repo-02：run-2 **用了**清单（碰了 d9 ⇒ 通过 ✓）、run-3 **没用**（没碰 ⇒ 失败 ✗）——
 * 同一份清单、同一个构建，差别在**注意力**：完整清单只在会话第一条消息的尾部投递一次，
 * 到"该看判据"的时刻往往已过 20+ 次工具调用 ⇒ 被推远 ✗。
 *
 * ⇒ 在**需要它的时刻**（第一次跑出红）再放一次 ✓ —— 与 `[RED TEST]` 指针同一手法 ✓。
 * 仍然是**只陈述事实**：列的是这个工作区里 `xxx-*` 族的判据文件，**不做"你没碰过"这种判断** ✗。
 */
export function buildFamilyReminder(root: string, message: string, maxFamilies = 4): string | null {
  const files = collectTestFiles(root);
  if (files.length < MIN_FILES_FOR_CLUSTERS) return null; // 小仓库里这段就是噪声
  const clusters = summarizeNameClusters(files, message, maxFamilies);
  if (clusters.length === 0) return null;
  const lines = clusters.map((c) =>
    c.count <= SMALL_CLUSTER_MAX
      ? `- ${c.prefix}-*（${c.count} 个）：${c.members.map((m) => m.split("/").pop()).join("、")}`
      : `- ${c.prefix}-*：${c.count} 个（例如 ${c.examples.map((m) => m.split("/").pop()).join("、")}）`,
  );
  return [
    `[判据族提醒] 这个工作区的测试文件按名字分成若干族，与本次任务词面相近的几族如下：`,
    ...lines,
    `（只是事实清单；某条判据要求什么，用 read 打开看。）`,
  ].join("\n");
}

/**
 * 生成"任务关键词在测试文件里的命中"清单；没有任何命中时返回 `null`。
 *
 * @param root     工作区根目录
 * @param message  用户消息（抽关键词的来源）
 * @param maxHits  最多列多少个命中文件
 */
export function buildTaskSearchNotice(root: string, message: string, maxHits = DEFAULT_MAX_HITS): string | null {
  const terms = extractSearchTerms(message);
  if (terms.length === 0) return null;

  const files = collectTestFiles(root);
  if (files.length === 0) return null;

  /**
   * **先算每个词的"文档频率"（出现在多少个测试文件里）**（第 98 波）。
   *
   * 为什么要：第一版按命中次数排序，结果 `agent` 这种**到处都是的泛词**（单文件 61 处命中）
   * 把真正的信号全压掉了 ✗。泛词的信息量为零 —— 出现在 40% 测试文件里的词，
   * 恰好说明它跟这次任务无关 ✓。所以：**丢掉过泛的词**（df 超过 20 个文件或 5%），
   * 只用剩下的"具体词"来排序 ✓。
   */
  const fileTexts = new Map<string, string>();
  for (const file of files) {
    try {
      const full = join(root, file);
      const text = statSync(full).size > MAX_BYTES_PER_FILE ? readFileSync(full, "utf8").slice(0, MAX_BYTES_PER_FILE) : readFileSync(full, "utf8");
      fileTexts.set(file, text);
    } catch {
      // 读不动就跳过
    }
  }
  const docFreq = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const text of fileTexts.values()) if (text.includes(term)) df++;
    docFreq.set(term, df);
  }
  const dfLimit = Math.max(20, Math.floor(files.length * 0.05));
  const usefulTerms = terms.filter((t) => (docFreq.get(t) ?? 0) <= dfLimit);
  if (usefulTerms.length === 0) {
    /**
     * 所有词都太泛 ⇒ 关键词这条线索没有信息量。
     * 此时**只有工作区足够大**才值得给「命名分族」（小仓库里塞这段就是噪声 ✗）。
     */
    return files.length >= MIN_FILES_FOR_CLUSTERS ? buildNotice([], files) : null;
  }

  const hits: { file: string; count: number; matched: string[] }[] = [];
  for (const [file, text] of fileTexts) {
    let count = 0;
    const matched: string[] = [];
    for (const term of usefulTerms) {
      const occurrences = text.split(term).length - 1;
      if (occurrences > 0) {
        count += occurrences;
        matched.push(term);
      }
    }
    if (count > 0) hits.push({ file, count, matched });
  }

  if (hits.length === 0 && files.length < MIN_FILES_FOR_CLUSTERS) return null;
  return buildNotice(hits, files, usefulTerms.length < terms.length ? terms.length - usefulTerms.length : 0, message);
}

/** 组装最终消息（关键词命中 + 命名簇；都只陈述事实） */
function buildNotice(
  hits: { file: string; count: number; matched: string[] }[],
  files: string[],
  droppedGeneric = 0,
  query = "",
  maxHits = DEFAULT_MAX_HITS,
): string | null {
  hits.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  const listed = hits.slice(0, maxHits);
  const lines = listed.map((h) => `- ${h.file}（${h.count} 处命中：${h.matched.slice(0, 3).join("、")}${h.matched.length > 3 ? " 等" : ""}）`).join("\n");
  const more =
    hits.length > listed.length
      ? `（上面只列了命中最多的 ${listed.length} 个；一共 ${hits.length} 个测试文件命中。）`
      : `（一共 ${hits.length} 个测试文件命中。）`;

  /** 命名簇：赢家正是从"文件名成族"这件事里看出规律的 */
  const clusters = summarizeNameClusters(files, query);
  const clusterLines = clusters.length
    ? [
        `这个工作区有 ${files.length} 个测试文件，按名字开头分成这些族（≥2 个的）：`,
        ...clusters.map((c) =>
          c.count <= SMALL_CLUSTER_MAX
            ? `- ${c.prefix}-*（${c.count} 个）：${c.members.map((m) => m.split("/").pop()).join("、")}`
            : `- ${c.prefix}-*：${c.count} 个（例如 ${c.examples.join("、")}）`,
        ),
      ].join("\n")
    : "";

  /** 措辞纪律：只陈述事实，不评价、不命令（判据 TSN-5 会扫这些词） */
  const head = hits.length
    ? `[任务关键词命中] 用你这条消息里的词在**测试文件**里搜了一遍，命中如下（按命中次数排序）：${
        droppedGeneric > 0 ? `（已忽略 ${droppedGeneric} 个过于常见的词，它们对定位没有帮助）` : ""
      }`
    : `[任务关键词命中] 你这条消息里的词在测试文件里没有有效命中（太常见的词已忽略）。下面是这个工作区测试文件的**命名分族**，供你判断该看哪一类：`;

  return [head, lines, hits.length ? more : "", clusterLines, `这只是搜索结果；具体某条判据要求什么，用 read 打开对应文件看。`]
    .filter(Boolean)
    .join("\n");
}
