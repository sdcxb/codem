/**
 * 更新包下载的**有界重试**与**可读错误**（第 82 轮；关闭 `GAP-LIST.md` 的 O-9）
 *
 * ## 真机现场（两次复现，可复核）
 *
 * 装机版点「检查更新」→ 按钮先显示 `发现新版本 1.16.126，下载中…`，
 * 然后变成 **`更新失败: error decoding response body`**。同一台机器上：
 * - 独立 `curl` 下同一个 40MB 安装包，第一次在 **27MB** 处 `exit 56`（接收数据中断），
 *   加 `--retry 3 --retry-all-errors` 才下全，sha256 与 `latest.json` 一致；
 * - 也就是说**包本身没问题，是这台机器的网络会把长下载掐断**。
 *
 * 而应用这一侧的问题是两条，都不是"网络"能解释的：
 * 1. **一次失败就放弃**：`downloadAndInstall()` 直接抛，界面把 `reqwest` 的原始错误
 *    （`error decoding response body`）原样印给用户 —— 用户读不出"这是什么、下一步做什么"；
 * 2. **没有重试**：明明是可恢复的传输中断，却让用户自己反复点按钮（用户不会知道要点几次）。
 *
 * ## 修法（这里只做两件可测的事）
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | 重试 | 只对**可恢复**的错误重试，最多 3 次、退避 800ms→1600ms（上界硬性，不许无限重试） |
 * | 可读 | 把已知错误翻译成"发生了什么 + 下一步"，**同时保留原文**（便于对账/反馈） |
 *
 * ## 为什么**不**重试所有错误（这条比"多试几次"更重要）
 *
 * **签名/校验类错误重试没有任何意义**：包的哈希对不上、公钥验不过，
 * 再下十次还是同一个结果，而重试会把"这是个严重问题（可能被篡改/发布坏了）"
 * 稀释成"网络不好，请重试"。所以 `isRetryableUpdateError` 明确**排除**
 * 签名/校验/权限类，它们**一次就抛**、并把原始信息完整带出去。
 *
 * 判据的边界也如实写在这里：**本模块不验证签名**（那是 `tauri-plugin-updater`
 * 用内置公钥做的事），它只决定"要不要再试一次"以及"怎么把话说清楚"。
 */

/**
 * 每次尝试的进度（**刻意不导出**）。
 *
 * 它只出现在 `DownloadRetryOptions.onAttempt` 的签名里，调用方靠类型推断就够了。
 * 第 82 轮第一次写成 `export interface` 时，**knip 棘轮当场报"types 222 → 223 涨了"** ——
 * 而本仓库的纪律是"没人引用的导出就别导出"（留着它只会逼着人去放宽棘轮）。
 */
interface DownloadAttemptInfo {
  /** 第几次尝试（从 1 开始，含第一次） */
  attempt: number;
  /** 总尝试次数（上界） */
  total: number;
  /** 本次失败的原因（第一次进来时为 undefined） */
  error?: unknown;
  /** 本次尝试前等待了多少毫秒（第一次为 0） */
  waitedMs: number;
}

export interface DownloadRetryOptions {
  /** 最多尝试几次（含第一次）。默认 3；**硬性上界 5**，传更大的值会被夹到 5。 */
  attempts?: number;
  /** 首次退避毫秒（之后翻倍）。默认 800。 */
  baseDelayMs?: number;
  /** 每次尝试前回调（用于界面显示"第 n/N 次尝试"） */
  onAttempt?: (info: DownloadAttemptInfo) => void;
  /** 注入 sleep（用例里不真等） */
  sleep?: (ms: number) => Promise<void>;
}

/** 硬性上界：再离谱的传参也不许变成"无限重试" */
export const MAX_DOWNLOAD_ATTEMPTS = 5;

/**
 * 可恢复的错误特征（**白名单**，不是黑名单）。
 *
 * 用白名单的理由：这里的判断会影响"要不要再下一个 40MB 的包"，
 * 把"不认识"当"可重试"会让签名/权限类问题被反复重试（正是上面说的稀释）。
 * 这些串都来自真机或 `reqwest`/`hyper` 的既有形态：
 * - `error decoding response body` —— **本机实测的那一句**（传输被截断，body 解不出来）；
 * - `error sending request` / `connection` / `reset by peer` / `broken pipe` —— 连接层中断；
 * - `timed out` / `timeout` / `unexpected eof` —— 超时或对端提前关闭；
 * - `dns` / `network` / `temporarily` / `502 / 503 / 504` —— 解析/网关类，通常是暂时的。
 */
const RETRYABLE_MARKERS = [
  "error decoding response body",
  "error sending request",
  "connection",
  "connect",
  "reset by peer",
  "broken pipe",
  "unexpected eof",
  "timed out",
  "timeout",
  "dns",
  "network",
  "temporarily",
  "502",
  "503",
  "504",
];

/**
 * **不可重试**的特征（先判这一组）：签名/校验/权限/清单结构。
 * 只要命中就不重试 —— 重试掩盖的是"发布坏了或被改了"。
 */
const NON_RETRYABLE_MARKERS = [
  "signature",
  "verif",
  "public key",
  "hash mismatch",
  "checksum",
  "not allowed",
  "permission",
  "forbidden",
  "403",
  "404",
  "malformed",
  "invalid json",
  "expected value",
];

function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const e = err as { message?: unknown; code?: unknown; toString?: () => string };
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  if (e.code !== undefined) parts.push(String(e.code));
  if (!parts.length) {
    try {
      parts.push(String(e));
    } catch {
      parts.push("");
    }
  }
  return parts.join(" ");
}

/**
 * 这个错误值不值得再下一次？
 *
 * - 命中不可重试特征 → **false**（一次就抛，别稀释严重问题）；
 * - 命中可重试特征 → **true**；
 * - 都不命中 → **false**（**默认不重试**，并把原始信息完整带给用户；
 *   宁可少试一次，也不要把"我不认识的问题"当成网络抖动反复试）。
 */
export function isRetryableUpdateError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  if (!text) return false;
  if (NON_RETRYABLE_MARKERS.some((m) => text.includes(m))) return false;
  return RETRYABLE_MARKERS.some((m) => text.includes(m));
}

/**
 * 把技术错误翻成"发生了什么 + 下一步"。
 *
 * 原则（与仓库其余错误文案同源）：**不吞原文**、**不编原因**。
 * 认识的特征给明确解释；不认识的一律走"未知错误 + 原文"，
 * 让用户能把它原样贴出来，而不是看到一句空洞的"更新失败"。
 */
export function describeUpdateError(err: unknown, lang: "zh" | "en" = "zh"): string {
  const raw = errorText(err).trim();
  const lower = raw.toLowerCase();
  const zh = lang === "zh";
  const withRaw = (head: string) => (raw ? `${head}（原始信息：${raw.slice(0, 160)}）` : head);

  if (lower.includes("error decoding response body") || lower.includes("unexpected eof") || lower.includes("broken pipe")) {
    return withRaw(
      zh
        ? "网络把安装包下载掐断了（传输未完成）—— 请重试；若反复失败，可到 GitHub Release 手动下载"
        : "The network cut the installer download short (transfer incomplete) — retry; if it keeps failing, download manually from GitHub Releases",
    );
  }
  if (NON_RETRYABLE_MARKERS.some((m) => lower.includes(m))) {
    return withRaw(
      zh
        ? "安装包校验/权限没通过（这一条**重试没有用**）—— 多半是发布产物有问题，请反馈这条原始信息"
        : "Installer verification/permission failed (retrying will not help) — the release artifact is likely broken; please report this raw message",
    );
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return withRaw(zh ? "下载超时 —— 请重试或换网络" : "Download timed out — retry or switch networks");
  }
  if (isRetryableUpdateError(err)) {
    return withRaw(zh ? "网络中断 —— 请重试" : "Network interrupted — please retry");
  }
  if (!raw) {
    return zh ? "更新失败（没有拿到错误信息）—— 请重试" : "Update failed (no error detail) — please retry";
  }
  return withRaw(zh ? "更新失败" : "Update failed");
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 带**有界重试**的下载。
 *
 * - `run` 每次重试都会被**重新调用**（`downloadAndInstall` 重入即重新下载）；
 * - 每次尝试前调 `onAttempt`（界面据此显示"第 n/N 次尝试"，不需要自己数）；
 * - 退避：`baseDelayMs * 2^(attempt-1)`（第一次不等待）；
 * - 次数用尽后**抛出最后一次的原始错误**（不包装成新类型：
 *   上层要用 `describeUpdateError` 决定措辞，包装会丢掉原始特征）。
 */
export async function downloadWithRetry<T>(
  run: () => Promise<T>,
  opts: DownloadRetryOptions = {},
): Promise<T> {
  const total = Math.min(Math.max(1, Math.floor(opts.attempts ?? 3)), MAX_DOWNLOAD_ATTEMPTS);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 800);
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= total; attempt++) {
    const waitedMs = attempt === 1 ? 0 : baseDelayMs * 2 ** (attempt - 2);
    opts.onAttempt?.({ attempt, total, error: attempt === 1 ? undefined : lastError, waitedMs });
    if (waitedMs > 0) await sleep(waitedMs);
    try {
      return await run();
    } catch (err) {
      lastError = err;
      const moreLeft = attempt < total;
      if (!moreLeft || !isRetryableUpdateError(err)) {
        // 不可重试的错误**立刻**抛（签名/权限类），其余是次数用尽 —— 两种都保留原始错误
        throw err;
      }
      console.warn(
        `[updater] 下载第 ${attempt}/${total} 次失败（可重试）：${errorText(err).slice(0, 120)}`,
      );
    }
  }
  // 理论上到不了这里（循环内要么 return 要么 throw）；留一行防御，避免"静默返回 undefined"
  throw lastError ?? new Error("update download failed without an error");
}
