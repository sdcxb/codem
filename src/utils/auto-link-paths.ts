/**
 * Auto-link local file paths in plain text.
 *
 * This is a rendering-layer post-processing — it does NOT depend on the LLM
 * using Markdown link syntax. Any bare file path in the assistant's text
 * (e.g. `D:\project\src\index.ts` or `/home/user/file.py`) is converted to a
 * clickable Markdown link before being passed to the Markdown renderer.
 *
 * Design (aligned with DSH's "don't trust model behavior" principle):
 * - The system prompt says "use Markdown links for file paths", but models
 *   don't always comply. This is the safety net.
 * - We only touch paths that look like real local paths — not URLs, not
 *   code-fenced content, not existing Markdown links.
 * - We avoid false positives by requiring either:
 *   a) A drive letter + backslash (Windows absolute): C:\...\file.ext
 *   b) A Unix absolute path with known extension: /home/.../file.ext
 *   c) A relative path with known extension that starts with ./
 *
 * Important: This runs BEFORE the Markdown parser, so we must not touch
 * content inside code spans (backticks) or code fences (```), since those
 * are handled by the inline-code renderer's own file-mention logic.
 */

/** Known file extensions for path detection */
const FILE_EXTENSIONS =
  /\.(md|txt|json|yaml|yml|ts|tsx|js|jsx|mjs|cjs|py|sh|bat|ps1|css|scss|less|html|htm|svg|png|jpg|jpeg|gif|bmp|webp|ico|toml|ini|cfg|conf|rs|go|java|c|cpp|cc|h|hpp|sql|xml|csv|log|env|lock|gitignore|dockerfile|makefile|cmake|gradle|kt|swift|rb|php|vue|svelte|astro|docx|xlsx|pptx|pdf|zip|tar|gz|rar|7z|wav|mp3|mp4|avi|mov|webm|ttf|otf|woff|woff2|eot)$/i;

/**
 * Check if a path segment looks like a real file path.
 * Must end with a known extension, or contain a path separator.
 */
function looksLikeFilePath(text: string): boolean {
  // Windows absolute: C:\path\file.ext or C:/path/file.ext
  if (/^[A-Za-z]:[\\/]\S+/.test(text)) {
    return FILE_EXTENSIONS.test(text) || /[\\/]/.test(text.slice(2));
  }
  // Unix absolute: /home/user/file.ext
  if (/^\/\S+/.test(text)) {
    return FILE_EXTENSIONS.test(text);
  }
  // Relative with ./: ./src/file.ext
  if (/^\.\//.test(text) && /^\.\S+/.test(text)) {
    return FILE_EXTENSIONS.test(text);
  }
  // UNC path: \\server\share\file.ext
  if (/^\\\\\S+/.test(text)) {
    return FILE_EXTENSIONS.test(text);
  }
  return false;
}

/**
 * Check if a URL from an existing Markdown link looks like a local file path.
 * More permissive than looksLikeFilePath — doesn't require file extension,
 * just needs to look like a path (drive letter or leading slash).
 */
function isLocalPath(p: string): boolean {
  if (!p) return false;
  // Windows: C:\... or C:/...
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // Unix absolute: /home/...
  if (p.startsWith("/")) return true;
  // UNC: \\server\share
  if (p.startsWith("\\\\")) return true;
  // Relative: ./...
  if (p.startsWith("./")) return true;
  return false;
}

/**
 * Extract the file path from a matched string (strip trailing punctuation
 * that the regex might have captured).
 */
function cleanPath(raw: string): string {
  let cleaned = raw;
  while (cleaned.length > 0 && /[.,;:!?)\]}>"']$/.test(cleaned)) {
    const lastChar = cleaned[cleaned.length - 1];
    if (lastChar === "." && cleaned.length > 1 && /[a-zA-Z0-9]/.test(cleaned[cleaned.length - 2])) {
      cleaned = cleaned.slice(0, -1);
    } else if (lastChar !== ".") {
      cleaned = cleaned.slice(0, -1);
    } else {
      break;
    }
  }
  return cleaned;
}

/**
 * Split text into segments, protecting code spans (backtick-delimited) and
 * code fences (``` blocks) from auto-linking.
 *
 * Returns an array of { text, isCode } segments. Only non-code segments
 * are processed for file path auto-linking.
 */
function splitByCodeSpans(text: string): Array<{ text: string; isCode: boolean }> {
  const segments: Array<{ text: string; isCode: boolean }> = [];
  const codeFenceRegex = /```[\s\S]*?```/g;
  const inlineCodeRegex = /`[^`\n]+`/g;

  type Match = { start: number; end: number };
  const matches: Match[] = [];

  let m: RegExpExecArray | null;
  codeFenceRegex.lastIndex = 0;
  while ((m = codeFenceRegex.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  inlineCodeRegex.lastIndex = 0;
  while ((m = inlineCodeRegex.exec(text)) !== null) {
    const inFence = matches.some((f) => m!.index >= f.start && m!.index < f.end);
    if (!inFence) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  let lastEnd = 0;
  for (const match of matches) {
    if (match.start > lastEnd) {
      segments.push({ text: text.slice(lastEnd, match.start), isCode: false });
    }
    segments.push({ text: text.slice(match.start, match.end), isCode: true });
    lastEnd = match.end;
  }
  if (lastEnd < text.length) {
    segments.push({ text: text.slice(lastEnd), isCode: false });
  }

  return segments.length > 0 ? segments : [{ text, isCode: false }];
}

/**
 * Find bare file paths in a text string and convert them to Markdown links.
 */
function processFilePaths(text: string): string {
  // Regex to find potential file paths:
  // - Windows: C:\path\file.ext or C:/path/file.ext
  // - Unix: /path/to/file.ext
  // - Relative: ./path/file.ext
  // - UNC: \\server\share\file.ext
  //
  // We match sequences of non-whitespace characters that start with a
  // path-like prefix, then check if they look like file paths.
  // Trailing punctuation is stripped in cleanPath().
  const pathRegex =
    /(?:^|[\s(])((?:[A-Za-z]:[\\/]\S+|\/[A-Za-z]\S*?\.[a-zA-Z0-9]{1,10}|\.\S*?\.[a-zA-Z0-9]{1,10}|\\\S+))/g;

  return text.replace(pathRegex, (match, path: string) => {
    const beforeMatch = match[0];
    const cleanP = cleanPath(path);

    if (!looksLikeFilePath(cleanP)) {
      return match;
    }

    // Use file:/// protocol prefix so CommonMark treats this as a valid URL
    // and react-markdown passes it to our <a> renderer. Without this, paths
    // like "D:/path" may be misinterpreted as a "d:" URL scheme by the
    // CommonMark parser, causing the href to be empty or malformed.
    // The openFileLink function strips the file:/// prefix before calling Tauri.
    // Also percent-encode backslashes and spaces for safety.
    const encodedPath = cleanP.replace(/\\/g, "%5C").replace(/ /g, "%20");
    // For Windows: file:///D:/path → file:///D:%5Cpath%5Cfile.txt
    // For Unix: file:///home/user/file.txt
    const fileUrl = cleanP.startsWith("/")
      ? `file://${encodedPath}`
      : `file:///${encodedPath}`;
    return `${beforeMatch}[${path}](${fileUrl} "点击打开文件位置")`;
  });
}

/**
 * Auto-link file paths in plain text (not in code spans).
 *
 * Returns the modified text with Markdown links inserted for bare file paths.
 *
 * @param text The input text (may contain Markdown)
 * @returns The text with file paths wrapped in Markdown links
 */
export function autoLinkFilePaths(text: string): string {
  if (!text) return text;

  const segments = splitByCodeSpans(text);
  let result = "";

  for (const seg of segments) {
    if (seg.isCode) {
      result += seg.text;
      continue;
    }

    const segText = seg.text;
    // Skip existing Markdown links: [label](url)
    const linkRegex = /\[([^\]]*)\]\(([^)]*)\)/g;
    const parts: string[] = [];
    let lastIdx = 0;
    let lm: RegExpExecArray | null;

    while ((lm = linkRegex.exec(segText)) !== null) {
      if (lm.index > lastIdx) {
        parts.push(processFilePaths(segText.slice(lastIdx, lm.index)));
      }
      // Fix existing Markdown links where URL is a local file path
      // (not http(s), mailto, #anchor, or already file://)
      const linkLabel = lm[1];
      let linkUrl = lm[2];
      // Strip optional title from URL: url "title" → url
      const titleMatch = linkUrl.match(/^(\S+)\s+"/);
      let linkTitle = "";
      if (titleMatch) {
        linkTitle = linkUrl.slice(titleMatch[1].length).trim();
        linkUrl = titleMatch[1];
      }
      // Check if URL looks like a local file path
      const isWeb = /^https?:\/\//i.test(linkUrl) || /^mailto:/i.test(linkUrl) || linkUrl.startsWith("#") || linkUrl.startsWith("file://");
      if (!isWeb && isLocalPath(linkUrl)) {
        const encodedPath = linkUrl.replace(/\\/g, "%5C").replace(/ /g, "%20");
        const fileUrl = linkUrl.startsWith("/")
          ? `file://${encodedPath}`
          : `file:///${encodedPath}`;
        parts.push(`[${linkLabel}](${fileUrl}${linkTitle ? " " + linkTitle : ""})`);
      } else {
        parts.push(lm[0]);
      }
      lastIdx = lm.index + lm[0].length;
    }
    if (lastIdx < segText.length) {
      parts.push(processFilePaths(segText.slice(lastIdx)));
    }

    result += parts.join("");
  }

  return result;
}
