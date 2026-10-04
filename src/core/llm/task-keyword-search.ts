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

/** 一次最多列多少个命中的测试文件 */
export const DEFAULT_MAX_HITS = 12;
/** 最多用几个关键词去搜 */
export const MAX_TERMS = 8;
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

/** 渲染一族（小族列全成员；大族给例子） */
function renderCluster(c: { prefix: string; count: number; examples: string[]; members: string[] }): string {
  const short = (p: string) => p.split("/").pop();
  return c.count <= SMALL_CLUSTER_MAX
    ? `- ${c.prefix}-*（${c.count} 个）：${c.members.map(short).join("、")}`
    : `- ${c.prefix}-*：${c.count} 个（例如 ${c.examples.map(short).join("、")}）`;
}

/** 组装最终消息（关键词命中 + 命名分族；都只陈述事实） */
function buildNotice(
  hits: { file: string; count: number; matched: string[] }[],
  files: string[],
  query: string,
  droppedGeneric = 0,
  maxHits = DEFAULT_MAX_HITS,
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

  return [head, lines, hits.length ? more : "", clusterLines, `这只是搜索结果；具体某条判据要求什么，用 read 打开对应文件看。`]
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
  opts: { src?: TestFileSource; maxHits?: number } = {},
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

  if (hits.length === 0 && files.length < MIN_FILES_FOR_CLUSTERS) return null;
  return buildNotice(hits, files, message, terms.length - usefulTerms.length, opts.maxHits);
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
