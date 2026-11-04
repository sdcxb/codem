/**
 * 对话里「明确给出的本地路径」→ 文档索引候选（入口 3.2）。
 *
 * ## 为什么不能直接用 `extractFilePathsFromText`
 *
 * 那个函数（`src/core/llm/tools.ts:375`）是为**工具输出的可点链接**写的：
 * - 只认盘符绝对路径、Unix 绝对路径、`./` 相对路径 ⇒ `docs/a.md`、`报告.docx` 全部漏掉；
 * - 不区分代码围栏 ⇒ 代码块里的 `src/foo.ts` 会被当成真路径；
 * - 没有「允许根 / 存在性 / 文档扩展名」校验。
 *
 * 这里保留它的**保守性**（宁漏不错），但补齐三个边界：
 * 1. 先剥掉 fenced code 与行内 code（那里的路径是示例，不是用户给的资料）；
 * 2. 支持裸相对路径与裸文件名（仅限二进制文档扩展名，避免把「a.txt」这类日常词当文件）；
 * 3. 由调用方注入 `exists` / `allowedRoots`，只登记**真实存在且在允许根内**的文件。
 */

/** 可以作为「项目资料」的扩展名（含文本与 Office/PDF/图片）。 */
const DOCUMENT_EXTENSIONS = [
  "md",
  "markdown",
  "rst",
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
] as const;

const DOC_EXT_ALT = DOCUMENT_EXTENSIONS.join("|");

/** 只有这些扩展名允许「裸文件名」形态（`.md/.txt` 太容易出现在日常句子里）。 */
const BINARY_DOC_ALT = "docx|xlsx|pptx|pdf";

export function isDocumentExtension(nameOrPath: string): boolean {
  const ext = nameOrPath.split(".").pop()?.toLowerCase() ?? "";
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext);
}

/** 去掉 ``` 围栏代码与行内 `code`（保留换行，避免把两段正文粘在一起）。 */
export function stripCodeFromMessage(text: string): string {
  if (!text) return "";
  let out = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  out = out.replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n");
  // 行内 code：只剥单反引号包裹的片段
  out = out.replace(/`[^`\n]{1,300}`/g, " ");
  return out;
}

/** 去掉链接/URL 里的路径（http(s):// 与 www. 不是本地文件）。 */
function isUrlLike(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^www\./i.test(raw) || raw.includes("://");
}

const TRAILING_PUNCT = /[.,;:!?)\]}>"'」』。，；：！？）】》]+$/;

function clean(raw: string): string {
  let p = raw.trim();
  p = p.replace(TRAILING_PUNCT, "");
  return p;
}

/**
 * 从一条用户消息里抽取候选路径（**不校验存在性**）。
 *
 * @param text 用户消息（建议先 `stripCodeFromMessage`）
 * @param maxPaths 上限（默认 20，与既有 `extractFilePathsFromText` 一致）
 */
export function extractDocumentPaths(text: string, maxPaths = 20): string[] {
  if (!text) return [];
  /*
   * 先剥掉 URL：`https://example.com/a.pdf` 里的 `/a.pdf` 会被 Unix 绝对路径规则命中，
   * 而它不是本地文件。整段替换成空格（保留其余文本的边界）。
   */
  const scanText = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const p = clean(raw);
    if (!p || isUrlLike(p)) return;
    if (!isDocumentExtension(p)) return;
    const key = p.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(p);
  };

  // 1) Windows 绝对路径：C:\dir\file.ext / C:/dir/file.ext
  const win = new RegExp(`[A-Za-z]:[\\\\/][^\\s"'<>|:*?\\n]+\\.(?:${DOC_EXT_ALT})`, "gi");
  for (const m of scanText.matchAll(win)) push(m[0]);

  // 2) Unix 绝对路径：/home/user/file.ext（要求出现在空白/括号/引号之后）
  const unix = new RegExp(
    `(?:^|[\\s(（「『"、，。；;:：'])((?:\\/[^\\s"'<>|:*?\\n]+)+\\.(?:${DOC_EXT_ALT}))`,
    "gi",
  );
  for (const m of scanText.matchAll(unix)) push(m[1]);

  // 3) 相对路径（至少含一个 `/`）：docs/a.md、./报告.docx、../资料/b.pdf
  const rel = new RegExp(
    `(?:^|[\\s(（「『"、，。；;:：'])((?:\\.{0,2}\\/)?(?:[\\w.\\-\\u4e00-\\u9fff]+\\/)+[\\w.\\-\\u4e00-\\u9fff]+\\.(?:${DOC_EXT_ALT}))`,
    "gi",
  );
  for (const m of scanText.matchAll(rel)) push(m[1]);

  // 4) 裸文件名：只认二进制文档扩展名（报告.docx / 数据.pdf）
  const bare = new RegExp(
    `(?:^|[\\s(（「『"、，。；;:：'])([\\w.\\-\\u4e00-\\u9fff]+\\.(?:${BINARY_DOC_ALT}))`,
    "gi",
  );
  for (const m of scanText.matchAll(bare)) push(m[1]);

  return found.slice(0, maxPaths);
}

/** 相对路径 → 绝对路径（`cwd` 为基准）。绝对路径原样返回。 */
function resolveCandidatePath(raw: string, cwd: string): string {
  const p = raw.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\")) return p;
  if (raw.startsWith("/")) return raw; // Unix 绝对路径（在 Windows 上也无害：存在性校验会失败）
  const base = cwd.replace(/[\\/]+$/, "");
  const rel = p.replace(/^\.\\/, "");
  return `${base}\\${rel}`;
}

/** 是否在允许根内（大小写不敏感前缀比较；根为空 = 不限制）。 */
function isWithinAllowedRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const p = path.replace(/\//g, "\\").toLowerCase();
  return roots.some((root) => {
    const r = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (!r) return false;
    return p === r || p.startsWith(`${r}\\`);
  });
}

export interface PathIngestCandidate {
  /** 用户原文里的写法（用于 UI 显示与撤销） */
  raw: string;
  /** 解析后的绝对路径 */
  path: string;
}

/**
 * 把一条消息变成「可索引的文档路径」清单。
 *
 * 四道过滤，**任何一道不过都不登记**：
 * 1. 不是 URL；2. 扩展名在支持表；3. 文件真实存在；4. 在允许根内。
 */
export async function collectIndexablePaths(params: {
  message: string;
  cwd: string;
  exists: (path: string) => Promise<boolean>;
  allowedRoots?: string[];
  maxPaths?: number;
}): Promise<PathIngestCandidate[]> {
  const cleaned = stripCodeFromMessage(params.message);
  const raw = extractDocumentPaths(cleaned, params.maxPaths ?? 20);
  const out: PathIngestCandidate[] = [];
  for (const candidate of raw) {
    const abs = resolveCandidatePath(candidate, params.cwd);
    if (params.allowedRoots && params.allowedRoots.length > 0) {
      if (!isWithinAllowedRoots(abs, params.allowedRoots)) continue;
    }
    try {
      if (!(await params.exists(abs))) continue;
    } catch {
      continue;
    }
    out.push({ raw: candidate, path: abs });
  }
  return out;
}
