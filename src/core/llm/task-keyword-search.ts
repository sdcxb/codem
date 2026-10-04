/**
 * **拿任务里的词搜仓库 + 给出测试文件命名分族**（第 98–114 波）。
 *
 * ## ⚠️ 第 114 波的关键修正：这里**不许**用 `node:fs`
 *
 * `vite.config.ts` 把前端的 `fs` alias 到 `src/stubs/node-fs-stub.ts`，
 * 而那个桩**不访问磁盘**（`readdirSync` 恒 `[]`、`readFileSync` 恒 `""`）✗。
 * 本模块第一版用了 `node:fs` ⇒ **在装机版里静默失效**，
 * 于是 1.16.236 / 237 / 238 三个版本里"关键词清单"与"族提醒"**一次都没生效** ✗，
 * 而所有判据全绿（Vitest 跑在 Node 里，`node:fs` 是真的 ✗）。
 *
 * 现在所有文件访问都走注入的 {@link TestFileSource}：
 * - **装机版**默认用 `core/file-api.ts` 的 IPC 接口（`listDirectory` / `readFile`）✓；
 * - **判据**注入一个真实的 Node fs 实现（`src/test/helpers/node-fs-source.ts`）✓。
 *
 * 门禁：`src/test/no-node-fs-in-llm.test.ts`（FSG-1）钉住"`src/core/llm` 生产文件不许 import node:fs" ✓。
 *
 * ## 机制内容（哪些是"只陈述事实"）
 *
 * - {@link buildTaskSearchNotice}：用用户消息里的词在**测试文件**里搜，列出命中最多的；
 *   过泛的词按**文档频率**剔除（第一版被 `agent` 这种到处都是的词压掉全部信号 ✗）；
 *   有命中就先给命中清单，再给**命名分族**（小族列全成员 ✓ —— 对手赢的那次正是**直接看到文件名** ✓）。
 * - {@link buildFamilyReminder}：紧凑版，用在**第一次测试跑出红**的那一刻再放一次
 *   （证据：完整清单只在会话第一条消息尾部投递一次，20+ 次工具调用后已被推远 ✗）。
 *
 * 两条都**只陈述事实**：不写"你应该跑哪些""你漏了哪些"这类判断 ✓。
 */

/** 目录项（与 `core/file-api.ts` 的 `listDirectory` 返回形状对齐） */
export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * 文件访问的抽象（第 114 波）——**本模块唯一的 I/O 出口**。
 * 装机版用 IPC，判据用真实 Node fs；`node:fs` 不在这里出现 ✗（否则门禁 FSG-1 会红）。
 */
export interface TestFileSource {
  list(dir: string): Promise<DirEntry[]>;
  /** 读文件；`maxBytes` 给定时只读开头那么多字节（够判命中即可） */
  read(path: string, maxBytes?: number): Promise<string>;
}

/**
 * 内容搜索接口（第 124 波）——**用应用自己的 grep**（`core/file-api.ts` 的 `grepSearch` ✓，
 * 与 `grep` 工具同一条 IPC ✓）。
 *
 * 为什么需要它（会话级证据）：对照臂赢的那次 repo-02 靠一次**全仓库符号 grep**
 * （"Found 117 matches"）在匹配清单里**同时看到源码与测试文件**，才直接找到
 * `dsh-d9-multi-edit-partial-failure.test.ts` ✓；而我的清单只搜测试文件 ✗，
 * 偏偏这个任务的原词在测试文件里零命中 ✗ ⇒ 命中段为空 ⇒ 帮不上 ✗。
 */
export type SearchLike = (pattern: string, root: string) => Promise<string[]>;

/** 装机版默认实现：走 `core/file-api.ts`（Tauri IPC），**不是** node:fs ✓ */
export function createIpcFileSource(): TestFileSource {
  return {
    async list(dir: string): Promise<DirEntry[]> {
      const { listDirectory } = await import("../file-api");
      const entries = await listDirectory(dir);
      return entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: Boolean((e as { isDirectory?: boolean }).isDirectory),
      }));
    },
    async read(path: string, maxBytes?: number): Promise<string> {
      const api = await import("../file-api");
      if (maxBytes && typeof api.readTextWindow === "function") {
        try {
          const win = await api.readTextWindow(path, 0, maxBytes);
          return String((win as { text?: string })?.text ?? "");
        } catch {
          // 窗口读失败就退回整读（下面统一截断）
        }
      }
      const text = await api.readFile(path);
      return maxBytes ? text.slice(0, maxBytes) : text;
    },
  };
}

/** 装机版默认搜索实现：走 `grepSearch`（IPC ✓） */
export function createIpcSearcher(): SearchLike {
  return async (pattern: string, root: string) => {
    const { grepSearch } = await import("../file-api");
    return grepSearch(pattern, root);
  };
}

/** 一次最多列多少个命中的测试文件 */
export const DEFAULT_MAX_HITS = 12;
/** 最多用几个关键词去搜 */
export const MAX_TERMS = 60;
/** 单个测试文件最多读多少字节（大文件只读头部，够判命中） */
const MAX_BYTES_PER_FILE = 128 * 1024;
/** 扫描的测试文件数上限 */
const MAX_TEST_FILES = 4000;
/** 递归深度上限 */
const MAX_DEPTH = 12;
/**
 * 只有工作区里的测试文件够多时，「命名分族」才有信息量（否则就是噪声 ✗）。
 */
export const MIN_FILES_FOR_CLUSTERS = 50;
/** 一个族最多记多少个成员名（够小族列全，又不至于爆） */
const MEMBERS_CAP = 30;
/** 成员数不超过这个值就**列全**（而不是只给几个例子） */
export const SMALL_CLUSTER_MAX = 25;

/** 跳过的目录（隐藏目录一律跳过：参考检出、快照、缓存都在这一类里） */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "coverage", "out", "vendor", "third_party"]);

/** 把文本切成可比较的词元（小写、长度 ≥3 的字母数字片段；camelCase 会拆开） */
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x.length >= 3);
}

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name);
}

/**
 * 收集工作区里的测试文件（相对路径，跳过隐藏/依赖/产物目录）。
 *
 * ⚠️ **async**：第 114 波之后所有 I/O 都走 {@link TestFileSource}（装机版是 IPC）✓。
 */
export async function collectTestFiles(root: string, src: TestFileSource = createIpcFileSource()): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_TEST_FILES) return;
    let entries: DirEntry[];
    try {
      entries = await src.list(dir);
    } catch {
      return; // 读不动的目录（权限/竞态）直接跳过，别让清单构建把会话搞崩
    }
    for (const entry of entries) {
      if (out.length >= MAX_TEST_FILES) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(entry.path, rel, depth + 1);
      } else if (isTestFile(entry.name)) {
        out.push(rel);
      }
    }
  };
  await walk(root, "", 0);
  return out;
}

/**
 * 从用户消息里抽"值得拿去搜仓库"的关键词。
 *
 * 三类（都来自赢家的做法 ✓）：
 * - **引号/书名号/反引号里的短语**（「写入确认」、`pendingWriteConfirms`）；
 * - **中文短语**：先按常见虚词/助词切开，再保留 2–6 字的片段 ✓
 *   （第一版直接取 12 字连续汉字 ⇒ 抽出的是**整句**「你查一下哪里出的问题并修」⇒ 全仓库零命中 ✗）；
 * - **英文标识符**（≥4 字符，含 camelCase / 下划线）。
 */
export function extractSearchTerms(message: string): string[] {
  const text = String(message ?? "");
  const terms = new Set<string>();

  for (const m of text.matchAll(/[「『“"']([^「」『』“”"'\n]{2,40})[」』”"']/g)) {
    const t = m[1].trim();
    if (t && t.length <= 20) terms.add(t);
  }
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    const t = m[1].trim();
    if (t) terms.add(t);
  }
  const CJK_SPLIT = /[的了是在和与及并而但却还只等如若为把被给对从到就也都很要会能可你我他她它这那些什么怎么吗呢吧啊哦嗯，。！？、；：（）《》【】\s]+/;
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,60}/g)) {
    for (const piece of m[0].split(CJK_SPLIT)) {
      if (piece.length >= 2 && piece.length <= 6) terms.add(piece);
    }
  }
  /**
   * **中文整句补子串**（第 124 波）——真实工作区实测逼出来的 ✓：
   *
   * 抽出来的词原来都是整句（「按我的一次性要求改」「写入确认里选」…）✗ ⇒ 在仓库里**逐条 0 命中** ✗
   * ⇒ 新加的"源码命中"一节是空的 ✗。而对照臂赢的那次真正 grep 的是
   * **「一次性要求」「写入确认」** ✓ —— 都是那些整句的**子串** ✓。
   *
   * 所以对长度为 4 以上的中文片段，再补 3–5 字的子串 ✓（有界：每个片段最多补 18 个 ✓）。
   * 这样"整句零命中、子串有命中"的形状就能被覆盖 ✓。
   */
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{4,60}/g)) {
    const run = m[0];
    let added = 0;
    for (let len = 5; len >= 3 && added < 18; len--) {
      for (let i = 0; i + len <= run.length && added < 18; i++) {
        const sub = run.slice(i, i + len);
        if (!terms.has(sub)) {
          terms.add(sub);
          added++;
        }
      }
    }
  }

  const stop = new Set(["this", "that", "with", "from", "have", "will", "test", "tests", "src", "code", "true", "false", "null", "error"]);
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,40}/g)) {
    const t = m[0];
    if (!stop.has(t.toLowerCase())) terms.add(t);
  }

  return [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/**
 * **测试文件命名簇**：按名字开头分族。
 *
 * 之所以有用：对照臂（DSH）在 `repo-02` 上通过的那次会话，正是从 grep 命中的**文件名**里
 * 看出 `dsh-dN-*` 这个族，然后直接去读 `dsh-d9-multi-edit-partial-failure.test.ts` ✓。
 *
 * 排序依据是**族内成员与任务文本的相关性**（不按族的大小 —— repo-03 实测里，
 * 相关的 `dsh-*` 被 25 个无关的 `library-*` 压在后面 ✗）。
 */
export function summarizeNameClusters(
  files: string[],
  query = "",
  top = 12,
): { prefix: string; count: number; examples: string[]; members: string[]; relevance: number }[] {
  const buckets = new Map<string, { count: number; examples: string[]; members: string[] }>();
  for (const f of files) {
    const base = (f.split("/").pop() ?? f).replace(/\.(test|spec)\..*$/, "");
    const prefix = base.split(/[-_.]/).filter(Boolean)[0] ?? base;
    if (prefix.length < 2) continue;
    const cur = buckets.get(prefix);
    if (cur) {
      cur.count++;
      if (cur.examples.length < 3) cur.examples.push(f);
      if (cur.members.length < MEMBERS_CAP) cur.members.push(f);
    } else {
      buckets.set(prefix, { count: 1, examples: [f], members: [f] });
    }
  }
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

/**
 * 这一族**实际所在的目录**（用于拼"可以一起跑"的命令）。
 * 取成员路径的公共目录 —— 例如 `src/test/dsh-d1-x.test.ts` ⇒ `src/test` ✓。
 */
function familyDir(members: string[]): string {
  const dirs = members.map((m) => {
    const parts = m.replace(/\\/g, "/").split("/");
    parts.pop();
    return parts.join("/");
  });
  if (dirs.length === 0) return "";
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * 渲染一族（小族列全成员；大族给例子）**并给出"这一族可以一起跑"的命令** ✓。
 *
 * ## 为什么必须给这条命令（第 121 波，依据是一次被证伪）
 *
 * 243 的读数：机制确认已送达 ✓（清单 5536 字符、逐字含 `dsh-d9`、RED TEST 指针开过 2 次 ✓），
 * 但 `repo-02` 两轮**都只碰 `dsh-d10`** ✗、从没碰被判分的 `dsh-d9` ✗ ⇒ 主判据被违反 ✗。
 * ⇒ **"把判据名送到眼前"不够** ✗：模型会挑字面最像的那一条就收工 ✗。
 *
 * 所以补一条**关于仓库的事实** ✓：这一族可以用一条命令一起跑 ✓。
 * 它**不替模型做事**（跑不跑、跑完怎么改，仍是它的判断 ✓ ——
 * 与"自动替它跑那一族"有本质区别 ✗，那条已被排除 ✓）；
 * 它**不判断**（无"你应该/你漏了" ✗）；它**对通过与不通过一视同仁** ✓
 * （同一条事实任何时候都成立 ✓ ⇒ 不会重蹈 `c7feb4a` 的选择性偏见 ✗）。
 *
 * ⚠️ 每个渲染出来的族都给命令 ✓（不能只给排在第一个的族 ✗ ——
 * 中文任务描述与英文文件名零重叠时，排序退化成"按族大小" ✗，
 * 而 `repo-02` 的目标族 `dsh-*` 恰好排在第三 ✗）。
 */
function renderCluster(c: { prefix: string; count: number; examples: string[]; members: string[] }): string {
  const short = (p: string) => p.split("/").pop();
  const line =
    c.count <= SMALL_CLUSTER_MAX
      ? `- ${c.prefix}-*（${c.count} 个）：${c.members.map(short).join("、")}`
      : `- ${c.prefix}-*：${c.count} 个（例如 ${c.examples.map(short).join("、")}）`;
  const dir = familyDir(c.members);
  const cmd = dir ? `npx vitest run ${dir}/${c.prefix}-*.test.ts` : "";
  return cmd ? `${line}\n  这一族可以一起跑：${cmd}` : line;
}

/** 组装最终消息（关键词命中 + 命名分族；都只陈述事实） */
function buildNotice(
  hits: { file: string; count: number; matched: string[] }[],
  files: string[],
  query: string,
  droppedGeneric = 0,
  maxHits = DEFAULT_MAX_HITS,
  sourceHits: string[] = [],
): string | null {
  hits.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  const listed = hits.slice(0, maxHits);
  const lines = listed
    .map((h) => `- ${h.file}（${h.count} 处命中：${h.matched.slice(0, 3).join("、")}${h.matched.length > 3 ? " 等" : ""}）`)
    .join("\n");
  const more =
    hits.length > listed.length
      ? `（上面只列了命中最多的 ${listed.length} 个；一共 ${hits.length} 个测试文件命中。）`
      : `（一共 ${hits.length} 个测试文件命中。）`;

  const clusters = summarizeNameClusters(files, query);
  const clusterLines = clusters.length
    ? [`这个工作区有 ${files.length} 个测试文件，按名字开头分成这些族（≥2 个的）：`, ...clusters.map(renderCluster)].join("\n")
    : "";

  /** 措辞纪律：只陈述事实，不评价、不命令（判据 TSN-5 会扫这些词） */
  const head = hits.length
    ? `[任务关键词命中] 用你这条消息里的词在**测试文件**里搜了一遍，命中如下（按命中次数排序）：${
        droppedGeneric > 0 ? `（已忽略 ${droppedGeneric} 个过于常见的词，它们对定位没有帮助）` : ""
      }`
    : `[任务关键词命中] 你这条消息里的词在测试文件里没有有效命中（太常见的词已忽略）。下面是这个工作区测试文件的**命名分族**，供你判断该看哪一类：`;

  /**
   * **源码命中**一节（第 124 波）：只陈述事实（哪些实现文件里有这些词 ✓），
   * 并明说"这些是源码、不是判据" ✓ —— 不判断、不命令 ✓。
   */
  const sourceSection = sourceHits.length
    ? [`[源码命中] 同样这些词在**源码/实现文件**里命中的位置（供你定位实现，不是判据）：`, ...sourceHits.map((s) => `- ${s}`)].join("\n")
    : "";

  return [head, lines, hits.length ? more : "", sourceSection, clusterLines, `这只是搜索结果；具体某条判据要求什么，用 read 打开对应文件看。`]
    .filter(Boolean)
    .join("\n");
}

/**
 * 生成"任务关键词在测试文件里的命中"清单；没有任何有效内容时返回 `null`。
 *
 * @param root     工作区根目录
 * @param message  用户消息（抽关键词的来源）
 * @param opts.src 文件访问实现（装机版默认走 IPC ✓；判据注入真实 Node fs ✓）
 */
export async function buildTaskSearchNotice(
  root: string,
  message: string,
  opts: { src?: TestFileSource; maxHits?: number; search?: SearchLike } = {},
): Promise<string | null> {
  const src = opts.src ?? createIpcFileSource();
  const terms = extractSearchTerms(message);
  if (terms.length === 0) return null;

  const files = await collectTestFiles(root, src);
  if (files.length === 0) return null;

  const fileTexts = new Map<string, string>();
  for (const file of files) {
    try {
      fileTexts.set(file, await src.read(`${root}/${file}`, MAX_BYTES_PER_FILE));
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
    return files.length >= MIN_FILES_FOR_CLUSTERS ? buildNotice([], files, message) : null;
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

  /**
   * **补一节源码命中**（第 124 波）：拿同样几个词去问应用自己的 grep ✓。
   * 只取前 3 个词、最多 8 条、剔除测试文件（测试命中已在上一节 ✓）——控制体量与噪声 ✓。
   */
  let sourceHits: string[] = [];
  try {
    const search = opts.search ?? createIpcSearcher();
    const found: string[] = [];
    for (const term of usefulTerms.slice(0, 15)) {
      const rows = await search(term, root);
      for (const row of rows) found.push(row);
      /** 够了就停：每个词一次 IPC，别把会话开头拖长 ✓（第 124 波） */
      if (found.filter((r) => !isTestFile(String(r))).length >= 8) break;
    }
    const seen = new Set<string>();
    for (const row of found) {
      const file = String(row).replace(/\\/g, "/").split(":")[0];
      if (!file || isTestFile(file)) continue;
      const key = file;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceHits.push(String(row).slice(0, 160));
      if (sourceHits.length >= 8) break;
    }
  } catch {
    // 搜不动就不给这一节（非关键路径 ✓）
  }

  if (hits.length === 0 && sourceHits.length === 0 && files.length < MIN_FILES_FOR_CLUSTERS) return null;
  return buildNotice(hits, files, message, terms.length - usefulTerms.length, opts.maxHits, sourceHits);
}

/**
 * **紧凑版"这一族判据"提醒** —— 用在**第一次测试跑出红**的那一刻（第 109 波）。
 *
 * 证据：完整清单只在会话第一条消息尾部投递一次，到"该看判据"的时刻往往已过
 * 20+ 次工具调用 ⇒ 被推远 ✗。所以在此刻（它正盯着失败输出）再放一次；
 * 仍然**只陈述事实**（列的是文件名，不做"你没碰过"这种判断 ✗）。
 */
export async function buildFamilyReminder(
  root: string,
  message: string,
  opts: { src?: TestFileSource; maxFamilies?: number } = {},
): Promise<string | null> {
  const src = opts.src ?? createIpcFileSource();
  const files = await collectTestFiles(root, src);
  if (files.length < MIN_FILES_FOR_CLUSTERS) return null; // 小仓库里这段就是噪声
  const clusters = summarizeNameClusters(files, message, opts.maxFamilies ?? 4);
  if (clusters.length === 0) return null;
  return [
    `[判据族提醒] 这个工作区的测试文件按名字分成若干族，与本次任务词面相近的几族如下：`,
    ...clusters.map(renderCluster),
    `（只是事实清单；某条判据要求什么，用 read 打开看。）`,
  ].join("\n");
}


/**
 * 从源码里抽"可拿去 grep 的符号"（第 125 波）——标识符 ≥8 字符，剔除语言关键字 ✓。
 *
 * 为什么是 ≥8：真实仓库里 3–7 字符的标识符（`result`/`target`/`payload`）（`data`/`result`/`value`）到处都是 ✓，
 * grep 它们只会把整个仓库倒出来 ✗；而 `applyToolResultStatus`/`classifyToolResult` 这种
 * 一搜就是几十条、条条相关 ✓（对照臂赢的那次正是这么搜的 ✓）。
 */
export function extractSymbols(source: string, max = 8): string[] {
  const KEYWORDS = new Set([
    "function", "return", "const", "export", "import", "interface", "extends", "implements",
    "public", "private", "protected", "readonly", "number", "string", "boolean", "object",
    "default", "unknown", "never", "async", "await", "yield", "typeof", "instanceof",
    "constructor", "undefined", "require", "console",
  ]);
  const seen = new Set<string>();
  for (const m of String(source ?? "").matchAll(/\b[A-Za-z_][A-Za-z0-9_]{7,40}\b/g)) {
    const s = m[0];
    if (KEYWORDS.has(s)) continue;
    seen.add(s);
  }
  return [...seen].sort((a, b) => b.length - a.length).slice(0, max);
}

/**
 * **"你刚改的符号，还有哪些判据文件提到"**（第 125 波）——见判据文件顶部的长注释。
 *
 * 返回 null 表示「没有任何测试文件提到这些符号」⇒ **什么都不追加** ✓（不留噪声 ✓）。
 */
export async function buildSymbolSiblings(
  root: string,
  editedRelativePath: string,
  opts: { src?: TestFileSource; search?: SearchLike; maxFiles?: number } = {},
): Promise<string | null> {
  const src = opts.src ?? createIpcFileSource();
  if (isTestFile(editedRelativePath)) return null; // 改的是测试文件 ⇒ 不用提 ✓
  let text = "";
  try {
    text = await src.read(`${root}/${editedRelativePath}`, MAX_BYTES_PER_FILE);
  } catch {
    return null;
  }
  const symbols = extractSymbols(text, 5);
  if (symbols.length === 0) return null;

  const search = opts.search ?? createIpcSearcher();
  const found: string[] = [];
  for (const sym of symbols.slice(0, 3)) {
    let rows: string[] = [];
    try {
      rows = await search(sym, root);
    } catch {
      continue;
    }
    for (const row of rows) {
      const file = String(row).replace(/\\/g, "/").split(":")[0];
      if (!file || !isTestFile(file)) continue; // 只列判据（测试）文件 ✓
      if (file.includes(editedRelativePath)) continue;
      if (!found.includes(file)) found.push(file);
      if (found.length >= (opts.maxFiles ?? 6)) break;
    }
    if (found.length >= (opts.maxFiles ?? 6)) break;
  }
  if (found.length === 0) return null;

  return [
    `[同族判据] 你刚改的 ${editedRelativePath} 里有这些符号（${symbols.slice(0, 3).join("、")}），`,
    `下列**测试/判据**文件也提到它们（只是列出事实 ✓）：`,
    ...found.map((f) => `- ${f}`),
  ].join("\n");
}
