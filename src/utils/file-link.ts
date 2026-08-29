/**
 * File link handler — shared between RichContent and MessageBubble.
 *
 * Design (aligned with DSH's resolveWorkspacePath + openPath pattern):
 * - Absolute paths (C:\..., /home/...) are used as-is.
 * - Relative paths are resolved against the current workspace cwd.
 * - http(s)/mailto links open in the system browser.
 * - File paths call `reveal_item_in_dir` (highlights file in file manager).
 *   If that fails (file doesn't exist), fall back to `open_file_external`.
 *
 * Right-click (context menu) support:
 * - Right-clicking a file link shows a custom context menu with:
 *   "Open Containing Folder", "Open File", "Copy Path".
 */

/** Global cwd — set by App.tsx when project changes. */
let globalCwd: string = "";

/** Set the current working directory for file link resolution. */
export function setGlobalCwd(cwd: string): void {
  globalCwd = cwd;
}

/** Check if a string looks like an absolute path (Windows or Unix). */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/**
 * Resolve a workspace-relative path into an absolute path, aligned with DSH's
 * resolveWorkspacePath.  If the path is already absolute, return it unchanged.
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (isAbsolutePath(path)) return path;
  if (cwd === undefined || cwd === "") return path;
  const base = cwd.replace(/[/\\]+$/, "");
  const rel = path.replace(/^[/\\]+/, "");
  return `${base}/${rel}`;
}

/**
 * Resolve a raw href (which may be file:// URL or percent-encoded) into
 * an absolute local file path. Exported for the context menu.
 */
export async function resolveFilePath(rawHref: string): Promise<string> {
  let href = rawHref;
  if (href.startsWith("file://")) {
    href = href.replace(/^file:\/\/\/?/, "");
    try {
      href = decodeURIComponent(href);
    } catch {
      // keep as-is
    }
  } else if (href.includes("%5C") || href.includes("%5c")) {
    try {
      href = decodeURIComponent(href);
    } catch {
      href = rawHref;
    }
  }

  // External URLs are not file paths
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return "";

  let absPath = href;
  if (!isAbsolutePath(href)) {
    let cwd = globalCwd;
    if (!cwd) {
      const { invoke } = (window as any).__TAURI__?.core || {};
      if (invoke) {
        try {
          cwd = (await invoke("get_default_cwd")) as string;
        } catch (err) {
          console.error("[resolveFilePath] Failed to get CWD:", err);
        }
      }
    }
    if (cwd) {
      absPath = resolveWorkspacePath(cwd, href);
      if (/^[A-Z]:\\/i.test(cwd)) {
        absPath = cwd.replace(/[\\/]+$/, "") + "\\" + href.replace(/\//g, "\\");
      }
    }
  }

  return absPath;
}

/** Open a file link — call from onClick or context menu. */
export async function openFileLink(rawHref: string): Promise<void> {
  if (!rawHref) return;

  const absPath = await resolveFilePath(rawHref);
  if (!absPath) return;

  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    console.error("[openFileLink] Tauri not available");
    return;
  }

  // External URLs — open in system browser
  if (/^https?:\/\//i.test(rawHref) || /^mailto:/i.test(rawHref)) {
    window.open(rawHref, "_blank");
    return;
  }

  console.log(`[openFileLink] absPath=${absPath}`);

  // Try to reveal the file in file manager (highlights the file)
  try {
    await invoke("reveal_item_in_dir", { path: absPath });
    return;
  } catch (err) {
    console.warn("[openFileLink] reveal_item_in_dir failed:", err);
  }

  // If reveal fails, try opening the parent directory
  try {
    const lastSep = Math.max(absPath.lastIndexOf("\\"), absPath.lastIndexOf("/"));
    if (lastSep > 0) {
      const dirPath = absPath.substring(0, lastSep);
      await invoke("open_file_external", { path: dirPath });
      return;
    }
  } catch (err) {
    console.warn("[openFileLink] open parent dir failed:", err);
  }

  // Last resort: try opening the file itself
  try {
    await invoke("open_file_external", { path: absPath });
  } catch (err2) {
    console.error("[openFileLink] All methods failed:", err2);
  }
}

/**
 * Open a file directly (not reveal in folder, but open the file itself).
 */
export async function openFileDirectly(rawHref: string): Promise<void> {
  const absPath = await resolveFilePath(rawHref);
  if (!absPath) return;

  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) return;

  try {
    await invoke("open_file_external", { path: absPath });
  } catch (err) {
    console.error("[openFileDirectly] failed:", err);
  }
}

/**
 * Copy a file path to clipboard.
 */
export async function copyFilePath(rawHref: string): Promise<void> {
  const absPath = await resolveFilePath(rawHref);
  if (!absPath) return;
  try {
    await navigator.clipboard.writeText(absPath);
  } catch (err) {
    console.error("[copyFilePath] failed:", err);
  }
}

// ===== Custom Context Menu =====

interface MenuState {
  visible: boolean;
  x: number;
  y: number;
  href: string;
}

let menuState: MenuState = { visible: false, x: 0, y: 0, href: "" };
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const fn of listeners) fn();
}

/** Subscribe to context menu state changes. Returns an unsubscribe function. */
export function subscribeFileLinkMenu(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Get current context menu state. */
export function getFileLinkMenuState(): MenuState {
  return menuState;
}

/** Close the context menu. */
export function closeFileLinkMenu(): void {
  menuState = { ...menuState, visible: false };
  notifyListeners();
}

/** onClick handler for file links in markdown. */
export function handleFileLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  // Left-click only; right-click is handled by onContextMenu
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  void openFileLink(href);
}

/** onContextMenu handler — shows custom context menu with file operations. */
export function handleFileLinkContextMenu(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  // Only handle file paths, not external URLs
  if (!href || /^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  menuState = { visible: true, x: e.clientX, y: e.clientY, href };
  notifyListeners();
}
