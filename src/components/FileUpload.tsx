import { useRef, useState } from "react";
import { MessageAttachment } from "../store";

const isTauri = () => !!(window as any).__TAURI__;

interface FileUploadProps {
  onUpload: (attachments: MessageAttachment[]) => void;
}

export function FileUpload({ onUpload }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const attachments: MessageAttachment[] = [];
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

        if (isTauri()) {
          // Tauri mode: read file directly via File API, no server needed
          attachments.push({
            id: `local-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            name: file.name,
            type: isImageFile(file.name) ? "image" : "file",
            content: fullContent || preview,
            mimeType: file.type || guessMimeType(file.name),
            size: file.size,
          });
        } else {
          // Browser/dev mode: use sidecar server upload
          const formData = new FormData();
          formData.append("file", file);

          const res = await fetch("http://localhost:3002/api/upload", {
            method: "POST",
            body: formData,
          });

          if (res.ok) {
            const data = await res.json();
            if (data.files && data.files.length > 0) {
              const uploaded = data.files[0];
              attachments.push({
                id: uploaded.id,
                name: file.name,
                type: isImageFile(file.name) ? "image" : "file",
                content: fullContent || preview,
                mimeType: uploaded.mimeType,
                size: file.size,
              });
            }
          }
        }
      } catch (err) {
        console.error("Upload failed:", err);
      }
    }

    if (attachments.length > 0) {
      onUpload(attachments);
    }

    setUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
      <button
        className="upload-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        title="上传文件"
      >
        {uploading ? "⏳" : "📎"}
      </button>
    </>
  );
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["txt", "md", "json", "js", "ts", "jsx", "tsx", "css", "html", "py", "rs", "go", "java", "c", "cpp", "h", "yaml", "yml", "toml", "xml", "csv", "sql", "sh", "bat", "log", "ini", "cfg", "conf"].includes(ext);
}

function isImageFile(name: string): boolean {
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
