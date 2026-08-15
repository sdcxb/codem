/**
 * FileEditor — 文件预览编辑器
 *
 * 支持的文件类型：
 * - 代码/文本：Shiki 语法高亮编辑器
 * - 图片：内置预览（缩放/旋转）
 * - PDF：iframe 预览
 * - Excel（xlsx/xls/csv）：SheetJS 解析表格预览
 * - Word（docx/doc）：读取纯文本预览
 * - 视频：HTML5 video 播放器
 * - 音频：HTML5 audio 播放器
 * - HTML：沙箱 iframe 预览
 * - 其他二进制：提示用系统应用打开
 *
 * 参考 wecode FilePreview 组件体系，参考 pierre 项目的代码编辑器设计。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Save, FileText, Image as ImageIcon, FileX, Eye, ZoomIn, ZoomOut, RotateCw, Download, ExternalLink, Sheet, Music, Video, FileCode, Maximize2, Minimize2 } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";

interface FileEditorProps {
  filePath: string;
  onClose: () => void;
}

// ==================== 文件类型判定 ====================

function getFileExt(path: string): string {
  const name = path.split(/[/\\]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
}

const TEXT_EXTS = new Set([
  "txt", "md", "json", "ts", "tsx", "js", "jsx", "css", "scss", "less",
  "xml", "yaml", "yml", "toml", "csv", "sql",
  "py", "java", "c", "cpp", "h", "hpp", "rs", "go", "rb", "php", "swift", "kt",
  "sh", "bash", "bat", "ps1", "env", "gitignore", "log",
  "ini", "cfg", "conf", "properties",
  "vue", "svelte", "astro",
  "dockerfile", "makefile", "cmake",
  "lua", "r", "dart", "scala", "clj", "cljs", "ex", "exs", "erl",
  "graphql", "gql", "proto", "thrift",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico"]);
const PDF_EXTS = new Set(["pdf"]);
const EXCEL_EXTS = new Set(["xlsx", "xls", "csv"]);
const WORD_EXTS = new Set(["doc", "docx"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "avi", "mov", "mkv", "ogv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "aac", "m4a"]);
const HTML_EXTS = new Set(["html", "htm"]);
const BINARY_EXTS = new Set([
  "exe", "dll", "so", "dylib", "bin", "wasm",
  "zip", "tar", "gz", "rar", "7z", "bz2",
  "ttf", "otf", "woff", "woff2", "eot",
  "pdb", "ipdb", "pyc", "class", "o", "a",
  "ppt", "pptx", // PPT 暂不支持内置预览
]);

type FileCategory = "text" | "image" | "pdf" | "excel" | "word" | "video" | "audio" | "html" | "binary";

function getCategory(ext: string): FileCategory {
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (PDF_EXTS.has(ext)) return "pdf";
  if (EXCEL_EXTS.has(ext)) return "excel";
  if (WORD_EXTS.has(ext)) return "word";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (HTML_EXTS.has(ext)) return "html";
  return "binary";
}

/** 文件扩展名到 Shiki 语言名的映射 */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", swift: "swift",
  kt: "kotlin", sh: "bash", bash: "bash", ps1: "powershell",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", xml: "xml", css: "css", scss: "scss",
  sql: "sql", md: "markdown", dockerfile: "dockerfile",
  vue: "vue", svelte: "svelte", ini: "ini", csv: "csv",
  lua: "lua", r: "r", dart: "dart", scala: "scala",
  graphql: "graphql", gql: "graphql", proto: "proto",
};

function getShikiLang(ext: string): string {
  return EXT_TO_LANG[ext] || "text";
}

/** 获取文件的 MIME 类型（用于 data URL 和 media 标签） */
function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
    pdf: "application/pdf",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", ogv: "video/ogg",
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", aac: "audio/aac", m4a: "audio/mp4",
    html: "text/html", htm: "text/html",
  };
  return map[ext] || "application/octet-stream";
}

/** 调用 Tauri read_file 命令读取文件（文本或 base64） */
async function readFile(path: string, encoding?: "base64"): Promise<string> {
  const { invoke } = (window as any).__TAURI__.core;
  return invoke("read_file", { path, encoding });
}

// ==================== Shiki 高亮器单例 ====================

let highlighterPromise: Promise<any> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark-dimmed", "github-light"],
        langs: [
          "javascript", "typescript", "jsx", "tsx", "python", "rust",
          "go", "java", "c", "cpp", "csharp", "php", "ruby", "swift",
          "kotlin", "bash", "shell", "powershell", "json", "yaml", "toml",
          "html", "css", "scss", "sql", "markdown", "dockerfile",
          "diff", "ini", "xml", "vue", "svelte", "lua", "r", "dart",
          "scala", "graphql", "proto",
        ],
      })
    );
  }
  return highlighterPromise;
}

function getCurrentShikiTheme(): "github-dark-dimmed" | "github-light" {
  const dataTheme = document.documentElement.getAttribute("data-theme");
  const dataSkin = document.documentElement.getAttribute("data-skin");
  if (dataSkin === "hub") return "github-dark-dimmed";
  return dataTheme === "light" ? "github-light" : "github-dark-dimmed";
}

// ==================== 预览组件 ====================

/** 图片预览 — 支持缩放/旋转 */
function FilePreviewImage({ filePath }: { filePath: string }) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const ext = getFileExt(filePath);
  const mime = getMimeType(ext);

  useEffect(() => {
    setLoading(true);
    setError("");
    (async () => {
      try {
        const base64 = await readFile(filePath, "base64");
        setDataUrl(`data:${mime};base64,${base64}`);
      } catch (err: any) {
        setError(err.message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [filePath, mime]);

  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError msg={error} />;

  return (
    <div className="file-preview-image">
      <div className="file-preview-toolbar">
        <button onClick={() => setScale(s => Math.max(0.1, s - 0.1))} title="缩小 (-)"><ZoomOut size={16} /></button>
        <span className="file-preview-zoom">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => Math.min(5, s + 0.1))} title="放大 (+)"><ZoomIn size={16} /></button>
        <button onClick={() => setRotation(r => (r + 90) % 360)} title="旋转 (R)"><RotateCw size={16} /></button>
      </div>
      <div className="file-preview-image-body">
        <img
          src={dataUrl}
          alt={filePath}
          style={{ transform: `scale(${scale}) rotate(${rotation}deg)`, maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transition: "transform 0.15s ease" }}
        />
      </div>
    </div>
  );
}

/** PDF 预览 — iframe data URL */
function FilePreviewPdf({ filePath }: { filePath: string }) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    (async () => {
      try {
        const base64 = await readFile(filePath, "base64");
        setDataUrl(`data:application/pdf;base64,${base64}`);
      } catch (err: any) {
        setError(err.message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [filePath]);

  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError msg={error} />;

  return (
    <div className="file-preview-embed">
      <iframe src={dataUrl} style={{ width: "100%", height: "100%", border: "none" }} title="PDF Viewer" />
    </div>
  );
}

/** Excel 预览 — SheetJS 解析表格 */
interface ExcelSheet {
  name: string;
  data: (string | number | boolean | null)[][];
}

function FilePreviewExcel({ filePath }: { filePath: string }) {
  const [sheets, setSheets] = useState<ExcelSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    (async () => {
      try {
        const base64 = await readFile(filePath, "base64");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const XLSX = await import("xlsx");
        const workbook = XLSX.read(bytes, { type: "array" });
        const parsed: ExcelSheet[] = [];
        for (const name of workbook.SheetNames) {
          const ws = workbook.Sheets[name];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false }) as (string | number | boolean | null)[][];
          parsed.push({ name, data });
        }
        setSheets(parsed);
        setActiveSheet(0);
      } catch (err: any) {
        setError(err.message || "解析失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [filePath]);

  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError msg={error} />;
  if (sheets.length === 0) return <PreviewError msg="无法解析表格内容" />;

  const sheet = sheets[activeSheet];

  return (
    <div className="file-preview-excel">
      {sheets.length > 1 && (
        <div className="file-preview-excel-tabs">
          {sheets.map((s, i) => (
            <button key={i} className={i === activeSheet ? "active" : ""} onClick={() => setActiveSheet(i)}>{s.name}</button>
          ))}
        </div>
      )}
      <div className="file-preview-excel-body">
        <table>
          <tbody>
            {sheet.data.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "header-row" : ""}>
                <td className="row-num">{ri + 1}</td>
                {row.map((cell, ci) => (
                  <td key={ci} className={ri === 0 ? "header-cell" : ""} title={cell != null ? String(cell) : ""}>
                    <div className="cell-content">{cell != null ? String(cell) : ""}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="file-preview-excel-footer">
        {sheet.name} · {sheet.data.length} 行
      </div>
    </div>
  );
}

/** Word 预览 — 读取纯文本 */
function FilePreviewWord({ filePath }: { filePath: string }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    (async () => {
      try {
        // 尝试读取为文本（docx 实际是 zip，会读到二进制）
        // 先用 base64 读取，然后尝试提取文本
        const base64 = await readFile(filePath, "base64");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        try {
          // 尝试用 JSZip 解压 docx 并提取 word/document.xml
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(bytes);
          const docXml = zip.file("word/document.xml");
          if (docXml) {
            const xml = await docXml.async("text");
            // 从 XML 中提取纯文本
            const text = xml
              .replace(/<w:p[^>]*>/g, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .trim();
            setContent(text || "（文档内容为空）");
            return;
          }
        } catch {
          // 不是 zip 格式（可能是老式 .doc），降级为直接读文本
        }

        // 降级：直接读取文本
        const text = await readFile(filePath);
        setContent(text || "（无法提取文本内容）");
      } catch (err: any) {
        setError(err.message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [filePath]);

  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError msg={error} />;

  return (
    <div className="file-preview-word">
      <div className="file-preview-word-body">{content}</div>
    </div>
  );
}

/** 视频/音频预览 — HTML5 媒体播放器 */
function FilePreviewMedia({ filePath, type }: { filePath: string; type: "video" | "audio" }) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const ext = getFileExt(filePath);
  const mime = getMimeType(ext);

  useEffect(() => {
    setLoading(true);
    setError("");
    (async () => {
      try {
        const base64 = await readFile(filePath, "base64");
        // 大文件可能 data URL 过长，但对预览够用
        setDataUrl(`data:${mime};base64,${base64}`);
      } catch (err: any) {
        setError(err.message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [filePath, mime]);

  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError msg={error} />;

  if (type === "video") {
    return (
      <div className="file-preview-video">
        <video src={dataUrl} controls style={{ maxWidth: "100%", maxHeight: "100%" }} />
      </div>
    );
  }
  return (
    <div className="file-preview-audio">
      <Music size={48} />
      <audio src={dataUrl} controls style={{ width: "100%", maxWidth: "400px" }} />
    </div>
  );
}

/** HTML 沙箱预览 */
function FilePreviewHtml({ filePath }: { filePath: string }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sourceMode, setSourceMode] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError("");
    (async () => {
      try {
        const text = await readFile(filePath);
        setContent(text);
      } catch (err: any) {
        setError(err.message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [filePath]);

  if (loading) return <PreviewLoading />;
  if (error) return <PreviewError msg={error} />;

  return (
    <div className="file-preview-html">
      <div className="file-preview-html-toolbar">
        <button className={!sourceMode ? "active" : ""} onClick={() => setSourceMode(false)}>预览</button>
        <button className={sourceMode ? "active" : ""} onClick={() => setSourceMode(true)}>源码</button>
      </div>
      {sourceMode ? (
        <pre className="file-preview-html-source">{content}</pre>
      ) : (
        <iframe
          srcDoc={content}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          title="HTML Preview"
        />
      )}
    </div>
  );
}

/** 不支持的二进制文件 */
function FilePreviewBinary({ filePath, fileName }: { filePath: string; fileName: string }) {
  const handleOpenExternal = async () => {
    try {
      const { invoke } = (window as any).__TAURI__.core;
      await invoke("open_file_external", { path: filePath });
    } catch {
      try {
        const { invoke } = (window as any).__TAURI__.core;
        await invoke("execute_command", { command: `cmd /c start "" "${filePath}"` });
      } catch {}
    }
  };

  return (
    <div className="file-preview-binary">
      <FileX size={48} className="file-preview-office-icon-svg" />
      <div className="file-preview-office-name">{fileName}</div>
      <div className="file-preview-office-type">二进制文件</div>
      <div className="file-preview-office-hint">无法在内置编辑器中预览</div>
      <button className="file-preview-office-btn" onClick={handleOpenExternal}>📂 用系统应用打开</button>
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="file-editor-loading">
      <Eye size={32} />
      <span>加载中...</span>
    </div>
  );
}

function PreviewError({ msg }: { msg: string }) {
  return <div className="file-editor-error-body">{msg}</div>;
}

// ==================== 代码编辑器（Shiki 高亮 + textarea 叠加） ====================

interface CodeEditorProps {
  content: string;
  filePath: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
  modified: boolean;
  saving: boolean;
}

const CodeEditor = ({ content, filePath, onChange, onSave, onClose, modified, saving }: CodeEditorProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [highlightedHtml, setHighlightedHtml] = useState<string>("");
  const [highlighterReady, setHighlighterReady] = useState(false);
  const [shikiTheme, setShikiTheme] = useState(getCurrentShikiTheme());

  const ext = getFileExt(filePath);
  const lang = getShikiLang(ext);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const newTheme = getCurrentShikiTheme();
      setShikiTheme((prev) => (prev !== newTheme ? newTheme : prev));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-skin"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getHighlighter();
        if (!cancelled) setHighlighterReady(true);
      } catch {
        if (!cancelled) setHighlighterReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!highlighterReady) return;
    let cancelled = false;
    (async () => {
      try {
        const highlighter = await getHighlighter();
        const loadedLangs = highlighter.getLoadedLanguages();
        const finalLang = loadedLangs.includes(lang) ? lang : "text";
        const html = highlighter.codeToHtml(content, {
          lang: finalLang,
          theme: shikiTheme,
        });
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        if (!cancelled) {
          const escaped = content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          setHighlightedHtml(`<pre class="shiki"><code>${escaped}</code></pre>`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [content, lang, shikiTheme, highlighterReady]);

  const handleScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = ta.scrollTop;
    }
  }, []);

  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const lineNumbers = useMemo(() => {
    const nums: number[] = [];
    for (let i = 1; i <= lineCount; i++) nums.push(i);
    return nums;
  }, [lineCount]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      if (e.shiftKey) {
        const lineStart = content.lastIndexOf("\n", start - 1) + 1;
        const before = content.substring(lineStart, start);
        const leadingSpaces = before.match(/^ {1,2}/);
        if (leadingSpaces) {
          const removeCount = leadingSpaces[0].length;
          const newContent = content.substring(0, lineStart) + content.substring(lineStart + removeCount);
          onChange(newContent);
          setTimeout(() => {
            ta.selectionStart = ta.selectionEnd = start - removeCount;
          }, 0);
        }
        return;
      }

      const newContent = content.substring(0, start) + "  " + content.substring(end);
      onChange(newContent);
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      }, 0);
      return;
    }

    const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
    if (pairs[e.key]) {
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start === end) {
        e.preventDefault();
        const closing = pairs[e.key];
        const newContent = content.substring(0, start) + e.key + closing + content.substring(end);
        onChange(newContent);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        }, 0);
      }
    }
  }, [content, onChange, onSave, onClose]);

  return (
    <div className="code-editor-container" ref={scrollContainerRef}>
      <div className="code-editor-scroll-area">
        <div className="code-editor-gutter" ref={gutterRef}>
          {lineNumbers.map((n) => (
            <span key={n} className="code-editor-line-number">{n}</span>
          ))}
        </div>

        <div className="code-editor-main">
        <pre
          ref={preRef}
          className="code-editor-highlight"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlightedHtml || '<pre class="shiki"><code></code></pre>' }}
        />

        <textarea
          ref={textareaRef}
          className="code-editor-textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          style={{
            color: "transparent",
            caretColor: shikiTheme === "github-light" ? "#1f2328" : "#adbac7",
            background: "transparent",
            WebkitTextFillColor: "transparent",
          }}
        />
      </div>
      </div>

      <div className="code-editor-statusbar">
        <span className="code-editor-status-lang">{lang}</span>
        <span className="code-editor-status-info">
          {lineCount} 行 · {content.length} 字符
        </span>
        {modified && <span className="code-editor-status-modified">● 已修改</span>}
      </div>
    </div>
  );
};

// ==================== 主组件 ====================

export function FileEditor({ filePath, onClose }: FileEditorProps) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [floating, setFloating] = useState(false);

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const ext = getFileExt(filePath);
  const category = getCategory(ext);
  const isText = category === "text";

  useEffect(() => {
    if (!isText) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const loadFile = async () => {
      try {
        const text = await readFile(filePath);
        setContent(text);
        setOriginalContent(text);
        setModified(false);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    loadFile();
  }, [filePath, isText]);

  const handleChange = useCallback((value: string) => {
    setContent(value);
    setModified(value !== originalContent);
  }, [originalContent]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const { invoke } = (window as any).__TAURI__.core;
      await invoke("write_file", { path: filePath, content });
      setOriginalContent(content);
      setModified(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [filePath, content]);

  const fileIcon = useMemo(() => {
    switch (category) {
      case "image": return <ImageIcon size={16} />;
      case "pdf": return <FileText size={16} />;
      case "excel": return <Sheet size={16} />;
      case "word": return <FileText size={16} />;
      case "video": return <Video size={16} />;
      case "audio": return <Music size={16} />;
      case "html": return <FileCode size={16} />;
      case "text": return <FileText size={16} />;
      default: return <FileX size={16} />;
    }
  }, [category]);

  return (
    <div className="file-editor">
      <div className="file-editor-header">
        <span className="file-editor-icon">{fileIcon}</span>
        <span className="file-editor-name">
          {modified && <span className="file-editor-modified-dot">●</span>}
          {fileName}
        </span>
        <span className="file-editor-path" title={filePath}>{filePath}</span>
        <div className="file-editor-actions">
          {error && <span className="file-editor-error">{error}</span>}
          {isText && (
            <button
              className="file-editor-btn save-btn"
              onClick={handleSave}
              disabled={!modified || saving}
              title="Ctrl+S"
            >
              <Save size={14} />
              {saving ? "保存中..." : "保存"}
            </button>
          )}
          <button
            className="file-editor-btn"
            onClick={() => setFloating(true)}
            title="放大浏览"
          >
            <Maximize2 size={14} />
          </button>
          <button className="file-editor-btn close" onClick={onClose} title="关闭 (Esc)">
            <ActionIcons.close size={14} />
          </button>
        </div>
      </div>
      <div className="file-editor-body">
        {category === "image" ? (
          <FilePreviewImage filePath={filePath} />
        ) : category === "pdf" ? (
          <FilePreviewPdf filePath={filePath} />
        ) : category === "excel" ? (
          <FilePreviewExcel filePath={filePath} />
        ) : category === "word" ? (
          <FilePreviewWord filePath={filePath} />
        ) : category === "video" ? (
          <FilePreviewMedia filePath={filePath} type="video" />
        ) : category === "audio" ? (
          <FilePreviewMedia filePath={filePath} type="audio" />
        ) : category === "html" ? (
          <FilePreviewHtml filePath={filePath} />
        ) : category === "binary" ? (
          <FilePreviewBinary filePath={filePath} fileName={fileName} />
        ) : loading ? (
          <PreviewLoading />
        ) : error ? (
          <PreviewError msg={error} />
        ) : (
          <CodeEditor
            content={content}
            filePath={filePath}
            onChange={handleChange}
            onSave={handleSave}
            onClose={onClose}
            modified={modified}
            saving={saving}
          />
        )}
      </div>
      {floating && createPortal(
        <div className="file-editor-floating-overlay" onClick={() => setFloating(false)}>
          <div className="file-editor-floating-window" onClick={(e) => e.stopPropagation()}>
            <div className="file-editor-floating-header">
              <span className="file-editor-icon">{fileIcon}</span>
              <span className="file-editor-name">{fileName}</span>
              <span className="file-editor-path" title={filePath}>{filePath}</span>
              <div className="file-editor-actions">
                {isText && (
                  <button
                    className="file-editor-btn save-btn"
                    onClick={handleSave}
                    disabled={!modified || saving}
                    title="Ctrl+S"
                  >
                    <Save size={14} />
                    {saving ? "保存中..." : "保存"}
                  </button>
                )}
                <button className="file-editor-btn" onClick={() => setFloating(false)} title="缩小返回">
                  <Minimize2 size={14} />
                </button>
                <button className="file-editor-btn close" onClick={onClose} title="关闭">
                  <ActionIcons.close size={14} />
                </button>
              </div>
            </div>
            <div className="file-editor-floating-body">
              {category === "image" ? (
                <FilePreviewImage filePath={filePath} />
              ) : category === "pdf" ? (
                <FilePreviewPdf filePath={filePath} />
              ) : category === "excel" ? (
                <FilePreviewExcel filePath={filePath} />
              ) : category === "word" ? (
                <FilePreviewWord filePath={filePath} />
              ) : category === "video" ? (
                <FilePreviewMedia filePath={filePath} type="video" />
              ) : category === "audio" ? (
                <FilePreviewMedia filePath={filePath} type="audio" />
              ) : category === "html" ? (
                <FilePreviewHtml filePath={filePath} />
              ) : category === "binary" ? (
                <FilePreviewBinary filePath={filePath} fileName={fileName} />
              ) : loading ? (
                <PreviewLoading />
              ) : error ? (
                <PreviewError msg={error} />
              ) : (
                <CodeEditor
                  content={content}
                  filePath={filePath}
                  onChange={handleChange}
                  onSave={handleSave}
                  onClose={() => setFloating(false)}
                  modified={modified}
                  saving={saving}
                />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
