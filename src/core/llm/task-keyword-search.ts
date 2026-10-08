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
export type SearchLike = (pattern: string, root: string, include?: string | string[]) => Promise<string[]>;

/**
 * ★ 第 43 波：**"只可能是判据"的文件名过滤** ✓ —— 一处定义、用在"只认测试文件"的那条链上 ✓。
 *
 * ## 为什么（**量出来的 ✓**）
 *
 * 收尾检查与回合内提示**只认测试文件** ✓（`isTestFile` ✓：`*.test.*` / `*.spec.*` ✓），
 * 而它们的搜索是 `Get-ChildItem -Recurse -File | Select-String <符号>` ✓ —— **把整个工作区扫一遍** ✗。
 *
 * 实测（`src` 树 1767 个文件 ⇒ 550 个 ✓）：单次搜索 **0.55s ⇒ 0.18s** ✓；
 * 而真机侧车里一次编辑会**连发 6 次**搜索（`tools.ts` 读到 85138 字符、抽出 12 个符号 ✓，
 * 命中前不收手 ✓）⇒ **≈10s ⇒ ≈3s** ✓（`.preview-shot/_tool-durations.mjs` 量的 edit 类批 ✓）。
 *
 * ⚠️ **两条都算** ✓：只给 `*test*` 会**漏掉 `*.spec.ts`** ✗（而 `isTestFile` 是认 spec 的 ✓）。
 */
const TEST_FILE_INCLUDE: string[] = ["*test*", "*spec*"];

/**
 * ★ 第 44 波：**判据可能住在哪** ✓ —— 只遍历这几个目录，而不是整棵树 ✓。
 *
 * ## 为什么（**上一版没吃到的那一口 ✓**）
 *
 * 第 43 波给搜索加了 `-Include '*test*','*spec*'` ✓，真机侧车确认它**生效了** ✓（命令行逐字可见 ✓）——
 * 但一批 edit 仍然 8 s ✗。原因：**`-Include` 只过滤"输出"，`Get-ChildItem -Recurse` 照样遍历整棵树** ✗。
 * 同一台机器、同一个工作区实测 ✓：
 * ```
 * 全树 + -Include     2.35s
 * 只 src/test         0.06s      ⇒ ★ 40×
 * ```
 * ⇒ 真正的着力点是**遍历范围** ✓。本仓布局：**536 条判据里 535 条在 `src/test/`** ✓、
 * 另 1 条在 `tests/` ✓；没有 `test/` 与 `__tests__/` ✓。
 *
 * ⚠️ **找不到任何判据目录时回退到工作区根** ✓（不认识的项目布局照旧能搜 ✓，只是慢 ✓ ——
 * 宁可慢也不许**假否定** ✗：那会让"同族判据"静默变成"没有同族判据" ✗）。
 */
const TEST_DIR_CANDIDATES: Array<{ parent?: string; name: string }> = [
  { parent: "src", name: "test" },
  { name: "test" },
  { name: "tests" },
  { name: "__tests__" },
];

/** 解析出**实际存在**的判据目录（去重、保序 ✓）；一个都没有 ⇒ 回退工作区根 ✓ */
async function resolveTestRoots(root: string, src: TestFileSource): Promise<string[]> {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dirsOf = async (dir: string): Promise<string[]> => {
    try {
      return (await src.list(dir)).filter((e) => e.isDirectory).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const rootDirs = await dirsOf(base);
  const srcDirs = rootDirs.includes("src") ? await dirsOf(`${base}/src`) : [];
  const out: string[] = [];
  for (const cand of TEST_DIR_CANDIDATES) {
    const present = cand.parent ? (cand.parent === "src" ? srcDirs : []) : rootDirs;
    if (!present.includes(cand.name)) continue;
    const abs = cand.parent ? `${base}/${cand.parent}/${cand.name}` : `${base}/${cand.name}`;
    if (!out.includes(abs)) out.push(abs);
  }
  return out.length ? out : [base];
}

/** 装机版默认实现：走 `core/file-api.ts`（Tauri IPC），**不是** node:fs ✓ */
/**
 * ★ 第 185 波（复审 R1-4/I-2）：**必须把工作区传进读侧沙箱**。
 *
 * `readFile` / `readTextWindow` / `grepSearch` 的读侧判定是
 * 「`workspace` 未给 ⇒ 不做判定」（`file-api.ts:68`）。改前这里的三处调用
 * （`:142` `readFile(path)`、`:136` `readTextWindow(...)`、`:160` `grepSearch(...)`）
 * 都**不传** ⇒ 声明要沙箱、实际整条失效：同一路径 `read` 工具被拒，这条内部搜索读得到。
 * 现在工作区由各入口的 `root`（= 会话工作区）显式传下来。
 */
function createIpcFileSource(workspace?: string): TestFileSource {
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
          const win = await api.readTextWindow(path, 0, maxBytes, { workspace });
          return String((win as { text?: string })?.text ?? "");
        } catch {
          // 窗口读失败就退回整读（下面统一截断）
        }
      }
      const text = await api.readFile(path, { workspace });
      return maxBytes ? text.slice(0, maxBytes) : text;
    },
  };
}

/** 装机版默认搜索实现：走 `grepSearch`（IPC ✓） */
/**
 * 装机版默认搜索实现：走 `grepSearch`（IPC ✓）。
 *
 * ⚠️ `include` **由调用点传进来** ✓（不是在这里烘焙 ✓）—— 见 `searchSiblingCriteriaFiles` 里的
 * `search(sym, root, TEST_FILE_INCLUDE)` ✓：**"只扫判据文件"这条策略属于调用点** ✓，
 * 而这个工厂只负责转发 ✓（判据 `SYM-1` 就是靠"注入的搜索器能不能看见 include"来钉这件事 ✓ ——
 * 烘焙在工厂里的话，注入式判据**看不见**它 ✗，那就成了"判据绿、策略却没生效" ✓）。
 */
function createIpcSearcher(workspace?: string): SearchLike {
  return async (pattern: string, root: string, include?: string | string[]) => {
    const { grepSearch } = await import("../file-api");
    // ★ 第 185 波（复审 R1-4/I-2）：`workspace` 一并交给读侧沙箱（理由见 createIpcFileSource）。
    return grepSearch(pattern, root, include, { workspace });
  };
}

/** 一次最多列多少个命中的测试文件 */
const DEFAULT_MAX_HITS = 12;
/** 最多用几个关键词去搜 */
const MAX_TERMS = 60;
/** 单个测试文件最多读多少字节（大文件只读头部，够判命中） */
const MAX_BYTES_PER_FILE = 128 * 1024;
/** 扫描的测试文件数上限 */
const MAX_TEST_FILES = 4000;
/** 递归深度上限 */
const MAX_DEPTH = 12;
/**
 * 只有工作区里的测试文件够多时，「命名分族」才有信息量（否则就是噪声 ✗）。
 */
const MIN_FILES_FOR_CLUSTERS = 50;
/** 一个族最多记多少个成员名（够小族列全，又不至于爆） */
const MEMBERS_CAP = 30;
/** 成员数不超过这个值就**列全**（而不是只给几个例子） */
const SMALL_CLUSTER_MAX = 25;

/** 跳过的目录（隐藏目录一律跳过：参考检出、快照、缓存都在这一类里） */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "coverage", "out", "vendor", "third_party"]);

/** 把文本切成可比较的词元（小写、长度 ≥3 的字母数字片段；camelCase 会拆开） */
function tokenize(text: string): string[] {
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
async function collectTestFiles(root: string, src: TestFileSource = createIpcFileSource(root)): Promise<string[]> {
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
function summarizeNameClusters(
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
/**
 * **从 grep 命中行里取文件路径**（第 133 波，修一个"真机上机制从不产出"的根因 ✗）。
 *
 * `core/file-api.ts::grepSearch` 的 PowerShell 是
 * `$_.Path + ':' + $_.LineNumber + ':' + $_.Line` ✗ ⇒ 行是 **Windows 绝对路径**：
 * `C:\…\src\test\x.test.ts:12: …` ✓。
 * 原来用 `split(":")[0]` 取路径 ✗ ⇒ 在 Windows 上得到 **`C`** ✗ ⇒ 测试文件过滤全落空 ✗
 * ⇒ 函数**永远返回 null** ✗。而判据侧的 helper（`node-grep-source.ts`）返回**相对路径** ✓
 * ⇒ 判据全绿、真机全空 ✗ —— 与 113/114 波同一类「夹具与现实不一致」✓。
 *
 * 现在按 `:行号:` 切 ✓（盘符里的冒号不会被误当成分隔 ✓）：
 * `C:\…\x.test.ts:12: text` ⇒ `C:/…/x.test.ts` ✓；`src/test/x.test.ts:1: text` ⇒ `src/test/x.test.ts` ✓。
 */
function fileFromGrepRow(row: string): string {
  const m = String(row).match(/^(.*?):(\d+):/);
  const raw = m ? m[1] : String(row).split(":")[0];
  return raw.replace(/\\/g, "/");
}

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
  const src = opts.src ?? createIpcFileSource(root);
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
    const search = opts.search ?? createIpcSearcher(root);
    const found: string[] = [];
    for (const term of usefulTerms.slice(0, 15)) {
      const rows = await search(term, root);
      for (const row of rows) found.push(row);
      /** 够了就停：每个词一次 IPC，别把会话开头拖长 ✓（第 124 波） */
      if (found.filter((r) => !isTestFile(String(r))).length >= 8) break;
    }
    const seen = new Set<string>();
    for (const row of found) {
      const file = fileFromGrepRow(String(row));
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
  const src = opts.src ?? createIpcFileSource(root);
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
  const src = opts.src ?? createIpcFileSource(root);
  if (isTestFile(editedRelativePath)) return null; // 改的是测试文件 ⇒ 不用提 ✓
  /**
   * **根目录下的文件不参与**（第 134 波）✓：相对路径里没有目录分隔 ⇒ 是临时脚本/配置 ✓。
   *
   * 真机证据（1.16.251）：机制已经能产出 ✓，但产出对象全是 agent 自己写在仓库根目录的
   * `tmp-*.mjs` ✗ ⇒ 每回合只有 4 个文件的额度 ✗，等它去编辑真正的 `src/core/llm/tools.ts` 时
   * **额度已经用完** ✗ ⇒ 那一轮 repo-02 连跑四轮 **0/4** ✗。
   */
  if (!editedRelativePath.replace(/\\/g, "/").includes("/")) return null;
  let text = "";
  try {
    text = await src.read(`${root}/${editedRelativePath}`, MAX_BYTES_PER_FILE);
  } catch (readErr) {
    /**
     * **第 133 波：读失败要能看见** ✓（原来静默 `return null` ✗ ⇒ 真机上连查三轮都只能靠猜 ✗）。
     */
    console.warn("[同族判据] 读文件失败（这会让提示为空）：", editedRelativePath, readErr);
    return null;
  }
  /**
   * ⚠️ **第 133 波的第二次修正**：原来这里取 `slice(0, 3)` ✗，而 `extractSymbols` 是**按长度倒序** ✓
   * —— 长名字往往是实现细节（没有任何判据提到 ✗）⇒ 真机上 `tools.ts` 也返回 null ✗
   * （它的 `applyToolResultStatus` 明明被 `dsh-d9` 提到 ✓，却排在第四、第五位开外 ✗）。
   *
   * 现在取 6 个 ✓，并且**第一个搜到命中的符号就收手** ✓ ——
   * 兼顾"能找到" ✓ 与"别把时延拖长" ✓（每次 grep 都是一次 PowerShell 调用 ✗）。
   */
  const symbols = extractSymbols(text, 12);
  /** 真机可见性（第 133 波）：**读了多长、抽出几个符号** —— "返回 null"就靠这两行定位 ✓。 */
  console.warn(`[同族判据] 诊断：${editedRelativePath} 读到 ${text.length} 字符，抽出 ${symbols.length} 个符号`);
  if (symbols.length === 0) return null;
  void src;

  const { files: found, tried } = await searchSiblingCriteriaFiles(root, symbols, editedRelativePath, opts);
  if (found.length === 0) return null;

  return [
    `[同族判据] 你刚改的 ${editedRelativePath} 里有这些符号（${tried.join("、")}），`,
    `下列**测试/判据**文件也提到它们（只是列出事实 ✓）：`,
    ...found.map((f) => `- ${f}`),
  ].join("\n");
}

/**
 * **列出某个源码文件的同族判据文件**（公开入口 ✓，第 154 波）。
 *
 * 收尾守卫（`unrunSiblingCriteria` 的调用方 ✓）要的是**文件列表** ✓，
 * 不是渲染好的提示文本 ✓ —— 所以这里把"读文件 + 抽符号 + 搜索"整条链打包 ✓，
 * 让收尾守卫不必自己再写一遍 ✗（两处各写一遍迟早分叉 ✓）。
 */
export async function siblingCriteriaFiles(
  root: string,
  editedRelativePath: string,
  opts: { src?: TestFileSource; search?: SearchLike; maxFiles?: number } = {},
): Promise<string[]> {
  const src = opts.src ?? createIpcFileSource(root);
  if (isTestFile(editedRelativePath)) return []; // 改的就是判据本身 ⇒ 不用列 ✓
  if (!editedRelativePath.replace(/\\/g, "/").includes("/")) return []; // 根目录临时文件不参与 ✓
  let text = "";
  try {
    text = await src.read(`${root}/${editedRelativePath}`, MAX_BYTES_PER_FILE);
  } catch {
    return [];
  }
  const symbols = extractSymbols(text, 12);
  if (symbols.length === 0) return [];
  /**
   * **收尾检查要 `thorough`** ✓（第 155 波）——理由见 `searchSiblingCriteriaFiles` 里的长注释 ✓：
   * "搜到就收手"会让收尾提醒**恰好漏掉**那两条真正没跑过的判据 ✗。
   */
  const { files } = await searchSiblingCriteriaFiles(root, symbols, editedRelativePath, { ...opts, src, thorough: true });
  return files;
}

/**
 * **列出"同族判据"文件** ✓（第 154 波把它从 `buildSymbolSiblings` 里抽出来 ✓）。
 *
 * 抽出来的理由：收尾守卫需要的是**文件列表**（"哪些判据没跑过"✓），而不是渲染好的文本 ✓ ——
 * 两处若各写一遍搜索逻辑，迟早会分叉 ✗（本仓库已经吃过"两条路径形状不同"的亏 ✓）。
 */
async function searchSiblingCriteriaFiles(
  root: string,
  symbols: string[],
  editedRelativePath: string,
  opts: { search?: SearchLike; maxFiles?: number; thorough?: boolean; src?: TestFileSource },
): Promise<{ files: string[]; tried: string[] }> {
  const search = opts.search ?? createIpcSearcher(root);
  /**
   * ★ 第 44 波：**只遍历判据目录** ✓ —— 全树 2.35s ⇒ `src/test` 0.06s（40× ✓）。
   * 判据目录由 `resolveTestRoots` 解析（回退到工作区根 ✓，绝不假否定 ✗）。
   */
  const testRoots = await resolveTestRoots(root, opts.src ?? createIpcFileSource(root));
  const found: string[] = [];
  const tried: string[] = [];
  /**
   * **thorough 时搜满全部符号** ✓（第 155 波第二次修正）：
   * 只搜前 6 个时，`tools.ts` 仍然**找不到** `dsh-d8` / `dsh-d9` ✗ ——
   * 那两条判据引用的符号排在更后面 ✓（`extractSymbols` 是**按长度倒序** ✗）。
   */
  const symbolBudget = opts.thorough ? symbols.length : 6;
  const fileBudget = opts.maxFiles ?? (opts.thorough ? 10 : 6);
  for (const sym of symbols.slice(0, symbolBudget)) {
    tried.push(sym);
    let rows: string[] = [];
    /** ★ 第 44 波：**每个判据目录各搜一次**（都只遍历那一个目录 ✓，合起来仍远小于全树 ✓） */
    for (const searchRoot of testRoots) {
      try {
        rows = rows.concat(await search(sym, searchRoot, TEST_FILE_INCLUDE));
      } catch {
        /* 单个根失败不致命 ✓ —— 其余根照样搜 ✓（"没有"与"搜不到"必须分开 ✗）*/
      }
    }
    for (const row of rows) {
      const file = fileFromGrepRow(String(row));
      if (!file || !isTestFile(file)) continue; // 只列判据（测试）文件 ✓
      if (file.includes(editedRelativePath)) continue;
      if (!found.includes(file)) found.push(file);
      if (found.length >= fileBudget) break;
    }
    /**
     * ⚠️ **第 155 波：`thorough` 时不许"搜到就收手"** ✗→✓。
     *
     * 原来这里一律"第一个搜到命中的符号就收手"✗（250 波为时延加的 ✓）——
     * 实测后果很严重 ✗：对 `src/core/llm/tools.ts` 只找得到
     * `dsh-d10-write-not-executed-is-error.test.ts` ✗，
     * **漏掉了 `dsh-d8-edit-ambiguity` 与 `dsh-d9-multi-edit-partial-failure`** ✗
     * —— 而那两条**正是失败轮从没跑过的** ✓✓（通过轮三条都跑了 ✓）。
     * 也就是说：**收尾提醒若沿用"收手"策略，点出的恰好是"已经跑过的那条"** ✗，等于没提醒 ✓。
     *
     * 于是分两种口径 ✓：
     * - **回合内提示**（`buildSymbolSiblings` ✓）：收手 ✓，时延优先 ✓（用户正等着 ✓）；
     * - **收尾检查**（`siblingCriteriaFiles` ✓）：`thorough` ✓，6 个符号全搜 ✓
     *   （一个会话只付一次 ✓；而"漏掉该跑的判据"的代价是整轮失败 ✗）。
     */
    if (!opts.thorough && found.length > 0) break;
    if (found.length >= (opts.maxFiles ?? 6)) break;
  }
  return { files: found, tried };
}

/**
 * **收尾判定（族口径）**：本会话跑过的判据属于哪个"族"、族里还有哪几条**没跑过** ✓。
 *
 * ## 为什么从"共享符号"换成"族"（第 156 波：先验前提查出来的 ✗→✓）
 *
 * 第 154 波先做的是"同族判据 = 与所改文件**共享符号**的判据"✗ —— 先验前提一量就发现它**是哑的** ✗：
 *
 * ```
 * siblingCriteriaFiles("src/core/llm/tools.ts")
 *   ⇒ 只找得到 dsh-d10（**已经跑过的那条** ✗），漏掉 dsh-d8 / dsh-d9 ✗
 * ```
 * 两次放宽（去掉"搜到就收手" ✓、搜满 12 个符号 ✓）**都还是找不到** ✗
 * ⇒ "共享符号"这条信号**连不到那两条判据** ✗（它们引用的标识符不在最长的 12 个里 ✓）。
 *
 * 而真机读数早就把正确信号指出来了 ✓：
 *
 * | 轮次 | 结果 | **bash 里真跑过的判据** |
 * |---|---|---|
 * | run-2 | **通过** ✓ | **dsh-d8, dsh-d9, dsh-d10（整个族 ✓）** |
 * | run-3 | 失败 ✗ | 只有 dsh-d10 ✗ |
 * | run-4 | 失败 ✗ | 只有 dsh-d10 ✗ |
 *
 * ⇒ 差别是「**同一族里跑了几条**」✓，不是「认不认识某个符号」✗。
 * 族的定义沿用本模块既有口径 ✓（`summarizeNameClusters`：**名字第一段** ✓，
 * 例如 `dsh-d8-edit-ambiguity.test.ts` ⇒ 族 `dsh` ✓）。
 *
 * 这条信号**不需要读源码、不需要 grep** ✓（只用文件清单 ✓）⇒ 收尾时几乎不花时间 ✓。
 *
 * @param runFiles 本会话**跑过**的判据文件（`testFileStatus` 的键 ✓）
 * @returns 族里没跑过的判据文件（相对路径 ✓、去重 ✓、有上限 ✓、排序稳定 ✓）
 */
export async function unrunFamilyCriteria(args: {
  root: string;
  runFiles: Iterable<string>;
  src?: TestFileSource;
  max?: number;
}): Promise<string[]> {
  const max = Math.max(1, args.max ?? 8);
  const normalize = (p: string) => p.replace(/\\/g, "/");
  const run = new Set([...args.runFiles].map((f) => normalize(f).replace(/^\.\//, "")));
  if (run.size === 0) return [];
  const wanted = new Set([...run].map(familyOfTestFile));
  let all: string[] = [];
  try {
    all = (await collectTestFiles(args.root, args.src)).map(normalize);
  } catch {
    return [];
  }
  const unrun: string[] = [];
  for (const file of all.slice().sort()) {
    if (run.has(file)) continue;
    if (!wanted.has(familyOfTestFile(file))) continue;
    if (!unrun.includes(file)) unrun.push(file);
    if (unrun.length >= max) break;
  }
  return unrun;
}

/**
 * **判据文件的"族"** ✓（名字第一段 ✓，`dsh-d8-edit-ambiguity.test.ts` ⇒ `dsh` ✓）。
 *
 * 为什么抽成导出函数（第 41 波）：收尾提醒的**缺口列表**与它**建议的命令**必须用同一个口径 ✓ ——
 * 原来列表用一个内部 `familyOf` ✓、而文案里的族名取自**别的**东西（跑过的第一条判据 ✗）⇒
 * 两者必然可能自相矛盾 ✗（真机代价见 `buildUnrunFamilyNudge` 的说明 ✓）。
 */
export function familyOfTestFile(file: string): string {
  const base = String(file).replace(/\\/g, "/").split("/").pop() ?? String(file);
  return base.split(/[-_.]/).filter(Boolean)[0] ?? base;
}

/**
 * 建议命令里的**过滤器**：`src/test/<族>-` ✓。
 *
 * ⚠️ ★ **必须是"位置参数 + 子串匹配"的形式，不能写成 glob** ✗→✓（第 41 波实测 ✓）：
 * ```
 * npx vitest list 'src/test/dsh-*.test.ts'   ⇒ 匹配 0 个文件 ✗
 * npx vitest list 'src/test/dsh-'            ⇒ 匹配 137 条测试 ✓（整个 dsh 族 ✓）
 * ```
 * vitest 的位置参数是**按路径做子串匹配**（多个参数是**或** ✓，实测 `chunk-` + `app-` = 2+3 个文件 ✓），
 * **不认 `*`** ✗。所以旧文案里那句 `npx vitest run 'src/test/<族>-*.test.ts'` **从来就跑不出东西** ✗ ——
 * 真机侧车里那条 `output length: 101`（≈ 一句"没有匹配文件"✓）就是它 ✓（`repo-02` run-2 ✓）。
 * 判据 `UNC-7` 钉"过滤器里不许出现通配符"✓。
 *
 * 顺带：**不带扩展名**也解决了 `.tsx` 判据 ✓（`src/test/app-` 实测匹配 3 个文件，其中 2 个是 `.tsx` ✓）。
 */
export function familyFilter(family: string): string {
  return `src/test/${family}-`;
}

/**
 * `unrun-family` 收尾提醒的**文案构造** ✓（纯函数 ⇒ 可单测 ✓，第 41 波）。
 *
 * ## 为什么必须抽出来（**真机读数驱动的修复** ✓，不是重构癖 ✗）
 *
 * `repo-02` / run-2（`1.16.289` ✓，败 ✗）的控制台侧车里逐字留着两行，**前后脚**：
 * ```
 * 收尾：族里没跑过的判据 {"family":"repro","unrun":50,"sample":["src/test/core-chat-message-storage.test.ts",…]}
 * … bash: npx vitest run "src/test/repro-*.test.ts"      ← ★ 模型照做了提醒里的命令
 *              output length: 101                        ← ★ 101 字节 ≈ 一句"没有匹配文件"
 * ```
 * ⇒ ★ 提醒**说**的族（`repro-*`）与它**点名**的缺口（`core-*`）不是一回事 ✗ ⇒
 * 模型照做却一条缺口都没补上 ✓，而 `unrunSiblingsNudged` 已置位 ⇒ 不再提醒 ✓ ⇒ 35 轮收尾 ✗
 * （同一任务通过的两轮是 79 / 99 轮 ✓）。
 * ⚠️ 而且那条命令**就算族名说对了也跑不出东西** ✗ —— 位置参数是子串匹配、不认 `*` ✓
 * （见 `familyFilter` 的实测 ✓）⇒ 这是**同一句话上的两个缺陷** ✓，都必须修 ✓。
 *
 * ## 口径（**一句话：文案里的每个集合都必须来自同一个 `unrun`** ✓）
 *
 * - 族名 = `unrun` 里**实际出现**的族（去重 + 排序 ✓）—— 不再取"跑过的第一条判据的族" ✗；
 * - 建议命令 = **每个族一条过滤器** ✓ ⇒ 命令**必然覆盖它自己点名的每一条缺口** ✓；
 * - 计数与列表都来自同一个 `unrun` ✓（`UNC-6` 钉 ✓）。
 *
 * @param runCount 本会话**跑过**的判据条数 ✓（文案里的"你已经跑过 N 条"✓）
 * @param unrun    **没跑过**的同族判据（相对路径 ✓）；空数组 ⇒ 返回 `""`（= 不提醒 ✓）
 */
export function buildUnrunFamilyNudge(args: { runCount: number; unrun: readonly string[] }): string {
  const unrun = [...new Set(args.unrun.map((f) => String(f).replace(/\\/g, "/").replace(/^\.\//, "")))];
  if (unrun.length === 0) return "";
  const families = [...new Set(unrun.map(familyOfTestFile))].sort();
  const shown = unrun.slice(0, 8);
  const filters = families.map((f) => `'${familyFilter(f)}'`).join(" ");
  return (
    "[SYSTEM] 你这一路动过源码，而**判据只跑了一部分**（这是一条事实，不是命令 ✓）：\n" +
    `- 你已经跑过 ${args.runCount} 条 ✓\n` +
    `- 与你跑过的判据**同族**、而**你没跑过**的还有 **${unrun.length} 条**` +
    `（分属 ${families.length} 个族：${families.map((f) => `\`${f}-*\``).join("、")}）：\n` +
    shown.map((f) => `  - ${f}`).join("\n") +
    (unrun.length > shown.length ? `\n  - …还有 ${unrun.length - shown.length} 条` : "") +
    `\n\n一条命令可以把这些族跑完：\`npx vitest run ${filters}\` ✓\n` +
    "（vitest 的位置参数是**按路径子串匹配** ✓、多个参数是**或** ✓ —— 别写成 `dsh-*.test.ts` 这种通配符 ✗，那样一个文件都匹配不到 ✓）\n" +
    "为什么值得跑完：这类任务的真机数据里，**把同族判据跑齐的轮次通过，只跑了一部分的轮次失败** ✓，" +
    "而失败形态几乎都是「改得不完整」（只补了其中一两处）✓。"
  );
}

/**
 * **收尾判定：改了源码，但它的同族判据一次都没跑过** ✓（纯函数 ⇒ 可单测 ✓）。
 *
 * ## 为什么需要它（目标①的失败签名 ✓）
 *
 * repo-02 的真机读数（同版本同提示词 ✓）显示：**决定成败的不是"读没读到判据"** ✗，
 * 而是**"有没有把该跑的判据都跑过"** ✓：
 *
 * | 轮次 | 结果 | 提到 d8/d9/d10 | **在 bash 里真跑过的** |
 * |---|---|---|---|
 * | run-2 | **通过** ✓ | 9 / 9 / 10 | **d8, d9, d10** ✓ |
 * | run-3 | 失败 ✗ | 0 / 0 / 21 | 只有 d10 ✗ |
 * | run-4 | 失败 ✗ | 2 / 2 / 6 | 只有 d10 ✗ |
 *
 * ⇒ 而本任务的缺陷形态正是"**补丁不完整**"✗（需要三处改动，失败轮只做了一两处 ✓）。
 * 只要在收尾时把"**你改过这个文件、但这条判据你一次都没跑**"点出来 ✓，
 * 模型就有机会自己发现漏掉的那处 ✓。
 *
 * @param editedSources 本会话编辑过的**源码**文件（相对路径 ✓，测试文件不算 ✓）
 * @param siblingsOf 每个编辑文件 → 它的同族判据文件列表（由 `siblingCriteriaFiles` 提供 ✓）
 * @param runStatus 本会话**跑过**的判据文件 → 结果（`testFileStatus` ✓；**不在里面 = 从没跑过** ✓）
 * @returns 没跑过的判据文件列表（去重 ✓、有上限 ✓；空 = 无需提醒 ✓）
 */
export function unrunSiblingCriteria(args: {
  editedSources: Iterable<string>;
  siblingsOf: ReadonlyMap<string, readonly string[]>;
  runStatus: ReadonlyMap<string, "red" | "green">;
  max?: number;
}): string[] {
  const max = Math.max(1, args.max ?? 6);
  const out: string[] = [];
  for (const source of args.editedSources) {
    for (const file of args.siblingsOf.get(source) ?? []) {
      if (args.runStatus.has(file)) continue; // 跑过（不论红绿 ✓）⇒ 不算"没跑过" ✓
      if (!out.includes(file)) out.push(file);
      if (out.length >= max) return out;
    }
  }
  return out;
}

