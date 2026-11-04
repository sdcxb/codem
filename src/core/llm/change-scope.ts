/**
 * 改动范围分类（第 187 波）。
 *
 * ## 要修的误报
 *
 * 用户做的是“写 .docx / .md 文档”的任务，循环把 `write` / Python 生成文档算成
 * `turnModifiedFiles`，收尾时按“改了文件但没跑测试/构建”给出「这一轮没有跑过
 * 任何验证」——可文档任务本来就不该用测试/构建来验证。提示既错误又制造焦虑。
 *
 * ## 判据
 *
 * 不能只看“有没有改文件”，也不能只靠一句提示词判断任务类型。这里按**改动对象**
 * 分级，并以用户任务描述只处理“拿不到具体路径”的兜底：
 *
 *   · 明确改了代码/配置（`.ts/.rs/.py/.json/...`）⇒ 需要代码验证；
 *   · 明确只改了文档/内容（`.md/.docx/.pdf/.xlsx/...`）⇒ 不需要测试/构建；
 *   · 只拿得到不透明命令（如 `python build_doc.py`）⇒ 若用户任务明显是文档任务，
 *     不要求测试/构建；否则按代码任务处理（保守）。
 *
 * 这是纯函数模块：路径/文本分类可单测，循环只负责累积事实。
 */

export type ChangeScope = "code" | "document" | "unknown";

const DOCUMENT_EXT_RE =
  /\.(?:md|markdown|mdx|txt|text|doc|docx|pdf|ppt|pptx|xls|xlsx|csv|tsv|rtf|odt|ods|odp|epub|html?|png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|avi|mkv|mp3|wav|flac|zip|7z|rar)$/i;

const CODE_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|pyi|go|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|rb|php|scala|sh|bash|zsh|ps1|bat|cmd|sql|css|scss|sass|less|vue|svelte|astro|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|gradle|cmake|dockerfile|makefile)$/i;

/** 命令/输出里的扩展名不要求在字符串末尾（`python x.py --out y.docx`） */
const DOCUMENT_TEXT_RE =
  /\.(?:md|markdown|mdx|txt|text|doc|docx|pdf|ppt|pptx|xls|xlsx|csv|tsv|rtf|odt|ods|odp|epub|html?|png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|avi|mkv|mp3|wav|flac|zip|7z|rar)(?=$|[\s"'`),;:])/i;

const CODE_TEXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|pyi|go|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|rb|php|scala|sh|bash|zsh|ps1|bat|cmd|sql|css|scss|sass|less|vue|svelte|astro|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|gradle|cmake|dockerfile|makefile)(?=$|[\s"'`),;:])/i;

/** 命令里出现这些工具/库，说明它在产出文档，而不是在改产品代码。 */
const DOCUMENT_COMMAND_RE =
  /(?:python-docx|docx|openpyxl|xlsxwriter|python-pptx|pptx|pandoc|soffice|libreoffice|winword|word[.\s]?application|wps|reportlab|markdown)/i;

/** 无扩展名但明确是代码/配置的 basename（小写） */
const CODE_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "cmakelists.txt",
  "jenkinsfile",
  "procfile",
  "gemfile",
  "rakefile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
]);

function normalizePath(path: string): string {
  return String(path ?? "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
}

/** 单个显式路径的分类。未知扩展名按 unknown，不猜。 */
export function classifyChangePath(path: string): ChangeScope {
  const p = normalizePath(path);
  if (!p) return "unknown";
  const base = p.split("/").pop()?.toLowerCase() ?? "";
  if (CODE_BASENAMES.has(base)) return "code";
  if (CODE_EXT_RE.test(base)) return "code";
  if (DOCUMENT_EXT_RE.test(base)) return "document";
  return "unknown";
}

export interface ChangeTextScope {
  code: boolean;
  document: boolean;
}

/**
 * 从一段命令/输出里提取路径扩展名。没有路径上下文时只回答“看见了什么”，
 * 不直接决定是否验证（调用方还要结合任务描述）。
 */
export function classifyChangeText(text: string): ChangeTextScope {
  const value = String(text ?? "");
  const code = CODE_TEXT_RE.test(value) || [...CODE_BASENAMES].some((name) => value.toLowerCase().includes(name));
  const document = DOCUMENT_TEXT_RE.test(value) || DOCUMENT_COMMAND_RE.test(value);
  return { code, document };
}

const DOCUMENT_TASK_RE =
  /(?:写|编写|撰写|编辑|生成|整理|重写|改写|润色|排版|校对|核对|合并|拆分|提取|更新|续写|补充)[^。\n]{0,30}(?:文档|文稿|报告|方案|申报书|标书|论文|手册|说明书|合同|术语表|章节|目录|分册|材料|表格|PPT|幻灯片|Word)|\.(?:docx?|md|markdown|pptx?|xlsx?|pdf)\b|文档任务|写文档|写材料|文字工作|按[^。\n]{0,12}体例/i;

const CODE_TASK_RE =
  /(?:代码|源码|函数|编译|构建|单元测试|集成测试|bug|修复|重构|部署|SQL|API|npm|pnpm|yarn|rust|typescript|react|git|commit|typecheck|vitest|cargo)/i;

/** 只用于“没有具体改动路径”的兜底；明确路径永远优先。 */
export function looksLikeDocumentTask(userMessage: string): boolean {
  const text = String(userMessage ?? "");
  return DOCUMENT_TASK_RE.test(text) && !CODE_TASK_RE.test(text);
}

export interface VerificationScopeInput {
  /** 是否明确改过代码/配置 */
  touchedCode: boolean;
  /** 是否明确只改过文档/内容 */
  touchedDocument: boolean;
  /** 有没有“改了但拿不到具体对象”的改动 */
  touchedUnknown: boolean;
  /** 用户原始任务描述，只用于 unknown 兜底 */
  userMessage: string;
}

/**
 * 收尾时是否应该要求“代码验证”（测试/构建/类型检查）。
 *
 * 注意：返回 false 不等于“任务已完成”；它只表示**不该用测试/构建来催**。
 * 完成门、回归门、红判据门仍独立生效。
 */
export function requiresCodeVerification(input: VerificationScopeInput): boolean {
  if (input.touchedCode) return true;
  if (input.touchedDocument) return false;
  if (input.touchedUnknown) return !looksLikeDocumentTask(input.userMessage);
  return false;
}
