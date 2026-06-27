import { useState, useEffect, useRef } from "react";

const isTauri = () => !!(window as any).__TAURI__;

interface FileEditorProps {
  filePath: string;
  onClose: () => void;
}

function getFileExt(path: string): string {
  const name = path.split(/[/\\]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
}

const TEXT_EXTS = new Set(["txt", "md", "json", "ts", "tsx", "js", "jsx", "css", "html", "xml", "yaml", "yml", "toml", "csv", "sql", "py", "java", "c", "cpp", "h", "rs", "go", "sh", "bat", "ps1", "env", "gitignore", "log", "ini", "cfg", "conf", "vue", "svelte"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico"]);
const PDF_EXTS = new Set(["pdf"]);
const OFFICE_EXTS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
const BINARY_EXTS = new Set(["exe", "dll", "so", "dylib", "bin", "zip", "tar", "gz", "rar", "7z", "mp3", "mp4", "avi", "mov", "wav", "ttf", "otf", "woff", "woff2"]);

function fileUrl(path: string): string {
  if (isTauri()) {
    return `https://asset.localhost/${encodeURIComponent(path)}`;
  }
  return `http://localhost:3002/api/file?path=${encodeURIComponent(path)}`;
}

function FilePreviewImage({ filePath }: { filePath: string }) {
  return (
    <div className="file-preview-image">
      <img src={fileUrl(filePath)} alt={filePath} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
    </div>
  );
}

function FilePreviewPdf({ filePath }: { filePath: string }) {
  return (
    <div className="file-preview-embed">
      <iframe src={fileUrl(filePath)} style={{ width: "100%", height: "100%", border: "none" }} title="PDF Viewer" />
    </div>
  );
}

function FilePreviewOffice({ filePath, fileName }: { filePath: string; fileName: string }) {
  const ext = getFileExt(filePath);
  const labels: Record<string, string> = { doc: "Word 文档", docx: "Word 文档", xls: "Excel 表格", xlsx: "Excel 表格", ppt: "PowerPoint 演示", pptx: "PowerPoint 演示" };
  const icons: Record<string, string> = { doc: "📄", docx: "📄", xls: "📊", xlsx: "📊", ppt: "📑", pptx: "📑" };

  const handleOpenExternal = async () => {
    if (isTauri()) {
      try {
        const { invoke } = (window as any).__TAURI__.core;
        await invoke("open_file_external", { path: filePath });
      } catch {
        try {
          const { invoke } = (window as any).__TAURI__.core;
          await invoke("execute_command", { command: `cmd /c start "" "${filePath}"` });
        } catch {}
      }
    } else {
      window.open(fileUrl(filePath), "_blank");
    }
  };

  return (
    <div className="file-preview-office">
      <div className="file-preview-office-icon">{icons[ext] || "📄"}</div>
      <div className="file-preview-office-name">{fileName}</div>
      <div className="file-preview-office-type">{labels[ext] || ext.toUpperCase()} 文件</div>
      <div className="file-preview-office-hint">Office 文件无法在内置编辑器中查看</div>
      <button className="file-preview-office-btn" onClick={handleOpenExternal}>📂 用系统应用打开</button>
    </div>
  );
}

function FilePreviewBinary({ filePath, fileName }: { filePath: string; fileName: string }) {
  return (
    <div className="file-preview-binary">
      <div className="file-preview-office-icon">📦</div>
      <div className="file-preview-office-name">{fileName}</div>
      <div className="file-preview-office-type">二进制文件</div>
      <div className="file-preview-office-hint">无法在编辑器中预览</div>
    </div>
  );
}

export function FileEditor({ filePath, onClose }: FileEditorProps) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const ext = getFileExt(filePath);

  const isText = TEXT_EXTS.has(ext) || (!IMAGE_EXTS.has(ext) && !PDF_EXTS.has(ext) && !OFFICE_EXTS.has(ext) && !BINARY_EXTS.has(ext));
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = PDF_EXTS.has(ext);
  const isOffice = OFFICE_EXTS.has(ext);
  const isBinary = BINARY_EXTS.has(ext);

  useEffect(() => {
    if (!isText) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const loadFile = async () => {
      try {
        let text: string;
        if (isTauri()) {
          const { invoke } = (window as any).__TAURI__.core;
          text = await invoke("read_file", { path: filePath });
        } else {
          const res = await fetch(`http://localhost:3002/api/file?path=${encodeURIComponent(filePath)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = await res.text();
        }
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

  const handleChange = (value: string) => {
    setContent(value);
    setModified(value !== originalContent);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isTauri()) {
        const { invoke } = (window as any).__TAURI__.core;
        await invoke("write_file", { path: filePath, content });
      } else {
        const res = await fetch("http://localhost:3002/api/write-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath, content }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      setOriginalContent(content);
      setModified(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") {
      onClose();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const start = (e.target as HTMLTextAreaElement).selectionStart;
      const end = (e.target as HTMLTextAreaElement).selectionEnd;
      const newContent = content.substring(0, start) + "  " + content.substring(end);
      setContent(newContent);
      setModified(newContent !== originalContent);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
        }
      }, 0);
    }
  };

  return (
    <div className="file-editor">
      <div className="file-editor-header">
        <span className="file-editor-name">
          {modified && "● "}{fileName}
        </span>
        <span className="file-editor-path">{filePath}</span>
        <div className="file-editor-actions">
          {error && <span className="file-editor-error">{error}</span>}
          {isText && (
            <button className="file-editor-btn" onClick={handleSave} disabled={!modified || saving}>
              {saving ? "保存中..." : "💾 保存"}
            </button>
          )}
          <button className="file-editor-btn close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="file-editor-body">
        {isImage ? (
          <FilePreviewImage filePath={filePath} />
        ) : isPdf ? (
          <FilePreviewPdf filePath={filePath} />
        ) : isOffice ? (
          <FilePreviewOffice filePath={filePath} fileName={fileName} />
        ) : isBinary ? (
          <FilePreviewBinary filePath={filePath} fileName={fileName} />
        ) : loading ? (
          <div className="file-editor-loading">加载中...</div>
        ) : error ? (
          <div className="file-editor-error-body">{error}</div>
        ) : (
          <textarea
            ref={textareaRef}
            className="file-editor-textarea"
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
