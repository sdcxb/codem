/**
 * fetch with timeout — 统一网络请求超时封装。
 *
 * 对标 dsh-desktop deadline 语义：所有外部 HTTP 请求（LLM API、多模态、
 * GitHub/Figma、同步等）都应带上限超时，防止慢/无响应端点挂起 UI 或
 * agentic loop。AbortSignal.timeout 在现代浏览器/Tauri WebView 均可用，
 * 但为兼容性这里用 AbortController + setTimeout 实现（与代码库其它
 * helper 一致），并在完成后清理定时器防泄漏。
 */

/** Default timeout for external HTTP requests (ms). */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/** fetch 带超时：超时抛 AbortError（调用方按需 catch）。 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
