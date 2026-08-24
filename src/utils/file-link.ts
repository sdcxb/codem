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
export async function openFileLink(href: string): Promise<void> {
  if (!href) return;

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
    try {
      const cwd = (await invoke("get_default_cwd")) as string;
      absPath = resolveWorkspacePath(cwd, href);
      // Normalize separators for Windows
      if (/^[A-Z]:\\/i.test(cwd)) {
        absPath = cwd.replace(/[\\/]+$/, "") + "\\" + href.replace(/\//g, "\\");
      }
    } catch (err) {
      console.error("[openFileLink] Failed to get CWD:", err);
    }
  }

  // Try to reveal the file in file manager (highlights the file)
  try {
    await invoke("reveal_item_in_dir", { path: absPath });
  } catch {
    // If reveal fails (e.g. file doesn't exist), try opening the parent directory
    try {
      await invoke("open_file_external", { path: absPath });
    } catch (err2) {
      console.error("[openFileLink] Both reveal and open failed:", err2);
    }
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
