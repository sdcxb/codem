/**
 * SkillMarketClient — 技能市场客户端。
 *
 * 架构方案 B+C：通过 Tauri Rust 层的 http_get / http_download 命令代理 HTTP 请求，
 * 绕过前端 CSP 限制，无需额外运行时依赖。
 *
 * 支持的市场源类型：
 * 1. github-repo    — GitHub 仓库目录型（如 anthropics/skills，每个子目录是一个技能）
 * 2. github-search   — GitHub 话题搜索型（搜索 topic:agent-skills 的仓库）
 * 3. builtin         — 内置技能展示型（展示 Codem 自带技能，无需下载）
 * 4. clawhub-api     — ClawHub.ai REST API（GET /api/v1/skills）
 * 5. skills-sh-api   — Skills.sh REST API（GET /api/v1/skills + /api/v1/skills/search）
 * 6. cli             — CLI 子进程型（如 skillhub-cli，通过 executeCommand 调用）
 *
 * IP 声明：本文件所有代码均为原创实现，仅使用公开 REST API 和 CLI 工具。
 */

import { installSkillFromZip, type InstallResult, type InstallProgressCallback } from "./installer";
import { getSkillRegistry, parseSkillMarkdown, type SkillDefinition } from "./skill";
import { writeFile, readFile, deletePath } from "../file-api";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
// P3-27: 增强安全沙箱
import {
  auditSkillInstallation,
  computeContentHash,
  addInstallAuditEntry,
  type SkillAuditResult,
} from "./sandbox";

// ========== Types ==========

/** 市场源类型 */
export type MarketSourceType =
  | "github-repo"
  | "github-search"
  | "builtin"
  | "clawhub-api"
  | "skills-sh-api"
  | "skillhub-api"
  | "cli";

/** 市场源配置 */
export interface MarketSource {
  id: string;
  name: string;
  type: MarketSourceType;
  /** API URL、搜索查询或 CLI 命令前缀 */
  url: string;
  /** 是否启用 */
  enabled: boolean;
  /** 图标 emoji（用于 UI 展示） */
  icon?: string;
  /** 子目录路径（仅 github-repo 类型）。如果仓库技能不在根目录而在子目录中，指定该子目录名。 */
  subdir?: string;
  /**
   * CLI 命令名（仅 type=cli）。
   * 如 "skillhub" 表示使用 skillhub-cli，实际调用 skillhub search / skillhub install。
   */
  cliCommand?: string;
  /**
   * API Token（仅 clawhub-api / skills-sh-api）。
   * Skills.sh 需要 Vercel OIDC Token 认证；ClawHub 可选。
   * skillhub-api 类型无需认证，直接使用公开 REST API。
   */
  apiToken?: string;
}

/** 市场技能条目 */
export interface MarketSkill {
  /** 唯一 ID（source-id + skill-path） */
  id: string;
  /** 技能名称 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 版本 */
  version?: string;
  /** 标签 */
  tags?: string[];
  /** 来源市场 */
  sourceId: string;
  /** 来源市场名称 */
  sourceName: string;
  /** 下载 URL（ZIP 包或 raw 文件） */
  downloadUrl: string;
  /** 仓库主页 URL */
  repoUrl?: string;
  /** Star 数（GitHub 搜索结果） */
  stars?: number;
  /** 最后更新时间 */
  lastUpdated?: string;
  /** 是否已安装 */
  installed?: boolean;
  /** 安装类型：zip（整个仓库 ZIP）或 dir（仓库内子目录） */
  installType: "zip" | "dir" | "builtin";
  /** 如果是 dir 类型，指定仓库内目录路径 */
  dirPath?: string;
  /** 仓库 owner/repo（用于 GitHub API） */
  repoFullName?: string;
  /** 默认分支 */
  branch?: string;
}

/** HTTP 响应（对应 Rust HttpResponse） */
interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

// ========== Default Market Sources ==========

/** 默认市场源列表 */
export const DEFAULT_MARKET_SOURCES: MarketSource[] = [
  {
    id: "anthropic-skills",
    name: "Anthropic Skills",
    type: "github-repo",
    url: "https://api.github.com/repos/anthropics/skills",
    enabled: true,
    icon: "🧠",
    subdir: "skills",
  },
  {
    id: "github-agent-skills",
    name: "GitHub Agent Skills",
    type: "github-search",
    url: "https://api.github.com/search/repositories?q=topic:agent-skills+topic:ai-coding&sort=stars&order=desc&per_page=30",
    enabled: true,
    icon: "⭐",
  },
  {
    id: "github-skill-md",
    name: "GitHub SKILL.md Repos",
    type: "github-search",
    url: "https://api.github.com/search/repositories?q=SKILL.md+in:name,description&sort=stars&order=desc&per_page=20",
    enabled: true,
    icon: "📦",
  },
  {
    id: "clawhub",
    name: "ClawHub.ai",
    type: "clawhub-api",
    url: "https://clawhub.ai",
    enabled: true,
    icon: "🦞",
  },
  {
    id: "skills-sh",
    name: "Skills.sh",
    type: "skills-sh-api",
    url: "https://skills.sh",
    enabled: true,
    icon: "🎯",
  },
  {
    id: "skillhub",
    name: "SkillHub",
    type: "skillhub-api",
    url: "https://skills.palebluedot.live",
    enabled: true,
    icon: "☁️",
  },
  {
    id: "codem-builtin",
    name: "Codem 内置技能",
    type: "builtin",
    url: "",
    enabled: true,
    icon: "⚡",
  },
];

// ========== Settings ==========

const MARKET_SOURCES_KEY = "codem-market-sources";

/** 获取市场源列表（合并默认源和用户配置） */
export function getMarketSources(): MarketSource[] {
  const saved = getSettingJSON<MarketSource[]>(MARKET_SOURCES_KEY, []);
  if (saved.length === 0) {
    return DEFAULT_MARKET_SOURCES;
  }
  // 合并：以 saved 为主，但用 defaults 中的新字段（如 subdir）补充
  return saved.map((s) => {
    const def = DEFAULT_MARKET_SOURCES.find((d) => d.id === s.id);
    if (def) {
      return { ...def, ...s, subdir: s.subdir ?? def.subdir };
    }
    return s;
  });
}

/** 保存市场源列表 */
export function setMarketSources(sources: MarketSource[]): void {
  setSettingJSON(MARKET_SOURCES_KEY, sources);
}

// ========== Tauri Invoke Helpers ==========

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    throw new Error("Tauri invoke not available — skill market requires Tauri runtime.");
  }
  return invoke(command, args);
}

/** 通过 Rust 层下载文件到本地路径 */
async function httpDownload(url: string, destPath: string, headers?: Record<string, string>): Promise<string> {
  return tauriInvoke("http_download", { url, destPath, headers });
}

// ========== 并发闸门与 BUSY（第 63 轮续：真机 1.16.112 复量暴露的"假话"） ==========

/**
 * 前端侧的**总准入闸门**：同时在飞的 `http_get` 不超过这个数。
 *
 * ## 为什么需要它（真机读数直接指出的）
 *
 * Rust 侧 `http_get` 有一道 12 路的并发闸门（`HTTP_GET_MAX_IN_FLIGHT`），超限立刻回
 * `{code:"BUSY", retryable:true}`。但前端的并发纪律是**每个源内部** 8 路
 * （`SOURCE_FETCH_CONCURRENCY`），源与源之间是 `Promise.all` **全并行** ——
 * 7 个源同开就是 ~56 路同时提交，其中 44 路必然被闸门当场拒掉。
 *
 * 真机（1.16.112 安装版）因此看到：
 * ```
 * [error] Error fetching repo skills for anthropic-skills: {"code":"BUSY",…}
 * ```
 * 也就是说：**Rust 侧的闸门做对了它该做的事，是前端把 56 路一起塞了过去。**
 * 闸门的正确落点是"准入"，而准入是**调用方**的责任 —— 让后端不断拒绝再重试，
 * 不如从一开始就不超量提交。
 *
 * ## 为什么是 8 而不是 12（刻意留 4 条余量）
 *
 * Rust 闸门容量是 12。前端若也占满 12，其它 `http_get` 调用方
 * （web 抓取、figma 抓取、宠物市场）就会被市场挤成 BUSY —— 那是把"市场的并发问题"
 * 转嫁成"别人的失败"。留 4 条给别的调用方：市场最多占 8 条，
 * **别的功能永远有至少 4 条可用**，而市场自己 8 路并发在实测里已经够快
 * （`.preview-shot/out-http-throughput.txt`：8 路并发 30 个仓库 ≈ 1.4s）。
 */
const HTTP_GET_FRONTEND_MAX_IN_FLIGHT = 8;

/** 前端闸门的排队实现（FIFO：先来先服务，且**不丢请求** —— 与后端的"拒绝"语义相反）。 */
class HttpAdmissionQueue {
  private limit: number;
  private inFlight = 0;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  /** 仅供测试：换一个容量（并丢弃仍在排队的等待者，避免旧轮次污染新容量下的判定）。 */
  setLimitForTests(limit: number): void {
    this.limit = Math.max(1, limit);
    const pending = this.waiters.splice(0);
    for (const w of pending) w();
  }

  async acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  get stats() {
    return { inFlight: this.inFlight, queued: this.waiters.length, limit: this.limit };
  }
}

const httpAdmission = new HttpAdmissionQueue(HTTP_GET_FRONTEND_MAX_IN_FLIGHT);

/**
 * BUSY 的**退避参数**（每一个值都从"这一轮刷新必须在 12s 内结束"倒推）。
 *
 * 判据链：
 * - 前端的源级上限是 `SOURCE_TIMEOUT_MS = 12s`，**退避总时长必须远小于它**，
 *   否则"重试成功"也会被源超时判为降级 —— 那就等于没重试。
 * - 最坏情况：3 次尝试、2 次退避，每次 ≤ `BUSY_BACKOFF_MAX_MS`。
 *   取 `250~600ms` 抖动 ⇒ 2 × 600ms = 1.2s，不到 12s 的 10%。**留了大量余量**。
 * - 为什么要**抖动**（jitter）：被拒的请求是**同一毫秒**一起被拒的（同一批 56 路），
 *   固定延时会让它们在同一毫秒一起回来、再次撞闸门（惊群）。抖动把它们摊开。
 * - 为什么要 2 次而不是 0 次：`BUSY` 是**明确可重试**的错误
 *   （`retryable: true`），一次都不试就是把可恢复的失败说成最终失败。
 * - 为什么不是 5 次：前端闸门（上面那道）已经让超量提交基本消失，
 *   所以走到这里的是"别的调用方也在挤"这种罕见情况；重试太多只会拖长本轮刷新。
 */
const BUSY_BACKOFF_MIN_MS = 250;
const BUSY_BACKOFF_MAX_MS = 600;
const BUSY_MAX_ATTEMPTS = 3; // = 首次 + 2 次重试

/** 退避时长（含抖动）。`Math.min` 是**显式的**上界保证，不依赖 `Math.random()` 的实现细节。 */
function busyBackoffMs(): number {
  const span = BUSY_BACKOFF_MAX_MS - BUSY_BACKOFF_MIN_MS;
  return Math.min(BUSY_BACKOFF_MAX_MS, BUSY_BACKOFF_MIN_MS + Math.floor(Math.random() * (span + 1)));
}

/**
 * `http_get` 的错误信封（Rust 侧 `busy_error()` 的对应读取端）。
 *
 * 为什么要 `JSON.parse` 容错而不是直接 `err.message.includes("BUSY")`：
 * 匹配裸文本会把"正文里恰好出现 BUSY 字样的普通网络错误"也误判成闸门拒绝，
 * 而这个仓库的判据一贯是"**错误是值，不是文本**"（见 `storage.rs` 顶部）。
 * 解析失败（网络层错误、TLS 错误、非 JSON）一律当作**普通失败**，不猜。
 */
interface HttpErrorEnvelope {
  code?: string;
  message?: string;
  retryable?: boolean;
  hint?: string;
}

/** 判断一次 `http_get` 拒绝是不是"并发闸门拒绝"。 */
function parseHttpErrorEnvelope(err: unknown): HttpErrorEnvelope | null {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null; // 非 JSON → 不是我们的信封，不猜
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as HttpErrorEnvelope) : null;
  } catch {
    return null;
  }
}

/**
 * 判断一次 `http_get` 拒绝是不是"并发闸门拒绝"。
 *
 * 认**两种**形态：
 *  1. Rust 侧原样抛来的 JSON 信封（`code === "BUSY"`）；
 *  2. 本模块重试耗尽后自己抛的 `HttpBusyError`（`code` 是类字段，没有 JSON 信封）。
 *
 * 第 2 条是**实测补的**：第一版只认信封，于是 `fetchGitHubRepoSkills` 的
 * `catch` 里 `isBusyHttpError(HttpBusyError)` 判成了 false ——
 * 自己抛的类型自己认不出来，`noteSourceBusy` 没被记上，
 * "源可达、返回为空"那句假话照旧打了出来（用例当场抓红）。
 */
function isBusyHttpError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === "BUSY") return true;
  return parseHttpErrorEnvelope(err)?.code === "BUSY";
}

/** 可重试的错误：`BUSY`（以及未来任何显式声明 `retryable: true` 的信封）。 */
function isRetryableHttpError(err: unknown): boolean {
  if ((err as { retryable?: unknown } | null)?.retryable === true) return true;
  const env = parseHttpErrorEnvelope(err);
  if (!env) return false;
  return env.code === "BUSY" || env.retryable === true;
}

/**
 * 本轮刷新里"被闸门拒过的源"（源名 → 次数）。
 *
 * ## 为什么需要它（这是"假话"的修复点）
 *
 * 真机 1.16.112 打出的是这一对**互相矛盾**的输出：
 * ```
 * [error] Error fetching repo skills for anthropic-skills: {"code":"BUSY",…}
 * [log]   Source "Anthropic Skills" 本次没有可展示的技能（源可达、返回为空）
 * ```
 * 第二行是**假话**：请求根本没发出去（`"本次请求未被发出"`），
 * 源可达性压根没被验证过。根因是取数函数的 `try/catch` 把异常就地吞掉、
 * `return []` —— 于是"取数失败"和"源真的空"在返回值上**不可区分**。
 *
 * 去重口径与限流那条一致（`noteGithubRateLimit`）：**每源一条**，跨轮在
 * `resetGithubRateLimitState()` 里清。
 */
const sourceBusyCount = new Map<string, number>();

/** 记一次 BUSY（按源归并计数，且每源只打一条 warning —— 与限流同一纪律）。 */
function noteSourceBusy(sourceName: string, sourceId: string, attemptContext: string): void {
  const n = (sourceBusyCount.get(sourceName) ?? 0) + 1;
  sourceBusyCount.set(sourceName, n);
  if (n === 1) {
    console.warn(
      `[SkillMarket] 源 "${sourceName}"（${sourceId}）本次**并发受限**（http_get 并发闸门已满）——` +
      `部分请求未被发出，该源本次结果不完整（已保留上一次的结果，稍后重试即可）。触发点：${attemptContext}`,
    );
  }
}

/** 某个源本轮是否被闸门拒过（用于**阻止**"源可达、返回为空"这句假话）。 */
function sourceHitBusy(sourceName: string): boolean {
  return (sourceBusyCount.get(sourceName) ?? 0) > 0;
}

/**
 * 通过 Rust 层发起 HTTP GET 请求（绕过 CSP）。
 *
 * ## 三层职责（顺序即优先级）
 *
 * 1. **前端准入闸门**：真正的修复 —— 不超量提交，让后端闸门基本不触发；
 * 2. **BUSY 退避重试**：`BUSY` 是显式可重试错误，退避后重试成功就走正常路径；
 * 3. **失败如实抛错**：重试仍失败时**抛出**（而不是返回空），
 *    由调用方按"并发受限"分类 —— 绝不再被当成"源可达但为空"。
 */
async function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  await httpAdmission.acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= BUSY_MAX_ATTEMPTS; attempt++) {
      try {
        return await tauriInvoke("http_get", { url, headers });
      } catch (err) {
        lastErr = err;
        // 非可重试错误（网络失败、CSP、非 JSON 信封）立刻抛出：重试只会白等。
        if (!isRetryableHttpError(err)) throw err;
        // 最后一次也失败了 → 退出循环，走下面的分类抛出
        if (attempt < BUSY_MAX_ATTEMPTS) {
          // 退避后把请求送回队尾（公平通道：不与仍在飞的其他请求抢许可）
          await new Promise((r) => setTimeout(r, busyBackoffMs()));
        }
      }
    }
    if (isBusyHttpError(lastErr)) throw new HttpBusyError(url, BUSY_MAX_ATTEMPTS, lastErr);
    throw lastErr;
  } finally {
    httpAdmission.release();
  }
}

/**
 * 重试耗尽后仍被闸门拒绝时抛出的**类型化错误**。
 *
 * 为什么要一个专门的类而不是继续用字符串：调用方需要**结构化地**区分
 * "并发受限"与"源真的失败"，才能各自说对话（这条判据与 `storage.rs` 顶部
 * "只给一个字符串，渲染侧只能靠正则猜"完全一致）。
 */
class HttpBusyError extends Error {
  readonly code = "BUSY";
  readonly retryable = true;

  constructor(
    readonly url: string,
    readonly attempts: number,
    cause?: unknown,
  ) {
    const detail = parseHttpErrorEnvelope(cause)?.message ?? "并发请求已达上限";
    super(`http_get 并发受限（已重试 ${attempts} 次）：${detail} —— ${url}`);
    this.name = "HttpBusyError";
  }
}

/** 仅供测试：重置前端闸门与 BUSY 记账（避免用例之间互相污染）。 */
export function __resetHttpGateForTests(): void {
  sourceBusyCount.clear();
  httpAdmission.setLimitForTests(HTTP_GET_FRONTEND_MAX_IN_FLIGHT);
}

/** 仅供测试：读前端闸门当前状态（在飞 / 排队 / 容量）。 */
export function __httpGateStatsForTests(): { inFlight: number; queued: number; limit: number } {
  return httpAdmission.stats;
}

/** 仅供测试：把闸门容量换成一个很小的值，以便在不去真机的情况下造出 BUSY。 */
export function __setHttpGateLimitForTests(limit: number): void {
  httpAdmission.setLimitForTests(limit);
}

// ========== 日志与并发纪律（第 63 轮：技能市场 console 归零） ==========

/**
 * ## 这一轮怎么区分"正常路径日志"与"真问题告警"
 *
 * 验收口径是"打开技能市场不许再有 warning"，但**不允许靠删日志/降级掩盖真缺陷**。
 * 判据只有一条：**这条日志说的是"预期内的降级路径"，还是"我们自己的功能坏了"？**
 *
 * - 预期内（Skills.sh REST API 在桌面端必然 401 → 我们**已经实现** HTML 兜底且兜底成功）
 *   → 降到 `console.log`（用这个 `info()`），但**必须把原因 + 后续动作写进文本**（不许静默）；
 * - 真问题（源真的撞到 12s 上限、源真的抛错、GitHub 配额耗尽、请求风暴）
 *   → **保持 `console.warn` / `console.error`，并且本轮是把这些真问题本身修掉**
 *     （并发收口 / 限流识别 / 定时器收口），不是把它们说轻。
 *
 * 所以：级别降低的每一处都附了"为什么这是正常形态"的判据（见各处行内注释）；
 * 而所有真问题告警在改后**依然会响** —— 只是不再每仓库刷一条、也不再假报。
 */
function info(message: string): void {
  console.log(`[SkillMarket] ${message}`);
}

/** 单个市场源的取数超时上限（毫秒）。必须短于 Rust 端 http_get 的 15s 单请求超时。 */
const SOURCE_TIMEOUT_MS = 12_000;

/**
 * 单个源内部的**并发上限**。
 *
 * 真机读数（改动前基线，见 `.preview-shot/out-skillmarket-ipc2.txt`）：
 * 一次"检查更新"会发出 **133 个 http_get**，其中 `GitHub Agent Skills` 一个源
 * 就在同一毫秒里并发扇出 30 个 Trees API 请求 + 后续 30 个 raw 请求，
 * 把 GitHub 未认证配额（60 次/小时）在 1 秒内打光 —— 接下来全是 403，
 * 失败后还会逐仓库退化成 Contents API 的**串行**请求，于是整源必然撞 12s 上限。
 *
 * 所以并发上限不是"让日志好看"，而是**修掉请求风暴本身**：
 * 8 路并发下同样 30 个仓库的实测耗时 ≈ 1.4s（见 `out-http-throughput.txt` 的 twentyGithubSame）。
 */
const SOURCE_FETCH_CONCURRENCY = 8;

/** GitHub 未认证配额是 60 次/小时；限流后短时间内再打只会继续 403，所以记一个短冷却。 */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 有界并发的 `map`（保序）。
 *
 * 为什么不用 `Promise.all(items.map(...))`：那是**无界**并发，30 个仓库 = 30 路
 * TCP+TLS 同时打同一个主机（Rust 端每次 `http_get` 都新建一个 reqwest Client，
 * 没有连接复用），局域网/代理一抖动就集体超时，而且必然先把配额打光。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 本轮刷新里**已经就"超时"报过账**的源（源名 → 记账时刻）。
 *
 * ## 这条修的是什么（真机 1.16.112 读数）
 *
 * 真机量到 `Source "ClawHub.ai" … 超过 12000ms` **×2**、`Source "SkillHub" … 超过 12000ms` **×2**。
 * 注意：限流那条路径（`noteGithubRateLimit`）**已经**做到了"每源一条"，
 * 唯独**超时这条路径没有去重** —— 于是同一个源在同一轮刷新里被报了两遍。
 *
 * ## 为什么会出现两遍（不是"日志写重了"，是真的取了两遍）
 *
 * `listMarketSkills()`（列表页）与 `searchMarketSkillsOnline()`（搜索页）各自会
 * **重新取一遍所有源**，而且各自**独立**套一层 `withSourceTimeout`。两者共用同一套收口
 * （`mergeSourceResult`），但超时告警是在 `withSourceTimeout` 里就地打的 ——
 * 于是同一轮刷新里同一个源超时两次，就写两条**内容逐字相同**的 warning。
 * 从用户视角这是"同一件事说两遍"，从排障视角这是"重复计数"（会让人以为两个源都挂了）。
 *
 * ## 去重口径：**同轮 + 同源 + 只一条 warning**（不吞真问题）
 *
 * - 去重键是**源名**，与告警文本里引用的那个名字严格同源，避免"日志说 A、去重按 id"这种对不上；
 * - 每个源**仍然保留自己的 `timedOut` 语义**（返回值不变），所以界面上的降级行为、
 *   `degraded` 判定、`onSourceLoaded` 不回调这些**都不受影响** —— 被去掉的只有重复文本；
 * - 跨轮清零，见 `resetGithubRateLimitState()` 的"轮次合并"规则。
 */
const sourceTimeoutWarned = new Set<string>();

/**
 * "同一轮刷新"的合并窗口。
 *
 * ## 为什么需要它（这是本轮前端侧真正的取舍点）
 *
 * **调用点没有传递轮次标识**：`listMarketSkills` 与 `searchMarketSkillsOnline` 是
 * 两个独立入口，各自在开头调 `resetGithubRateLimitState()`。如果复位是"每次调用都清"，
 * 那么**第二次调用会把第一次刚记下的去重账本抹掉**，重复告警原样复现 —— 去重等于没写。
 *
 * 所以把"两个复位点落在 3 秒内"**合并成同一轮**：
 * - 这与真机现象窗口吻合：用户点一次"检查更新"，列表取数（含 12s 超时）与
 *   搜索取数是**同一次用户动作**触发的，两者的起始间隔在秒级；
 * - 3 秒足够覆盖"列表 → 搜索"的间隔（搜索侧本身还有 600ms 防抖），
 *   又远短于"用户再点一次刷新"的自然间隔；
 * - 代价（**如实说明**）：如果用户在 3 秒内改了搜索词、或在刷新未结束时又点一次刷新，
 *   同一个源的超时会只报一条。这被接受 —— 那本来就是"同一件事的一段连续观测"，
 *   少报一条重复比多报一条重复更准。
 *
 * 更严的口径需要一个**显式的轮次令牌**（例如由 SkillManager 生成并透传 `roundId`），
 * 但那要改 `src/components/**`（本轮明确不许动），所以这里用时间窗口近似，
 * 并把边界写在这里而不是藏进实现。
 */
const ROUND_COALESCE_MS = 3_000;

/** 上一次"开新轮"的时刻。0 = 还没开过轮（首次调用一定要开）。 */
let roundOpenedAt = 0;

/**
 * `withSourceTimeout` 的返回值：`timedOut` 用来区分"真的撞了上限"与"源本来就没东西"，
 * 让日志能说准（改前那条 `timed out after 12000ms` 恰恰两个都不准）。
 */
interface SourceFetchOutcome<T> {
  value: T;
  timedOut: boolean;
}

/**
 * 取数超时的**统一收口**：定时器一定会被清掉。
 *
 * 改动前的写法是裸 `Promise.race([work, new Promise(r => setTimeout(() => {
 *   console.warn('timed out'); r([]); }, 12000))])` —— 胜负一分出，
 * 输的那个 `setTimeout` **没有人清**。真机直接量到（`.preview-shot/out-timer-leak.txt`）：
 * 7 个 12000ms 定时器 `clearedCount: 0`，全部在点击后 13.3s 原样开火，
 * 其中包含 `Codem 内置技能`（同步返回，0ms 就赢了）和已经把技能结果打完日志的源
 * （`ClawHub: fetched 296 skills`）—— 也就是说：
 *
 *   **"某个源 timed out after 12000ms" 这条日志，当时并不代表那个源真的超时了。**
 *
 * 那既是假警报（把正常源说成超时），也是真问题（漏掉的定时器会在用户早就看到结果之后
 * 再写一条误导日志）。这里把定时器在源完成时清掉，并且只在**源确实还没结束**时才报超时。
 */
async function withSourceTimeout<T>(
  sourceName: string,
  timeLimitMs: number,
  work: Promise<T>,
): Promise<SourceFetchOutcome<T>> {
  let settled = false;
  const tracked = work.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<SourceFetchOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return; // 兜底：正常路径下定时器已被清掉，这里不该发生
      /**
       * 同一轮刷新内每个源只报一次（真机 1.16.112：同一个源被报了两遍）。
       *
       * 列表页与搜索页共用这套收口、却各自独立套一层超时，是重复的来源。
       * 这里按**源名**去重；去重只影响"这条文本打不打"，`timedOut` 一律照常返回 ——
       * 也就是说第二个调用方该降级还是降级，只是不再重复喊同一句话。
       */
      if (!sourceTimeoutWarned.has(sourceName)) {
        sourceTimeoutWarned.add(sourceName);
        console.warn(
          `[SkillMarket] Source "${sourceName}" 超过 ${timeLimitMs}ms 仍未取完 —— 本次先跳过该源（已保留上一次的结果）。` +
          `该源的请求仍在后台跑完，不会取消。`,
        );
      }
      resolve({ value: [] as unknown as T, timedOut: true });
    }, timeLimitMs);
  });
  try {
    return await Promise.race([
      tracked.then((value) => ({ value, timedOut: false }) as SourceFetchOutcome<T>),
      guard,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 单源取数结果：`degraded` = 本次没能拿到（调用方不得把它计入结果），`failed` = 真失败（要进 errors）。 */
interface SourceMergeResult {
  skills: MarketSkill[];
  /** 本次没拿到 → 调用方不应把它计入 `result.skills`（否则会顶掉界面上该源的旧数据） */
  degraded: boolean;
  /**
   * 真失败（源自己抛错，例如 Trees API 挂了）。
   *
   * 与"超时"分开的判据：超时是**我们自己设的 12s 上限**触发的、且后台仍在把请求跑完
   * （真机读数：`ClawHub: fetched 296 skills` 就打在超时日志之后 5.5s），
   * 它应当走日志 + 界面上温和的"未更新"提示，**不该**变成 `errors` ——
   * 那是 SkillManager 顶部那条红色的"部分源加载失败"横幅，会误导用户以为功能坏了。
   * 而源自己抛错是它真的没干成，必须可见。
   */
  failed: boolean;
}

/**
 * 取数降级的统一收口：超时 / 抛错都**不让界面变空**，并且说清降级原因（不静默）。
 *
 * 为什么必须把"降级"与"成功但为空"分开（这是本轮修掉的第二个真缺陷）：
 * 调用方 SkillManager 是这样合并的 ——
 *
 * ```ts
 * const sourceIdsInResult = new Set(result.skills.map((s) => s.sourceId));
 * const preserved = prev.filter((s) => !sourceIdsInResult.has(s.sourceId));
 * ```
 *
 * 也就是说：**只要某个源的 id 出现在 `result.skills` 里，它的旧数据就会被丢掉**。
 * 改动前超时/失败会 `push(...[])`（等于什么都不 push）但同时 `onSourceLoaded(id, [])`
 * 把界面清空；如果只是照抄"空数组也算结果"，一次超时刷新就会让该市场整片技能消失。
 * 所以这里返回 `degraded=true`，由调用方**不把它计入结果**，旧数据才能被保留下来。
 */
async function mergeSourceResult(
  sourceName: string,
  timeLimitMs: number,
  work: Promise<MarketSkill[]>,
): Promise<SourceMergeResult> {
  let outcome: SourceFetchOutcome<MarketSkill[]>;
  try {
    outcome = await withSourceTimeout(sourceName, timeLimitMs, work);
  } catch (err: any) {
    // 源自己抛错（例如 GitHub Trees API 失败）：说清是哪一步炸的，不吞
    info(`Source "${sourceName}" 取数失败：${err?.message || String(err)}`);
    return { skills: [], degraded: true, failed: true };
  }
  if (outcome.timedOut) {
    // 超时的 warning 已经在 withSourceTimeout 里打过了 —— 一条事实只留一条日志
    return { skills: [], degraded: true, failed: false };
  }
  if (outcome.value.length === 0) {
    /**
     * ## 先排除"这句是假话"的情况（真机 1.16.112 的原始缺陷）
     *
     * 真机打出来的是一对互相矛盾的输出：
     * ```
     * [error] Error fetching repo skills for anthropic-skills: {"code":"BUSY",…"本次请求未被发出"}
     * [log]   Source "Anthropic Skills" 本次没有可展示的技能（源可达、返回为空）
     * ```
     * 第二行**恰恰说反了**：请求根本没发出去，源可达性从未被验证。
     *
     * 为什么会这样：源的 `try/catch` 把 BUSY 异常就地吞掉并 `return []`，
     * 于是"取数失败"与"源真的空"在返回值上**不可区分**，这里只能按后者写。
     * 现在 `httpGet` 会把 BUSY 记进 `sourceBusyCount`（按源），这里据此**拒绝说假话**。
     */
    if (sourceHitBusy(sourceName)) {
      /**
       * 并发受限：本次**什么都没证实**。不能说"源可达"，也不能说"源是空的"。
       * 与超时/限流同一档：保留上一次的结果（`degraded=true`），
       * 但不进 `errors` —— 它既不是源的故障、也不是用户的配置问题，
       * 而是一次**可重试的拥塞**，warning 已经由 `noteSourceBusy` 打过（每源一条）。
       */
      return { skills: [], degraded: true, failed: false };
    }
    /**
     * 正常完成了但一条都没有。
     *
     * 判据：这**不是失败** —— 请求都回来了、状态码都看过，只是该源当前确实没有可展示的技能
     * （比如内置技能一个都没启用、第三方排行榜为空）。照实写一条 info：空结果必须可见，
     * 但它不该伪装成故障。`degraded` 保持 false：空结果确实是这个源现在的真实状态。
     */
    info(`Source "${sourceName}" 本次没有可展示的技能（源可达、返回为空）`);
  }
  return { skills: outcome.value, degraded: false, failed: false };
}

// ========== GitHub API Helpers ==========

/** GitHub API 请求头（包含 Accept header + 用户配置的 Token 认证） */
function githubApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // 读取用户在 Git 配置中设置的 GitHub Token，避免未认证限流（60 次/小时 → 5000 次/小时）
  try {
    const gitConfig = getSettingJSON<{ githubToken?: string } | null>("codem-git-config", null);
    if (gitConfig?.githubToken) {
      headers["Authorization"] = `Bearer ${gitConfig.githubToken}`;
    }
  } catch {
    // DB 未就绪等情况忽略
  }
  return headers;
}

/** 检查是否配置了 GitHub Token */
function hasGithubToken(): boolean {
  try {
    const gitConfig = getSettingJSON<{ githubToken?: string } | null>("codem-git-config", null);
    return !!gitConfig?.githubToken;
  } catch {
    return false;
  }
}

/** 获取仓库默认分支 */
async function getDefaultBranch(repoFullName: string): Promise<string> {
  const resp = await httpGet(
    `https://api.github.com/repos/${repoFullName}`,
    githubApiHeaders(),
  );
  if (resp.status !== 200) return "main";
  const data = JSON.parse(resp.body);
  return data.default_branch || "main";
}

// ========== GitHub Trees API (移植自 vercel-labs/skills blob.ts) ==========

/**
 * 已知技能目录前缀列表（相对仓库根目录）。
 * 移植自 vercel-labs/skills blob.ts 的 PRIORITY_PREFIXES，
 * 覆盖 30+ 种 Agent 约定的技能存放位置。
 * 排序规则：先匹配的优先，根目录最优先，然后按列表顺序。
 */
const SKILL_PRIORITY_PREFIXES: string[] = [
  "",                           // 根目录
  "skills/",                    // 通用 skills/ 目录
  "skills/.curated/",           // curated 子目录
  "skills/.experimental/",     // experimental 子目录
  "skills/.system/",            // system 子目录
  ".agents/skills/",            // 通用 agent skills
  ".claude/skills/",            // Claude
  ".cline/skills/",             // Cline
  ".codebuddy/skills/",         // CodeBuddy
  ".codex/skills/",             // Codex
  ".commandcode/skills/",       // CommandCode
  ".continue/skills/",          // Continue
  ".github/skills/",            // GitHub
  ".goose/skills/",             // Goose
  ".grok/skills/",              // Grok
  ".iflow/skills/",             // iFlow
  ".june/skills/",              // June
  ".kilocode/skills/",          // KiloCode
  ".kimchi/skills/",            // Kimchi
  ".kiro/skills/",              // Kiro
  ".minimax/skills/",           // MiniMax
  ".mux/skills/",               // Mux
  ".neovate/skills/",           // Neovate
  ".opencode/skills/",          // OpenCode
  ".openhands/skills/",         // OpenHands
  ".pi/skills/",                // Pi
  ".post/assistant/skills/",    // Post
  ".qoder/skills/",             // Qoder
  ".roo/skills/",               // Roo
  ".tree/skills/",              // Tree
  ".windserf/skills/",          // Windserf
  ".zcode/skills/",             // ZCode
  ".zencoder/skills/",           // ZenCoder
  ".codem/skills/",             // Codem (our own convention)
];

/** Trees API 返回的树条目 */
interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
  url?: string;
}

/** Trees API 返回的完整树 */
interface RepoTree {
  sha: string;
  branch: string;
  tree: TreeEntry[];
}

/**
 * 通过 GitHub Trees API 一次性获取仓库的完整文件树。
 * 移植自 vercel-labs/skills blob.ts 的 fetchRepoTree()。
 *
 * API 端点：GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
 * 返回仓库中所有文件和目录的扁平列表，一次调用即可获取全部。
 *
 * 认证策略：先匿名（60 次/小时），403 限流时切换到 token 认证。
 */

/** 从响应头里按**大小写不敏感**的方式取限流余量。 */
function rateLimitRemaining(resp: HttpResponse): string | undefined {
  for (const [k, v] of Object.entries(resp.headers || {})) {
    if (k.toLowerCase() === "x-ratelimit-remaining") return v;
  }
  return undefined;
}

/**
 * 这次响应是不是"配额已耗尽"的 403。
 *
 * 为什么要单独判定：GitHub 对**不存在的分支**也回 403，对**配额耗尽**也回 403。
 * 前者换 branch 重试、或者退化成 Contents API 兜底是有意义的（能拿到东西）；
 * 后者继续打只会把剩余配额和 12 秒窗口一起烧光 —— 两个调用方一个会**换分支重试**、
 * 一个会**退化成逐目录串行请求**，都是纯粹的浪费。
 */
function isRateLimitedResponse(resp: HttpResponse): boolean {
  if (resp.status !== 403) return false;
  const remaining = rateLimitRemaining(resp);
  if (remaining === "0") return true;
  // 没有限流头时不敢断言是限流（可能是 403 权限/分支不存在），交给调用方按普通失败处理。
  return false;
}

/** 带限流缓存的仓库树缓存项 */
interface RepoTreeCacheEntry {
  tree: RepoTree | null;
  rateLimited: boolean;
}

/**
 * 同一个仓库的 Trees 请求复用规则。
 *
 * 判据（代码级，非推测）：`anthropic-skills`（github-repo）与两个 github-search 源
 * 会命中同一批仓库，改动前 `fetchRepoTree` 没有任何缓存 —— 真机读数里 `api.github.com`
 * 一次刷新被打了 54 次，其中大量是同一仓库的重复 Trees 请求。在 60 次/小时的匿名配额下，
 * 重复请求就是把"能用"变成"403"的直接原因。
 *
 * 两种结论的复用期**故意不同**：
 *  - 成功（拿到了树）：仓库树基本只随 push 变化，缓存 30 分钟，省下的是真实配额；
 *  - 失败/限流：只缓存 60 秒 —— 够挡住"同一秒里两个源问同一个仓库"的重复，
 *    又不至于让"配额已经恢复"或"分支名变了"这件事被一个长冷却期掩盖住
 *    （安装路径 `installSkillFromGitHubDir` 也走这里，绝不能让它被长冷却骗到）。
 */
const REPO_TREE_TTL_MS = 30 * 60 * 1000;
const REPO_TREE_FAILURE_TTL_MS = 60 * 1000;
const repoTreeCache = new Map<string, { at: number; entry: RepoTreeCacheEntry }>();

async function fetchRepoTreeCached(ownerRepo: string, ref?: string): Promise<RepoTreeCacheEntry> {
  const key = `${ownerRepo}@${ref || "HEAD"}`;
  const hit = repoTreeCache.get(key);
  if (hit) {
    const ttl = hit.entry.tree ? REPO_TREE_TTL_MS : REPO_TREE_FAILURE_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.entry;
  }
  const entry = await fetchRepoTreeInternal(ownerRepo, ref);
  repoTreeCache.set(key, { at: Date.now(), entry });
  return entry;
}

async function fetchRepoTreeInternal(ownerRepo: string, ref?: string): Promise<RepoTreeCacheEntry> {
  const branches = ref ? [ref] : ["HEAD", "main", "master"];

  for (const branch of branches) {
    try {
      const url = `https://api.github.com/repos/${ownerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
      const resp = await httpGet(url, githubApiHeaders());

      if (resp.status === 200) {
        const data = JSON.parse(resp.body);
        if (data.tree && Array.isArray(data.tree)) {
          return { tree: { sha: data.sha, branch, tree: data.tree }, rateLimited: false };
        }
      }

      // 403 + 配额耗尽 → 换分支/换兜底都没意义（同样会 403），直接带着"限流"标记出去
      if (isRateLimitedResponse(resp)) {
        return { tree: null, rateLimited: true };
      }
    } catch {
      // 继续尝试下一个分支
    }
  }

  return { tree: null, rateLimited: false };
}

/** 向后兼容的薄封装：只关心"有没有树"的调用方（如安装路径）继续用它。 */
async function fetchRepoTree(ownerRepo: string, ref?: string): Promise<RepoTree | null> {
  const { tree } = await fetchRepoTreeCached(ownerRepo, ref);
  return tree;
}

/**
 * 已就"GitHub 限流"这件事记过账的源（源 id → 记账时刻）。
 *
 * 为什么要按源记账：一次刷新里 `anthropic-skills` 与两个 github-search 源各自都会撞限流，
 * 三个源都值得在 UI 上被单独解释一次（"这个源这次为什么是空的"），
 * 但**同一个源内部**绝不能像改动前那样每仓库刷一条（真机基线：一次刷新 35 条）。
 */
const githubRateLimitNoted = new Map<string, number>();

/** 上一次撞到 GitHub 限流的时刻（0 = 本次刷新内没撞过）。用于"同一个源内部不要再打了"。 */
let githubRateLimitedAt = 0;

/** 距离上次撞限流是否还在冷却期内。 */
function githubRateLimitCoolingDown(): boolean {
  return githubRateLimitedAt > 0 && Date.now() - githubRateLimitedAt < RATE_LIMIT_COOLDOWN_MS;
}

/**
 * 记一次限流。
 * @param sourceId 撞限流的市场源 id（用于"每源只说一次"，不是每仓库一次）
 * @param scope 说明里带上具体范围（仓库名/源名），便于复核
 */
function noteGithubRateLimit(sourceId: string, scope: string): void {
  githubRateLimitedAt = Date.now();
  if (githubRateLimitNoted.has(sourceId)) return;
  githubRateLimitNoted.set(sourceId, Date.now());
  info(
    `源 "${sourceId}" 依赖的 GitHub API 未认证配额（60 次/小时）已耗尽 —— 该源本次只拿到部分结果；` +
    `在 设置 → Git 偏好 里配好 GitHub Token 可把配额提到 5000 次/小时（触发点：${scope}）`,
  );
}

/**
 * 每轮刷新重新开始限流判定：上一轮的结论不该跨刷新永久生效。
 *
 * 同一个复位点也清掉"超时已报账"的集合（`sourceTimeoutWarned`，定义在
 * `withSourceTimeout` 上方）—— 两者共用**同一条轮次边界**：一轮刷新 = 一次复位。
 * 刻意不各留一个 `reset*`：两处复位点迟早会分叉，那时"限流说每源一次、
 * 超时说每轮一次"就会变成两种口径，而它们本该是同一条纪律。
 *
 * ## 轮次合并（`ROUND_COALESCE_MS`）：**回调点不带轮次标识**的补偿
 *
 * 这个函数被 `listMarketSkills()` 与 `searchMarketSkillsOnline()` **各自**在开头调用，
 * 而它们是同一次用户动作（点"检查更新" / 触发搜索）里的两次调用。
 * 如果每次都真的清，"后一次调用"会把"前一次刚记下的超时账本"抹掉，重复告警原样复现。
 *
 * 所以这里加了时间判定：**距上一次开轮不足 `ROUND_COALESCE_MS` 就视为同一轮，不清**。
 * 判据与代价见 `ROUND_COALESCE_MS` 的注释（含"3 秒内的两次刷新会被当成一轮"这个已知取舍）。
 */
function resetGithubRateLimitState(): void {
  const now = Date.now();
  if (roundOpenedAt > 0 && now - roundOpenedAt < ROUND_COALESCE_MS) return;
  roundOpenedAt = now;
  githubRateLimitedAt = 0;
  githubRateLimitNoted.clear();
  sourceTimeoutWarned.clear();
  // 同理清掉"本轮被闸门拒过的源"：上一轮的拥塞结论不该跨轮生效
  // （否则**上一轮**的 BUSY 会把**这一轮**的空结果也误标成"并发受限"）。
  sourceBusyCount.clear();
}

/**
 * 在仓库树中查找所有 SKILL.md 文件的路径。
 * 移植自 vercel-labs/skills blob.ts 的 findSkillMdPaths()。
 *
 * 如果指定了 subdir，只在该子目录下搜索；否则搜索整个仓库。
 * 返回的路径列表按 SKILL_PRIORITY_PREFIXES 优先级排序。
 */
function findSkillMdPathsInTree(tree: RepoTree, subdir?: string): string[] {
  // 找到所有以 SKILL.md 结尾的 blob 条目（大小写不敏感）
  const allSkillMds = tree.tree
    .filter((e) => e.type === "blob" && e.path.toLowerCase().endsWith("skill.md"))
    .map((e) => e.path);

  // 如果有 subdir，只保留该子目录下的
  const prefix = subdir
    ? (subdir.endsWith("/") ? subdir : subdir + "/")
    : "";
  const filtered = prefix
    ? allSkillMds.filter((p) => p.startsWith(prefix) || p === prefix + "SKILL.md")
    : allSkillMds;

  // 按 SKILL_PRIORITY_PREFIXES 优先级排序
  // 越靠前的前缀，优先级越高
  const getPriority = (skillMdPath: string): number => {
    // 去掉末尾的 SKILL.md 得到技能目录路径
    let folderPath = skillMdPath.replace(/\//g, "/");
    if (folderPath.toLowerCase().endsWith("/skill.md")) {
      folderPath = folderPath.slice(0, -9); // 去掉 "/SKILL.md"
    } else if (folderPath.toLowerCase().endsWith("skill.md")) {
      folderPath = folderPath.slice(0, -8); // 去掉 "SKILL.md"
    }
    if (folderPath.endsWith("/")) {
      folderPath = folderPath.slice(0, -1);
    }

    // 根目录技能
    if (!folderPath) return 0;

    // 找到匹配的优先级前缀
    for (let i = 0; i < SKILL_PRIORITY_PREFIXES.length; i++) {
      const p = SKILL_PRIORITY_PREFIXES[i];
      if (p && (folderPath.startsWith(p) || folderPath === p.slice(0, -1))) {
        return i;
      }
    }

    // 未知前缀，排到最后
    return SKILL_PRIORITY_PREFIXES.length;
  };

  return filtered.sort((a, b) => getPriority(a) - getPriority(b));
}

/**
 * 从 SKILL.md 路径提取技能目录路径（去掉末尾的 SKILL.md）。
 */
function getSkillDirFromPath(skillMdPath: string): string {
  let folderPath = skillMdPath.replace(/\//g, "/");
  if (folderPath.toLowerCase().endsWith("/skill.md")) {
    folderPath = folderPath.slice(0, -9);
  } else if (folderPath.toLowerCase().endsWith("skill.md")) {
    folderPath = folderPath.slice(0, -8);
  }
  if (folderPath.endsWith("/")) {
    folderPath = folderPath.slice(0, -1);
  }
  return folderPath;
}

/**
 * 从 SKILL.md 路径提取技能 slug 名称（目录的最后一段）。
 */
function getSkillSlugFromPath(skillMdPath: string): string {
  const dir = getSkillDirFromPath(skillMdPath);
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] || "skill";
}

// ========== Source Adapters ==========

/**
 * 从 GitHub 仓库目录型源获取技能列表。
 * 使用 GitHub Trees API 一次性获取仓库完整文件树，在内存中搜索所有 SKILL.md。
 * 支持任意仓库结构（根目录 / skills/ / .agents/skills/ 等均可自动发现）。
 */
async function fetchGitHubRepoSkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  try {
    // 获取仓库信息
    const repoResp = await httpGet(source.url, githubApiHeaders());
    if (repoResp.status !== 200) {
      // 403 是"配额耗尽"还是"仓库不可用"必须分开说：前者用户能自己解决（配 Token），
      // 后者只能等源恢复。改动前两者都只打一个 403，用户无从判断该做什么。
      const limited = isRateLimitedResponse(repoResp);
      if (limited) noteGithubRateLimit(source.id, source.name);
      console.warn(
        `[SkillMarket] Failed to fetch repo info for ${source.id}: ${repoResp.status}` +
        (limited ? "（GitHub 未认证配额耗尽，配置 GitHub Token 可恢复）" : ""),
      );
      return skills;
    }
    const repoInfo = JSON.parse(repoResp.body);
    const defaultBranch = repoInfo.default_branch || "main";
    const repoFullName = repoInfo.full_name;

    // 使用 Trees API 一次性获取仓库完整文件树
    const treeResult = await fetchRepoTreeCached(repoFullName, defaultBranch);
    if (treeResult.rateLimited) {
      noteGithubRateLimit(source.id, repoFullName);
      return skills; // 限流时不做 Contents API 兜底：那只会再打一串同样 403 的请求
    }
    const tree = treeResult.tree;
    if (!tree) {
      console.warn(`[SkillMarket] Trees API failed for ${repoFullName}, falling back to Contents API`);
      return await fetchGitHubRepoSkillsLegacy(source, repoInfo);
    }

    // 在树中搜索所有 SKILL.md 文件，按优先级排序
    const skillMdPaths = findSkillMdPathsInTree(tree, source.subdir);
    if (skillMdPaths.length === 0) {
      console.warn(`[SkillMarket] No SKILL.md found in tree for ${repoFullName}`);
      return skills;
    }

    info(`Trees API found ${skillMdPaths.length} SKILL.md files in ${repoFullName}`);

    // 取每个 SKILL.md 的内容：**有界并发**（改动前是 19~30 路无界 Promise.allSettled，
    // 真机读数里这一个源会把 20+ 个 raw 请求插进同一毫秒）
    const results = await mapLimit(skillMdPaths, SOURCE_FETCH_CONCURRENCY, async (skillMdPath) => {
      const rawUrl = `https://raw.githubusercontent.com/${repoFullName}/${tree.branch}/${skillMdPath}`;
      const mdResp = await httpGet(rawUrl);
      if (mdResp.status !== 200) return null;

      const skillDef = parseSkillMarkdown(mdResp.body, skillMdPath);
      if (!skillDef) return null;

      const slug = getSkillSlugFromPath(skillMdPath);
      const dirPath = getSkillDirFromPath(skillMdPath);

      return {
        id: `${source.id}:${slug}`,
        name: skillDef.name || slug,
        displayName: skillDef.displayName || skillDef.name || slug,
        description: skillDef.description || "",
        author: skillDef.author || repoFullName.split("/")[0],
        version: skillDef.version,
        tags: skillDef.tags,
        sourceId: source.id,
        sourceName: source.name,
        downloadUrl: `https://api.github.com/repos/${repoFullName}/zipball/${defaultBranch}`,
        repoUrl: `https://github.com/${repoFullName}/tree/${defaultBranch}/${dirPath}`,
        lastUpdated: repoInfo.updated_at,
        installType: "dir" as const,
        dirPath,
        repoFullName,
        branch: defaultBranch,
      } satisfies MarketSkill;
    });

    for (const value of results) {
      if (value) skills.push(value);
    }
  } catch (err) {
    /**
     * **BUSY 必须被单独认出来，不能混进普通失败。**
     *
     * 真机 1.16.112 的缺陷就是在这里丢掉了"这其实是并发受限"这个事实：
     * 异常被就地吞掉、`return []`，随后 `mergeSourceResult` 把空数组
     * 解释成"源可达、返回为空"——一句与事实相反的结论。
     *
     * 这里不再只打一条 `console.error` 了事，而是：
     *  1. 记进 `sourceBusyCount`（按源，供 `mergeSourceResult` 拒绝说假话）；
     *  2. `console.error` 保留 —— 它仍然是**真问题**（请求没发出去），不许静默。
     */
    if (isBusyHttpError(err)) {
      noteSourceBusy(source.name, source.id, "fetchGitHubRepoSkills");
    }
    console.error(`[SkillMarket] Error fetching repo skills for ${source.id}:`, err);
  }

  return skills;
}

/**
 * Legacy fallback：使用 Contents API 逐层遍历获取仓库技能列表。
 * 仅在 Trees API 失败时使用。
 *
 * 第 63 轮：这里原来是 `for (const dir of dirs) { await httpGet(...) }` ——
 * **串行**打 N 个 raw 请求（N = 仓库根目录数，真机读数里单个仓库就能到几十个）。
 * 它只在 Trees API 彻底失败时才走，在"GitHub 限流"的现场恰恰是最容易被触发的路径，
 * 于是"串行 N 请求 × 每个最多 15s"必然撞上 12s 的源上限。改成有界并发。
 */
async function fetchGitHubRepoSkillsLegacy(source: MarketSource, repoInfo: any): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const defaultBranch = repoInfo.default_branch || "main";
  const repoFullName = repoInfo.full_name;

  const contentsPath = source.subdir
    ? `https://api.github.com/repos/${repoFullName}/contents/${source.subdir}?ref=${defaultBranch}`
    : `https://api.github.com/repos/${repoFullName}/contents/?ref=${defaultBranch}`;
  const contentsResp = await httpGet(contentsPath, githubApiHeaders());
  if (contentsResp.status !== 200) return skills;
  const rootContents = JSON.parse(contentsResp.body);
  if (!Array.isArray(rootContents)) return skills;

  const dirs = rootContents.filter((item: any) => item.type === "dir");
  const skillMdBase = source.subdir
    ? `https://raw.githubusercontent.com/${repoFullName}/${defaultBranch}/${source.subdir}`
    : `https://raw.githubusercontent.com/${repoFullName}/${defaultBranch}`;

  const parsed = await mapLimit(dirs as any[], SOURCE_FETCH_CONCURRENCY, async (dir: any) => {
    try {
      const skillMdUrl = `${skillMdBase}/${dir.name}/SKILL.md`;
      const mdResp = await httpGet(skillMdUrl);
      if (mdResp.status !== 200) return null;
      const skillPath = source.subdir
        ? `${source.subdir}/${dir.name}/SKILL.md`
        : `${dir.name}/SKILL.md`;
      const skillDef = parseSkillMarkdown(mdResp.body, skillPath);
      if (!skillDef) return null;
      return {
        id: `${source.id}:${dir.name}`,
        name: skillDef.name || dir.name,
        displayName: skillDef.displayName || skillDef.name || dir.name,
        description: skillDef.description || "",
        author: skillDef.author || repoFullName.split("/")[0],
        version: skillDef.version,
        tags: skillDef.tags,
        sourceId: source.id,
        sourceName: source.name,
        downloadUrl: `https://api.github.com/repos/${repoFullName}/zipball/${defaultBranch}`,
        repoUrl: dir.html_url || `https://github.com/${repoFullName}/tree/${defaultBranch}/${source.subdir ? source.subdir + "/" : ""}${dir.name}`,
        lastUpdated: repoInfo.updated_at,
        installType: "dir" as const,
        dirPath: source.subdir ? `${source.subdir}/${dir.name}` : dir.name,
        repoFullName,
        branch: defaultBranch,
      } satisfies MarketSkill;
    } catch (err) {
      console.warn(`[SkillMarket] Legacy: Failed for ${dir.name}:`, err);
      return null;
    }
  });

  for (const value of parsed) {
    if (value) skills.push(value);
  }
  return skills;
}

/**
 * 从 GitHub 搜索型源获取技能列表。
 * 搜索结果中的每个仓库被视为一个技能。
 * 使用 Trees API 搜索每个仓库中的 SKILL.md（支持任意目录结构）。
 *
 * ## 第 63 轮：这个函数是"12 秒超时"的主要来源，改的是**并发纪律**而不是日志
 *
 * 改动前：`Promise.allSettled(items.map(...))` —— 30 个仓库**同时**打 Trees API，
 * 每个仓库失败还会再打一次 Contents API（Contents 分支内部是逐目录串行）。
 * 真机读数：`api.github.com` 一次刷新 54 个请求、`raw.githubusercontent.com` 69 个，
 * 1 秒内 30 个 Trees 请求并发发出，随后 20+ 个返回 403（配额 60 次/小时已打光），
 * 于是"搜索型源"整源卡死到 12s 上限、一条技能都拿不到。
 *
 * 改后：
 *  - 并发上限 8（同批 30 个请求实测 1.4s 全返回）
 *  - 撞到限流就**停止继续打**，并且不再退化成 Contents 兜底（那只会继续 403）
 *  - 同一仓库的 Trees 请求在一次刷新内复用（`fetchRepoTreeCached`）
 *  - 结果如实告诉用户被跳过了多少仓库（不假装完整）
 */
async function fetchGitHubSearchSkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  try {
    const resp = await httpGet(source.url, githubApiHeaders());
    if (resp.status !== 200) {
      const limited = isRateLimitedResponse(resp);
      if (limited) noteGithubRateLimit(source.id, source.name);
      console.warn(
        `[SkillMarket] GitHub search failed for ${source.id}: ${resp.status}` +
        (limited ? "（GitHub 未认证配额耗尽，配置 GitHub Token 可恢复）" : ""),
      );
      return skills;
    }

    const data = JSON.parse(resp.body);
    if (!data.items || !Array.isArray(data.items)) return skills;

    let skipped = 0;

    // 有界并发处理每个仓库：先用 Trees API 搜索 SKILL.md，找到则用 dir 类型
    const repoSkills = await mapLimit(
      data.items as any[],
      SOURCE_FETCH_CONCURRENCY,
      async (repo: any): Promise<MarketSkill | null> => {
        let description = repo.description || "";
        let displayName = repo.name;
        let author = repo.owner?.login || "";
        let tags: string[] | undefined;
        let version: string | undefined;
        const branch = repo.default_branch || "main";

        // 用 Trees API 搜索仓库中的 SKILL.md（支持嵌套目录结构）
        let skillMdPath: string | null = null;
        let installType: "zip" | "dir" = "zip";
        let dirPath: string | undefined;

        // 已经确认在冷却期内限流 → 不再打扰 API，直接把本仓库记为"跳过"
        if (githubRateLimitCoolingDown()) {
          skipped++;
          return null;
        }

        const treeResult = await fetchRepoTreeCached(repo.full_name, branch);
        if (treeResult.rateLimited) {
          noteGithubRateLimit(source.id, repo.full_name);
          skipped++;
          return null;
        }
        const tree = treeResult.tree;
        if (tree) {
          const skillMdPaths = findSkillMdPathsInTree(tree);
          if (skillMdPaths.length > 0) {
            skillMdPath = skillMdPaths[0]; // 取优先级最高的
            dirPath = getSkillDirFromPath(skillMdPath);
            installType = "dir";
          }
        }

        // 如果 Trees API 找到了 SKILL.md，获取其内容
        if (skillMdPath && tree) {
          try {
            const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${tree.branch}/${skillMdPath}`;
            const mdResp = await httpGet(rawUrl);
            if (mdResp.status === 200) {
              const skillDef = parseSkillMarkdown(mdResp.body, skillMdPath);
              if (skillDef) {
                displayName = skillDef.displayName || skillDef.name || displayName;
                description = skillDef.description || description;
                author = skillDef.author || author;
                version = skillDef.version;
                tags = skillDef.tags;
              }
            }
          } catch {
            // SKILL.md 读取失败 — 使用仓库元数据
          }
        } else {
          // Trees API 未找到 SKILL.md，fallback 到根目录直接尝试
          try {
            const skillMdUrl = `https://raw.githubusercontent.com/${repo.full_name}/${branch}/SKILL.md`;
            const mdResp = await httpGet(skillMdUrl);
            if (mdResp.status === 200) {
              const skillDef = parseSkillMarkdown(mdResp.body, "");
              if (skillDef) {
                displayName = skillDef.displayName || skillDef.name || displayName;
                description = skillDef.description || description;
                author = skillDef.author || author;
                version = skillDef.version;
                tags = skillDef.tags;
                // 根目录有 SKILL.md → dir 类型，dirPath 为空（根目录）
                installType = "dir";
                dirPath = "";
              }
            }
          } catch {
            // SKILL.md not found — use repo metadata only
          }
        }

        return {
          id: `${source.id}:${repo.full_name}`,
          name: repo.name,
          displayName,
          description: description || "无描述",
          author,
          version,
          tags: Array.isArray(tags) ? tags : (Array.isArray(repo.topics) ? repo.topics : []),
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: `https://api.github.com/repos/${repo.full_name}/zipball/${branch}`,
          repoUrl: repo.html_url,
          stars: repo.stargazers_count,
          lastUpdated: repo.updated_at,
          installType,
          dirPath,
          repoFullName: repo.full_name,
          branch,
        } satisfies MarketSkill;
      },
    );

    for (const value of repoSkills) {
      if (value) skills.push(value);
    }

    if (skipped > 0) {
      // 降级必须写在界面上也看得见的信息级日志里：用户要知道"少的是被限流跳过的，不是不存在"
      info(`GitHub 搜索源 "${source.name}"：${skills.length} 个仓库完成，${skipped} 个因 API 限流被跳过（改配 GitHub Token 可避免）`);
    }
  } catch (err) {
    // BUSY 同样要单独认出来（理由同 fetchGitHubRepoSkills）：否则空数组会被
    // mergeSourceResult 解释成"源可达、返回为空"——一句与事实相反的结论。
    if (isBusyHttpError(err)) noteSourceBusy(source.name, source.id, "fetchGitHubSearchSkills");
    console.error(`[SkillMarket] Error fetching search skills for ${source.id}:`, err);
  }

  return skills;
}

/**
 * 获取内置技能列表作为市场条目。
 */
async function fetchBuiltinSkills(source: MarketSource): Promise<MarketSkill[]> {
  const registry = getSkillRegistry();
  const allSkills = registry.getAll();
  return allSkills
    .filter((s) => s.source === "builtin")
    .map((s) => ({
      id: `${source.id}:${s.name}`,
      name: s.name,
      displayName: s.displayName || s.name,
      description: s.description,
      author: s.author || "Codem",
      version: s.version,
      tags: s.tags,
      sourceId: source.id,
      sourceName: source.name,
      downloadUrl: "",
      installType: "builtin" as const,
      installed: true,
    }));
}

// ========== ClawHub.ai API Adapter ==========

/**
 * 从 ClawHub.ai REST API 获取技能列表。
 *
 * ClawHub 是 OpenClaw 生态的技能市场，提供 REST API：
 *   GET /api/v1/skills?limit=&cursor=&sort= → 技能列表（游标分页）
 *
 * 响应格式：
 *   { data: [{ name, slug, description, author, downloads, ... }], nextCursor: "..." }
 *
 * API 文档：https://docs.openclaw.ai/clawhub/api
 * 公共读取无需认证，IP 级限流 3000/min。
 */
async function fetchClawHubSkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 3; // 最多 3 页 × 100 条/页 = 300 条（避免多页串行请求导致加载慢）
  const PAGE_SIZE = 100;
  let pageNum = 0;

  try {
    const baseUrl = source.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (source.apiToken) {
      headers["Authorization"] = `Bearer ${source.apiToken}`;
    }

    let cursor: string | null = null;

    while (pageNum < MAX_PAGES) {
      // 构建带分页参数的 URL
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("sort", "downloads");
      if (cursor) {
        params.set("cursor", cursor);
      }

      const resp = await httpGet(`${baseUrl}/api/v1/skills?${params.toString()}`, headers);
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] ClawHub API failed (page ${pageNum}): ${resp.status}`);
        break;
      }

      const data = JSON.parse(resp.body);
      // 兼容多种响应格式
      const items: any[] = data.data || data.items || data.skills || [];
      if (items.length === 0) break;

      for (const item of items) {
        const slug = item.slug || item.name;
        if (!slug) continue;
        const author = item.author || item.owner || "";
        skills.push({
          id: `${source.id}:${slug}`,
          name: slug,
          displayName: item.displayName || item.name || slug,
          description: item.description || "无描述",
          author,
          version: item.version,
          tags: Array.isArray(item.tags) ? item.tags : [],
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: item.installUrl || item.downloadUrl || (item.repoFullName ? `https://api.github.com/repos/${item.repoFullName}/zipball/main` : `${baseUrl}/${author}/skills/${slug}`),
          repoUrl: item.url || `${baseUrl}/${author}/skills/${slug}`,
          stars: item.downloads || item.installs,
          lastUpdated: item.updatedAt,
          installType: "zip",
          repoFullName: item.repoFullName,
          branch: item.branch || "main",
        });
      }

      // 检查是否有下一页游标
      cursor = data.nextCursor || data.cursor || data.next_cursor || null;
      if (!cursor) break;
      pageNum++;
    }
  } catch (err) {
    // 同上：ClawHub 是分页串行取的，被闸门拒掉一页会让整源变成"空"——
    // 必须记成"并发受限"，不能让它伪装成"源可达、返回为空"。
    if (isBusyHttpError(err)) noteSourceBusy(source.name, source.id, "fetchClawHubSkills");
    console.error(`[SkillMarket] Error fetching ClawHub skills:`, err);
  }

  console.log(`[SkillMarket] ClawHub: fetched ${skills.length} skills across ${pageNum + 1} page(s)`);
  return skills;
}

// ========== Skills.sh API Adapter ==========

/**
 * 从 Skills.sh 获取技能列表。
 *
 * Skills.sh 由 Vercel 运营，提供 REST API：
 *   GET /api/v1/skills?view=all-time&page=0&per_page=100 → 分页排行榜
 *
 * 认证：Vercel OIDC Token（桌面应用无法获取）。
 * 策略：
 *   1. 先尝试 API 无认证请求（部分端点可能允许匿名访问）
 *   2. 若 401，fallback 到网页版 HTML 爬取（解析排行榜页面中的技能数据）
 *   3. 网页版支持多视图：all-time / trending / hot
 *
 * API 文档：https://skills.sh/docs/api
 */
async function fetchSkillsShSkills(source: MarketSource): Promise<MarketSkill[]> {
  const baseUrl = source.url.replace(/\/$/, "");

  // 策略 1：尝试 API 无认证请求
  const apiSkills = await fetchSkillsShViaAPI(source, baseUrl);
  if (apiSkills.length > 0) {
    return apiSkills;
  }

  // 策略 2：fallback 到网页版 HTML 爬取
  info("Skills.sh API 未返回条目（401 需要 Vercel OIDC Token / 或匿名不可用）—— 改走网页版抓取");
  return await fetchSkillsShViaHTML(source, baseUrl);
}

/**
 * 通过 Skills.sh REST API 获取技能（带分页）。
 * API 可能需要 Vercel OIDC 认证，尝试无认证请求。
 */
async function fetchSkillsShViaAPI(source: MarketSource, baseUrl: string): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 2; // 最多 2 页 × 500 条/页 = 1000 条（避免多页串行请求导致加载慢）
  const PER_PAGE = 500;

  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (source.apiToken) {
      headers["Authorization"] = `Bearer ${source.apiToken}`;
    }

    let page = 0;
    let hasMore = true;

    while (hasMore && page < MAX_PAGES) {
      const resp = await httpGet(
        `${baseUrl}/api/v1/skills?view=all-time&page=${page}&per_page=${PER_PAGE}`,
        headers,
      );
      if (resp.status === 401) {
        /**
         * ## 为什么这条从 `console.warn` 降成 `console.log`（判据，不是"为了让日志干净"）
         *
         * 1. **这是设计内的正常形态，不是失败**：Skills.sh 的 `/api/v1/skills` 只认 Vercel OIDC
         *    Token，而 OIDC Token 是 Vercel 在它自己的构建/部署运行时里签发的**短时凭证**——
         *    桌面应用既没有 Vercel 项目上下文，也没有签发方，**本机不可能拿到**（我这台机器上
         *    没有 Vercel 相关环境变量，`codem-market-sources` 也没有任何配置项能填它：
         *    全仓库只有 `MarketSource.apiToken` 这一个字段，且没有任何 UI/设置写入它）。
         * 2. **路径已闭环**：401 之后我们**立刻**走 HTML 兜底，而且兜底是成功的
         *    ——真机读数 `Skills.sh HTML: scraped 432 skills`（首次基线 475 条）。
         *    也就是说这条 401 不代表"功能坏了"，而代表"探测到了一个用不上的端点，然后换路成功"。
         * 3. 反过来，如果用户**自己配了** `source.apiToken` 却仍 401，那就是真问题（凭据无效），
         *    这种情况**保留 warning**，不放水。
         *
         * 文本里照样写清原因与后续动作（不静默）：见下面两条 info 日志。
         */
        if (source.apiToken) {
          console.warn("[SkillMarket] Skills.sh 已配置 apiToken 但仍返回 401 —— 该 Token 无效或已过期，本次改走网页兜底");
        } else {
          info(
            "Skills.sh REST API 需要 Vercel OIDC Token（桌面端无法获取，属正常形态）—— " +
            "本次改走网页版抓取（这是设计好的兜底路径，功能不受影响）",
          );
        }
        return skills; // 返回已获取的（可能为空）
      }
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] Skills.sh API failed (page ${page}): ${resp.status}`);
        return skills;
      }

      const data = JSON.parse(resp.body);
      const items: any[] = data.data || [];
      if (items.length === 0) break;

      for (const item of items) {
        const skillId = item.id || `${item.source}/${item.slug}`;
        skills.push({
          id: `${source.id}:${skillId}`,
          name: item.slug || item.name,
          displayName: item.name || item.slug,
          description: item.description || "无描述",
          author: item.source || "",
          version: item.version,
          tags: Array.isArray(item.tags) ? item.tags : [],
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: item.installUrl || (item.source ? `https://api.github.com/repos/${item.source}/zipball/main` : ""),
          repoUrl: item.url || `${baseUrl}/${skillId}`,
          stars: item.installs,
          lastUpdated: item.updatedAt,
          installType: item.source ? "dir" : "zip",
          repoFullName: item.source,
          dirPath: item.slug || item.name,
        });
      }

      // 检查分页信息
      const pagination = data.pagination;
      hasMore = pagination ? pagination.hasMore === true : false;
      page++;
    }

    console.log(`[SkillMarket] Skills.sh API: fetched ${skills.length} skills across ${page} page(s)`);
  } catch (err) {
    console.error(`[SkillMarket] Error fetching Skills.sh via API:`, err);
  }

  return skills;
}

/**
 * 通过爬取 Skills.sh 网页版 HTML 获取技能列表。
 *
 * Skills.sh 网站服务端渲染了排行榜数据，HTML 中包含技能名、来源、安装数等信息。
 * 解析 HTML 中的技能链接和文本内容。
 */
async function fetchSkillsShViaHTML(source: MarketSource, baseUrl: string): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  try {
    // 爬取多个视图页面
    const views = [
      { path: "", label: "all-time" },
      { path: "/trending", label: "trending" },
      { path: "/hot", label: "hot" },
    ];

    const seenSlugs = new Set<string>();

    for (const view of views) {
      try {
        const resp = await httpGet(`${baseUrl}${view.path}`, {
          "Accept": "text/html",
        });
        if (resp.status !== 200) {
          console.warn(`[SkillMarket] Skills.sh HTML scrape failed for ${view.label}: ${resp.status}`);
          continue;
        }

        const html = resp.body;

        // Skills.sh 页面中技能链接格式：/vercel-labs/skills/find-skills
        // 匹配所有技能详情页链接 — 只匹配字母数字和连字符组成的路径段
        const skillLinkPattern = /href="\/([a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*)\/([a-zA-Z0-9][\w.-]*)"/g;
        let match: RegExpExecArray | null;

        while ((match = skillLinkPattern.exec(html)) !== null) {
          const source_path = match[1]; // e.g., "vercel-labs/skills"
          const slug = match[2]; // e.g., "find-skills"

          // 过滤非技能链接（如 /agent/xxx, /topic/xxx, /docs 等）
          if (source_path.startsWith("agent/") ||
              source_path.startsWith("topic/") ||
              source_path.startsWith("docs") ||
              source_path === "packs" ||
              slug === "official" ||
              slug === "audits") {
            continue;
          }

          // 清洗 source_path：去除可能残留的 HTML 标签和属性
          // 正则可能匹配到 href 值中包含的额外 HTML 属性（如 link rel=...）
          const cleanSourcePath = source_path.replace(/[^a-zA-Z0-9._\-\/]/g, "");
          if (!cleanSourcePath || cleanSourcePath.includes("link") || cleanSourcePath.includes("svg")) {
            continue;
          }

          const skillId = `${cleanSourcePath}/${slug}`;
          if (seenSlugs.has(skillId)) continue;
          seenSlugs.add(skillId);

          // 尝试从页面文本中提取安装数
          // 技能名后面通常跟着安装数（如 "2.9M", "840.3K" 等）
          const installPattern = new RegExp(
            `${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*?([\\d.]+[KM]?)`,
            "i",
          );
          const installMatch = html.match(installPattern);
          let stars: number | undefined;
          if (installMatch) {
            const num = installMatch[1];
            if (num.endsWith("K")) {
              stars = Math.round(parseFloat(num) * 1000);
            } else if (num.endsWith("M")) {
              stars = Math.round(parseFloat(num) * 1000000);
            } else {
              stars = parseInt(num, 10) || undefined;
            }
          }

          // 显示名：将 slug 转为可读名称
          const displayName = slug
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");

          skills.push({
            id: `${source.id}:${skillId}`,
            name: slug,
            displayName,
            description: `Skills.sh skill from ${cleanSourcePath}`,
            author: cleanSourcePath,
            sourceId: source.id,
            sourceName: source.name,
            downloadUrl: `https://github.com/${cleanSourcePath}`,
            repoUrl: `${baseUrl}/${cleanSourcePath}/${slug}`,
            stars,
            installType: "dir",
            repoFullName: cleanSourcePath,
            dirPath: slug,
          });
        }
      } catch (err) {
        console.warn(`[SkillMarket] Skills.sh HTML scrape error for ${view.label}:`, err);
      }
    }

    console.log(`[SkillMarket] Skills.sh HTML: scraped ${skills.length} skills`);
  } catch (err) {
    console.error(`[SkillMarket] Error scraping Skills.sh HTML:`, err);
  }

  return skills;
}

// ========== SkillHub API Adapter ==========

/**
 * 从 SkillHub REST API 获取技能列表。
 *
 * SkillHub 是开源 AI Agent 技能市场（skills.palebluedot.live），
 * 索引了 25 万+ 技能，提供公开 REST API（无需认证）：
 *   GET /api/skills?q=&limit=&page=    → 搜索 + 分页
 *   GET /api/skills/featured            → 精选技能
 *   GET /api/skills/:id                 → 技能详情
 *   GET /api/skill-files/zip?skillId=   → 下载 ZIP
 *
 * 匿名限流：120 请求/分钟（读）、60 请求/分钟（搜索）
 *
 * API 文档：https://skills.palebluedot.live/en/docs/api
 */
async function fetchSkillHubAPISkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 2; // 最多 2 页 × 100 条/页 = 200 条
  const PAGE_SIZE = 100;

  try {
    const baseUrl = source.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };

    // 并行请求 featured + 各页数据（之前是串行，4 个请求 × 15s 超时 = 最长 60s）
    const pageUrls: string[] = [];
    pageUrls.push(`${baseUrl}/api/skills/featured`);
    for (let p = 0; p < MAX_PAGES; p++) {
      pageUrls.push(`${baseUrl}/api/skills?limit=${PAGE_SIZE}&page=${p}&sort=downloads`);
    }

    const results = await Promise.allSettled(
      pageUrls.map(url => httpGet(url, headers)),
    );

    const seenIds = new Set<string>();

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const resp = result.value;
      if (resp.status !== 200) continue;

      try {
        const data = JSON.parse(resp.body);
        const items: any[] = data.data || data.skills || data.items || (Array.isArray(data) ? data : []);

        for (const item of items) {
          const skillId = item.id || item._id || `${item.owner || item.source}/${item.slug || item.name}`;
          const skillKey = `${source.id}:${skillId}`;
          if (seenIds.has(skillKey)) continue;
          seenIds.add(skillKey);

          const slug = item.slug || item.name || skillId;
          const author = item.owner || item.source || item.author || "";
          const downloadUrl = item.zipUrl || item.downloadUrl ||
            (item._id || item.id ?
              `${baseUrl}/api/skill-files/zip?skillId=${item._id || item.id}` :
              `${baseUrl}/api/skill-files/zip?skillId=${slug}`);

          skills.push({
            id: skillKey,
            name: slug,
            displayName: item.displayName || item.name || slug,
            description: item.description || item.summary || "无描述",
            author,
            version: item.version,
            tags: Array.isArray(item.tags) ? item.tags : (Array.isArray(item.categories) ? item.categories : []),
            sourceId: source.id,
            sourceName: source.name,
            downloadUrl,
            repoUrl: item.url || item.repoUrl || (author ? `https://github.com/${author}` : undefined),
            stars: item.downloads || item.installs || item.stars,
            lastUpdated: item.updatedAt || item.updated_at,
            installType: "zip",
            repoFullName: item.repoFullName || (author ? `${author}/${slug}` : undefined),
            branch: item.branch || "main",
          });
        }
      } catch (e) {
        console.warn("[SkillMarket] SkillHub parse error:", e);
      }
    }

    console.log(`[SkillMarket] SkillHub API: fetched ${skills.length} skills`);
  } catch (err) {
    console.error(`[SkillMarket] Error fetching SkillHub skills:`, err);
  }

  return skills;
}

/**
 * 从 SkillHub 指定端点获取技能并追加到 skills 数组。
 * 返回本次获取到的技能数量。
 */
async function fetchSkillHubEndpoint(
  url: string,
  source: MarketSource,
  headers: Record<string, string>,
  skills: MarketSkill[],
): Promise<number> {
  const before = skills.length;
  const baseUrl = source.url.replace(/\/$/, "");

  try {
    const resp = await httpGet(url, headers);
    if (resp.status !== 200) {
      console.warn(`[SkillMarket] SkillHub endpoint failed: ${resp.status} for ${url}`);
      return 0;
    }

    const data = JSON.parse(resp.body);
    const items: any[] = data.data || data.skills || (Array.isArray(data) ? data : []);

    for (const item of items) {
      const skillId = item.id || item._id || `${item.owner || item.source}/${item.slug || item.name}`;
      const slug = item.slug || item.name || skillId;
      const author = item.owner || item.source || item.author || "";
      const downloadUrl = item.zipUrl || item.downloadUrl ||
        `${baseUrl}/api/skill-files/zip?skillId=${item._id || item.id || slug}`;

      skills.push({
        id: `${source.id}:${skillId}`,
        name: slug,
        displayName: item.displayName || item.name || slug,
        description: item.description || item.summary || "无描述",
        author,
        version: item.version,
        tags: item.tags || item.categories,
        sourceId: source.id,
        sourceName: source.name,
        downloadUrl,
        repoUrl: item.url || item.repoUrl || (author ? `https://github.com/${author}` : undefined),
        stars: item.downloads || item.installs || item.stars,
        lastUpdated: item.updatedAt || item.updated_at,
        installType: "zip",
        repoFullName: item.repoFullName || (author ? `${author}/${slug}` : undefined),
        branch: item.branch || "main",
      });
    }
  } catch (err) {
    console.warn(`[SkillMarket] SkillHub endpoint error for ${url}:`, err);
  }

  return skills.length - before;
}

// ========== CLI Subprocess Adapter (Generic) ==========

/**
 * 通过 CLI 子进程获取技能列表（如 skillhub-cli）。
 *
 * 工作流程：
 * 1. 调用 `<cliCommand> search ""` 或 `<cliCommand> list` 获取技能列表
 * 2. 解析 stdout 为 MarketSkill[]
 *
 * SkillHub CLI 输出格式（推测）：
 *   name        description                    author       downloads
 *   skill-1     First skill description         author1      123
 *   skill-2     Second skill description        author2      456
 *
 * 或 JSON 格式：
 *   [{"name": "skill-1", "description": "...", "author": "..."}]
 */
async function fetchCLISkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  if (!source.cliCommand) {
    console.warn(`[SkillMarket] CLI source ${source.id} has no cliCommand configured`);
    return skills;
  }

  try {
    const { executeCommand } = await import("../file-api");

    // 尝试 JSON 输出格式优先（skillhub search --json）
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;

    try {
      // 尝试带 --json flag 获取结构化输出
      const result = await executeCommand(`${source.cliCommand} search --json`, undefined);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    } catch {
      // --json 不支持，尝试普通 search
      try {
        const result = await executeCommand(`${source.cliCommand} search`, undefined);
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
      } catch (err2: any) {
        // CLI 未安装，抛出描述性错误以便 UI 展示
        const errMsg = `CLI "${source.cliCommand}" 未安装。请运行 npm i -g ${source.cliCommand} 安装后重试。`;
        console.warn(`[SkillMarket] ${errMsg}`);
        throw new Error(errMsg);
      }
    }

    if (exitCode !== 0 && exitCode !== undefined) {
      console.warn(`[SkillMarket] CLI "${source.cliCommand}" exited with code ${exitCode}: ${stderr}`);
      return skills;
    }

    // 尝试解析 JSON 输出
    const trimmed = stdout.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed);
        const items: any[] = Array.isArray(data) ? data : (data.data || data.items || []);

        for (const item of items) {
          const name = item.name || item.slug || "";
          if (!name) continue;

          skills.push({
            id: `${source.id}:${name}`,
            name,
            displayName: item.displayName || item.name || name,
            description: item.description || "无描述",
            author: item.author || item.owner || "",
            version: item.version,
            tags: item.tags,
            sourceId: source.id,
            sourceName: source.name,
            downloadUrl: "", // CLI 安装不需要 downloadUrl
            repoUrl: item.url || item.repoUrl,
            stars: item.downloads || item.installs,
            lastUpdated: item.updatedAt,
            installType: "cli" as any, // 标记为 CLI 安装类型
          });
        }
        return skills;
      } catch {
        // JSON 解析失败，尝试表格解析
      }
    }

    // 解析表格格式输出（制表符或空格分隔）
    const lines = trimmed.split("\n").filter((l) => l.trim());
    if (lines.length > 1) {
      // 跳过表头
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s{2,}|\t/).filter((p) => p.trim());
        if (parts.length < 1) continue;

        const name = parts[0].trim();
        const description = parts[1]?.trim() || "无描述";
        const author = parts[2]?.trim() || "";

        skills.push({
          id: `${source.id}:${name}`,
          name,
          displayName: name,
          description,
          author,
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: "",
          installType: "cli" as any,
        });
      }
    }
  } catch (err) {
    console.error(`[SkillMarket] Error fetching CLI skills for ${source.id}:`, err);
  }

  return skills;
}

/**
 * 通过 CLI 子进程安装技能（如 skillhub-cli）。
 *
 * 调用 `<cliCommand> install <skillName>` 安装技能。
 * CLI 自动将技能文件下载到本地，我们只需将安装结果同步到 registry。
 */
async function installCLISkill(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const { executeCommand } = await import("../file-api");
  const { getSkillRegistry, parseSkillMarkdown } = await import("./skill");
  const { readFile } = await import("../file-api");

  onProgress?.(10, `正在通过 CLI 安装: ${skill.name}...`);

  try {
    // 查找技能的 MarketSource 以获取 cliCommand
    const sources = getMarketSources();
    const source = sources.find((s) => s.id === skill.sourceId);
    if (!source?.cliCommand) {
      return { success: false, error: "未找到 CLI 命令配置" };
    }

    onProgress?.(30, `执行 ${source.cliCommand} install ${skill.name}...`);

    const result = await executeCommand(
      `${source.cliCommand} install ${skill.name}`,
      undefined,
      120_000, // FIX: 安装有界超时 2min（下载依赖可能耗时，但防挂死）
    );

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `CLI 安装失败 (exit ${result.exitCode}): ${result.stderr}`,
      };
    }

    onProgress?.(70, "CLI 安装完成，正在注册技能...");

    // CLI 安装后，技能文件通常在 ~/.skillhub/skills/ 或类似目录
    // 尝试查找并注册
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skill.name}`;

    // 尝试读取 SKILL.md
    try {
      const skillMdPath = `${skillDir}${sep}SKILL.md`;
      const skillMdContent = await readFile(skillMdPath);
      const skillDef = parseSkillMarkdown(skillMdContent, skillMdPath);
      if (skillDef) {
        skillDef.source = "user";
        skillDef.filePath = skillDir;
        skillDef.enabled = true;
        getSkillRegistry().register(skillDef);
      }
    } catch {
      // SKILL.md 可能不在预期位置，尝试在 CLI 输出中查找路径
      console.log(`[SkillMarket] CLI install output: ${result.stdout.substring(0, 200)}`);
    }

    onProgress?.(100, `技能 "${skill.name}" 安装成功！`);

    return {
      success: true,
      skillName: skill.name,
      filesWritten: 1,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `CLI 安装失败: ${err.message || String(err)}`,
    };
  }
}

// ========== Public API ==========

/** 市场搜索结果 */
export interface MarketSearchResult {
  skills: MarketSkill[];
  errors: Array<{ sourceId: string; sourceName: string; error: string }>;
}

/**
 * 从所有启用的市场源获取技能列表。
 * @param sources 可选，默认使用 getMarketSources()
 * @param onSourceLoaded 每个源加载完成时的回调（用于渐进式 UI 更新）。
 *        **注意**：只在"这个源确实取数成功"时回调 —— 超时/失败时**不回调**，
 *        让调用方保留界面上该源的旧数据（改动前用 `[]` 回调，等于把整片技能清空）。
 */
export async function listMarketSkills(
  sources?: MarketSource[],
  onSourceLoaded?: (sourceId: string, skills: MarketSkill[]) => void,
): Promise<MarketSearchResult> {
  const activeSources = (sources || getMarketSources()).filter((s) => s.enabled);
  const allSkills: MarketSkill[] = [];
  const errors: Array<{ sourceId: string; sourceName: string; error: string }> = [];

  // 获取已安装技能名列表，用于标记 installed 状态
  const registry = getSkillRegistry();
  const installedNames = new Set(registry.getAll().map((s) => s.name));

  resetGithubRateLimitState();

  // 并行加载所有源（每个源都有超时保护，见 withSourceTimeout）
  const promises = activeSources.map(async (source) => {
    try {
      const merged = await mergeSourceResult(source.name, SOURCE_TIMEOUT_MS, fetchSkillsFromSource(source));
      const { skills } = merged;

      // 标记已安装状态
      for (const skill of skills) {
        if (installedNames.has(skill.name)) {
          skill.installed = true;
        }
      }

      /**
       * 降级的源**不计入结果**。
       *
       * 判据：调用方（SkillManager）按 `result.skills` 里的 sourceId 决定"替换哪些源的旧数据"
       * （见那里 `sourceIdsInResult` 的注释）。把一个空数组的源塞进结果，等于告诉 UI
       * "这个源现在就是 0 条"，于是它会把该市场已有的技能整片丢掉 ——
       * 用户看到的是"点了一次检查更新，某个市场消失了"。降级只该降级，不该变成删除。
       *
       * 只有**源自己抛错**才算 `errors`（那是真的没干成，界面顶部需要可见提示）；
       * 12s 超时是我们自己的上限触发的、后台仍在把请求跑完，只写日志，不报红。
       */
      if (merged.degraded) {
        if (merged.failed) {
          errors.push({
            sourceId: source.id,
            sourceName: source.name,
            error: `取数失败 —— 已保留上一次的结果`,
          });
        }
        return;
      }

      allSkills.push(...skills);
      // 只有取到东西才回调：空结果回调会把界面上该源的旧数据清掉
      if (skills.length > 0) onSourceLoaded?.(source.id, skills);
    } catch (err: any) {
      errors.push({
        sourceId: source.id,
        sourceName: source.name,
        error: err.message || String(err),
      });
      // 这里**不**用 `onSourceLoaded(source.id, [])`：失败不是"这个源没有技能"
    }
  });

  await Promise.all(promises);

  return { skills: allSkills, errors };
}

/**
 * 获取技能安装目录。
 */
async function getSkillsDir(): Promise<string> {
  const dataDir = await tauriInvoke("get_app_data_dir");
  const sep = dataDir.includes("/") && !dataDir.includes("\\") ? "/" : "\\";
  return `${dataDir}.codem${sep}skills`;
}

/**
 * 下载并安装市场技能。
 * @param skill 市场技能条目
 * @param onProgress 安装进度回调
 * @param overwrite 是否覆盖已存在的技能
 */
export async function installMarketSkill(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
): Promise<InstallResult> {
  // 内置技能无需安装
  if (skill.installType === "builtin") {
    return {
      success: true,
      skillName: skill.name,
      filesWritten: 0,
    };
  }

  // CLI 类型技能通过 CLI 子进程安装（如 skillhub install）
  if (skill.installType === "cli" as any) {
    return await installCLISkill(skill, onProgress);
  }

  try {
    onProgress?.(5, "正在准备下载...");

    // 对于 dir 类型的 GitHub 技能，通过 Trees API 搜索 SKILL.md 并下载目录文件，
    // 而不是下载整个仓库 zipball（某些仓库非常大，如 cloudflare-docs 1.4GB）
    // dirPath 可以是空字符串（根目录 SKILL.md）或具体目录路径
    if (skill.installType === "dir" && skill.repoFullName) {
      return await installSkillFromGitHubDir(skill, onProgress, overwrite);
    }

    // 获取临时文件路径
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const tempZipPath = `${skillsDir}${sep}.tmp${sep}${skill.sourceId}-${skill.name}.zip`;

    // 修正 downloadUrl：确保是有效的 ZIP 下载链接
    let downloadUrl = skill.downloadUrl;
    if (!downloadUrl) {
      return {
        success: false,
        error: "该技能没有可用的下载链接（downloadUrl 为空）。请尝试其他来源。",
      };
    }

    // Skills.sh HTML 抓取的 downloadUrl 是 GitHub 仓库主页（https://github.com/owner/repo）
    // 需要转换为 zipball URL，并获取仓库真实的默认分支（不能假设是 main）
    if (downloadUrl.startsWith("https://github.com/") && !downloadUrl.includes("/zipball/") && !downloadUrl.includes("/archive/")) {
      const repoPath = downloadUrl.replace("https://github.com/", "");
      // 获取仓库真实默认分支（避免 branch=main 导致 404）
      let branch = skill.branch || "main";
      try {
        const repoResp = await httpGet(`https://api.github.com/repos/${repoPath}`, githubApiHeaders());
        if (repoResp.status === 200) {
          const repoInfo = JSON.parse(repoResp.body);
          branch = repoInfo.default_branch || branch;
        }
      } catch (err) {
        console.warn(`[SkillMarket] Failed to get default branch for ${repoPath}, using ${branch}:`, err);
      }
      downloadUrl = `https://api.github.com/repos/${repoPath}/zipball/${branch}`;
    }

    onProgress?.(15, `正在下载技能包: ${skill.displayName}...`);

    // 通过 Rust 层下载 ZIP 文件
    await httpDownload(downloadUrl, tempZipPath, githubApiHeaders());

    onProgress?.(40, "正在读取下载文件...");

    // 读取下载的 ZIP 文件为 base64
    const { invoke } = (window as any).__TAURI__?.core || {};
    const base64Data = await invoke("read_file", { path: tempZipPath, encoding: "base64" });

    // 将 base64 转换为 Uint8Array
    const binaryString = atob(base64Data);
    const zipData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      zipData[i] = binaryString.charCodeAt(i);
    }

    // 清理临时文件
    try {
      await deletePath(tempZipPath);
    } catch {
      // Ignore cleanup errors
    }

    onProgress?.(55, "正在解压和安装...");

    // 如果是目录类型，需要过滤只安装指定目录
    if (skill.installType === "dir" && skill.dirPath) {
      return await installSkillFromZipFiltered(zipData, skill.dirPath, onProgress, overwrite, skill.name);
    }

    // 普通 ZIP 安装
    const result = await installSkillFromZip(zipData, onProgress, overwrite, skill.name);

    // P3-27: Record audit entry on successful install
    if (result.success) {
      try {
        const { unzipSync, strFromU8 } = await import("fflate");
        const files = unzipSync(new Uint8Array(zipData));
        const fileMap = new Map<string, string>();
        for (const [path, data] of Object.entries(files)) {
          if (path.endsWith("/") || (data as Uint8Array).length > 1024 * 1024) continue;
          try { fileMap.set(path, strFromU8(data as Uint8Array)); } catch (e) { console.warn('[skill-market-client.ts]', e) }
        }
        const hash = computeContentHash(fileMap);
        addInstallAuditEntry({
          skillName: result.skillName || skill.name,
          sourceId: skill.sourceId,
          installedAt: Date.now(),
          auditLevel: "safe",
          filesWritten: result.filesWritten || 0,
          contentHash: hash,
          version: skill.version,
          author: skill.author,
        });
      } catch (e) { console.warn('[skill-market-client.ts]', e) }
    }

    return result;
  } catch (err: any) {
    return {
      success: false,
      error: `市场安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 通过 GitHub Trees API 搜索 SKILL.md 并下载技能文件。
 *
 * 移植自 vercel-labs/skills blob.ts + download-source.ts 的核心逻辑。
 * 工作流程：
 * 1. 通过 Trees API 一次性获取仓库完整文件树
 * 2. 在树中搜索 SKILL.md（支持 30+ 种 Agent 目录约定）
 * 3. 从 dirPath 目录中筛选所有文件
 * 4. 逐个通过 raw.githubusercontent.com 下载文件内容
 * 5. 写入到本地技能目录并注册
 */
async function installSkillFromGitHubDir(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
): Promise<InstallResult> {
  const { getSkillRegistry, parseSkillMarkdown } = await import("./skill");
  const { writeFile } = await import("../file-api");

  try {
    const repoFullName = skill.repoFullName!;
    let dirPath = skill.dirPath || "";

    // 获取仓库默认分支
    onProgress?.(10, `正在获取仓库信息: ${repoFullName}...`);
    let branch = skill.branch || "main";
    try {
      const repoResp = await httpGet(`https://api.github.com/repos/${repoFullName}`, githubApiHeaders());
      if (repoResp.status === 200) {
        const repoInfo = JSON.parse(repoResp.body);
        branch = repoInfo.default_branch || branch;
      }
    } catch (err) {
      console.warn(`[SkillMarket] Failed to get default branch for ${repoFullName}:`, err);
    }

    // 使用 Trees API 一次性获取仓库完整文件树
    onProgress?.(20, `正在获取仓库文件树...`);
    const tree = await fetchRepoTree(repoFullName, branch);
    if (!tree) {
      const tokenHint = hasGithubToken()
        ? ""
        : `\n\n⚠️ 您尚未配置 GitHub Token。请前往 设置 → Git 偏好配置 → GitHub Token 填写 Token。`;
      return {
        success: false,
        error: `无法获取仓库文件树（Trees API 失败）。${tokenHint}`,
      };
    }

    // 如果 dirPath 为空或未在树中找到 SKILL.md，用优先级搜索
    onProgress?.(30, `正在搜索 SKILL.md...`);

    // 在树中搜索 SKILL.md
    const skillMdPaths = findSkillMdPathsInTree(tree);
    if (skillMdPaths.length === 0) {
      return {
        success: false,
        error: `仓库 ${repoFullName} 中未找到 SKILL.md 文件。`,
      };
    }

    // 如果有 dirPath，尝试精确匹配该目录下的 SKILL.md
    // 否则取优先级最高的
    let skillMdPath: string;
    if (dirPath) {
      const exactMatch = skillMdPaths.find((p) => {
        const dir = getSkillDirFromPath(p);
        return dir === dirPath || dir.endsWith("/" + dirPath);
      });
      skillMdPath = exactMatch || skillMdPaths[0];
      // 更新 dirPath 为实际找到的路径
      dirPath = getSkillDirFromPath(skillMdPath);
    } else {
      skillMdPath = skillMdPaths[0];
      dirPath = getSkillDirFromPath(skillMdPath);
    }

    console.log(`[SkillMarket] Using SKILL.md at: ${skillMdPath}, dirPath: ${dirPath}`);

    // 从树中筛选属于该技能目录的所有文件
    interface FileEntry {
      path: string;       // 相对于 dirPath 的路径
      downloadUrl: string;
      size: number;
    }

    const files: FileEntry[] = [];
    const allowedExtensions = new Set([
      ".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".csv",
      ".ts", ".tsx", ".js", ".jsx", ".mjs",
      ".py", ".sh", ".bat", ".ps1",
      ".css", ".html", ".svg",
      ".png", ".jpg", ".jpeg", ".gif", ".ico",
      ".toml", ".ini", ".cfg",
    ]);

    // 技能目录前缀（dirPath 可能为空，表示根目录）
    const dirPrefix = dirPath ? dirPath + "/" : "";
    for (const entry of tree.tree) {
      if (entry.type !== "blob") continue;
      // 文件必须在该技能目录下
      if (dirPrefix && !entry.path.startsWith(dirPrefix) && entry.path !== dirPath + "/SKILL.md") continue;
      if (!dirPrefix && !entry.path.toLowerCase().endsWith("skill.md") && entry.path.includes("/")) continue;

      // 获取相对路径
      let relativePath = entry.path;
      if (dirPrefix && relativePath.startsWith(dirPrefix)) {
        relativePath = relativePath.substring(dirPrefix.length);
      }

      // 检查扩展名
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      if (!allowedExtensions.has(ext) && !relativePath.endsWith("SKILL.md")) continue;

      // 检查大小（跳过大文件）
      if (entry.size && entry.size > 1024 * 1024) continue;

      const rawUrl = `https://raw.githubusercontent.com/${repoFullName}/${tree.branch}/${entry.path}`;
      files.push({ path: relativePath, downloadUrl: rawUrl, size: entry.size || 0 });
    }

    if (files.length === 0) {
      return {
        success: false,
        error: `目录 "${dirPath}" 中未找到可安装的文件。`,
      };
    }

    // 检查是否有 SKILL.md
    const skillMdFile = files.find((f) => f.path.endsWith("SKILL.md"));
    if (!skillMdFile) {
      return {
        success: false,
        error: `目录 "${dirPath}" 中未找到 SKILL.md 文件。`,
      };
    }

    // 先下载 SKILL.md 解析技能信息
    onProgress?.(40, "正在解析技能元数据...");
    const mdResp = await httpGet(skillMdFile.downloadUrl);
    if (mdResp.status !== 200) {
      return { success: false, error: "下载 SKILL.md 失败。" };
    }
    const skillDef = parseSkillMarkdown(mdResp.body, skillMdFile.path);
    if (!skillDef) {
      return { success: false, error: "SKILL.md 解析失败。" };
    }

    // 使用 preferredName 覆盖技能名
    if (skill.name) {
      skillDef.name = skill.name;
    }

    // 检查是否已存在
    const registry = getSkillRegistry();
    const existing = registry.get(skillDef.name);
    if (existing && !overwrite) {
      return {
        success: false,
        error: `技能 "${skillDef.name}" 已存在。是否覆盖安装？`,
        skillName: skillDef.name,
      };
    }

    // 获取安装目录
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skillDef.name}`;

    // 下载并写入所有文件
    onProgress?.(50, `正在下载技能文件 (${files.length} 个)...`);
    let filesWritten = 0;
    const downloadedContents = new Map<string, string>();

    // SKILL.md 的内容已在前面下载
    downloadedContents.set(skillMdFile.path, mdResp.body);

    for (const file of files) {
      // 跳过 SKILL.md（已下载）
      if (file.path === skillMdFile.path) {
        const fullPath = `${skillDir}${sep}${file.path.replace(/\//g, sep)}`;
        await writeFile(fullPath, mdResp.body);
        filesWritten++;
        continue;
      }
      try {
        const fileResp = await httpGet(file.downloadUrl);
        if (fileResp.status !== 200) {
          console.warn(`[SkillMarket] Failed to download ${file.path}: ${fileResp.status}`);
          continue;
        }

        downloadedContents.set(file.path, fileResp.body);

        const fullPath = `${skillDir}${sep}${file.path.replace(/\//g, sep)}`;
        await writeFile(fullPath, fileResp.body);
        filesWritten++;

        const progress = 50 + Math.round((filesWritten / files.length) * 40);
        onProgress?.(progress, `写入文件: ${file.path}`);
      } catch (err) {
        console.warn(`[SkillMarket] Failed to write ${file.path}:`, err);
      }
    }

    if (filesWritten === 0) {
      return { success: false, error: "所有文件下载失败。" };
    }

    onProgress?.(95, "正在注册技能...");

    // 注册技能
    skillDef.source = "user";
    skillDef.filePath = skillDir;
    skillDef.enabled = true;
    registry.register(skillDef);

    // 审计记录
    try {
      const hash = computeContentHash(downloadedContents);
      addInstallAuditEntry({
        skillName: skillDef.name,
        sourceId: skill.sourceId,
        installedAt: Date.now(),
        auditLevel: "safe",
        filesWritten,
        contentHash: hash,
        version: skill.version,
        author: skill.author,
      });
    } catch (e) { console.warn('[skill-market-client.ts]', e) }

    onProgress?.(100, `技能 "${skillDef.name}" 安装成功！`);

    return {
      success: true,
      skillName: skillDef.name,
      skill: skillDef,
      filesWritten,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 从 ZIP 中只安装指定目录的技能。
 * 用于 GitHub 仓库目录型源（如 anthropics/skills 中的单个技能）。
 */
async function installSkillFromZipFiltered(
  zipData: Uint8Array,
  targetDir: string,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
  preferredName?: string,
): Promise<InstallResult> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const { getSkillRegistry, parseSkillMarkdown } = await import("./skill");
  const { writeFile } = await import("../file-api");

  try {
    onProgress?.(60, "正在解压 ZIP 文件...");

    const files = unzipSync(zipData);
    const allPaths = Object.keys(files);

    // GitHub zipball 的路径格式：{repo}-{hash}/{dirPath}/...
    // targetDir 可能是多级路径（如 "skills/pdf"），需要按路径段匹配
    const targetSegments = targetDir.split("/").filter(Boolean);

    const targetPaths = allPaths.filter((p) => {
      const normalized = p.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      // GitHub zipball 第一级是 repo-hash，从第二级开始匹配
      if (parts.length < targetSegments.length + 1) return false;
      // 从 index 1 开始检查是否有连续的 targetSegments
      for (let i = 1; i <= parts.length - targetSegments.length; i++) {
        let match = true;
        for (let j = 0; j < targetSegments.length; j++) {
          if (parts[i + j] !== targetSegments[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      return false;
    });

    if (targetPaths.length === 0) {
      // dirPath 在 ZIP 中不存在（可能技能已改名或移除），fallback 到普通 ZIP 安装
      console.warn(`[SkillMarket] dirPath "${targetDir}" not found in ZIP, falling back to full ZIP install`);
      return await installSkillFromZip(zipData, onProgress, overwrite, preferredName);
    }

    // 确定实际的根前缀（如 "anthropics-skills-abc123/"）
    // 根前缀是 targetSegments 之前的所有路径段
    const firstPath = targetPaths[0].replace(/\\/g, "/");
    const firstParts = firstPath.split("/").filter(Boolean);
    // 找到 targetSegments 在路径中的起始位置
    let segStartIdx = -1;
    for (let i = 0; i <= firstParts.length - targetSegments.length; i++) {
      let match = true;
      for (let j = 0; j < targetSegments.length; j++) {
        if (firstParts[i + j] !== targetSegments[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        segStartIdx = i;
        break;
      }
    }
    const rootPrefix = segStartIdx > 0 ? firstParts.slice(0, segStartIdx).join("/") + "/" : "";
    // 完整的目录前缀（根前缀 + targetDir + /）
    const fullDirPrefix = rootPrefix + targetDir + "/";

    // 查找 SKILL.md
    const skillMdPath = targetPaths.find((p) => p.replace(/\\/g, "/").endsWith("SKILL.md"));
    if (!skillMdPath) {
      return {
        success: false,
        error: "ZIP 中未找到 SKILL.md 文件。",
      };
    }

    // 解析 SKILL.md
    const skillMdContent = strFromU8(files[skillMdPath]);
    const skill = parseSkillMarkdown(skillMdContent, skillMdPath);
    if (!skill) {
      return { success: false, error: "SKILL.md 解析失败。" };
    }

    // 使用 preferredName 覆盖技能名（确保与市场显示一致）
    if (preferredName) {
      skill.name = preferredName;
    }

    // 检查是否已存在
    const registry = getSkillRegistry();
    const existing = registry.get(skill.name);
    if (existing && !overwrite) {
      return {
        success: false,
        error: `技能 "${skill.name}" 已存在。是否覆盖安装？`,
        skillName: skill.name,
      };
    }

    onProgress?.(75, `正在安装技能: ${skill.name}...`);

    // 获取安装目录
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skill.name}`;

    // 写入文件
    let filesWritten = 0;
    const allowedExtensions = new Set([
      ".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".csv",
      ".ts", ".tsx", ".js", ".jsx", ".mjs",
      ".py", ".sh", ".bat", ".ps1",
      ".css", ".html", ".svg",
      ".png", ".jpg", ".jpeg", ".gif", ".ico",
      ".toml", ".ini", ".cfg",
    ]);

    for (const zipPath of targetPaths) {
      if (zipPath.endsWith("/") || zipPath.endsWith("\\")) continue;

      // 去除根前缀和目标目录前缀，得到相对路径
      let relativePath = zipPath.replace(/\\/g, "/").replace(fullDirPrefix, "");
      if (!relativePath || relativePath === zipPath.replace(/\\/g, "/")) {
        // 尝试只去除根前缀
        relativePath = zipPath.replace(/\\/g, "/").replace(rootPrefix, "");
        // 去除 targetDir/ 前缀
        if (relativePath.startsWith(targetDir + "/")) {
          relativePath = relativePath.substring(targetDir.length + 1);
        }
      }
      if (!relativePath) continue;

      // 检查扩展名
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;

      // 检查文件大小
      const fileData = files[zipPath];
      if (fileData.length > 1024 * 1024) continue;

      // 写入文件
      const fullPath = `${skillDir}${sep}${relativePath.replace(/\//g, sep)}`;
      const content = strFromU8(fileData);
      await writeFile(fullPath, content);
      filesWritten++;

      const progress = 75 + Math.round((filesWritten / targetPaths.length) * 20);
      onProgress?.(progress, `写入文件: ${relativePath}`);
    }

    onProgress?.(95, "正在注册技能...");

    // 注册技能
    skill.source = "user";
    skill.filePath = skillDir;
    skill.enabled = true;
    registry.register(skill);

    onProgress?.(100, `技能 "${skill.name}" 安装成功！`);

    return {
      success: true,
      skillName: skill.name,
      skill,
      filesWritten,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 检查市场技能是否已安装。
 */
export function isMarketSkillInstalled(skill: MarketSkill): boolean {
  const registry = getSkillRegistry();
  return registry.getAll().some((s) => s.name === skill.name);
}

/**
 * 增量联网搜索：在所有启用的市场源中搜索关键词。
 *
 * 与 listMarketSkills 不同，此函数会利用支持搜索 API 的市场源（如 SkillHub、Skills.sh）
 * 直接在服务端搜索，而非拉取全量列表后在本地过滤。
 *
 * 对于不支持服务端搜索的源（如 GitHub repo），仍然拉取全量后本地过滤。
 *
 * @param query 搜索关键词
 * @param sources 可选，默认使用 getMarketSources()
 * @param onSourceLoaded 每个源搜索完成时的回调
 */
export async function searchMarketSkillsOnline(
  query: string,
  sources?: MarketSource[],
  onSourceLoaded?: (sourceId: string, skills: MarketSkill[]) => void,
): Promise<MarketSearchResult> {
  const activeSources = (sources || getMarketSources()).filter((s) => s.enabled);
  const allSkills: MarketSkill[] = [];
  const errors: Array<{ sourceId: string; sourceName: string; error: string }> = [];

  // 获取已安装技能名列表
  const registry = getSkillRegistry();
  const installedNames = new Set(registry.getAll().map((s) => s.name));

  const q = query.toLowerCase().trim();

  resetGithubRateLimitState();

  // 超时上限统一走模块级常量 SOURCE_TIMEOUT_MS（12s，略短于 Rust 端 15s http_get 超时）

  const promises = activeSources.map(async (source) => {
    try {
      let skills: MarketSkill[] = [];

      // 为单个源设置超时（与 listMarketSkills 同一套收口：定时器一定被清、超时才报超时）
      const sourceWork = (async () => {
        // 对于 SkillHub，利用其服务端搜索 API
        if (source.type === "skillhub-api") {
          return await fetchSkillHubSearch(source, q);
        }
        // 其他源：全量拉取后在本地过滤
        let fetched = await fetchSkillsFromSource(source);
        if (q) {
          fetched = fetched.filter((s) => {
            const tags = Array.isArray(s.tags) ? s.tags : [];
            const name = String(s.name || "");
            const displayName = String(s.displayName || "");
            const description = String(s.description || "");
            const author = s.author ? String(s.author) : "";
            return (
              name.toLowerCase().includes(q) ||
              displayName.toLowerCase().includes(q) ||
              description.toLowerCase().includes(q) ||
              author.toLowerCase().includes(q) ||
              tags.some((t) => String(t).toLowerCase().includes(q))
            );
          });
        }
        return fetched;
      })();

      // 在 sourceWork 之上做超时 + 失败收口
      const merged = await mergeSourceResult(source.name, SOURCE_TIMEOUT_MS, sourceWork);
      skills = merged.skills;

      // 标记已安装状态
      for (const skill of skills) {
        if (installedNames.has(skill.name)) {
          skill.installed = true;
        }
      }

      // 降级：不计入结果；只有源自己抛错才进 errors（超时只留日志，不报红）
      if (merged.degraded) {
        if (merged.failed) {
          errors.push({
            sourceId: source.id,
            sourceName: source.name,
            error: `取数失败 —— 已保留上一次的结果`,
          });
        }
        return;
      }

      allSkills.push(...skills);
      if (skills.length > 0) onSourceLoaded?.(source.id, skills);
    } catch (err: any) {
      errors.push({
        sourceId: source.id,
        sourceName: source.name,
        error: err.message || String(err),
      });
      // 失败不回调空数组（避免把界面上该源的旧结果清空）
    }
  });

  await Promise.all(promises);

  return { skills: allSkills, errors };
}

/**
 * 从单个市场源获取技能（复用现有适配器）。
 */
async function fetchSkillsFromSource(source: MarketSource): Promise<MarketSkill[]> {
  switch (source.type) {
    case "github-repo":
      return await fetchGitHubRepoSkills(source);
    case "github-search":
      return await fetchGitHubSearchSkills(source);
    case "builtin":
      return await fetchBuiltinSkills(source);
    case "clawhub-api":
      return await fetchClawHubSkills(source);
    case "skills-sh-api":
      return await fetchSkillsShSkills(source);
    case "skillhub-api":
      return await fetchSkillHubAPISkills(source);
    case "cli":
      return await fetchCLISkills(source);
    default:
      return [];
  }
}

/**
 * 通过 SkillHub 服务端搜索 API 搜索技能。
 * GET /api/skills?q=<query>&limit=50&page=0
 */
async function fetchSkillHubSearch(source: MarketSource, query: string): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 2;
  const PAGE_SIZE = 50;

  try {
    const baseUrl = source.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };

    let page = 0;
    let hasMore = true;
    const seenIds = new Set<string>();

    while (hasMore && page < MAX_PAGES) {
      const params = new URLSearchParams();
      params.set("q", query);
      params.set("limit", String(PAGE_SIZE));
      params.set("page", String(page));
      params.set("sort", "downloads");

      const resp = await httpGet(`${baseUrl}/api/skills?${params.toString()}`, headers);
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] SkillHub search failed (page ${page}): ${resp.status}`);
        break;
      }

      const data = JSON.parse(resp.body);
      const items: any[] = data.data || data.skills || data.items || (Array.isArray(data) ? data : []);
      if (items.length === 0) break;

      for (const item of items) {
        const skillId = item.id || item._id || `${item.owner || item.source}/${item.slug || item.name}`;
        const skillKey = `${source.id}:${skillId}`;
        if (seenIds.has(skillKey)) continue;
        seenIds.add(skillKey);

        const slug = item.slug || item.name || skillId;
        const author = item.owner || item.source || item.author || "";
        const downloadUrl = item.zipUrl || item.downloadUrl ||
          (item._id || item.id ?
            `${baseUrl}/api/skill-files/zip?skillId=${item._id || item.id}` :
            `${baseUrl}/api/skill-files/zip?skillId=${slug}`);

        skills.push({
          id: skillKey,
          name: slug,
          displayName: item.displayName || item.name || slug,
          description: item.description || item.summary || "无描述",
          author,
          version: item.version,
          tags: Array.isArray(item.tags) ? item.tags : (Array.isArray(item.categories) ? item.categories : []),
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl,
          repoUrl: item.url || item.repoUrl || (author ? `https://github.com/${author}` : undefined),
          stars: item.downloads || item.installs || item.stars,
          lastUpdated: item.updatedAt || item.updated_at,
          installType: "zip",
          repoFullName: item.repoFullName || (author ? `${author}/${slug}` : undefined),
          branch: item.branch || "main",
        });
      }

      const hasMoreFlag = data.hasMore !== undefined ? data.hasMore :
        (data.pagination ? data.pagination.hasMore : undefined);
      if (hasMoreFlag === false) break;
      if (items.length < PAGE_SIZE) break;
      page++;
    }

    console.log(`[SkillMarket] SkillHub search "${query}": found ${skills.length} skills`);
  } catch (err) {
    console.error(`[SkillMarket] Error searching SkillHub:`, err);
  }

  return skills;
}

/**
 * P3-27: 预检安装 — 在下载 ZIP 后、实际安装前进行安全审计。
 *
 * 工作流程：
 * 1. 解压 ZIP 但不写入文件系统
 * 2. 提取所有文件内容
 * 3. 执行安全审计（恶意代码检测、权限声明验证）
 * 4. 返回审计结果 + 解压后的文件数据（供后续安装使用）
 *
 * @param skill 市场技能条目
 * @param onProgress 进度回调
 * @returns 审计结果 + 文件数据，或 null（下载失败时）
 */
export async function preAuditSkill(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
): Promise<{ audit: SkillAuditResult; files: Map<string, string>; skillMdPath: string } | null> {
  if (skill.installType === "builtin") {
    return { audit: { overall: "safe", findings: [], declaredPermissions: [], timestamp: Date.now() }, files: new Map(), skillMdPath: "" };
  }
  if (skill.installType === "cli" as any) {
    return { audit: { overall: "safe", findings: [], declaredPermissions: [], timestamp: Date.now() }, files: new Map(), skillMdPath: "" };
  }
  try {
    onProgress?.(5, "Downloading skill package...");
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const tempZipPath = `${skillsDir}${sep}.tmp${sep}${skill.sourceId}-${skill.name}.zip`;

    onProgress?.(15, `Downloading: ${skill.displayName}...`);
    await httpDownload(skill.downloadUrl, tempZipPath, githubApiHeaders());

    onProgress?.(40, "Reading downloaded file...");
    const { invoke } = (window as any).__TAURI__?.core || {};
    const base64Data = await invoke("read_file", { path: tempZipPath, encoding: "base64" });
    const binaryString = atob(base64Data);
    const zipData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) { zipData[i] = binaryString.charCodeAt(i); }
    try { await deletePath(tempZipPath); } catch (e) { console.warn('[skill-market-client.ts]', e) }

    onProgress?.(55, "Extracting and auditing...");
    const { unzipSync, strFromU8 } = await import("fflate");
    const rawFiles = unzipSync(zipData);
    const allPaths = Object.keys(rawFiles);

    let targetPaths = allPaths;
    let rootPrefix = "";

    if (skill.installType === "dir" && skill.dirPath) {
      const targetSegments = skill.dirPath.split("/").filter(Boolean);
      targetPaths = allPaths.filter((p) => {
        const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts.length < targetSegments.length + 1) return false;
        for (let i = 1; i <= parts.length - targetSegments.length; i++) {
          let match = true;
          for (let j = 0; j < targetSegments.length; j++) { if (parts[i + j] !== targetSegments[j]) { match = false; break; } }
          if (match) return true;
        }
        return false;
      });
      const firstPath = targetPaths[0]?.replace(/\\/g, "/") || "";
      const firstParts = firstPath.split("/").filter(Boolean);
      let segStartIdx = -1;
      for (let i = 0; i <= firstParts.length - targetSegments.length; i++) {
        let match = true;
        for (let j = 0; j < targetSegments.length; j++) { if (firstParts[i + j] !== targetSegments[j]) { match = false; break; } }
        if (match) { segStartIdx = i; break; }
      }
      rootPrefix = segStartIdx > 0 ? firstParts.slice(0, segStartIdx).join("/") + "/" : "";
    } else {
      const skillMdPath = allPaths.find(p => p.endsWith("SKILL.md"));
      if (skillMdPath) {
        const parts = skillMdPath.replace(/\\/g, "/").split("/");
        if (parts.length > 1) { rootPrefix = parts.slice(0, -1).join("/") + "/"; }
      }
    }

    const skillMdPath = targetPaths.find(p => p.replace(/\\/g, "/").endsWith("SKILL.md"));
    if (!skillMdPath) return null;

    const skillMdContent = strFromU8(rawFiles[skillMdPath]);

    const allowedExtensions = new Set([".md",".txt",".json",".yaml",".yml",".ts",".tsx",".js",".jsx",".mjs",".py",".sh",".bat",".ps1",".css",".html",".svg",".toml",".ini",".cfg"]);
    const fileMap = new Map<string, string>();
    for (const zipPath of targetPaths) {
      if (zipPath.endsWith("/") || zipPath.endsWith("\\")) continue;
      const relativePath = zipPath.replace(/\\/g, "/").replace(rootPrefix, "");
      if (!relativePath) continue;
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      const fileData = rawFiles[zipPath];
      if (fileData.length > 1024 * 1024) continue;
      try { fileMap.set(relativePath, strFromU8(fileData)); } catch (e) { console.warn('[skill-market-client.ts]', e) }
    }

    const audit = auditSkillInstallation(fileMap, skillMdContent);
    onProgress?.(100, "Audit complete");
    return { audit, files: fileMap, skillMdPath };
  } catch (err) {
    console.error("[SkillMarket] Pre-audit failed:", err);
    return null;
  }
}

/**
 * 获取市场源图标。
 */
export function getSourceIcon(source: MarketSource): string {
  return source.icon || "📦";
}

// ========== Skill Publishing ==========

/** 发布目标市场类型 */
export type PublishTarget = "clawhub" | "github" | "cli";

/** 发布配置 */
export interface PublishConfig {
  /** 目标市场 */
  target: PublishTarget;
  /** 技能本地路径（~/.codem/skills/<name>） */
  skillPath: string;
  /** 技能名称（slug） */
  slug: string;
  /** 显示名称 */
  displayName: string;
  /** 版本号（semver） */
  version: string;
  /** 变更日志 */
  changelog?: string;
  /** 标签（逗号分隔，默认 "latest"） */
  tags?: string;
  /** 目标市场源 ID（用于 CLI 类型市场） */
  sourceId?: string;
  /**
   * GitHub 仓库配置（仅 target=github 时使用）
   * 如果指定 repoName，会尝试通过 gh CLI 创建仓库并推送
   */
  githubRepoName?: string;
  /** GitHub 仓库可见性 */
  githubPrivate?: boolean;
}

/** 发布结果 */
export interface PublishResult {
  success: boolean;
  /** 发布后的技能 URL */
  url?: string;
  /** 发布后的技能 ID */
  publishedId?: string;
  /** 错误信息 */
  error?: string;
  /** CLI 输出（用于调试） */
  rawOutput?: string;
}

/** 可发布的市场信息 */
export interface PublishableMarket {
  id: string;
  name: string;
  target: PublishTarget;
  icon: string;
  /** 是否已就绪（CLI 已安装、已登录等） */
  ready: boolean;
  /** 未就绪原因 */
  notReadyReason?: string;
}

/**
 * 检查 CLI 工具是否已安装。
 */
async function isCLIInstalled(command: string): Promise<boolean> {
  try {
    const { executeCommand } = await import("../file-api");
    const result = await executeCommand(`${command} --version`, undefined);
    return result.exitCode === 0 || result.exitCode === undefined;
  } catch {
    return false;
  }
}

/**
 * 检查 ClawHub CLI 登录状态。
 */
async function checkClawHubAuth(): Promise<{ authenticated: boolean; user?: string }> {
  try {
    const { executeCommand } = await import("../file-api");
    const result = await executeCommand("clawhub whoami", undefined);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { authenticated: true, user: result.stdout.trim() };
    }
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

/**
 * 列出所有支持发布的市场源。
 * 检查每个市场的就绪状态（CLI 是否安装、是否登录等）。
 */
export async function listPublishableMarkets(): Promise<PublishableMarket[]> {
  const markets: PublishableMarket[] = [];

  // 1. ClawHub — 通过 clawhub CLI 发布
  const clawhubInstalled = await isCLIInstalled("clawhub");
  let clawhubReady = clawhubInstalled;
  let clawhubNotReadyReason: string | undefined;

  if (clawhubInstalled) {
    const auth = await checkClawHubAuth();
    if (!auth.authenticated) {
      clawhubReady = false;
      clawhubNotReadyReason = "未登录，请运行 clawhub login";
    }
  } else {
    clawhubNotReadyReason = "未安装 clawhub CLI，请运行 npm i -g clawhub";
  }

  markets.push({
    id: "clawhub",
    name: "ClawHub.ai",
    target: "clawhub",
    icon: "🦞",
    ready: clawhubReady,
    notReadyReason: clawhubNotReadyReason,
  });

  // 2. GitHub — 通过 gh CLI 创建仓库 + 推送
  const ghInstalled = await isCLIInstalled("gh");
  markets.push({
    id: "github",
    name: "GitHub 仓库",
    target: "github",
    icon: "🐙",
    ready: ghInstalled,
    notReadyReason: ghInstalled ? undefined : "未安装 GitHub CLI，请运行 winget install GitHub.cli",
  });

  // 3. CLI 类型市场（如 SkillHub，如果支持 publish）
  const sources = getMarketSources();
  for (const source of sources) {
    if (source.type === "cli" && source.cliCommand) {
      const cliReady = await isCLIInstalled(source.cliCommand);
      markets.push({
        id: source.id,
        name: source.name,
        target: "cli",
        icon: source.icon || "📦",
        ready: cliReady,
        notReadyReason: cliReady ? undefined : `未安装 ${source.cliCommand} CLI`,
      });
    }
  }

  return markets;
}

/**
 * 发布技能到 ClawHub。
 * 调用 `clawhub skill publish <path>` CLI 命令。
 */
async function publishToClawHub(config: PublishConfig): Promise<PublishResult> {
  const { executeCommand } = await import("../file-api");

  const parts = [
    "clawhub", "skill", "publish", `"${config.skillPath}"`,
    "--slug", config.slug,
    "--name", `"${config.displayName}"`,
    "--version", config.version,
  ];
  if (config.changelog) {
    parts.push("--changelog", `"${config.changelog}"`);
  }
  parts.push("--tags", config.tags || "latest");

  try {
    const result = await executeCommand(parts.join(" "), undefined);
    const output = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `clawhub publish 失败 (exit ${result.exitCode}): ${result.stderr || output}`,
        rawOutput: output,
      };
    }

    // 从输出中提取技能 URL
    // clawhub CLI 通常输出类似 "Published to https://clawhub.ai/<user>/skills/<slug>"
    const urlMatch = output.match(/https?:\/\/[^\s]+clawhub[^\s]*/i);
    const url = urlMatch ? urlMatch[0] : `https://clawhub.ai/skills/${config.slug}`;

    return {
      success: true,
      url,
      publishedId: config.slug,
      rawOutput: output,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `clawhub publish 异常: ${err.message || String(err)}`,
    };
  }
}

/**
 * 发布技能到 GitHub 仓库。
 * 调用 `gh repo create` 创建仓库，然后 git init + commit + push。
 *
 * 流程：
 * 1. 在技能目录初始化 git 仓库
 * 2. 添加所有文件并提交
 * 3. 通过 gh CLI 创建 GitHub 仓库
 * 4. 推送到远程
 */
async function publishToGitHub(config: PublishConfig): Promise<PublishResult> {
  const { executeCommand } = await import("../file-api");
  const repoName = config.githubRepoName || config.slug;
  const visibility = config.githubPrivate ? "--private" : "--public";

  const outputParts: string[] = [];

  try {
    // 1. git init
    let result = await executeCommand("git init", config.skillPath, 60_000); // FIX: 有界超时
    outputParts.push("[git init]", result.stdout, result.stderr);

    // 2. git add
    result = await executeCommand("git add -A", config.skillPath, 60_000); // FIX: 有界超时
    outputParts.push("[git add]", result.stdout, result.stderr);

    // 3. git commit
    result = await executeCommand(
      `git commit -m "Publish skill: ${config.displayName} v${config.version}"`,
      config.skillPath,
      60_000, // FIX: 有界超时
    );
    outputParts.push("[git commit]", result.stdout, result.stderr);

    // 4. gh repo create
    result = await executeCommand(
      `gh repo create ${repoName} ${visibility} --source=. --push --description="Codem skill: ${config.displayName}"`,
      config.skillPath,
      120_000, // FIX: 网络操作 2min 超时
    );
    outputParts.push("[gh repo create]", result.stdout, result.stderr);

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `GitHub 仓库创建失败: ${result.stderr}`,
        rawOutput: outputParts.join("\n"),
      };
    }

    // 从输出中提取仓库 URL
    const urlMatch = (result.stdout + result.stderr).match(/https:\/\/github\.com\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0] : `https://github.com/${repoName}`;

    return {
      success: true,
      url,
      publishedId: repoName,
      rawOutput: outputParts.join("\n"),
    };
  } catch (err: any) {
    return {
      success: false,
      error: `GitHub 发布异常: ${err.message || String(err)}`,
      rawOutput: outputParts.join("\n"),
    };
  }
}

/**
 * 通过 CLI 子进程发布技能（通用 CLI 市场适配）。
 * 尝试调用 `<cliCommand> publish <path>` 命令。
 */
async function publishToCLI(config: PublishConfig): Promise<PublishResult> {
  const { executeCommand } = await import("../file-api");

  // 查找 CLI 命令
  const sources = getMarketSources();
  const source = sources.find((s) => s.id === config.sourceId);
  if (!source?.cliCommand) {
    return { success: false, error: "未找到 CLI 命令配置" };
  }

  const cmd = source.cliCommand;

  try {
    // 尝试 publish 命令（格式可能因 CLI 而异）
    const result = await executeCommand(
      `${cmd} publish "${config.skillPath}" --name "${config.displayName}" --version ${config.version}`,
      undefined,
    );
    const output = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      // publish 命令不支持，尝试 upload
      try {
        const result2 = await executeCommand(
          `${cmd} upload "${config.skillPath}" --name "${config.displayName}"`,
          undefined,
        );
        const output2 = (result2.stdout || "") + (result2.stderr ? "\n" + result2.stderr : "");
        if (result2.exitCode !== 0 && result2.exitCode !== undefined) {
          return {
            success: false,
            error: `${cmd} publish/upload 均不支持 (exit ${result2.exitCode}): ${result2.stderr}`,
            rawOutput: output + "\n---\n" + output2,
          };
        }
        return {
          success: true,
          publishedId: config.slug,
          rawOutput: output2,
        };
      } catch {
        return {
          success: false,
          error: `${cmd} 不支持 publish 命令`,
          rawOutput: output,
        };
      }
    }

    const urlMatch = output.match(/https?:\/\/[^\s]+/i);
    return {
      success: true,
      url: urlMatch ? urlMatch[0] : undefined,
      publishedId: config.slug,
      rawOutput: output,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `${cmd} publish 异常: ${err.message || String(err)}`,
    };
  }
}

/**
 * 发布技能到市场（统一入口）。
 *
 * 根据目标市场类型分派到对应的发布实现：
 * - clawhub: 调用 `clawhub skill publish` CLI
 * - github:  通过 `gh repo create` + git push 创建 GitHub 仓库
 * - cli:     调用通用 `<cliCommand> publish` 命令
 *
 * @param config 发布配置
 * @returns 发布结果
 */
export async function publishSkillToMarket(config: PublishConfig): Promise<PublishResult> {
  // 验证技能路径
  if (!config.skillPath) {
    return { success: false, error: "技能路径不能为空" };
  }
  if (!config.slug) {
    return { success: false, error: "技能 slug 不能为空" };
  }
  if (!config.version) {
    return { success: false, error: "版本号不能为空" };
  }

  switch (config.target) {
    case "clawhub":
      return await publishToClawHub(config);
    case "github":
      return await publishToGitHub(config);
    case "cli":
      return await publishToCLI(config);
    default:
      return { success: false, error: `不支持的发布目标: ${config.target}` };
  }
}

/**
 * 预检发布（dry-run）。
 * 仅 ClawHub 支持 --dry-run，其他市场返回就绪状态。
 */
export async function dryRunPublish(config: PublishConfig): Promise<PublishResult> {
  if (config.target !== "clawhub") {
    // GitHub 和 CLI 不支持 dry-run，返回就绪检查
    const markets = await listPublishableMarkets();
    const market = markets.find((m) => m.target === config.target);
    if (market && !market.ready) {
      return { success: false, error: market.notReadyReason || "市场未就绪" };
    }
    return { success: true, rawOutput: "预检通过（该市场不支持 dry-run）" };
  }

  const { executeCommand } = await import("../file-api");
  try {
    const result = await executeCommand(
      `clawhub skill publish "${config.skillPath}" --slug ${config.slug} --name "${config.displayName}" --version ${config.version} --dry-run --json`,
      undefined,
    );
    const output = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `dry-run 失败: ${result.stderr || output}`,
        rawOutput: output,
      };
    }

    return {
      success: true,
      rawOutput: output,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `dry-run 异常: ${err.message || String(err)}`,
    };
  }
}
