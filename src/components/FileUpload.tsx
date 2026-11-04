import { useRef, useState } from "react";
import { MessageAttachment } from "../store";
import { isDocumentExtension } from "../core/document/path-ingest";
import { hasDocumentBackend } from "../core/document/client";

interface FileUploadProps {
  onUpload: (attachments: MessageAttachment[]) => void;
  hideButton?: boolean;
  /**
   * 文档索引集合（项目 id / `session:<id>`）。给了它 ⇒ 选中的文件**同时入索引**；
   * 没给（旧调用点/单测）⇒ 保持 1.18.5 行为（只做附件）。
   */
  collectionId?: string;
}

/**
 * 附件按钮：**原生文件对话框优先**。
 *
 * 为什么改了取文件的方式（ADR-0008 §12）：
 * - HTML `<input type=file>` 在 WebView2 里只给 `File` 对象，**拿不到真实路径**；
 *   上百 MB 的 docx/pdf 只能分块 base64 过 IPC（256+ 次往返）。
 * - `@tauri-apps/plugin-dialog` 返回真实路径 ⇒ Rust 直接流式读，字节一次都不进渲染进程。
 *
 * 浏览器环境（无 Tauri）仍走原来的 `<input>`，并对**文档扩展名**额外走分块 blob 通道。
 */
export function FileUpload({ onUpload, hideButton, collectionId }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  /** 入索引（失败只留痕，不影响附件本身）。 */
  const ingestAttachment = (att: MessageAttachment, source: { file?: File; path?: string }) => {
    if (!collectionId || !hasDocumentBackend()) return;
    void (async () => {
      try {
        if (source.path) {
          const { ingestPath } = await import("../core/document/client");
          await ingestPath({
            collectionId,
            path: source.path,
            kind: "attachment",
            name: att.name,
            sourceRef: att.id,
          });
        } else if (source.file) {
          const { ingestFileBytes } = await import("../core/document/client");
          await ingestFileBytes({
            collectionId,
            file: source.file,
            kind: "attachment",
            sourceRef: att.id,
          });
        }
      } catch (err) {
        console.warn("[FileUpload] 文档入索引失败:", err);
      }
    })();
  };

  /** Tauri：原生对话框（真实路径）。返回 true 表示已处理完毕。 */
  const pickViaNativeDialog = async (): Promise<boolean> => {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri || !collectionId) return false;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Documents",
            extensions: [
              "docx", "xlsx", "pptx", "pdf", "md", "markdown", "txt", "csv", "json", "yaml", "yml",
              "png", "jpg", "jpeg", "webp",
            ],
          },
        ],
      });
      if (!selected) return true;
      const paths: string[] = (Array.isArray(selected) ? selected : [selected])
        .map((item: any) => (typeof item === "string" ? item : item?.path))
        .filter((p: any): p is string => typeof p === "string" && p.length > 0);
      if (paths.length === 0) return true;

      const attachments: MessageAttachment[] = paths.map((path, i) => {
        const name = path.split(/[\\/]/).pop() || `file-${i}`;
        return {
          id: `local-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          type: isImageName(name) ? "image" : "file",
          mimeType: guessMimeType(name),
          size: 0,
        };
      });
      onUpload(attachments);
      attachments.forEach((att, i) => ingestAttachment(att, { path: paths[i] }));
      return true;
    } catch (err) {
      console.warn("[FileUpload] 原生对话框不可用，回退 input:", err);
      return false;
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const attachments: MessageAttachment[] = [];
    const picked: Array<{ att: MessageAttachment; file: File }> = [];
    const MAX_FILE_CONTENT_SIZE = 200 * 1024; // 200KB — 文本文件最大直接嵌入内容

    for (const file of Array.from(files)) {
      try {
        // Generate preview (works in both Tauri and browser mode)
        let preview: string | undefined;
        let fullContent: string | undefined;

        if (isTextFile(file.name)) {
          const text = await readFileAsText(file);
          preview = text.length > 2000 ? text.substring(0, 2000) + "\n..." : text;
          // 对于小文件，直接读取全部内容嵌入 attachment
          if (text.length <= MAX_FILE_CONTENT_SIZE) {
            fullContent = text;
          }
        } else if (isImageFile(file.name)) {
          preview = await readFileAsDataURL(file);
          fullContent = preview; // 图片以 data URL 形式存储
        }

        // Read file directly via File API — no server needed
        const att: MessageAttachment = {
          id: `local-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          name: file.name,
          type: isImageFile(file.name) ? "image" : "file",
          content: fullContent || preview,
          mimeType: file.type || guessMimeType(file.name),
          size: file.size,
        };
        attachments.push(att);
        picked.push({ att, file });
      } catch (err) {
        console.error("Upload failed:", err);
      }
    }

    if (attachments.length > 0) {
      onUpload(attachments);
      // 文档（含 pdf/docx/图片）进索引；普通源码文件不进来（避免噪声）
      for (const { att, file } of picked) {
        if (isDocumentExtension(file.name)) ingestAttachment(att, { file });
      }
    }

    setUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleClick = async () => {
    setUploading(true);
    const handled = await pickViaNativeDialog();
    setUploading(false);
    if (!handled) fileInputRef.current?.click();
  };

  return (
    <>
      <input
        ref={fileInputRef}
        id="file-upload-input"
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
      {!hideButton && (
        <button
          className="upload-btn"
          onClick={() => void handleClick()}
          disabled={uploading}
          title="上传文件"
        >
          {uploading ? "⏳" : "📎"}
        </button>
      )}
    </>
  );
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["txt", "md", "json", "js", "ts", "jsx", "tsx", "css", "html", "py", "rs", "go", "java", "c", "cpp", "h", "yaml", "yml", "toml", "xml", "csv", "sql", "sh", "bat", "log", "ini", "cfg", "conf"].includes(ext);
}

function isImageFile(name: string): boolean {
  return isImageName(name);
}

function isImageName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
}

function guessMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json",
    js: "text/javascript", ts: "text/typescript", jsx: "text/javascript", tsx: "text/typescript",
    css: "text/css", html: "text/html", py: "text/x-python", rs: "text/rust",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    pdf: "application/pdf", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] || "application/octet-stream";
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
