/**
 * 交接正文 → 「工作区外的绝对路径」→ 提示加入沙箱允许目录。
 *
 * ## 现场（2026-10-18 用户直报的后续）
 *
 * 修好"移交给新对话"之后，新会话按交接正文去读 `C:/mimo-gui/docs/ui-spec.md`，被沙箱拒绝：
 * 新会话的工作区是 `D:\mimo`，那个绝对路径在工作区外。用户不可能每次交接都手动去设置里
 * 加一遍目录，所以这里做两件事：
 *
 * 1. **机械抽取**交接正文里的绝对路径（不靠模型自觉列出来）；
 * 2. 只挑出**工作区外、又还没被允许**的那些，交付给界面上的提示条（`SandboxAllowPrompt`），
 *    用户点一下就能把它们所在目录加入允许目录。
 *
 * 判据 `ALLOW-1..5`。
 */
import { getSandboxAllowedDirs, isWithinAllowedDirs, normalizeAllowedDir } from "../sandbox/sandbox-acl";

/**
 * 从文本里抽取 Windows 绝对路径（盘符 + UNC），去重，去掉尾部标点。
 *
 * 只做 Windows 形态：本产品是 Windows 桌面应用；POSIX 形态（`/v1` 这类）误报率太高。
 * 支持被引号/中文标点包住的情况（交接正文里很常见）。
 */
export function extractAbsolutePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const cleaned = String(raw ?? "")
      .replace(/^["'「『（(]+/, "")
      .replace(/["'」』）)，。；、,.;:!?]+$/, "")
      .trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase().replace(/\\/g, "/");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  // 1) 盘符路径：C:\... / C:/...（到空白、引号或中文标点为止）
  for (const m of String(text ?? "").matchAll(/[A-Za-z]:[\\/][^\s"'「」『』，。；、）】)]*/g)) {
    push(m[0]);
  }
  // 2) UNC：\\server\share\...
  for (const m of String(text ?? "").matchAll(/\\\\[^\s\\/"'「」『』，。；、）】)]+\\[^\s"'「」『』，。；、）】)]*/g)) {
    push(m[0]);
  }
  return out;
}

/**
 * 其中**在工作区外、且不在允许目录里**的路径（保持原顺序）。
 *
 * 工作区为空（全局对话没有项目目录）时：返回全部路径即可 —— 调用方（提示条）
 * 会要求用户显式选择目录，不会自动放行任何东西。
 */
export function outsideWorkspacePaths(
  paths: readonly string[],
  workspace: string | null | undefined,
  allowed: readonly string[] = getSandboxAllowedDirs(),
): string[] {
  const ws = normalizeAllowedDir(String(workspace ?? "")).toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = normalizeAllowedDir(raw);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (ws && (key === ws || key.startsWith(ws + "/"))) continue;
    if (isWithinAllowedDirs(p, allowed)) continue;
    out.push(p);
  }
  return out;
}

/** 事件名：提示条监听它（见 `SandboxAllowPrompt`） */
export const SANDBOX_ALLOW_REQUEST_EVENT = "codem-sandbox-allow-request";

/**
 * 请求界面提示「把这些目录加入允许目录」。
 *
 * - 没有工作区外路径 ⇒ 什么都不做（不打扰用户）；
 * - 浏览器环境缺失（测试/SSR）⇒ 静默返回 false；
 * - 返回是否真的发出了提示（判据据此断言接线）。
 */
export function requestSandboxAllowlist(
  taskText: string,
  workspace: string | null | undefined,
): boolean {
  const outside = outsideWorkspacePaths(extractAbsolutePaths(taskText), workspace);
  if (outside.length === 0) return false;
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return false;
  window.dispatchEvent(
    new CustomEvent(SANDBOX_ALLOW_REQUEST_EVENT, { detail: { paths: outside } }),
  );
  return true;
}
