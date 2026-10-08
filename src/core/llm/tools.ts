import type { ToolDefinition, ToolCallResult, LLMMessage } from "./types";
import { classifyToolResult } from "./tool-result-status";
import { readFile, writeFile, deletePath, executeCommand, globSearch, grepSearch, isPathWithinWorkspace, fileVersion } from "../file-api";
import {
  decideEditIntent,
  decideWriteIntent,
  getFsObservationPolicy,
  type FsPolicyDenial,
} from "./fs-observation";
import { getLang } from "../i18n/lang";
import { getSetting } from "../storage/settings";
// ★ 误拒修复：「沙箱是否启用」的唯一实现在 `sandbox-acl.ts`（与 `file-api` 的读写判定共用）——
// 这里不再自己读设置（同一规则不许两份）。
import { isSandboxAclEnabled } from "../sandbox/sandbox-acl";
import type { Context } from "../cordis/src/index.ts";
import type { PlanUpdateOp } from "./plan-utils";
import { findAmbiguousLiteral, replaceLiteral, suggestEditCandidates } from "./edit-matchers";
import { str } from "./input-args";
import {
  NO_TIMEOUT,
  resolveToolContract,
  type ResolvedToolContract,
  type ToolContract,
} from "./tool-contract";
/**
 * 第 122 轮 D 项：`read` / `bash` 的**结果形状**。
 *
 * 这两个是全仓调用量第 1、第 2 的工具（`bash 952 · read 330`），
 * 注册 `outputSchema` 之后"结果长什么样"从实现细节变成**可校验的声明**；
 * 渲染器与实现共用同一个函数，所以模型看到的文本一个字符都没变。
 */
import {
  BASH_OUTPUT_SCHEMA,
  READ_OUTPUT_SCHEMA,
  renderBashOutput,
  renderReadOutput,
  type ReadOutputValue,
} from "./tool-output-shapes";
import {
  appendDiagnostics,
  globWindowDiagnostic,
  pagedDiagnostic,
  renderDiagnostics,
  truncatedDiagnostic,
  type ToolDiagnostic,
} from "./tool-diagnostics";

// R4: 可选的 ctx 消费层 — 当 ctx 可用时优先通过 ctx.get() 消费服务
let _ctx: Context | null = null;

/** R4: 设置 Cordis Context — 传入后工具通过 ctx.get() 消费服务 */
export function setToolContext(ctx: Context) { _ctx = ctx }

// ========== 工具禁用（第 47 轮补：让「工具管理」的开关真的生效） ==========

/**
 * 「工具管理」面板写入的禁用列表键。
 *
 * ⚠️ 第 47 轮补之前这个键**全仓没有任何读取方**：面板写着"禁用的工具不会出现在
 * LLM 的可用工具列表中"，而模型侧的工具集构建完全不过滤 —— 用户把 `bash` 关掉，
 * 界面上看着关了（重启后也还是关的，设置确实落库了），**但模型照样能调用它**。
 * 安全侧的开关说假话，比没有这个开关更糟：用户会据此放松警惕。
 */
const DISABLED_TOOLS_KEY = "codem-disabled-tools";

/**
 * 禁用列表的进程内缓存。
 *
 * 为什么缓存：`getAll()` / `execute()` 都在**每次工具调用**的热路径上，
 * 而读设置要过端口（再序列化一次 JSON）。缓存由 `ToolManager` 面板的写入路径失效。
 */
let disabledToolIdsCache: Set<string> | null = null;

/** 读禁用列表（带缓存）。读不到就按"什么都没禁用"处理 —— 与旧行为一致，不会凭空禁用工具 */
function disabledToolIds(): Set<string> {
  if (disabledToolIdsCache) return disabledToolIdsCache;
  let list: string[] = [];
  try {
    const raw = getSetting(DISABLED_TOOLS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.map((v) => String(v));
  } catch {
    list = [];
  }
  disabledToolIdsCache = new Set(list);
  return disabledToolIdsCache;
}

/** 这个工具是否被用户禁用（定义层与执行层共用同一个判据） */
export function isToolDisabled(toolId: string): boolean {
  let disabled = false;
  try {
    disabled = disabledToolIds().has(toolId);
  } catch {
    /**
     * 判据本身出错时**不放行**：安全侧的开关宁可多拦一次
     * （模型会看到明确的拒绝原因，用户也能在「工具管理」里看到它是禁用状态），
     * 也不能在判据坏掉时静默放行。
     */
    console.warn("[tools] 禁用列表判据出错，本次按「已禁用」处理（安全侧宁可多拦）");
    disabled = true;
  }
  return disabled;
}

/**
 * 让禁用列表缓存失效（`ToolManager` 面板切换开关后必须调用）。
 *
 * 没有这一步，用户关掉一个工具之后**当前进程内仍然能调用它** ——
 * 那正是"开关说要生效、实际没生效"的同一类缺陷。
 */
export function invalidateDisabledToolsCache(): void {
  disabledToolIdsCache = null;
}

/** R4: 获取 Cordis Context */
export function getToolContext(): Context | null { return _ctx }

/** R4: 从 ctx 获取文件系统服务 */
function getFs() {
  if (_ctx) {
    try {
      const fs = _ctx.get('fs')
      if (fs) return fs
    } catch (e) { console.warn('[tools.ts]', e) }
  }
  return { readFile, writeFile, globSearch, grepSearch, isPathWithinWorkspace }
}

/** R4: 从 ctx 获取 Shell 服务 */
function getShell() {
  if (_ctx) {
    try {
      const shell = _ctx.get('shell')
      if (shell) return shell
    } catch (e) { console.warn('[tools.ts]', e) }
  }
  return { execute: (cmd: string, cwd?: string) => executeCommand(cmd, cwd) }
}

/** R4: 从 ctx 获取设置服务 */
function getSettings() {
  if (_ctx) {
    try {
      const settings = _ctx.get('settings')
      if (settings) return settings
    } catch (e) { console.warn('[tools.ts]', e) }
  }
  return { get: (key: string) => getSetting(key) }
}

/** R4: 从 ctx 获取 i18n 服务 */
function getI18n() {
  if (_ctx) {
    try {
      const i18n = _ctx.get('i18n')
      if (i18n) return i18n
    } catch (e) { console.warn('[tools.ts]', e) }
  }
  return { getLang: () => getLang() }
}
import { createLoadSkillTool } from "./tools/load-skill";
import { createWebSearchTool } from "./tools/web-search";
import { createReadAttachmentTool } from "./tools/read-attachment";
import { createSearchNotebookTool } from "./tools/search-notebook";
// P1-6: AI 跨笔记操作工具 (对标 NotebookLM 笔记操作)
import { createNoteOperationTools } from "./tools/note-operations";
import { createGeneratePPTTool } from "./tools/generate-ppt";
// P1: 澄清提问、事实核查、Todo 列表工具
import { createClarificationTool } from "./tools/ask-clarification";
import { createFactCheckTool } from "./tools/fact-check";
import { createShowTodoTool } from "./tools/show-todo";
// D-MCP: Playwright + Figma + GitHub MCP tools

// S0-3: Seam-aware file reading helper
// Uses FileSystemSeam if registered, falls back to direct import
async function readViaSeam(path: string, cwd?: string): Promise<string> {
  try {
    const { getSeamRegistry } = await import("../seam/types");
    const registry = getSeamRegistry();
    if (registry.hasProvider("filesystem")) {
      const fs = registry.getProvider<{
        readFile: (path: string, cwd?: string) => Promise<string>;
      }>("filesystem");
      return fs.readFile(path, cwd);
    }
  } catch {
    // Seam not initialized — fall through to direct import
  }
  // Fallback: resolve relative paths against cwd
  const resolvedPath = (cwd && !path.startsWith("/") && !path.match(/^[A-Za-z]:/))
    ? `${cwd.replace(/[/\\]+$/, "")}/${path}`
    : path;
  return readFile(resolvedPath);
}
import { createBrowserAutomateTool } from "./tools/browser-automate";
import { createFigmaFetchTool } from "./tools/figma-fetch";
import { createGitHubTool } from "./tools/github-tool";
// P0-1: LSP tool for code navigation
import { createLSPTool } from "./tools/lsp-tool";
// P0-2: tool_search for deferred tool loading
import { createToolSearchTool } from "./tools/tool-search";
// P0-3: exit_plan_mode tool for Plan Mode approval flow
import { createExitPlanModeTool } from "./tools/exit-plan-mode";
// P1-6: run_code tool for TypeScript code execution
import { createRunCodeTool } from "./tools/run-code";
// P1-7: session_search tool for FTS5 full-text search
import { createSessionSearchTool, createSessionEventSearchTool, createSessionTraceTool, createSessionEventReadTool } from "./tools/session-search";
// P2-12: Goal tools for automatic continuation
import { createGoalTools } from "./tools/goal-tools";
// P2-11: Workflow tool for JS-based task orchestration
import { createWorkflowTool } from "./workflow-engine";
// P2-19/20: Job and Terminal tools for background task & terminal management
import { createJobTools } from "./tools/job-tools";
import { createTerminalOpenTool, createTerminalSendTool, createTerminalReadTool, createTerminalSignalTool, createTerminalCloseTool, createTerminalListTool } from "./tools/terminal-tools";
// D3: Dynamic Plugin tools
import { createDynamicPluginTools } from "./dynamic-plugin-tools";

// ========== S5: Sandbox Helpers ==========

/** S5: Check if sandbox mode is enabled and if the path is within the workspace. Returns error message if blocked, null if allowed. */
function checkSandbox(path: string, ctx: ToolContext): string | null {
  /**
   * ★ 误拒修复：「沙箱是否启用」**只有一处实现** —— `sandbox-acl.isSandboxAclEnabled()`
   * （与 `file-api.ts:assertWithinWorkspace` 共用它）。
   *
   * 改前这里自己读设置：`getSetting("codem-sandbox-enabled") === "true"`。而 `file-api.ts`
   * 的读侧/写侧判定**不看开关**（`workspace` 有值就判）⇒ 同一规则两份实现、两个结论：
   * `write` 工具在沙箱关闭时放行，而 `sdk.write({ workspace })` 却抛错 —— 就是用户点名的
   * 「关了沙箱沙箱还生效」。现在两处都问同一个入口（键名与"读失败时沿用上次值"的纪律
   * 都只有 `sandbox-acl.ts` 一份）。
   *
   * 判据：`src/test/sandbox-mode-consistency.test.ts` 的 SB-ONE-1（全仓只有一处读设置）。
   */
  const sandboxEnabled = isSandboxAclEnabled();
  if (!sandboxEnabled) return null;
  const workspace = ctx.cwd;
  if (!workspace) return null; // No workspace set — can't enforce
  // Resolve relative paths against the workspace before checking
  const resolvedPath = resolvePath(path, workspace);
  if (!isPathWithinWorkspace(resolvedPath, workspace)) {
    return `Sandbox: Write to "${path}" is outside the workspace "${workspace}". The sandbox is enabled — disable it in settings or write within the workspace.`;
  }
  return null;
}

/** Resolve a relative path against a base directory. */
function resolvePath(path: string, base: string): string {
  // If path is already absolute (starts with drive letter on Windows, or / on Unix), return as-is
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")) {
    return path;
  }
  // Join base + relative path
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  return base.replace(/[\\/]+$/, "") + sep + path.replace(/^[\\/]+/, "");
}

// ========== S2: Protected Paths ==========

// ========== E4: File Content LRU Cache ==========

class FileContentCache {
  private cache: Map<string, { content: string; timestamp: number }> = new Map();
  private maxSize: number;
  private maxAgeMs: number;

  constructor(maxSize = 50, maxAgeMs = 60_000) {
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  get(path: string): string | null {
    const entry = this.cache.get(path);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.maxAgeMs) {
      this.cache.delete(path);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(path);
    this.cache.set(path, entry);
    return entry.content;
  }

  set(path: string, content: string): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(path, { content, timestamp: Date.now() });
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
  }
}

const fileCache = new FileContentCache();

// ========== S2: Protected Paths ==========

/** Paths that must never be written or edited */
const PROTECTED_PATH_PATTERNS = [
  /(^|\/)\.git\//i,          // .git directory contents
  /(^|\\)\.git\\/i,          // .git directory (Windows)
  /(^|\/|\\)\.env$/i,        // .env files
  /(^|\/|\\)\.env\./i,       // .env.* files
  /(^|\/)\.codem-snapshots\//i, // snapshot directory
  /(^|\\)\.codem-snapshots\\/i,
  /(^|\/)node_modules\//i,    // node_modules
  /(^|\\)node_modules\\/i,
];

/** Check if a file path is protected (S2) */
export function isProtectedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(normalized) || pattern.test(filePath));
}

// ========== S1: Overwrite Protection ==========

/**
 * Calculate similarity ratio between old and new content (S1).
 * Returns 0.0 (completely different) to 1.0 (identical).
 * Uses a simple line-overlap heuristic.
 */
function calculateContentSimilarity(oldContent: string, newContent: string): number {
  if (oldContent === newContent) return 1.0;
  if (!oldContent || !newContent) return 0.0;

  const oldLines = new Set(oldContent.split("\n").map(l => l.trim()).filter(l => l.length > 0));
  const newLines = newContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (newLines.length === 0) return 0.0;

  let commonLines = 0;
  for (const line of newLines) {
    if (oldLines.has(line)) commonLines++;
  }

  return commonLines / Math.max(newLines.length, oldLines.size);
}

/** Threshold below which we block the overwrite */
const OVERWRITE_SIMILARITY_THRESHOLD = 0.1;

// ========== Structured file_paths extraction from tool output ==========

/**
 * Extract file paths from tool output text (e.g. bash stdout).
 *
 * This provides structured metadata so the UI can render clickable file links
 * without relying on the LLM to format paths in its response.
 *
 * Matching rules (conservative — avoid false positives):
 * - Windows absolute: C:\path\file.ext
 * - Unix absolute: /home/user/file.ext
 * - Relative with separator: ./src/file.ext or src/./file.ext
 * - Must end with a known file extension
 * - De-duplicated, max 20 results
 */
const FILE_EXT_REGEX = /\.(md|txt|json|yaml|yml|ts|tsx|js|jsx|mjs|cjs|py|sh|bat|ps1|css|scss|less|html|htm|svg|png|jpg|jpeg|gif|bmp|webp|ico|toml|ini|cfg|conf|rs|go|java|c|cpp|cc|h|hpp|sql|xml|csv|log|env|lock|gitignore|dockerfile|makefile|cmake|gradle|kt|swift|rb|php|vue|svelte|astro|docx|xlsx|pptx|pdf|zip|tar|gz|rar|7z|wav|mp3|mp4|avi|mov|webm|ttf|otf|woff|woff2|eot)$/i;

export function extractFilePathsFromText(text: string): string[] {
  if (!text) return [];
  const paths: string[] = [];
  const seen = new Set<string>();

  // Windows absolute: C:\path\file.ext or C:/path/file.ext
  const winRegex = /[A-Za-z]:[\\/]\S+\.[a-zA-Z0-9]{1,10}/g;
  // Unix absolute: /home/user/file.ext
  const unixRegex = /\/[A-Za-z]\S*\.[a-zA-Z0-9]{1,10}/g;
  // Relative with ./: ./src/file.ext
  const relRegex = /\.\/\S+\.[a-zA-Z0-9]{1,10}/g;

  for (const regex of [winRegex, unixRegex, relRegex]) {
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      let p = m[0];
      // Strip trailing punctuation
      p = p.replace(/[.,;:!?)\]}>"']+$/, "");
      if (!FILE_EXT_REGEX.test(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
      if (paths.length >= 20) break;
    }
    if (paths.length >= 20) break;
  }

  return paths;
}

// ========== F3.4: Auto-lint after write/edit ==========

/**
 * File extensions that support linting.
 *
 * ## ★ 第 42 波：**`.ts` 换快路径** ✓（`LINT-1..5` ✓）—— 目标② 的实测着力点 ✓
 *
 * 实测（`.preview-shot/_tool-durations.mjs` ✓，12 个侧车）：`edit`/`multi_edit`/`write`
 * 共 63 批 ≈ **416 s**、单批最大 **15.8 s**，而 `read`（对照）69 批只 8 s ✓
 * ⇒ 这笔时间**在工具内部** ✓。根因就是这里：
 * | 命令 | 实测 |
 * |---|---|
 * | `npx tsc --noEmit --pretty <file>`（**旧** ✗）| **5.5 s** |
 * | `node --experimental-strip-types --check <file>`（新 ✓，只查语法）| **0.17 s** |
 * | `npx tsc --noEmit --noResolve --jsx preserve --skipLibCheck <file>`（`.tsx` ✓）| **1.85 s** |
 * ⚠️ `.tsx` **不能**交给 node 的 `--check` ✗（实测 `ERR_UNKNOWN_FILE_EXTENSION` ✓）——
 * 所以 `.tsx` 仍走 tsc，只是加 `--noResolve`（跳过模块解析 ⇒ 快 3 倍 ✓）。
 */
const LINTABLE_EXTENSIONS: Record<string, { cmd: string; args: string }> = {
  /** ★ 只查**语法**（0.17s ✓）：编辑最常弄坏的就是语法/半截文件 ✓，而导入解析与类型交给 agent 自己的 tsc/vitest ✓ */
  ".ts": { cmd: "node", args: "--experimental-strip-types --check" },
  /** `.tsx` 走 tsc：node 的类型剥离**不认 JSX** ✗；`--noResolve` 让它只查这一个文件 ✓ */
  ".tsx": { cmd: "npx", args: "tsc --noEmit --noResolve --jsx preserve --skipLibCheck --pretty" },
  ".js": { cmd: "npx", args: "eslint" },
  ".jsx": { cmd: "npx", args: "eslint" },
  ".py": { cmd: "python", args: "-m py_compile" },
};

/**
 * `.ts` 快路径的**回退**：老 Node 没有 `--experimental-strip-types` ✓
 * ⇒ 那种机器上 node 会以"bad option"退非 0 ✗ —— 若把它当**语法错**报出去 ✗，
 * 就等于给每个 `.ts` 编辑塞一条假报警 ✓。
 * ⇒ 只有**命令本身没跑起来**才回退 ✓；真的语法错照常报 ✓。
 */
function isUnsupportedNodeFlag(out: string): boolean {
  return /bad option|unknown option|not supported|--experimental-strip-types/i.test(out) && !/SyntaxError|Unexpected/i.test(out);
}

/** Run a quick lint check on a file after writing/editing (F3.4) */
export async function autoLint(filePath: string): Promise<string | null> {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  const linter = LINTABLE_EXTENSIONS[ext];
  if (!linter) return null;

  try {
    // 用单引号包裹路径：PowerShell 单引号字符串内 $/反引号不做变量展开，
    // 避免路径含 $（如 C:\my$dir\file.ts）被展开为空。单引号转义为双单引号。
    const safeFile = filePath.replace(/'/g, "''");
    const run = async (cmd: string, args: string) => {
      const result = await executeCommand(`${cmd} ${args} '${safeFile}'`);
      return { code: result.exitCode, text: (result.stderr || result.stdout || "").trim() };
    };
    let { code, text } = await run(linter.cmd, linter.args);
    if (code !== 0 && isUnsupportedNodeFlag(text)) {
      /** 老 Node ⇒ 回退到 tsc（慢，但至少还在查 ✓） */
      ({ code, text } = await run("npx", "tsc --noEmit --noResolve --skipLibCheck --pretty"));
    }
    if (code === 0) return null; // No errors
    // Return first 3 lines of error output
    const errors = text.split("\n").filter((l: string) => l.trim()).slice(0, 5);
    return errors.length > 0 ? `[lint] ${errors.join("\n")}` : null;
  } catch {
    return null; // Linter not available — silently skip
  }
}

// ========== S4: Write Confirm Result ==========
export type WriteConfirmResult =
  | { action: "accept" }
  | { action: "reject" }
  | { action: "custom"; instruction: string };

// ========== Tool Context ==========
export interface ToolContext {
  sessionId: string;
  messageId: string;
  cwd: string;
  abort: AbortSignal;
  messages: LLMMessage[];
  metadata(input: { title?: string; metadata?: Record<string, any> }): void;
  /** (S4) Called before overwriting an existing file with low similarity. Return accept/reject/custom instruction. */
  onWriteConfirm?: (params: { filePath: string; existingContent: string; newContent: string }) => Promise<WriteConfirmResult>;
  /** (S5) Workspace path for sandbox enforcement */
  workspace?: string;
  /** Security mode: "ask" = show Diff confirm, "auto" = skip Diff confirm, "full" = skip everything */
  securityMode?: "ask" | "auto" | "full";

  /** (步骤计划) 执行中动态修改宏观计划（update_plan 工具回调）。成功返回详细结果文本（含新计划列表），失败返回 {ok:false,error}。 */
  updatePlan?: (op: PlanUpdateOp) => { ok: true; message: string } | { ok: false; error: string };

  // ===== Phase D extensions =====

  /** (D2) Get the current system prompt. Returns the assembled prompt string. */
  getSystemPrompt?: () => string;
  /** (D2) Submit prompt changes for user review. Returns when user has reviewed. */
  onPromptChangeSubmit?: (changes: PromptChange[]) => Promise<{ applied: boolean; message: string }>;
  /** (D3) Present an interactive form to the user and wait for their response. */
  onInteractiveForm?: (questions: InteractiveFormQuestion[]) => Promise<Record<string, unknown>>;

  // ===== Phase F extensions =====

  /** (F5) Active notebook ID for knowledge base mode. When set, search_notebook tool is available. */
  notebookId?: string;
}

export interface ToolExecuteResult {
  title: string;
  metadata?: Record<string, any>;
  output: string;
  /**
   * 本次调用**是否失败**。
   *
   * ## 第 181 波（T-1）：**必填化的尝试与结论**（这一节是给下一次动手的人看的）
   *
   * 该字段**应当**是必填的：省略时由 `classifyToolResult` 按输出**推断**，而推断表里有一份
   * `CONTENT_TOOLS`（`read`/`grep`/`glob`/`web_fetch`/`load_skill`…）**明确不推断**
   * （理由正当：它们的输出是"数据"，首行恰好是 `Error:` 也可能就是文件内容）。
   * 于是这些工具**真的失败**时会落到 `completed` —— 一个**静默缺口**。
   *
   * 本轮实测把 `isError` 改成必填后 `tsc` 报 **187 处**（33 文件）：
   * 153 处"缺字段" + **34 处"返回类型与 `execute` 签名不匹配"的执行点**
   * （后者此前**编译期完全看不见**，因为它们写在联合返回里、被推断成了 `isError?: undefined`）。
   *
   * ⚠️ **真正让这项不能机械做的原因**：153 处里 **123 处的 `output` 是模板串/表达式**
   * （`` output: `Error: ${e.message}` ``），**无法静态判定成败**。更关键的是——
   * 本仓库的**成功路径一律省略 `isError`**，而现行推断会对它们**按文本判**：
   * 只要 `output` 首行是 `Error:` 就判失败。把 `isError` 填成 `false` 会**改掉**这条语义
   * （原本会判失败的路径变成显式成功）；填成 `true` 则会把成功误标成失败。
   * **两种都会造成"看不见的行为改变"**，所以必须**逐条判成败**，不能用脚本硬插。
   *
   * **结论：这一项留给下一轮单独动手**（判据与精确缺口已在
   * `tool-result-status.test.ts` 的 `TRS-*` 与 `docs/HANDOFF-NEXT-SESSION.md` 第 181 波）。
   */
  isError: boolean;
  /**
   * 第 97 波：工具产出的**结构化结果值**（第 121 轮那套 `outputSchema` 的输入）。
   *
   * 工具声明了 `contract.outputSchema` 时**必须**给这个字段：`tool-pipeline` 的 finalize 层
   * 拿它做校验，再由 `contract.renderOutput` 渲染成给模型看的 `output`。
   *
   * ⚠️ 这个字段在第 121/122 轮加进 `ToolCallResult` 时**漏在了这里**（工具侧的类型），
   * 于是在 `agentic-loop` 里读 `result.value` 会报 TS2339 —— 而那条读取正是"把 value 透传给下游"
   * 的关键一行。也就是说：**类型漏字段 → 那一行写不出来 → 四个主力工具在真机上全废**
   * （`bash`/`read`/`glob`/`grep` 每次成功调用都被契约层改写成
   * `Error: … declared outputSchema but returned no value`）。判据见
   * `src/test/output-contract-real-loop.test.ts`。
   */
  value?: unknown;
}

// ========== Phase D: Interactive Form & Prompt Optimization Types ==========

/** (D3) A single question in an interactive form */
export interface InteractiveFormOption {
  label: string;
  value: string;
  recommended?: boolean;
}

/** (D3) A question to present to the user via interactive form */
export interface InteractiveFormQuestion {
  id: string;
  question: string;
  input_type: "choice" | "text";
  options?: InteractiveFormOption[];
  multi_select?: boolean;
  required?: boolean;
  default?: string | string[];
  placeholder?: string;
}

/** (D2) A prompt change submitted for user review */
export interface PromptChange {
  type: string;
  name: string;
  original: string;
  suggested: string;
}

// ========== Tool Definition ==========
export interface ToolDef {
  id: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult>;
  /**
   * Maximum result size in characters before the output is persisted to disk.
   * If the result exceeds this size, it is saved to a file and the LLM
   * receives a preview + file path instead of the full content.
   *
   * - Default (undefined): uses DEFAULT_MAX_RESULT_SIZE_CHARS (50KB)
   * - Infinity: never persist (used by 'read' tool to prevent loops)
   *
   * See: tool-result-storage.ts
   */
  maxResultSizeChars?: number;

  /**
   * P0-2: If true, this tool's full schema is NOT sent to the LLM upfront.
   * Instead, a compact description (searchHint) is sent, and the LLM must
   * call `tool_search` to retrieve the full schema before using the tool.
   *
   * This reduces token usage for rarely-used tools with large schemas (e.g. LSP).
   * Default: false (full schema always sent).
   */
  shouldDefer?: boolean;

  /**
   * P0-2: Short description used when shouldDefer=true.
   * The LLM sees this instead of the full description+parameters.
   * Should include enough info for the LLM to know WHEN to search for this tool.
   */
  searchHint?: string;

  /**
   * Tool usage guidance — tells the LLM WHEN and HOW to use this tool.
   *
   * This text is automatically registered to the systemPrompt service as a
   * prompt section (name: `tool:<id>`, order: 100–199) when the tool is
   * registered via toolsProvider. It follows the DSH pattern where each
   * tool owns its usage guidance, so the system prompt's tool list is
   * assembled dynamically from registered tools — never hardcoded.
   *
   * Leave undefined for internal/infrastructure tools that should not be
   * advertised to the LLM directly (e.g. spawn_subagent is documented in
   * its own dedicated prompt section).
   */
  guidance?: string;

  /**
   * 工具契约 —— 这个工具「是什么」的声明。
   *
   * 契约化之前，这些事实分散在 **7 组硬编码名单**里（并发、超时豁免、沙箱覆盖、
   * 落盘豁免、micro-compact、计划模式、recon），新增工具要往 5–7 处登记，
   * 漏一处**不报错**、只是静默少一项能力。本仓已因此栽过三次
   * （`web_search` 被串行、`lsp_tool` 权限从未命中、`read_attachment` 加了不生效）。
   *
   * 字段全部可选，**缺省值一律落在安全侧**：不并发、要超时、不豁免落盘。
   * 需要「特权」的工具显式声明 ⇒ 漏声明 = 少一项优化，而不是行为不确定。
   *
   * 所有字段的语义与优先级见 `tool-contract.ts`；消费者**必须**走
   * `resolveToolContract()` 而不是直接读这里的字段（那样又会各自补默认值）。
   */
  contract?: ToolContract;
}

// ========== Tool Registry ==========
export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map();

  register(tool: ToolDef) {
    this.tools.set(tool.id, tool);
  }

  /** Remove a tool by id (used by SkillToolRegistry when unloading skills) */
  remove(id: string): boolean {
    return this.tools.delete(id);
  }

  get(id: string): ToolDef | undefined {
    return this.tools.get(id);
  }

  /**
   * 取某个工具的**完整**契约。
   *
   * 这是消费者（调度、超时、沙箱、快照、落盘）唯一的入口 —— 它们不该读
   * `tool.contract?.readOnly` 然后各自补默认值，那等于把刚消灭的「多份真相」
   * 换个地方重建。未注册的工具（MCP 运行时注册等）走 `tool-contract.ts`
   * 里的名字兜底表。
   */
  getContract(id: string): ResolvedToolContract {
    return resolveToolContract(this.tools.get(id)?.contract, id);
  }

  /**
   * 取工具**原始**契约声明（未解析）。
   *
   * 为什么还需要它：`ResolvedToolContract` 只承载**值**（布尔/数值/枚举），
   * 刻意不带函数。而入参归一化（`normalizeInput`）与结果渲染（`renderOutput`）
   * 是**行为**，必须从原始声明上取。两个入口分工明确：
   * - 判据/默认值 ⇒ `getContract()`
   * - 行为钩子 ⇒ `getRawContract()`
   *
   * 分开而不是把函数塞进 `ResolvedToolContract`：后者会被序列化/比较/缓存，
   * 带上函数会让「值契约」变得不可序列化，也会让「契约字段必须有消费者」
   * 那道门禁失去意义。
   */
  getRawContract(id: string): ToolContract | undefined {
    return this.tools.get(id)?.contract;
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values()).filter((t) => !isToolDisabled(t.id));
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.id,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * DSH-style: 创建一个隔离的工具作用域 — 对标 Cordis ctx.isolate('tools').
   *
   * 子作用域继承父作用域的所有工具注册，但在子作用域中 register/remove
   * 只影响子作用域自身，不影响父作用域。这使子智能体可以安全地注册
   * 专属工具（如 report）而不泄漏到主智能体的工具集中。
   */
  createScope(): ToolRegistry {
    return new ScopedToolRegistry(this);
  }

  /**
   * P0-2: Get definitions for tools that are NOT deferred (shouldDefer=false).
   * These tools have their full schema sent to the LLM.
   * Also includes tool_search itself.
   */
  getCoreDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter((t) => !t.shouldDefer)
      .map((t) => ({
        name: t.id,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  /**
   * P0-2: Get compact definitions for deferred tools (shouldDefer=true).
   * Returns minimal info: name + searchHint.
   * The LLM uses tool_search to retrieve the full schema when needed.
   */
  getDeferredDefinitions(): Array<{ name: string; searchHint: string }> {
    return this.getAll()
      .filter((t) => t.shouldDefer)
      .map((t) => ({
        name: t.id,
        searchHint: t.searchHint || t.description.substring(0, 120),
      }));
  }

  /**
   * P0-2: Get the full definition of a single deferred tool by name.
   * Used by tool_search to return the schema when the LLM requests it.
   * Returns undefined if the tool doesn't exist or is not deferred.
   */
  getDeferredDefinition(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool || !tool.shouldDefer) return undefined;
    return {
      name: tool.id,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  async execute(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    /**
     * ## ⚠️ 第 47 轮补（UI/UX 审计 P1）：**禁用必须真的是禁用**
     *
     * 「工具管理」面板写着"禁用的工具不会出现在 LLM 的可用工具列表中"，
     * 而 `codem-disabled-tools` 这个键**全仓没有任何读取方** —— 用户把 `bash`
     * 关掉、行变灰、重启后还是关的（设置真的落库了），但发给模型的工具列表
     * 完全不过滤：**他以为收回了权限，实际一点没变**。安全侧的开关说假话尤其危险。
     *
     * 修法分两层（缺一不可）：
     * 1. **定义层**（`getAll` / `getCoreDefinitions` / `getDeferredDefinitions`）——
     *    直接不把禁用的工具报给模型，模型根本看不到它；
     * 2. **执行层**（这里）—— 拦下任何绕过定义层的调用（历史会话里残留的 tool_call、
     *    委派子会话、插件直接调 `execute`）。只做第 1 层的话，
     *    "禁用"仍然只是"看不见"，不是"调不到"。
     *
     * 返回的是**明确的错误结果**（不是抛异常、也不是静默成功）：模型能看到自己被拒，
     * 用户能在工具卡片上看到原因。
     */
    if (isToolDisabled(toolName)) {
      const reason = `工具「${toolName}」已在「工具管理」中被禁用，本次调用被拒绝`;
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: `Error: ${reason}`,
        status: "error",
        error: reason,
      };
    }
    // 用虚方法 get()（而非 this.tools）以便 ScopedToolRegistry 的 overlay 生效
    const tool = this.get(toolName);
    if (!tool) {
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: `Error: Tool "${toolName}" not found`,
        status: "error",
        error: `Tool "${toolName}" not found`,
      };
    }

    try {
      const result = await tool.execute(args, ctx);
      // 第 84 波（B 类缺陷）：工具失败原来被**无条件**标成 completed。
      // 现在按统一规则判定（见 tool-result-status.ts），显式声明优先、内容型工具不推断。
      const verdict = classifyToolResult(toolName, result.output, result.isError);
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: result.output,
        /**
         * ★ 第 185 波（T5）：**`value` 必须透传** —— 与 `agentic-loop.ts` 那条路径**同形**。
         *
         * 这里原来是"重建一个干净结果对象"，只带 id/name/input/output/status/metadata ——
         * 工具自己产出的结构化 `value` 在这一层被丢掉。而下游
         * `OutputContractValidationMiddleware` 正是靠 `result.value` 做校验：
         * 「声明了 outputSchema 却没有 value」被判成**实现漏了**，把**成功结果改写成
         * `Error: … declared outputSchema but returned no value`**。
         * 声明了 `outputSchema` 的四个工具恰好是主力：`bash` / `read` / `glob` / `grep`
         * ⇒ 经这个入口（`provider/tools-provider.ts:120`、`dsh-compat/index.ts:154`）
         * 的一次**成功**调用会被改写成错误 —— 就是第 97 波在 `agentic-loop` 那条路上
         * 修掉的那场真机事故，只是换了入口。
         *
         * 无条件赋值（与 `agentic-loop.ts:4944` 逐字同形）：`undefined` 与"没有这个键"
         * 对契约判定是同一件事（`result.value === undefined`），不需要额外条件。
         */
        value: result.value,
        status: verdict.status,
        /**
         * ★ 第 185 波（T5）：失败时**只补 `error` 字段，绝不顶掉 `output`**。
         *
         * `output` 里可能装着**部分成功的事实**：`multi_edit` 的
         * `Applied 2/3 edits to x. Errors: …`（`tools.ts:2036-2056`）—— 哪几条落盘了、
         * 哪几条失败，全靠这句话。它首行就是 `Applied …`，`classifyToolResult` 依据
         * 显式 `isError` 判失败并把首行放进 `error`；如果这里反过来用 `error` 覆盖
         * `output`，模型就只看到"失败"、看不到"已经改了哪两条"，也无法定向重试。
         */
        ...(verdict.status === "error" ? { error: verdict.error, errorSource: "tool" as const } : {}),
        // metadata 之前在这里被丢掉（类型里却写着"从 ToolExecuteResult 透传"），
        // 例如 subagent 的 subagentId —— 上层据此判断要不要等待后台子智能体。
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
    } catch (error: any) {
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: `Error: ${error.message}`,
        status: "error",
        error: error.message,
      };
    }
  }
}

/**
 * DSH-style: 隔离的工具作用域 — 对标 Cordis ctx.isolate('tools').
 *
 * 子作用域委托所有读取操作（get/getAll/getDefinitions/execute）给父作用域，
 * 但 register/remove 只影响自身的 overlay Map，不修改父作用域。
 * 子作用域中注册的工具优先于父作用域中的同名工具（shadowing）。
 */
class ScopedToolRegistry extends ToolRegistry {
  private overlay: Map<string, ToolDef> = new Map();
  private removed: Set<string> = new Set();

  constructor(private parent: ToolRegistry) {
    super();
  }

  register(tool: ToolDef): void {
    this.overlay.set(tool.id, tool);
    this.removed.delete(tool.id);
  }

  remove(id: string): boolean {
    const hadInOverlay = this.overlay.delete(id);
    const hadInParent = this.parent.get(id) !== undefined;
    if (hadInParent) {
      this.removed.add(id);
    }
    return hadInOverlay || hadInParent;
  }

  get(id: string): ToolDef | undefined {
    // 第 47 轮补：子作用域的 `get` 同样要过禁用判据 —— `execute` 走的正是 `get`，
    // 只过滤 `getAll` 的话"禁用"仍只是"看不见"，不是"调不到"。
    // （`ToolRegistry.execute` 本身也有一次判据，两处都留着：
    //   一处防"看得见"，一处防"调得到"，任一被绕过都还有另一道。）
    if (isToolDisabled(id)) return undefined;
    if (this.overlay.has(id)) return this.overlay.get(id);
    if (this.removed.has(id)) return undefined;
    return this.parent.get(id);
  }

  getAll(): ToolDef[] {
    const result: ToolDef[] = [];
    const seen: Set<string> = new Set();
    for (const [id, tool] of this.overlay) {
      // 第 47 轮补：overlay（子作用域自注册的工具）也必须过禁用判据 ——
      // 只过滤父作用域的话，子智能体注册的同名/专属工具会绕过用户的开关
      if (isToolDisabled(id)) continue;
      result.push(tool);
      seen.add(id);
    }
    for (const tool of this.parent.getAll()) {
      if (!seen.has(tool.id) && !this.removed.has(tool.id)) {
        result.push(tool);
        seen.add(tool.id);
      }
    }
    return result;
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.id,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  getCoreDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter((t) => !t.shouldDefer)
      .map((t) => ({
        name: t.id,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  getDeferredDefinitions(): Array<{ name: string; searchHint: string }> {
    return this.getAll()
      .filter((t) => t.shouldDefer)
      .map((t) => ({
        name: t.id,
        searchHint: t.searchHint || t.description.substring(0, 120),
      }));
  }

  getDeferredDefinition(name: string): ToolDefinition | undefined {
    const tool = this.get(name);
    if (!tool || !tool.shouldDefer) return undefined;
    return {
      name: tool.id,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  async execute(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const tool = this.get(toolName);
    if (!tool) {
      return {
        id: toolCallId,
        name: toolName,
        input: args,
        output: `Error: Tool "${toolName}" not found`,
        status: "error" as const,
        error: `Tool "${toolName}" not found`,
      };
    }
    // 委托给基类实现 —— 基类用虚方法 this.get()，会命中本作用域的 overlay。
    // （原来这里整段复制了基类逻辑，于是"失败被判成 completed"和"metadata 丢失"
    //   要修两遍；去掉重复实现，只留一处判定。）
    return super.execute(toolCallId, toolName, args, ctx);
  }
}

// ========== Built-in Tools ==========

export function createBashTool(): ToolDef {
  return {
    id: "bash",
    contract: {
      sideEffectScope: "system",
      accessScope: "system",
      timeoutMs: NO_TIMEOUT,
      /**
       * 入参归一化 —— **这是全仓第一个真正使用该钩子的工具**，也是它存在的理由。
       *
       * 解决的问题：此前权限层用 `args.command ?? args.cmd ?? ""` 兜底，而执行层只读
       * `args.command` —— 模型写 `{cmd: "..."}` 时，权限/计划模式看到命令、执行层看到
       * 空串，两层对同一份入参得出不同结论。归一化把别名补齐成**唯一规范形态**，
       * 位置在**权限判定之前**，于是后续所有层看到的都是同一份
       * （zcode 的原话：「此后 hook、项目权限规则、权限事件载荷、handler 读到的
       * 都是同一份归一化输入」；「位置就是全部的意义」）。
       *
       * ⚠️ **刻意不做的事**：不在这里把相对 `workdir` 解析成绝对路径。
       * 归一化钩子只拿得到 `args`，**拿不到 `ctx.cwd`**，而相对路径必须有基准目录
       * 才能解析。我第一版写了 `str(out.cwd)` 去取基准 —— 那个字段在入参里根本不存在，
       * 于是解析会被静默跳过（"看起来在做、其实没做"）。相对路径的解析留在实现里，
       * 那里有真正的 `ctx.cwd`。**要扩展这个钩子的能力（比如传 ctx），得先改签名
       * 并让每个调用点都拿到 ctx，不要在这里用不存在的字段凑。**
       */
      normalizeInput: (a) => {
        const out = { ...a };
        // 别名：模型常用 cmd，规范名是 command
        if (out.command === undefined && typeof out.cmd === "string") out.command = out.cmd;
        delete out.cmd;
        return out;
      },
      /**
       * 第 122 轮 D 项：`bash` 的结果契约（调用量第 1 的工具）。
       * 渲染逐字复现旧行为，见 `renderBashOutput` 与 `execute` 里的注释。
       */
      outputSchema: BASH_OUTPUT_SCHEMA,
      renderOutput: (v) => renderBashOutput(v as never),
    },

    description: "Execute a bash command in the terminal (PowerShell on Windows). The system automatically sets UTF-8 encoding (chcp 65001) and PYTHONUTF8=1. Output includes stdout, stderr, and exit code. If output contains garbled characters (乱码), the source command may be outputting in GBK — do NOT retry with a different tool, adjust the command instead. For long-running commands (builds, tests, dependency installations), set a higher timeout_ms.",
    guidance: "Use bash for any shell command: build, test, git, install dependencies, run scripts. Prefer workdir over `cd`. For long-running commands, set a higher timeout_ms.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        workdir: { type: "string", description: "Working directory (optional)" },
        timeout_ms: {
          type: "number",
          description: "Maximum wait time in milliseconds. Defaults to 30000 (30s). Use higher values for long-running commands like builds, tests, or dependency installations (e.g. 120000 for cargo build, 300000 for large pip installs). Maximum 600000 (10min).",
        },
      },
      required: ["command"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      // 用 `str()` 而不是 `args.command as string`：后者在模型漏参时是 `undefined`，
      // 下面 `command.match(...)` 会抛 TypeError，被 catch 包成
      // 「Cannot read properties of undefined (reading 'match')」这种看不懂的内部错。
      // 现在缺参数会走到下面显式的那条提示（且带 `errorSource: "tool"`，
      // 模型能自行纠正、不累加连续错误）。
      let command = str(args.command) ?? "";
      if (!command) {
        return {
          title: "bash",
          output:
            "Error: Missing required parameter `command` (a non-empty string). " +
            "Example: bash({ command: \"git status\" })",
          isError: true,
        };
      }
      let workdir = str(args.workdir) || ctx.cwd;
      // python -c 中文 编码规避写入的临时文件路径；执行后必须删除，避免项目下堆积 __pyc_temp_*.py
      let tempFile: string | null = null;

      // Auto-detect "cd <path> && <rest>" pattern and split into workdir + rest.
      // This lets the LLM use natural shell syntax without needing to know about
      // the workdir parameter. The runtime handles it transparently.
      const cdMatch = command.match(/^\s*cd\s+["']?([^'"\&]+?)["']?\s*&&\s*(.+)$/s);
      if (cdMatch) {
        const cdPath = cdMatch[1].trim();
        const rest = cdMatch[2].trim();
        // Resolve relative cd path against current workdir
        if (cdPath && !cdPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cdPath)) {
          const sep = workdir.includes("/") && !workdir.includes("\\") ? "/" : "\\";
          workdir = workdir.replace(/[\\/]+$/, "") + sep + cdPath;
        } else {
          workdir = cdPath;
        }
        command = rest;
        console.log(`[bash tool] Auto-split cd: workdir="${workdir}", command="${command.substring(0, 80)}"`);
      }

      // P0+: Encoding safety net — handle edge cases that the Rust backend's
      // chcp 65001 + PYTHONUTF8=1 doesn't fully cover.
      //
      // 1. `python -c "中文"` — Command-line args go through Windows code page
      //    conversion. Even with PYTHONUTF8=1, the args themselves can get
      //    mangled. Fix: rewrite to use a temp file with UTF-8 BOM.
      // 2. `.bat/.cmd` execution — Batch files default to ANSI encoding; if the
      //    LLM wrote one with Chinese content (UTF-8 no BOM), cmd.exe garbles it.
      //    Fix: prepend chcp 65001 explicitly (Rust layer sets it for PowerShell,
      //    but cmd.exe subprocesses need it re-asserted).
      const hasNonAscii = /[^\x00-\x7F]/.test(command);

      // Detect `python -c "..."` or `python -c '...'` with non-ASCII content
      const pythonCMatch = command.match(/^(\s*python(?:3)?\s+-c\s+)(["'])([\s\S]*?)\2\s*$/);
      if (pythonCMatch && hasNonAscii) {
        const prefix = pythonCMatch[1];
        const scriptBody = pythonCMatch[3];
        // Write to a temp file and execute that instead — avoids command-line
        // encoding conversion entirely. File is written as UTF-8 by Rust backend.
        tempFile = `${workdir.replace(/[\\/]+$/, "")}\\__pyc_temp_${Date.now()}.py`;
        try {
          await writeFile(tempFile, `# -*- coding: utf-8 -*-\n${scriptBody}`, { workspace: ctx.workspace || ctx.cwd });
          command = `${prefix.replace(/-c\s+$/, "")} "${tempFile}"`;
          console.log(`[bash tool] Rewrote python -c with non-ASCII to temp file: ${tempFile}`);
        } catch (e) {
          console.warn(`[bash tool] Failed to write temp file for python -c rewrite:`, e);
          // Fall through — let the original command run; PYTHONUTF8=1 may still save it
          tempFile = null;
        }
      }

      // Detect .bat/.cmd execution — prepend chcp 65001 to ensure the batch
      // interpreter uses UTF-8 code page (PowerShell's chcp doesn't propagate
      // to cmd.exe subprocesses in all cases)
      if (/\.(bat|cmd)\b/i.test(command) && !command.includes("chcp")) {
        command = `chcp 65001 >nul && ${command}`;
        console.log(`[bash tool] Prepended chcp 65001 for .bat/.cmd execution`);
      }

      // LLM can specify timeout; clamp to safe range
      const requestedTimeout = (args.timeout_ms as number) || 30000;
      const timeoutMs = Math.max(5000, Math.min(requestedTimeout, 600000));

      // 超时/取消监听 — 声明在 try 外以便 finally 清理（防泄漏）
      let timeoutController: AbortController | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timeoutAbortFn: (() => void) | null = null;
      let externalAbortFn: (() => void) | null = null;

      try {
        // 超时 + 外部取消（用户中止会话）。竞速胜出后清理所有监听防泄漏。
        timeoutController = new AbortController();
        timer = setTimeout(() => timeoutController?.abort(), timeoutMs);

        // 已取消则直接返回，不 spawn 命令（对标 dsh abort 语义）
        if (ctx.abort?.aborted) {
          return { title: `bash: ${command.substring(0, 50)}`, output: "Error: Command cancelled", isError: true };
        }

        const data = await Promise.race([
          // FIX: 传 timeoutMs 给 Rust — 超时时 Rust 真正杀进程树（之前前端
          // Promise.race 只是放弃 Promise，底层命令仍在后台跑）。
          executeCommand(command, workdir, timeoutMs),
          new Promise<never>((_, reject) => {
            timeoutAbortFn = () => {
              reject(new Error(`Command timed out after ${timeoutMs}ms. If this is a long-running command (build, test, install), try again with a higher timeout_ms value.`));
            };
            externalAbortFn = () => {
              reject(new Error("Command cancelled"));
            };
            timeoutController!.signal.addEventListener("abort", timeoutAbortFn);
            // FIX(对标 dsh abort 语义): 用户取消/会话中止时立即返回，而不是让
            // 命令继续跑到超时（之前最长等 600s）。Rust 侧 timeout_ms 兜底杀进程树。
            if (ctx.abort?.aborted) {
              externalAbortFn();
            } else {
              ctx.abort?.addEventListener("abort", externalAbortFn);
            }
          }),
        ]);

        if (timer) clearTimeout(timer);

        const exitCode = (data as any).exitCode;
        const output = data.stdout || data.stderr || "(no output)";
        /**
         * 第 122 轮 D 项：`bash` 的结果契约（调用量第 1 的工具）。
         *
         * 渲染保持与旧行为**逐字一致**（`renderBashOutput` 就是原来那两行的搬运）：
         * 注册契约不该改变模型看到的东西，否则就是偷偷改了行为。
         * `value.output` 存的是**原始输出体**（`stdout || stderr || "(no output)"`），
         * 不是拆开的 stdout/stderr —— 拆字段会改变"任一非空就只用那个"这个既有行为。
         */
        const bashValue = { command, output, ...(exitCode !== undefined ? { exitCode } : {}) };
        const formatted = renderBashOutput(bashValue);
        // Extract file paths from output for structured metadata
        const filePaths = extractFilePathsFromText(output);
        return {
          title: `bash: ${command.substring(0, 50)}`,
          output: formatted, isError: false,
          value: bashValue,
          metadata: filePaths.length > 0 ? { file_paths: filePaths } : undefined,
        };
      } catch (error: any) {
        return { title: `bash: ${command.substring(0, 50)}`, output: `Error: ${error.message}`, isError: true };
      } finally {
        // 清理超时/取消监听（含 catch 路径，防泄漏）
        if (timeoutController && timeoutAbortFn) {
          timeoutController.signal.removeEventListener("abort", timeoutAbortFn);
        }
        if (externalAbortFn && ctx.abort) {
          ctx.abort.removeEventListener("abort", externalAbortFn);
        }
        if (timer) clearTimeout(timer);
        // 删除 python -c 编码规避的临时脚本 —— 它是工具内部产物，不是用户要保留的文件。
        // 若不删除，每次含中文的 python -c 都会在项目下留下 __pyc_temp_*.py 垃圾文件，
        // 且这些文件不经过 write 工具，generatedFiles 收集不到 → 清理按钮也不显示。
        if (tempFile) {
          try {
            await deletePath(tempFile);
            console.log(`[bash tool] Cleaned up temp file: ${tempFile}`);
          } catch (e) {
            console.warn(`[bash tool] Failed to delete temp file ${tempFile}:`, e);
          }
        }
      }
    },
  };
}

/**
 * P0-FIX: Incremental line extraction — the performance-critical replacement
 * for `content.split("\n").slice(...).map(...).join("\n")`.
 *
 * Problem: `split("\n")` on a 50 MB file creates an array of millions of
 * strings, consuming ~2× the file size in memory and blocking the JS event
 * loop for the entire split + slice + map + join duration (often seconds).
 *
 * Solution: Scan the content string with `indexOf("\n", prev)` to find only
 * the line boundaries in the [offset, offset+limit) range. Each line is
 * extracted with `substring` and appended to an output array. This touches
 * only the bytes in the requested range — O(limit) memory and O(content
 * scanned) CPU, not O(content × 2) memory.
 *
 * This is the same design principle as DSH's `TextRetainer`: only
 * materialise the bytes you need, never the full stream.
 *
 * @param content  Full file content (already read into memory by the caller)
 * @param offset   1-indexed line number to start from
 * @param limit    Maximum number of lines to read
 * @param maxChars Hard cap on output length (truncates if exceeded)
 * @returns 正文（带行号）与**单独的**提示行（第 122 轮：提示不再拼进正文，
 *          见函数末尾注释 —— `read` 的可见文本现在由 `renderReadOutput` 统一渲染）
 */
function extractLinesIncremental(
  content: string,
  offset: number,
  limit: number,
  maxChars: number,
): { content: string; notices: string[]; diagnostics: ToolDiagnostic[] } {
  const len = content.length;
  // Fast path: skip to the start line using indexOf
  let lineStart = 0;
  let currentLine = 1; // 1-indexed

  // Advance to the offset-th line
  while (currentLine < offset && lineStart < len) {
    const next = content.indexOf("\n", lineStart);
    if (next === -1) {
      // Fewer lines than offset — file is shorter than requested。
      // 第 122 轮：返回值改成 `{content, notices}` 之后这条早退**也必须跟着改**
      // —— 漏掉它会让 "offset 超过文件长度" 这条路径返回字符串，
      // 下游 `extracted.content` 就是 `undefined`（真跑一次构建才暴露：
      // `tsc` 报 `Type 'string' is not assignable to type '{ content; notices }'`）。
      return { content: `[End of file: only ${currentLine} line(s)]`, notices: [], diagnostics: [] };
    }
    lineStart = next + 1;
    currentLine++;
  }

  // Collect lines from offset to offset+limit (or end of content)
  const parts: string[] = [];
  let totalChars = 0;
  let lineEnd: number;
  let linesCollected = 0;
  let hasMore = false;

  while (linesCollected < limit && lineStart < len) {
    lineEnd = content.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      // Last line (no trailing newline)
      if (lineStart < len) {
        const line = content.substring(lineStart);
        const numbered = `${offset + linesCollected}: ${line}`;
        if (totalChars + numbered.length > maxChars) {
          hasMore = true;
          break;
        }
        parts.push(numbered);
        totalChars += numbered.length + 1; // +1 for the join \n
        linesCollected++;
      }
      break;
    }

    const line = content.substring(lineStart, lineEnd);
    const numbered = `${offset + linesCollected}: ${line}`;
    if (totalChars + numbered.length > maxChars) {
      hasMore = true;
      break;
    }
    parts.push(numbered);
    totalChars += numbered.length + 1;
    linesCollected++;
    lineStart = lineEnd + 1;
  }

  // Check if there are more lines after what we collected
  if (!hasMore && lineStart < len) {
    hasMore = true;
  }

  let output = parts.join("\n");
  /**
   * 第 122 轮 D 项：提示行不再拼进正文，而是**单独返回**。
   *
   * 原因：`read` 现在注册了 `outputSchema`，模型可见文本由 `renderReadOutput`
   * 统一渲染。如果这里把提示拼进 `content`，那条提示就会变成"文件内容的一部分"
   * 被裹进数据边界里 —— 而它其实是**元信息**。拆出来之后两条路径
   * （Rust 分页 / 这里）给渲染器的形状一致，措辞与顺序逐字不变。
   */
  /**
   * 第 183 波：分页/截断不再写成"看起来像正文的括号文本"，而是**结构化诊断**
   * （渲染成 `<harness>` 块，见 `tool-diagnostics.ts`）。
   *
   * 这一条路径（legacy 逐行读取）**拿不到**总行数与精确丢弃量 —— 所以只说它知道的
   * （"给的是第 X-Y 行"）。**宁可说得少，也不许编数字**：截断量说错比不说更糟，
   * 模型会据此判断该不该继续翻页。
   */
  const diagnostics: ToolDiagnostic[] = [];
  if (hasMore) {
    diagnostics.push(pagedDiagnostic(offset, offset + linesCollected - 1));
  }
  if (totalChars >= maxChars) {
    diagnostics.push({
      severity: "warn",
      code: "truncated",
      message: `Output truncated at the ${maxChars}-char cap. Use offset to read more.`,
    });
  }

  return { content: output, notices: [], diagnostics };
}

export function createReadFileTool(): ToolDef {
  return {
    id: "read",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      persistResult: false,
      /**
       * 第 122 轮 D 项：`read` 的结果契约。
       *
       * 这个工具为什么**值得**注册（而不是凑覆盖率）：它是调用量第 2 的工具，
       * 而且它的输出要经过一整块数据边界包装（防注入，见 `renderReadOutput`）。
       * 包装一旦被误改，模型会把文件内容当指令读 —— 这是本仓最贵的一类缺陷，
       * 值得有一个**声明**把它钉住。
       */
      outputSchema: READ_OUTPUT_SCHEMA,
      renderOutput: (v) => renderReadOutput(v as ReadOutputValue),
    },
    guidance: "Use read to view file contents. Use offset/limit for large files; pass line_numbers: true when you need line numbers (e.g. to anchor an edit or refer to a position). After a write or edit, the tool result confirms success — do NOT re-read the file you just wrote.",
    description: "Read a file from the filesystem. Files are read as UTF-8 text. BOM (Byte Order Mark) is automatically stripped. Chinese and emoji content is fully supported.",
    // Never persist read results to disk — prevents infinite loops
    // (read → result too large → persist → LLM reads persisted file → result too large → ...)
    maxResultSizeChars: Infinity,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to read" },
        offset: { type: "number", description: "Line number to start from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
        // 第 113 波：需要行号（改代码、对着 diff 说话、指位置）时打开它，**不要**为此去 shell
        // （`node -e` / `python -c` 打印带行号的区间）—— 实测我们这样绕道过，多花调用还容易踩引号。
        line_numbers: {
          type: "boolean",
          description:
            "Prefix every line with its 1-based line number. Use this instead of shelling out to print numbered lines.",
        },
      },
      required: ["path"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const path = args.path as string;
      const offset = (args.offset as number) || 1;
      const limit = (args.limit as number) || 2000;
      /** 第 113 波：要行号时给每行加编号（见 READ 的 `line_numbers` 说明） */
      const lineNumbers = args.line_numbers === true;
      // 单次 read 结果上限（字符）：对齐 dsh-desktop read 上限（READ_MAX_BYTES≈50KB）。
      // 此前 100k 字符单次返回（中文内容 ≈300KB 字节）会把大半上下文一次性撑满，
      // 是"同样任务 token 比 dsh 大数倍"的主因之一。50k 字符 ≈ 代码/英文 12k tokens。
      const MAX_CHARS = 50_000;

      try {
        let output: string = "";

        // P0-FIX: Route through Rust's read_file_lines for paginated reading.
        // This is the primary path — the full file content never crosses IPC,
        // so files of any size (hundreds of MB, thousands of pages) work without
        // freezing the JS event loop. Rust's BufReader lazily iterates lines,
        // only collecting the [offset, offset+limit) range into memory.
        //
        // Falls back to readFile + extractLinesIncremental when:
        //   - FileSystemSeam is registered (non-Tauri/test mode), or
        //   - read_file_lines command is unavailable
        let usedRustPaginated = false;
        /**
         * 第 122 轮 D 项：`read` 注册 `outputSchema`。
         *
         * 模型可见正文的**唯一来源**是 `renderReadOutput`（`tool-output-shapes.ts`），
         * 这里只负责把"读到了什么 + 要附哪条提示"填进去。提示行是**原文**而不是几个数字：
         * 分页/截断提示在两条路径上措辞不同（Rust 侧带上限字符数、legacy 侧不带），
         * 让渲染器按数字重拼就得假定走的是哪条路 —— 那是**悄悄改模型看到的文本**。
         */
        let readValue: ReadOutputValue | null = null;

        // Try the Tauri read_file_lines command first
        if (typeof window !== "undefined" && (window as any).__TAURI__) {
          try {
            const { readFileLines } = await import("../file-api");
            const result = await readFileLines(path, offset, limit, MAX_CHARS);
            output = result.text;
            /**
             * 第 181 波（T-3）：**精确**的丢弃计数；第 183 波把它做成**结构化诊断**。
             *
             * 改前这里用 `offset + Math.ceil(text.length / 80) - 1` **猜**结束行号
             * （文件里有长行就偏得离谱），而且完全不告诉模型**还差多少**。
             * 现在结束行号与丢弃量都由 Rust 侧的同一次扫描给出，并渲染成
             * `<harness>` 块（形态固定、可被 UI 解析、不会与被读内容混淆）。
             */
            const diagnostics: ToolDiagnostic[] = [];
            if (result.hasMore) {
              diagnostics.push(
                truncatedDiagnostic(result.droppedLines, result.droppedChars, result.totalLines),
              );
            }
            /**
             * 原始 `output` 也带上同一份诊断（逐字相同的块）。
             *
             * 为什么两处都要：`readValue` 是**注册了契约之后**模型看到的权威来源；
             * 而 `output` 是回退路径（以及 UI/日志里显示的文本）。两者若不一致，
             * 就又回到"同一个事实两份措辞"的老问题上了。
             */
            output = appendDiagnostics(output, diagnostics);
            // 行号字段**不在这里**加：最终 `value` 在下面统一重建（那里是权威位置，
            // 也是唯一能被渲染器看到的地方 —— 在这儿加等于写了个没人读的字段）。
            readValue = { path, content: result.text, notices: [], diagnostics };
            usedRustPaginated = true;
          } catch (e: any) {
            // read_file_lines failed — could be file not found, permission error,
            // or command not registered. If it's a "command not found" error,
            // fall through to the legacy path. Otherwise surface the error.
            if (!e.message?.includes?.("not a function") && !e.message?.includes?.("read_file_lines")) {
              /**
               * 文件系统错误 —— **必须显式声明失败**（第 97 波）。
               *
               * `read` 是**内容型工具**（`tool-result-status.ts` 的 `CONTENT_TOOLS`）：它的输出是数据，
               * 首行恰好是 `Error:` 也可能只是文件内容，所以分类器**不推断**。
               * 于是"读一个不存在的文件"原来被报成 `completed` —— 一次**假成功**；
               * 而它又声明了 `outputSchema`，"没给 value"还会被契约层换成
               * `read declared outputSchema but returned no value`，把**真正的原因**顶掉。
               * 显式 `isError: true` 两条一起解决：状态诚实、文本原样透传。
               */
              return { title: `read: ${path}`, output: `Error: ${e.message}`, isError: true };
            }
            // Command not found — fall through to legacy path
          }
        }

        if (!usedRustPaginated) {
          // Legacy path: read full file, then extract lines incrementally.
          // Used when read_file_lines is unavailable or FileSystemSeam is active.
          let content: string;
          const useCache = offset === 1 && limit >= 2000;
          if (useCache) {
            const cached = fileCache.get(path);
            if (cached !== null) {
              content = cached;
            } else {
              content = await readViaSeam(path, ctx.cwd);
              fileCache.set(path, content);
            }
          } else {
            content = await readViaSeam(path, ctx.cwd);
          }
          const extracted = extractLinesIncremental(content, offset, limit, MAX_CHARS);
          output = appendDiagnostics(extracted.content, extracted.diagnostics);
          readValue = {
            path,
            content: extracted.content,
            notices: extracted.notices,
            diagnostics: extracted.diagnostics,
          };
        }

        /**
         * 第 122 轮 D 项：`read` 注册 `outputSchema` 之后，模型可见文本由
         * `renderReadOutput` 统一渲染。这里要保证**一个字符都不变**地复现原实现：
         *
         * 原来是
         * ```
         * output = <正文> + (提示行，各路径自己拼)
         * filteredOutput = output.replace(/<system-reminder>…/g, "").trim()
         * wrapped = [边框, "", `文件: ${path}`, "", filteredOutput, "", 边框].join("\n")
         * ```
         *
         * 所以：① 先把正文与提示行按原顺序拼回**同一串**再过滤+trim
         * （`.trim()` 的作用范围必须和原来一样覆盖到提示行）；
         * ② 再把提示行按**精确后缀**摘下来交给 `renderReadOutput`
         * —— 提示行是本函数自己按 `\n` 拼的，摘除是精确定义的，不是启发式。
         */
        const notices = readValue?.notices ?? [];
        const filtered = [readValue?.content ?? output, ...notices]
          .join("\n")
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .trim();
        // ② 精确摘除尾部提示（已被 trim，所以不带尾部空白）
        const noticeSuffix = notices.join("\n");
        const contentFinal =
          noticeSuffix && filtered.endsWith(noticeSuffix)
            ? filtered.slice(0, filtered.length - noticeSuffix.length - 1)
            : filtered;
        const value: ReadOutputValue =
          noticeSuffix && filtered.endsWith(noticeSuffix)
            ? {
                path,
                content: contentFinal,
                notices,
                // 第 113 波：行号开关必须**跟着重建的对象一起走** ——
                // 第一版只在上面两条路径上加了这两个字段，而这里会把对象**整个重建**，
                // 于是渲染器永远收不到 lineNumbers：单元测 `renderReadOutput` 会绿、
                // 真机路径却一个行号都没有（这正是"判据长在没人走的链路上"的老毛病）。
                ...(lineNumbers ? { lineNumbers: true, startLine: offset } : {}),
                // 第 183 波：**诊断也必须跟着重建一起走** —— 与上面行号开关是同一个坑
                // （重建对象会丢掉没显式带上的字段）。`diagnostics` 是渲染器唯一的输入，
                // 这里漏了它，模型就永远看不到"你只读到一部分"。
                ...(readValue?.diagnostics?.length ? { diagnostics: readValue.diagnostics } : {}),
              }
            : {
                path,
                content: filtered,
                ...(lineNumbers ? { lineNumbers: true, startLine: offset } : {}),
                ...(readValue?.diagnostics?.length ? { diagnostics: readValue.diagnostics } : {}),
              };
        /**
         * 第 95 波：**读到 = 观察到**（`fs-observation-policy` 的写入前置条件靠这条记录）。
         *
         * 记的是"这一版"（`size:mtime` 令牌），不是内容哈希 —— 因为 `read` 是分窗读取，
         * 手里从来没有整份内容。取不到令牌就记 `null`（策略层对"无法比对"有明确退化处置）。
         */
        await noteObservedPresent(ctx.sessionId, path);
        return {
          title: `read: ${path}`,
          output: renderReadOutput(value), isError: false,
          value,
        };
      } catch (error: any) {
        /**
         * 读失败也分两种：**确认不存在**要记成 `absent`（它让后续 `createIfAbsent` 有意义，
         * 也让"我以为它不存在，其实它是被建出来的"能被识别为过期观察）；其它失败（权限/IPC）
         * 不记，因为"读不到"不等于"不存在"（本仓库的既有纪律）。
         */
        await noteObservedIfMissing(ctx.sessionId, path);
        // 第 97 波：内容型工具的失败必须**显式**声明（否则被报成 completed，见上面那条注释）
        return { title: `read: ${path}`, output: `Error: ${error.message}`, isError: true };
      }
    },
  };
}

export function createWriteFileTool(): ToolDef {
  return {
    id: "write",
    contract: { sideEffectScope: "workspace", timeoutMs: NO_TIMEOUT },
    guidance: "Use write to create new files or completely replace existing ones. Include the COMPLETE final content in a single call. For appending or small changes, use edit instead. IMPORTANT: for very large files (roughly over 200 lines), do NOT try to emit everything in one call — the tool arguments can be truncated by the output limit. Instead write the first chunk, then append the remaining chunks with write + append: true. After writing, when you mention the file in your response, ALWAYS use a Markdown link with the full path: [filename](./path/to/file). This lets the user click to open it.",
    description: "Write content to a file (creates or overwrites). Files are saved as UTF-8 without BOM. Chinese and emoji content is fully supported. For Python scripts, include '# -*- coding: utf-8 -*-' as the first line. WARNING: This tool overwrites the entire file. If the file already exists and you only need to change a few lines, use the 'edit' tool instead to avoid losing existing content. For large files, pass append: true on subsequent calls to add content to the end instead of overwriting.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to write" },
        content: { type: "string", description: "The content to write" },
        append: {
          type: "boolean",
          description:
            "第 66 波：为 true 时把 content **追加**到文件末尾（而不是覆盖）。生成大文件时用它分块写入：" +
            "第一次不带 append（或 append:false）写第一段，之后每次 append:true 追加一段（建议每段 ≤200 行）。",
        },
      },
      required: ["path", "content"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const path = args.path as string;
      const content = args.content as string;
      const append = args.append === true;

      // 第 66 波：内容型工具必须拿到"真正的字符串内容"。
      // 参数被截断时循环已经拒绝执行，这里再兜一层：content 不是字符串 → 直接报错，
      // 绝不用空值去覆盖文件（旧逻辑在截断时会走到 content:""，会把已有文件清空）。
      if (typeof content !== "string") {
        return {
          title: `write: ${path}`,
          output:
            `Error: 'content' must be a string (received ${content === undefined ? "undefined" : typeof content}). ` +
            `This usually means the tool arguments were truncated by the output limit — write the file in chunks (append: true) instead of one huge call.`, isError: true,
        };
      }

      // S2: Protected path check
      if (isProtectedPath(path)) {
        return {
          title: `write: ${path}`,
          output: `Error: This path is protected and cannot be written to. Protected paths include .git/, .env, .codem-snapshots/, node_modules/. Use the 'edit' tool for modifying existing files in safe locations.`, isError: true,
        };
      }

      // S5: Sandbox path whitelist check
      const sandboxError = checkSandbox(path, ctx);
      if (sandboxError) {
        return { title: `write: ${path}`, output: `Error: ${sandboxError}`, isError: true };
      }

      /**
       * 第 95 波：**没看过的文件不许覆盖**（对标 DSH 的 `createIfAbsent` / `replaceIfVersion`）。
       *
       * - 目标是**新文件**（当前不存在）⇒ 放行（创建不破坏任何东西）；
       * - 目标**已存在**：没读过 ⇒ `FS_NOT_OBSERVED` 拒绝；读过但版本变了 ⇒ `FS_STALE_OBSERVATION` 拒绝。
       *
       * `append: true` **不走这里**：追加是"往上加"，不破坏已有内容，而且它正是"大文件分块写入"的
       * 落地方式（先写首段、再逐段 append）—— 要求每段之前都先读一遍会把那条流程变成不可用。
       */
      if (!append) {
        const denial = await checkWriteAllowed(ctx.sessionId, path);
        if (denial) return fsPolicyDenialResult(`write: ${path}`, denial);
      }

      try {
        // S1: Overwrite protection — only block when content is completely different AND no confirm callback
        let existingContent: string | null = null;
        try {
          existingContent = await readFile(path);
        } catch {
          // File doesn't exist — proceed with creation
        }

        if (existingContent !== null && existingContent.length > 0 && !append) {
          const similarity = calculateContentSimilarity(existingContent, content);
          if (similarity < OVERWRITE_SIMILARITY_THRESHOLD) {
            // S4: If onWriteConfirm callback is available AND security mode is "ask",
            // ask the user to review the diff.
            // In "auto" and "full" modes, skip the Diff confirmation dialog.
            const secMode = ctx.securityMode || "ask";
            if (ctx.onWriteConfirm && secMode === "ask") {
              console.log(`[write-tool] Requesting user confirmation for overwrite: ${path}`);
              console.log(`[write-tool] existingContent: "${existingContent.substring(0, 100)}" (${existingContent.length} bytes)`);
              console.log(`[write-tool] newContent: "${content.substring(0, 100)}" (${content.length} bytes)`);
              const confirmResult = await ctx.onWriteConfirm({
                filePath: path,
                existingContent,
                newContent: content,
              });
              console.log(`[write-tool] User confirmation result: ${JSON.stringify(confirmResult)}`);

              if (confirmResult.action === "reject") {
                return {
                  title: `write: ${path}`,
                  output: `Error: User rejected the overwrite of "${path}". Use the 'edit' tool for targeted modifications instead.`, isError: true,
                };
              }

              if (confirmResult.action === "custom") {
                // User provided a custom instruction — return it to the LLM with the current file content
                // The LLM should process the instruction, modify the content, and call write again
                // The next write attempt will trigger confirmation again, so the user can review the LLM's modification
                const instruction = confirmResult.instruction;
                console.log(`[write-tool] User custom instruction: ${instruction}`);
                /**
                 * 第 D10 波：**没写盘就不能报成功**。
                 *
                 * 这条分支的语义是"本次 write 被用户改成一次性指示，文件内容一个字节都没动"，
                 * 但输出以 `Write not executed.` 开头 —— 它既不以 `Error:` 开头，
                 * 也没有 `isError`，而 `write` 不在 `tool-result-status.ts` 的
                 * `CONTENT_TOOLS` 豁免名单里，于是分类器按首行前缀推断得到 `completed`。
                 * 结果：界面上是绿的、`ui-handoff` 把这条路径当成"产出"、
                 * 委派汇报说写完了 —— 与 `tool-result-status.ts` 文件头点名的
                 * 「假成功」缺陷是同一类，只是那一波只覆盖了首行恰好以 `Error:` 开头的路径。
                 */
                return {
                  title: `write: ${path}`,
                  output: `Write not executed. User gave a ONE-TIME custom instruction for this specific write operation: "${instruction}".\n\n[IMPORTANT: This instruction applies ONLY to this write. Do not carry it over to future write requests. Each write is independent unless the user explicitly states otherwise.]\n\nCurrent file content (${existingContent.length} bytes):\n---\n${existingContent}\n---\n\nPlease follow the user's instruction to modify the content, then call write again with the complete modified content. The user will review your modification before it is written.`,
                  isError: true,
                };
              }

              // action === "accept" — proceed with the write
            } else {
              console.warn(`[write-tool] onWriteConfirm callback not available, proceeding with overwrite without confirmation`);
            }
            // No callback: proceed with write (write tool is designed to overwrite)
          }
        }

        // 第 66 波：append 模式 —— 生成大文件时"分块写入"的落点。
        // 追加不会覆盖已有内容，因此跳过覆盖确认；但仍受保护路径/沙箱检查约束（前面已做）。
        const finalContent = append && existingContent ? existingContent + content : content;
        await writeFile(path, finalContent, { workspace: ctx.workspace || ctx.cwd });
        // E4: Invalidate cache after write
        fileCache.invalidate(path);
        // 第 95 波：写盘成功 = 这个会话现在"看到"的是新版本（后续 edit / 再 write 不必重读）
        await noteObservedPresent(ctx.sessionId, path);
        // F3.4: Auto-lint after write
        const lintResult = await autoLint(path);
        const action = append && existingContent ? "Appended" : "Successfully wrote";
        // 第 67 波（同类问题清查）：把**已有非空文件**写成空内容是很危险的静默破坏 ——
        // 合法场景（用户就是想清空）依然放行，但必须在结果里说清楚，让模型有机会发现是自己搞错了。
        const emptiedExisting = !append && content.length === 0 && !!existingContent && existingContent.length > 0;
        const output = lintResult
          ? `${action} ${content.length} bytes to ${path} (total ${finalContent.length} bytes)\n${lintResult}`
          : `${action} ${content.length} bytes to ${path} (total ${finalContent.length} bytes)`;
        return {
          title: `write: ${path}`,
          output: emptiedExisting
            ? `${output}\n\n[WARNING] 你刚刚把**已有文件的全部内容**写成了空（原文件 ${existingContent!.length} 字符）。如果这不是你的本意，请立刻用 write 恢复内容或从版本控制里找回。`
            : output, isError: false,
          metadata: { file_paths: [path] },
        };
      } catch (error: any) {
        return { title: `write: ${path}`, output: `Error: ${error.message}`, isError: true };
      }
    },
  };
}

/**
 * 校验 edit / multi_edit 的字符串参数，把「模型参数写错」变成可行动的提示。
 *
 * ## 为什么需要它
 *
 * 模型写这两个工具时有三种常见错法，旧实现全都变成同一条听不懂的崩溃信息：
 *
 * | 模型的写法 | 旧行为 |
 * | --- | --- |
 * | 蛇形 `old_string` / `new_string`（Anthropic 风格） | `undefined` 一路传下去 → `Cannot read properties of undefined (reading 'length')` |
 * | 漏字段（输出被截断时常见） | 同上 |
 * | 传了 `null` | 同上 |
 *
 * 这三种**都不是内部的 bug，而是模型可以自己修好的输入错误**。所以这里返回
 * 一条说明「哪个参数缺了、是不是写成了蛇形」，模型下一轮就能改对，
 * 而不是花一轮去猜「Cannot read properties」是什么意思。
 *
 * @param names 必填的驼峰参数名
 * @returns 错误说明；`null` 表示参数没问题
 */
function validateEditParams(
  args: Record<string, unknown>,
  names: readonly string[],
): string | null {
  const missing = names.filter((n) => typeof args[n] !== "string");
  if (missing.length === 0) return null;

  // 识别「驼峰写成蛇形」这一具体情形 —— 光说 "missing" 模型可能重复同样的错误
  const snakeHints: string[] = [];
  for (const n of missing) {
    const snake = n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (snake in args) snakeHints.push(`did you mean \`${n}\` instead of \`${snake}\`?`);
  }

  return (
    `Missing required string parameter(s): ${missing.map((n) => `\`${n}\``).join(", ")}. ` +
    (snakeHints.length > 0
      ? `This tool uses camelCase — ${snakeHints.join(" ")} `
      : "") +
    `Required parameters are: ${names.map((n) => `\`${n}\``).join(", ")}.`
  );
}

/**
 * 第 95 波：`fs-observation-policy`（**读后写 + 版本比对**）在工具层的落点。
 *
 * 判据本身是纯函数（`fs-observation.ts` 的 `decideEditIntent` / `decideWriteIntent`），
 * 这里只负责三件事：取当前版本令牌、取本会话的观察、把拒绝结果变成模型看得懂的返回值。
 * 为什么判定放在**工具自己的 execute 里**而不是某个包装层：本仓库的规矩是
 * 「在做出决定的那一次操作里执行它」—— 包装/闸门层可以被别的调用点绕过。
 */

/** 把策略拒绝变成工具返回值（`isError` 让分类器按失败算，不再出现"没写盘却报成功"） */
function fsPolicyDenialResult(title: string, denial: FsPolicyDenial) {
  return { title, output: `Error: ${denial.message}`, isError: true as const };
}

/** 记下"这个会话现在看到的是这一版"（读/写成功之后调用；拿不到令牌就记 `null`） */
async function noteObservedPresent(sessionId: string | undefined, path: string): Promise<void> {
  if (!sessionId || !path) return;
  // 观察是**旁路记账**：取不到令牌绝不能反过来把一次成功的读/写变成失败（所以用不抛的那条路）
  const version = await currentVersionOrUnknown(path);
  getFsObservationPolicy().observe(sessionId, path, "present", typeof version === "string" ? version : null);
}

/** 记下"这个会话确认这个路径不存在"（`read` 失败且当前确实不存在时调用） */
async function noteObservedIfMissing(sessionId: string | undefined, path: string): Promise<void> {
  if (!sessionId || !path) return;
  const version = await currentVersionOrUnknown(path);
  if (version === null) getFsObservationPolicy().observe(sessionId, path, "absent", null);
}

/**
 * 取文件当前版本令牌，**三态**：
 * - `string` = 拿到了（可以比对）；
 * - `null` = **确认不存在**；
 * - `undefined` = **不知道**（拿不到令牌：IPC 不可用 / 命令没注册 / 权限）。
 *
 * 为什么必须区分后两者：把"读不到"当成"不存在"正是本仓库反复打的那类缺陷
 * （`file-api.fileVersion` 的注释与 `session-jsonl` 的 `isFileMissingError` 同一条纪律）。
 * 策略层对 `undefined` 的处置写在 `fs-observation.ts` 的判定函数里（**不谎报状态**）。
 */
async function currentVersionOrUnknown(path: string): Promise<string | null | undefined> {
  try {
    return await fileVersion(path);
  } catch (e) {
    console.warn(`[fs-observation] 取不到 "${path}" 的版本令牌（按"不知道"处理，不谎报状态）:`, e);
    return undefined;
  }
}

/** `edit` / `multi_edit` 的前置判定：`null` = 放行 */
async function checkEditAllowed(sessionId: string | undefined, path: string): Promise<FsPolicyDenial | null> {
  // 没有会话归属 ⇒ 不启用（见 `fs-observation.ts` 模块头的取舍说明）
  if (!sessionId || !path) return null;
  const current = await currentVersionOrUnknown(path);
  const decision = decideEditIntent(path, getFsObservationPolicy().get(sessionId, path), current);
  return decision.ok ? null : decision;
}

/** `write`（覆盖）的前置判定：`null` = 放行。`append` 模式不走这里（追加不破坏已有内容） */
async function checkWriteAllowed(sessionId: string | undefined, path: string): Promise<FsPolicyDenial | null> {
  if (!sessionId || !path) return null;
  const current = await currentVersionOrUnknown(path);
  const decision = decideWriteIntent(path, getFsObservationPolicy().get(sessionId, path), current);
  return decision.ok ? null : decision;
}

export function createEditFileTool(): ToolDef {  return {
    id: "edit",
    contract: { sideEffectScope: "workspace", timeoutMs: NO_TIMEOUT },
    guidance: "Use edit to modify existing files by replacing exact strings. The old_string must match exactly (including whitespace). For multiple edits in one file, use multi_edit instead. After editing, when you mention the file in your response, ALWAYS use a Markdown link with the full path: [filename](./path/to/file). This lets the user click to open it.",
    description: "Edit a file by replacing exact string matches. This is preferred over 'write' for modifying existing files because it preserves the rest of the file content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to edit" },
        oldString: { type: "string", description: "The exact string to replace" },
        newString: { type: "string", description: "The replacement string" },
      },
      required: ["path", "oldString", "newString"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const path = args.path as string;
      const oldString = args.oldString as string;
      const newString = args.newString as string;

      // 参数校验：模型常见两种写错方式 —— 用蛇形 `old_string`/`new_string`
      // （Anthropic 风格），或漏字段。缺字段时值是 `undefined`，若直接往下传会变成
      // 「Cannot read properties of undefined」这种**内部崩溃信息**，
      // 模型既看不懂也不知道该怎么改。这里显式回一条可行动的错误。
      const paramError = validateEditParams(args, ["oldString", "newString"]);
      if (paramError) {
        return { title: `edit: ${path}`, output: `Error: ${paramError}`, isError: true };
      }

      // S2: Protected path check
      if (isProtectedPath(path)) {
        return {
          title: `edit: ${path}`,
          output: `Error: This path is protected and cannot be edited. Protected paths include .git/, .env, .codem-snapshots/, node_modules/.`, isError: true,
        };
      }

      // S5: Sandbox path whitelist check
      const sandboxError = checkSandbox(path, ctx);
      if (sandboxError) {
        return { title: `edit: ${path}`, output: `Error: ${sandboxError}`, isError: true };
      }

      /**
       * 第 95 波：**读后写**（`FS_NOT_OBSERVED` / `FS_STALE_OBSERVATION`）。
       *
       * 放在 `readFile` 之前：这条判定要回答的是"你凭什么认为你知道这个文件现在长什么样"，
       * 一旦没读过（或读完之后文件被改过），`oldString` 就是**猜的**，改错地方只是时间问题。
       */
      {
        const denial = await checkEditAllowed(ctx.sessionId, path);
        if (denial) return fsPolicyDenialResult(`edit: ${path}`, denial);
      }

      try {
        const content = await readFile(path);

        /**
         * 第 D8 波：**歧义即拒**（对标 DSH 的 `FS_AMBIGUOUS_EDIT`）。
         *
         * `replaceLiteral` 只换第一处，而 `oldString` 在文件里出现两次以上时，
         * 「第一处」可能**不是**模型想改的那一处 —— 旧实现照样写盘、照样返回
         * 「Successfully edited」，模型拿着成功信号继续往下走，用户要等到
         * build/test 失败才发现改错了地方。
         *
         * 判据与 `edit-matchers.ts` 里 `suggestEditCandidates` 的设计取舍保持一致：
         * 「候选值不唯一时明确说『有 N 处』，而不是挑一个」—— 精确命中同理。
         *
         * 放在 `replaceLiteral` **之前**：一旦发现歧义就绝不调用替换，也就不可能写盘。
         * `oldString === newString` 时同样拒绝：没有歧义的意图才配得到一次（无变化的）
         * 写盘，而「两处都长得一样」正说明意图没有唯一确定；拒绝的代价是零字节改动。
         */
        /**
         * 第 113 波：**容忍"从带行号的读取里复制过来"的锚点**。
         *
         * 有了 `read({ line_numbers: true })` 之后，模型很可能连行号一起复制进 `oldString`
         * （`1406\tconst x = 1;`）。若直接拿它去精确匹配，必然匹配不到 ⇒ 报"oldString not found"，
         * 而模型不知道为什么（它看到的就是带行号的文本）。这里在匹配前**逐行剥掉行号前缀**，
         * 让"复制带行号的整段"也能改成功 —— 与 `read` 的新能力配对，少一类无谓的失败。
         */
        const stripLineNumberGutter = (text: string): string =>
          text
            .split("\n")
            .map((line) => line.replace(/^\s*\d+\t/, ""))
            .join("\n");
        /**
         * **先去行号"是退路"，不是默认动作**（第 116 波自查修正）。
         *
         * 第一版无条件剥掉 `^\d+\t` —— 但那是**破坏性**的：如果锚点本身就是制表符分隔的数据
         * （`42\tvalue` 这种 TSV 行），剥完就变成 `value`，可能匹配到**别的地方**，
         * 甚至把不该改的行改掉。所以改成"**精确命中优先，命中不了再退到去行号重试**"：
         *  · 字面量真的存在 ⇒ 按字面量改（TSV 那类内容不会被破坏）；
         *  · 字面量不存在（模型从带行号的读取里整段复制过来了）⇒ 去掉行号再试。
         * 两个方向各有判据（LN-6 钉前者、LN-3 钉后者）。
         */
        const oldStringNoGutter = stripLineNumberGutter(oldString);
        const newStringNoGutter = stripLineNumberGutter(newString);
        const exactExists = replaceLiteral(content, oldString, newString) !== null;
        const effectiveOldString = exactExists ? oldString : oldStringNoGutter;
        const effectiveNewString = exactExists ? newString : newStringNoGutter;

        const ambiguous = findAmbiguousLiteral(content, effectiveOldString);
        if (ambiguous) {
          return {
            title: `edit: ${path}`,
            output:
              `Error: oldString appears ${ambiguous.count} times (lines ${ambiguous.lines.join(", ")}) ` +
              `— include more surrounding context to make it unique. Nothing was written.`,
            isError: true,
          };
        }

        // 用 replaceLiteral 而非 content.replace(oldString, newString)：
        // 后者会把 newString 里的 $& / $$ / $` / $' 当替换记号展开，
        // 静默改写文件内容却照样返回成功。详见 edit-matchers.ts 文件头。
        const newContent = replaceLiteral(content, effectiveOldString, effectiveNewString);
        if (newContent === null) {
          // 没命中就给出「大概想改哪里」，而不是只回一句 not found ——
          // 后者会让模型必须额外花一次 read + 一次重试，还可能猜偏。
          const suggestion = suggestEditCandidates(content, oldString);
          return {
            title: `edit: ${path}`,
            output: `Error: ${suggestion ? suggestion.message : `oldString not found in ${path}`}`, isError: true,
          };
        }

        await writeFile(path, newContent, { workspace: ctx.workspace || ctx.cwd });
        // E4: Invalidate cache after edit
        fileCache.invalidate(path);
        // 第 95 波：写盘成功 = 这个会话现在"看到"的是新版本（下一次 edit 不必再读一次）
        await noteObservedPresent(ctx.sessionId, path);
        // F3.4: Auto-lint after edit
        const lintResult = await autoLint(path);
        const output = lintResult
          ? `Successfully edited ${path}\n${lintResult}`
          : `Successfully edited ${path}`;
        return { title: `edit: ${path}`, output, isError: false, metadata: { file_paths: [path] } };
      } catch (error: any) {
        return { title: `edit: ${path}`, output: `Error: ${error.message}`, isError: true };
      }
    },
  };
}

// ========== S3: Multi-Edit Tool (apply_patch style) ==========

export function createMultiEditTool(): ToolDef {
  return {
    id: "multi_edit",
    contract: { sideEffectScope: "workspace", timeoutMs: NO_TIMEOUT },
    guidance: "Use multi_edit to make several edits to the same file in one operation. Each edit is applied in sequence on the result of the previous one. After editing, when you mention the file in your response, ALWAYS use a Markdown link with the full path: [filename](./path/to/file). This lets the user click to open it.",
    description: "Apply multiple exact-string replacements to a file in one operation. Each edit replaces the first occurrence of oldString with newString. Edits are applied sequentially. Use this when you need to make several targeted changes to the same file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to edit" },
        edits: {
          type: "array",
          description: "Array of edit operations to apply sequentially",
          items: {
            type: "object",
            properties: {
              oldString: { type: "string", description: "The exact string to find" },
              newString: { type: "string", description: "The replacement string" },
            },
            required: ["oldString", "newString"],
          },
        },
      },
      required: ["path", "edits"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const path = args.path as string;
      const edits = args.edits as Array<{ oldString: string; newString: string }>;

      // 同 edit：`edits` 缺失/非数组/条目缺字段都要变成可行动的提示，
      // 而不是 `undefined.map is not a function` 这类内部崩溃。
      if (!Array.isArray(edits) || edits.length === 0) {
        return {
          title: `multi_edit: ${path}`,
          output:
            `Error: Missing required parameter \`edits\` — it must be a non-empty array of ` +
            `\`{ oldString, newString }\` objects.`, isError: true,
        };
      }
      for (let i = 0; i < edits.length; i++) {
        const perItem = validateEditParams(
          (edits[i] ?? {}) as Record<string, unknown>,
          ["oldString", "newString"],
        );
        if (perItem) {
          return {
            title: `multi_edit: ${path}`,
            output: `Error: edits[${i}]: ${perItem}`, isError: true,
          };
        }
      }

      // S2: Protected path check
      if (isProtectedPath(path)) {
        return {
          title: `multi_edit: ${path}`,
          output: `Error: This path is protected and cannot be edited. Protected paths include .git/, .env, .codem-snapshots/, node_modules/.`, isError: true,
        };
      }

      // S5: Sandbox path whitelist check
      const sandboxError = checkSandbox(path, ctx);
      if (sandboxError) {
        return { title: `multi_edit: ${path}`, output: `Error: ${sandboxError}`, isError: true };
      }

      // 第 95 波：与 `edit` 同一条前置判定（读后写 / 版本比对）
      {
        const denial = await checkEditAllowed(ctx.sessionId, path);
        if (denial) return fsPolicyDenialResult(`multi_edit: ${path}`, denial);
      }

      try {
        let content = await readFile(path);
        let appliedCount = 0;
        const errors: string[] = [];

        for (let i = 0; i < edits.length; i++) {
          const { oldString, newString } = edits[i];
          // 同上：必须用 replaceLiteral，否则 newString 里的 $ 记号会静默改写文件。
          const next = replaceLiteral(content, oldString, newString);
          if (next === null) {
            const suggestion = suggestEditCandidates(content, oldString);
            errors.push(
              `Edit ${i + 1}: ${suggestion ? suggestion.message : "oldString not found"}`,
            );
            continue;
          }
          content = next;
          appliedCount++;
        }

        if (appliedCount === 0) {
          return {
            title: `multi_edit: ${path}`,
            output: `Error: No edits could be applied. ${errors.join("; ")}`, isError: true,
          };
        }

        await writeFile(path, content, { workspace: ctx.workspace || ctx.cwd });

        // E4: Invalidate cache after multi-edit
        fileCache.invalidate(path);
        // 第 95 波：写盘成功 = 这一版就是本会话"看到"的版本
        await noteObservedPresent(ctx.sessionId, path);
        // F3.4: Auto-lint after multi-edit
        const lintResult = await autoLint(path);

        const msg = errors.length > 0
          ? `Applied ${appliedCount}/${edits.length} edits to ${path}. Errors: ${errors.join("; ")}`
          : `Applied ${appliedCount} edits to ${path}`;
        /**
         * 第 D9 波：**部分失败不是成功**。
         *
         * 此前这条结果既没有 `Error:` 前缀、也没有 `isError`，于是
         * `classifyToolResult` 按首行判定得到 `completed`：一半的编辑根本没落盘，
         * 而上层（`session/ui-handoff.ts` 的"产物"判定、委派汇报）把它当成写完了。
         *
         * 用显式 `isError` 而不是改文案：文案里 `Applied 2/3 edits … Errors: …`
         * 本身是**有用的事实**（哪几条成功、哪几条失败），保持原样；
         * 失败与否由声明表达。`appliedCount === 0` 的早退分支与全成功分支都不动
         * （前者首行已经是 `Error:`，后者是真正的成功）。
         */
        return {
          title: `multi_edit: ${path}`,
          output: lintResult ? `${msg}\n${lintResult}` : msg,
          metadata: { file_paths: [path] },
          isError: errors.length > 0,
        };
      } catch (error: any) {
        return { title: `multi_edit: ${path}`, output: `Error: ${error.message}`, isError: true };
      }
    },
  };
}

/**
 * ★ 第 186 波：**模型侧内联上限**（glob 的搜索结果里，最多有多少条路径进上下文）。
 *
 * ## 为什么是 500（而不是"有多少给多少"）
 *
 * 1. **硬预算**：本仓自己给"工具结果太大、不该躺在上下文里"划的线是
 *    `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000` 字符（`tool-result-storage.ts:27`），
 *    spill 的门限是 64 KB（`spill.ts:37`）。500 条 Windows 绝对路径（本仓实测
 *    40–90 字符/条）≈ **20–45 KB，压在那两条线以下** ⇒ 这份结果不会被二次 spill、
 *    也不会一个人吃掉上下文的一大块；
 * 2. **够用**：500 条足以让模型看清**结构性事实**（命名规律、目录分布、要不要缩小范围）。
 *    "把两万条逐条处理"那种活本来就该交给 `run_code`（`sdk.glob` 拿全量、可翻页）；
 * 3. **不撒谎**：少给的部分**不隐藏** —— 完整列表落盘并把路径给模型，
 *    并在 `<harness>` 里写明"内联了几条 / 本次返回几条 / 剩下的怎么拿"。
 *
 * 改前的缺陷**不是上限大小**，而是超限就报错：模型既拿不到数据，也拿不到下一步。
 */
const GLOB_INLINE_MAX = 500;

/** `glob` 工具的结构化结果（`outputSchema` 与渲染器共用这一个形状） */
interface GlobOutputValue {
  pattern: string;
  /** **实际内联给模型的那一段**（有界，见 `GLOB_INLINE_MAX`） */
  files: string[];
  /** `files.length`（历史字段口径不变：它一直是"这里有多少条"） */
  count: number;
  /** 本次搜索**返回**的总条数（可以比 `files.length` 大） */
  returned: number;
  /** 本次搜索结果**至少还有更多**（要拿剩下的就用 `offset` 翻页） */
  truncated: boolean;
  /** Rust 侧给的可执行下一步（夹取说明 / 翻页 offset） */
  hint?: string;
  /** 完整列表落盘路径（只在"模型看不到全部"时才落盘） */
  spillPath?: string;
  /** 结构化诊断（渲染成 `<harness>` 块，与 `read` 同一套口径） */
  diagnostics?: ToolDiagnostic[];
}

/**
 * `glob` 的模型可见输出 —— **唯一来源**（`execute` 与 `renderOutput` 都走它）。
 *
 * 未被截断时**逐字**等于旧行为（`files.join("\n") || "No files found"`）：注册契约
 * 与这次改动都不该改变"结果完整时模型看到的东西"。
 */
function renderGlobOutput(v: GlobOutputValue): string {
  const body = v.files.length > 0 ? v.files.join("\n") : "No files found";
  const diagBlock = renderDiagnostics(v.diagnostics);
  return diagBlock ? `${body}\n${diagBlock}` : body;
}

export function createGlobTool(): ToolDef {
  return {
    id: "glob",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      // 第 121 轮：结果契约。这是第一个**真的注册了** outputSchema 的工具 ——
      // 在此之前全仓零个工具注册过，于是整套输出校验形同虚设（恒真）。
      // 第 186 波：补上 `returned` / `truncated` / `hint` / `spillPath`
      // —— "结果有界"这件事从此是**声明**，不是实现细节（形状不符会被契约层拦下）。
      outputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          count: { type: "number" },
          pattern: { type: "string" },
          returned: { type: "number" },
          truncated: { type: "boolean" },
          hint: { type: "string" },
          spillPath: { type: "string" },
          diagnostics: { type: "array" },
        },
        required: ["files", "count", "pattern", "returned", "truncated"],
        additionalProperties: false,
      },
      // 渲染与 `execute` 走同一个函数（第 183 波的诊断块也在这里落地）——
      // "模型看到什么"不可能有两份实现。
      renderOutput: (v) => renderGlobOutput(v as GlobOutputValue),
    },
    guidance:
      "Use glob to find files by name pattern (e.g. `**/*.ts`). Use grep to search file contents instead. " +
      "Large result sets are NOT an error: you get a bounded inline list plus `truncated` and `hint`, " +
      "and the complete returned list is spilled to a file (see `spillPath`). Page with `offset` when you need all of them.",
    description:
      "Find files matching a glob pattern. Supports Chinese filenames natively. " +
      "Patterns: * (wildcard), ? (single char), {a,b} (alternatives), ** (recursive). " +
      "Returns { files, count, returned, truncated, hint, spillPath? }: `files` is a BOUNDED inline list " +
      // 数字从常量来（不写死第二份 —— 改了 `GLOB_INLINE_MAX` 而描述没改就是"描述在说谎"）
      "(at most " + GLOB_INLINE_MAX + " paths), `returned` is how many this call returned, `truncated: true` means at least one " +
      "more match exists. When the list does not fit inline, the complete returned list is written to `spillPath` " +
      "and a <harness> note says so — read that file for everything, or call again with `offset` to page. " +
      "Example: glob(pattern=\"*.py\") or glob(pattern=\"测试*.md\", path=\"D:\\\\项目\") or glob(pattern=\"*.log\", limit=1000, offset=20000)",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match" },
        path: { type: "string", description: "Directory to search in" },
        limit: {
          type: "number",
          description:
            "Max paths to return for this page (allowed 1-200000, default 20000). " +
            "Out-of-range values are clamped and the clamping is reported in `hint` (never silent).",
        },
        offset: {
          type: "number",
          description:
            "Skip the first N matches — use it to page through a large result set " +
            "(next page = offset + returned).",
        },
      },
      required: ["pattern"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const pattern = args.pattern as string;
      const rawPath = (args.path as string) || ctx.cwd || ".";
      // Resolve "." to ctx.cwd (project directory), not user home
      const searchPath = rawPath === "." ? ctx.cwd : rawPath;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const offset = typeof args.offset === "number" ? args.offset : undefined;

      try {
        console.log("[glob tool] executing:", { pattern, searchPath, ctxCwd: ctx.cwd, limit, offset });
        const res = await globSearch(pattern, searchPath, { limit, offset });
        console.log("[glob tool] returned:", res.returned, "truncated:", res.truncated);

        // 模型侧只内联有界的一段（完整列表走 spill，见 GLOB_INLINE_MAX）
        const inline = res.files.slice(0, GLOB_INLINE_MAX);
        const diagnostics: ToolDiagnostic[] = [];
        let spillPath: string | undefined;
        let spillError: string | undefined;

        /**
         * 只在"模型看不到全部"时落盘 ⇒ **常规搜索零 I/O**（与 `spill.ts` 同一取向）。
         *
         * 两种触发：① 本次搜索本身就截断了（后面还有匹配）；② 返回的条数超过内联上限。
         * 落盘用的是**既有机制**（`retainToolResult`）：会话私有目录、文件名带写入时刻、
         * 由 `pruneSpillFiles()` 按保留期回收 —— 不新增第二套清理者。
         */
        if (res.truncated || res.files.length > inline.length) {
          try {
            const { retainToolResult } = await import("../storage/spill");
            const retained = await retainToolResult(res.files.join("\n"), {
              sessionId: ctx.sessionId,
              toolName: "glob",
              /**
               * `maxInlineBytes: 0` ⇒ **总是落盘**。
               *
               * 这里的名单**已经**超过模型侧内联上限了，而 `retainToolResult` 的默认门限是
               * 64 KB（按字节判）—— 500 条短路径可能不到 64 KB，于是"该落盘却没落"。
               * 我们要判的是"模型看不全"，不是"字节数大"，所以按 0 传，由上面的条件决定。
               */
              maxInlineBytes: 0,
            });
            spillPath = retained.locator;
          } catch (e: any) {
            // ★ 落盘失败**不许沉默**：否则模型会把内联的 500 条当成全部
            spillError = e?.message ?? String(e);
            console.warn("[glob tool] spill failed:", spillError);
          }
          diagnostics.push(
            globWindowDiagnostic({
              inlineCount: inline.length,
              returned: res.returned,
              truncated: res.truncated,
              spillPath,
              spillError,
              hint: res.hint,
            }),
          );
        }

        const value: GlobOutputValue = {
          pattern,
          files: inline,
          count: inline.length,
          returned: res.returned,
          truncated: res.truncated,
          ...(res.hint ? { hint: res.hint } : {}),
          ...(spillPath ? { spillPath } : {}),
          ...(diagnostics.length ? { diagnostics } : {}),
        };
        return {
          title: `glob: ${pattern}`,
          // ① `value` 是**结构化事实**（下游可结构化消费，不必再切字符串）；
          // ② `output` 与契约的 renderOutput 走**同一个**渲染函数（不会漂移）；
          // ③ `diagnostics` 同时挂一份在结果上：事件日志/UI 读的是它（`tool-pipeline.ts:1330`）。
          value,
          output: renderGlobOutput(value),
          isError: false,
          ...(diagnostics.length ? { diagnostics } : {}),
        };
      } catch (error: any) {
        console.error("[glob tool] error:", error);
        // 第 97 波：内容型工具的失败必须显式声明（它同样声明了 outputSchema）
        return { title: `glob: ${pattern}`, output: `Error: ${error.message}`, isError: true };
      }
    },
  };
}

export function createGrepTool(): ToolDef {
  return {
    id: "grep",
    contract: {
      readOnly: true,
      accessScope: "workspace",
      // 第 121 轮：结果契约（第 2 个）。渲染复现旧行为逐字 ——
      // 注册契约不该改变模型看到的东西，否则就是偷偷改了行为。
      outputSchema: {
        type: "object",
        properties: {
          matches: { type: "array", items: { type: "string" } },
          count: { type: "number" },
          pattern: { type: "string" },
        },
        required: ["matches", "count", "pattern"],
        additionalProperties: false,
      },
      renderOutput: (v) => {
        const o = v as { matches: string[] };
        return o.matches.length > 0 ? o.matches.join("\n") : "No matches found";
      },
    },
    guidance:
      "Use grep to search file contents with a regular expression. Returns matching lines with line numbers. " +
      "This is the EXACT-route search: ideal when you already know precise identifiers, quotes, filenames, keys, dates or regexes. " +
      "If the exact wording or location is UNKNOWN and you need semantic/fuzzy/cross-file/conceptual discovery, prefer zvec_grep_search (when available) — grep is lexical-only. " +
      "Mixed tasks: run zvec_grep_search first to locate relevant files, then grep to verify or list exhaustive occurrences.",
    description:
      "Search file contents using regex (exact/lexical route). Supports Chinese patterns natively. Uses PowerShell Select-String under the hood. Example: grep(pattern=\"中文\", path=\"D:\\\\项目\") or grep(pattern=\"function.*中文\", include=\"*.py\"). " +
      "Routing: exact anchors (identifiers/quotes/filenames/regex) → this tool; fuzzy intent or unknown location / cross-file synthesis → zvec_grep_search; mixed → zvec_grep_search then grep to verify.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in" },
        include: { type: "string", description: "File pattern to include (e.g. *.ts)" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const pattern = args.pattern as string;
      const rawPath = (args.path as string) || ctx.cwd || ".";
      // Resolve "." to ctx.cwd (project directory), not user home
      const searchPath = rawPath === "." ? ctx.cwd : rawPath;
      const include = args.include as string | undefined;

      try {
        const results = await grepSearch(pattern, searchPath, include);
        return {
          title: `grep: ${pattern}`,
          value: { matches: results, count: results.length, pattern },
          output: results.join("\n") || "No matches found", isError: false,
        };
      } catch (error: any) {
        // 第 97 波：内容型工具的失败必须显式声明（它同样声明了 outputSchema）
        return { title: `grep: ${pattern}`, output: `Error: ${error.message}`, isError: true };
      }
    },
  };
}

// ========== Create Default Tool Registry ==========
// ========== F4: Multimodal Tools ==========

export function createTTSTool(): ToolDef {
  return {
    id: "tts",
    contract: { sideEffectScope: "network", accessScope: "network", persistResult: false },
    guidance: "Use tts when the user asks to read text aloud, generate audio/voice, or convert text to speech (朗读、语音、配音).",
    description: "Convert text to speech audio and play it. Call this tool when the user wants to: read text aloud (朗读), generate voice/audio (生成语音/声音/音频), convert text to speech (转语音), do voiceover (配音), or any request involving generating audio from text. The tool detects intent from natural language — no commands needed. The audio will be played automatically.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to convert to speech. Use the user's requested text or the text from the conversation." },
        voice: { type: "string", description: "Voice name (e.g. 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'). Default: 'alloy'.", default: "alloy" },
        speed: { type: "number", description: "Speech speed (0.25 to 4.0). Default: 1.0.", default: 1.0 },
      },
      required: ["text"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const text = args.text as string;
      if (!text) return { title: "tts", output: "Error: text is required", isError: true };
      try {
        const { textToSpeech, playTTSAudio, getMultimodalSettings } = await import("./multimodal");
        const config = getMultimodalSettings().tts;
        if (!config || !config.enabled) {
          return { title: "tts", output: "Error: TTS provider not configured. Ask the user to enable it in Settings → Multimodal.", isError: true };
        }
        const result = await textToSpeech({
          text,
          voice: args.voice as string | undefined,
          speed: args.speed as number | undefined,
        });
        playTTSAudio(result);
        return {
          title: `🔊 语音合成: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
          output: `✅ 语音已生成并开始播放（${text.length} 字，格式: ${result.format}）。音频正在播放中。`, isError: false,
          metadata: { type: "tts", textLength: text.length, format: result.format },
        };
      } catch (e: any) {
        return { title: "tts", output: `Error: ${e?.message || e}`, isError: true };
      }
    },
  };
}

export function createImageGenTool(): ToolDef {
  return {
    id: "image_gen",
    contract: { sideEffectScope: "network", accessScope: "network", persistResult: false },
    guidance: "Use image_gen when the user asks to generate, draw, or create an image (生成图片、画图、插图).",
    description: "Generate images from a text description. Call this tool when the user wants to: generate/create an image (生成图片/图像), draw something (画一幅图/画图/帮我画), create a poster/icon/illustration (海报/图标/插图), or any request involving creating visual content from a description. The tool detects intent from natural language — no commands needed. Returns the generated image for display.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image to generate. Be specific about style, content, colors, and composition for best results." },
        size: { type: "string", description: "Image size: '256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'. Default: '1024x1024'.", default: "1024x1024" },
        quality: { type: "string", description: "Quality: 'standard' or 'hd'. Default: 'standard'.", default: "standard" },
        style: { type: "string", description: "Style: 'vivid' (hyper-real) or 'natural' (natural). Default: 'vivid'.", default: "vivid" },
      },
      required: ["prompt"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const prompt = args.prompt as string;
      if (!prompt) return { title: "image_gen", output: "Error: prompt is required", isError: true };
      try {
        const { generateImages, getMultimodalSettings } = await import("./multimodal");
        const config = getMultimodalSettings().imageGen;
        if (!config || !config.enabled) {
          return { title: "image_gen", output: "Error: Image generation provider not configured. Ask the user to enable it in Settings → Multimodal.", isError: true };
        }
        const result = await generateImages({
          prompt,
          size: args.size as any,
          quality: args.quality as any,
          style: args.style as any,
        });
        // Format result with markdown images for display
        const imageMarkdown = result.images.map((img, i) => {
          if (img.base64) {
            return `![generated-image-${i}](data:image/png;base64,${img.base64})`;
          }
          return `![generated-image-${i}](${img.url})`;
        }).join("\n\n");
        const revisedInfo = result.images[0]?.revisedPrompt ? `\n\n优化后的提示词: ${result.images[0].revisedPrompt}` : "";
        return {
          title: `🎨 图像生成: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`,
          output: `已生成 ${result.images.length} 张图片：\n\n${imageMarkdown}${revisedInfo}`, isError: false,
          metadata: { type: "image_gen", prompt, count: result.images.length },
        };
      } catch (e: any) {
        return { title: "image_gen", output: `Error: ${e?.message || e}`, isError: true };
      }
    },
  };
}

export function createDefaultToolRegistry(ctx?: Context): ToolRegistry {
  // R4: 如果传入了 ctx，设置全局工具上下文
  if (ctx) setToolContext(ctx)

  /**
   * 低频大 schema 工具延迟加载（省每轮固定 token）：
   * 对齐 dsh 工具按需暴露 —— 45 个全 schema 每轮注入 ≈10.6k tokens。
   * PPT/浏览器/Figma/GitHub API/工作流/图片/语音与日常"修 bug/写代码"无关，
   * 不注入全 schema；模型可通过 tool_search（系统提示词含 name+hint）按需加载。
   */
  const DEFERRED_BIG_TOOLS = new Set([
    "generate_ppt", "browser_automate", "figma_fetch", "github_tool",
    "workflow", "image_gen", "tts",
  ]);
  const deferIfBig = (tool: ToolDef): ToolDef => {
    if (DEFERRED_BIG_TOOLS.has(tool.id)) tool.shouldDefer = true;
    return tool;
  };

  const registry = new ToolRegistry();
  registry.register(createBashTool());
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  registry.register(createEditFileTool());
  registry.register(createMultiEditTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(deferIfBig(createTTSTool()));
  registry.register(deferIfBig(createImageGenTool()));
  // B3: load_skill tool for lazy skill loading
  registry.register(createLoadSkillTool(registry));
  // B4: web_search tool
  registry.register(createWebSearchTool());
  // B5: read_attachment tool
  registry.register(createReadAttachmentTool());
  // F5: search_notebook tool for knowledge base mode
  registry.register(createSearchNotebookTool());
  // P1-6: AI 跨笔记操作工具 (create_note / edit_note / link_notes)
  for (const tool of createNoteOperationTools()) {
    registry.register(tool);
  }
  // PPT 生成工具 — 在对话中让 AI 生成演示文稿
  registry.register(deferIfBig(createGeneratePPTTool()));
  // P1: 澄清提问、事实核查、Todo 列表工具
  registry.register(createClarificationTool());
  registry.register(createFactCheckTool());
  registry.register(createShowTodoTool());
  // D-MCP: Playwright + Figma + GitHub integration tools
  registry.register(deferIfBig(createBrowserAutomateTool()));
  registry.register(deferIfBig(createFigmaFetchTool()));
  registry.register(deferIfBig(createGitHubTool()));
  // P0-1: LSP tool for code navigation (definition, references, hover, symbols)
  registry.register(createLSPTool());
  // P0-2: tool_search for deferred tool loading (must be registered AFTER deferred tools)
  registry.register(createToolSearchTool(registry));
  // P0-3: exit_plan_mode tool — submit plan for user approval in Plan mode
  registry.register(createExitPlanModeTool());
  // P1-6: run_code tool — execute TypeScript code with tool SDK access
  registry.register(createRunCodeTool());
// P1-7: session_search tool — FTS5 full-text search across session history
registry.register(createSessionSearchTool());
// R3-2.1: session query tools — event search, trace, and read
registry.register(createSessionEventSearchTool());
registry.register(createSessionTraceTool());
registry.register(createSessionEventReadTool());
  // P2-12: Goal tools — create/get/update goals for automatic continuation
  for (const tool of createGoalTools()) {
    registry.register(tool);
  }
  // P2-11: Workflow tool — JS-based task orchestration
  registry.register(deferIfBig(createWorkflowTool()));
  // P2-19/20: Job and Terminal tools
  for (const tool of createJobTools()) {
    registry.register(tool);
  }
  registry.register(createTerminalOpenTool());
  registry.register(createTerminalSendTool());
  registry.register(createTerminalReadTool());
  registry.register(createTerminalSignalTool());
  registry.register(createTerminalCloseTool());
  registry.register(createTerminalListTool());
  // D3: Dynamic Plugin tools — cordis_define/inspect/run/stop/undefine
  for (const tool of createDynamicPluginTools()) {
    registry.register(tool);
  }
  // 步骤计划：执行中动态插入/追加语义步骤（对标 dsh 客户端 todo 语义列表）
  registry.register(createUpdatePlanTool());
  return registry;
}

/**
 * update_plan — 动态调整对话中展示的"第X/X步"宏观计划。
 *
 * 对标 dsh-desktop 客户端：任务步骤是模型维护的语义工作单元（分析原因 →
 * 诊断链路 → 修复 → 验证），执行中发现必须先处理的新问题时，模型把新步骤
 * 插入到当前进行中的步骤之前（编号顺延），而不是只做事后追加。
 */
export function createUpdatePlanTool(): ToolDef {
  return {
    id: "update_plan",
    contract: { sideEffectScope: "session", accessScope: "session" },
    guidance:
      "执行过程中，如果发现必须先处理的新问题（例如当前修复依赖一个调用链路问题），调用 update_plan 把新步骤插入到当前进行中的步骤之前，再继续原计划。插入后总步数与后续编号会自动更新。",
    description:
      "动态更新对话顶部展示的执行计划（第X/X步列表）。仅当你发现计划外、必须先处理的新问题时使用：\n" +
      "  - insert_before: 把新步骤插入到指定步骤之前（后续步骤自动顺延）。index 为 1-based 步骤号。\n" +
      "    典型用法：当前正在执行第 3 步时发现新问题，调用 insert_before index=3，使新步骤成为新的第 3 步。\n" +
      "  - insert_after: 把新步骤插入到指定步骤之后。index 为 1-based；index=0 表示插到第 1 步之前（仅当第 1 步尚未完成时可用）。\n" +
      "  - append: 追加到计划末尾（全新的任务方向）。\n" +
      "规则：不能插入到已完成（index 小于当前进行中步骤）的位置；步骤标题要简短有意义（如『修复调用链路』），不要用『执行命令』这类与任务无关的泛化标题。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["insert_before", "insert_after", "append"],
          description: "插入方式：insert_before=插到指定步骤前；insert_after=插到指定步骤后；append=追加到末尾",
        },
        index: {
          type: "integer",
          description: "目标步骤号（1-based，insert_before/insert_after 使用；insert_after 用 0 表示最前）。省略时 insert_before 默认插到当前进行中的步骤之前。",
        },
        titles: {
          type: "array",
          items: { type: "string" },
          description: "要插入的步骤标题（1 个或多个），简短有意义、指向具体任务内容",
        },
      },
      required: ["action", "titles"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const action = args.action as PlanUpdateOp["action"];
      const titles = (Array.isArray(args.titles) ? args.titles : []).map((t) => String(t));
      if (!ctx.updatePlan) {
        return { title: "update_plan", output: "Error: 当前没有可更新的执行计划（仅对话任务进行中可用）。", isError: true };
      }
      const op: PlanUpdateOp = action === "append"
        ? { action, titles }
        : { action, ...(typeof args.index === "number" ? { index: args.index } : {}), titles };
      const err = ctx.updatePlan(op);
      if (!err) return { title: "update_plan", output: "Error: 计划更新失败（无返回）。", isError: true };
      if (!err.ok) return { title: "update_plan", output: `Error: ${err.error}`, isError: true };
      return { title: "update_plan", output: err.message, isError: true };
    },
  };
}
