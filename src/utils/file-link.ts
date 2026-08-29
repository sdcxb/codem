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
 * - Right-clicking a file link shows "Open Containing Folder" and "Open File".
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

/** Open a file link — call from onClick or onContextMenu. */
export async function openFileLink(rawHref: string): Promise<void> {
  if (!rawHref) return;

  // Conditionally decode percent-encoded backslashes (%5C) from auto-link-paths.
  // react-markdown may or may not decode these depending on version,
  // so we check for the encoded form and decode only if needed.
  let href = rawHref;
  if (href.includes("%5C") || href.includes("%5c")) {
    try {
      href = decodeURIComponent(href);
    } catch {
      href = rawHref;
    }
  }

  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    console.error("[openFileLink] Tauri not available");
    return;
  }

  // External URLs — open in system browser
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    window.open(href, "_blank");
    return;
  }

  // Resolve relative paths against workspace cwd
  let absPath = href;
  if (!isAbsolutePath(href)) {
    // Use globalCwd first (set by App.tsx), then fall back to Tauri command
    let cwd = globalCwd;
    if (!cwd) {
      try {
        cwd = (await invoke("get_default_cwd")) as string;
      } catch (err) {
        console.error("[openFileLink] Failed to get CWD:", err);
      }
    }
    if (cwd) {
      absPath = resolveWorkspacePath(cwd, href);
      // Normalize separators for Windows
      if (/^[A-Z]:\\/i.test(cwd)) {
        absPath = cwd.replace(/[\\/]+$/, "") + "\\" + href.replace(/\//g, "\\");
      }
    }
  }

  console.log(`[openFileLink] href=${href}, absPath=${absPath}`);

  // Try to reveal the file in file manager (highlights the file)
  try {
    await invoke("reveal_item_in_dir", { path: absPath });
    return;
  } catch (err) {
    console.warn("[openFileLink] reveal_item_in_dir failed:", err);
  }

  // If reveal fails, try opening the parent directory
  // Strip the filename and try to open the directory
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

/** onClick handler for file links in markdown. */
export function handleFileLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  // Left-click only; right-click is handled by onContextMenu
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  void openFileLink(href);
}

/** onContextMenu handler — shows native context menu with "Open Containing Folder". */
export function handleFileLinkContextMenu(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  // Only handle file paths, not external URLs
  if (!href || /^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  void openFileLink(href);
}
